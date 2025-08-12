const http = require("http");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// Create a single Express app that can be shared with other modules
const app = express();

// Serve all static assets from the /public directory
app.use(express.static(PUBLIC_DIR));

// Create the HTTP server using the Express app
const server = http.createServer(app);

// WebSocket server for the finding game
const wss = new WebSocket.Server({ server });

// ---- Game state ----
const LOBBIES = new Map(); // code -> Lobby
const MAX_PLAYERS = 10; // maximum people in a room
const LOBBY_IDLE_CLEAN_MS = 10 * 60 * 1000; // cleanup empty lobbies after 10m

function newId() {
    return crypto.randomBytes(8).toString("hex");
}
function makeLobbyCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
function genBoard(size = 100) {
    // numbers 1..size shuffled
    return shuffle(Array.from({ length: size }, (_, i) => i + 1));
}
function makeLobby() {
    const boardSize = 100;
    return {
        code: makeUniqueLobbyCode(),
        players: new Map(), // playerId -> {id,name,score,ws,playing}
        board: genBoard(boardSize),
        boardSize,
        target: 1, // start at 1 and count up to boardSize
        hostId: null,
        hintDelay: 5000,
        showCooldown: true,
        maxPlayers: 4, // playable slots, can be adjusted by host up to 10
        lastActive: Date.now(),
        destroyTimer: null,
    };
}
function makeUniqueLobbyCode() {
    for (let i = 0; i < 999; i++) {
        const c = makeLobbyCode();
        if (!LOBBIES.has(c)) return c;
    }
    return makeLobbyCode();
}

function lobbyBroadcast(lobby, msgObj) {
    const txt = JSON.stringify(msgObj);
    for (const p of lobby.players.values()) {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(txt);
        }
    }
    lobby.lastActive = Date.now();
}

function lobbySnapshot(lobby) {
    return {
        code: lobby.code,
        hostId: lobby.hostId,
        players: Array.from(lobby.players.values()).map(p => ({
            id: p.id, name: p.name, score: p.score, playing: !!p.playing
        })),
        board: lobby.board,
        target: lobby.target,
        hintDelay: lobby.hintDelay,
        showCooldown: lobby.showCooldown,
        maxPlayers: lobby.maxPlayers,
        boardSize: lobby.boardSize,
    };
}

function cleanupEmptyLobbies() {
    const now = Date.now();
    for (const [code, lobby] of LOBBIES.entries()) {
        if (lobby.players.size === 0 && now - lobby.lastActive > LOBBY_IDLE_CLEAN_MS) {
            LOBBIES.delete(code);
        }
    }
}
setInterval(cleanupEmptyLobbies, 30_000);

// ---- WebSocket protocol ----
// Messages from client (JSON):
// {type:"create_lobby", name}
// {type:"join_lobby", code, name}
// {type:"guess", code, playerId, number}
// {type:"restart_game", code, playerId}
// {type:"kick_player", code, playerId, targetId}
// {type:"join_game", code, playerId}
// {type:"leave_game", code, playerId}
// {type:"remove_from_game", code, playerId, targetId}
// {type:"set_player_slots", code, playerId, slots}
// {type:"set_hint_delay", code, playerId, delay}
// {type:"set_show_cooldown", code, playerId, enabled}
// {type:"set_board_size", code, playerId, size}
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
        // attach ws
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
        const player = { id: playerId, name: trimmed, score: 0, ws, playing: true };
        lobby.players.set(playerId, player);
        lobby.hostId = playerId;

        bindPlayer(lobby, player);
        safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleJoin = (code, name) => {
        const trimmed = (name || "").trim();
        if (!trimmed) { safeSend({ type: "error", message: "Name required" }); return; }
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) { safeSend({ type: "error", message: "Lobby not found" }); return; }
        if (lobby.players.size >= MAX_PLAYERS) { safeSend({ type: "error", message: "Lobby full (max 10)" }); return; }

        const playerId = newId();
        const player = { id: playerId, name: trimmed, score: 0, ws, playing: false };
        lobby.players.set(playerId, player);

        bindPlayer(lobby, player);
        safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleGuess = (code, playerId, number) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        const player = lobby.players.get(playerId);
        if (!player || !player.playing) return;

        // Only accept valid guess: the clicked number equals target
        if (Number(number) === lobby.target) {
            // score & advance to next number
            player.score = (player.score || 0) + 1;
            lobby.target += 1;
            lobby.board = genBoard(lobby.boardSize);

            if (lobby.target > lobby.boardSize) {
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

    const handleRestart = (code, playerId) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        lobby.target = 1;
        lobby.board = genBoard(lobby.boardSize);
        for (const p of lobby.players.values()) p.score = 0;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleJoinGame = (code, playerId) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        const player = lobby.players.get(playerId);
        if (!player || player.playing) return;
        const playingCount = Array.from(lobby.players.values()).filter(p => p.playing).length;
        if (playingCount >= lobby.maxPlayers) return;
        player.playing = true;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleLeaveGame = (code, playerId) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        const player = lobby.players.get(playerId);
        if (!player || !player.playing) return;
        player.playing = false;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const removePlayer = (lobby, playerId) => {
        if (!lobby) return;
        const wasHost = lobby.hostId === playerId;
        lobby.players.delete(playerId);
        if (wasHost) {
            const first = lobby.players.values().next().value;
            lobby.hostId = first ? first.id : null;
        }
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
        if (lobby.players.size === 0) lobby.lastActive = Date.now();
    };

    const handleRemoveFromGame = (code, playerId, targetId) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        const target = lobby.players.get(targetId);
        if (!target) return;
        target.playing = false;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleSetPlayerSlots = (code, playerId, slots) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        let s = Number(slots);
        if (!Number.isFinite(s)) return;
        s = Math.max(1, Math.min(10, s));
        lobby.maxPlayers = s;
        const playing = Array.from(lobby.players.values()).filter(p => p.playing);
        if (playing.length > s) {
            playing.slice(s).forEach(p => p.playing = false);
        }
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleKick = (code, playerId, targetId) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        const target = lobby.players.get(targetId);
        if (!target) return;
        removePlayer(lobby, targetId);
    };

    const handleSetHintDelay = (code, playerId, delay) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        const d = Number(delay);
        if (!Number.isFinite(d) || d < 0) return;
        lobby.hintDelay = d;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleSetShowCooldown = (code, playerId, enabled) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        lobby.showCooldown = !!enabled;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
    };

    const handleSetBoardSize = (code, playerId, size) => {
        const lobby = LOBBIES.get((code || "").toUpperCase());
        if (!lobby) return;
        if (lobby.hostId !== playerId) return;
        let s = Number(size);
        if (!Number.isFinite(s)) return;
        s = Math.round(s / 10) * 10;
        s = Math.max(10, Math.min(1000, s));
        lobby.boardSize = s;
        lobby.target = 1;
        lobby.board = genBoard(s);
        for (const p of lobby.players.values()) p.score = 0;
        lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
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
            case "guess":
                handleGuess(msg.code, msg.playerId, msg.number);
                break;
            case "restart_game":
                handleRestart(msg.code, msg.playerId);
                break;
            case "kick_player":
                handleKick(msg.code, msg.playerId, msg.targetId);
                break;
            case "set_hint_delay":
                handleSetHintDelay(msg.code, msg.playerId, msg.delay);
                break;
            case "set_show_cooldown":
                handleSetShowCooldown(msg.code, msg.playerId, msg.enabled);
                break;
            case "set_board_size":
                handleSetBoardSize(msg.code, msg.playerId, msg.size);
                break;
            case "join_game":
                handleJoinGame(msg.code, msg.playerId);
                break;
            case "leave_game":
                handleLeaveGame(msg.code, msg.playerId);
                break;
            case "remove_from_game":
                handleRemoveFromGame(msg.code, msg.playerId, msg.targetId);
                break;
            case "set_player_slots":
                handleSetPlayerSlots(msg.code, msg.playerId, msg.slots);
                break;
            default:
                safeSend({ type: "error", message: "Unknown message type" });
        }
    });

    ws.on("close", () => {
        if (boundLobby && boundPlayer) {
            removePlayer(boundLobby, boundPlayer.id);
        }
    });
});

server.listen(PORT, () => {
    console.log("Listening on http://localhost:" + PORT);
});

// Export both the Express app and the underlying HTTP server so other modules
// (like the Twitch bot) can attach routes or share the same server instance.
module.exports = { app, server };
