const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const BASE_PATH = '/racing';

// Board
let WIDTH = 12;
const HEIGHT = 24;
const MAX_PLAYERS = 4;

function calcWidth(playerCount) {
  return Math.min(11, 2 * playerCount + 3);
}

// Timing
const TICK_MS = 50;          // 20 tps
const GRAVITY_START = 800;   // ms per cell at level 1
const GRAVITY_MIN = 150;     // ms per cell cap
const GRAVITY_STEP_EVERY = 45000; // ms: speed up
const GRAVITY_STEP_DELTA = 50;    // ms faster each step
const LOCK_DELAY_MS = 500;

// AP / Powers
const AP_CAP = 10;
const POWERS = {
  blockDrop: { cost: 2 },      // +2 junk rows
  columnBomb: { cost: 2 },     // clear one column
  freezeRival: { cost: 2 },    // freeze random rival until their turn ends
  spareFill: { cost: 2 }       // fill near-complete rows
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];

const SHAPES = {
  I: [
    [[1, 1, 1, 1]],
    [[1], [1], [1], [1]]
  ],
  O: [
    [[1, 1], [1, 1]]
  ],
  T: [
    [[1, 1, 1], [0, 1, 0]],
    [[0, 1], [1, 1], [0, 1]],
    [[0, 1, 0], [1, 1, 1]],
    [[1, 0], [1, 1], [1, 0]]
  ],
  J: [
    [[1, 0, 0], [1, 1, 1]],
    [[1, 1], [1, 0], [1, 0]],
    [[1, 1, 1], [0, 0, 1]],
    [[0, 1], [0, 1], [1, 1]]
  ],
  L: [
    [[0, 0, 1], [1, 1, 1]],
    [[1, 0], [1, 0], [1, 1]],
    [[1, 1, 1], [1, 0, 0]],
    [[1, 1], [0, 1], [0, 1]]
  ],
  S: [
    [[0, 1, 1], [1, 1, 0]],
    [[1, 0], [1, 1], [0, 1]]
  ],
  Z: [
    [[1, 1, 0], [0, 1, 1]],
    [[0, 1], [1, 1], [1, 0]]
  ]
};
const KINDS = Object.keys(SHAPES);

// ----------- Utility

function emptyBoard() {
  return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
}

function cloneBoard(b) {
  return b.map(row => row.slice());
}

function randomKind() {
  return KINDS[Math.floor(Math.random() * KINDS.length)];
}

function cellFree(board, x, y) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
  return board[y][x] === null;
}

function pieceCells(piece) {
  const mat = SHAPES[piece.kind][piece.rot];
  const pts = [];
  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (mat[r][c]) pts.push({ x: piece.x + c, y: piece.y + r });
    }
  }
  return pts;
}

function canPlace(board, piece) {
  const pts = pieceCells(piece);
  for (const p of pts) {
    if (p.x < 0 || p.x >= WIDTH || p.y < 0 || p.y >= HEIGHT) return false;
    if (board[p.y][p.x] !== null) return false;
  }
  return true;
}

function rotate(piece, dir) {
  const max = SHAPES[piece.kind].length;
  const next = (piece.rot + (dir === 'cw' ? 1 : -1) + max) % max;
  return { ...piece, rot: next };
}

// very light kick (try staying, shift ±1, ±2)
function tryRotate(board, piece, dir) {
  let cand = rotate(piece, dir);
  const kicks = [0, -1, 1, -2, 2];
  for (const k of kicks) {
    const p2 = { ...cand, x: cand.x + k };
    if (canPlace(board, p2)) return p2;
  }
  return piece;
}

function lockToBoard(board, piece, ownerId, color) {
  const b = board;
  const pts = pieceCells(piece);
  for (const p of pts) {
    if (p.y >= 0 && p.y < HEIGHT && p.x >= 0 && p.x < WIDTH) {
      b[p.y][p.x] = { ownerId, color };
    }
  }
}

function detectFullRows(board) {
  const rows = [];
  for (let r = 0; r < HEIGHT; r++) {
    if (board[r].every(c => c !== null)) rows.push(r);
  }
  return rows;
}

function clearRows(board, rows) {
  rows.sort((a, b) => a - b);
  for (const r of rows) board.splice(r, 1);
  while (board.length < HEIGHT) board.unshift(Array(WIDTH).fill(null));
}

function topRowOwnerId(room) {
  for (let c = 0; c < WIDTH; c++) {
    const cell = room.board[0][c];
    if (cell && cell.ownerId) {
      const p = room.players.get(cell.ownerId);
      if (p && p.ap >= 10 && !p.eliminated) return cell.ownerId;
    }
  }
  return null;
}

function makeQueue() {
  // simple random queue
  return Array.from({ length: 5 }, () => randomKind());
}

// room code helper
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeRoomCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// ----------- Room / Game

function createRoom(code) {
  return {
    code,
    board: emptyBoard(),
    players: new Map(),
    tick: 0,
    gravityMs: GRAVITY_START,
    lastSpeedUp: Date.now(),
    turnOrder: [],
    turnIndex: 0,
    turnId: null,   // block turn
    winnerId: null,
    hostId: null,
    started: false,
  };
}

function setupRacingGame(wss) {
  const rooms = new Map();

  function getRoom(code) {
    if (!rooms.has(code)) rooms.set(code, createRoom(code));
    return rooms.get(code);
  }

  function broadcast(room, obj) {
    const txt = JSON.stringify(obj);
    for (const p of room.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(txt);
    }
  }

  function stateForClient(room) {
    const players = {};
    room.players.forEach((p, id) => {
      players[id] = {
        id,
        name: p.name,
        color: p.color,
        ap: p.ap,
        frozenUntil: p.frozenUntil,
        usedPower: p.usedPower,
        eliminated: p.eliminated,
        active: p.active ? {
          kind: p.active.kind, x: p.active.x, y: p.active.y, rot: p.active.rot
        } : null
      };
    });
    const board = room.board.map(row => row.map(cell => cell ? cell.color : null));
    return { type: 'state', board, players, width: WIDTH, height: HEIGHT, winnerId: room.winnerId || null, turnId: room.turnId, hostId: room.hostId, started: room.started };
  }

  function broadcastState(room) { broadcast(room, stateForClient(room)); }

  function spawnNewPiece(room, p) {
    if (p.queue.length < 3) p.queue.push(randomKind(), randomKind());
    const kind = p.queue.shift();
    const shape = SHAPES[kind][0];
    const w = shape[0].length;
    let x = 5;
    if (x + w > WIDTH) x = WIDTH - w;
    const y = 0;
    const base = { ownerId: p.id, color: p.color, kind, rot: 0, x, y, lastFallAt: Date.now(), groundedAt: null };
    if (!canPlace(room.board, base)) {
      broadcast(room, { type: 'event', kind: 'eliminated', playerId: p.id, name: p.name });
      p.eliminated = true;
      p.active = null;
      p.extraTurns = 0;
      const idx = room.turnOrder.indexOf(p.id);
      if (idx >= 0) {
        room.turnOrder.splice(idx, 1);
        if (idx < room.turnIndex) room.turnIndex--;
      }
      if (room.hostId === p.id) room.hostId = room.turnOrder[0] || null;
      if (room.turnOrder.length === 0) {
        room.turnId = null;
      } else {
        room.turnIndex = room.turnIndex % room.turnOrder.length;
        room.turnId = room.turnOrder[room.turnIndex];
      }
      if (room.turnOrder.length === 1) {
        const winnerId = room.turnOrder[0];
        room.winnerId = winnerId;
        const wp = room.players.get(winnerId);
        broadcast(room, { type: 'winner', winnerId, name: wp ? wp.name : undefined });
      }
      broadcastState(room);
      return;
    }
    p.active = base;
  }

  function ensureActivePieces(room) {
    if (!room.turnId) return;
    const p = room.players.get(room.turnId);
    if (p && !p.active && !p.eliminated) spawnNewPiece(room, p);
  }

  function stepGravity(room, now) {
    if (!room.turnId) return;
    const p = room.players.get(room.turnId);
    if (!p || !p.active || p.eliminated) return;
    const due = now - p.active.lastFallAt >= room.gravityMs;
    if (!due) return;
    const down = { ...p.active, y: p.active.y + 1 };
    if (canPlace(room.board, down)) {
      p.active = { ...down, lastFallAt: now };
      p.active.groundedAt = null;
    } else {
      if (p.active.groundedAt == null) p.active.groundedAt = now;
      p.active.lastFallAt = now;
      if (now - p.active.groundedAt >= LOCK_DELAY_MS) {
        lockNow(room, p);
      }
    }
  }

  function advanceTurn(room) {
    if (room.turnOrder.length === 0) {
      room.turnId = null;
      room.turnIndex = 0;
      return;
    }
    room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
    room.turnId = room.turnOrder[room.turnIndex];
  }

  function doLineClearAwards(room, player, clearedRowsCount) {
    if (clearedRowsCount <= 0) return;
    const gain = (clearedRowsCount === 1) ? 1 : (clearedRowsCount === 2) ? 2 : 3;
    player.ap = Math.min(AP_CAP, player.ap + gain);
    broadcast(room, { type: 'event', kind: 'apGain', playerId: player.id, gain, ap: player.ap });
  }

  function lockNow(room, p) {
    lockToBoard(room.board, p.active, p.id, p.color);
    let win = false;
    for (let c = 0; c < WIDTH; c++) {
      const cell = room.board[0][c];
      if (cell && cell.ownerId === p.id) { win = true; break; }
    }
    const rows = detectFullRows(room.board);
      if (rows.length) {
        clearRows(room.board, rows);
        doLineClearAwards(room, p, rows.length);
      }
      if (win && p.ap >= 10) {
        room.winnerId = p.id;
        broadcast(room, { type: 'winner', winnerId: p.id, name: p.name });
      }
      p.active = null;
      p.turns++;
      if (p.powerCooldown > 0) {
        p.powerCooldown--;
        if (p.powerCooldown === 0) p.usedPower = false;
      }
      p.frozenUntil = 0;
      try { p.ws.send(JSON.stringify({ type: 'chooseReward' })); } catch {}
      if (p.extraTurns > 0) {
        p.extraTurns--;
        room.turnId = p.id;
      } else {
      advanceTurn(room);
    }
    broadcastState(room);
  }

  function tryMove(room, p, dx, dy) {
    if (!p.active) return;
    const cand = { ...p.active, x: p.active.x + dx, y: p.active.y + dy };
    if (canPlace(room.board, cand)) {
      p.active = cand;
      if (dy !== 0) {
        p.active.lastFallAt = Date.now();
        p.active.groundedAt = null;
      }
    } else if (dy > 0) {
      if (p.active.groundedAt == null) p.active.groundedAt = Date.now();
    }
  }

  function tryHardDrop(room, p) {
    if (!p.active) return;
    let test = { ...p.active };
    let lastGood = test;
    while (true) {
      const next = { ...test, y: test.y + 1 };
      if (canPlace(room.board, next)) {
        lastGood = next;
        test = next;
      } else {
        p.active = lastGood;
        p.active.lastFallAt = Date.now();
        p.active.groundedAt = Date.now() - LOCK_DELAY_MS;
        lockNow(room, p);
        break;
      }
    }
  }

  function handlePower(room, p, msg) {
    if (p.eliminated) return;
    if (room.turnId === p.id) return;
    if (p.usedPower) return;
    if (!msg || !msg.kind || !POWERS[msg.kind]) return;
    if (p.ap < POWERS[msg.kind].cost) return;
      p.ap -= POWERS[msg.kind].cost;
      if (msg.kind === 'blockDrop') {
        for (let i = 0; i < 2; i++) {
          const gap = Math.floor(Math.random() * WIDTH);
          const row = Array.from({ length: WIDTH }, (_, x) => (x === gap ? null : { ownerId: 'junk', color: '#555' }));
          room.board.shift();
          room.board.push(row);
        }
        for (const pl of room.players.values()) {
          if (!pl.active) continue;
          let overlaps = !canPlace(room.board, pl.active);
          while (overlaps && pl.active.y > 0) {
            pl.active = { ...pl.active, y: pl.active.y - 1 };
            overlaps = !canPlace(room.board, pl.active);
          }
          if (overlaps) {
            pl.active.groundedAt = Date.now() - LOCK_DELAY_MS;
            lockNow(room, pl);
          }
        }
        broadcast(room, { type: 'event', kind: 'power', power: 'blockDrop', by: p.id });
      }
      if (msg.kind === 'columnBomb') {
        const col = Math.max(0, Math.min(WIDTH - 1, msg.col ?? Math.floor(WIDTH / 2)));
        for (let r = 0; r < HEIGHT; r++) room.board[r][col] = null;
        broadcast(room, { type: 'event', kind: 'power', power: 'columnBomb', by: p.id, col });
      }
      if (msg.kind === 'freezeRival') {
        const others = Array.from(room.players.values()).filter(pl => pl.id !== p.id && !pl.eliminated);
        if (others.length) {
          const target = others[Math.floor(Math.random() * others.length)];
          target.frozenUntil = Number.MAX_SAFE_INTEGER;
        }
        broadcast(room, { type: 'event', kind: 'power', power: 'freezeRival', by: p.id });
      }
      if (msg.kind === 'spareFill') {
        const targets = [];
        for (let r = 0; r < HEIGHT; r++) {
          const empties = room.board[r].reduce((a, c) => a + (c ? 0 : 1), 0);
          if (empties > 0 && empties <= 2) {
            for (let c = 0; c < WIDTH; c++) {
              if (room.board[r][c] === null) targets.push({ r, c });
            }
          }
        }
        for (let i = 0; i < 3 && targets.length > 0; i++) {
          const idx = Math.floor(Math.random() * targets.length);
          const { r, c } = targets.splice(idx, 1)[0];
          room.board[r][c] = { ownerId: 'junk', color: '#555' };
        }
        const rows = detectFullRows(room.board);
        if (rows.length) {
          clearRows(room.board, rows);
          doLineClearAwards(room, p, rows.length);
        }
        broadcast(room, { type: 'event', kind: 'power', power: 'spareFill', by: p.id });
      }
      p.usedPower = true;
      p.powerCooldown = 2;
      broadcastState(room);
      }

  function speedRamp(room, now) {
    if (now - room.lastSpeedUp >= GRAVITY_STEP_EVERY) {
      room.gravityMs = Math.max(GRAVITY_MIN, room.gravityMs - GRAVITY_STEP_DELTA);
      room.lastSpeedUp = now;
      broadcast(room, { type: 'event', kind: 'speedUp', gravityMs: room.gravityMs });
    }
  }

  function gameTick(room) {
    if (!room.started || room.winnerId) return;
    const now = Date.now();
    speedRamp(room, now);
    ensureActivePieces(room);
    stepGravity(room, now);
    const winner = topRowOwnerId(room);
    if (winner && !room.winnerId) {
      room.winnerId = winner;
      const wp = room.players.get(winner);
      broadcast(room, { type: 'winner', winnerId: winner, name: wp ? wp.name : 'Player' });
    }
    broadcastState(room);
    room.tick++;
  }

  setInterval(() => {
    for (const room of rooms.values()) gameTick(room);
  }, TICK_MS);

  wss.on('connection', (ws, req) => {
    const { searchParams } = new URL(req.url, 'http://localhost');
    let code = (searchParams.get('room') || makeRoomCode()).toUpperCase();
    const name = (searchParams.get('name') || '').trim();
    const room = getRoom(code);
    if (room.players.size >= MAX_PLAYERS) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Room full' }));
      ws.close();
      return;
    }
    if (!name) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Name required' }));
      ws.close();
      return;
    }
    const id = Math.random().toString(36).slice(2);
    const color = COLORS[room.players.size % COLORS.length];
  const player = {
    id, ws,
    name,
    color,
    ap: 1,
    frozenUntil: 0,
    queue: makeQueue(),
    active: null,
    usedPower: true,
    powerCooldown: 0,
    turns: 0,
    extraTurns: 0,
    eliminated: false,
  };
    room.players.set(id, player);
    room.turnOrder.push(id);
    if (!room.hostId) room.hostId = id;
    if (room.started && !room.turnId) room.turnId = id;

    ws.send(JSON.stringify({ type: 'welcome', id, color, width: WIDTH, height: HEIGHT, code, hostId: room.hostId }));
    broadcastState(room);

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || msg.id !== id) return;
      const now = Date.now();
      const isFrozen = player.frozenUntil && now < player.frozenUntil;

      if (msg.type === 'move') {
        if (player.eliminated) return;
        if (room.turnId !== id) return;
        if (!player.active) return;
        if (isFrozen) return;
        if (msg.dir === 'left') tryMove(room, player, -1, 0);
        else if (msg.dir === 'right') tryMove(room, player, 1, 0);
        else if (msg.dir === 'soft') tryMove(room, player, 0, 1);
        else if (msg.dir === 'hard') tryHardDrop(room, player);
        else if (msg.dir === 'rotCW') player.active = tryRotate(room.board, player.active, 'cw');
        else if (msg.dir === 'rotCCW') player.active = tryRotate(room.board, player.active, 'ccw');
      }

      if (msg.type === 'power') {
        if (player.eliminated) return;
        handlePower(room, player, msg);
      }

      if (msg.type === 'reward') {
        if (player.eliminated) return;
        if (msg.choice === 'extraTurn') {
          player.extraTurns++;
        } else {
          player.ap = Math.min(AP_CAP, player.ap + 1);
          broadcast(room, { type: 'event', kind: 'apGain', playerId: player.id, gain: 1, ap: player.ap });
        }
        broadcastState(room);
      }

      if (msg.type === 'start') {
        if (id !== room.hostId) return;
        WIDTH = calcWidth(room.players.size);
        room.board = emptyBoard();
        room.tick = 0;
        room.gravityMs = GRAVITY_START;
        room.lastSpeedUp = Date.now();
        room.winnerId = null;
        room.turnOrder = Array.from(room.players.keys());
        room.turnIndex = 0;
        room.turnId = room.turnOrder[0] || null;
        room.started = true;
        for (const pl of room.players.values()) {
          pl.ap = 1;
          pl.frozenUntil = 0;
          pl.queue = makeQueue();
          pl.active = null;
          pl.usedPower = false;
          pl.powerCooldown = 0;
          pl.turns = 0;
          pl.extraTurns = 0;
          pl.eliminated = false;
        }
        broadcastState(room);
      }

      if (msg.type === 'restart') {
        if (id !== room.hostId) return;
        WIDTH = calcWidth(room.players.size);
        room.board = emptyBoard();
        room.tick = 0;
        room.gravityMs = GRAVITY_START;
        room.lastSpeedUp = Date.now();
        room.winnerId = null;
        room.turnOrder = Array.from(room.players.keys());
        room.turnIndex = 0;
        room.turnId = room.turnOrder[0] || null;
        for (const pl of room.players.values()) {
          pl.ap = 1;
          pl.frozenUntil = 0;
          pl.queue = makeQueue();
          pl.active = null;
          pl.usedPower = false;
          pl.powerCooldown = 0;
          pl.turns = 0;
          pl.extraTurns = 0;
          pl.eliminated = false;
        }
        broadcastState(room);
      }
    });

    ws.on('close', () => {
      room.players.delete(id);
      const idx = room.turnOrder.indexOf(id);
      if (idx >= 0) {
        room.turnOrder.splice(idx, 1);
        if (idx < room.turnIndex) room.turnIndex--;
        if (room.turnId === id) advanceTurn(room);
      }
      if (room.hostId === id) room.hostId = room.turnOrder[0] || null;
      if (room.players.size === 0) {
        rooms.delete(room.code);
      }
      if (room.turnOrder.length === 1 && room.started && !room.winnerId) {
        const winnerId = room.turnOrder[0];
        room.winnerId = winnerId;
        const wp = room.players.get(winnerId);
        broadcast(room, { type: 'winner', winnerId, name: wp ? wp.name : undefined });
      }
      broadcastState(room);
    });
  });
}

module.exports = { setupRacingGame };

if (require.main === module) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    let urlPath = pathname;
    if (urlPath === '/' || urlPath === BASE_PATH) {
      urlPath = '/index.html';
    } else if (urlPath.startsWith(BASE_PATH + '/')) {
      urlPath = urlPath.slice(BASE_PATH.length);
    }
    const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : '.' + urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });

  const wss = new WebSocket.Server({ server, path: BASE_PATH });
  setupRacingGame(wss);

  server.listen(PORT, () => {
    console.log('Listening on http://localhost:' + PORT + BASE_PATH);
  });
}
