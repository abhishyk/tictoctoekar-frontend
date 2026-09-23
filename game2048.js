// Classic 2048 — entirely client-side (per instruction: no D1/backend state
// for the game itself). The ONLY server call is the one-shot coin claim once
// a 2048 tile is actually reached (Api.claim2048Win), same trust model as
// Bot-mode Tic Tac Toe: server does a cheap legality check on the submitted
// board, not full move-by-move replay.
window.Game2048 = (function () {
  const SIZE = 4;
  const WIN_TILE = 2048;
  let grid = [];
  let score = 0;
  let wonThisGame = false;
  let over = false;
  let wired = false;

  const TILE_COLORS = {
    2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563',
    32: '#f67c5f', 64: '#f65e3b', 128: '#edcf72', 256: '#edcc61',
    512: '#edc850', 1024: '#edc53f', 2048: '#edc22e',
  };

  function el(id) { return document.getElementById(id); }

  function start() {
    grid = Array(SIZE * SIZE).fill(0);
    score = 0;
    wonThisGame = false;
    over = false;
    spawnTile();
    spawnTile();
    render();
    wireControls();
  }

  function idx(r, c) { return r * SIZE + c; }

  function spawnTile() {
    const empty = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] === 0) empty.push(i);
    if (!empty.length) return;
    const i = empty[Math.floor(Math.random() * empty.length)];
    grid[i] = Math.random() < 0.9 ? 2 : 4;
  }

  // Slides+merges one line (array of 4 values, 0 = empty) towards index 0.
  // Returns { line, gained, moved } — `line` is the new 4-value line.
  function collapseLine(line) {
    const nonZero = line.filter((v) => v !== 0);
    const result = [];
    let gained = 0;
    for (let i = 0; i < nonZero.length; i++) {
      if (i < nonZero.length - 1 && nonZero[i] === nonZero[i + 1]) {
        const merged = nonZero[i] * 2;
        result.push(merged);
        gained += merged;
        i++;
      } else {
        result.push(nonZero[i]);
      }
    }
    while (result.length < SIZE) result.push(0);
    const moved = result.some((v, i) => v !== line[i]);
    return { line: result, gained, moved };
  }

  function getLine(dir, i) {
    // dir: 'left' | 'right' | 'up' | 'down'
    const line = [];
    for (let j = 0; j < SIZE; j++) {
      if (dir === 'left' || dir === 'right') line.push(grid[idx(i, j)]);
      else line.push(grid[idx(j, i)]);
    }
    if (dir === 'right' || dir === 'down') line.reverse();
    return line;
  }

  function setLine(dir, i, line) {
    if (dir === 'right' || dir === 'down') line = [...line].reverse();
    for (let j = 0; j < SIZE; j++) {
      if (dir === 'left' || dir === 'right') grid[idx(i, j)] = line[j];
      else grid[idx(j, i)] = line[j];
    }
  }

  function move(dir) {
    if (over) return;
    let anyMoved = false;
    let gainedTotal = 0;
    for (let i = 0; i < SIZE; i++) {
      const { line, gained, moved } = collapseLine(getLine(dir, i));
      if (moved) anyMoved = true;
      gainedTotal += gained;
      setLine(dir, i, line);
    }
    if (!anyMoved) return;

    score += gainedTotal;
    spawnTile();
    render();
    window.MiniApp.haptic('light');

    if (!wonThisGame && grid.some((v) => v >= WIN_TILE)) {
      wonThisGame = true;
      claimWin();
    } else if (isGameOver()) {
      over = true;
      window.MiniApp.haptic('medium');
      window.MiniApp.showMiniResult({
        win: false,
        emoji: '😢',
        title: 'No More Moves',
        sub: 'Board is full — tap Replay to try again.',
        coinText: '',
        onReplay: start,
        autoReplayOnTimeout: true, // solo game — no reason to force Home if they don't tap in time
      });
    }
  }

  function isGameOver() {
    if (grid.some((v) => v === 0)) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const v = grid[idx(r, c)];
        if (c < SIZE - 1 && grid[idx(r, c + 1)] === v) return false;
        if (r < SIZE - 1 && grid[idx(r + 1, c)] === v) return false;
      }
    }
    return true;
  }

  async function claimWin() {
    try {
      const res = await Api.claim2048Win(grid.slice());
      if (res.awarded) window.MiniApp.updateCoins(res.coins);

      const note = el('g2048CapNote');
      if (note && res.earnedToday !== undefined) {
        note.textContent = `Earned today: ${res.earnedToday} / ${res.cap} coins`;
      }

      window.MiniApp.haptic('heavy');
      window.MiniApp.showMiniResult({
        win: true,
        emoji: '🎉',
        title: '2048 Reached!',
        sub: 'You merged your way to victory.',
        coinText: res.awarded ? `+${res.reward} coin` : 'Daily coin limit reached',
        coinPositive: res.awarded,
        onReplay: start,
        autoReplayOnTimeout: true,
      });
    } catch (err) {
      window.MiniApp.toast(err.message || 'Could not claim reward — check your connection.');
    }
  }

  function render() {
    const board = el('g2048Board');
    board.innerHTML = '';
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      const tile = document.createElement('div');
      tile.className = 'g2048-tile' + (v === 0 ? ' empty' : '');
      if (v) {
        tile.textContent = v;
        tile.style.background = TILE_COLORS[v] || '#3c3a32';
        tile.style.color = v <= 4 ? '#5a5248' : '#fff';
      }
      board.appendChild(tile);
    }
    el('g2048Score').textContent = score;
  }

  function wireControls() {
    if (wired) return;
    wired = true;

    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.screen.active')?.dataset.screen !== '2048') return;
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (map[e.key]) { e.preventDefault(); move(map[e.key]); }
    });

    const wrap = document.querySelector('.g2048-board-wrap');
    let startX = 0, startY = 0;
    wrap.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    wrap.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
      else move(dy > 0 ? 'down' : 'up');
    }, { passive: true });

    el('g2048RestartBtn').addEventListener('click', start);
  }

  return { start };
})();
