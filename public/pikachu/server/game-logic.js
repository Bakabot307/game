// Shared game logic for server

const ROWS = 11;
const COLS = 18;
const TYPE_COUNT = 33;

function makeInitialBoard() {
  const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const bag = [];
  for (let i = 0; i < TYPE_COUNT; i++) {
    const count = i < 6 ? 6 : 4;
    for (let k = 0; k < count; k++) bag.push(i);
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  let idx = 0;
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      b[r][c] = bag[idx++];
    }
  }
  return b;
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function findPathLimitedTurns(board, start, goal, maxTurns) {
  const dirs = [
    { dr: -1, dc: 0 },
    { dr: 1, dc: 0 },
    { dr: 0, dc: -1 },
    { dr: 0, dc: 1 },
  ];
  const visited = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => Array(4).fill(Infinity)));
  const q = [];
  for (let d = 0; d < 4; d++) {
    visited[start.r][start.c][d] = 0;
    q.push({ r: start.r, c: start.c, d, t: 0, parent: null });
  }
  const canPass = (r, c) => {
    if (!inBounds(r, c)) return false;
    if (r === goal.r && c === goal.c) return true;
    return board[r][c] === null;
  };
  let endNode = null;
  while (q.length) {
    const node = q.shift();
    const { r, c, d, t } = node;
    for (let nd = 0; nd < 4; nd++) {
      const turnCost = nd === d ? 0 : 1;
      const nt = t + (node.parent ? turnCost : 0);
      if (nt > maxTurns) continue;
      let nr = r + dirs[nd].dr;
      let nc = c + dirs[nd].dc;
      while (inBounds(nr, nc) && canPass(nr, nc)) {
        if (visited[nr][nc][nd] > nt) {
          visited[nr][nc][nd] = nt;
          const next = { r: nr, c: nc, d: nd, t: nt, parent: node };
          q.push(next);
          if (nr === goal.r && nc === goal.c) {
            endNode = next;
            q.length = 0;
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
  const revPoints = [];
  let node = endNode;
  revPoints.push({ r: node.r, c: node.c });
  let lastDir = node.d;
  while (node.parent) {
    if (node.parent.d !== lastDir) {
      revPoints.push({ r: node.parent.r, c: node.parent.c });
      lastDir = node.parent.d;
    }
    node = node.parent;
  }
  revPoints.push({ r: start.r, c: start.c });
  return revPoints.reverse();
}

function applyLevel(board, level, a, b) {
  switch (level) {
    case 1:
      level1(board, a); level1(board, b); break;
    case 2:
      if (a.r < b.r) { level2(board, b); level2(board, a); } else { level2(board, a); level2(board, b); }
      break;
    case 3:
      if (a.r < b.r) { level3(board, a); level3(board, b); } else { level3(board, b); level3(board, a); }
      break;
    case 4:
      if (a.c < b.c) { level4(board, a); level4(board, b); } else { level4(board, b); level4(board, a); }
      break;
    case 5:
      if (a.c < b.c) { level5(board, b); level5(board, a); } else { level5(board, a); level5(board, b); }
      break;
    case 6:
      if (a.r > 5 && b.r > 5) {
        if (a.r < b.r) { level6(board, a); level6(board, b); } else { level6(board, b); level6(board, a); }
      } else {
        if (a.r < b.r) { level6(board, b); level6(board, a); } else { level6(board, a); level6(board, b); }
      }
      break;
    case 7:
      const centerC = 8;
      const aRight = a.c > centerC; const bRight = b.c > centerC;
      if (aRight && bRight) {
        if (a.c < b.c) { level7(board, a); level7(board, b); } else { level7(board, b); level7(board, a); }
      } else {
        if (a.c < b.c) { level7(board, b); level7(board, a); } else { level7(board, a); level7(board, b); }
      }
      break;
    default:
      level1(board, a); level1(board, b);
  }
}

function level1(board, p) { board[p.r][p.c] = null; }
function level2(board, p) { // down
  let r = p.r;
  while (r < ROWS - 1) {
    if (r + 1 < ROWS && board[r + 1][p.c] !== null) board[r][p.c] = board[r + 1][p.c];
    else { board[r][p.c] = null; break; }
    r += 1;
  }
}
function level3(board, p) { // up
  let r = p.r;
  while (r > 0) {
    if (r - 1 >= 0 && board[r - 1][p.c] !== null) board[r][p.c] = board[r - 1][p.c];
    else { board[r][p.c] = null; break; }
    r -= 1;
  }
}
function level4(board, p) { // left
  let c = p.c;
  while (c > 0) {
    if (c - 1 >= 0 && board[p.r][c - 1] !== null) board[p.r][c] = board[p.r][c - 1];
    else { board[p.r][c] = null; break; }
    c -= 1;
  }
}
function level5(board, p) { // right
  let c = p.c;
  while (c < COLS - 1) {
    if (c + 1 < COLS && board[p.r][c + 1] !== null) board[p.r][c] = board[p.r][c + 1];
    else { board[p.r][c] = null; break; }
    c += 1;
  }
}
function level6(board, p) { // toward middle row 5
  if (p.r < 5) {
    let r = p.r;
    while (r <= 5) {
      if (r + 1 <= 5 && board[r + 1][p.c] !== null) board[r][p.c] = board[r + 1][p.c];
      else { board[r][p.c] = null; break; }
      r += 1;
    }
  } else if (p.r > 5) {
    let r = p.r;
    while (r >= 5) {
      if (r - 1 >= 5 && board[r - 1][p.c] !== null) board[r][p.c] = board[r - 1][p.c];
      else { board[r][p.c] = null; break; }
      r -= 1;
    }
  } else {
    board[p.r][p.c] = null;
  }
}
function level7(board, p) { // toward middle col 8
  const midC = 8;
  if (p.c <= midC) {
    let c = p.c;
    while (c <= midC) {
      if (c + 1 <= midC && board[p.r][c + 1] !== null) board[p.r][c] = board[p.r][c + 1];
      else { board[p.r][c] = null; break; }
      c += 1;
    }
  } else {
    let c = p.c;
    while (c > midC) {
      if (c - 1 > midC && board[p.r][c - 1] !== null) board[p.r][c] = board[p.r][c - 1];
      else { board[p.r][c] = null; break; }
      c -= 1;
    }
  }
}

function boardCleared(board) {
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (board[r][c] !== null) return false;
    }
  }
  return true;
}

// Determine whether any valid pair exists on the current board
function hasAnyMove(board) {
  const positionsByType = Array.from({ length: TYPE_COUNT }, () => []);
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      const v = board[r][c];
      if (v !== null) positionsByType[v].push({ r, c });
    }
  }
  for (let t = 0; t < TYPE_COUNT; t++) {
    const pts = positionsByType[t];
    const n = pts.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const path = findPathLimitedTurns(board, pts[i], pts[j], 2);
        if (path) return true;
      }
    }
  }
  return false;
}

// Shuffle remaining tiles: redistribute types among existing non-null cells
function rerandomRemaining(board) {
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
  const bag = [];
  for (let t = 0; t < TYPE_COUNT; t++) {
    for (let k = 0; k < counts[t]; k++) bag.push(t);
  }
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  for (let i = 0; i < positions.length; i++) {
    const { r, c } = positions[i];
    board[r][c] = bag[i];
  }
  return board;
}

module.exports = {
  ROWS, COLS, TYPE_COUNT,
  makeInitialBoard,
  findPathLimitedTurns,
  applyLevel,
  boardCleared,
  hasAnyMove,
  rerandomRemaining,
};
