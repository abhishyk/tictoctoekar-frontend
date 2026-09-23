// Small, dependency-free animation helpers. Everything here is plain CSS
// classes + timers — no animation libraries, keeps things fast on low-end
// Android phones.

const Anim = {
  /** Runs the 3-2-1-GO countdown, calling onDone() when it finishes. */
  runCountdown(onDone) {
    const overlay = document.getElementById('countdownOverlay');
    const numberEl = document.getElementById('countdownNumber');
    const sequence = ['3', '2', '1', 'GO!'];
    let i = 0;

    overlay.hidden = false;

    const step = () => {
      const val = sequence[i];
      numberEl.textContent = val;
      numberEl.classList.remove('go');
      // Restart the CSS animation each tick.
      numberEl.style.animation = 'none';
      // Force reflow so the animation restarts.
      void numberEl.offsetWidth;
      numberEl.style.animation = '';
      if (val === 'GO!') numberEl.classList.add('go');

      Api.haptic('medium');

      i += 1;
      if (i < sequence.length) {
        setTimeout(step, 700);
      } else {
        setTimeout(() => {
          overlay.hidden = true;
          onDone && onDone();
        }, 550);
      }
    };
    step();
  },

  /** Pop-in animation for placing a mark in a cell. */
  markCell(cellEl, mark) {
    cellEl.textContent = mark;
    cellEl.classList.add('filled', mark === 'X' ? 'mark-x' : 'mark-o');
    // 'medium' reads as a proper, felt tap (matches the new solid press
    // animation) — 'light' was barely noticeable next to it.
    Api.haptic('medium');
  },

  /** Highlights the winning line's three cells. */
  highlightWin(cellEls, line) {
    line.forEach((i) => cellEls[i].classList.add('win-cell'));
  },

  clearBoardAnimations(cellEls) {
    cellEls.forEach((el) => {
      el.textContent = '';
      el.className = 'cell';
    });
  },

  /** Bumps the coin pill (used whenever the balance changes). */
  bumpCoinPill() {
    const pill = document.getElementById('coinPill');
    pill.classList.remove('bump');
    void pill.offsetWidth;
    pill.classList.add('bump');
  },

  showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.hidden = false;
    // Restart animation.
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = '';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  },

  /**
   * Flies a BURST of the same emoji up across the WHOLE screen (like the
   * reaction bursts on live-stream apps) instead of a single icon confined
   * to the board area — each copy gets a random stagger, start position,
   * horizontal drift, rotation and size so the burst looks organic and
   * covers the full width/height rather than a stack of identical clones
   * huddled in the middle. Purely visual — never touches the network itself.
   */
  showReaction(emoji, count = 8) {
    // Fixed-position, appended straight to <body> so the flight path spans
    // the entire viewport instead of being clipped to the board's box.
    const host = document.body;

    for (let i = 0; i < count; i++) {
      const stagger = i * 60 + Math.random() * 60;
      setTimeout(() => {
        const span = document.createElement('span');
        span.className = 'flying-reaction';
        span.textContent = emoji;

        const startXPct = 12 + Math.random() * 76; // vw, spread across almost the full width
        const driftX = Math.round((Math.random() - 0.5) * 160); // px, extra horizontal wander while flying up
        const rot = Math.round((Math.random() - 0.5) * 60); // deg
        const scale = (0.85 + Math.random() * 0.55).toFixed(2);
        const duration = (1.6 + Math.random() * 0.7).toFixed(2);
        const riseVh = Math.round(78 + Math.random() * 14); // vh, how far up the screen it travels

        span.style.setProperty('--drift-x', `${driftX}px`);
        span.style.setProperty('--rot', `${rot}deg`);
        span.style.setProperty('--scale', scale);
        span.style.setProperty('--rise', `${riseVh}vh`);
        span.style.left = `${startXPct}vw`;
        span.style.animationDuration = `${duration}s`;

        host.appendChild(span);
        setTimeout(() => span.remove(), duration * 1000 + 120);
      }, stagger);
    }
  },

  showLoading(show) {
    document.getElementById('loadingOverlay').hidden = !show;
  },

  /**
   * Paints the wheel's colored slices + radial labels for a given ordered
   * list of reward names (the server's canonical order — see Api.spinInfo).
   * Called once when the Spin screen opens, and it's safe to call again
   * later (e.g. after a spin) since it just repaints from scratch.
   */
  buildWheel(wheelEl, labels) {
    const n = labels.length;
    if (!n) return;
    const slice = 360 / n;
    const colors = ['#ffd35a', '#6d9bff', '#ff7a9c', '#00e5c7', '#7cff6d', '#ff9d4d', '#b98bff'];
    const stops = labels
      .map((_, i) => `${colors[i % colors.length]} ${i * slice}deg ${(i + 1) * slice}deg`)
      .join(', ');
    wheelEl.style.background = `conic-gradient(${stops})`;

    wheelEl.querySelectorAll('.wheel-label').forEach((el) => el.remove());
    labels.forEach((label, i) => {
      const mid = i * slice + slice / 2;
      // Spoke points "east" at rotate(0); subtracting 90deg re-bases it to
      // "north" (12 o'clock), matching where conic-gradient's own 0deg lands.
      const spoke = document.createElement('div');
      spoke.className = 'wheel-label';
      spoke.style.transform = `rotate(${mid - 90}deg)`;
      const span = document.createElement('span');
      span.textContent = label;
      spoke.appendChild(span);
      wheelEl.appendChild(spoke);
    });
  },

  /**
   * Spins the wheel to land on `reward` (already decided server-side — this
   * is purely the visual payoff, never what picks the prize). Resets any
   * previous rotation to 0 first (instantly, no transition) so repeated
   * spins each get a fresh multi-turn animation instead of one
   * ever-growing rotation value that would eventually spin "too fast" to
   * read as the animation covers more and more raw degrees per spin.
   */
  spinWheelTo(wheelEl, labels, reward, onDone) {
    const n = labels.length;
    if (!n) { onDone && onDone(); return; }
    const slice = 360 / n;
    const idx = Math.max(0, labels.indexOf(reward));
    const mid = idx * slice + slice / 2;
    const finalAngle = 5 * 360 + (360 - mid);

    wheelEl.style.transition = 'none';
    wheelEl.style.transform = 'rotate(0deg)';
    void wheelEl.offsetWidth; // force reflow so the reset above isn't itself animated
    wheelEl.style.transition = 'transform 4.2s cubic-bezier(0.1, 0.7, 0.15, 1)';
    wheelEl.style.transform = `rotate(${finalAngle}deg)`;

    Api.haptic('medium');
    setTimeout(() => {
      Api.haptic('heavy');
      onDone && onDone();
    }, 4300);
  },

  /** Fires the winner-modal coin +/- text with directional animation. */
  showCoinChange(amount) {
    const el = document.getElementById('coinChange');
    if (amount === 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = amount > 0 ? `+${amount} coins` : `${amount} coins`;
    el.className = 'coin-change ' + (amount > 0 ? 'positive' : 'negative');
  },

  /** Simple screen transition: fade/slide out old, fade/slide in new. */
  switchScreen(fromEl, toEl) {
    if (fromEl && fromEl !== toEl) {
      fromEl.classList.remove('active');
      fromEl.classList.add('leaving');
      setTimeout(() => fromEl.classList.remove('leaving'), 220);
    }
    if (toEl) {
      toEl.classList.add('active');
    }
  },
};

window.Anim = Anim;
