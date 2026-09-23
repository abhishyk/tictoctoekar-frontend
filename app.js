// App shell: SPA navigation + screen wiring. This is the only file that
// touches the DOM at a "controller" level — game.js/animations.js/api.js
// stay reusable and side-effect-light.

(function () {
  'use strict';

  const State = {
    user: null,
    screenHistory: ['home'],
    currentGame: null, // { mode: 'computer'|'pvp', gameId, board, myMark, oppMark, ... }
    pollTimer: null,
    pollInFlight: false,
    connIssueStreak: 0,
    challengePollTimer: null,
    matchmakingGameId: null,
  };

  const el = (id) => document.getElementById(id);
  const screens = {};
  document.querySelectorAll('.screen').forEach((s) => { screens[s.dataset.screen] = s; });

  // ---- Deterrent: disable right-click + common DevTools shortcuts -------
  // NOTE: this is a UX nicety only. It cannot stop a determined user (the
  // browser menu, remote debugging, etc. still work) and is not a security
  // boundary — all real security (coins, results, auth) lives server-side.
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const blocked =
      k === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'K'].includes(k.toUpperCase())) ||
      (e.metaKey && e.altKey && ['I', 'J', 'C'].includes(k.toUpperCase())) ||
      (e.ctrlKey && k.toUpperCase() === 'U');
    if (blocked) e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => e.preventDefault());

  // ---- Keep the screen awake/bright during a match -------------------------
  // What looked like "brightness auto-lowers mid-game and only comes back
  // when I tap" is the phone's normal inactivity dimmer — taps are the only
  // thing resetting its idle timer, and mid-match most taps are on the board,
  // not spread out, so the screen dims in between. The Wake Lock API tells
  // the OS "this page is active" so it skips that dimming entirely while a
  // game is open. It has no effect on the ambient-light sensor (a phone in a
  // genuinely dark room will still dim itself), and older/limited in-app
  // browsers may not support it at all — in that case this just no-ops and
  // the game behaves as it did before.
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) {
      wakeLock = null;
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  // A wake lock is auto-released whenever the tab/app goes to the background
  // (switching apps, screen off) — so if we come back while still on the
  // game screen, re-acquire it rather than leaving the screen unprotected.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.querySelector('.screen.active')?.dataset.screen === 'game') {
      requestWakeLock();
    }
  });

  // ---- Navigation ---------------------------------------------------------
  function showScreen(name, { replace = false } = {}) {
    const current = document.querySelector('.screen.active');
    const next = screens[name];
    if (!next) return;

    // Leaving the RPS screen entirely (e.g. the back arrow, mid-round,
    // before a result is even shown) — stop its PvP background poll so it
    // doesn't keep quietly hitting the game room after we've navigated away.
    if (current && current.dataset.screen === 'rps' && name !== 'rps') {
      if (window.RpsGame && typeof window.RpsGame.stopPvp === 'function') window.RpsGame.stopPvp();
    }

    Anim.switchScreen(current, next);

    if (!replace) {
      State.screenHistory.push(name);
    } else {
      State.screenHistory[State.screenHistory.length - 1] = name;
    }
    el('backBtn').hidden = name === 'home';

    stopPolling();
    if (name !== 'game') stopChallengePolling();

    if (name === 'game') {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }

  function goBack() {
    if (State.currentGame && State.currentGame.mode === 'pvp' && State.currentGame.status === 'in_progress') {
      Anim.showToast('Finish the match, or use 🚩 to quit');
      return;
    }
    State.screenHistory.pop();
    const prev = State.screenHistory.pop() || 'home';
    showScreen(prev);
  }

  el('backBtn').addEventListener('click', goBack);

  // ---- Coin pill ------------------------------------------------------------
  function renderCoins(coins) {
    el('coinAmount').textContent = coins;
    Anim.bumpCoinPill();
  }

  function setUser(user) {
    State.user = user;
    renderCoins(user.coins);
  }

  // ---- Home -----------------------------------------------------------------
  document.querySelectorAll('.menu-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'find-player') openFindPlayer();
      if (action === 'play-friend') showScreen('friend');
      if (action === 'play-computer') startComputerGame();
      if (action === 'wallet') openWallet();
      if (action === 'leaderboard') openLeaderboard();
      if (action === 'spin-wheel') openSpin();
      if (action === 'guide') showScreen('guide');
      if (action === 'more-games') showScreen('moregames');
      if (action === 'open-rps') openMiniGame('rps', 'rps.js', 'RpsGame');
      if (action === 'open-2048') openMiniGame('2048', 'game2048.js', 'Game2048');
    });
  });

  // ---- Built-in mini games (Rock Paper Scissors / 2048) ----------------------
  // Each game's code lives in its own file and is only fetched the first time
  // its screen is opened (not listed in index.html's <script> tags at all) —
  // so home-screen load time is completely unaffected by these existing.
  // Every game talks back to the shell only through window.MiniApp (defined
  // at the bottom of this file), never by reaching into this closure.
  const loadedGameScripts = {};
  function loadGameScript(src) {
    if (loadedGameScripts[src]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { loadedGameScripts[src] = true; resolve(); };
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.appendChild(s);
    });
  }
  async function openMiniGame(screenName, scriptFile, globalName) {
    Api.haptic('light');
    try {
      await loadGameScript(scriptFile);
    } catch (err) {
      Anim.showToast('Could not load that game. Check your connection.');
      return;
    }
    showScreen(screenName);
    const game = window[globalName];
    if (game && typeof game.start === 'function') game.start();
  }


  // ---- Find Player ------------------------------------------------------------
  let searchDebounce = null;
  function openFindPlayer() {
    showScreen('find');
    el('playerResults').innerHTML = '';
    el('findEmptyState').hidden = false;
    el('playerSearchInput').value = '';
    el('playerSearchInput').focus();
  }

  el('playerSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    if (!q) {
      el('playerResults').innerHTML = '';
      el('findEmptyState').hidden = false;
      return;
    }
    searchDebounce = setTimeout(() => runPlayerSearch(q), 350);
  });
  el('playerSearchBtn').addEventListener('click', () => runPlayerSearch(el('playerSearchInput').value.trim()));

  async function runPlayerSearch(q) {
    if (!q) return;
    try {
      const { players } = await Api.searchPlayers(q);
      renderPlayerResults(players);
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  function renderPlayerResults(players) {
    const container = el('playerResults');
    container.innerHTML = '';
    el('findEmptyState').hidden = players.length > 0;
    if (!players.length) {
      el('findEmptyState').textContent = 'No players found.';
      el('findEmptyState').hidden = false;
      return;
    }

    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      const initial = (p.username || '?').charAt(0).toUpperCase();
      const canChallenge = State.user.coins >= 10;
      row.innerHTML = `
        <div class="avatar">${initial}${p.isOnline ? '<span class="online-dot"></span>' : ''}</div>
        <div class="player-info">
          <div class="name">@${p.username || 'player'} ${p.isOnline ? '<span class="online-label">Online</span>' : ''}</div>
          <div class="meta">${p.wins} wins · ${p.totalMatches} matches</div>
        </div>
        <button class="challenge-btn" ${canChallenge ? '' : 'disabled'}>Challenge</button>
      `;
      row.querySelector('.challenge-btn').addEventListener('click', () => sendChallenge(p));
      container.appendChild(row);
    });
  }

  async function sendChallenge(player) {
    if (State.user.coins < 10) {
      Anim.showToast('Minimum 10 coins required to play.');
      return;
    }
    try {
      Anim.showLoading(true);
      const { game } = await Api.createChallenge(player.telegramId);
      Anim.showLoading(false);
      openWaitingForAccept(game.id, player.username);
    } catch (err) {
      Anim.showLoading(false);
      Anim.showToast(err.message);
    }
  }

  // ---- Waiting for opponent (challenge sent, or Auto Match queued) -----------
  function openWaitingForAccept(gameId, opponentUsername) {
    openWaitingScreen(gameId, {
      text: `Waiting for @${opponentUsername || 'opponent'} to accept…`,
      cancellable: false,
    });
  }

  function openWaitingScreen(gameId, { text, cancellable }) {
    el('waitingText').textContent = text;
    el('waitingCancelBtn').hidden = !cancellable;
    // Auto Match (cancellable) gets the radar — it's actively looking for
    // whoever else queues up next. Waiting for a specific friend to accept
    // isn't "searching" for anyone, so it keeps the plain spinner.
    el('waitingRadar').hidden = !cancellable;
    el('waitingSpinner').hidden = cancellable;
    State.matchmakingGameId = cancellable ? gameId : null;
    showScreen('waiting');

    State.challengePollTimer = setInterval(async () => {
      try {
        const { game } = await Api.getGame(gameId);
        if (game.status === 'started') {
          stopChallengePolling();
          await refreshMe();
          enterPvpGame(gameId);
        } else if (['cancelled', 'expired'].includes(game.status)) {
          stopChallengePolling();
          Anim.showToast(cancellable ? 'No opponent found — try again.' : 'Challenge was not accepted.');
          showScreen('home', { replace: true });
        }
      } catch (err) {
        stopChallengePolling();
        Anim.showToast(err.message);
        showScreen('home', { replace: true });
      }
    }, 2000);
  }

  el('waitingCancelBtn').addEventListener('click', async () => {
    const gameId = State.matchmakingGameId;
    stopChallengePolling();
    if (gameId) {
      try { await Api.cancelMatchmaking(gameId); } catch (_) {}
    }
    State.matchmakingGameId = null;
    showScreen('home', { replace: true });
  });

  function stopChallengePolling() {
    if (State.challengePollTimer) {
      clearInterval(State.challengePollTimer);
      State.challengePollTimer = null;
    }
  }

  // ---- Auto Match: pair with whoever else is looking for a game right now ----
  el('autoMatchBtn').addEventListener('click', startAutoMatch);

  async function startAutoMatch() {
    if (State.user.coins < 10) {
      Anim.showToast('Minimum 10 coins required to play.');
      return;
    }
    try {
      Anim.showLoading(true);
      const { game, matched } = await Api.joinMatchmaking();
      Anim.showLoading(false);
      if (matched) {
        await refreshMe();
        enterPvpGame(game.id);
      } else {
        openWaitingScreen(game.id, { text: 'Searching for an opponent…', cancellable: true });
      }
    } catch (err) {
      Anim.showLoading(false);
      Anim.showToast(err.message);
    }
  }

  // ---- Incoming challenge modal -----------------------------------------------
  // Two game buttons instead of one Accept — whichever the challenged player
  // taps both accepts AND picks which game the match opens as.
  function showChallengeModal(gameId, challengerUsername) {
    el('challengeTitle').textContent = `@${challengerUsername || 'A player'} challenged you!`;
    el('challengeModal').hidden = false;

    const doAccept = async (gameType) => {
      el('challengeModal').hidden = true;
      try {
        Anim.showLoading(true);
        const { game } = await Api.acceptChallenge(gameId, gameType);
        Anim.showLoading(false);
        await refreshMe();
        if (game.status !== 'started') {
          Anim.showToast('Challenge could not start.');
          return;
        }
        if (game.gameType === 'rps') {
          enterPvpRps(gameId);
        } else {
          enterPvpGame(gameId);
        }
      } catch (err) {
        Anim.showLoading(false);
        Anim.showToast(err.message);
      }
    };

    el('challengeAcceptTttBtn').onclick = () => doAccept('tictactoe');
    el('challengeAcceptRpsBtn').onclick = () => doAccept('rps');

    el('challengeDeclineBtn').onclick = async () => {
      el('challengeModal').hidden = true;
      try {
        await Api.declineChallenge(gameId);
      } catch (_) {}
    };
  }

  // ---- PvP Rock Paper Scissors (real opponent, no coins at stake) -------------
  // Reuses the same #screen-rps + rps.js already built for solo play — only
  // the source of the opponent's move differs (a live poll against the game
  // room instead of the server picking a random bot move).
  async function enterPvpRps(gameId) {
    try {
      Anim.showLoading(true);
      const { game, player1, player2 } = await Api.getGame(gameId);
      const opp = game.youAre === 'player1' ? player2 : player1;
      await loadGameScript('rps.js');
      Anim.showLoading(false);
      showScreen('rps');
      window.RpsGame.startPvp(gameId, opp?.username ? '@' + opp.username : 'Opponent');
    } catch (err) {
      Anim.showLoading(false);
      Anim.showToast(err.message || 'Could not load Rock Paper Scissors.');
      showScreen('home', { replace: true });
    }
  }

  // ---- Wallet -----------------------------------------------------------------
  async function openWallet() {
    showScreen('wallet');
    try {
      const { user } = await Api.me();
      setUser(user);
      el('walletCoins').textContent = user.coins;
      el('walletMatches').textContent = user.totalMatches;
      el('walletWins').textContent = user.wins;
      el('walletLosses').textContent = user.losses;
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  // ---- Spin Wheel (unlocks at 1,00,000 coins) ---------------------------------
  // These must match the Worker's SPIN_MIN_BALANCE/SPIN_COST (spin.js) — they're
  // only used here for the eligibility copy before spinning; the server is the
  // one that actually enforces and charges this, never the client.
  const SPIN_MIN_BALANCE = 100000;
  const SPIN_COST = 99000;
  let spinBusy = false;

  async function openSpin() {
    showScreen('spin');
    el('spinStatus').textContent = 'Loading…';
    el('spinBtn').disabled = true;
    try {
      const { coins, canSpin, segments } = await Api.spinInfo();
      State.spinSegments = segments;
      if (State.user) State.user.coins = coins;
      renderCoins(coins);
      Anim.buildWheel(el('spinWheel'), segments);
      renderSpinEligibility(coins, canSpin);
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  function renderSpinEligibility(coins, canSpin) {
    const btn = el('spinBtn');
    if (canSpin) {
      el('spinStatus').textContent =
        `You have ${coins.toLocaleString()} coins. Spinning costs ${SPIN_COST.toLocaleString()} coins.`;
      btn.disabled = spinBusy;
      btn.textContent = `Spin (${SPIN_COST.toLocaleString()} coins)`;
    } else {
      const need = Math.max(0, SPIN_MIN_BALANCE - coins);
      el('spinStatus').textContent =
        `Reach ${SPIN_MIN_BALANCE.toLocaleString()} coins to unlock a spin — ${need.toLocaleString()} more to go. (You have ${coins.toLocaleString()})`;
      btn.disabled = true;
      btn.textContent = 'Spin';
    }
  }

  el('spinBtn').addEventListener('click', doSpin);
  async function doSpin() {
    if (spinBusy) return;
    if (!State.user || State.user.coins < SPIN_MIN_BALANCE) {
      Anim.showToast(`You need ${SPIN_MIN_BALANCE.toLocaleString()} coins to spin.`);
      return;
    }
    spinBusy = true;
    el('spinBtn').disabled = true;
    try {
      const { reward, coins, segments } = await Api.spin();
      State.spinSegments = segments;
      Anim.spinWheelTo(el('spinWheel'), segments, reward, () => {
        State.user.coins = coins;
        renderCoins(coins);
        renderSpinEligibility(coins, coins >= SPIN_MIN_BALANCE);
        showSpinResultModal(reward);
        spinBusy = false;
      });
    } catch (err) {
      spinBusy = false;
      el('spinBtn').disabled = !State.user || State.user.coins < SPIN_MIN_BALANCE;
      Anim.showToast(err.message);
    }
  }

  function showSpinResultModal(reward) {
    const isBlank = reward === 'Better luck next time';
    el('spinResultEmoji').textContent = isBlank ? '🙃' : '🎊';
    el('spinResultTitle').textContent = isBlank ? 'Better Luck Next Time' : `🎉 Congratulations! 🎉`;
    el('spinResultSub').innerHTML = isBlank
      ? 'No prize this time — keep playing to earn more coins and try again.'
      : `You won <b>${reward}</b>!<br>Our team will message you here to credit this shortly.`;
    el('spinResultModal').hidden = false;

    // A proper celebration for an actual prize — reuses the same
    // full-screen flying-emoji burst as in-game reactions, just layered
    // with a flower/confetti mix instead of a single emoji.
    if (!isBlank) {
      Anim.showReaction('🎉', 10);
      setTimeout(() => Anim.showReaction('🌸', 8), 180);
      setTimeout(() => Anim.showReaction('💐', 6), 320);
      setTimeout(() => Anim.showReaction('✨', 8), 460);
      Api.haptic('heavy');
    }
  }
  el('spinResultOkBtn').addEventListener('click', () => { el('spinResultModal').hidden = true; });

  // ---- Buy Coins (Telegram Stars) -----------------------------------------------
  el('buyCoinsBtn').addEventListener('click', openShop);

  async function openShop() {
    showScreen('shop');
    const list = el('shopPackages');
    list.innerHTML = '';
    try {
      const { packages } = await Api.getShopPackages();
      packages.forEach((pkg) => {
        const row = document.createElement('div');
        row.className = 'shop-pack';
        row.innerHTML = `
          <div class="pack-icon">💰</div>
          <div class="pack-info">
            <div class="pack-coins">${pkg.label}</div>
            <div class="pack-stars">⭐ ${pkg.stars} Telegram Stars</div>
          </div>
          <button class="pack-buy-btn">Buy</button>
        `;
        row.querySelector('.pack-buy-btn').addEventListener('click', (e) => buyPackage(pkg.id, e.target));
        list.appendChild(row);
      });
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  async function buyPackage(packageId, buttonEl) {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.openInvoice) {
      Anim.showToast('Please open this from Telegram to buy coins.');
      return;
    }
    buttonEl.disabled = true;
    try {
      const { invoiceLink } = await Api.createInvoice(packageId);
      tg.openInvoice(invoiceLink, async (status) => {
        buttonEl.disabled = false;
        if (status === 'paid') {
          await refreshMe();
          Anim.showToast('Payment successful — coins added!');
          Anim.bumpCoinPill();
        } else if (status === 'failed') {
          Anim.showToast('Payment failed. Please try again.');
        }
        // status === 'cancelled' or 'pending' — nothing to do, user just backed out.
      });
    } catch (err) {
      buttonEl.disabled = false;
      Anim.showToast(err.message);
    }
  }

  // ---- Leaderboard --------------------------------------------------------------
  async function openLeaderboard() {
    showScreen('leaderboard');
    const list = el('leaderboardList');
    list.innerHTML = '';
    try {
      const { leaderboard } = await Api.leaderboard();
      if (!leaderboard.length) {
        list.innerHTML = '<p class="empty-state">No players yet.</p>';
        return;
      }
      leaderboard.forEach((row) => {
        const div = document.createElement('div');
        div.className = 'leaderboard-row' + (row.rank <= 3 ? ` top${row.rank}` : '');
        div.innerHTML = `
          <div class="rank">${row.rank}</div>
          <div class="lb-name">@${row.username || 'player'}</div>
          <div class="lb-wins">${row.wins} wins</div>
        `;
        list.appendChild(div);
      });
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  // ---- Share invite (Play with Friend) -------------------------------------------
  el('shareInviteBtn').addEventListener('click', () => {
    const tg = window.Telegram && window.Telegram.WebApp;
    const botUsername = window.__BOT_USERNAME__ || '';
    const miniAppName = window.__MINIAPP_NAME__ || '';

    // Reverted back to the named-app link (bot username + app short name).
    // The bot-level link without an app name can't tell Telegram which Mini
    // App to launch for a bot set up the normal BotFather /newapp way, so
    // it doesn't reliably open the app — this form does, and is what was
    // actually confirmed working. A Telegram client old enough to not
    // support Mini Apps at all can't be helped by any link format — that's
    // a real platform floor, not something a different URL shape fixes.
    let url = 'https://t.me/';
    if (botUsername && miniAppName) {
      url = `https://t.me/${botUsername}/${miniAppName}?startapp=invite`;
    } else if (botUsername) {
      url = `https://t.me/${botUsername}`;
    }

    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('🎮 Play Tic Tac Toe with me!')}`;
    if (tg && tg.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, '_blank');
    }
  });

  // ---- Computer mode (100% local — no network calls at all) -----------------------
  function startComputerGame() {
    State.currentGame = {
      mode: 'computer',
      board: Game.emptyBoard(),
      myMark: 'X',
      computerMark: 'O',
      finished: false,
      // Decided once, right here, for the whole game — never per move (see
      // Game.bestMove). ~1 in 4 games run with a genuinely weak/random bot
      // so a reasonably careful human can actually win; the rest run the
      // real unbeatable minimax bot, where perfect play only ever draws.
      weakMode: Math.random() < Game.WEAK_GAME_CHANCE,
    };
    el('meName').textContent = 'You';
    el('oppName').textContent = 'Bot';
    el('meAvatar').textContent = 'X';
    el('oppAvatar').textContent = 'O';
    el('stakeNote').textContent = 'Practice mode — no coins at stake';
    resetBoardUI();
    showScreen('game');
    setTurnIndicator('Your turn');
  }

  function handleComputerCellTap(index) {
    const g = State.currentGame;
    if (g.finished || g.board[index]) return;
    g.board[index] = g.myMark;
    Anim.markCell(getCellEl(index), g.myMark);

    const evalResult = Game.evaluate(g.board);
    if (evalResult.winner || evalResult.isDraw) {
      finishComputerGame(evalResult);
      return;
    }

    setTurnIndicator("Bot's turn");
    // Was 500ms — felt instant/robotic since the move itself computes in a
    // few ms. A bit more "thinking" delay makes it feel like an actual
    // opponent rather than the board just snapping to the next state.
    setTimeout(() => {
      const move = Game.bestMove(g.board, g.computerMark, g.myMark, g.weakMode);
      g.board[move] = g.computerMark;
      Anim.markCell(getCellEl(move), g.computerMark);
      const evalResult2 = Game.evaluate(g.board);
      if (evalResult2.winner || evalResult2.isDraw) {
        finishComputerGame(evalResult2);
      } else {
        setTurnIndicator('Your turn');
      }
    }, 900);
  }

  async function finishComputerGame(evalResult) {
    const g = State.currentGame;
    g.finished = true;
    if (evalResult.line) Anim.highlightWin(getCellEls(), evalResult.line);

    let title, emoji;
    let sub = 'Practice mode';
    let coinChange = 0;

    if (evalResult.isDraw) {
      title = "It's a Draw!";
      emoji = '🤝';
    } else if (evalResult.winner === g.myMark) {
      title = 'You Win!';
      emoji = '🏆';
      // A real win pays real coins — the server re-checks the board and
      // enforces a daily cap, it never just trusts "I won" at face value.
      // This never touches wins/losses/leaderboard stats, only the wallet.
      try {
        const res = await Api.claimBotWin(g.board);
        if (res.awarded) {
          coinChange = res.reward;
          sub = `Practice mode · +${res.reward} coins today (${res.earnedToday}/${res.cap})`;
          if (State.user) State.user.coins = res.coins;
          renderCoins(res.coins);
        } else {
          sub = `Practice mode · Daily coin limit reached (${res.cap}) — resets tomorrow`;
        }
      } catch (_) {
        // Coin credit failing shouldn't block showing the win itself.
      }
    } else {
      title = 'Bot Wins';
      emoji = '🤖';
    }
    setTurnIndicator('');
    setTimeout(() => showResultModal({ title, emoji, sub, coinChange, canRematch: true }), 500);
  }

  // ---- PvP mode -------------------------------------------------------------------
  async function enterPvpGame(gameId) {
    try {
      Anim.showLoading(true);
      const { game, player1, player2 } = await Api.getGame(gameId);
      Anim.showLoading(false);

      const iAmP1 = game.youAre === 'player1';
      const myMark = iAmP1 ? 'X' : 'O';
      const oppMark = iAmP1 ? 'O' : 'X';
      const me = iAmP1 ? player1 : player2;
      const opp = iAmP1 ? player2 : player1;

      State.currentGame = {
        mode: 'pvp',
        gameId,
        myMark,
        oppMark,
        board: Game.emptyBoard(),
        turn: 'X', // placeholder only — who actually moves first is random and gets
        // corrected the instant the first poll comes back (see pollPvpState),
        // while the countdown/"Syncing…" overlay is still covering the board
        finished: false,
        status: 'in_progress',
        resultSubmitted: false,
        lastReactionTs: 0,
      };

      el('meName').textContent = me?.username ? '@' + me.username : 'You';
      el('oppName').textContent = opp?.username ? '@' + opp.username : 'Opponent';
      el('meAvatar').textContent = myMark;
      el('oppAvatar').textContent = oppMark;
      el('stakeNote').textContent = 'Staked: 10 coins each — winner takes 10';
      resetBoardUI();
      showScreen('game');

      Anim.runCountdown(() => {
        beginPvpPolling(gameId);
      });
    } catch (err) {
      Anim.showLoading(false);
      Anim.showToast(err.message);
      showScreen('home', { replace: true });
    }
  }

  function beginPvpPolling(gameId) {
    setTurnIndicator('Syncing…');
    hideConnectionWarning();
    document.querySelectorAll('.player-chip').forEach((c) => c.classList.remove('active-turn'));
    const timeoutRow = el('timeoutRow');
    if (timeoutRow) timeoutRow.hidden = true;
    State.pollInFlight = false;
    stopPolling();
    // 1.2s still shows the opponent's move almost instantly (our OWN moves
    // never wait on this poll at all — see the click handler below, so this
    // interval only affects how fast we notice what the other player just
    // did) while cutting D1 read volume by ~3.4x compared to the old 350ms —
    // important on the free plan once many matches run at once.
    State.pollTimer = setInterval(() => pollPvpState(gameId), 1200);
    pollPvpState(gameId); // immediate first tick
  }

  async function pollPvpState(gameId) {
    const g = State.currentGame;
    if (!g || g.finished) return;

    // On a slow connection a single poll can take longer than the 350ms
    // interval — without this guard the next tick would fire anyway and
    // requests would pile up faster than they resolve. Skip this tick
    // instead; the next one will pick up wherever the in-flight one left off.
    if (State.pollInFlight) return;
    State.pollInFlight = true;

    try {
      const state = await Api.getGameState(gameId);
      State.connIssueStreak = 0;
      hideConnectionWarning();
      const changed = JSON.stringify(state.board) !== JSON.stringify(g.board);
      g.board = state.board;
      if (changed) renderBoard();
      applyTurnState(g, state.turn);
      g.turnStartedAt = state.turnStartedAt;
      g.moveCount = state.moveCount || 0;
      g.timeoutMs = state.timeoutMs;
      updateTimeoutUI(g);

      // Opponent's reaction arrives here (our own is already shown
      // optimistically the instant we tap it — see sendReaction()).
      if (state.reaction && state.reaction.ts > (g.lastReactionTs || 0)) {
        g.lastReactionTs = state.reaction.ts;
        if (!g.suppressReactionTs || g.suppressReactionTs !== state.reaction.ts) {
          Anim.showReaction(state.reaction.emoji);
        }
      }

      const evalResult = Game.evaluate(state.board);
      if (evalResult.winner || evalResult.isDraw) {
        stopPolling();
        g.finished = true;
        if (evalResult.line) Anim.highlightWin(getCellEls(), evalResult.line);
        await settlePvpResult(evalResult, g);
      }
    } catch (err) {
      const isConnIssue = /Network error|timed out/i.test(err.message || '');

      if (isConnIssue) {
        // A genuine slow/dropped connection, not a real API error — don't
        // also fire the getGame() fallback below (it would likely time out
        // too, on the same bad connection, doubling the wait for nothing).
        // Just surface it after a few misses in a row and retry next tick.
        State.connIssueStreak = (State.connIssueStreak || 0) + 1;
        if (State.connIssueStreak >= 3) showConnectionWarning();
      } else if (!g.finished) {
        // The state endpoint stops accepting requests once the game leaves
        // 'started' — that's our signal that the match ended some other way
        // (most likely: the opponent quit/forfeited). Check D1 for the
        // authoritative outcome rather than just retrying forever.
        try {
          const { game } = await Api.getGame(gameId);
          if (game.status === 'completed') {
            stopPolling();
            g.finished = true;
            const myId = g.myMark === 'X' ? game.player1Id : game.player2Id;
            const iWon = !!game.winnerId && game.winnerId === myId;
            const draw = !game.winnerId;
            await refreshMe();
            showResultModal({
              title: draw ? "It's a Draw!" : iWon ? 'Opponent Quit — You Win!' : 'You Lose',
              emoji: draw ? '🤝' : iWon ? '🏆' : '😔',
              sub: draw ? 'Ranked match' : iWon ? 'Your opponent forfeited' : 'Ranked match',
              coinChange: draw ? 0 : iWon ? 10 : -10,
              canRematch: false,
            });
          } else if (['expired', 'cancelled'].includes(game.status)) {
            stopPolling();
            g.finished = true;
            Anim.showToast('Match ended — no coins lost.');
            showScreen('home', { replace: true });
          }
        } catch (_) {
          // Transient network hiccup on the fallback check itself — just retry next tick.
        }
      }
    } finally {
      State.pollInFlight = false;
    }
  }

  function showConnectionWarning() {
    const banner = el('connBanner');
    if (banner) banner.hidden = false;
  }
  function hideConnectionWarning() {
    State.connIssueStreak = 0;
    const banner = el('connBanner');
    if (banner) banner.hidden = true;
  }

  async function settlePvpResult(evalResult, g) {
    if (g.resultSubmitted) return;
    g.resultSubmitted = true;

    let myClaim;
    if (evalResult.isDraw) myClaim = 'draw';
    else if (evalResult.winner === g.myMark) myClaim = 'win';
    else myClaim = 'loss';
    g.lastClaim = myClaim;

    setTurnIndicator('');
    try {
      const res = await Api.submitResult(g.gameId, myClaim);
      await refreshMe();

      if (res.status === 'waiting_for_opponent') {
        showResultModal({
          title: myClaim === 'win' ? 'You Win!' : myClaim === 'loss' ? 'You Lose' : "It's a Draw!",
          emoji: myClaim === 'win' ? '🏆' : myClaim === 'loss' ? '😔' : '🤝',
          sub: 'Confirming with opponent…',
          coinChange: null,
          canRematch: false,
        });
        // Poll briefly for the opponent's confirmation to update the coin amount.
        pollForSettlement(g.gameId);
        return;
      }

      renderSettledResult(res, g);
    } catch (err) {
      Anim.showToast(err.message);
    }
  }

  function pollForSettlement(gameId) {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        const { game } = await Api.getGame(gameId);
        if (game.status === 'completed') {
          clearInterval(timer);
          renderSettledResult({ status: 'completed', winnerId: game.winnerId }, State.currentGame);
          await refreshMe();
        }
      } catch (_) {}
      if (attempts > 15) clearInterval(timer); // ~30s safety cutoff
    }, 2000);
  }

  // `res` is the backend's authoritative settlement outcome; `g.lastClaim`
  // is only used to phrase the message (win/loss/draw), never to decide
  // whether coins moved — that's always driven by what the server settled.
  function renderSettledResult(res, g) {
    let title, emoji, coinChange;
    if (res.status === 'voided') {
      title = 'Match Voided';
      emoji = '⚠️';
      coinChange = 0;
      Anim.showToast(res.reason || 'Results did not match — refunded.');
    } else if (!res.winnerId) {
      title = "It's a Draw!";
      emoji = '🤝';
      coinChange = 0;
    } else if (g.lastClaim === 'win') {
      title = 'You Win!';
      emoji = '🏆';
      coinChange = 10;
    } else {
      title = 'You Lose';
      emoji = '😔';
      coinChange = -10;
    }
    showResultModal({ title, emoji, sub: 'Ranked match', coinChange, canRematch: false });
  }

  function setTurnIndicator(text) {
    el('turnIndicator').textContent = text;
  }

  // Updates the board's turn state + indicator, and — this is the bit that
  // makes it obvious whose move it is — fires a haptic buzz and a brief
  // glow/pop animation on the indicator the moment it becomes YOUR turn
  // (never on the moment it becomes the opponent's, so it doesn't buzz
  // right after your own tap).
  function applyTurnState(g, newTurn) {
    const wasMyTurn = g.turn === g.myMark;
    g.turn = newTurn;
    const isMyTurn = newTurn === g.myMark;

    const indicatorEl = el('turnIndicator');
    indicatorEl.textContent = isMyTurn ? 'Your turn' : "Opponent's turn";
    indicatorEl.classList.toggle('my-turn', isMyTurn);
    indicatorEl.classList.toggle('opp-turn', !isMyTurn);

    if (isMyTurn && !wasMyTurn) {
      Api.haptic('medium');
      indicatorEl.classList.remove('turn-pop');
      // Force reflow so the animation can replay even if the class was
      // already removed+added in the same tick.
      void indicatorEl.offsetWidth;
      indicatorEl.classList.add('turn-pop');
    }

    const boardWrap = el('boardWrap');
    if (boardWrap) boardWrap.classList.toggle('waiting-turn', !isMyTurn);

    // Glow whichever avatar's turn it actually is — a second, always-visible
    // cue alongside the text indicator (handy for glancing mid-game without
    // reading text). Only meaningful for PvP; computer mode doesn't call this.
    const meChip = document.querySelector('.player-chip.me');
    const oppChip = document.querySelector('.player-chip.opp');
    if (meChip) meChip.classList.toggle('active-turn', isMyTurn);
    if (oppChip) oppChip.classList.toggle('active-turn', !isMyTurn);
  }

  // Live countdown for the "opponent inactive" timeout, shown to BOTH
  // players so nobody is surprised when the Leave/Claim Win option appears.
  // While the timer is still running it just informs; once it hits 0 the
  // WAITING player (not the one on turn) gets the actionable button.
  function updateTimeoutUI(g) {
    const row = el('timeoutRow');
    const text = el('timeoutText');
    const btn = el('timeoutBtn');
    if (!row || !text || !btn) return;

    if (!g || g.finished || g.mode === 'computer' || !g.timeoutMs) {
      row.hidden = true;
      btn.hidden = true;
      return;
    }

    const isMyTurn = g.turn === g.myMark;
    const elapsed = Date.now() - (g.turnStartedAt || Date.now());
    const remaining = Math.max(0, Math.ceil((g.timeoutMs - elapsed) / 1000));

    row.hidden = false;

    if (remaining > 0) {
      text.textContent = isMyTurn
        ? `Move within ${remaining}s or your opponent can leave`
        : `Opponent has ${remaining}s to move`;
      btn.hidden = true;
      return;
    }

    if (isMyTurn) {
      text.textContent = "Time's up — your opponent can leave now";
      btn.hidden = true;
      return;
    }

    const bothEngaged = (g.moveCount || 0) >= 2;
    text.textContent = bothEngaged
      ? 'Opponent inactive — you can claim the win'
      : "Opponent hasn't shown up — you can leave, no coins lost";
    btn.textContent = bothEngaged ? 'Claim Win' : 'Leave';
    btn.hidden = false;
  }

  el('timeoutBtn').addEventListener('click', async () => {
    const g = State.currentGame;
    if (!g || g.finished) return;

    g.finished = true;
    stopPolling();
    try {
      Anim.showLoading(true);
      const res = await Api.claimTimeout(g.gameId);
      Anim.showLoading(false);
      await refreshMe();
      if (res.outcome === 'won') {
        showResultModal({
          title: 'Opponent Inactive — You Win!',
          emoji: '🏆',
          sub: 'Opponent went idle mid-match',
          coinChange: 10,
          canRematch: false,
        });
      } else {
        showResultModal({
          title: 'Match Cancelled',
          emoji: '🚫',
          sub: "Opponent never showed up — no coins lost",
          coinChange: 0,
          canRematch: false,
        });
      }
    } catch (err) {
      g.finished = false;
      Anim.showLoading(false);
      Anim.showToast(err.message);
      beginPvpPolling(g.gameId); // resume — the timeout claim was rejected (too early / already ended)
    }
  });

  function stopPolling() {
    if (State.pollTimer) {
      clearInterval(State.pollTimer);
      State.pollTimer = null;
    }
    State.pollInFlight = false;
    hideConnectionWarning();
  }

  // ---- Board rendering + input ------------------------------------------------------
  function getCellEls() {
    return Array.from(document.querySelectorAll('#board .cell'));
  }
  function getCellEl(i) {
    return document.querySelector(`#board .cell[data-index="${i}"]`);
  }

  // Diffs the DOM against g.board and only touches cells that actually
  // changed — this is what makes placing a move feel snappy instead of
  // janky. The old version cleared + replayed the pop-in animation (and
  // fired a haptic buzz) for EVERY already-filled cell on every single
  // update, which is why marks placed turns ago would visibly "jump" again
  // each time a poll tick or a new move touched the board at all.
  function renderBoard() {
    const g = State.currentGame;
    const cells = getCellEls();
    if (!g) {
      Anim.clearBoardAnimations(cells);
      return;
    }
    g.board.forEach((mark, i) => {
      const cellEl = cells[i];
      const isFilled = cellEl.classList.contains('filled');
      if (mark && !isFilled) {
        Anim.markCell(cellEl, mark);
      } else if (!mark && isFilled) {
        cellEl.textContent = '';
        cellEl.className = 'cell';
      }
    });
  }

  /** Full wipe — only for the moment a fresh match actually starts, since
   * the board's cell elements are reused across matches and may still carry
   * classes (filled/win-cell) from whatever game played before this one. */
  function resetBoardUI() {
    Anim.clearBoardAnimations(getCellEls());
  }

  getCellEls().forEach((cellEl) => {
    cellEl.addEventListener('click', () => {
      const g = State.currentGame;
      if (!g || g.finished) return;
      const index = Number(cellEl.dataset.index);
      if (g.board[index]) return;

      if (g.mode === 'computer') {
        handleComputerCellTap(index);
      } else if (g.mode === 'pvp') {
        handlePvpCellTap(g, index);
      }
    });
  });

  // Optimistic PvP move: mark the cell and flip the turn indicator to
  // "Opponent's turn" the INSTANT you tap, instead of waiting for the next
  // poll tick to echo your own move back — that round trip is what made
  // taps feel laggy. We still send the move to the server and reconcile
  // with whatever it actually confirms (reverting cleanly if it's rejected,
  // e.g. a stale board from a race with the opponent).
  function handlePvpCellTap(g, index) {
    if (g.turn !== g.myMark) {
      Anim.showToast("Wait for your turn");
      Api.haptic('light');
      return;
    }

    const cellEl = getCellEl(index);
    g.board[index] = g.myMark;
    if (cellEl) Anim.markCell(cellEl, g.myMark);
    applyTurnState(g, g.oppMark);

    Api.postMove(g.gameId, index)
      .then((state) => {
        // Reconcile with the server's authoritative state — normally a
        // no-op since it matches what we already rendered, but this keeps
        // us correct if anything raced.
        if (!g.finished) {
          const changed = JSON.stringify(state.board) !== JSON.stringify(g.board);
          g.board = state.board;
          if (changed) renderBoard();
          applyTurnState(g, state.turn);
        }
      })
      .catch((err) => {
        // Rejected (not our turn after all / cell filled by a race) — undo
        // the optimistic mark and let the next poll pull the real state.
        g.board[index] = null;
        renderBoard();
        Anim.showToast(err.message);
      });
  }

  // ---- Reactions (client-side only relay — never stored in D1) --------------------
  document.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = State.currentGame;
      if (!g || g.finished) return;
      const emoji = btn.dataset.emoji;

      // Show it immediately for the sender — no need to wait on a round trip.
      Anim.showReaction(emoji);
      Api.haptic('light');

      if (g.mode === 'pvp') {
        Api.sendReaction(g.gameId, emoji)
          .then((state) => {
            // Remember this reaction's timestamp so our own next poll tick
            // doesn't show it a second time.
            if (state.reaction) {
              g.suppressReactionTs = state.reaction.ts;
              g.lastReactionTs = state.reaction.ts;
            }
          })
          .catch(() => {}); // a missed reaction is never worth interrupting the match for
      }
      // Computer mode: purely local, nothing to send anywhere.
    });
  });

  // ---- Quit / Forfeit --------------------------------------------------------------
  function confirmDialog(message) {
    return new Promise((resolve) => {
      const tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.showConfirm) {
        tg.showConfirm(message, (ok) => resolve(!!ok));
      } else {
        resolve(window.confirm(message));
      }
    });
  }

  el('quitBtn').addEventListener('click', async () => {
    const g = State.currentGame;
    if (!g || g.finished) return;

    if (g.mode === 'computer') {
      const ok = await confirmDialog('Quit this practice match?');
      if (!ok) return;
      g.finished = true;
      State.currentGame = null;
      showScreen('home', { replace: true });
      return;
    }

    // Nobody has played a move yet — the 10-coin entry fee is only taken
    // once the first real move is made, so quitting now costs nothing.
    const noMoveYet = Array.isArray(g.board) && g.board.every((c) => !c);
    const confirmMsg = noMoveYet
      ? 'Cancel this match? No one has played yet, so no coins will be lost.'
      : 'Quit now? Your 10 coins go to your opponent and this counts as a loss.';
    const ok = await confirmDialog(confirmMsg);
    if (!ok) return;

    g.finished = true;
    stopPolling();
    try {
      Anim.showLoading(true);
      const res = await Api.forfeitGame(g.gameId);
      Anim.showLoading(false);
      await refreshMe();
      if (res && res.noFaultCancel) {
        showResultModal({
          title: 'Match Cancelled',
          emoji: '🚫',
          sub: 'No one played — no coins lost',
          coinChange: 0,
          canRematch: false,
        });
      } else {
        showResultModal({
          title: 'You Quit',
          emoji: '🚩',
          sub: 'You forfeited the match',
          coinChange: -10,
          canRematch: false,
        });
      }
    } catch (err) {
      Anim.showLoading(false);
      Anim.showToast(err.message);
      showScreen('home', { replace: true });
    }
  });

  // ---- Result modal -------------------------------------------------------------------
  function showResultModal({ title, emoji, sub, coinChange, canRematch }) {
    const timeoutRow = el('timeoutRow');
    if (timeoutRow) timeoutRow.hidden = true;
    el('resultTitle').textContent = title;
    el('resultEmoji').textContent = emoji;
    el('resultSub').textContent = sub || '';
    if (coinChange === null || coinChange === undefined) {
      el('coinChange').hidden = true;
    } else {
      Anim.showCoinChange(coinChange);
    }
    el('resultPlayAgainBtn').style.display = canRematch ? 'block' : 'none';
    el('resultModal').hidden = false;
  }

  el('resultPlayAgainBtn').addEventListener('click', () => {
    el('resultModal').hidden = true;
    if (State.currentGame && State.currentGame.mode === 'computer') {
      startComputerGame();
    } else {
      showScreen('home', { replace: true });
    }
  });
  el('resultHomeBtn').addEventListener('click', () => {
    el('resultModal').hidden = true;
    State.currentGame = null;
    showScreen('home', { replace: true });
  });

  // ---- Bootstrapping ------------------------------------------------------------------
  async function refreshMe() {
    const { user, pendingChallenge } = await Api.me();
    setUser(user);
    if (pendingChallenge && (!State.currentGame || State.currentGame.finished)) {
      showChallengeModal(pendingChallenge.gameId, pendingChallenge.challengerUsername);
    }
  }

  async function init() {
    Anim.showLoading(true);
    Api.init();
    try {
      const { user, startParam } = await Api.auth();
      setUser(user);
      showScreen('home', { replace: true });

      if (startParam === 'playbot') {
        // Deep link from the group "Beat The Bot" taunt message (see
        // telegram.js's maybeReactToKeyword) — drop straight into a Bot
        // match instead of the home screen.
        await refreshMe();
        startComputerGame();
      } else if (startParam === 'playrps') {
        // Deep link from the bot's /play command — drop straight into solo
        // Rock Paper Scissors instead of the home screen.
        await refreshMe();
        openMiniGame('rps', 'rps.js', 'RpsGame');
      } else if (startParam) {
        try {
          const { game } = await Api.getGame(startParam);
          if (game.status === 'pending' && game.youAre === 'player2') {
            const { pendingChallenge } = await Api.me();
            showChallengeModal(startParam, pendingChallenge?.challengerUsername);
          } else if (game.status === 'started') {
            if (game.gameType === 'rps') enterPvpRps(startParam);
            else enterPvpGame(startParam);
          }
        } catch (_) {
          // Unknown/expired start param — ignore, just show home.
        }
      } else {
        await refreshMe();
      }
    } catch (err) {
      Anim.showToast(err.message || 'Could not sign in. Please reopen from Telegram.');
    } finally {
      Anim.showLoading(false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  // ---- Shared full-screen win/lose overlay for the mini games ---------------
  // Owned here (not by rps.js/game2048.js individually) because both games
  // share the same #miniResultOverlay markup — wiring its buttons once, in a
  // file that's always loaded, avoids any game double-binding them.
  let miniResultOnClose = null;
  let miniResultOnReplay = null;
  let miniReplayTimer = null;

  function clearMiniReplayTimer() {
    if (miniReplayTimer) {
      clearInterval(miniReplayTimer);
      miniReplayTimer = null;
    }
  }

  el('miniResultCloseBtn').addEventListener('click', () => {
    el('miniResultOverlay').hidden = true;
    const cb = miniResultOnClose;
    miniResultOnClose = null;
    if (cb) cb();
  });

  // Replay has a hard 5-second window (see showMiniResult below) — after it
  // disables itself, only Home works. Used by Rock Paper Scissors (both solo
  // vs Bot and real PvP — identical behavior either way, per spec).
  el('miniResultReplayBtn').addEventListener('click', () => {
    if (!miniResultOnReplay) return;
    clearMiniReplayTimer();
    el('miniResultOverlay').hidden = true;
    const cb = miniResultOnReplay;
    miniResultOnReplay = null;
    cb();
  });

  el('miniResultHomeBtn').addEventListener('click', () => {
    clearMiniReplayTimer();
    miniResultOnReplay = null;
    el('miniResultOverlay').hidden = true;
    // Stop RPS's background "did the opponent replay?" watch poll, if any —
    // otherwise it would keep quietly polling the game room after leaving.
    if (window.RpsGame && typeof window.RpsGame.stopPvp === 'function') window.RpsGame.stopPvp();
    showScreen('home', { replace: true });
  });

  // ---- Bridge for the lazy-loaded mini games (rps.js / game2048.js) --
  // Those files are plain, separately-loaded <script>s (not modules), so they
  // can't reach into this IIFE's closure directly — this is the only door in.
  window.MiniApp = {
    goHome: () => showScreen('home', { replace: true }),
    haptic: (style) => Api.haptic(style),
    toast: (msg) => Anim.showToast(msg),
    // Called by a game right after the server confirms a coin credit, so the
    // top coin pill updates immediately without a full /api/me refetch.
    updateCoins: (coins) => {
      if (State.user) State.user.coins = coins;
      renderCoins(coins);
    },
    // For flows where the SERVER moved coins without the client sending the
    // move itself (e.g. RPS PvP's per-round stake, settled entirely inside
    // the game room) — re-fetches the authoritative balance instead of
    // trying to compute it locally.
    refreshCoins: async () => {
      try {
        const { user } = await Api.me();
        if (State.user) State.user.coins = user.coins;
        renderCoins(user.coins);
      } catch (_) {}
    },
    // The signed-in player's own telegram id — rps.js (PvP mode) needs this
    // to tell whether a settled round's winnerId is "me" or "the opponent".
    get myTelegramId() {
      return State.user ? State.user.telegramId : null;
    },
    // Force-closes the overlay without firing any callback — used by RPS's
    // PvP mode when it detects the OPPONENT already replayed first, so this
    // player's dead result screen closes on its own and joins the new round.
    closeMiniResult() {
      clearMiniReplayTimer();
      miniResultOnReplay = null;
      miniResultOnClose = null;
      el('miniResultOverlay').hidden = true;
    },
    // Full-screen win/lose celebration shared by every mini game.
    // { win, emoji, title, sub, coinText, coinPositive, onClose, onReplay, replaySeconds, autoReplayOnTimeout }
    // Pass `onClose` for the plain single "Continue" button (used by 2048).
    // Pass `onReplay` instead for the Replay(Ns)+Home two-button flow (used
    // by Rock Paper Scissors, solo AND PvP alike). `autoReplayOnTimeout: true`
    // (solo vs Bot only) means: if the countdown runs out with no tap, just
    // fire the replay callback anyway instead of disabling it — there's no
    // opponent to leave hanging, so there's no reason to force Home. PvP
    // leaves this false (default): once time's up, only Home works, since
    // auto-continuing without the other real player's consent would be odd.
    showMiniResult({ win, emoji, title, sub, coinText, coinPositive, onClose, onReplay, replaySeconds = 5, autoReplayOnTimeout = false }) {
      el('miniResultEmoji').textContent = emoji;
      el('miniResultTitle').textContent = title;
      el('miniResultSub').textContent = sub || '';
      const coinEl = el('miniResultCoin');
      if (coinText) {
        coinEl.hidden = false;
        coinEl.textContent = coinText;
        coinEl.className = 'coin-change ' + (coinPositive ? 'positive' : 'negative');
      } else {
        coinEl.hidden = true;
      }
      const card = el('miniResultCard');
      card.classList.remove('shake-lose');
      void card.offsetWidth;
      if (win) {
        Anim.showReaction('🎉', 14);
        Anim.showReaction('🌸', 10);
      } else {
        card.classList.add('shake-lose');
      }

      clearMiniReplayTimer();
      const closeBtn = el('miniResultCloseBtn');
      const replayBtn = el('miniResultReplayBtn');
      const homeBtn = el('miniResultHomeBtn');

      if (onReplay) {
        closeBtn.hidden = true;
        replayBtn.hidden = false;
        homeBtn.hidden = false;
        replayBtn.disabled = false;
        miniResultOnClose = null;
        miniResultOnReplay = onReplay;

        let secs = replaySeconds;
        replayBtn.textContent = `🔁 Replay (${secs}s)`;
        miniReplayTimer = setInterval(() => {
          secs -= 1;
          if (secs <= 0) {
            clearMiniReplayTimer();
            if (autoReplayOnTimeout) {
              const cb = miniResultOnReplay;
              miniResultOnReplay = null;
              el('miniResultOverlay').hidden = true;
              if (cb) cb();
            } else {
              replayBtn.disabled = true;
              replayBtn.textContent = '🔁 Replay';
              miniResultOnReplay = null;
            }
          } else {
            replayBtn.textContent = `🔁 Replay (${secs}s)`;
          }
        }, 1000);
      } else {
        closeBtn.hidden = false;
        replayBtn.hidden = true;
        homeBtn.hidden = true;
        miniResultOnReplay = null;
        miniResultOnClose = onClose || null;
      }

      el('miniResultOverlay').hidden = false;
    },
  };
})();
