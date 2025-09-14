const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Logic = require('./server/game-logic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Room management
// room: { id, hostId, players: Map(socketId->{id,name,score}), state, board, level }
const rooms = new Map();
const globalLeaderboard = new Map(); // name -> total points

function genRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function getRoom(roomId) { return rooms.get(roomId); }

function serializeScores(room) {
  const list = [];
  for (const [sid, p] of room.players.entries()) list.push({ id: sid, name: p.name, score: p.score });
  list.sort((a, b) => b.score - a.score);
  return list;
}

function broadcastRoom(room, event, payload) {
  io.to(room.id).emit(event, payload);
}

io.on('connection', (socket) => {
  // Host creates a room
  socket.on('host:createRoom', ({ name }, ack) => {
    try {
      const roomId = genRoomId();
      const room = { id: roomId, hostId: socket.id, players: new Map(), state: 'lobby', board: null, level: 1 };
      rooms.set(roomId, room);
      socket.join(roomId);
      room.players.set(socket.id, { id: socket.id, name: name || 'Host', score: 0 });
      if (ack) ack({ ok: true, roomId, you: { id: socket.id, host: true }, scores: serializeScores(room), state: room.state, level: room.level });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // User joins existing room
  socket.on('user:joinRoom', ({ roomId, name }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    socket.join(roomId);
    room.players.set(socket.id, { id: socket.id, name: name || 'Player', score: 0 });
    broadcastRoom(room, 'room:playerJoined', { id: socket.id, name: name || 'Player', scores: serializeScores(room) });
    const payload = { ok: true, roomId, hostId: room.hostId, state: room.state, level: room.level, scores: serializeScores(room) };
    if (room.state === 'in_progress' || room.state === 'ended') payload.board = room.board;
    ack && ack(payload);
  });

  // Host starts game
  socket.on('host:startGame', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Only host can start' });
    room.board = Logic.makeInitialBoard();
    room.state = 'in_progress';
    // Do not change level on start
    // Reset scores on new start
    for (const p of room.players.values()) p.score = 0;
    broadcastRoom(room, 'game:started', { board: room.board, level: room.level, scores: serializeScores(room) });
    ack && ack({ ok: true });
  });

  // Host ends game
  socket.on('host:endGame', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Only host can end' });
    room.state = 'ended';
    // Do not change level on manual end
    broadcastRoom(room, 'game:ended', { scores: serializeScores(room), board: room.board, level: room.level });
    ack && ack({ ok: true });
  });

  // Host restarts (new board, reset scores)
  socket.on('host:restartGame', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Only host can restart' });
    room.board = Logic.makeInitialBoard();
    room.state = 'in_progress';
    // Do not change level on restart
    for (const p of room.players.values()) p.score = 0;
    broadcastRoom(room, 'game:restarted', { board: room.board, level: room.level, scores: serializeScores(room) });
    ack && ack({ ok: true });
  });

  // Host closes room
  socket.on('host:closeRoom', ({ roomId }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Only host can close' });
    broadcastRoom(room, 'room:closed', {});
    for (const sid of room.players.keys()) {
      io.sockets.sockets.get(sid)?.leave(roomId);
    }
    rooms.delete(roomId);
    ack && ack({ ok: true });
  });

  // Player attempts a match move
  socket.on('game:move', ({ roomId, a, b }, ack) => {
    const room = getRoom(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.state !== 'in_progress') return ack && ack({ ok: false, error: 'Game not in progress' });
    if (!a || !b) return ack && ack({ ok: false, error: 'Invalid coords' });
    if (!Logic.boardCleared(room.board)) {
      const v1 = room.board[a.r]?.[a.c];
      const v2 = room.board[b.r]?.[b.c];
      if (v1 == null || v2 == null || v1 !== v2) return ack && ack({ ok: false, error: 'Not matchable' });
      const path = Logic.findPathLimitedTurns(room.board, a, b, 2);
      if (!path) return ack && ack({ ok: false, error: 'No path' });
      // Apply level and score
      Logic.applyLevel(room.board, room.level || 1, a, b);
      const player = room.players.get(socket.id);
      if (player) {
        player.score += 10;
        const prev = globalLeaderboard.get(player.name) || 0;
        globalLeaderboard.set(player.name, prev + 10);
      }
      const scores = serializeScores(room);
      const cleared = Logic.boardCleared(room.board);
      broadcastRoom(room, 'game:matched', { a, b, path, board: room.board, scores });
      if (cleared) {
        room.state = 'ended';
        // Increase level after the board is cleared
        room.level = ((room.level % 7) + 1);
        broadcastRoom(room, 'game:ended', { scores, board: room.board, level: room.level });
      } else {
        // Automatic fallback: if no possible pairs remain, reshuffle
        if (!Logic.hasAnyMove(room.board)) {
          Logic.rerandomRemaining(room.board);
          broadcastRoom(room, 'game:shuffled', { board: room.board });
        }
      }
      return ack && ack({ ok: true });
    } else {
      return ack && ack({ ok: false, error: 'Board already cleared' });
    }
  });

  socket.on('disconnect', () => {
    // remove player from any room
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        const wasHost = room.hostId === socket.id;
        room.players.delete(socket.id);
        broadcastRoom(room, 'room:playerLeft', { id: socket.id, scores: serializeScores(room) });
        if (wasHost) {
          // close room if host left
          broadcastRoom(room, 'room:closed', {});
          rooms.delete(room.id);
        }
        break;
      }
    }
  });
});

// Host sets the active level (1..7)
io.on('connection', (socket) => {
  socket.on('host:setLevel', ({ roomId, level }, ack) => {
    const room = rooms.get(roomId);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Only host can set level' });
    const n = Number(level);
    if (!Number.isInteger(n) || n < 1 || n > 7) return ack && ack({ ok: false, error: 'Level must be 1..7' });
    room.level = n;
    io.to(room.id).emit('room:levelChanged', { level: room.level });
    ack && ack({ ok: true, level: room.level });
  });
});

app.get('/api/leaderboard', (_req, res) => {
  const arr = [];
  for (const [name, points] of globalLeaderboard.entries()) arr.push({ name, points });
  arr.sort((a, b) => b.points - a.points);
  res.json({ leaderboard: arr.slice(0, 50) });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Pikachu web listening on http://localhost:${PORT}`);
});
