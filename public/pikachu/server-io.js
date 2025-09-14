const Logic = require('./server/game-logic');

// Room management with reconnection support
// room: {
//   id,
//   hostId, // clientId of host
//   players: Map(clientId -> { id: clientId, name, score, connected: boolean, socketId?: string }),
//   disconnectTimers: Map(clientId -> Timeout),
//   state, board, level
// }
const rooms = new Map();
const clientToRoom = new Map(); // clientId -> roomId
const globalLeaderboard = new Map(); // name -> total points

const DISCONNECT_GRACE_MS = Number(process.env.PIKACHU_GRACE_MS || 45000);

function genClientId() {
  // Lightweight UUID-ish generator without external deps
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function genRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function getRoom(roomId) { return rooms.get(roomId); }

function serializeScores(room) {
  const list = [];
  for (const [cid, p] of room.players.entries()) list.push({ id: cid, name: p.name, score: p.score, connected: !!p.connected });
  list.sort((a, b) => b.score - a.score);
  return list;
}

function broadcastRoom(io, room, event, payload) {
  io.to(room.id).emit(event, payload);
}

function setupPikachuGame(io) {
  io.on('connection', (socket) => {
    // Identify client across reconnects
    let clientId = (socket.handshake.auth && socket.handshake.auth.clientId) || (socket.handshake.query && socket.handshake.query.clientId);
    if (typeof clientId !== 'string' || clientId.length < 8) {
      clientId = genClientId();
      // Inform client to persist this id
      socket.emit('session:assign', { clientId });
    }
    socket.data.clientId = clientId;

    function leaveExistingRooms() {
      const toClose = [];
      const toLeave = [];
      for (const room of rooms.values()) {
        if (room.players.has(clientId)) {
          if (room.hostId === clientId) toClose.push(room);
          else toLeave.push(room);
        }
      }
      for (const room of toLeave) {
        room.players.delete(clientId);
        clientToRoom.delete(clientId);
        socket.leave(room.id);
        broadcastRoom(io, room, 'room:playerLeft', { id: clientId, scores: serializeScores(room) });
      }
      for (const room of toClose) {
        broadcastRoom(io, room, 'room:closed', {});
        // Detach all sockets from this room
        for (const p of room.players.values()) {
          if (p.socketId) io.sockets.sockets.get(p.socketId)?.leave(room.id);
          clientToRoom.delete(p.id);
        }
        rooms.delete(room.id);
      }
    }

    // Attempt automatic resume if previously in a room
    const resumeRoomId = clientToRoom.get(clientId);
    if (resumeRoomId) {
      const room = rooms.get(resumeRoomId);
      const player = room?.players.get(clientId);
      if (room && player) {
        // Clear any pending removal
        if (!room.disconnectTimers) room.disconnectTimers = new Map();
        const t = room.disconnectTimers.get(clientId);
        if (t) { clearTimeout(t); room.disconnectTimers.delete(clientId); }

        player.connected = true;
        player.socketId = socket.id;
        socket.join(room.id);
        broadcastRoom(io, room, 'room:playerRejoined', { id: clientId, scores: serializeScores(room) });
        const payload = {
          ok: true,
          roomId: room.id,
          hostId: room.hostId,
          state: room.state,
          level: room.level,
          scores: serializeScores(room)
        };
        if (room.state === 'in_progress' || room.state === 'ended') payload.board = room.board;
        socket.emit('session:resumed', payload);
      }
    }

    // Host creates a room
    socket.on('host:createRoom', ({ name, roomId: wantedId }, ack) => {
      try {
        // Ensure the creator is not lingering in previous rooms
        leaveExistingRooms();
        let roomId = wantedId && String(wantedId).trim().toUpperCase();
        if (roomId) {
          if (!/^[A-Z0-9]{3,12}$/.test(roomId)) return ack && ack({ ok: false, error: 'Invalid room code' });
          if (rooms.has(roomId)) return ack && ack({ ok: false, error: 'Room already exists' });
        } else {
          roomId = genRoomId();
        }
        const room = { id: roomId, hostId: clientId, players: new Map(), disconnectTimers: new Map(), state: 'lobby', board: null, level: 1 };
        rooms.set(roomId, room);
        socket.join(roomId);
        room.players.set(clientId, { id: clientId, name: name || 'Host', score: 0, connected: true, socketId: socket.id });
        clientToRoom.set(clientId, roomId);
        ack && ack({ ok: true, roomId, you: { id: clientId, host: true }, scores: serializeScores(room), state: room.state, level: room.level, hostId: room.hostId });
      } catch (e) {
        ack && ack({ ok: false, error: e.message });
      }
    });

    // User joins existing room
    socket.on('user:joinRoom', ({ roomId, name }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      // If this client was previously in some room, leave it first
      const prevId = clientToRoom.get(clientId);
      if (prevId && prevId !== roomId) {
        const prev = rooms.get(prevId);
        if (prev?.players.has(clientId)) {
          prev.players.delete(clientId);
          prev.disconnectTimers?.delete?.(clientId);
          broadcastRoom(io, prev, 'room:playerLeft', { id: clientId, scores: serializeScores(prev) });
        }
        clientToRoom.delete(clientId);
      }

      socket.join(roomId);
      const player = room.players.get(clientId);
      if (player) {
        // Rejoining same room (idempotent)
        player.connected = true; player.socketId = socket.id; if (name) player.name = name;
        if (room.disconnectTimers?.has(clientId)) { clearTimeout(room.disconnectTimers.get(clientId)); room.disconnectTimers.delete(clientId); }
        broadcastRoom(io, room, 'room:playerRejoined', { id: clientId, scores: serializeScores(room) });
      } else {
        room.players.set(clientId, { id: clientId, name: name || 'Player', score: 0, connected: true, socketId: socket.id });
        broadcastRoom(io, room, 'room:playerJoined', { id: clientId, name: name || 'Player', scores: serializeScores(room) });
      }
      clientToRoom.set(clientId, roomId);
      const payload = { ok: true, roomId, hostId: room.hostId, state: room.state, level: room.level, scores: serializeScores(room) };
      if (room.state === 'in_progress' || room.state === 'ended') payload.board = room.board;
      ack && ack(payload);
    });

    // User leaves room
    socket.on('user:leaveRoom', ({ roomId }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (!room.players.has(clientId)) return ack && ack({ ok: false, error: 'Not in room' });
      const wasHost = room.hostId === clientId;
      room.players.delete(clientId);
      socket.leave(roomId);
      clientToRoom.delete(clientId);
      if (wasHost) {
        broadcastRoom(io, room, 'room:closed', {});
        rooms.delete(room.id);
      } else {
        broadcastRoom(io, room, 'room:playerLeft', { id: clientId, scores: serializeScores(room) });
      }
      ack && ack({ ok: true });
    });

    // Host starts game
    socket.on('host:startGame', ({ roomId }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (room.hostId !== clientId) return ack && ack({ ok: false, error: 'Only host can start' });
      room.board = Logic.makeInitialBoard();
      room.state = 'in_progress';
      // Reset scores on new start
      for (const p of room.players.values()) p.score = 0;
      broadcastRoom(io, room, 'game:started', { board: room.board, level: room.level, scores: serializeScores(room) });
      ack && ack({ ok: true });
    });

    // Host ends game
    socket.on('host:endGame', ({ roomId }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (room.hostId !== clientId) return ack && ack({ ok: false, error: 'Only host can end' });
      room.state = 'ended';
      broadcastRoom(io, room, 'game:ended', { scores: serializeScores(room), board: room.board, level: room.level });
      ack && ack({ ok: true });
    });

    // Host restarts game (new board, reset scores)
    socket.on('host:restartGame', ({ roomId }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (room.hostId !== clientId) return ack && ack({ ok: false, error: 'Only host can restart' });
      room.board = Logic.makeInitialBoard();
      room.state = 'in_progress';
      for (const p of room.players.values()) p.score = 0;
      broadcastRoom(io, room, 'game:restarted', { board: room.board, level: room.level, scores: serializeScores(room) });
      ack && ack({ ok: true });
    });

    // Host closes room
    socket.on('host:closeRoom', ({ roomId }, ack) => {
      const room = getRoom(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (room.hostId !== clientId) return ack && ack({ ok: false, error: 'Only host can close' });
      broadcastRoom(io, room, 'room:closed', {});
      for (const p of room.players.values()) {
        if (p.socketId) io.sockets.sockets.get(p.socketId)?.leave(roomId);
        clientToRoom.delete(p.id);
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
        const player = room.players.get(clientId);
        if (player) {
          player.score += 10;
          const prev = globalLeaderboard.get(player.name) || 0;
          globalLeaderboard.set(player.name, prev + 10);
        }
        const scores = serializeScores(room);
        const cleared = Logic.boardCleared(room.board);
        broadcastRoom(io, room, 'game:matched', { a, b, path, board: room.board, scores });
        if (cleared) {
          room.state = 'ended';
          // Increase level after the board is cleared
          room.level = ((room.level % 7) + 1);
          broadcastRoom(io, room, 'game:ended', { scores, board: room.board, level: room.level });
        } else {
          // Automatic fallback: if no possible pairs remain, reshuffle
          if (!Logic.hasAnyMove(room.board)) {
            Logic.rerandomRemaining(room.board);
            broadcastRoom(io, room, 'game:shuffled', { board: room.board });
          }
        }
        return ack && ack({ ok: true });
      } else {
        return ack && ack({ ok: false, error: 'Board already cleared' });
      }
    });

    // Host sets the active level (1..7)
    socket.on('host:setLevel', ({ roomId, level }, ack) => {
      const room = rooms.get(roomId);
      if (!room) return ack && ack({ ok: false, error: 'Room not found' });
      if (room.hostId !== clientId) return ack && ack({ ok: false, error: 'Only host can set level' });
      const n = Number(level);
      if (!Number.isInteger(n) || n < 1 || n > 7) return ack && ack({ ok: false, error: 'Level must be 1..7' });
      room.level = n;
      io.to(room.id).emit('room:levelChanged', { level: room.level });
      ack && ack({ ok: true, level: room.level });
    });

    socket.on('disconnect', () => {
      // Mark player as temporarily disconnected; allow grace period for reconnection
      const roomId = clientToRoom.get(clientId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) { clientToRoom.delete(clientId); return; }
      const player = room.players.get(clientId);
      if (!player) { clientToRoom.delete(clientId); return; }
      player.connected = false;
      if (!room.disconnectTimers) room.disconnectTimers = new Map();
      // Broadcast a lightweight disconnected event so UIs can reflect status
      broadcastRoom(io, room, 'room:playerDisconnected', { id: clientId, scores: serializeScores(room) });
      const wasHost = room.hostId === clientId;
      // Schedule final removal/closure
      const t = setTimeout(() => {
        // If still absent, remove from room; if host, close the room
        const still = rooms.get(roomId);
        if (!still) return;
        const p = still.players.get(clientId);
        if (!p || p.connected) return; // already back or already removed
        still.players.delete(clientId);
        clientToRoom.delete(clientId);
        if (wasHost) {
          broadcastRoom(io, still, 'room:closed', {});
          for (const pl of still.players.values()) { if (pl.socketId) io.sockets.sockets.get(pl.socketId)?.leave(still.id); clientToRoom.delete(pl.id); }
          rooms.delete(still.id);
        } else {
          broadcastRoom(io, still, 'room:playerLeft', { id: clientId, scores: serializeScores(still) });
        }
      }, DISCONNECT_GRACE_MS);
      room.disconnectTimers.set(clientId, t);
    });
  });

  // Leaderboard endpoint helper for potential integration
  io.httpServer?.on?.('request', (req, res) => {
    try {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname === '/pikachu/api/leaderboard') {
        const arr = [];
        for (const [name, points] of globalLeaderboard.entries()) arr.push({ name, points });
        arr.sort((a, b) => b.points - a.points);
        const body = JSON.stringify({ leaderboard: arr.slice(0, 50) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      }
    } catch (_) {
      // ignore URL parsing errors
    }
  });
}

module.exports = { setupPikachuGame };

