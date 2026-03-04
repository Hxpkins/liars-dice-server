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

// ============================================================
// GAME ENGINE
// ============================================================
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

// ============================================================
// BOT AI
// ============================================================
function countOwn(dice, face, isPal) {
  let c = 0;
  for (const d of dice) { if (d === face) c++; else if (!isPal && face !== 1 && d === 1) c++; }
  return c;
}

// --- STATISTICAL BOT AI ---
function logBinom(n, k) {
  if (k === 0 || k === n) return 0;
  var r = 0;
  for (var i = 0; i < k; i++) r += Math.log(n - i) - Math.log(i + 1);
  return r;
}
function binomProb(n, k, p) {
  // P(X >= k) where X ~ Binomial(n, p)
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  var sum = 0;
  for (var i = 0; i < k; i++) {
    sum += Math.exp(logBinom(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.max(0, Math.min(1, 1 - sum));
}
function bidProb(s, bid, botDice, isPal) {
  var myMatch = countOwn(botDice, bid.faceValue, isPal);
  var needed = bid.quantity - myMatch;
  if (needed <= 0) return 1;
  var unknown = totalDice(s) - botDice.length;
  var p = (isPal || bid.faceValue === 1) ? 1/6 : 2/6;
  return binomProb(unknown, needed, p);
}

// Difficulty configs: liarThresh = call liar if P(bid true) < this
// bidNoise = how much randomness in bid selection (0=optimal, 1=random)
// calzaRange = how close to exact probability must be to attempt calza
// bluffChance = chance to overbid beyond statistical safety
var DIFF_CFG = {
  rookie:  { liarThresh: 0.20, bidNoise: 0.7, calzaRange: 0,    bluffChance: 0.3  },
  regular: { liarThresh: 0.35, bidNoise: 0.4, calzaRange: 0,    bluffChance: 0.15 },
  skilled: { liarThresh: 0.45, bidNoise: 0.2, calzaRange: 0.12, bluffChance: 0.08 },
  expert:  { liarThresh: 0.52, bidNoise: 0.05,calzaRange: 0.08, bluffChance: 0.03 },
};

function botDecision(s, botId, difficulty) {
  var diff = DIFF_CFG[difficulty] || DIFF_CFG.regular;
  var bot = s.players.find(function(p) { return p.id === botId; });
  if (!bot) return { type: 'liar' };
  var cb = s.currentBid;
  var td = totalDice(s);
  var faces = s.isPal && cb ? [cb.faceValue] : [1, 2, 3, 4, 5, 6];

  // Generate valid bids
  var vb = [];
  for (var fi = 0; fi < faces.length; fi++) {
    for (var q = 1; q <= td; q++) {
      var b = { playerId: botId, quantity: q, faceValue: faces[fi] };
      if (isValidBid(s, b).ok) vb.push(b);
    }
  }

  // Opening bid (no current bid)
  if (!cb && vb.length > 0) {
    // Score each bid by probability
    var scored = vb.map(function(b) {
      return { bid: b, prob: bidProb(s, b, bot.dice, s.isPal) };
    });
    // Target a bid with ~60-80% probability of being true
    var targetP = 0.7 - diff.bidNoise * 0.3;
    scored.sort(function(a, b) {
      return Math.abs(a.prob - targetP) - Math.abs(b.prob - targetP);
    });
    // Add noise: pick from top candidates
    var pool = scored.slice(0, Math.max(1, Math.ceil(diff.bidNoise * 8)));
    var pick = pool[Math.floor(Math.random() * pool.length)];
    return { type: 'bid', bid: pick.bid };
  }

  if (vb.length === 0) return { type: 'liar' };

  if (cb) {
    var pTrue = bidProb(s, cb, bot.dice, s.isPal);

    // Consider CALZA in advanced mode
    if (s.config.mode === 'advanced' && diff.calzaRange > 0 &&
        !s.history.some(function(a) { return a.type === 'calza'; }) &&
        cb.playerId !== botId) {
      // Calculate exact probability
      var myMatch = countOwn(bot.dice, cb.faceValue, s.isPal);
      var needed = cb.quantity - myMatch;
      var unknown = td - bot.diceCount;
      var pp = (s.isPal || cb.faceValue === 1) ? 1/6 : 2/6;
      var pExact = needed >= 0 && needed <= unknown ?
        Math.exp(logBinom(unknown, needed) + needed * Math.log(pp) + (unknown - needed) * Math.log(1 - pp)) : 0;
      if (pExact > diff.calzaRange) {
        return { type: 'calza' };
      }
    }

    // Call LIAR if probability of bid being true is below threshold
    if (pTrue < diff.liarThresh) {
      return { type: 'liar' };
    }

    // Make a bid - score all valid bids
    var scored2 = vb.map(function(b) {
      return { bid: b, prob: bidProb(s, b, bot.dice, s.isPal) };
    });

    // Expert/skilled: prefer bids with high probability, minimal raise
    // Rookie: more random, sometimes bluffs wildly
    if (Math.random() < diff.bluffChance) {
      // Wild bluff: pick a random bid
      return { type: 'bid', bid: vb[Math.floor(Math.random() * vb.length)] };
    }

    // Filter bids with reasonable probability
    var minP = Math.max(0.15, diff.liarThresh - 0.15);
    var reasonable = scored2.filter(function(s) { return s.prob >= minP; });
    if (reasonable.length === 0) reasonable = scored2.slice(0, 5);

    // Sort by: prefer bids that are just above minimum raise, with good probability
    reasonable.sort(function(a, b) {
      // Weight: higher probability better, lower quantity better (minimal raise)
      var scoreA = a.prob * 2 - a.bid.quantity / td;
      var scoreB = b.prob * 2 - b.bid.quantity / td;
      return scoreB - scoreA;
    });

    var topN = Math.max(1, Math.ceil(diff.bidNoise * reasonable.length));
    var pool2 = reasonable.slice(0, topN);
    return { type: 'bid', bid: pool2[Math.floor(Math.random() * pool2.length)].bid };
  }

  return { type: 'bid', bid: vb[0] };
}

// ============================================================
// LOBBY, PARTY & MATCHMAKING
// ============================================================
const BOT_NAMES = ['Bluff King', 'Lady Luck', 'The Shark', 'Wild Card', 'Snake Eyes'];
const BOT_AVATARS = ['🤴', '🎭', '🦈', '🃏', '🐍'];
const rooms = new Map();
const players = new Map();
const parties = new Map();
const matchQueue = [];

let botCounter = 0;
function genCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < (len || 6); i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createBotPlayer(difficulty) {
  const idx = botCounter % BOT_NAMES.length;
  botCounter++;
  return {
    id: 'bot-' + uuid().slice(0, 8),
    socketId: null,
    name: BOT_NAMES[idx],
    avatar: BOT_AVATARS[idx],
    isBot: true,
    isReady: true,
    connected: true,
    difficulty: difficulty || 'regular',
  };
}

function createRoom(hostSocket, hostName, hostAvatar, mode, maxPlayers, isPublic) {
  const roomId = uuid();
  const code = genCode(6);
  const hostId = uuid();
  const room = {
    id: roomId, code: code, mode: mode || 'basic', host: hostId,
    status: 'lobby', maxPlayers: Math.max(2, Math.min(6, maxPlayers || 6)),
    isPublic: !!isPublic,
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

function sanitizeForPlayer(gs, playerId) {
  if (!gs) return null;
  return {
    config: gs.config, cpi: gs.cpi, currentBid: gs.currentBid,
    round: gs.round, phase: gs.phase, isPal: gs.isPal,
    palId: gs.palId, history: gs.history, result: gs.result,
    winner: gs.winner,
    players: gs.players.map(function(p) {
      return {
        id: p.id, name: p.name, avatar: p.avatar, diceCount: p.diceCount,
        isBot: p.isBot, isEliminated: p.isEliminated,
        dice: p.id === playerId ? p.dice : [],
      };
    }),
  };
}

function sanitizeRevealed(gs) {
  return {
    config: gs.config, cpi: gs.cpi, currentBid: gs.currentBid,
    round: gs.round, phase: gs.phase, isPal: gs.isPal,
    palId: gs.palId, history: gs.history, result: gs.result,
    winner: gs.winner,
    players: gs.players.map(function(p) {
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
    id: room.id, code: room.code, mode: room.mode, host: room.host,
    status: room.status, maxPlayers: room.maxPlayers, isPublic: room.isPublic,
    players: room.players.map(function(p) {
      return { id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot, isReady: p.isReady, connected: p.connected, difficulty: p.difficulty || null };
    }),
  });
}

// ============================================================
// GAME FLOW
// ============================================================
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
  var roomBot = room.players.find(function(p) { return p.id === bot.id; });
  var diff = (roomBot && roomBot.difficulty) || 'regular';
  var act = botDecision(gs, bot.id, diff);
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
  var oldPlayers = gs.players;
  var newPlayers = gs.players.map(function(p) {
    var u = Object.assign({}, p);
    if (r.loserId === p.id) { u.diceCount = Math.max(0, p.diceCount - 1); if (u.diceCount === 0) u.isEliminated = true; }
    if (r.gainId === p.id) u.diceCount = Math.min(gs.config.maxDice, p.diceCount + 1);
    return u;
  });
  // Track first eliminated player
  if (!room.firstEliminated) {
    var justElim = newPlayers.find(function(np) {
      var op = oldPlayers.find(function(o) { return o.id === np.id; });
      return np.isEliminated && op && !op.isEliminated;
    });
    if (justElim) {
      room.firstEliminated = justElim.id;
    }
  }
  gs = Object.assign({}, gs, { players: newPlayers });
  var rem = actives(gs);
  if (rem.length === 1) {
    gs.phase = 'gameOver';
    gs.winner = rem[0].id;
    room.gameState = gs;
    room.status = 'finished';
    emitGameState(room);
    io.to(room.id).emit('gameOver', { winner: rem[0], firstEliminated: room.firstEliminated });
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
  room.status = 'playing';
  var c = { mode: room.mode, startingDice: 5, turnTimer: 30, maxDice: 5, playerCount: room.players.length };
  var ps = room.players.map(function(p) {
    return { id: p.id, name: p.name, diceCount: c.startingDice, dice: [], isBot: p.isBot, isEliminated: false, avatar: p.avatar, diceSkin: 'default' };
  });
  room.gameState = { config: c, players: ps, cpi: 0, currentBid: null, round: 0, phase: 'waiting', isPal: false, palId: null, history: [], result: null, winner: null };
  var first = Math.floor(Math.random() * room.players.length);
  room.gameState = startRoundServer(room.gameState, first);
  emitGameState(room);
  startTurnTimer(room);
}

// ============================================================
// MATCHMAKING
// ============================================================
function removeFromQueue(socketId) {
  for (var i = matchQueue.length - 1; i >= 0; i--) {
    if (matchQueue[i].socketId === socketId) matchQueue.splice(i, 1);
    else if (matchQueue[i].partyMembers) {
      var found = matchQueue[i].partyMembers.some(function(m) { return m.socketId === socketId; });
      if (found) matchQueue.splice(i, 1);
    }
  }
}

function tryMatchmake() {
  var byMode = { basic: [], advanced: [] };
  for (var i = 0; i < matchQueue.length; i++) {
    var entry = matchQueue[i];
    var mode = entry.mode || 'basic';
    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push(entry);
  }
  for (var mode in byMode) {
    var entries = byMode[mode];
    if (entries.length === 0) continue;
    var pending = [];
    var totalPlayers = 0;
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var size = e.partyMembers ? e.partyMembers.length : 1;
      if (totalPlayers + size <= 6) { pending.push(e); totalPlayers += size; }
    }
    // Need at least 2 human players, OR 1 who has waited 15+ seconds
    var oldestWait = pending.length > 0 ? Date.now() - pending[0].joinedAt : 0;
    if (totalPlayers < 2 && oldestWait < 15000) continue;
    if (totalPlayers < 1) continue;

    var firstEntry = pending[0];
    var firstSock = io.sockets.sockets.get(firstEntry.socketId);
    if (!firstSock) { removeFromQueue(firstEntry.socketId); continue; }

    var room = createRoom(firstSock, firstEntry.name, firstEntry.avatar, mode, 6, true);
    firstSock.emit('matchFound', { roomId: room.id, code: room.code, playerId: room.host });

    for (var k = 1; k < pending.length; k++) {
      var pe = pending[k];
      if (pe.partyMembers) {
        for (var m = 0; m < pe.partyMembers.length; m++) {
          var mem = pe.partyMembers[m];
          var memSock = io.sockets.sockets.get(mem.socketId);
          if (!memSock) continue;
          var memId = uuid();
          room.players.push({ id: memId, socketId: mem.socketId, name: mem.name, avatar: mem.avatar, isBot: false, isReady: true, connected: true });
          players.set(mem.socketId, { roomId: room.id, playerId: memId });
          memSock.join(room.id);
          memSock.emit('matchFound', { roomId: room.id, code: room.code, playerId: memId });
        }
      } else {
        var pSock = io.sockets.sockets.get(pe.socketId);
        if (!pSock) continue;
        var pid = uuid();
        room.players.push({ id: pid, socketId: pe.socketId, name: pe.name, avatar: pe.avatar, isBot: false, isReady: true, connected: true });
        players.set(pe.socketId, { roomId: room.id, playerId: pid });
        pSock.join(room.id);
        pSock.emit('matchFound', { roomId: room.id, code: room.code, playerId: pid });
      }
    }

    for (var r2 = 0; r2 < pending.length; r2++) {
      var idx = matchQueue.indexOf(pending[r2]);
      if (idx !== -1) matchQueue.splice(idx, 1);
    }

    // Fill with bots and start
    while (room.players.length < 6) room.players.push(createBotPlayer());
    setTimeout(function() { startGame(room); emitLobby(room); }, 3000);
  }
}

setInterval(tryMatchmake, 3000);

// ============================================================
// SOCKET HANDLERS
// ============================================================
io.on('connection', function(socket) {
  console.log('Connected: ' + socket.id);

  socket.on('createRoom', function(data) {
    var room = createRoom(socket, data.name, data.avatar, data.mode, data.maxPlayers || 6, false);
    socket.emit('roomCreated', { roomId: room.id, code: room.code, playerId: room.host, maxPlayers: room.maxPlayers });
    emitLobby(room);
  });

  socket.on('leaveRoom', function() {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) { players.delete(socket.id); return; }
    var p = room.players.find(function(pl) { return pl.id === info.playerId; });
    var pName = p ? p.name : 'A player';
    var pAvatar = p ? p.avatar : '❓';
    socket.leave(room.id);
    players.delete(socket.id);
    io.to(room.id).emit('playerLeft', { name: pName, avatar: pAvatar, playerId: info.playerId });
    if (room.status === 'lobby' || room.status === 'finished') {
      room.players = room.players.filter(function(pl) { return pl.id !== info.playerId; });
    } else if (room.status === 'playing' && p) {
      p.connected = false;
    }
    if (room.players.filter(function(p2) { return !p2.isBot && p2.connected !== false; }).length === 0) {
      clearTimeout(room.turnTimer);
      rooms.delete(room.id);
    } else {
      if (room.host === info.playerId) {
        var newHost = room.players.find(function(pl) { return !pl.isBot && pl.connected !== false; });
        if (newHost) room.host = newHost.id;
      }
      emitLobby(room);
    }
    socket.emit('leftRoom');
  });

  socket.on('joinRoom', function(data) {
    var found = null;
    rooms.forEach(function(room) {
      if (room.code === data.code.toUpperCase() && room.status === 'lobby') found = room;
    });
    if (!found) { socket.emit('actionError', 'Room not found or game already started.'); return; }
    if (found.players.length >= found.maxPlayers) { socket.emit('actionError', 'Room is full (' + found.maxPlayers + '/' + found.maxPlayers + ').'); return; }
    var playerId = uuid();
    found.players.push({ id: playerId, socketId: socket.id, name: data.name || 'Player', avatar: data.avatar || '🎲', isBot: false, isReady: false, connected: true });
    players.set(socket.id, { roomId: found.id, playerId: playerId });
    socket.join(found.id);
    socket.emit('joinedRoom', { roomId: found.id, code: found.code, playerId: playerId });
    emitLobby(found);
  });

  socket.on('setMaxPlayers', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room || room.status !== 'lobby' || room.host !== info.playerId) return;
    var n = Math.max(2, Math.min(6, data.maxPlayers || 6));
    while (room.players.length > n) {
      var botIdx = -1;
      for (var i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].isBot) { botIdx = i; break; }
      }
      if (botIdx !== -1) room.players.splice(botIdx, 1);
      else break;
    }
    room.maxPlayers = n;
    emitLobby(room);
  });

  socket.on('addBot', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room || room.status !== 'lobby' || room.host !== info.playerId) return;
    if (room.players.length >= room.maxPlayers) { socket.emit('actionError', 'Room is full.'); return; }
    var diff = (data && data.difficulty) || 'regular';
    if (!DIFF_CFG[diff]) diff = 'regular';
    room.players.push(createBotPlayer(diff));
    emitLobby(room);
  });

  socket.on('removeBot', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room || room.status !== 'lobby' || room.host !== info.playerId) return;
    var botIdx = -1;
    if (data && data.botId) {
      botIdx = room.players.findIndex(function(p) { return p.id === data.botId && p.isBot; });
    } else {
      for (var i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].isBot) { botIdx = i; break; }
      }
    }
    if (botIdx !== -1) { room.players.splice(botIdx, 1); emitLobby(room); }
  });

  socket.on('setBotDifficulty', function(data) {
    var info = players.get(socket.id);
    if (!info || !data) return;
    var room = rooms.get(info.roomId);
    if (!room || room.status !== 'lobby' || room.host !== info.playerId) return;
    var bot = room.players.find(function(p) { return p.id === data.botId && p.isBot; });
    if (bot && DIFF_CFG[data.difficulty]) {
      bot.difficulty = data.difficulty;
      emitLobby(room);
    }
  });

  socket.on('kickPlayer', function(data) {
    var info = players.get(socket.id);
    if (!info || !data) return;
    var room = rooms.get(info.roomId);
    if (!room || room.host !== info.playerId) return;
    var targetId = data.playerId;
    if (targetId === info.playerId) return; // Can't kick yourself
    var target = room.players.find(function(p) { return p.id === targetId; });
    if (!target) return;
    if (target.isBot) {
      // Just remove bots
      room.players = room.players.filter(function(p) { return p.id !== targetId; });
    } else {
      // Kick human player
      if (target.socketId) {
        var tSock = io.sockets.sockets.get(target.socketId);
        if (tSock) {
          tSock.emit('kicked', { reason: 'Host removed you from the lobby.' });
          tSock.leave(room.id);
        }
        players.delete(target.socketId);
      }
      room.players = room.players.filter(function(p) { return p.id !== targetId; });
    }
    emitLobby(room);
  });

  socket.on('endCurrentGame', function() {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room || room.host !== info.playerId) return;
    if (room.status !== 'playing') return;
    clearTimeout(room.turnTimer);
    room.status = 'finished';
    room.gameState.phase = 'gameOver';
    room.gameState.winner = null;
    io.to(room.id).emit('gameCancelled', { reason: 'Host ended the game.' });
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
    if (room.players.length < 2) { socket.emit('actionError', 'Need at least 2 players.'); return; }
    room.firstEliminated = null;
    startGame(room);
    emitLobby(room);
  });

  socket.on('restartGame', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    if (room.host !== info.playerId) { socket.emit('actionError', 'Only host can restart.'); return; }
    clearTimeout(room.turnTimer);

    // Replace disconnected players with bots
    var newPlayers = [];
    room.players.forEach(function(p) {
      if (!p.isBot && !p.connected) {
        // Player left — replace with bot at same seat
        var replacement = createBotPlayer(data && data.botDifficulty || 'regular');
        replacement.name = p.name + ' (Bot)';
        newPlayers.push(replacement);
        if (p.socketId) players.delete(p.socketId);
      } else {
        newPlayers.push(p);
      }
    });
    room.players = newPlayers;

    // Optionally shuffle player order
    if (data && data.randomizeSeats) {
      for (var i = room.players.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = room.players[i];
        room.players[i] = room.players[j];
        room.players[j] = temp;
      }
    }
    var prevFirstElim = room.firstEliminated;
    room.firstEliminated = null;
    // Reset players
    room.players.forEach(function(p) {
      p.isReady = true;
      p.isEliminated = false;
      if (!p.isBot) p.connected = true;
    });
    // Start new game
    room.status = 'playing';
    var c = { mode: room.mode, startingDice: 5, turnTimer: 30, maxDice: 5, playerCount: room.players.length };
    var ps = room.players.map(function(p) {
      return { id: p.id, name: p.name, diceCount: c.startingDice, dice: [], isBot: p.isBot, isEliminated: false, avatar: p.avatar, diceSkin: 'default' };
    });
    room.gameState = { config: c, players: ps, cpi: 0, currentBid: null, round: 0, phase: 'waiting', isPal: false, palId: null, history: [], result: null, winner: null };
    var first;
    if (data && data.firstLoserStarts && prevFirstElim) {
      first = room.players.findIndex(function(p) { return p.id === prevFirstElim; });
      if (first === -1) first = Math.floor(Math.random() * room.players.length);
    } else {
      first = Math.floor(Math.random() * room.players.length);
    }
    room.gameState = startRoundServer(room.gameState, first);
    io.to(room.id).emit('rematchStarting', { randomized: !!(data && data.randomizeSeats), firstLoserStarts: !!(data && data.firstLoserStarts) });
    emitGameState(room);
    startTurnTimer(room);
    emitLobby(room);
  });

  socket.on('endLobby', function() {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    if (room.host !== info.playerId) return;
    clearTimeout(room.turnTimer);
    io.to(room.id).emit('lobbyEnded');
    room.players.forEach(function(p) {
      if (p.socketId) {
        players.delete(p.socketId);
        var s = io.sockets.sockets.get(p.socketId);
        if (s) s.leave(room.id);
      }
    });
    rooms.delete(room.id);
  });

  socket.on('startGameWithOptions', function() {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room || room.status !== 'lobby') return;
    if (room.host !== info.playerId) { socket.emit('actionError', 'Only host can start.'); return; }
    if (room.players.length < 2) { socket.emit('actionError', 'Need at least 2 players.'); return; }
    room.firstEliminated = null;
    startGame(room);
    emitLobby(room);
  });

  // --- MATCHMAKING ---
  socket.on('searchGame', function(data) {
    removeFromQueue(socket.id);
    matchQueue.push({ socketId: socket.id, name: data.name || 'Player', avatar: data.avatar || '🎲', mode: data.mode || 'basic', partyMembers: null, joinedAt: Date.now() });
    socket.emit('queueJoined', { position: matchQueue.length });
    tryMatchmake();
  });

  socket.on('cancelSearch', function() {
    removeFromQueue(socket.id);
    socket.emit('queueLeft');
  });

  // --- PARTY ---
  socket.on('createParty', function(data) {
    var partyId = uuid();
    var code = genCode(4);
    var party = { id: partyId, code: code, leader: socket.id, members: [{ socketId: socket.id, name: data.name || 'Player', avatar: data.avatar || '🎲' }] };
    parties.set(partyId, party);
    socket.partyId = partyId;
    socket.emit('partyCreated', { partyId: partyId, code: code });
    socket.emit('partyUpdate', { id: party.id, code: party.code, leader: party.leader, members: party.members });
  });

  socket.on('joinParty', function(data) {
    var found = null;
    parties.forEach(function(party) { if (party.code === data.code.toUpperCase()) found = party; });
    if (!found) { socket.emit('actionError', 'Party not found.'); return; }
    if (found.members.length >= 5) { socket.emit('actionError', 'Party is full (max 5).'); return; }
    found.members.push({ socketId: socket.id, name: data.name || 'Player', avatar: data.avatar || '🎲' });
    socket.partyId = found.id;
    socket.emit('partyJoined', { partyId: found.id, code: found.code });
    found.members.forEach(function(m) {
      var s = io.sockets.sockets.get(m.socketId);
      if (s) s.emit('partyUpdate', { id: found.id, code: found.code, leader: found.leader, members: found.members });
    });
  });

  socket.on('leaveParty', function() {
    if (!socket.partyId) return;
    var party = parties.get(socket.partyId);
    if (!party) return;
    party.members = party.members.filter(function(m) { return m.socketId !== socket.id; });
    socket.partyId = null;
    if (party.members.length === 0) { parties.delete(party.id); return; }
    if (party.leader === socket.id) party.leader = party.members[0].socketId;
    party.members.forEach(function(m) {
      var s = io.sockets.sockets.get(m.socketId);
      if (s) s.emit('partyUpdate', { id: party.id, code: party.code, leader: party.leader, members: party.members });
    });
  });

  socket.on('partySearch', function(data) {
    if (!socket.partyId) { socket.emit('actionError', 'Not in a party.'); return; }
    var party = parties.get(socket.partyId);
    if (!party || party.leader !== socket.id) { socket.emit('actionError', 'Only party leader can search.'); return; }
    party.members.forEach(function(m) { removeFromQueue(m.socketId); });
    matchQueue.push({ socketId: socket.id, name: party.members[0].name, avatar: party.members[0].avatar, mode: data.mode || 'basic', partyMembers: party.members.slice(), joinedAt: Date.now() });
    party.members.forEach(function(m) {
      var s = io.sockets.sockets.get(m.socketId);
      if (s) s.emit('queueJoined', { position: matchQueue.length, asParty: true });
    });
    tryMatchmake();
  });

  socket.on('partyCancelSearch', function() {
    removeFromQueue(socket.id);
    if (socket.partyId) {
      var party = parties.get(socket.partyId);
      if (party) { party.members.forEach(function(m) { var s = io.sockets.sockets.get(m.socketId); if (s) s.emit('queueLeft'); }); }
    }
  });

  // --- GAME ACTIONS ---
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

  // --- CHAT ---
  socket.on('chat', function(msg) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    var p = room.players.find(function(pl) { return pl.id === info.playerId; });
    if (!p) return;
    io.to(room.id).emit('chat', { sender: p.name, message: msg, avatar: p.avatar });
  });

  // --- VOICE SIGNALING ---
  socket.on('voiceOffer', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    var target = room.players.find(function(p) { return p.id === data.targetId; });
    if (target && target.socketId) {
      var tSock = io.sockets.sockets.get(target.socketId);
      if (tSock) tSock.emit('voiceOffer', { fromId: info.playerId, offer: data.offer });
    }
  });

  socket.on('voiceAnswer', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    var target = room.players.find(function(p) { return p.id === data.targetId; });
    if (target && target.socketId) {
      var tSock = io.sockets.sockets.get(target.socketId);
      if (tSock) tSock.emit('voiceAnswer', { fromId: info.playerId, answer: data.answer });
    }
  });

  socket.on('voiceIce', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    var target = room.players.find(function(p) { return p.id === data.targetId; });
    if (target && target.socketId) {
      var tSock = io.sockets.sockets.get(target.socketId);
      if (tSock) tSock.emit('voiceIce', { fromId: info.playerId, candidate: data.candidate });
    }
  });

  socket.on('voiceToggle', function(data) {
    var info = players.get(socket.id);
    if (!info) return;
    io.to(info.roomId).emit('voiceToggle', { playerId: info.playerId, muted: data.muted });
  });

  // --- DISCONNECT ---
  socket.on('disconnect', function() {
    console.log('Disconnected: ' + socket.id);
    removeFromQueue(socket.id);
    if (socket.partyId) {
      var party = parties.get(socket.partyId);
      if (party) {
        party.members = party.members.filter(function(m) { return m.socketId !== socket.id; });
        if (party.members.length === 0) parties.delete(party.id);
        else {
          if (party.leader === socket.id) party.leader = party.members[0].socketId;
          party.members.forEach(function(m) {
            var s = io.sockets.sockets.get(m.socketId);
            if (s) s.emit('partyUpdate', { id: party.id, code: party.code, leader: party.leader, members: party.members });
          });
        }
      }
    }
    var info = players.get(socket.id);
    if (!info) return;
    var room = rooms.get(info.roomId);
    if (!room) return;
    var p = room.players.find(function(pl) { return pl.id === info.playerId; });
    var pName = p ? p.name : 'A player';
    var pAvatar = p ? p.avatar : '❓';
    if (p) p.connected = false;
    players.delete(socket.id);
    // Notify remaining players
    io.to(room.id).emit('playerLeft', { name: pName, avatar: pAvatar, playerId: info.playerId });
    if (room.status === 'lobby') {
      room.players = room.players.filter(function(pl) { return pl.id !== info.playerId; });
      if (room.players.filter(function(p2) { return !p2.isBot; }).length === 0) { rooms.delete(room.id); return; }
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
    if (room.status === 'finished') {
      room.players = room.players.filter(function(pl) { return pl.id !== info.playerId; });
      if (room.players.filter(function(p2) { return !p2.isBot; }).length === 0) { rooms.delete(room.id); }
      else emitLobby(room);
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

// ============================================================
// REST ENDPOINTS
// ============================================================
app.get('/health', function(req, res) {
  res.json({ status: 'ok', rooms: rooms.size, players: players.size, queue: matchQueue.length, parties: parties.size });
});

app.get('/rooms', function(req, res) {
  var publicRooms = [];
  rooms.forEach(function(room) {
    if (room.status === 'lobby' && room.isPublic) {
      publicRooms.push({ code: room.code, mode: room.mode, playerCount: room.players.filter(function(p) { return !p.isBot; }).length, maxPlayers: room.maxPlayers });
    }
  });
  res.json(publicRooms);
});

setInterval(function() {
  var now = Date.now();
  rooms.forEach(function(room, id) { if (now - room.createdAt > 60 * 60 * 1000) rooms.delete(id); });
  parties.forEach(function(party, id) { if (party.members.length === 0) parties.delete(id); });
  for (var i = matchQueue.length - 1; i >= 0; i--) {
    if (now - matchQueue[i].joinedAt > 5 * 60 * 1000) matchQueue.splice(i, 1);
  }
}, 5 * 60 * 1000);

server.listen(PORT, function() {
  console.log('Liars Dice server v2 running on port ' + PORT);
});
