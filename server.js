const express = require("express"), http = require("http"), { Server } = require("socket.io");
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static(__dirname + "/public"));

// ---- Settings: change these freely ----
const SAME = 5, UNIQUE = 10, COUNT = 10;              // points + seconds left after first "Done"
const CATS = ["name", "place", "animal", "thing"];
const LETTERS = "ABCDEFGHIJKLMNOPRSTUVW";
// Brand names are blocked automatically in "thing" (add more any time)
const BRANDS = "cocacola pepsi sprite fanta nike adidas mcdonalds kfc subway starbucks nestle cadbury oreo pringles doritos kitkat snickers twix nutella iphone ipad samsung sony google microsoft xbox playstation nintendo lego barbie gucci prada chanel dior rolex toyota honda bmw ferrari tesla ikea dettol colgate pampers nivea maybelline loreal marcjacobs zara levis reebok vaseline lipton nescafe roohafza sunsip".split(" ");
const BAD_PLACES = "disneyland disneyworld wonderland hogwarts narnia gotham atlantis neverland".split(" ");

const rooms = {};
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const rnd = a => a[Math.random() * a.length | 0];

function badReason(r, id, c, a, L) {
  const n = norm(a);
  if (!n || n[0] !== L) return "wrong letter";
  if (c === "thing") {
    const words = a.toLowerCase().split(/\s+/).map(norm);
    if (BRANDS.some(b => words.includes(b) || (b.length >= 6 && n.includes(b)))) return "brand name";
  }
  if (c === "place" && BAD_PLACES.some(b => n.includes(b))) return "not a real city/country";
  const v = r.flags[id + "|" + c];
  const others = Object.keys(r.players).length - 1;
  if (v && others >= 1 && v.size >= Math.floor(others / 2) + 1) return "voted out";
  return "";
}

function score(r) {
  const ids = Object.keys(r.players), L = r.letter.toLowerCase(), cnt = {}, rows = {};
  const get = (id, c) => ((r.answers[id] || {})[c] || "").trim();
  CATS.forEach(c => { cnt[c] = {}; ids.forEach(id => { const a = get(id, c); if (a && !badReason(r, id, c, a, L)) cnt[c][norm(a)] = (cnt[c][norm(a)] || 0) + 1; }); });
  ids.forEach(id => {
    let total = 0, cats = {};
    CATS.forEach(c => {
      const a = get(id, c), why = a ? badReason(r, id, c, a, L) : "";
      const p = a && !why ? (cnt[c][norm(a)] > 1 ? SAME : UNIQUE) : 0;
      total += p; cats[c] = { t: a, p, why };
    });
    rows[id] = { cats, total };
  });
  return rows;
}

function view(r, me) {
  const flags = {}, mine = [];
  Object.entries(r.flags).forEach(([k, s]) => { flags[k] = s.size; if (s.has(me)) mine.push(k); });
  return {
    me, code: r.code, host: r.host, round: r.round, rounds: r.rounds, phase: r.phase, letter: r.letter, picker: r.picker,
    used: r.used, left: r.deadline ? r.deadline - Date.now() : null, startIn: r.startAt ? r.startAt - Date.now() : null,
    players: Object.values(r.players).map(p => ({ id: p.id, name: p.name, on: p.on, done: !!r.done[p.id], total: (r.bank[p.id] || 0) + (r.phase === "results" && r.rows[p.id] ? r.rows[p.id].total : 0) })),
    rows: r.phase === "results" ? r.rows : null, flags, mine, chat: r.chat.slice(-60)
  };
}
const push = r => Object.keys(r.players).forEach(id => io.to(id).emit("state", view(r, id)));
const online = r => Object.values(r.players).filter(p => p.on);

function newRoom(pub) {
  let code; do { code = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join(""); } while (rooms[code]);
  return rooms[code] = { code, pub, host: null, players: {}, order: [], rounds: 5, round: 0, phase: "lobby", letter: null, picker: null, used: [], deadline: null, startAt: null, answers: {}, done: {}, flags: {}, bank: {}, rows: {}, chat: [], timer: null, auto: null };
}
function addPlayer(r, socket, name) {
  name = String(name || "Player").trim().slice(0, 16) || "Player";
  r.players[socket.id] = { id: socket.id, name, on: true }; r.order.push(socket.id);
  if (!r.host) r.host = socket.id;
  socket.join(r.code); socket.data.code = r.code;
  if (r.pub && r.phase === "lobby" && online(r).length >= 2 && !r.auto) {
    r.startAt = Date.now() + 15000; r.auto = setTimeout(() => { r.auto = null; r.startAt = null; if (r.phase === "lobby") nextRound(r); }, 15000);
  }
  push(r);
}
function nextRound(r) {
  if (r.phase === "results") Object.keys(r.rows).forEach(id => r.bank[id] = (r.bank[id] || 0) + r.rows[id].total);
  clearTimeout(r.timer); r.deadline = null; r.round++; r.phase = "pick"; r.letter = null;
  r.answers = {}; r.done = {}; r.flags = {}; r.rows = {};
  if (r.used.length >= LETTERS.length) r.used = [];
  const on = r.order.filter(id => r.players[id] && r.players[id].on);
  r.picker = on[(r.round - 1) % on.length];
  push(r);
}
function finalize(r) {
  if (r.phase === "results") Object.keys(r.rows).forEach(id => r.bank[id] = (r.bank[id] || 0) + r.rows[id].total);
  clearTimeout(r.timer); r.phase = "final"; r.rows = {}; push(r);
}
function setLetter(r, L) {
  r.used.push(L); io.to(r.code).emit("landed", { letter: L, counted: true });
  setTimeout(() => { if (r.phase === "pick") { r.letter = L; r.phase = "play"; push(r); } }, 1400);
}
function finish(r) {
  if (r.phase !== "play") return;
  clearTimeout(r.timer); r.phase = "results"; r.deadline = null; r.rows = score(r); push(r);
}

io.on("connection", socket => {
  const R = () => rooms[socket.data.code];
  socket.on("create", (name, pub) => { const r = newRoom(!!pub); addPlayer(r, socket, name); });
  socket.on("join", (name, code) => {
    const r = rooms[String(code || "").toUpperCase()];
    if (!r) return socket.emit("err", "No room with that code.");
    if (r.phase !== "lobby") return socket.emit("err", "That game already started.");
    addPlayer(r, socket, name);
  });
  socket.on("quick", name => {
    const r = Object.values(rooms).find(x => x.pub && x.phase === "lobby" && online(x).length < 8) || newRoom(true);
    addPlayer(r, socket, name);
  });
  socket.on("start", () => { const r = R(); if (r && r.phase === "lobby" && r.host === socket.id) nextRound(r); });
  socket.on("stop", () => {
    const r = R(); if (!r || r.phase !== "pick" || r.picker !== socket.id) return;
    const L = rnd(LETTERS.split(""));
    if (r.used.includes(L)) io.to(r.code).emit("landed", { letter: L, counted: false }); else setLetter(r, L);
  });
  socket.on("skip", () => { const r = R(); if (r && r.phase === "pick" && r.host === socket.id) setLetter(r, rnd(LETTERS.split("").filter(l => !r.used.includes(l)))); });
  socket.on("draft", a => { const r = R(); if (r && r.phase === "play" && !r.done[socket.id]) r.answers[socket.id] = a; });
  socket.on("done", a => {
    const r = R(); if (!r || r.phase !== "play" || r.done[socket.id]) return;
    r.answers[socket.id] = a; r.done[socket.id] = true;
    if (!r.deadline) { r.deadline = Date.now() + COUNT * 1000; r.timer = setTimeout(() => finish(r), COUNT * 1000); }
    if (online(r).every(p => r.done[p.id])) finish(r); else push(r);
  });
  socket.on("flag", (id, c) => {
    const r = R(); if (!r || r.phase !== "results" || id === socket.id) return;
    const k = id + "|" + c, s = r.flags[k] || (r.flags[k] = new Set());
    s.has(socket.id) ? s.delete(socket.id) : s.add(socket.id);
    r.rows = score(r); push(r);
  });
  socket.on("next", () => { const r = R(); if (r && r.phase === "results") (r.rounds && r.round >= r.rounds) ? finalize(r) : nextRound(r); });
  socket.on("end", () => { const r = R(); if (r && r.phase === "results") finalize(r); });
  socket.on("rounds", n => { const r = R(); if (r && r.phase === "lobby" && r.host === socket.id && [0, 1, 5].includes(n)) { r.rounds = n; push(r); } });
  socket.on("again", () => {
    const r = R(); if (!r || r.phase !== "final" || r.host !== socket.id) return;
    Object.keys(r.players).forEach(id => { if (!r.players[id].on) { delete r.players[id]; r.order = r.order.filter(i => i !== id); } });
    Object.assign(r, { round: 0, phase: "lobby", letter: null, picker: null, used: [], bank: {}, rows: {}, answers: {}, done: {}, flags: {}, deadline: null }); push(r);
  });
  socket.on("chat", t => {
    const r = R(); if (!r) return; t = String(t || "").trim().slice(0, 200); if (!t) return;
    r.chat.push({ name: r.players[socket.id].name, id: socket.id, text: t }); push(r);
  });
  socket.on("disconnect", () => {
    const r = R(); if (!r || !r.players[socket.id]) return;
    if (r.phase === "lobby") { delete r.players[socket.id]; r.order = r.order.filter(i => i !== socket.id); } else r.players[socket.id].on = false;
    const on = online(r);
    if (!on.length) { clearTimeout(r.timer); clearTimeout(r.auto); delete rooms[r.code]; return; }
    if (r.host === socket.id || !r.players[r.host] || !r.players[r.host].on) r.host = on[0].id;
    if (r.phase === "pick" && r.picker === socket.id) setLetter(r, rnd(LETTERS.split("").filter(l => !r.used.includes(l))));
    if (r.phase === "play" && on.every(p => r.done[p.id])) return finish(r);
    push(r);
  });
});
srv.listen(process.env.PORT || 3000, () => console.log("Game running on port " + (process.env.PORT || 3000)));
