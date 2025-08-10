// server.js
// Run: node server.js  (serves ./public and a ws game server)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// ---- Static file server (no Express) ----
const server = http.createServer((req, res) => {
  // serve /public
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const filePath = path.join(__dirname, "public", decodeURIComponent(urlPath));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("Not found"); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
        ext === ".html" ? "text/html" :
            ext === ".js"   ? "text/javascript" :
                ext === ".css"  ? "text/css" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ---- Game state ----
const LOBBIES = new Map(); // code -> Lobby
const MAX_PLAYERS = 4;
const LOBBY_IDLE_CLEAN_MS = 10 * 60 * 1000; // cleanup empty lobbies after 10m
const PLAYER_HOLD_MS = 2 * 60 * 1000; // keep disconnected players for 2m

function newId() {
  return crypto.randomBytes(8).toString("hex");
}
function makeLobbyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random()*alphabet.length)];
  return s;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function genBoard() {
  // numbers 1..100 shuffled
  return shuffle(Array.from({length:100}, (_,i)=>i+1));
}
function makeLobby() {
  return {
    code: makeUniqueLobbyCode(),
    players: new Map(), // playerId -> {id,name,score,connected,ws}
    board: genBoard(),
    target: 1, // start at 1 and count up to 100
    lastActive: Date.now(),
    destroyTimer: null,
  };
}
function makeUniqueLobbyCode() {
  for (let i=0;i<999;i++){
    const c = makeLobbyCode();
    if (!LOBBIES.has(c)) return c;
  }
  return makeLobbyCode();
}

function lobbyBroadcast(lobby, msgObj) {
  const txt = JSON.stringify(msgObj);
  for (const p of lobby.players.values()) {
    if (p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(txt);
    }
  }
  lobby.lastActive = Date.now();
}

function lobbySnapshot(lobby) {
  return {
    code: lobby.code,
    players: Array.from(lobby.players.values()).map(p => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected
    })),
    board: lobby.board,
    target: lobby.target,
  };
}

function cleanupEmptyLobbies() {
  const now = Date.now();
  for (const [code, lobby] of LOBBIES.entries()) {
    const anyConnected = Array.from(lobby.players.values()).some(p => p.connected);
    const anyPlayers = lobby.players.size > 0;
    if (!anyConnected && !anyPlayers && now - lobby.lastActive > LOBBY_IDLE_CLEAN_MS) {
      LOBBIES.delete(code);
    }
  }
}
setInterval(cleanupEmptyLobbies, 30_000);

// ---- WebSocket protocol ----
// Messages from client (JSON):
// {type:"create_lobby", name}
// {type:"join_lobby", code, name}
// {type:"reconnect", code, playerId}
// {type:"guess", code, playerId, number}
//
// Server pushes:
// {type:"lobby_joined", playerId, code, snapshot}
// {type:"state", snapshot}
// {type:"round_result", winnerPlayerId, number, snapshot}
// {type:"error", message}

wss.on("connection", (ws) => {
  let boundLobby = null;
  let boundPlayer = null;

  const safeSend = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const bindPlayer = (lobby, player) => {
    // mark connected + attach ws
    player.connected = true;
    player.ws = ws;
    boundLobby = lobby;
    boundPlayer = player;
  };

  const handleCreate = (name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) { safeSend({ type: "error", message: "Name required" }); return; }

    const lobby = makeLobby();
    LOBBIES.set(lobby.code, lobby);

    const playerId = newId();
    const player = { id: playerId, name: trimmed, score: 0, connected: true, ws };
    lobby.players.set(playerId, player);

    bindPlayer(lobby, player);
    safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });
    lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
  };

  const handleJoin = (code, name) => {
    const trimmed = (name || "").trim();
    if (!trimmed) { safeSend({ type: "error", message: "Name required" }); return; }
    const lobby = LOBBIES.get((code||"").toUpperCase());
    if (!lobby) { safeSend({type:"error", message:"Lobby not found"}); return; }
    if (lobby.players.size >= MAX_PLAYERS) { safeSend({type:"error", message:"Lobby full (max 4)"}); return; }

    const playerId = newId();
    const player = { id: playerId, name: trimmed, score: 0, connected: true, ws };
    lobby.players.set(playerId, player);

    bindPlayer(lobby, player);
    safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });
    lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
  };

  const handleReconnect = (code, playerId) => {
    const lobby = LOBBIES.get((code||"").toUpperCase());
    if (!lobby) { safeSend({type:"error", message:"Lobby not found"}); return; }
    const player = lobby.players.get(playerId);
    if (!player) { safeSend({type:"error", message:"Player not found in lobby"}); return; }

    bindPlayer(lobby, player);
    safeSend({ type: "lobby_joined", playerId: player.id, code: lobby.code, snapshot: lobbySnapshot(lobby) });
    lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
  };

  const handleGuess = (code, playerId, number) => {
    const lobby = LOBBIES.get((code||"").toUpperCase());
    if (!lobby) return;
    const player = lobby.players.get(playerId);
    if (!player) return;

    // Only accept valid guess: the clicked number equals target
    if (Number(number) === lobby.target) {
      // score & advance to next number
      player.score = (player.score || 0) + 1;
      lobby.target += 1;
      lobby.board = genBoard();

      if (lobby.target > 100) {
        // determine winner(s) and end game
        const scores = Array.from(lobby.players.values()).map(p => p.score || 0);
        const max = Math.max(...scores);
        const winners = Array.from(lobby.players.values())
          .filter(p => (p.score || 0) === max)
          .map(p => p.id);
        lobbyBroadcast(lobby, {
          type: "game_over",
          winners,
          snapshot: lobbySnapshot(lobby),
        });
      } else {
        lobbyBroadcast(lobby, {
          type: "round_result",
          winnerPlayerId: player.id,
          number: number,
          snapshot: lobbySnapshot(lobby),
        });
      }
    } else {
      // Optional: notify incorrect (comment out if noisy)
      // player.ws && player.ws.readyState===WebSocket.OPEN && player.ws.send(JSON.stringify({type:"error", message:"Wrong number"}));
    }
  };

  ws.on("message", (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "create_lobby":
        handleCreate(msg.name);
        break;
      case "join_lobby":
        handleJoin(msg.code, msg.name);
        break;
      case "reconnect":
        handleReconnect(msg.code, msg.playerId);
        break;
      case "guess":
        handleGuess(msg.code, msg.playerId, msg.number);
        break;
      default:
        safeSend({type:"error", message:"Unknown message type"});
    }
  });

  ws.on("close", () => {
    // mark player disconnected but keep for PLAYER_HOLD_MS
    if (boundLobby && boundPlayer) {
      boundPlayer.connected = false;
      boundPlayer.ws = null;
      lobbyBroadcast(boundLobby, { type: "state", snapshot: lobbySnapshot(boundLobby) });

      // remove player after hold if they don't return
      const lobbyRef = boundLobby;
      const pid = boundPlayer.id;
      setTimeout(() => {
        const lobbyNow = LOBBIES.get(lobbyRef.code);
        if (!lobbyNow) return;
        const p = lobbyNow.players.get(pid);
        if (p && !p.connected) {
          lobbyNow.players.delete(pid);
          lobbyBroadcast(lobbyNow, { type: "state", snapshot: lobbySnapshot(lobbyNow) });
          // if empty, mark lastActive
          if (lobbyNow.players.size === 0) lobbyNow.lastActive = Date.now();
        }
      }, PLAYER_HOLD_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log("Listening on http://localhost:" + PORT);
});
