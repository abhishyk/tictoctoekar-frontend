// Rock Paper Scissors — solo (vs Bot, +1 coin on win) AND real PvP (via a
// /challenge, no coins at stake — see games.js/gameRoom.js). Both modes
// share this one screen/DOM; only where the opponent's move comes from
// differs (server-picked random bot vs a live poll against the shared
// GameRoom Durable Object).
window.RpsGame = (function () {
  const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
  const BOT_NAMES = ['Rocky', 'Ninja', 'Shadow', 'Blitz', 'Titan', 'Volt', 'Ghost', 'Ace', 'Maverick', 'Chief'];
  const PICK_SECONDS = 10;

  let mode = 'solo'; // 'solo' | 'pvp'
  let busy = false;
  let wired = false;
  let pickTimer = null;
  let pickSecondsLeft = 0;
  let pvp = null; // { gameId, oppName, round, pollTimer }
  let pvpRevealing = false;

  function el(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function resetTable() {
    const botEl = el('rpsBotEmoji'), meEl = el('rpsPlayerEmoji');
    botEl.textContent = '🤖'; meEl.textContent = '🧑';
    botEl.classList.remove('reveal-pop', 'rps-emoji-hidden');
    meEl.classList.remove('reveal-pop', 'rps-emoji-hidden');
  }

  function wireOnce() {
    if (wired) return;
    wired = true;
    el('rpsStartBtn').addEventListener('click', startRound);
    document.querySelectorAll('.rps-choice-btn').forEach((btn) => {
      // Native `disabled` attribute (see index.html) already stops a click
      // from firing at all while disabled, so no extra guard is needed here.
      btn.addEventListener('click', () => play(btn.dataset.choice));
    });
  }

  // The buttons are disabled via the native `disabled` attribute/property
  // (index.html has them start out disabled), not a CSS class.
  function setChoicesEnabled(enabled) {
    document.querySelectorAll('.rps-choice-btn').forEach((btn) => { btn.disabled = !enabled; });
  }

  function clearPickTimer() {
    if (pickTimer) { clearInterval(pickTimer); pickTimer = null; }
  }

  function stopPvpPoll() {
    if (pvp && pvp.pollTimer) { clearInterval(pvp.pollTimer); pvp.pollTimer = null; }
  }

  // ---- Entry points -----------------------------------------------------
  function start() {
    mode = 'solo';
    pvp = null;
    stopPvpPoll();
    busy = false;
    clearPickTimer();
    resetTable();
    el('rpsCapNote').textContent = '';
    el('rpsResult').textContent = 'Tap Start Round';
    el('rpsStartBtn').hidden = false;
    el('rpsChoices').hidden = true;
    el('rpsBotLabel').textContent = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    wireOnce();
  }

  // Called by app.js once a challenge has been accepted as Rock Paper
  // Scissors — real opponent, no coins at stake.
  function startPvp(gameId, oppName) {
    mode = 'pvp';
    pvp = { gameId, oppName, round: 0 };
    busy = false;
    pvpRevealing = false;
    clearPickTimer();
    resetTable();
    el('rpsCapNote').textContent = 'Real match — 1 coin per round, loser pays winner';
    el('rpsStartBtn').hidden = true;
    el('rpsBotLabel').textContent = oppName || 'Opponent';
    wireOnce();
    beginPvpRound();
  }

  // ---- Solo (vs computer) ------------------------------------------------
  function startPickTimer(onTimeout) {
    pickSecondsLeft = PICK_SECONDS;
    el('rpsResult').textContent = `Choose now! (${pickSecondsLeft}s)`;
    pickTimer = setInterval(() => {
      pickSecondsLeft -= 1;
      if (pickSecondsLeft <= 0) { clearPickTimer(); onTimeout(); }
      else el('rpsResult').textContent = `Choose now! (${pickSecondsLeft}s)`;
    }, 1000);
  }

  function onPickTimeout() {
    setChoicesEnabled(false);
    window.MiniApp.toast("Time's up — round cancelled.");
    el('rpsResult').textContent = "Time's up! Tap Start Round to try again.";
    el('rpsChoices').hidden = true;
    el('rpsStartBtn').hidden = false;
    resetTable();
    busy = false;
  }

  function startRound() {
    if (mode !== 'solo' || busy) return;
    busy = true;
    el('rpsStartBtn').hidden = true;
    resetTable();
    el('rpsBotEmoji').classList.add('rps-emoji-hidden');
    el('rpsPlayerEmoji').classList.add('rps-emoji-hidden');
    el('rpsChoices').hidden = false;
    setChoicesEnabled(false);
    el('rpsResult').textContent = 'Get ready…';
    Anim.runCountdown(() => {
      setChoicesEnabled(true);
      busy = false;
      startPickTimer(onPickTimeout);
    });
  }

  async function play(choice) {
    if (mode === 'pvp') return playPvp(choice);
    if (busy) return;
    busy = true;
    clearPickTimer();
    window.MiniApp.haptic('medium');
    setChoicesEnabled(false);
    el('rpsResult').textContent = 'Rock… Paper… Scissors…!';
    let res;
    try {
      [res] = await Promise.all([Api.playRps(choice), sleep(650)]);
    } catch (err) {
      el('rpsResult').textContent = 'Something went wrong — try again.';
      window.MiniApp.toast(err.message || 'Network error');
      el('rpsStartBtn').hidden = false;
      el('rpsChoices').hidden = true;
      resetTable();
      busy = false;
      return;
    }
    await revealAndShow(choice, res.botChoice);
    showSoloResult(res);
    busy = false;
  }

  async function revealAndShow(myChoice, oppChoice) {
    const meEl = el('rpsPlayerEmoji'), botEl = el('rpsBotEmoji');
    meEl.classList.remove('rps-emoji-hidden');
    botEl.classList.remove('rps-emoji-hidden');
    meEl.textContent = EMOJI[myChoice] || '❔';
    botEl.textContent = EMOJI[oppChoice] || '❔';
    meEl.classList.add('reveal-pop');
    botEl.classList.add('reveal-pop');
    await sleep(1100);
  }

  // Every outcome (win/loss/draw) shows the shared Replay(5s)+Home overlay
  // instead of a plain Continue button. Solo mode passes
  // autoReplayOnTimeout: true — there's no opponent to leave hanging here,
  // so if the 5s countdown runs out without a tap, it just quietly starts
  // the next round with the Bot instead of forcing the player to Home.
  function showSoloResult(res) {
    const botName = el('rpsBotLabel').textContent;
    const replay = () => startRound();

    if (res.result === 'draw') {
      window.MiniApp.showMiniResult({
        win: false, emoji: '🤝', title: "It's a Draw!",
        sub: `You and ${botName} picked the same move.`, coinText: '',
        onReplay: replay, autoReplayOnTimeout: true,
      });
      return;
    }
    if (res.result === 'win') {
      window.MiniApp.showMiniResult({
        win: true, emoji: '🎉', title: 'You Win!',
        sub: `Great move — you beat ${botName}.`,
        coinText: res.awarded ? `+${res.reward} coin` : 'Daily coin limit reached',
        coinPositive: res.awarded, onReplay: replay, autoReplayOnTimeout: true,
      });
      if (res.awarded) window.MiniApp.updateCoins(res.coins);
    } else {
      window.MiniApp.showMiniResult({
        win: false, emoji: '😢', title: 'You Lost',
        sub: `${botName} got you this time — go again!`, coinText: '',
        onReplay: replay, autoReplayOnTimeout: true,
      });
    }
  }

  // ---- PvP (real opponent) ------------------------------------------------
  function beginPvpRound() {
    resetTable();
    el('rpsBotEmoji').classList.add('rps-emoji-hidden');
    el('rpsPlayerEmoji').classList.add('rps-emoji-hidden');
    el('rpsChoices').hidden = false;
    setChoicesEnabled(false);
    busy = false;
    pvpRevealing = false;
    el('rpsResult').textContent = 'Get ready…';
    stopPvpPoll();
    // Keep polling through the countdown too — if the opponent already
    // picked (or replayed) while we were mid-animation, we don't want to
    // miss it once choices actually unlock.
    pvp.pollTimer = setInterval(pollPvp, 1200);
    // Same "1, 2, 3, Go!" beat solo mode uses (Anim.runCountdown) — this was
    // missing here entirely before, which is why PvP skipped straight to
    // enabled buttons with no countdown.
    Anim.runCountdown(() => {
      setChoicesEnabled(true);
      el('rpsResult').textContent = 'Choose your move…';
    });
  }

  // The Worker proxies every game-room call through a check that the match
  // is still `status: 'started'` (see proxyToGameRoom in index.js) — once
  // the opponent has left (see stopPvp()'s leaveRpsMatch call), that check
  // starts failing with this exact message, which is how we tell "match
  // ended" apart from an ordinary network blip.
  function isMatchEndedError(err) {
    return /not active/i.test((err && err.message) || '');
  }

  function handleOpponentLeft() {
    stopPvpPoll();
    pvp = null;
    window.MiniApp.toast('Opponent left the match.');
    window.MiniApp.goHome();
  }

  async function playPvp(choice) {
    if (busy) return;
    busy = true;
    setChoicesEnabled(false);
    window.MiniApp.haptic('medium');
    el('rpsResult').textContent = 'Waiting for opponent…';
    try {
      const state = await Api.pvpRpsPick(pvp.gameId, choice);
      await handlePvpState(state);
    } catch (err) {
      if (isMatchEndedError(err)) { handleOpponentLeft(); return; }
      window.MiniApp.toast(err.message || 'Network error');
      setChoicesEnabled(true);
      busy = false;
    }
  }

  async function pollPvp() {
    if (!pvp) return;
    try {
      const state = await Api.getGameState(pvp.gameId);
      await handlePvpState(state);
    } catch (err) {
      if (isMatchEndedError(err)) { handleOpponentLeft(); return; }
      // Otherwise a transient network hiccup — next tick retries.
    }
  }

  async function handlePvpState(state) {
    if (!pvp || pvpRevealing) return;

    if (state.round !== pvp.round) {
      // Opponent tapped Replay first — follow along into the new round.
      pvp.round = state.round;
      beginPvpRound();
      return;
    }

    if (state.revealed && state.result) {
      pvpRevealing = true;
      await revealAndShow(state.myPick, state.oppPick);
      showPvpResult(state.result);
      pvpRevealing = false;
    }
  }

  // While the result overlay is up, we keep polling in the background —
  // NOT to reveal anything new, just to notice if the OPPONENT taps Replay
  // first. Either player's tap resets the shared room (see gameRoom.js's
  // rps-replay), so without this watch, whoever didn't tap would be left
  // staring at a dead result screen while the other player waits alone in
  // the new round forever.
  function showPvpResult(result) {
    const oppName = pvp.oppName || 'Opponent';
    const replay = () => {
      stopPvpPoll();
      window.MiniApp.haptic('light');
      el('rpsResult').textContent = 'Waiting to begin…';
      Api.pvpRpsReplay(pvp.gameId)
        .then((state) => {
          pvp.round = state.round;
          beginPvpRound();
        })
        .catch((err) => window.MiniApp.toast(err.message || 'Could not start rematch'));
    };

    stopPvpPoll();
    pvp.pollTimer = setInterval(async () => {
      try {
        const state = await Api.getGameState(pvp.gameId);
        if (state.round !== pvp.round) {
          stopPvpPoll();
          pvp.round = state.round;
          window.MiniApp.closeMiniResult();
          beginPvpRound();
        }
      } catch (_) {
        // Transient — next tick retries.
      }
    }, 1500);

    if (result.draw) {
      window.MiniApp.showMiniResult({
        win: false, emoji: '🤝', title: "It's a Draw!",
        sub: `Same move as ${oppName} — try again.`, coinText: '', onReplay: replay,
      });
      return;
    }

    // Each round settles its own 1-coin stake the instant it's decided (see
    // gameRoom.js's settleRpsRound) — refresh the wallet so the top coin
    // pill reflects it right away, same as every other coin-affecting flow.
    window.MiniApp.refreshCoins();

    const iWon = result.winnerId === window.MiniApp.myTelegramId;
    const coinText = result.coinsSettled === false ? '' : iWon ? '+1 coin' : '-1 coin';
    if (iWon) {
      window.MiniApp.showMiniResult({
        win: true, emoji: '🎉', title: 'You Win!',
        sub: `You beat ${oppName}!`, coinText, coinPositive: true, onReplay: replay,
      });
    } else {
      window.MiniApp.showMiniResult({
        win: false, emoji: '😢', title: 'You Lost',
        sub: `${oppName} got you this time.`, coinText, coinPositive: false, onReplay: replay,
      });
    }
  }

  // Called by app.js when the player leaves — the Home button, or
  // navigating away from the RPS screen entirely mid-round. Stops the
  // background poll AND tells the server this match is over, so a stale
  // "▶️ PLAY GAME" deep link (from the original Telegram challenge message)
  // can never silently drop the OTHER player back into a "PvP" match with
  // nobody actually on the other side (see app.js's startParam handling).
  function stopPvp() {
    if (pvp) {
      Api.leaveRpsMatch(pvp.gameId).catch(() => {}); // best-effort — a missed call just means cron cleans it up later
    }
    stopPvpPoll();
    pvp = null;
  }

  return { start, startPvp, stopPvp };
})();
