// Pikachu (Onet) web implementation
// Grid: 11 rows x 18 cols, outer border is invisible

const ROWS = 11;
const COLS = 18;
const TILE_W = 40; // px
const TILE_H = 50; // px

// Types: 33 kinds, counts: first 6 => 6 each, others => 4 each
const TYPE_COUNT = 33;

const $board = document.getElementById('board');
const $canvas = document.getElementById('lineCanvas');
const ctx = $canvas.getContext('2d');
const $btnNew = document.getElementById('btnNew');
const $btnAuto = document.getElementById('btnAuto');
const $btnReRandom = document.getElementById('btnReRandom');
const $level = document.getElementById('level');
const $nameInput = document.getElementById('nameInput');
const $roomInput = document.getElementById('roomInput');
const $selfName = document.getElementById('selfName');
let selfName = '';
const $btnHost = document.getElementById('btnHost');
const $btnJoin = document.getElementById('btnJoin');
const $btnLeave = document.getElementById('btnLeave');
const $btnStart = document.getElementById('btnStart');
const $btnEnd = document.getElementById('btnEnd');
const $btnRestart = document.getElementById('btnRestart');
const $btnClose = document.getElementById('btnClose');
const $roomInfo = document.getElementById('roomInfo');
const $roomCode = document.getElementById('roomCode');
const $scoreboard = document.getElementById('scoreboard');
const $levelControls = document.getElementById('levelControls');
const $levelText = document.getElementById('levelText');
const $levelTextValue = document.getElementById('levelTextValue');
const $levelSelect = document.getElementById('levelSelect');
const $btnSetLevel = document.getElementById('btnSetLevel');
const $hostMarker = document.getElementById('hostMarker');

let board = null; // board[r][c] = null | number(0..32)
let selected = null; // {r,c}
let currentLevel = 0; // matches WinForms, increments on New

// Multiplayer state
let socket = null;
let inRoom = false;
let roomId = null;
let isHost = false;
let gameState = 'lobby'; // 'lobby'|'in_progress'|'ended'
let clientId = (function(){
  try {
    const k = 'pikachuClientId';
    let id = localStorage.getItem(k);
    if (!id || id.length < 8) {
      id = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      localStorage.setItem(k, id);
    }
    return id;
  } catch(_) { return String(Math.random()).slice(2); }
})();

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isBoundary(r, c) {
  return r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1;
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function isOccupied(r, c) {
  // Occupied only if inside board and has a tile value
  return inBounds(r, c) && board[r][c] !== null;
}

function posToPx(r, c) {
  return { x: c * TILE_W + TILE_W / 2, y: r * TILE_H + TILE_H / 2 };
}

function clearLines() {
  ctx.clearRect(0, 0, $canvas.width, $canvas.height);
}

function drawPath(points) {
  clearLines();
  if (!points || points.length === 0) return;
  ctx.strokeStyle = '#ffff00';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const first = posToPx(points[0].r, points[0].c);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = posToPx(points[i].r, points[i].c);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function makeInitialBoard() {
  // Initialize full board with nulls
  const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  // Fill interior with distribution
  const bag = [];
  for (let i = 0; i < TYPE_COUNT; i++) {
    const count = i < 6 ? 6 : 4; // matches WinForms
    for (let k = 0; k < count; k++) bag.push(i);
  }
  // Shuffle bag
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }

  // Place into interior cells (r:1..ROWS-2, c:1..COLS-2)
  let idx = 0;
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      b[r][c] = bag[idx++];
    }
  }
  return b;
}

function renderBoard() {
  $board.innerHTML = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const val = board[r][c];
      const div = document.createElement('div');
      div.className = 'tile' + (val === null ? ' hidden' : '');
      div.style.left = `${c * TILE_W}px`;
      div.style.top = `${r * TILE_H}px`;
      if (val !== null) {
        div.style.backgroundImage = `url(assets/piece_${val}.png)`;
        div.dataset.r = String(r);
        div.dataset.c = String(c);
        div.addEventListener('click', onTileClick);
      }
      $board.appendChild(div);
    }
  }
}

function setSelected(el, on) {
  if (!el) return;
  el.classList.toggle('selected', !!on);
}

function onTileClick(e) {
  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);
  if (selected && selected.r === r && selected.c === c) return; // ignore clicking same

  const elPrev = selected ? document.querySelector(`.tile[data-r="${selected.r}"][data-c="${selected.c}"]`) : null;
  setSelected(elPrev, false);

  if (!selected) {
    selected = { r, c };
    setSelected(e.currentTarget, true);
    return;
  }

  // Attempt match
  const a = selected;
  const b = { r, c };
  if (board[a.r][a.c] !== board[b.r][b.c]) {
    selected = { r, c };
    setSelected(e.currentTarget, true);
    return;
  }

  if (inRoom && gameState === 'in_progress') {
    // Send move to server; server validates and broadcasts
    const move = { roomId, a, b };
    socket.emit('game:move', move, (resp) => {
      if (!resp?.ok) {
        // invalid; switch selection
        selected = { r, c };
        setSelected(e.currentTarget, true);
      } else {
        selected = null;
      }
    });
    return;
  }

  const path = findPathLimitedTurns(a, b, 2);
  if (path) {
    drawPath(path);
    // After delay, clear and apply level
    setTimeout(() => {
      clearLines();
      applyLevel(currentLevel || 1, a, b);
      selected = null;
      renderBoard();
    }, 700);
  } else {
    // No path; reselect current
    selected = { r, c };
    setSelected(e.currentTarget, true);
  }
}

// BFS path finding with at most K turns
function findPathLimitedTurns(start, goal, maxTurns) {
  const dirs = [
    { dr: -1, dc: 0 }, // up
    { dr: 1, dc: 0 },  // down
    { dr: 0, dc: -1 }, // left
    { dr: 0, dc: 1 },  // right
  ];

  // visited[r][c][dir] = min turns to reach
  const visited = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => Array(4).fill(Infinity)));
  const q = [];

  // Seed from start in all directions without consuming a turn
  for (let d = 0; d < 4; d++) {
    visited[start.r][start.c][d] = 0;
    q.push({ r: start.r, c: start.c, d, t: 0, parent: null });
  }

  // Helper to check cell passability: empty or goal
  const canPass = (r, c) => {
    if (!inBounds(r, c)) return false;
    if (r === goal.r && c === goal.c) return true;
    return board[r][c] === null; // empty (includes boundaries)
  };

  let endNode = null;

  while (q.length > 0) {
    const node = q.shift();
    const { r, c, d, t } = node;

    // Try extending in all 4 directions
    for (let nd = 0; nd < 4; nd++) {
      const turnCost = nd === d ? 0 : 1;
      const nt = t + (node.parent ? turnCost : 0); // first move doesn't count as a turn
      if (nt > maxTurns) continue;

      let nr = r + dirs[nd].dr;
      let nc = c + dirs[nd].dc;
      while (inBounds(nr, nc) && canPass(nr, nc)) {
        if (visited[nr][nc][nd] <= nt) {
          // already reached better or equal
        } else {
          visited[nr][nc][nd] = nt;
          const next = { r: nr, c: nc, d: nd, t: nt, parent: node };
          q.push(next);
          if (nr === goal.r && nc === goal.c) {
            endNode = next;
            q.length = 0; // break both loops
            break;
          }
        }
        nr += dirs[nd].dr;
        nc += dirs[nd].dc;
      }
      if (endNode) break;
    }
  }

  if (!endNode) return null;

  // Reconstruct points along direction changes only (corners), include endpoints
  const revPoints = [];
  let node = endNode;
  // Push goal first
  revPoints.push({ r: node.r, c: node.c });
  let lastDir = node.d;
  while (node.parent) {
    if (node.parent.d !== lastDir) {
      revPoints.push({ r: node.parent.r, c: node.parent.c });
      lastDir = node.parent.d;
    }
    node = node.parent;
  }
  // Ensure start is included
  revPoints.push({ r: start.r, c: start.c });
  return revPoints.reverse();
}

function applyLevel(level, a, b) {
  switch (level) {
    case 1:
      level1(a);
      level1(b);
      break;
    case 2:
      if (a.r < b.r) { level2(b); level2(a); } else { level2(a); level2(b); }
      break;
    case 3:
      if (a.r < b.r) { level3(a); level3(b); } else { level3(b); level3(a); }
      break;
    case 4:
      if (a.c < b.c) { level4(a); level4(b); } else { level4(b); level4(a); }
      break;
    case 5:
      if (a.c < b.c) { level5(b); level5(a); } else { level5(a); level5(b); }
      break;
    case 6:
      if (a.r > 5 && b.r > 5) {
        if (a.r < b.r) { level6(a); level6(b); } else { level6(b); level6(a); }
      } else {
        if (a.r < b.r) { level6(b); level6(a); } else { level6(a); level6(b); }
      }
      break;
    case 7:
      const centerC = 8; // index within row
      const aRight = a.c > centerC;
      const bRight = b.c > centerC;
      if (aRight && bRight) {
        if (a.c < b.c) { level7(a); level7(b); } else { level7(b); level7(a); }
      } else {
        if (a.c < b.c) { level7(b); level7(a); } else { level7(a); level7(b); }
      }
      break;
    default:
      level1(a); level1(b);
  }
}

function level1(p) {
  board[p.r][p.c] = null;
}

function level2(p) { // collapse down
  let r = p.r;
  while (r < ROWS - 1) {
    if (r + 1 < ROWS && board[r + 1][p.c] !== null) {
      board[r][p.c] = board[r + 1][p.c];
    } else {
      board[r][p.c] = null;
      break;
    }
    r += 1;
  }
}

function level3(p) { // collapse up
  let r = p.r;
  while (r > 0) {
    if (r - 1 >= 0 && board[r - 1][p.c] !== null) {
      board[r][p.c] = board[r - 1][p.c];
    } else {
      board[r][p.c] = null;
      break;
    }
    r -= 1;
  }
}

function level4(p) { // collapse left
  let c = p.c;
  const rowStart = Math.floor((p.r * COLS + p.c) / COLS) * COLS; // unused but kept for parity
  while (c > 0) {
    if (c - 1 >= 0 && board[p.r][c - 1] !== null) {
      board[p.r][c] = board[p.r][c - 1];
    } else {
      board[p.r][c] = null;
      break;
    }
    c -= 1;
  }
}

function level5(p) { // collapse right
  let c = p.c;
  while (c < COLS - 1) {
    if (c + 1 < COLS && board[p.r][c + 1] !== null) {
      board[p.r][c] = board[p.r][c + 1];
    } else {
      board[p.r][c] = null;
      break;
    }
    c += 1;
  }
}

function level6(p) { // collapse toward middle row (row index 5)
  const midRowStart = 90 / 18; // 5
  const midRowEndIndex = 107; // inclusive, same row
  if (p.r < 5) {
    // move down toward row 5
    let r = p.r;
    while (r <= 5) {
      if (r + 1 <= 5 && board[r + 1][p.c] !== null) {
        board[r][p.c] = board[r + 1][p.c];
      } else {
        board[r][p.c] = null;
        break;
      }
      r += 1;
    }
  } else if (p.r > 5) {
    // move up toward row 5
    let r = p.r;
    while (r >= 5) {
      if (r - 1 >= 5 && board[r - 1][p.c] !== null) {
        board[r][p.c] = board[r - 1][p.c];
      } else {
        board[r][p.c] = null;
        break;
      }
      r -= 1;
    }
  } else {
    // at middle row, just clear
    board[p.r][p.c] = null;
  }
}

function level7(p) { // collapse toward middle column (index 8)
  const midC = 8;
  if (p.c <= midC) {
    // move right toward mid
    let c = p.c;
    while (c <= midC) {
      if (c + 1 <= midC && board[p.r][c + 1] !== null) {
        board[p.r][c] = board[p.r][c + 1];
      } else {
        board[p.r][c] = null;
        break;
      }
      c += 1;
    }
  } else {
    // move left toward mid
    let c = p.c;
    while (c > midC) {
      if (c - 1 > midC && board[p.r][c - 1] !== null) {
        board[p.r][c] = board[p.r][c - 1];
      } else {
        board[p.r][c] = null;
        break;
      }
      c -= 1;
    }
  }
}

function newGame() {
  board = makeInitialBoard();
  currentLevel = (currentLevel + 1) % 8;
  if (currentLevel === 0) currentLevel = 1;
  $level.textContent = String(currentLevel);
  selected = null;
  clearLines();
  renderBoard();
}

function rerandom() {
  // Count remaining values by type and clear assignments first
  const counts = new Array(TYPE_COUNT).fill(0);
  const positions = [];
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (board[r][c] !== null) {
        counts[board[r][c]]++;
        board[r][c] = null;
        positions.push({ r, c });
      }
    }
  }
  // Create a list of types according to counts
  const bag = [];
  for (let i = 0; i < TYPE_COUNT; i++) {
    for (let k = 0; k < counts[i]; k++) bag.push(i);
  }
  // Shuffle and place back
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  for (let i = 0; i < positions.length; i++) {
    const { r, c } = positions[i];
    board[r][c] = bag[i];
  }
  renderBoard();
}

function autoStep() {
  // Attempt to find one matching pair and clear it
  for (let r1 = 1; r1 < ROWS - 1; r1++) {
    for (let c1 = 1; c1 < COLS - 1; c1++) {
      if (board[r1][c1] === null) continue;
      for (let r2 = 1; r2 < ROWS - 1; r2++) {
        for (let c2 = 1; c2 < COLS - 1; c2++) {
          if (r1 === r2 && c1 === c2) continue;
          if (board[r1][c1] !== board[r2][c2]) continue;
          const path = findPathLimitedTurns({ r: r1, c: c1 }, { r: r2, c: c2 }, 2);
          if (path) {
            drawPath(path);
            setTimeout(() => {
              clearLines();
              applyLevel(currentLevel || 1, { r: r1, c: c1 }, { r: r2, c: c2 });
              renderBoard();
            }, 300);
            return true;
          }
        }
      }
    }
  }
  return false;
}

// Wire UI (guard in case buttons are not present)
if ($btnNew) $btnNew.addEventListener('click', () => { if (!inRoom) newGame(); });
if ($btnReRandom) $btnReRandom.addEventListener('click', () => { if (!inRoom) rerandom(); });
if ($btnAuto) $btnAuto.addEventListener('click', () => {
  // Keep stepping until no move is found in a short loop
  const tick = () => {
    const ok = autoStep();
    if (ok) {
      setTimeout(tick, 350);
    }
  };
  tick();
});

// Keyboard shortcuts similar to WinForms
document.addEventListener('keydown', (e) => {
  if (!inRoom && e.ctrlKey && e.key.toLowerCase() === 'n') newGame();
  if ($btnAuto && e.ctrlKey && e.key.toLowerCase() === 'a') $btnAuto.click();
  if (!inRoom && e.ctrlKey && e.key.toLowerCase() === 'r') rerandom();
});

// Multiplayer wiring
function updateRoomUI() {
  // Show some buttons only for host; toggle Start/End based on state
  const isHostActive = inRoom && isHost;
  $btnStart.hidden = !(isHostActive && gameState !== 'in_progress');
  $btnEnd.hidden = !(isHostActive && gameState === 'in_progress');
  $btnRestart.hidden = !isHostActive;
  $btnClose.hidden = !isHostActive;
  $levelControls.hidden = !isHostActive;
  if ($btnSetLevel) $btnSetLevel.hidden = !isHostActive;
  $roomInfo.hidden = !inRoom;
  if ($levelText) $levelText.hidden = isHostActive || !inRoom;
  // Disable single-player controls when in room
  [$btnNew, $btnAuto, $btnReRandom].forEach(b => { if (b) b.disabled = inRoom; });
  if ($btnLeave) $btnLeave.hidden = !(inRoom && !isHost);
  if ($hostMarker) $hostMarker.hidden = !isHostActive;
  // Hide inputs for non-host while in room
  if ($nameInput) $nameInput.hidden = inRoom && !isHost;
  if ($roomInput) $roomInput.hidden = inRoom && !isHost;
}

function renderScores(scores) {
  if (!$scoreboard) return;
  $scoreboard.innerHTML = '';
  (scores || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'row';
    if (s.connected === false) row.style.opacity = '0.55';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const score = document.createElement('div');
    score.className = 'score';
    score.textContent = s.score;
    row.appendChild(name); row.appendChild(score);
    $scoreboard.appendChild(row);
  });
}

function connectSocket() {
  if (socket) return;
  socket = io({
    auth: { clientId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 10000,
  });

  // Server can assign a clientId if missing/invalid
  socket.on('session:assign', ({ clientId: assigned }) => {
    if (assigned && assigned !== clientId) {
      clientId = assigned;
      try { localStorage.setItem('pikachuClientId', assigned); } catch(_){}
    }
  });

  socket.on('room:playerJoined', ({ scores }) => { renderScores(scores); });
  socket.on('room:playerLeft', ({ scores }) => { renderScores(scores); });
  socket.on('room:playerDisconnected', ({ scores }) => { renderScores(scores); });
  socket.on('room:playerRejoined', ({ scores }) => { renderScores(scores); });
  socket.on('room:closed', () => {
    inRoom = false; isHost = false; roomId = null; gameState = 'lobby';
    $roomCode.textContent = '';
    updateRoomUI();
  });

  socket.on('game:started', ({ board: srvBoard, level, scores }) => {
    inRoom = true; gameState = 'in_progress';
    board = srvBoard; currentLevel = level; $level.textContent = String(level);
    if ($levelSelect) $levelSelect.value = String(level);
    if ($levelTextValue) $levelTextValue.textContent = String(level);
    renderBoard(); renderScores(scores); clearLines(); updateRoomUI();
  });

  socket.on('game:restarted', ({ board: srvBoard, level, scores }) => {
    gameState = 'in_progress';
    board = srvBoard; currentLevel = level; $level.textContent = String(level);
    if ($levelSelect) $levelSelect.value = String(level);
    if ($levelTextValue) $levelTextValue.textContent = String(level);
    renderBoard(); renderScores(scores); clearLines(); updateRoomUI();
  });

  socket.on('game:matched', ({ path, board: srvBoard, scores }) => {
    if (path) {
      drawPath(path);
      setTimeout(() => { clearLines(); }, 700);
    }
    board = srvBoard; renderBoard(); renderScores(scores);
  });

  socket.on('game:ended', ({ scores, level }) => {
    gameState = 'ended'; renderScores(scores);
    if (level) { currentLevel = level; $level.textContent = String(level); if ($levelSelect) $levelSelect.value = String(level); if ($levelTextValue) $levelTextValue.textContent = String(level); }
    updateRoomUI();
  });
  socket.on('room:levelChanged', ({ level }) => {
    currentLevel = level; $level.textContent = String(level);
    if ($levelSelect) $levelSelect.value = String(level);
    if ($levelTextValue) $levelTextValue.textContent = String(level);
  });
  socket.on('game:shuffled', ({ board: srvBoard }) => {
    // Server auto-reshuffled due to no moves
    board = srvBoard; renderBoard(); clearLines();
  });
  // Resume state after reconnect
  socket.on('session:resumed', (resp) => {
    if (!resp?.ok) return;
    inRoom = true; roomId = resp.roomId; isHost = (resp.hostId === clientId); gameState = resp.state;
    if ($roomCode) $roomCode.textContent = resp.roomId;
    if (resp.board) { board = resp.board; renderBoard(); }
    if (resp.level) { currentLevel = resp.level; $level.textContent = String(resp.level); if ($levelSelect) $levelSelect.value = String(resp.level); if ($levelTextValue) $levelTextValue.textContent = String(resp.level); }
    renderScores(resp.scores);
    updateRoomUI();
  });
}

$btnHost && $btnHost.addEventListener('click', () => {
  connectSocket();
  const name = ($nameInput.value || 'Host').trim();
  socket.emit('host:createRoom', { name }, (resp) => {
    if (!resp?.ok) return alert(resp?.error || 'Cannot create room');
    inRoom = true; isHost = true; roomId = resp.roomId; gameState = resp.state;
    $roomCode.textContent = roomId; updateRoomUI(); renderScores(resp.scores);
    if (resp.level) { currentLevel = resp.level; $level.textContent = String(resp.level); if ($levelSelect) $levelSelect.value = String(resp.level); if ($levelTextValue) $levelTextValue.textContent = String(resp.level); }
  });
});

$btnJoin && $btnJoin.addEventListener('click', () => {
  connectSocket();
  const name = ($nameInput.value || 'Player').trim();
  const code = ($roomInput.value || '').trim().toUpperCase();
  if (!code) return alert('Enter room code');
  socket.emit('user:joinRoom', { roomId: code, name }, (resp) => {
    if (!resp?.ok) return alert(resp?.error || 'Cannot join');
    inRoom = true; isHost = (resp.hostId === clientId); roomId = code; gameState = resp.state;
    $roomCode.textContent = code; updateRoomUI(); renderScores(resp.scores);
    if (resp.board) { board = resp.board; renderBoard(); }
    if (resp.level) { currentLevel = resp.level; $level.textContent = String(resp.level); if ($levelSelect) $levelSelect.value = String(resp.level); if ($levelTextValue) $levelTextValue.textContent = String(resp.level); }
  });
});

// Leave room (non-host)
$btnLeave && $btnLeave.addEventListener('click', () => {
  if (!inRoom || !roomId) return;
  connectSocket();
  socket.emit('user:leaveRoom', { roomId }, (resp) => {
    if (!resp?.ok) return alert(resp?.error || 'Cannot leave');
    inRoom = false; isHost = false; roomId = null; gameState = 'lobby';
    $roomCode.textContent = '';
    renderScores([]); clearLines();
    updateRoomUI();
  });
});

$btnStart.addEventListener('click', () => {
  if (!(inRoom && isHost)) return; socket.emit('host:startGame', { roomId });
});
$btnEnd.addEventListener('click', () => {
  if (!(inRoom && isHost)) return; socket.emit('host:endGame', { roomId });
});
$btnRestart.addEventListener('click', () => {
  if (!(inRoom && isHost)) return; socket.emit('host:restartGame', { roomId });
});
$btnClose.addEventListener('click', () => {
  if (!(inRoom && isHost)) return; socket.emit('host:closeRoom', { roomId });
});

// Level control (host only)
$btnSetLevel.addEventListener('click', () => {
  if (!(inRoom && isHost)) return;
  const value = Number($levelSelect.value);
  socket.emit('host:setLevel', { roomId, level: value }, (resp) => {
    if (!resp?.ok) return alert(resp?.error || 'Failed to set level');
    currentLevel = resp.level; $level.textContent = String(resp.level);
  });
});

// Start single-player by default
// Room URL helpers: support /pikachu/{CODE}?join=1|create=1&name=...
(function initFromURL(){
  try {
    const parts = location.pathname.split('/').filter(Boolean);
    // If user opens /pikachu/{CODE} directly, redirect to '/' to type name first
    try {
      if (parts[0] === 'pikachu' && parts[1]) {
        const pending = JSON.parse(sessionStorage.getItem('gamePending') || 'null');
        if (!pending) {
          sessionStorage.setItem('gamePending', JSON.stringify({ game: 'pikachu', action: 'join', code: (parts[1]||'').toUpperCase() }));
          location.href = '/';
          return;
        }
      }
    } catch(_) {}
    if (parts[0] === 'pikachu' && parts[1]) {
      const code = (parts[1] || '').toUpperCase();
      if ($roomInput) $roomInput.value = code;
      if ($roomCode) $roomCode.textContent = code;
    }
    // Read pending action from sessionStorage set by Create page
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem('gamePending') || 'null'); } catch (_) { pending = null; }
    if (pending && pending.game === 'pikachu') {
      if (pending.name) { selfName = pending.name.trim(); }
      if ($selfName) $selfName.textContent = selfName;
      connectSocket();
      const code = (pending.code || (parts[1] ? (parts[1]||'').toUpperCase() : '')).trim();
      if (pending.action === 'create') {
        // Optimistically show host controls while creating
        inRoom = true; isHost = true; roomId = code || null; gameState = 'lobby';
        updateRoomUI();
        const hostName = (selfName || 'Host').trim();
        socket.emit('host:createRoom', { name: hostName, roomId: code || undefined }, (resp) => {
          if (!resp?.ok) { alert(resp?.error || 'Cannot create'); return; }
          inRoom = true; isHost = true; roomId = resp.roomId; gameState = resp.state;
          if ($roomCode) $roomCode.textContent = resp.roomId;
          updateRoomUI(); renderScores(resp.scores);
          if (resp.level) { currentLevel = resp.level; $level.textContent = String(resp.level); if ($levelSelect) $levelSelect.value = String(resp.level); if ($levelTextValue) $levelTextValue.textContent = String(resp.level); }
        });
        sessionStorage.removeItem('gamePending');
        return;
      }
      if (pending.action === 'join' && code) {
        // Require a name for joining; if missing, send user to '/'
        if (!pending.name || !pending.name.trim()) {
          sessionStorage.setItem('gamePending', JSON.stringify({ game: 'pikachu', action: 'join', code }));
          location.href = '/';
          return;
        }
        const player = (selfName || 'Player').trim();
        socket.emit('user:joinRoom', { roomId: code, name: player }, (resp) => {
          if (!resp?.ok) return alert(resp?.error || 'Cannot join');
          inRoom = true; isHost = (resp.hostId === clientId); roomId = code; gameState = resp.state;
          if ($roomCode) $roomCode.textContent = code;
          updateRoomUI(); renderScores(resp.scores);
          if (resp.board) { board = resp.board; renderBoard(); }
          if (resp.level) { currentLevel = resp.level; $level.textContent = String(resp.level); if ($levelSelect) $levelSelect.value = String(resp.level); if ($levelTextValue) $levelTextValue.textContent = String(resp.level); }
        });
        sessionStorage.removeItem('gamePending');
        return;
      }
      sessionStorage.removeItem('gamePending');
    }
  } catch (_) {}
  // Fallback: single-player
  newGame();
})();


