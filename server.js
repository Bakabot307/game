const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const { setupFindingGame } = require('./public/finding-game/server');
const { setupRacingGame } = require('./public/racing/server');

const PORT = process.env.PORT || 3000;

function serveStatic(req, res) {
  const routes = [
    { base: '/finding-game', dir: path.join(__dirname, 'public', 'finding-game') },
    { base: '/racing', dir: path.join(__dirname, 'public', 'racing') },
  ];

  for (const { base, dir } of routes) {
    if (req.url === base || req.url.startsWith(base + '/')) {
      let urlPath = req.url;
      if (urlPath === '/' || urlPath === base) {
        urlPath = '/index.html';
      } else {
        urlPath = urlPath.slice(base.length);
      }
      let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
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

  res.writeHead(404);
  res.end('Not Found');
}

const server = http.createServer(serveStatic);

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
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log('Listening on http://localhost:' + PORT);
});
