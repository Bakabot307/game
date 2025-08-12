const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const BASE_PATH = '/racing';

// Board
const WIDTH = 10;
const HEIGHT = 20;
const MAX_PLAYERS = 4;

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
  blockDrop: { cost: 3 },      // +2 junk rows
  columnBomb: { cost: 4 },     // clear one column
  freezeRival: { cost: 5 }     // freeze random rival 2s
};
const FREEZE_MS = 2000;

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

function topRowOwnerId(board) {
  for (let c = 0; c < WIDTH; c++) {
    const cell = board[0][c];
    if (cell && cell.ownerId) return cell.ownerId;
  }
  return null;
}

function makeQueue() {
  // simple random queue
  return Array.from({ length: 5 }, () => randomKind());
}

// ----------- Room / Game

function setupRacingGame(wss) {
  const room = {
    board: emptyBoard(),
    players: new Map(), // id -> player
    tick: 0,
    gravityMs: GRAVITY_START,
    lastSpeedUp: Date.now(),
    startedAt: Date.now()
  };

  function broadcast(obj) {
    const txt = JSON.stringify(obj);
    for (const p of room.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(txt);
    }
  }

  function stateForClient() {
    const players = {};
    room.players.forEach((p, id) => {
      players[id] = {
        id,
        name: p.name,
        color: p.color,
        ap: p.ap,
        frozenUntil: p.frozenUntil,
        active: p.active ? {
          kind: p.active.kind, x: p.active.x, y: p.active.y, rot: p.active.rot
        } : null
      };
    });
    // compress board to color strings or null
    const board = room.board.map(row => row.map(cell => cell ? cell.color : null));
    return { type: 'state', board, players, winnerId: room.winnerId || null };
  }

  function broadcastState() { broadcast(stateForClient()); }

  function spawnNewPiece(p) {
    if (p.queue.length < 3) p.queue.push(randomKind(), randomKind());
    const kind = p.queue.shift();
    const shape = SHAPES[kind][0];
    const w = shape[0].length;

    const x = Math.floor((WIDTH - w) / 2);
    const y = 0;
    const base = { ownerId: p.id, color: p.color, kind, rot: 0, x, y, lastFallAt: Date.now(), groundedAt: null };

    // try spawn + small horizontal wiggle if blocked
    let spawned = base;
    const kicks = [0, -1, 1, -2, 2];
    let ok = false;
    for (const k of kicks) {
      const tryP = { ...base, x: base.x + k };
      if (canPlace(room.board, tryP)) { spawned = tryP; ok = true; break; }
    }
    if (!ok) {
      // board blocked → end immediately; attacker plausibly wins
      room.winnerId = p.id;
      broadcast({ type: 'winner', winnerId: p.id, name: p.name });
      return;
    }
    p.active = spawned;
  }

  function ensureActivePieces() {
    for (const p of room.players.values()) {
      if (!p.active) spawnNewPiece(p);
    }
  }

  function stepGravity(now) {
    for (const p of room.players.values()) {
      if (!p.active) continue;
      // skip if frozen (still falls)
      const due = now - p.active.lastFallAt >= room.gravityMs;
      if (!due) continue;

      const down = { ...p.active, y: p.active.y + 1 };
      if (canPlace(room.board, down)) {
        p.active = { ...down, lastFallAt: now };
        p.active.groundedAt = null;
      } else {
        // on ground
        if (p.active.groundedAt == null) p.active.groundedAt = now;
        p.active.lastFallAt = now;
        if (now - p.active.groundedAt >= LOCK_DELAY_MS) {
          lockNow(p);
        }
      }
    }
  }

  function doLineClearAwards(player, clearedRowsCount) {
    if (clearedRowsCount <= 0) return;
    const gain = (clearedRowsCount === 1) ? 1 : (clearedRowsCount === 2) ? 2 : 3;
    player.ap = Math.min(AP_CAP, player.ap + gain);
    broadcast({ type: 'event', kind: 'apGain', playerId: player.id, gain, ap: player.ap });
  }

  function lockNow(p) {
    lockToBoard(room.board, p.active, p.id, p.color);
    // win check by top ownership (this player's cells reaching top)
    let win = false;
    for (let c = 0; c < WIDTH; c++) {
      const cell = room.board[0][c];
      if (cell && cell.ownerId === p.id) { win = true; break; }
    }
    // line clears
    const rows = detectFullRows(room.board);
    if (rows.length) {
      clearRows(room.board, rows);
      doLineClearAwards(p, rows.length);
    }
    if (win) {
      room.winnerId = p.id;
      broadcast({ type: 'winner', winnerId: p.id, name: p.name });
    }
    p.active = null; // will respawn next tick
  }

  function tryMove(p, dx, dy) {
    if (!p.active) return;
    const cand = { ...p.active, x: p.active.x + dx, y: p.active.y + dy };
    if (canPlace(room.board, cand)) {
      p.active = cand;
      if (dy !== 0) {
        p.active.lastFallAt = Date.now();
        p.active.groundedAt = null;
      }
    } else if (dy > 0) {
      // attempt to lock sooner if soft drop into ground
      if (p.active.groundedAt == null) p.active.groundedAt = Date.now();
    }
  }

  function tryHardDrop(p) {
    if (!p.active) return;
    let cur = p.active;
    while (true) {
      const nxt = { ...cur, y: cur.y + 1 };
      if (canPlace(room.board, nxt)) cur = nxt;
      else break;
    }
    p.active = { ...cur, groundedAt: Date.now() - LOCK_DELAY_MS };
    lockNow(p);
  }

  function handlePower(p, msg) {
    if (!msg || !msg.kind || !POWERS[msg.kind]) return;
    if (p.ap < POWERS[msg.kind].cost) return;
    p.ap -= POWERS[msg.kind].cost;

    if (msg.kind === 'blockDrop') {
      // Add 2 junk rows bottom (shared board)
      for (let i = 0; i < 2; i++) {
        const gap = Math.floor(Math.random() * WIDTH);
        const row = Array.from({ length: WIDTH }, (_, x) => (x === gap ? null : { ownerId: 'junk', color: '#555' }));
        room.board.shift();        // remove top
        room.board.push(row);      // push junk
      }
      // if any active overlaps with filled cell, nudge up; if out-of-top, just lock it
      for (const pl of room.players.values()) {
        if (!pl.active) continue;
        let overlaps = !canPlace(room.board, pl.active);
        while (overlaps && pl.active.y > 0) {
          pl.active = { ...pl.active, y: pl.active.y - 1 };
          overlaps = !canPlace(room.board, pl.active);
        }
        if (overlaps) { // still overlaps at y==0 → lock immediately
          pl.active.groundedAt = Date.now() - LOCK_DELAY_MS;
          lockNow(pl);
        }
      }
      broadcast({ type: 'event', kind: 'power', power: 'blockDrop', by: p.id });
    }

    if (msg.kind === 'columnBomb') {
      const col = Math.max(0, Math.min(WIDTH - 1, msg.col ?? Math.floor(WIDTH / 2)));
      for (let r = 0; r < HEIGHT; r++) room.board[r][col] = null;
      broadcast({ type: 'event', kind: 'power', power: 'columnBomb', by: p.id, col });
    }

    if (msg.kind === 'freezeRival') {
      const rivals = [...room.players.values()].filter(r => r.id !== p.id);
      if (rivals.length) {
        const target = rivals[Math.floor(Math.random() * rivals.length)];
        target.frozenUntil = Date.now() + FREEZE_MS;
        broadcast({ type: 'event', kind: 'power', power: 'freezeRival', by: p.id, target: target.id, durMs: FREEZE_MS });
      }
    }
  }

  function speedRamp(now) {
    if (now - room.lastSpeedUp >= GRAVITY_STEP_EVERY) {
      room.gravityMs = Math.max(GRAVITY_MIN, room.gravityMs - GRAVITY_STEP_DELTA);
      room.lastSpeedUp = now;
      broadcast({ type: 'event', kind: 'speedUp', gravityMs: room.gravityMs });
    }
  }

  function gameTick() {
    if (room.winnerId) return; // stop physics but still allow state to be seen

    const now = Date.now();
    speedRamp(now);

    ensureActivePieces();

    stepGravity(now);

    // End condition check in case of top-row after junk etc.
    const winner = topRowOwnerId(room.board);
    if (winner && !room.winnerId) {
      room.winnerId = winner;
      const wp = room.players.get(winner);
      broadcast({ type: 'winner', winnerId: winner, name: wp ? wp.name : 'Player' });
    }

    // broadcast small deltas? For simplicity, send full state.
    broadcastState();
    room.tick++;
  }

  const tickTimer = setInterval(gameTick, TICK_MS);

  // --- WS Handling
  wss.on('connection', ws => {
    if (room.players.size >= MAX_PLAYERS) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Room full' }));
      ws.close();
      return;
    }

    const id = Math.random().toString(36).slice(2);
    const color = COLORS[room.players.size];
    const player = {
      id, ws,
      name: `P${room.players.size + 1}`,
      color,
      ap: 0,
      frozenUntil: 0,
      queue: makeQueue(),
      active: null
    };
    room.players.set(id, player);

    ws.send(JSON.stringify({ type: 'welcome', id, color, width: WIDTH, height: HEIGHT }));
    broadcastState();

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || msg.id !== id) return;
      const now = Date.now();
      const isFrozen = player.frozenUntil && now < player.frozenUntil;

      if (msg.type === 'move') {
        if (!player.active) return;
        if (isFrozen && (msg.dir === 'left' || msg.dir === 'right' || msg.dir === 'rotCW' || msg.dir === 'rotCCW')) return;

        if (msg.dir === 'left') tryMove(player, -1, 0);
        else if (msg.dir === 'right') tryMove(player, 1, 0);
        else if (msg.dir === 'soft') tryMove(player, 0, 1);
        else if (msg.dir === 'hard') tryHardDrop(player);
        else if (msg.dir === 'rotCW') player.active = tryRotate(room.board, player.active, 'cw');
        else if (msg.dir === 'rotCCW') player.active = tryRotate(room.board, player.active, 'ccw');
      }

      if (msg.type === 'power') handlePower(player, msg);
    });

    ws.on('close', () => {
      room.players.delete(id);
      if (room.players.size === 0) {
        // reset room if empty
        room.board = emptyBoard();
        room.tick = 0;
        room.gravityMs = GRAVITY_START;
        room.lastSpeedUp = Date.now();
        room.winnerId = null;
      } else {
        broadcastState();
      }
    });
  });

  // HTTP server in same process
  return tickTimer;
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
