// Thin fetch wrapper around the Worker API + Telegram Mini App bootstrap.
// No coin/user/game state is ever trusted from anywhere except what these
// calls return from the backend.

const API_BASE_URL = 'https://tictactoe-worker.abhishekmail841.workers.dev';

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const Api = {
  initData: '',
  startParam: null,

  init() {
    if (tg) {
      tg.ready();
      tg.expand();
      // True edge-to-edge fullscreen (hides Telegram's own header/close bar),
      // available on Bot API 8.0+ clients. Older Telegram versions simply
      // don't have this method, hence the guards — `expand()` above is the
      // fallback for those and still gives the tall (non-half-screen) view.
      try {
        if (tg.requestFullscreen) tg.requestFullscreen();
      } catch (_) {}
      try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (_) {}
      // Always our own fixed dark colors — NEVER Telegram's theme keys
      // ('secondary_bg_color'/'bg_color'), which flip to light values when
      // the person's Telegram is set to light mode and would otherwise wash
      // out our whole dark UI. Passing an explicit hex here (Bot API 6.1+)
      // keeps both the native header bar and the page background locked to
      // this app's own theme regardless of the person's Telegram setting.
      try { tg.setHeaderColor && tg.setHeaderColor('#131628'); } catch (_) {}
      try { tg.setBackgroundColor && tg.setBackgroundColor('#0b0d16'); } catch (_) {}
      this.initData = tg.initData || '';
      this.startParam = tg.initDataUnsafe?.start_param || null;
      this.applySafeArea();
      // Fullscreen mode overlays Telegram's OWN small floating control bar
      // (Close / title / chevron / "...") on top of our content — that area
      // is reported separately from the device's own notch/status-bar inset
      // (which env(safe-area-inset-top) already covers). Without adding
      // this on top too, our topbar renders underneath Telegram's overlay
      // and gets visually hidden by it. Both insets can change (e.g. the
      // overlay auto-collapses after a moment on some clients), so we
      // re-apply on every change event, not just once at load.
      tg.onEvent && tg.onEvent('safeAreaChanged', () => this.applySafeArea());
      tg.onEvent && tg.onEvent('contentSafeAreaChanged', () => this.applySafeArea());
      tg.onEvent && tg.onEvent('fullscreenChanged', () => this.applySafeArea());
    } else {
      // Allows local preview outside Telegram (no auth will succeed, but the UI can be inspected).
      console.warn('Telegram WebApp SDK not detected — running outside Telegram.');
    }
  },

  applySafeArea() {
    if (!tg) return;
    const root = document.documentElement;
    const deviceTop = tg.safeAreaInset?.top || 0;
    const contentTop = tg.contentSafeAreaInset?.top || 0;
    // The two insets cover different things (device notch vs Telegram's own
    // fullscreen overlay) and can overlap in practice on some clients, so we
    // take the larger of the two rather than always summing them — summing
    // tends to push the topbar down further than actually needed.
    root.style.setProperty('--tg-content-safe-top', `${Math.max(deviceTop, contentTop)}px`);
  },

  haptic(style = 'light') {
    try {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(style);
    } catch (_) {}
  },

  async request(path, options = {}) {
    // On a slow/flaky connection a plain fetch() can hang far longer than
    // is useful (Telegram's in-app browser doesn't always surface its own
    // timeout quickly) — so every request gets its own hard cutoff. A poll
    // tick that times out is treated just like any other failed tick by the
    // caller, not a crash.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let res;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': this.initData,
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Request timed out — check your connection.');
      throw new Error('Network error — check your connection.');
    } finally {
      clearTimeout(timeout);
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  },

  auth() {
    return this.request('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ initData: this.initData }),
    });
  },

  me() {
    return this.request('/api/me');
  },

  searchPlayers(q) {
    return this.request(`/api/players?q=${encodeURIComponent(q)}`);
  },

  createChallenge(targetTelegramId, chatId) {
    return this.request('/api/challenge', {
      method: 'POST',
      body: JSON.stringify({ targetTelegramId, chatId }),
    });
  },

  // `gameType` ('tictactoe' | 'rps') is which game the ACCEPTER picked —
  // see the two-button challenge modal / Telegram challenge buttons.
  acceptChallenge(gameId, gameType) {
    return this.request('/api/challenge/accept', {
      method: 'POST',
      body: JSON.stringify({ gameId, gameType }),
    });
  },

  joinMatchmaking() {
    return this.request('/api/matchmaking/join', { method: 'POST' });
  },

  cancelMatchmaking(gameId) {
    return this.request('/api/matchmaking/cancel', {
      method: 'POST',
      body: JSON.stringify({ gameId }),
    });
  },

  declineChallenge(gameId) {
    return this.request('/api/challenge/decline', {
      method: 'POST',
      body: JSON.stringify({ gameId }),
    });
  },

  getGame(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}`);
  },

  getGameState(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`);
  },

  postMove(gameId, index) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/move`, {
      method: 'POST',
      body: JSON.stringify({ index }),
    });
  },

  resetGameRoom(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reset' }),
    });
  },

  submitResult(gameId, result) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/result`, {
      method: 'POST',
      body: JSON.stringify({ result }),
    });
  },

  forfeitGame(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/forfeit`, {
      method: 'POST',
    });
  },

  // Called by the WAITING player once the opponent has been idle on their
  // own turn for 60s straight — relayed through the same /state action
  // dispatch the game room already uses for reset/reaction.
  claimTimeout(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'claim-timeout' }),
    });
  },

  // Reactions are relayed through the same in-memory game room as moves —
  // never written to D1. `sendReaction` piggybacks on the /state endpoint's
  // action dispatch, same as `resetGameRoom`.
  sendReaction(gameId, emoji) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reaction', emoji }),
    });
  },

  leaderboard() {
    return this.request('/api/leaderboard');
  },

  getShopPackages() {
    return this.request('/api/shop/packages');
  },

  spinInfo() {
    return this.request('/api/spin');
  },

  spin() {
    return this.request('/api/spin', { method: 'POST' });
  },

  claimBotWin(board) {
    return this.request('/api/bot-win', {
      method: 'POST',
      body: JSON.stringify({ board }),
    });
  },

  // Rock Paper Scissors — server picks the bot's move itself and returns the
  // outcome, so a round can't be forged by the client.
  playRps(choice) {
    return this.request('/api/rps/play', {
      method: 'POST',
      body: JSON.stringify({ choice }),
    });
  },

  // 2048 — client plays entirely locally, then claims the coin reward once
  // a winning (2048) tile is reached, same trust model as claimBotWin.
  claim2048Win(board) {
    return this.request('/api/2048-win', {
      method: 'POST',
      body: JSON.stringify({ board }),
    });
  },

  // Rock Paper Scissors PvP — relayed through the same in-memory game room
  // as the Tic Tac Toe board/reactions (never touches D1). `getGameState`
  // above is reused as-is for polling the opponent's pick.
  pvpRpsPick(gameId, choice) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rps-pick', choice }),
    });
  },

  pvpRpsReplay(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rps-replay' }),
    });
  },

  // Marks the match ended once a player leaves, so a stale "Play Game" deep
  // link can never silently drop someone back into a match whose opponent
  // is already gone (see app.js's startParam handling).
  leaveRpsMatch(gameId) {
    return this.request(`/api/game/${encodeURIComponent(gameId)}/rps-leave`, {
      method: 'POST',
    });
  },

  createInvoice(packageId) {
    return this.request('/api/shop/invoice', {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    });
  },
};

window.Api = Api;
