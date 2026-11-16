/* Helium: application shell: navigation, views, queue, Now Playing, lyrics, shortcuts. */
(function (H) {
  'use strict';

  const { idb, ls } = H.store;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const compactMQ = window.matchMedia('(max-width: 760px)');

  const app = $('#app');
  const lib = new H.Library();
  const engine = new H.Engine();

  /* =============================================================== Prefs */

  const prefs = Object.assign(
    { theme: 'auto', haptics: true, clicks: true, gapless: true, volume: 0.8, shuffle: false, repeat: 'off', wheelMode: 'scrub', rootView: 'albums' },
    ls.get('prefs', {})
  );
  const savePrefs = () => ls.set('prefs', prefs);
  const applyTheme = () => { document.documentElement.dataset.theme = prefs.theme; };
  applyTheme();
  engine.volume = prefs.volume;
  engine.gapless = prefs.gapless;

  /* =============================================================== State */

  const state = {
    stack: [{ type: prefs.rootView }],
    viewTracks: [],
    queue: [],
    original: [],
    qIndex: -1,
    track: null,
    lyrics: null,
    lyricIndex: -2,
    lyricUserScrollAt: 0,
    listened: 0,
    lastTime: 0,
    counted: false,
    scanning: false,
    restored: false,
    rootHandle: null,
    npOpen: false,
    flipped: false
  };

  /* ============================================================= Helpers */

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function hue(text) {
    let h = 0;
    for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'type' || k === 'title') node.setAttribute(k, v === true ? '' : v);
        else node[k] = v;
      }
    }
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }

  function icon(name, cls = 'icon') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function setIcon(button, name) {
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', '#i-' + name);
  }

  let toastTimer = 0;
  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 1300);
  }

  const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  /* ================================================================= Art */

  const artObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      artObserver.unobserve(entry.target);
      loadArt(entry.target, entry.target.dataset.art);
    }
  }, { root: $('#stage-scroll'), rootMargin: '400px 0px' });

  function artBox(key, label, cls = '') {
    const box = el('span', { class: 'art ' + cls, style: `--h:${hue(label)}` }, el('img', { alt: '', decoding: 'async' }));
    if (key) { box.dataset.art = key; artObserver.observe(box); }
    return box;
  }

  async function loadArt(box, key) {
    const img = box.querySelector('img');
    box.dataset.artKey = key || '';
    if (!key) { box.classList.remove('has-img'); img.removeAttribute('src'); return; }
    const url = await lib.artURL(key);
    if (box.dataset.artKey !== (key || '')) return;
    if (!url) { box.classList.remove('has-img'); return; }
    if (img.src !== url) {
      img.onload = () => box.classList.add('has-img');
      img.src = url;
      if (img.complete) box.classList.add('has-img');
    } else box.classList.add('has-img');
  }

  function setArt(box, track) {
    box.style.setProperty('--h', hue(track ? track.album : ''));
    box.classList.remove('has-img');
    loadArt(box, track ? track.artKey : '');
  }

  /* =========================================================== Navigation */

  const navSpring = new H.Spring({ value: 0, onUpdate: (v) => app.style.setProperty('--nav', v) });
  const isCompact = () => compactMQ.matches;

  function showScreen(screen) {
    app.dataset.screen = screen;
    navSpring.to(screen === 'stage' ? 1 : 0);
  }

  const ROOT_TITLES = {
    songs: 'Songs', albums: 'Albums', artists: 'Artists', folders: 'Local Folders', playlists: 'Playlists',
    'smart:recent': 'Recently Added', 'smart:heavy': 'Heavy Rotation', 'smart:never': 'Never Played'
  };

  function viewTitle(v) {
    switch (v.type) {
      case 'album': { const a = lib.albumByKey.get(v.key); return a ? a.title : 'Album'; }
      case 'artist': return v.name;
      case 'folder': { const f = lib.folders.get(v.path); return v.path ? (f ? f.name : v.path) : 'Local Folders'; }
      case 'playlist': { const p = lib.playlists.find((x) => x.id === v.id); return p ? p.name : 'Playlist'; }
      case 'search': return 'Search';
      default: return ROOT_TITLES[v.type] || 'Library';
    }
  }

  function navigate(view, { root = false } = {}) {
    const scroller = $('#stage-scroll');
    const current = state.stack[state.stack.length - 1];
    if (current) current.scroll = scroller.scrollTop;
    if (root) {
      state.stack = [view];
      if (ROOT_TITLES[view.type] && view.type !== 'search') { prefs.rootView = view.type; savePrefs(); }
    } else if (current && current.type === 'search' && view.type === 'search') {
      state.stack[state.stack.length - 1] = view;
    } else {
      state.stack.push(view);
    }
    render();
    scroller.scrollTop = 0;
    if (isCompact()) showScreen('stage');
  }

  function back() {
    if (state.stack.length > 1) {
      state.stack.pop();
      render();
      const top = state.stack[state.stack.length - 1];
      $('#stage-scroll').scrollTop = top.scroll || 0;
      if (top.type !== 'search' && $('#search').value && !state.stack.some((v) => v.type === 'search')) $('#search').value = '';
    } else if (isCompact()) {
      showScreen('menu');
    }
  }

  /* =============================================================== Views */

  function trackRow(t, index, { thumb = false, num = null } = {}) {
    const btn = el('button', { class: 'row-btn', 'data-index': index, 'data-id': t.id },
      thumb ? artBox(t.artKey, t.album, 'row-thumb') : el('span', { class: 'row-num', text: num != null ? String(num) : '' }),
      el('span', { class: 'eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: t.title }),
        el('span', { class: 'row-sub', text: thumb ? `${t.artist} · ${t.album}` : t.artist })
      ),
      el('span', { class: 'row-end', text: t.duration ? fmt(t.duration) : '' })
    );
    if (state.track && state.track.id === t.id) btn.setAttribute('aria-current', 'true');
    return el('li', null, btn);
  }

  function navRow(view, title, sub, iconName, end) {
    return el('li', null,
      el('button', { class: 'row-btn', 'data-nav': JSON.stringify(view) },
        el('span', { class: 'row-icon' }, icon(iconName)),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: title }), sub ? el('span', { class: 'row-sub', text: sub }) : null),
        el('span', { class: 'row-end' }, end || '', icon('chevron-right'))
      )
    );
  }

  function trackList(tracks, opts = {}) {
    const ol = el('ol', { class: 'rows' + (opts.thumb ? ' rows-thumbs' : '') });
    const frag = document.createDocumentFragment();
    tracks.forEach((t, i) => frag.append(trackRow(t, (opts.offset || 0) + i, { thumb: opts.thumb, num: opts.numbers ? (t.track || i + 1) : opts.index ? i + 1 : null })));
    ol.append(frag);
    return ol;
  }

  function albumGrid(albums) {
    const grid = el('div', { class: 'album-grid' });
    const frag = document.createDocumentFragment();
    for (const a of albums) {
      frag.append(el('button', { class: 'album-card', 'data-nav': JSON.stringify({ type: 'album', key: a.key }), 'aria-label': `${a.title}, ${a.artist}` },
        artBox(a.artKey, a.title),
        el('span', { class: 'album-card-title', text: a.title }),
        el('span', { class: 'album-card-sub', text: a.artist + (a.year ? ' · ' + a.year : '') })
      ));
    }
    grid.append(frag);
    return grid;
  }

  const plural = (n, word) => `${n.toLocaleString('id-ID')} ${word}`;
  const minutes = (sec) => `${Math.max(1, Math.round(sec / 60))} mnt`;

  function viewHead(title, count) {
    return el('div', { class: 'view-head' }, el('h2', { text: title }), count != null ? el('span', { class: 'view-count', text: count }) : null);
  }

  function emptyNote(text) { return el('div', { class: 'view-empty', text }); }

  function buildView(v) {
    const frag = document.createDocumentFragment();
    let tracks = [];
    switch (v.type) {
      case 'songs':
        tracks = lib.tracks;
        frag.append(viewHead('Songs', plural(tracks.length, 'lagu')), trackList(tracks, { thumb: true }));
        break;

      case 'albums':
        frag.append(viewHead('Albums', plural(lib.albums.length, 'album')), albumGrid(lib.albums));
        tracks = lib.albums.flatMap((a) => a.tracks);
        break;

      case 'album': {
        const a = lib.albumByKey.get(v.key);
        if (!a) { frag.append(emptyNote('Album tidak ditemukan.')); break; }
        tracks = a.tracks;
        const art = artBox(a.artKey, a.title);
        frag.append(el('header', { class: 'album-head' },
          art,
          el('div', { class: 'album-head-text' },
            el('h2', { text: a.title }),
            el('div', { class: 'album-head-artist', text: a.artist }),
            el('div', { class: 'album-head-meta meta-num', text: [a.year, plural(a.tracks.length, 'lagu'), minutes(a.duration), a.format].filter(Boolean).join(' · ') }),
            el('div', { class: 'album-head-actions' },
              el('button', { class: 'btn btn-primary', 'data-action': 'play-all' }, icon('play'), 'Putar'),
              el('button', { class: 'btn btn-quiet', 'data-action': 'shuffle-all' }, icon('shuffle'), 'Acak')
            )
          )
        ));
        const discs = new Set(a.tracks.map((t) => t.disc || 1));
        if (discs.size > 1) {
          let offset = 0;
          for (const d of [...discs].sort((x, y) => x - y)) {
            const part = a.tracks.filter((t) => (t.disc || 1) === d);
            frag.append(el('div', { class: 'view-sub', text: 'Disc ' + d }), trackList(part, { numbers: true, offset }));
            offset += part.length;
          }
        } else {
          frag.append(trackList(a.tracks, { numbers: true }));
        }
        break;
      }

      case 'artists': {
        frag.append(viewHead('Artists', plural(lib.artists.length, 'artis')));
        const ol = el('ol', { class: 'rows' });
        for (const ar of lib.artists) ol.append(navRow({ type: 'artist', name: ar.name }, ar.name, `${plural(ar.albums.length, 'album')} · ${plural(ar.tracks.length, 'lagu')}`, 'artist'));
        frag.append(ol);
        tracks = lib.artists.flatMap((a) => a.albums.flatMap((al) => al.tracks));
        break;
      }

      case 'artist': {
        const ar = lib.artistByName.get(H.util.fold(v.name));
        if (!ar) { frag.append(emptyNote('Artis tidak ditemukan.')); break; }
        tracks = ar.albums.flatMap((al) => al.tracks);
        frag.append(viewHead(ar.name, `${plural(ar.albums.length, 'album')} · ${plural(tracks.length, 'lagu')}`), albumGrid(ar.albums));
        frag.append(el('div', { class: 'view-sub', text: 'Semua lagu' }), trackList(tracks, { thumb: true }));
        break;
      }

      case 'folders':
      case 'folder': {
        const path = v.type === 'folders' ? '' : v.path;
        const f = lib.folders.get(path);
        if (!f) { frag.append(emptyNote('Folder kosong.')); break; }
        tracks = f.tracks;
        frag.append(viewHead(path ? f.name : (lib.rootName || 'Local Folders'), path || null));
        const children = [...f.children].map((p) => lib.folders.get(p)).sort((a, b) => H.util.compare(a.name, b.name));
        if (children.length) {
          const ol = el('ol', { class: 'rows' });
          for (const c of children) {
            const count = countTracks(c);
            ol.append(navRow({ type: 'folder', path: c.path }, c.name, plural(count, 'lagu'), 'folder'));
          }
          frag.append(ol);
        }
        if (tracks.length) frag.append(children.length ? el('div', { class: 'view-sub', text: 'File' }) : '', trackList(tracks, { index: true }));
        break;
      }

      case 'playlists': {
        frag.append(viewHead('Playlists', plural(lib.playlists.length, 'playlist')));
        const ol = el('ol', { class: 'rows' });
        for (const [kind, name, ic] of [['recent', 'Recently Added', 'sparkle'], ['heavy', 'Heavy Rotation', 'flame'], ['never', 'Never Played', 'clock']]) {
          ol.append(navRow({ type: 'smart:' + kind }, name, 'Smart collection', ic));
        }
        for (const p of lib.playlists) ol.append(navRow({ type: 'playlist', id: p.id }, p.name, `${plural(p.tracks.length, 'lagu')} · ${p.path}`, 'playlist'));
        frag.append(ol);
        if (!lib.playlists.length) frag.append(emptyNote('Letakkan file .m3u atau .m3u8 di folder musikmu untuk menampilkannya di sini.'));
        break;
      }

      case 'playlist': {
        const p = lib.playlists.find((x) => x.id === v.id);
        if (!p) { frag.append(emptyNote('Playlist tidak ditemukan.')); break; }
        tracks = p.tracks;
        frag.append(viewHead(p.name, `${plural(tracks.length, 'lagu')} · ${minutes(tracks.reduce((n, t) => n + (t.duration || 0), 0))}`), trackList(tracks, { thumb: true }));
        break;
      }

      case 'smart:recent':
      case 'smart:heavy':
      case 'smart:never': {
        const kind = v.type.slice(6);
        tracks = lib.smart(kind);
        const notes = {
          recent: 'Lagu yang paling baru masuk ke library-mu.',
          heavy: 'Belum ada riwayat putar. Lagu yang sering kamu dengarkan akan muncul di sini.',
          never: 'Semua lagu sudah pernah diputar.'
        };
        frag.append(viewHead(ROOT_TITLES[v.type], plural(tracks.length, 'lagu')));
        frag.append(tracks.length ? trackList(tracks, { thumb: true }) : emptyNote(notes[kind]));
        break;
      }

      case 'search': {
        const r = lib.search(v.q);
        tracks = r.tracks;
        frag.append(viewHead(`“${v.q}”`, plural(r.tracks.length, 'lagu')));
        if (r.artists.length) {
          frag.append(el('div', { class: 'view-sub', text: 'Artists' }));
          const chips = el('div', { class: 'chips' });
          for (const a of r.artists) chips.append(el('button', { class: 'chip', 'data-nav': JSON.stringify({ type: 'artist', name: a.name }) }, icon('artist'), a.name));
          frag.append(chips);
        }
        if (r.albums.length) frag.append(el('div', { class: 'view-sub', text: 'Albums' }), albumGrid(r.albums));
        if (r.tracks.length) frag.append(el('div', { class: 'view-sub', text: 'Songs' }), trackList(r.tracks, { thumb: true }));
        if (!r.tracks.length && !r.albums.length && !r.artists.length) frag.append(emptyNote('Tidak ada yang cocok di library lokalmu.'));
        break;
      }
    }
    return { frag, tracks };
  }

  function countTracks(folder) {
    let n = folder.tracks.length;
    for (const c of folder.children) n += countTracks(lib.folders.get(c));
    return n;
  }

  function render() {
    const v = state.stack[state.stack.length - 1];
    const hasLibrary = lib.tracks.length > 0;
    $('#empty').hidden = hasLibrary;
    $('#view').hidden = !hasLibrary;
    $('#stage-title').textContent = hasLibrary ? viewTitle(v) : 'Helium';
    const prev = state.stack[state.stack.length - 2];
    $('#back-label').textContent = prev ? viewTitle(prev) : 'Library';
    if (state.stack.length > 1) app.dataset.depth = state.stack.length; else delete app.dataset.depth;

    const rootType = state.stack[0].type;
    $$('.nav-item').forEach((b) => {
      if (b.dataset.view === rootType) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    const view = $('#view');
    view.replaceChildren();
    if (hasLibrary) {
      const { frag, tracks } = buildView(v);
      state.viewTracks = tracks;
      view.append(frag);
    } else {
      state.viewTracks = [];
    }
    const canPlay = state.viewTracks.length > 0;
    $('#btn-play-view').hidden = !canPlay;
    $('#btn-shuffle-view').hidden = !canPlay;
    updateHero();
  }

  function updateCounts() {
    const counts = { playlists: lib.playlists.length, artists: lib.artists.length, albums: lib.albums.length, songs: lib.tracks.length, folders: Math.max(0, lib.folders.size - 1) };
    $$('[data-count]').forEach((n) => { const c = counts[n.dataset.count]; n.textContent = c ? c.toLocaleString('id-ID') : ''; });
  }

  /* =============================================================== Queue */

  function playList(tracks, startIndex, { shuffle = prefs.shuffle } = {}) {
    if (!tracks.length) return;
    state.original = tracks.slice();
    if (startIndex == null) startIndex = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    const start = tracks[startIndex];
    if (shuffle) {
      state.queue = [start, ...shuffled(tracks.filter((_, i) => i !== startIndex))];
      state.qIndex = 0;
    } else {
      state.queue = state.original.slice();
      state.qIndex = startIndex;
    }
    if (shuffle !== prefs.shuffle) setShuffle(shuffle, { silent: true, reorder: false });
    playAt(state.qIndex);
  }

  function playAt(i, opts) {
    const t = state.queue[i];
    if (!t) return;
    state.qIndex = i;
    engine.load(t, opts);
  }

  function upcomingIndex(natural) {
    if (natural && prefs.repeat === 'one') return state.qIndex;
    const n = state.qIndex + 1;
    if (n < state.queue.length) return n;
    return prefs.repeat === 'all' && state.queue.length ? 0 : -1;
  }

  function next() {
    const i = upcomingIndex(false);
    if (i >= 0) playAt(i);
    else toast('Akhir antrean');
  }

  function prev() {
    if (engine.currentTime > 3 || state.qIndex <= 0 && prefs.repeat !== 'all') { engine.seek(0); return; }
    const i = state.qIndex > 0 ? state.qIndex - 1 : state.queue.length - 1;
    playAt(i);
  }

  function preloadNext() {
    const i = upcomingIndex(true);
    engine.preload(i >= 0 ? state.queue[i] : null);
  }

  function setShuffle(on, { silent = false, reorder = true } = {}) {
    prefs.shuffle = on;
    savePrefs();
    $$('[data-act="shuffle"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
    if (reorder && state.track && state.queue.length) {
      const cur = state.queue[state.qIndex];
      if (on) {
        state.queue = [cur, ...shuffled(state.original.filter((t) => t !== cur))];
        state.qIndex = 0;
      } else {
        state.queue = state.original.slice();
        state.qIndex = Math.max(0, state.queue.indexOf(cur));
      }
      preloadNext();
      renderQueue();
    }
    if (!silent) toast(on ? 'Shuffle aktif' : 'Shuffle mati');
  }

  function cycleRepeat() {
    prefs.repeat = prefs.repeat === 'off' ? 'all' : prefs.repeat === 'all' ? 'one' : 'off';
    savePrefs();
    updateRepeat();
    preloadNext();
    toast({ off: 'Ulangi mati', all: 'Ulangi semua', one: 'Ulangi satu lagu' }[prefs.repeat]);
  }

  function updateRepeat() {
    const b = $('#np-repeat-btn');
    b.dataset.repeat = prefs.repeat;
    b.setAttribute('aria-label', 'Ulangi: ' + { off: 'mati', all: 'semua', one: 'satu lagu' }[prefs.repeat]);
  }

  /* ========================================================= Now Playing */

  function onTrack(track, gapless) {
    state.trackToken = (state.trackToken || 0) + 1;
    // A silent reload after a recovered read error keeps the listening tally.
    if (engine.recovering && state.track && state.track.id === track.id) return;
    if (gapless) {
      const i = upcomingIndex(true);
      if (i >= 0 && state.queue[i] === track) state.qIndex = i;
    }
    state.track = track;
    state.listened = 0;
    state.lastTime = 0;
    state.counted = false;
    app.dataset.hasTrack = 'true';

    const sub = `${track.artist} · ${track.album}`;
    $('#bar-title').textContent = track.title;
    $('#bar-sub').textContent = sub;
    $('#np-title').textContent = track.title;
    $('#np-sub').textContent = sub;
    $('#np-format').textContent = track.format;
    for (const box of [$('.bar-art'), $('#np-art'), $('#hero-art')]) setArt(box, track);
    updateHero();
    $$('.row-btn[data-id]').forEach((b) => (b.dataset.id === track.id ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    document.title = `${track.title} · ${track.artist} · Helium`;

    loadLyrics(track);
    updateMediaSession(track);
    renderQueue();
    updateTime(true);
    saveSession();
    preloadNext();
  }

  function updateHero() {
    const t = state.track;
    const v = state.stack[state.stack.length - 1];
    $('#hero').hidden = !t || !lib.tracks.length || v.type === 'album';
    if (!t) return;
    $('#hero-title').textContent = t.title;
    $('#hero-sub').textContent = `${t.artist} · ${t.album}`;
    $('#hero-format').textContent = [t.format, t.year].filter(Boolean).join(' · ');
  }

  let lastShownSecond = -1;
  function updateTime(force) {
    const t = engine.currentTime;
    const d = engine.duration;
    const ratio = d ? Math.min(1, t / d) : 0;
    $('#bar-progress').style.transform = `scaleX(${ratio})`;
    const seek = $('#np-seek');
    if (!seeking) {
      seek.max = d || 1;
      seek.value = t;
      seek.style.setProperty('--fill', ratio * 100 + '%');
    }
    const sec = Math.floor(t);
    if (force || sec !== lastShownSecond) {
      lastShownSecond = sec;
      $('#bar-time').textContent = `${fmt(t)} / ${fmt(d)}`;
      if (!seeking) {
        $('#np-elapsed').textContent = fmt(t);
        $('#np-remaining').textContent = '-' + fmt(Math.max(0, d - t));
      }
      if (prefs.wheelMode === 'scrub') {
        const s = $('#wheel-surface');
        s.setAttribute('aria-valuenow', Math.round(ratio * 100));
        s.setAttribute('aria-valuetext', `${fmt(t)} dari ${fmt(d)}`);
      }
    }
    if (state.flipped) syncLyrics(t);
  }

  function setPlayingUI() {
    const playing = !engine.paused;
    app.dataset.playing = String(playing);
    $$('[data-act="toggle"]').forEach((b) => {
      setIcon(b, playing ? 'pause' : 'play');
      b.setAttribute('aria-label', playing ? 'Jeda' : 'Putar');
    });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (playing) loop();
  }

  let rafId = 0;
  function loop() {
    cancelAnimationFrame(rafId);
    const tick = () => {
      updateTime();
      if (!engine.paused) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  /* NP sheet with interruptible spring + drag to dismiss */
  const np = $('#np');
  const npSpring = new H.Spring({
    value: 0,
    onUpdate: (v) => {
      np.style.setProperty('--p', v);
      $('#np-scrim').style.setProperty('--p', v);
      np.classList.toggle('is-animating', v > 0.001 && v < 0.999);
    },
    onRest: (v) => {
      if (v === 0 && !state.npOpen) setTimeout(() => { if (!state.npOpen) np.hidden = true; }, H.motion.reduced ? 160 : 0);
    }
  });

  function openNP() {
    if (!state.track) return;
    if (state.npOpen) return;
    state.npOpen = true;
    np.hidden = false;
    app.dataset.np = 'open';
    if (H.motion.reduced) { np.style.setProperty('--p', 0); void np.offsetWidth; }
    npSpring.to(1);
    lastFocus = document.activeElement;
    setTimeout(() => $('#np-close').focus({ preventScroll: true }), 30);
    updateTime(true);
  }

  let lastFocus = null;
  function closeNP(velocity) {
    if (!state.npOpen) return;
    state.npOpen = false;
    app.dataset.np = 'closed';
    npSpring.to(0, velocity !== undefined ? { velocity } : undefined);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  (function dragToDismiss() {
    let drag = null;
    const handles = [$('.np-header'), $('#np-card')];
    for (const h of handles) {
      h.addEventListener('pointerdown', (e) => {
        if (!isCompact() || e.button !== 0) return;
        if (e.target.closest('button') && h !== $('#np-card')) return;
        if (state.flipped || !$('#np-queue').hidden) return;
        drag = { id: e.pointerId, y0: e.clientY, y: e.clientY, t: performance.now(), v: 0, moved: false, start: npSpring.value };
        npSpring.stop();
      });
    }
    window.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.abs(dy) < 8) return;
      if (!drag.moved) { drag.moved = true; np.classList.add('is-dragging'); }
      const now = performance.now();
      drag.v = (e.clientY - drag.y) / Math.max(1, now - drag.t); // px per ms
      drag.y = e.clientY;
      drag.t = now;
      const h = window.innerHeight;
      npSpring.set(Math.min(1, Math.max(0, drag.start - Math.max(0, dy) / h)));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      np.classList.remove('is-dragging');
      if (!d.moved) return;
      suppressCardClick = performance.now();
      const h = window.innerHeight;
      const velocity = (-d.v * 1000) / h; // progress units per second
      if (d.y - d.y0 > h * 0.18 || d.v > 0.6) closeNP(velocity);
      else npSpring.to(1, { velocity });
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  })();

  /* Lyrics flip */
  let suppressCardClick = 0;
  const flipSpring = new H.Spring({ value: 0, onUpdate: (v) => np.style.setProperty('--flip', v) });

  function setFlipped(on) {
    state.flipped = on;
    flipSpring.to(on ? 1 : 0);
    $('#np-lyrics-btn').setAttribute('aria-pressed', String(on));
    $('#np-art').setAttribute('aria-hidden', String(on));
    $('#np-lyrics').setAttribute('aria-hidden', String(!on));
    if (on) { state.lyricIndex = -2; syncLyrics(engine.currentTime, true); }
  }

  function toggleLyrics() {
    if (!state.track) return;
    if (!state.npOpen) { openNP(); setFlipped(true); return; }
    $('#np-queue').hidden = true;
    $('#np-queue-btn').setAttribute('aria-pressed', 'false');
    setFlipped(!state.flipped);
  }

  let lyricsToken = 0;
  async function loadLyrics(track) {
    const token = ++lyricsToken;
    state.lyrics = null;
    const list = $('#lyrics-list');
    list.replaceChildren();
    const lyr = await lib.lyricsFor(track);
    if (token !== lyricsToken) return;
    state.lyrics = lyr && lyr.lines.length ? lyr : null;
    $('#lyrics-empty').hidden = !!state.lyrics;
    $('#np-lyrics-btn').dataset.available = String(!!state.lyrics);
    list.classList.toggle('is-synced', !!(state.lyrics && state.lyrics.synced));
    if (state.lyrics) {
      const frag = document.createDocumentFragment();
      state.lyrics.lines.forEach((l, i) => frag.append(el('li', { 'data-i': i, text: l.text || '♪' })));
      list.append(frag);
      list.scrollTop = 0;
    }
    state.lyricIndex = -2;
    if (state.flipped) syncLyrics(engine.currentTime, true);
  }

  function syncLyrics(t, instant) {
    const lyr = state.lyrics;
    if (!lyr || !lyr.synced) return;
    const idx = H.lrc.activeIndex(lyr.lines, t + 0.15);
    if (idx === state.lyricIndex) return;
    state.lyricIndex = idx;
    const list = $('#lyrics-list');
    const items = list.children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-active', i === idx);
      items[i].classList.toggle('is-past', i < idx);
    }
    if (performance.now() - state.lyricUserScrollAt < 3000) return;
    const li = items[Math.max(0, idx)];
    if (!li) return;
    const top = li.offsetTop - list.clientHeight / 2 + li.offsetHeight / 2;
    list.scrollTo({ top, behavior: instant || H.motion.reduced ? 'auto' : 'smooth' });
  }

  /* Queue panel */
  function renderQueue() {
    const panel = $('#np-queue');
    if (panel.hidden) return;
    const list = $('#np-queue-list');
    const upcoming = state.queue.slice(state.qIndex + 1, state.qIndex + 201);
    $('#np-queue-count').textContent = plural(Math.max(0, state.queue.length - state.qIndex - 1), 'lagu');
    list.replaceChildren();
    if (!upcoming.length) { list.append(emptyNote(prefs.repeat === 'all' ? 'Antrean akan diulang dari awal.' : 'Tidak ada lagu berikutnya.')); return; }
    const frag = document.createDocumentFragment();
    upcoming.forEach((t, i) => {
      const li = trackRow(t, state.qIndex + 1 + i, { thumb: true });
      li.firstChild.dataset.queue = 'true';
      frag.append(li);
    });
    list.append(frag);
  }

  function toggleQueue() {
    const panel = $('#np-queue');
    panel.hidden = !panel.hidden;
    $('#np-queue-btn').setAttribute('aria-pressed', String(!panel.hidden));
    if (!panel.hidden) { if (state.flipped) setFlipped(false); renderQueue(); }
  }

  /* =========================================================== Media Session */

  async function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    const meta = { title: track.title, artist: track.artist, album: track.album, artwork: [] };
    const url = await lib.artURL(track.artKey);
    if (url) meta.artwork = [{ src: url, sizes: '512x512' }];
    if (state.track !== track) return;
    try { navigator.mediaSession.metadata = new MediaMetadata(meta); } catch (e) { /* unsupported */ }
  }

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const handlers = {
      play: () => engine.play(),
      pause: () => engine.pause(),
      previoustrack: prev,
      nexttrack: next,
      seekbackward: (d) => engine.seek(engine.currentTime - (d.seekOffset || 10)),
      seekforward: (d) => engine.seek(engine.currentTime + (d.seekOffset || 10)),
      seekto: (d) => engine.seek(d.seekTime)
    };
    for (const [k, fn] of Object.entries(handlers)) { try { ms.setActionHandler(k, fn); } catch (e) { /* unsupported action */ } }
  }

  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = engine.duration;
    if (!d) return;
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, engine.currentTime), playbackRate: 1 }); } catch (e) { /* ignore */ }
  }

  /* ============================================================ Session */

  let sessionTimer = 0;
  function saveSession() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      if (!state.track) return;
      ls.set('session', {
        ids: state.queue.slice(Math.max(0, state.qIndex - 200), state.qIndex + 800).map((t) => t.id),
        current: state.track.id,
        time: engine.currentTime,
        original: state.original.length <= 2000 ? state.original.map((t) => t.id) : null
      });
    }, 300);
  }

  function restoreSession() {
    if (state.restored || state.track) return;
    state.restored = true;
    const s = ls.get('session', null);
    if (!s || !s.current) return;
    const queue = (s.ids || []).map((id) => lib.byId.get(id)).filter(Boolean);
    const idx = queue.findIndex((t) => t.id === s.current);
    if (idx < 0) return;
    state.queue = queue;
    state.original = s.original ? s.original.map((id) => lib.byId.get(id)).filter(Boolean) : queue.slice();
    playAt(idx, { autoplay: false, startAt: s.time || 0 });
  }

  /* ========================================================= Engine events */

  engine.addEventListener('track', (e) => onTrack(e.detail.track, e.detail.gapless));
  engine.addEventListener('play', setPlayingUI);
  engine.addEventListener('pause', () => { setPlayingUI(); updateTime(true); saveSession(); });
  engine.addEventListener('seeked', () => { updateTime(true); updatePositionState(); });
  engine.addEventListener('durationchange', () => {
    const t = state.track;
    if (t && !t.duration && engine.duration) {
      t.duration = engine.duration;
      $$(`.row-btn[data-id="${CSS.escape(t.id)}"] .row-end`).forEach((n) => (n.textContent = fmt(t.duration)));
    }
    updateTime(true);
    updatePositionState();
  });
  engine.addEventListener('timeupdate', () => {
    const t = engine.currentTime;
    const d = t - state.lastTime;
    state.lastTime = t;
    if (!engine.paused && d > 0 && d < 1.5) state.listened += d;
    const need = Math.min(30, (engine.duration || 60) * 0.5);
    if (!state.counted && state.track && state.listened >= need) {
      state.counted = true;
      H.stats.played(state.track.id);
    }
    if (engine.paused) updateTime();
    if (Math.floor(t) % 5 === 0) saveSession();
  });
  engine.addEventListener('ended', () => {
    if (prefs.repeat === 'one') { engine.seek(0); engine.play(); state.listened = 0; state.counted = false; return; }
    const i = upcomingIndex(true);
    if (i >= 0) playAt(i);
    else { engine.seek(0); setPlayingUI(); }
  });
  // Unsupported codec (e.g. ALAC outside Safari) or unreadable file: say why, then skip ahead like an iPod would.
  let errorStreak = 0;
  engine.addEventListener('error', () => {
    const t = state.track;
    const token = state.trackToken;
    engine.pause();
    setPlayingUI();
    toast(t ? `Browser ini tidak bisa memutar “${t.title}”${t.codec ? ` (${t.codec})` : ''}` : 'Gagal memutar file');
    errorStreak++;
    const i = upcomingIndex(false);
    if (errorStreak < 4 && i >= 0 && i !== state.qIndex) setTimeout(() => { if (state.trackToken === token) playAt(i); }, 1400);
  });
  engine.addEventListener('playing', () => { errorStreak = 0; });
  engine.addEventListener('volumechange', () => {
    const v = $('#bar-volume');
    v.value = engine.volume;
    v.style.setProperty('--fill', engine.volume * 100 + '%');
    if (prefs.wheelMode === 'volume') {
      const s = $('#wheel-surface');
      s.setAttribute('aria-valuenow', Math.round(engine.volume * 100));
      s.setAttribute('aria-valuetext', `Volume ${Math.round(engine.volume * 100)}%`);
    }
  });

  /* ================================================================ Wheel */

  let hudTimer = 0;
  function hud(text) {
    const n = $('#wheel-hud');
    n.textContent = text;
    n.classList.add('is-visible');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => n.classList.remove('is-visible'), 700);
  }

  let bumpTimer = 0;
  function bump(node) {
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(() => node.classList.remove('bump'), 450);
  }

  function setVolume(v, announce) {
    engine.volume = v;
    prefs.volume = engine.volume;
    savePrefs();
    if (announce) toast(`Volume ${Math.round(engine.volume * 100)}%`);
  }

  function action(act) {
    switch (act) {
      case 'toggle': if (state.track) engine.toggle(); else if (state.viewTracks.length) playList(state.viewTracks, 0); break;
      case 'prev': if (state.track) prev(); break;
      case 'next': if (state.track) next(); break;
      case 'shuffle': setShuffle(!prefs.shuffle); break;
      case 'menu': closeNP(); break;
    }
  }

  H.createWheel($('#wheel'), {
    prefs: () => prefs,
    onAction: action,
    onDetent(dir, speed) {
      if (prefs.wheelMode === 'volume') {
        setVolume(engine.volume + dir * 0.02 * speed);
        hud(`${Math.round(engine.volume * 100)}%`);
        return;
      }
      if (!state.track) return;
      engine.seek(engine.currentTime + dir * speed);
      hud(fmt(engine.currentTime));
      bump($('#np-seek'));
    }
  });

  function setWheelMode(mode) {
    prefs.wheelMode = mode;
    savePrefs();
    $$('.wheel-modes [role="radio"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    const s = $('#wheel-surface');
    s.setAttribute('aria-label', mode === 'volume' ? 'Cincin putar: volume' : 'Cincin putar: posisi lagu');
    if (mode === 'volume') engine.dispatchEvent(new Event('volumechange'));
    else updateTime(true);
  }

  /* =========================================================== Scrubber */

  let seeking = false;
  let seekThrottle = 0;
  const seekInput = $('#np-seek');
  seekInput.addEventListener('pointerdown', () => { seeking = true; });
  seekInput.addEventListener('input', () => {
    seeking = true;
    const v = parseFloat(seekInput.value);
    const d = engine.duration || 1;
    seekInput.style.setProperty('--fill', (v / d) * 100 + '%');
    $('#np-elapsed').textContent = fmt(v);
    $('#np-remaining').textContent = '-' + fmt(Math.max(0, d - v));
    const now = performance.now();
    if (now - seekThrottle > 80) { seekThrottle = now; engine.seek(v); }
  });
  const endSeek = () => {
    if (!seeking) return;
    engine.seek(parseFloat(seekInput.value));
    seeking = false;
  };
  seekInput.addEventListener('change', endSeek);
  seekInput.addEventListener('pointerup', endSeek);
  seekInput.addEventListener('blur', () => { seeking = false; });

  const vol = $('#bar-volume');
  vol.addEventListener('input', () => setVolume(parseFloat(vol.value)));

  /* ============================================================= Library I/O */

  function setStatus(text) { $('#library-status').textContent = text; }

  function librarySummary() {
    if (!lib.tracks.length) return '';
    return `${plural(lib.tracks.length, 'lagu')} · ${plural(lib.albums.length, 'album')}`;
  }

  lib.addEventListener('progress', (e) => {
    const { done, total } = e.detail;
    setStatus(total ? `Mengindeks ${done.toLocaleString('id-ID')} / ${total.toLocaleString('id-ID')}…` : 'Memindai folder…');
  });

  lib.addEventListener('change', () => {
    // Re-bind queue entries to the freshly indexed track objects.
    const rebind = (arr) => arr.map((t) => lib.byId.get(t.id)).filter(Boolean);
    if (state.track) {
      const cur = lib.byId.get(state.track.id);
      state.queue = rebind(state.queue);
      state.original = rebind(state.original);
      if (cur) { state.qIndex = Math.max(0, state.queue.indexOf(cur)); state.track = cur; }
    }
    updateCounts();
    setStatus(librarySummary());
    // Drop views that no longer resolve after a rescan.
    if (!lib.tracks.length) state.stack = [{ type: prefs.rootView }];
    render();
    restoreSession();
  });

  async function scan(loader) {
    if (state.scanning) return;
    state.scanning = true;
    setStatus('Memindai folder…');
    $('#btn-reconnect').hidden = true;
    try {
      const { entries, rootName } = await loader();
      const audioCount = entries.filter((e) => H.entries.AUDIO.test(e.name)).length;
      if (!audioCount) { toast('Tidak ada file audio di folder itu'); setStatus(librarySummary()); return; }
      await lib.load(entries, rootName);
      if (isCompact() && app.dataset.screen !== 'stage') showScreen('menu');
    } catch (err) {
      console.error(err);
      toast('Gagal membaca folder');
      setStatus(librarySummary());
    } finally {
      state.scanning = false;
    }
  }

  function scanHandle(handle) {
    state.rootHandle = handle;
    return scan(async () => ({ entries: await H.entries.fromHandle(handle), rootName: handle.name }));
  }

  function scanFiles(files) {
    state.rootHandle = null;
    return scan(async () => H.entries.fromFiles(files));
  }

  async function openFolder() {
    if (window.showDirectoryPicker) {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ id: 'helium-music', mode: 'read' });
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        $('#file-folder').click();
        return;
      }
      await idb.put('kv', 'root', handle);
      return scanHandle(handle);
    }
    $('#file-folder').click();
  }

  $('#file-folder').addEventListener('change', (e) => { if (e.target.files.length) scanFiles(e.target.files); e.target.value = ''; });
  $('#file-files').addEventListener('change', (e) => { if (e.target.files.length) scanFiles(e.target.files); e.target.value = ''; });

  // Drag & drop folders / files.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; app.classList.add('is-dropping'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) app.classList.remove('is-dropping'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    app.classList.remove('is-dropping');
    const items = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
    // Everything must be pulled out of the DataTransfer synchronously.
    const handlePromises = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null));
    const fsEntries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const plainFiles = [...(e.dataTransfer.files || [])];
    (async () => {
      if (handlePromises.length && handlePromises.every(Boolean)) {
        const handles = (await Promise.all(handlePromises)).filter(Boolean);
        const dir = handles.find((h) => h.kind === 'directory');
        if (dir) { await idb.put('kv', 'root', dir); return scanHandle(dir); }
      }
      if (fsEntries.some((en) => en && en.isDirectory)) {
        const files = await filesFromEntries(fsEntries.filter(Boolean));
        return scanFiles(files);
      }
      if (plainFiles.length) scanFiles(plainFiles);
    })();
  });

  async function filesFromEntries(entries) {
    const out = [];
    const readAll = (reader) => new Promise((resolve) => {
      const all = [];
      const step = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); step(); } }, () => resolve(all));
      step();
    });
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((res) => entry.file(res, () => res(null)));
        if (file) {
          try { Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name }); } catch (e) { /* read-only */ }
          out.push(file);
        }
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/');
      }
    }
    for (const en of entries) await walk(en, '');
    return out;
  }

  /* ============================================================ Settings */

  const dialog = $('#settings');
  function openSettings() {
    const form = dialog.querySelector('form');
    form.theme.value = prefs.theme;
    form.haptics.checked = prefs.haptics;
    form.clicks.checked = prefs.clicks;
    form.gapless.checked = prefs.gapless;
    dialog.showModal();
  }
  dialog.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'theme') { prefs.theme = t.value; applyTheme(); }
    if (t.name === 'haptics') { prefs.haptics = t.checked; if (t.checked && navigator.vibrate) navigator.vibrate(4); }
    if (t.name === 'clicks') prefs.clicks = t.checked;
    if (t.name === 'gapless') { prefs.gapless = engine.gapless = t.checked; preloadNext(); }
    savePrefs();
  });
  $('#btn-rescan').addEventListener('click', async () => {
    dialog.close();
    if (state.rootHandle) {
      const perm = await state.rootHandle.requestPermission({ mode: 'read' }).catch(() => 'denied');
      if (perm === 'granted') scanHandle(state.rootHandle);
    } else {
      toast('Pilih folder musikmu lagi untuk memindai ulang');
      openFolder();
    }
  });
  $('#btn-change-folder').addEventListener('click', () => { dialog.close(); openFolder(); });
  $('#btn-forget').addEventListener('click', async () => {
    if (!confirm('Hapus indeks library, cover art tersimpan, dan statistik putar dari browser ini? File musikmu tidak disentuh.')) return;
    dialog.close();
    engine.stop();
    Object.assign(state, { queue: [], original: [], qIndex: -1, track: null, rootHandle: null, stack: [{ type: prefs.rootView }] });
    ls.remove('session');
    app.dataset.hasTrack = 'false';
    closeNP();
    document.title = 'Helium';
    await lib.forget();
    setStatus('');
    if (isCompact()) showScreen('menu');
  });

  /* ============================================================== Wiring */

  $$('.nav-item').forEach((b) => b.addEventListener('click', () => {
    $('#search').value = '';
    navigate({ type: b.dataset.view }, { root: true });
  }));

  $('#btn-back').addEventListener('click', back);
  $('#btn-open-folder').addEventListener('click', openFolder);
  $('#btn-empty-folder').addEventListener('click', openFolder);
  $('#btn-empty-files').addEventListener('click', () => $('#file-files').click());
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-play-view').addEventListener('click', () => playList(state.viewTracks, null, { shuffle: false }));
  $('#btn-shuffle-view').addEventListener('click', () => playList(state.viewTracks, null, { shuffle: true }));

  $('#view').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { navigate(JSON.parse(nav.dataset.nav)); return; }
    const act = e.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'play-all') playList(state.viewTracks, null, { shuffle: false });
      if (act.dataset.action === 'shuffle-all') playList(state.viewTracks, null, { shuffle: true });
      return;
    }
    const row = e.target.closest('.row-btn[data-index]');
    if (row) {
      const i = parseInt(row.dataset.index, 10);
      if (state.track && state.track.id === row.dataset.id && state.queue[state.qIndex] === state.viewTracks[i]) engine.toggle();
      else playList(state.viewTracks, i);
    }
  });

  $('#np-queue-list').addEventListener('click', (e) => {
    const row = e.target.closest('.row-btn[data-index]');
    if (row) playAt(parseInt(row.dataset.index, 10));
  });

  $$('#glass-bar [data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act)));
  $('#bar-open').addEventListener('click', openNP);
  $('#hero-art').addEventListener('click', openNP);
  $('#np-close').addEventListener('click', () => closeNP());
  $('#np-scrim').addEventListener('click', () => closeNP());
  $('#np-queue-btn').addEventListener('click', toggleQueue);
  $('#np-lyrics-btn').addEventListener('click', toggleLyrics);
  $('#np-repeat-btn').addEventListener('click', cycleRepeat);
  $('#np-card').addEventListener('click', (e) => {
    if (performance.now() - suppressCardClick < 300) return;
    if (e.target.closest('#np-queue')) return;
    const line = e.target.closest('#lyrics-list li');
    if (line && state.lyrics && state.lyrics.synced) {
      engine.seek(state.lyrics.lines[+line.dataset.i].time);
      state.lyricUserScrollAt = 0;
      return;
    }
    if (state.flipped && e.target.closest('#lyrics-list')) return;
    toggleLyrics();
  });
  const lyricsList = $('#lyrics-list');
  ['wheel', 'touchmove'].forEach((t) => lyricsList.addEventListener(t, () => { state.lyricUserScrollAt = performance.now(); }, { passive: true }));

  $$('.wheel-modes [role="radio"]').forEach((b) => b.addEventListener('click', () => setWheelMode(b.dataset.mode)));

  let searchTimer = 0;
  const search = $('#search');
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = search.value.trim();
      const top = state.stack[state.stack.length - 1];
      if (!q) { if (top.type === 'search') back(); return; }
      if (!lib.tracks.length) return;
      navigate({ type: 'search', q });
      if (isCompact()) search.blur();
    }, 160);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      const q = search.value.trim();
      if (q && lib.tracks.length) navigate({ type: 'search', q });
    }
    if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); e.stopPropagation(); }
  });

  /* ========================================================== Keyboard */

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      if (dialog.open) dialog.close();
      if (state.npOpen && isCompact()) closeNP();
      if (isCompact()) showScreen('menu');
      search.focus();
      search.select();
      return;
    }
    if (dialog.open || mod || e.altKey) return;
    const typing = t.matches && t.matches('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]');
    if (typing) return;
    const onRange = t.matches && t.matches('input[type="range"], [role="slider"]');

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        // Space is play/pause everywhere (Enter still activates focused buttons).
        if (t.matches && t.matches('[role="radio"], summary')) return;
        e.preventDefault();
        action('toggle');
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (onRange && !e.shiftKey) return;
        if (!state.track) return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) (dir > 0 ? next : prev)();
        else { engine.seek(engine.currentTime + dir * 5); bump(seekInput); }
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        if (onRange) return;
        e.preventDefault();
        setVolume(engine.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05), true);
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        toggleLyrics();
        break;
      case 'Escape':
        if (!$('#np-queue').hidden) toggleQueue();
        else if (state.npOpen) closeNP();
        else if (state.stack.length > 1 || isCompact()) back();
        break;
    }
  });

  // Focus trap inside the Now Playing dialog on Tab.
  np.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = $$('button:not([hidden]), input, [tabindex="0"]', np).filter((n) => n.offsetParent !== null && !n.closest('[hidden]'));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  compactMQ.addEventListener('change', () => {
    navSpring.set(app.dataset.screen === 'stage' ? 1 : 0);
  });

  window.addEventListener('pagehide', saveSession);

  /* ============================================================== Boot */

  async function boot() {
    setShuffle(prefs.shuffle, { silent: true, reorder: false });
    updateRepeat();
    setWheelMode(prefs.wheelMode);
    engine.dispatchEvent(new Event('volumechange'));
    app.dataset.np = 'closed';
    app.dataset.screen = isCompact() ? 'menu' : 'stage';
    navSpring.set(app.dataset.screen === 'stage' ? 1 : 0);
    render();
    updateCounts();

    const handle = await idb.get('kv', 'root');
    if (handle && handle.queryPermission) {
      state.rootHandle = handle;
      let perm = 'prompt';
      try { perm = await handle.queryPermission({ mode: 'read' }); } catch (e) { /* ignore */ }
      if (perm === 'granted') { scanHandle(handle); return; }
      const btn = $('#btn-reconnect');
      btn.querySelector('span').textContent = `Hubungkan ulang “${handle.name}”`;
      btn.hidden = false;
      btn.onclick = async () => {
        const p = await handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (p === 'granted') scanHandle(handle);
        else toast('Izin akses folder ditolak');
      };
    }
  }

  boot();

  // Exposed for debugging in the console.
  H.app = { lib, engine, state, prefs };
})(window.Helium);
