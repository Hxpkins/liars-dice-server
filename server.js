const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
cors: { origin: '*', methods: ['GET', 'POST'] }
});
const PORT = process.env.PORT || 3001;
// GAME ENGINE
function randomDie() { return Math.floor(Math.random() * 6) + 1; }
function rollNDice(n) { return Array.from({ length: n }, () => randomDie()); }
function countDice(players, fv, isPal) {
let c = 0;
for (const p of players) {
if (p.isEliminated) continue;
for (const d of p.dice) {
if (d === fv) c++;
else if (!isPal && fv !== 1 && d === 1) c++;
}
}
return c;
}
function actives(s) { return s.players.filter(p => !p.isEliminated); }
function totalDice(s) { return actives(s).reduce((a, p) => a + p.diceCount, 0); }
function nextActive(s, from) {
const n = s.players.length;
let i = (from + 1) % n;
let x = 0;
while (s.players[i].isEliminated && x < n) { i = (i + 1) % n; x++; }
return i;
}
function isValidBid(s, b) {
if (b.faceValue < 1 || b.faceValue > 6) return { ok: false, r: 'Face 1-6' };
if (b.quantity < 1) return { ok: false, r: 'Qty >= 1' };
if (b.quantity > totalDice(s)) return { ok: false, r: 'Exceeds dice' };
const cb = s.currentBid;
if (!cb) return { ok: true };
if (s.isPal) {
if (b.faceValue !== cb.faceValue) return { ok: false, r: 'Palafico: same face' };
if (b.quantity <= cb.quantity) return { ok: false, r: 'Palafico: raise qty' };
return { ok: true };
}
const pa = cb.faceValue === 1, na = b.faceValue === 1;
if (pa && na) return b.quantity > cb.quantity ? { ok: true } : { ok: false, r: 'Raise ace qty' };
if (!pa && !na) {
if (b.quantity > cb.quantity) return { ok: true };
if (b.quantity === cb.quantity && b.faceValue > cb.faceValue) return { ok: true };
return { ok: false, r: 'Raise qty or face' };
}
if (!pa && na) { const m = Math.ceil(cb.quantity / 2); return b.quantity >= m ? { ok: true } : { ok: false, r: 'To aces: need ' + m }; }
if (pa && !na) { const m = cb.quantity * 2 + 1; return b.quantity >= m ? { ok: true } : { ok: false, r: 'From aces: need ' + m }; }
return { ok: true };
}
// BOT AI
function countOwn(dice, face, isPal) {
let c = 0;
for (const d of dice) { if (d === face) c++; else if (!isPal && face !== 1 && d === 1) c++; }
return c;
}
function botDecision(s, botId) {
const bot = s.players.find(function(p) { return p.id === botId; });
const cb = s.currentBid;
const td = totalDice(s);
const faces = s.isPal && cb ? [cb.faceValue] : [1, 2, 3, 4, 5, 6];
const vb = [];
for (const f of faces) {
for (let q = 1; q <= td; q++) {
const b = { playerId: botId, quantity: q, faceValue: f };
if (isValidBid(s, b).ok) vb.push(b);
}
}
if (!cb && vb.length > 0) {
const counts = {};
for (let f = 1; f <= 6; f++) counts[f] = countOwn(bot.dice, f, s.isPal);
const best = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; })[0];
const qty = Math.max(1, Math.min(Math.floor(td / 6) + 1, td));
return { type: 'bid', bid: vb.find(function(b) { return b.faceValue === Number(best[0]) && b.quantity <= qty; }) || vb[0] };
}
if (vb.length === 0) return { type: 'liar' };
if (cb) {
const my = countOwn(bot.dice, cb.faceValue, s.isPal);
const od = td - bot.diceCount;
const prob = s.isPal || cb.faceValue === 1 ? 1 / 6 : 2 / 6;
const exp = my + od * prob;
if (cb.quantity > exp * 1.3) return { type: 'liar' };
if (s.config.mode === 'advanced' && !s.history.some(function(a) { return a.type === 'calza'; }) && cb.playerId !== botId && Math.abs(cb.quantity - exp) < 0.8) {
return { type: 'calza' };
}
}
const sorted = vb.slice().sort(function(a, b) {
const ao = countOwn(bot.dice, a.faceValue, s.isPal);
const bo = countOwn(bot.dice, b.faceValue, s.isPal);
return bo !== ao ? bo - ao : a.quantity - b.quantity;
});
const top = sorted.slice(0, 3);
return { type: 'bid', bid: top[Math.floor(Math.random() * top.length)] };
}
// LOBBY SYSTEM
const BOT_NAMES = ['Bluff King', 'Lady Luck', 'The Shark', 'Wild Card', 'Snake Eyes'];
const BOT_AVATARS = ['🤴', '🎭', '🦈', '🃏', '🐍'];
const rooms = new Map();
const players = new Map();
function genCode() {
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let code = '';
for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
return code;
}
function createRoom(hostSocket, hostName, hostAvatar, mode) {
const roomId = uuid();
const code = genCode();
const hostId = uuid();
const room = {
id: roomId, code: code, mode: mode || 'basic', host: hostId, status: 'lobby',
maxPlayers: 6,
players: [{
id: hostId, socketId: hostSocket.id, name: hostName || 'Host',
avatar: hostAvatar || '😎', isBot: false, isReady: false, connected: true,
}],
gameState: null, turnTimer: null, createdAt: Date.now(),
};
rooms.set(roomId, room);
players.set(hostSocket.id, { roomId: roomId, playerId: hostId });
hostSocket.join(roomId);
return room;
}
function addBots(room) {
const needed = room.maxPlayers - room.players.length;
for (let i = 0; i < needed; i++) {
room.players.push({
id: 'bot-' + i, socketId: null, name: BOT_NAMES[i % BOT_NAMES.length],
avatar: BOT_AVATARS[i % BOT_AVATARS.length], isBot: true, isReady: true, connected: true,
});
}
}
function sanitizeForPlayer(gameState, playerId) {
if (!gameState) return null;
return {
config: gameState.config, cpi: gameState.cpi, currentBid: gameState.currentBid,
round: gameState.round, phase: gameState.phase, isPal: gameState.isPal,
palId: gameState.palId, history: gameState.history, result: gameState.result,
winner: gameState.winner,
players: gameState.players.map(function(p) {
return {
id: p.id, name: p.name, avatar: p.avatar, diceCount: p.diceCount,
isBot: p.isBot, isEliminated: p.isEliminated,
dice: p.id === playerId ? p.dice : [],
};
}),
};
}
function sanitizeRevealed(gameState) {
return {
config: gameState.config, cpi: gameState.cpi, currentBid: gameState.currentBid,
round: gameState.round, phase: gameState.phase, isPal: gameState.isPal,
palId: gameState.palId, history: gameState.history, result: gameState.result,
winner: gameState.winner,
players: gameState.players.map(function(p) {
return {
id: p.id, name: p.name, avatar: p.avatar, diceCount: p.diceCount,
isBot: p.isBot, isEliminated: p.isEliminated, dice: p.dice,
};
}),
};
}
function emitGameState(room) {
var gs = room.gameState;
if (!gs) return;
room.players.forEach(function(p) {
if (!p.isBot && p.socketId) {
var sock = io.sockets.sockets.get(p.socketId);
if (sock) {
var view = gs.phase === 'revealing' ? sanitizeRevealed(gs) : sanitizeForPlayer(gs, p.id);
sock.emit('gameState', view);
}
}
});
}
function emitLobby(room) {
io.to(room.id).emit('lobbyUpdate', {
id: room.id, code: room.code, mode: room.mode, host: room.host, status: room.status,
players: room.players.map(function(p) {
return { id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot, isReady: p.isReady, connected: p.connected };
}),
});
}
function startRoundServer(s, fpi) {
var ns = {
config: s.config, players: s.players, cpi: fpi, currentBid: null,
round: s.round + 1, phase: 'bidding', isPal: false, palId: null,
history: [], result: null, winner: null,
};
ns.players = s.players.map(function(p) {
if (p.isEliminated) return Object.assign({}, p);
return Object.assign({}, p, { dice: rollNDice(p.diceCount) });
});
if (ns.config.mode === 'advanced') {
var ap = actives(ns);
var pp = ap.filter(function(p) { return p.diceCount === 1; });
ns.isPal = pp.length === 1 && ap.length > 2;
ns.palId = ns.isPal ? pp[0].id : null;
}
return ns;
}
function startTurnTimer(room) {
clearTimeout(room.turnTimer);
var gs = room.gameState;
if (!gs || gs.phase !== 'bidding') return;
var cp = gs.players[gs.cpi];
if (cp.isBot) {
room.turnTimer = setTimeout(function() { executeBotTurn(room); }, 2500 + Math.random() * 2500);
return;
}
room.turnTimer = setTimeout(function() {
var gs2 = room.gameState;
if (!gs2 || gs2.phase !== 'bidding') return;
var cp2 = gs2.players[gs2.cpi];
if (cp2.isBot) return;
if (gs2.currentBid) { doAction(room, cp2.id, 'liar', null); }
else { doAction(room, cp2.id, 'bid', { quantity: 1, faceValue: 2 }); }
}, 30000);
}
function executeBotTurn(room) {
var gs = room.gameState;
if (!gs || gs.phase !== 'bidding') return;
var bot = gs.players[gs.cpi];
if (!bot.isBot) return;
var act = botDecision(gs, bot.id);
doAction(room, bot.id, act.type, act.bid || null);
}
function doAction(room, playerId, action, data) {
var gs = room.gameState;
if (!gs || gs.phase !== 'bidding') return;
if (gs.players[gs.cpi].id !== playerId) return;
try {
if (action === 'bid') {
var b = { playerId: playerId, quantity: data.quantity, faceValue: data.faceValue };
var v = isValidBid(gs, b);
if (!v.ok) {
var pl = room.players.find(function(p) { return p.id === playerId; });
if (pl && pl.socketId) {
var sock = io.sockets.sockets.get(pl.socketId);
if (sock) sock.emit('actionError', v.r);
}
return;
}
gs = Object.assign({}, gs, {
currentBid: b,
history: gs.history.concat([{ type: 'bid', pid: playerId, bid: b }]),
cpi: nextActive(gs, gs.cpi),
});
io.to(room.id).emit('action', { type: 'bid', playerId: playerId, bid: b });
} else if (action === 'liar') {
if (!gs.currentBid) return;
var bid = gs.currentBid;
var actual = countDice(gs.players, bid.faceValue, gs.isPal);
var ok = actual >= bid.quantity;
gs = Object.assign({}, gs, {
history: gs.history.concat([{ type: 'liar', pid: playerId }]),
result: { action: 'liar', cid: playerId, bid: bid, actual: actual, callerRight: !ok, loserId: ok ? playerId : bid.playerId, gainId: null },
phase: 'revealing',
});
io.to(room.id).emit('action', { type: 'liar', playerId: playerId });
} else if (action === 'calza') {
if (!gs.currentBid) return;
var bid2 = gs.currentBid;
var actual2 = countDice(gs.players, bid2.faceValue, gs.isPal);
var exact = actual2 === bid2.quantity;
var cl = gs.players.find(function(p) { return p.id === playerId; });
var cg = cl.diceCount < gs.config.maxDice;
gs = Object.assign({}, gs, {
history: gs.history.concat([{ type: 'calza', pid: playerId }]),
result: { action: 'calza', cid: playerId, bid: bid2, actual: actual2, callerRight: exact, loserId: exact ? null : playerId, gainId: exact && cg ? playerId : null },
phase: 'revealing',
});
io.to(room.id).emit('action', { type: 'calza', playerId: playerId });
}
room.gameState = gs;
emitGameState(room);
if (gs.phase === 'revealing') {
clearTimeout(room.turnTimer);
room.turnTimer = setTimeout(function() { resolveReveal(room); }, 6000);
} else {
startTurnTimer(room);
}
} catch (e) { console.error('Action error:', e); }
}
function resolveReveal(room) {
var gs = room.gameState;
if (!gs || gs.phase !== 'revealing') return;
var r = gs.result;
var newPlayers = gs.players.map(function(p) {
var u = Object.assign({}, p);
if (r.loserId === p.id) { u.diceCount = Math.max(0, p.diceCount - 1); if (u.diceCount === 0) u.isEliminated = true; }
if (r.gainId === p.id) u.diceCount = Math.min(gs.config.maxDice, p.diceCount + 1);
return u;
});
gs = Object.assign({}, gs, { players: newPlayers });
var rem = actives(gs);
if (rem.length === 1) {
gs.phase = 'gameOver';
gs.winner = rem[0].id;
room.gameState = gs;
room.status = 'finished';
emitGameState(room);
io.to(room.id).emit('gameOver', { winner: rem[0] });
return;
}
var ni;
if (r.loserId) {
var li = gs.players.findIndex(function(p) { return p.id === r.loserId; });
ni = gs.players[li].isEliminated ? nextActive(gs, li) : li;
} else {
ni = gs.players.findIndex(function(p) { return p.id === r.cid; });
}
room.gameState = startRoundServer(gs, ni);
emitGameState(room);
startTurnTimer(room);
}
function startGame(room) {
addBots(room);
room.status = 'playing';
var defs = room.players.map(function(p) {
return { id: p.id, name: p.name, isBot: p.isBot, avatar: p.avatar, diceSkin: 'default' };
});
var c = { mode: room.mode, startingDice: 5, turnTimer: 30, maxDice: 5, playerCount: defs.length };
var ps = defs.map(function(p) {
return { id: p.id, name: p.name, diceCount: c.startingDice, dice: [], isBot: p.isBot, isEliminated: false, avatar: p.avatar, diceSkin: 'default' };
});
room.gameState = { config: c, players: ps, cpi: 0, currentBid: null, round: 0, phase: 'waiting', isPal: false, palId: null, history: [], result: null, winner: null };
var first = Math.floor(Math.random() * room.players.length);
room.gameState = startRoundServer(room.gameState, first);
emitGameState(room);
startTurnTimer(room);
}
// SOCKET HANDLERS
io.on('connection', function(socket) {
console.log('Connected: ' + socket.id);
socket.on('createRoom', function(data) {
var room = createRoom(socket, data.name, data.avatar, data.mode);
socket.emit('roomCreated', { roomId: room.id, code: room.code, playerId: room.host });
emitLobby(room);
});
socket.on('joinRoom', function(data) {
var found = null;
rooms.forEach(function(room) {
if (room.code === data.code.toUpperCase() && room.status === 'lobby') found = room;
});
if (!found) { socket.emit('actionError', 'Room not found or game already started.'); return; }
var humanCount = found.players.filter(function(p) { return !p.isBot; }).length;
if (humanCount >= found.maxPlayers) { socket.emit('actionError', 'Room is full.'); return; }
var playerId = uuid();
found.players.push({
id: playerId, socketId: socket.id, name: data.name || 'Player',
avatar: data.avatar || '🎲', isBot: false, isReady: false, connected: true,
});
players.set(socket.id, { roomId: found.id, playerId: playerId });
socket.join(found.id);
socket.emit('joinedRoom', { roomId: found.id, code: found.code, playerId: playerId });
emitLobby(found);
});
socket.on('toggleReady', function() {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room || room.status !== 'lobby') return;
var p = room.players.find(function(pl) { return pl.id === info.playerId; });
if (p) { p.isReady = !p.isReady; emitLobby(room); }
});
socket.on('startGame', function() {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room || room.status !== 'lobby') return;
if (room.host !== info.playerId) { socket.emit('actionError', 'Only host can start.'); return; }
startGame(room);
});
socket.on('bid', function(data) {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room || room.status !== 'playing') return;
doAction(room, info.playerId, 'bid', data);
});
socket.on('callLiar', function() {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room || room.status !== 'playing') return;
doAction(room, info.playerId, 'liar', null);
});
socket.on('callCalza', function() {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room || room.status !== 'playing') return;
doAction(room, info.playerId, 'calza', null);
});
socket.on('chat', function(msg) {
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room) return;
var p = room.players.find(function(pl) { return pl.id === info.playerId; });
if (!p) return;
io.to(room.id).emit('chat', { sender: p.name, message: msg, avatar: p.avatar });
});
socket.on('disconnect', function() {
console.log('Disconnected: ' + socket.id);
var info = players.get(socket.id);
if (!info) return;
var room = rooms.get(info.roomId);
if (!room) return;
var p = room.players.find(function(pl) { return pl.id === info.playerId; });
if (p) p.connected = false;
players.delete(socket.id);
if (room.status === 'lobby') {
room.players = room.players.filter(function(pl) { return pl.id !== info.playerId; });
if (room.players.length === 0) { rooms.delete(room.id); return; }
if (room.host === info.playerId) {
var newHost = room.players.find(function(pl) { return !pl.isBot; });
if (newHost) room.host = newHost.id;
}
emitLobby(room);
}
if (room.status === 'playing') {
emitLobby(room);
var gs = room.gameState;
if (gs && gs.phase === 'bidding' && gs.players[gs.cpi].id === info.playerId) {
clearTimeout(room.turnTimer);
var pid = info.playerId;
room.turnTimer = setTimeout(function() {
var gs2 = room.gameState;
if (!gs2 || gs2.phase !== 'bidding') return;
if (gs2.currentBid) doAction(room, pid, 'liar', null);
else doAction(room, pid, 'bid', { quantity: 1, faceValue: 2 });
}, 10000);
}
}
});
socket.on('rejoin', function(data) {
var room = rooms.get(data.roomId);
if (!room) { socket.emit('actionError', 'Room not found.'); return; }
var p = room.players.find(function(pl) { return pl.id === data.playerId; });
if (!p) { socket.emit('actionError', 'Player not found.'); return; }
p.socketId = socket.id;
p.connected = true;
players.set(socket.id, { roomId: data.roomId, playerId: data.playerId });
socket.join(data.roomId);
socket.emit('rejoined', { roomId: data.roomId, code: room.code, playerId: data.playerId });
emitLobby(room);
if (room.status === 'playing') emitGameState(room);
});
});
// REST ENDPOINTS
app.get('/health', function(req, res) {
res.json({ status: 'ok', rooms: rooms.size, players: players.size });
});
app.get('/rooms', function(req, res) {
var publicRooms = [];
rooms.forEach(function(room) {
if (room.status === 'lobby') {
publicRooms.push({
code: room.code, mode: room.mode,
playerCount: room.players.filter(function(p) { return !p.isBot; }).length,
maxPlayers: room.maxPlayers,
});
}
});
res.json(publicRooms);
});
// Cleanup stale rooms every 5 minutes
setInterval(function() {
var now = Date.now();
rooms.forEach(function(room, id) {
if (now - room.createdAt > 60 * 60 * 1000) rooms.delete(id);
});
}, 5 * 60 * 1000);
server.listen(PORT, function() {
console.log('Liars Dice server running on port ' + PORT);
});
