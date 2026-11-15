/* Helium — .lrc parser. Supports multiple timestamps per line and the [offset:] tag. */
(function (H) {
  'use strict';

  const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parse(text) {
    let offset = 0;
    const lines = [];
    const plain = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) { offset = parseInt(off[1], 10) / 1000; continue; }
      if (/^\[[a-z]+:.*\]\s*$/i.test(raw)) continue; // [ar:], [ti:], ...
      const stamps = [];
      let m;
      STAMP.lastIndex = 0;
      let last = 0;
      while ((m = STAMP.exec(raw))) {
        const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
        stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
        last = STAMP.lastIndex;
      }
      const words = raw.slice(last).replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
      if (stamps.length) for (const t of stamps) lines.push({ time: t, text: words });
      else if (raw.trim()) plain.push(raw.trim());
    }
    if (!lines.length) return { synced: false, lines: plain.map((text) => ({ time: -1, text })) };
    // Offset: positive values make lyrics appear sooner.
    for (const l of lines) l.time = Math.max(0, l.time - offset);
    lines.sort((a, b) => a.time - b.time);
    return { synced: true, lines };
  }

  // Index of the active line for time t (binary search), -1 before the first line.
  function activeIndex(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  H.lrc = { parse, activeIndex };
})(window.Helium = window.Helium || {});
