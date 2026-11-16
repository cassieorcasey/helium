/*
 * Helium: Virtual Rotary Scrubber.
 * Circular drag on the ring emits a detent every 15°, with haptics (navigator.vibrate) and an optional
 * synthesized mechanical click. Taps on the ring labels act as buttons; the ring surface is also a
 * keyboard-operable slider so the gesture is never the only way in.
 */
(function (H) {
  'use strict';

  const DETENT = 15; // degrees
  let audioCtx = null;

  function click() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const len = Math.floor(audioCtx.sampleRate * 0.006);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const hp = audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400;
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.22, t);
      src.connect(hp).connect(gain).connect(audioCtx.destination);
      src.start(t);
    } catch (e) { /* audio unavailable */ }
  }

  function createWheel(root, { onDetent, onAction, prefs }) {
    const surface = root.querySelector('.wheel-surface');
    const indicator = root.querySelector('.wheel-indicator');
    let tracking = null;
    let angle = 0;
    let lastDetentAt = 0;
    let tapHandledAt = 0;

    const feedback = () => {
      if (prefs().haptics && navigator.vibrate) navigator.vibrate(4);
      if (prefs().clicks) click();
    };

    const detent = (dir, fromKeyboard) => {
      const now = performance.now();
      const gap = now - lastDetentAt;
      lastDetentAt = now;
      // Acceleration: fast spins cover more ground per detent.
      const speed = fromKeyboard ? 1 : gap < 30 ? 5 : gap < 60 ? 3 : gap < 110 ? 2 : 1;
      feedback();
      onDetent(dir, speed);
    };

    const geometry = (e) => {
      const r = root.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      return { deg: (Math.atan2(dy, dx) * 180) / Math.PI, dist: Math.hypot(dx, dy) / (r.width / 2) };
    };

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const g = geometry(e);
      if (g.dist < 0.36 || g.dist > 1.04) return; // centre button handles itself
      e.preventDefault();
      root.setPointerCapture(e.pointerId);
      tracking = { id: e.pointerId, last: g.deg, total: 0, acc: 0, start: performance.now(), target: e.target.closest('[data-act]') };
      root.classList.add('is-turning');
      surface.focus({ preventScroll: true });
    });

    root.addEventListener('pointermove', (e) => {
      if (!tracking || e.pointerId !== tracking.id) return;
      const g = geometry(e);
      let d = g.deg - tracking.last;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      tracking.last = g.deg;
      tracking.total += Math.abs(d);
      tracking.acc += d;
      angle += d;
      indicator.style.setProperty('--angle', angle + 'deg');
      while (tracking.acc >= DETENT) { tracking.acc -= DETENT; detent(1); }
      while (tracking.acc <= -DETENT) { tracking.acc += DETENT; detent(-1); }
    });

    const end = (e) => {
      if (!tracking || e.pointerId !== tracking.id) return;
      const t = tracking;
      tracking = null;
      root.classList.remove('is-turning');
      tapHandledAt = performance.now();
      // A short, mostly-still press on a ring label is a tap on that control.
      if (e.type === 'pointerup' && t.total < 10 && performance.now() - t.start < 600 && t.target) {
        feedback();
        onAction(t.target.dataset.act, t.target);
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    // Buttons still respond to keyboard / assistive tech clicks.
    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        // Pointer interactions on the ring were already resolved in pointerup (tap or turn).
        if (performance.now() - tapHandledAt < 500) return;
        onAction(btn.dataset.act, btn);
      });
    });

    surface.addEventListener('keydown', (e) => {
      const map = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 };
      if (!(e.key in map) || e.shiftKey || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const n = map[e.key];
      angle += Math.sign(n) * DETENT;
      indicator.style.setProperty('--angle', angle + 'deg');
      for (let i = 0; i < Math.abs(n); i++) detent(Math.sign(n), true);
    });

    // Wheel scrolling over the ring maps to detents too (trackpads, mice).
    let wheelAcc = 0;
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      wheelAcc += e.deltaY;
      while (Math.abs(wheelAcc) >= 40) {
        const dir = wheelAcc > 0 ? 1 : -1;
        wheelAcc -= dir * 40;
        angle += dir * DETENT;
        indicator.style.setProperty('--angle', angle + 'deg');
        detent(dir);
      }
    }, { passive: false });

    return { click };
  }

  H.createWheel = createWheel;
})(window.Helium = window.Helium || {});
