const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const BASE_PATH = '/racing';

const WIDTH = 10;
const HEIGHT = 20;
const COLORS = ['red', 'blue', 'green', 'yellow'];

function setupRacingGame(wss) {
  const board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
  const players = new Map();
  let tickRate = 1000;
  let placed = 0;
  let tickTimer = null;

  function startTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(gameTick, tickRate);
  }

  function broadcast(obj) {
    const txt = JSON.stringify(obj);
    for (const p of players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(txt);
    }
  }

  function broadcastState() {
    const pstate = {};
    players.forEach((p, id) => { pstate[id] = { x: p.x, y: p.y, color: p.color, name: p.name }; });
    broadcast({ type: 'state', board, players: pstate });
  }

  function spawn(p) {
    p.x = Math.floor(WIDTH / 2);
    p.y = 0;
    if (board[p.y][p.x]) {
      // spawning into filled cell => player immediately loses space; reset
      broadcast({ type: 'winner', winner: p.name + ' (blocked)' });
    }
  }

  function clearLines() {
    for (let y = HEIGHT - 1; y >= 0; y--) {
      if (board[y].every(c => c)) {
        board.splice(y, 1);
        board.unshift(Array(WIDTH).fill(null));
        y++;
      }
    }
  }

  function handleLock(p) {
    board[p.y][p.x] = p.color;
    placed++;
    if (p.y === 0) {
      broadcast({ type: 'winner', winner: p.name });
      resetBoard();
    } else {
      clearLines();
      spawn(p);
      if (placed % 20 === 0 && tickRate > 200) {
        tickRate -= 100;
        startTick();
      }
    }
  }

  function gameTick() {
    for (const p of players.values()) {
      if (p.y == null) continue;
      if (p.y + 1 >= HEIGHT || board[p.y + 1][p.x]) {
        handleLock(p);
      } else {
        p.y++;
      }
    }
    broadcastState();
  }

  function handleMove(p, dir) {
    if (dir === 'left') {
      const nx = p.x - 1;
      if (nx >= 0 && !board[p.y][nx]) p.x = nx;
    } else if (dir === 'right') {
      const nx = p.x + 1;
      if (nx < WIDTH && !board[p.y][nx]) p.x = nx;
    } else if (dir === 'down') {
      if (p.y + 1 >= HEIGHT || board[p.y + 1][p.x]) {
        handleLock(p);
      } else {
        p.y++;
      }
    }
    broadcastState();
  }

  function resetBoard() {
    for (let y = 0; y < HEIGHT; y++) board[y].fill(null);
    players.forEach(p => spawn(p));
  }

  wss.on('connection', ws => {
    if (players.size >= COLORS.length) {
      ws.close();
      return;
    }
    const id = Math.random().toString(36).slice(2);
    const color = COLORS[players.size];
    const player = { id, color, ws, name: color, x: null, y: null };
    players.set(id, player);
    spawn(player);
    ws.send(JSON.stringify({ type: 'welcome', id, color }));
    broadcastState();

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'move' && msg.id === id) handleMove(player, msg.dir);
    });

    ws.on('close', () => {
      players.delete(id);
      broadcastState();
    });
  });

  startTick();
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
    let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      const ext = path.extname(filePath).toLowerCase();
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });
  const wss = new WebSocket.Server({ server });
  setupRacingGame(wss);
  server.listen(PORT, () => {
    console.log('Listening on http://localhost:' + PORT);
  });
}
