const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { Server: IOServer } = require('socket.io');

const { setupFindingGame } = require('./public/finding-game/server');
const { setupRacingGame } = require('./public/racing/server');
const { setupPikachuGame } = require('./public/pikachu/server-io');

const PORT = process.env.PORT || 3000;

function serveStatic(req, res) {
  // Let Socket.IO handle its own client and handshake routes
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith('/socket.io/')) {
      return; // allow other listeners (Socket.IO) to respond
    }
  } catch (_) {
    // ignore URL parse errors
  }
  const routes = [
    { base: '/', dir: path.join(__dirname, 'public', 'create') },
    { base: '/create', dir: path.join(__dirname, 'public', 'create') },
    { base: '/finding-game', dir: path.join(__dirname, 'public', 'finding-game') },
    { base: '/racing', dir: path.join(__dirname, 'public', 'racing') },
    { base: '/pikachu', dir: path.join(__dirname, 'public', 'pikachu', 'public') },
  ];
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  for (const { base, dir } of routes) {
    if (pathname === base) {
      // Root and Create always serve index.html
      if (base === '/' || base === '/create') {
        const filePath = path.join(dir, 'index.html');
        return fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(500); return res.end('Error'); }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      }
      // For '/finding-game', '/racing', '/pikachu' without a code, fall through
    }
    if (pathname.startsWith(base + '/')) {
      let urlPath = pathname.slice(base.length + 1); // portion after '/{base}/'
      const segs = urlPath.split('/').filter(Boolean);
      // Special-case: '/create/' should serve its index
      if (base === '/create' && segs.length === 0) {
        urlPath = 'index.html';
      } else if (segs.length === 0) {
        // '/{game}/' should not serve index; skip to allow global 404 handler
        continue;
      }
      // Support '/{game}/{CODE}' by serving index.html
      if (segs.length === 1 && /^[A-Za-z0-9]{3,12}$/.test(segs[0])) {
        urlPath = 'index.html';
      }
      const filePath = path.join(dir, urlPath);
      if (!filePath.startsWith(dir)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      return fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const types = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon'
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
      });
    }
  }

  // Global 404: serve Create page content directly (no redirect)
  const createPath = path.join(__dirname, 'public', 'create', 'index.html');
  fs.readFile(createPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// Socket.IO for Pikachu
const ioPikachu = new IOServer(server, {
  // default path '/socket.io' is expected by the client script
  cors: { origin: '*' },
  serveClient: true,
});
setupPikachuGame(ioPikachu);

const wssFinding = new WebSocket.Server({ noServer: true });
setupFindingGame(wssFinding);

const wssRacing = new WebSocket.Server({ noServer: true });
setupRacingGame(wssRacing);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/finding-game') {
    wssFinding.handleUpgrade(req, socket, head, ws => {
      wssFinding.emit('connection', ws, req);
    });
  } else if (pathname === '/racing') {
    wssRacing.handleUpgrade(req, socket, head, ws => {
      wssRacing.emit('connection', ws, req);
    });
  } else {
    // Other upgrades (e.g., Socket.IO) are handled by their own listeners
    // Do not destroy the socket here.
  }
});

server.listen(PORT);
