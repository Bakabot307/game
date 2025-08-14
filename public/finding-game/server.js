const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const BASE_PATH = "/finding-game";

// Cache static files in memory for better performance
const fileCache = new Map();
const cacheFile = (filePath, data, contentType) => {
    fileCache.set(filePath, { data, contentType, cachedAt: Date.now() });
};

function setupFindingGame(wss) {
    // ---- Game state ----
    const LOBBIES = new Map();
    const MAX_PLAYERS = 10;
    const LOBBY_IDLE_CLEAN_MS = 10 * 60 * 1000;

    // Connection management
    const connections = new Set();

    // Rate limiting per connection
    const rateLimits = new Map(); // ws -> { lastMessage: timestamp, messageCount: number }
    const RATE_LIMIT_WINDOW = 1000; // 1 second
    const MAX_MESSAGES_PER_WINDOW = 20; // Max messages per second per connection

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
        return shuffle(Array.from({ length: size }, (_, i) => i + 1));
    }

    function makeLobby() {
        const boardSize = 100;
        return {
            code: makeUniqueLobbyCode(),
            players: new Map(),
            board: genBoard(boardSize),
            boardSize,
            target: 1,
            hostId: null,
            hintDelay: 5000,
            showCooldown: true,
            maxPlayers: 4,
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

    // Optimized broadcast - pre-serialize message and batch send
    function lobbyBroadcast(lobby, msgObj) {
        if (!lobby || lobby.players.size === 0) return;

        const txt = JSON.stringify(msgObj);
        const deadConnections = [];

        for (const p of lobby.players.values()) {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
                try {
                    p.ws.send(txt);
                } catch (err) {
                    console.warn('Failed to send message to player:', err.message);
                    deadConnections.push(p.id);
                }
            } else if (p.ws) {
                deadConnections.push(p.id);
            }
        }

        // Clean up dead connections
        deadConnections.forEach(playerId => {
            removePlayer(lobby, playerId);
        });

        lobby.lastActive = Date.now();
    }

    function lobbySnapshot(lobby) {
        return {
            code: lobby.code,
            hostId: lobby.hostId,
            players: Array.from(lobby.players.values()).map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
                playing: !!p.playing
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
        let cleaned = 0;

        for (const [code, lobby] of LOBBIES.entries()) {
            if (lobby.players.size === 0 && now - lobby.lastActive > LOBBY_IDLE_CLEAN_MS) {
                LOBBIES.delete(code);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} empty lobbies. Active lobbies: ${LOBBIES.size}`);
        }
    }

    // Rate limiting check
    function checkRateLimit(ws) {
        const now = Date.now();
        let limit = rateLimits.get(ws);

        if (!limit) {
            limit = { lastMessage: now, messageCount: 1 };
            rateLimits.set(ws, limit);
            return true;
        }

        if (now - limit.lastMessage > RATE_LIMIT_WINDOW) {
            limit.lastMessage = now;
            limit.messageCount = 1;
            return true;
        }

        limit.messageCount++;
        return limit.messageCount <= MAX_MESSAGES_PER_WINDOW;
    }

    // Enhanced cleanup interval
    setInterval(() => {
        cleanupEmptyLobbies();
        // Clean up rate limit entries for closed connections
        for (const ws of rateLimits.keys()) {
            if (ws.readyState !== WebSocket.OPEN) {
                rateLimits.delete(ws);
            }
        }
    }, 30_000);

    wss.on("connection", (ws) => {
        connections.add(ws);
        let boundLobby = null;
        let boundPlayer = null;
        let heartbeatInterval = null;

        // Heartbeat mechanism
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        heartbeatInterval = setInterval(() => {
            if (ws.isAlive === false) {
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 30000);

        const safeSend = (obj) => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify(obj));
                } catch (err) {
                    console.warn('Failed to send message:', err.message);
                }
            }
        };

        const bindPlayer = (lobby, player) => {
            player.ws = ws;
            boundLobby = lobby;
            boundPlayer = player;
        };

        // Validate input helper
        const validateString = (str, maxLength = 50) => {
            const trimmed = (str || "").trim();
            return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
        };

        const handleCreate = (name) => {
            const validName = validateString(name, 30);
            if (!validName) {
                safeSend({ type: "error", message: "Name required (max 30 chars)" });
                return;
            }

            const lobby = makeLobby();
            LOBBIES.set(lobby.code, lobby);

            const playerId = newId();
            const player = { id: playerId, name: validName, score: 0, ws, playing: true };
            lobby.players.set(playerId, player);
            lobby.hostId = playerId;

            bindPlayer(lobby, player);
            safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });

            // Use setTimeout to avoid blocking the main thread
            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleJoin = (code, name) => {
            const validName = validateString(name, 30);
            if (!validName) {
                safeSend({ type: "error", message: "Name required (max 30 chars)" });
                return;
            }

            const lobbyCode = validateString(code, 10);
            if (!lobbyCode) {
                safeSend({ type: "error", message: "Valid lobby code required" });
                return;
            }

            const lobby = LOBBIES.get(lobbyCode.toUpperCase());
            if (!lobby) {
                safeSend({ type: "error", message: "Lobby not found" });
                return;
            }
            if (lobby.players.size >= MAX_PLAYERS) {
                safeSend({ type: "error", message: "Lobby full (max 10)" });
                return;
            }

            const playerId = newId();
            const player = { id: playerId, name: validName, score: 0, ws, playing: false };
            lobby.players.set(playerId, player);

            bindPlayer(lobby, player);
            safeSend({ type: "lobby_joined", playerId, code: lobby.code, snapshot: lobbySnapshot(lobby) });

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleGuess = (code, playerId, number) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby) return;
            const player = lobby.players.get(playerId);
            if (!player || !player.playing) return;

            const num = Number(number);
            if (!Number.isInteger(num) || num < 1 || num > lobby.boardSize) return;

            if (num === lobby.target) {
                player.score = (player.score || 0) + 1;
                lobby.target += 1;
                lobby.board = genBoard(lobby.boardSize);

                if (lobby.target > lobby.boardSize) {
                    const scores = Array.from(lobby.players.values()).map(p => p.score || 0);
                    const max = Math.max(...scores);
                    const winners = Array.from(lobby.players.values())
                        .filter(p => (p.score || 0) === max)
                        .map(p => p.id);

                    setTimeout(() => {
                        lobbyBroadcast(lobby, {
                            type: "game_over",
                            winners,
                            snapshot: lobbySnapshot(lobby),
                        });
                    }, 0);
                } else {
                    setTimeout(() => {
                        lobbyBroadcast(lobby, {
                            type: "round_result",
                            winnerPlayerId: player.id,
                            number: number,
                            snapshot: lobbySnapshot(lobby),
                        });
                    }, 0);
                }
            }
        };

        const handleRestart = (code, playerId) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;

            lobby.target = 1;
            lobby.board = genBoard(lobby.boardSize);
            for (const p of lobby.players.values()) p.score = 0;

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleJoinGame = (code, playerId) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby) return;
            const player = lobby.players.get(playerId);
            if (!player || player.playing) return;

            const playingCount = Array.from(lobby.players.values()).filter(p => p.playing).length;
            if (playingCount >= lobby.maxPlayers) return;

            player.playing = true;
            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleLeaveGame = (code, playerId) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby) return;
            const player = lobby.players.get(playerId);
            if (!player || !player.playing) return;

            player.playing = false;
            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const removePlayer = (lobby, playerId) => {
            if (!lobby) return;
            const wasHost = lobby.hostId === playerId;
            lobby.players.delete(playerId);

            if (wasHost && lobby.players.size > 0) {
                const first = lobby.players.values().next().value;
                lobby.hostId = first ? first.id : null;
            }

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
                if (lobby.players.size === 0) lobby.lastActive = Date.now();
            }, 0);
        };

        const handleRemoveFromGame = (code, playerId, targetId) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;
            const target = lobby.players.get(targetId);
            if (!target) return;

            target.playing = false;
            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleSetPlayerSlots = (code, playerId, slots) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;

            let s = Number(slots);
            if (!Number.isFinite(s)) return;
            s = Math.max(1, Math.min(10, Math.floor(s)));
            lobby.maxPlayers = s;

            const playing = Array.from(lobby.players.values()).filter(p => p.playing);
            if (playing.length > s) {
                playing.slice(s).forEach(p => p.playing = false);
            }

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleSetHintDelay = (code, playerId, delay) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;

            const d = Number(delay);
            if (!Number.isFinite(d) || d < 0 || d > 60000) return; // max 60 seconds
            lobby.hintDelay = Math.floor(d);

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleSetShowCooldown = (code, playerId, enabled) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;

            lobby.showCooldown = !!enabled;
            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        const handleSetBoardSize = (code, playerId, size) => {
            const lobby = LOBBIES.get((code || "").toUpperCase());
            if (!lobby || lobby.hostId !== playerId) return;

            let s = Number(size);
            if (!Number.isFinite(s)) return;
            s = Math.round(s / 10) * 10;
            s = Math.max(10, Math.min(1000, s));

            lobby.boardSize = s;
            lobby.target = 1;
            lobby.board = genBoard(s);
            for (const p of lobby.players.values()) p.score = 0;

            setTimeout(() => {
                lobbyBroadcast(lobby, { type: "state", snapshot: lobbySnapshot(lobby) });
            }, 0);
        };

        ws.on("message", (raw) => {
            // Rate limiting
            if (!checkRateLimit(ws)) {
                safeSend({ type: "error", message: "Too many requests" });
                return;
            }

            let msg = null;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                safeSend({ type: "error", message: "Invalid JSON" });
                return;
            }

            if (!msg || typeof msg.type !== 'string') {
                safeSend({ type: "error", message: "Invalid message format" });
                return;
            }

            // Process message handlers
            const handlers = {
                "create_lobby": () => handleCreate(msg.name),
                "join_lobby": () => handleJoin(msg.code, msg.name),
                "guess": () => handleGuess(msg.code, msg.playerId, msg.number),
                "restart_game": () => handleRestart(msg.code, msg.playerId),
                "set_hint_delay": () => handleSetHintDelay(msg.code, msg.playerId, msg.delay),
                "set_show_cooldown": () => handleSetShowCooldown(msg.code, msg.playerId, msg.enabled),
                "set_board_size": () => handleSetBoardSize(msg.code, msg.playerId, msg.size),
                "join_game": () => handleJoinGame(msg.code, msg.playerId),
                "leave_game": () => handleLeaveGame(msg.code, msg.playerId),
                "remove_from_game": () => handleRemoveFromGame(msg.code, msg.playerId, msg.targetId),
                "set_player_slots": () => handleSetPlayerSlots(msg.code, msg.playerId, msg.slots),
            };

            const handler = handlers[msg.type];
            if (handler) {
                try {
                    handler();
                } catch (err) {
                    console.error('Handler error:', err);
                    safeSend({ type: "error", message: "Server error" });
                }
            } else {
                safeSend({ type: "error", message: "Unknown message type" });
            }
        });

        ws.on("close", () => {
            connections.delete(ws);
            rateLimits.delete(ws);
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
            }
            if (boundLobby && boundPlayer) {
                removePlayer(boundLobby, boundPlayer.id);
            }
        });

        ws.on("error", (err) => {
            console.warn('WebSocket error:', err.message);
        });
    });

    // Global heartbeat for dead connection detection
    setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) {
                return ws.terminate();
            }
            ws.isAlive = false;
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        });
    }, 30000);

    console.log(`Game server initialized. Max connections: ${MAX_PLAYERS * 50}`);
}

module.exports = { setupFindingGame };

if (require.main === module) {
    const server = http.createServer((req, res) => {
        const { pathname } = new URL(req.url, `http://${req.headers.host}`);
        let urlPath = pathname;

        if (urlPath === "/" || urlPath === BASE_PATH) {
            urlPath = "/index.html";
        } else if (urlPath.startsWith(BASE_PATH + "/")) {
            urlPath = urlPath.slice(BASE_PATH.length);
        }

        let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);

        // Security check
        if (!filePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        // Check cache first
        const cached = fileCache.get(filePath);
        if (cached && Date.now() - cached.cachedAt < 300000) { // 5 min cache
            res.writeHead(200, {
                "Content-Type": cached.contentType,
                "Cache-Control": "public, max-age=300"
            });
            return res.end(cached.data);
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                return res.end("Not Found");
            }

            const ext = path.extname(filePath).toLowerCase();
            const types = {
                ".html": "text/html; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".json": "application/json",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon"
            };

            const contentType = types[ext] || "text/plain";

            // Cache static files
            if (ext !== '.html') { // Don't cache HTML for dynamic updates
                cacheFile(filePath, data, contentType);
            }

            res.writeHead(200, {
                "Content-Type": contentType,
                "Cache-Control": ext === '.html' ? "no-cache" : "public, max-age=3600"
            });
            res.end(data);
        });
    });

    // Enable keep-alive
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    const wss = new WebSocket.Server({
        server,
        perMessageDeflate: {
            zlibDeflateOptions: {
                windowBits: 13,
                memLevel: 7,
            },
        },
    });

    setupFindingGame(wss);

    server.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
        console.log(`WebSocket compression enabled`);
        console.log(`Static file caching enabled`);
    });
}