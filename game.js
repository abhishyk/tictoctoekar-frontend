// Pure Tic Tac Toe engine — board lives only here, in the browser. Nothing
// in this file talks to the network. Shared by both Computer mode and PvP
// (PvP only differs in who's allowed to move and how the result is reported).

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],           // diagonals
];

const Game = {
  WIN_LINES,

  emptyBoard() {
    return Array(9).fill(null);
  },

  /** Returns { winner: 'X'|'O'|null, line: [i,i,i]|null, isDraw: boolean } */
  evaluate(board) {
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return { winner: board[a], line, isDraw: false };
      }
    }
    const isDraw = board.every((cell) => cell !== null);
    return { winner: null, line: null, isDraw };
  },

  availableMoves(board) {
    const moves = [];
    board.forEach((cell, i) => { if (!cell) moves.push(i); });
    return moves;
  },

  // Small chance the bot plays a genuinely weak (not just "one of several
  // equally good") move instead of its real best one — otherwise minimax
  // is mathematically unbeatable and a human could never actually WIN, only
  // ever draw at best. This keeps the bot strong almost always (97% of its
  // moves are still perfect) while leaving a real, if rare, window to win.
  MISTAKE_CHANCE: 0.20,

  /**
   * Unbeatable-by-default minimax computer opponent. `computerMark` moves,
   * `humanMark` is the other symbol. Adds slight randomness among
   * equally-good moves so it doesn't always pick the same cell, plus a
   * small MISTAKE_CHANCE of a genuinely weak move (see above).
   */
  bestMove(board, computerMark, humanMark) {
    const moves = this.availableMoves(board);
    if (moves.length === 9) {
      // Opening move: corners/center play better and avoid a fully
      // deterministic-looking first move.
      const openings = [0, 2, 4, 6, 8];
      return openings[Math.floor(Math.random() * openings.length)];
    }

    if (Math.random() < this.MISTAKE_CHANCE) {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    let bestScore = -Infinity;
    let candidates = [];

    for (const move of moves) {
      const next = board.slice();
      next[move] = computerMark;
      const score = this._minimax(next, 0, false, computerMark, humanMark);
      if (score > bestScore) {
        bestScore = score;
        candidates = [move];
      } else if (score === bestScore) {
        candidates.push(move);
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  },

  _minimax(board, depth, isMaximizing, computerMark, humanMark) {
    const { winner, isDraw } = this.evaluate(board);
    if (winner === computerMark) return 10 - depth;
    if (winner === humanMark) return depth - 10;
    if (isDraw) return 0;

    const moves = this.availableMoves(board);
    if (isMaximizing) {
      let best = -Infinity;
      for (const move of moves) {
        const next = board.slice();
        next[move] = computerMark;
        best = Math.max(best, this._minimax(next, depth + 1, false, computerMark, humanMark));
      }
      return best;
    } else {
      let best = Infinity;
      for (const move of moves) {
        const next = board.slice();
        next[move] = humanMark;
        best = Math.min(best, this._minimax(next, depth + 1, true, computerMark, humanMark));
      }
      return best;
    }
  },
};

window.Game = Game;
