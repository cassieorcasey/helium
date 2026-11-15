/* Helium — local library: scanning, indexing (with cache), collections, smart playlists and play statistics. */
(function (H) {
  'use strict';

  const { idb, ls } = H.store;
  const AUDIO = /\.(mp3|flac|m4a|m4b|mp4|aac|alac|wav|wave|ogg|oga|opus|webm|aif|aiff)$/i;
  const LRC = /\.lrc$/i;
  const M3U = /\.m3u8?$/i;
  const COVER = /^(cover|folder|front|album|albumart|artwork)\.(jpe?g|png|webp)$/i;
  const CONCURRENCY = 6;

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const compare = (a, b) => collator.compare(a || '', b || '');
  const stripExt = (p) => p.replace(/\.[^./]+$/, '');
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function hashBytes(bytes) {
    // FNV-1a over length + up to 4096 sampled bytes: stable, cheap de-duplication key for cover art.
    let h = 0x811c9dc5 ^ bytes.length;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return 'a' + (h >>> 0).toString(36) + bytes.length.toString(36);
  }

  function normalizePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }

  /* ------------------------------------------------------------- Stats */

  const stats = {
    data: ls.get('stats', {}),
    timer: 0,
    save() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => ls.set('stats', this.data), 400);
    },
    get(id) { return this.data[id] || { p: 0, l: 0, a: 0 }; },
    seen(ids) {
      const now = Date.now();
      let changed = false;
      for (const id of ids) if (!this.data[id]) { this.data[id] = { p: 0, l: 0, a: now }; changed = true; }
      if (changed) this.save();
    },
    played(id) {
      const s = this.data[id] || (this.data[id] = { p: 0, l: 0, a: Date.now() });
      s.p += 1;
      s.l = Date.now();
      this.save();
    },
    reset() { this.data = {}; ls.remove('stats'); }
  };

  /* ----------------------------------------------------------- Entries */

  async function entriesFromHandle(root) {
    const out = [];
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue;
        const path = prefix ? prefix + '/' + name : name;
        if (handle.kind === 'directory') await walk(handle, path);
        else if (AUDIO.test(name) || LRC.test(name) || M3U.test(name) || COVER.test(name)) {
          out.push({ path, name, folder: prefix, getFile: () => handle.getFile() });
        }
      }
    }
    await walk(root, '');
    return out;
  }

  function entriesFromFiles(files) {
    const list = Array.from(files);
    const rel = (f) => f.webkitRelativePath || f.name;
    // Drop the common top-level folder (the one the user picked) so paths match the handle-based layout.
    const firsts = new Set(list.map((f) => rel(f).split('/')[0]));
    const strip = firsts.size === 1 && list.every((f) => rel(f).includes('/'));
    const rootName = strip ? [...firsts][0] : '';
    const entries = [];
    for (const f of list) {
      if (!(AUDIO.test(f.name) || LRC.test(f.name) || M3U.test(f.name) || COVER.test(f.name))) continue;
      let path = rel(f);
      if (strip) path = path.slice(rootName.length + 1);
      const i = path.lastIndexOf('/');
      entries.push({ path, name: f.name, folder: i < 0 ? '' : path.slice(0, i), getFile: () => Promise.resolve(f) });
    }
    return { entries, rootName };
  }

  /* ----------------------------------------------------------- Library */

  class Library extends EventTarget {
    constructor() {
      super();
      this.reset();
      this.artBlobs = new Map();
      this.artURLs = new Map();
      this.artWritten = new Set();
    }

    reset() {
      this.rootName = '';
      this.tracks = [];
      this.byId = new Map();
      this.albums = [];
      this.albumByKey = new Map();
      this.artists = [];
      this.artistByName = new Map();
      this.folders = new Map();
      this.playlists = [];
      this.lrcEntries = new Map();
      this.imageEntries = new Map();
    }

    async load(entries, rootName) {
      const audio = [];
      const lists = [];
      const lrcEntries = new Map();
      const imageEntries = new Map();
      for (const e of entries) {
        if (AUDIO.test(e.name)) audio.push(e);
        else if (LRC.test(e.name)) lrcEntries.set(stripExt(e.path).toLowerCase(), e);
        else if (M3U.test(e.name)) lists.push(e);
        else if (COVER.test(e.name)) {
          const prev = imageEntries.get(e.folder);
          if (!prev || /^cover/i.test(e.name)) imageEntries.set(e.folder, e);
        }
      }

      const total = audio.length;
      const tracks = new Array(total);
      let next = 0, done = 0;
      this.dispatchEvent(new CustomEvent('progress', { detail: { done, total } }));
      const work = async () => {
        while (next < total) {
          const i = next++;
          tracks[i] = await this.indexOne(audio[i]);
          done++;
          if (done % 12 === 0 || done === total) this.dispatchEvent(new CustomEvent('progress', { detail: { done, total } }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total || 1) }, work));

      this.reset();
      this.rootName = rootName || '';
      this.lrcEntries = lrcEntries;
      this.imageEntries = imageEntries;
      this.tracks = tracks.filter(Boolean);
      for (const t of this.tracks) {
        if (!t.artKey && imageEntries.has(t.folder)) t.artKey = 'folder:' + t.folder;
        t.lrc = lrcEntries.get(stripExt(t.path).toLowerCase()) || null;
        this.byId.set(t.id, t);
      }
      stats.seen(this.tracks.map((t) => t.id));
      this.build();
      await this.loadPlaylists(lists);
      this.dispatchEvent(new Event('change'));
    }

    async indexOne(entry) {
      let file;
      try { file = await entry.getFile(); } catch (e) { return null; }
      const key = `${entry.path}|${file.size}|${file.lastModified}`;
      let meta = await idb.get('meta', key);
      if (!meta) {
        meta = await H.metadata.parse(file);
        meta.artKey = '';
        if (meta.picture && meta.picture.data.length) {
          const artKey = hashBytes(meta.picture.data);
          meta.artKey = artKey;
          if (!this.artWritten.has(artKey)) {
            this.artWritten.add(artKey);
            const blob = new Blob([meta.picture.data], { type: meta.picture.mime });
            this.artBlobs.set(artKey, blob);
            idb.put('art', artKey, blob);
          }
        }
        delete meta.picture;
        idb.put('meta', key, meta);
      }
      const base = stripExt(entry.name);
      const t = Object.assign({}, meta, {
        id: entry.path,
        path: entry.path,
        name: entry.name,
        folder: entry.folder,
        getFile: entry.getFile,
        size: file.size,
        mtime: file.lastModified
      });
      if (!t.title) t.title = base.replace(/^\d{1,3}[\s._-]+/, '') || base;
      if (!t.artist) t.artist = 'Unknown Artist';
      if (!t.album) t.album = entry.folder ? entry.folder.split('/').pop() : 'Unknown Album';
      if (!t.track) { const m = base.match(/^(\d{1,3})[\s._-]/); if (m) t.track = parseInt(m[1], 10); }
      t.format = H.metadata.formatLabel(t);
      t.search = fold(`${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre} ${t.name}`);
      return t;
    }

    build() {
      const albums = new Map();
      const artists = new Map();
      const folders = new Map();
      const folderNode = (path) => {
        let node = folders.get(path);
        if (node) return node;
        const i = path.lastIndexOf('/');
        node = { path, name: path ? path.slice(i + 1) : (this.rootName || 'Library'), parent: path ? (i < 0 ? '' : path.slice(0, i)) : null, children: new Set(), tracks: [] };
        folders.set(path, node);
        if (path) folderNode(node.parent).children.add(path);
        return node;
      };

      for (const t of this.tracks) {
        const albumArtist = t.albumArtist || t.artist;
        const key = fold(albumArtist) + '\u0001' + fold(t.album);
        let al = albums.get(key);
        if (!al) {
          al = { key, title: t.album, artist: albumArtist, year: t.year, tracks: [], artKey: '', duration: 0 };
          albums.set(key, al);
        }
        al.tracks.push(t);
        al.duration += t.duration || 0;
        if (!al.artKey && t.artKey) al.artKey = t.artKey;
        if (!al.year && t.year) al.year = t.year;
        t.albumKey = key;

        let ar = artists.get(fold(albumArtist));
        if (!ar) { ar = { name: albumArtist, albums: [], tracks: [] }; artists.set(fold(albumArtist), ar); }
        ar.tracks.push(t);
        if (!ar.albums.includes(al)) ar.albums.push(al);

        folderNode(t.folder).tracks.push(t);
      }

      const byAlbumOrder = (a, b) => (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) || compare(a.name, b.name);
      for (const al of albums.values()) {
        al.tracks.sort(byAlbumOrder);
        al.format = al.tracks[0].format;
        // Tracks without their own art borrow the album's.
        if (al.artKey) for (const t of al.tracks) if (!t.artKey) t.artKey = al.artKey;
      }
      for (const ar of artists.values()) ar.albums.sort((a, b) => compare(a.year, b.year) || compare(a.title, b.title));
      for (const f of folders.values()) f.tracks.sort(byAlbumOrder);

      this.tracks.sort((a, b) => compare(a.title, b.title) || compare(a.artist, b.artist));
      this.albums = [...albums.values()].sort((a, b) => compare(a.title, b.title));
      this.albumByKey = albums;
      this.artists = [...artists.values()].sort((a, b) => compare(a.name, b.name));
      this.artistByName = artists;
      this.folders = folders;
    }

    async loadPlaylists(entries) {
      const byPath = new Map();
      const byTail = new Map();
      for (const t of this.tracks) {
        const lower = t.path.toLowerCase();
        byPath.set(lower, t);
        const segs = lower.split('/');
        byTail.set(segs.slice(-2).join('/'), t);
        if (!byTail.has(segs[segs.length - 1])) byTail.set(segs[segs.length - 1], t);
      }
      const resolve = (folder, ref) => {
        let r = ref.trim().replace(/\\/g, '/');
        try { if (/^file:\/\//i.test(r)) r = decodeURIComponent(r.replace(/^file:\/\/[^/]*/i, '')); } catch (e) { /* keep raw */ }
        const absolute = /^(\/|[a-z]:\/)/i.test(r);
        if (!absolute) {
          const hit = byPath.get(normalizePath((folder ? folder + '/' : '') + r).toLowerCase());
          if (hit) return hit;
        }
        const segs = normalizePath(r).toLowerCase().split('/');
        return byTail.get(segs.slice(-2).join('/')) || byTail.get(segs[segs.length - 1]) || null;
      };

      const playlists = [];
      for (const e of entries) {
        try {
          const text = await (await e.getFile()).text();
          const tracks = [];
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim() || line.startsWith('#')) continue;
            const t = resolve(e.folder, line);
            if (t) tracks.push(t);
          }
          playlists.push({ id: e.path, name: stripExt(e.name), path: e.path, tracks });
        } catch (err) { /* unreadable playlist */ }
      }
      this.playlists = playlists.sort((a, b) => compare(a.name, b.name));
    }

    smart(kind) {
      const s = (t) => stats.get(t.id);
      if (kind === 'recent') {
        return [...this.tracks].sort((a, b) => s(b).a - s(a).a || b.mtime - a.mtime).slice(0, 100);
      }
      if (kind === 'heavy') {
        return this.tracks.filter((t) => s(t).p > 0).sort((a, b) => s(b).p - s(a).p || s(b).l - s(a).l).slice(0, 100);
      }
      if (kind === 'never') {
        return this.tracks.filter((t) => !s(t).p).sort((a, b) => compare(a.artist, b.artist) || compare(a.album, b.album) || (a.track || 0) - (b.track || 0));
      }
      return [];
    }

    search(query) {
      const terms = fold(query).split(/\s+/).filter(Boolean);
      if (!terms.length) return { tracks: [], albums: [], artists: [] };
      const match = (text) => terms.every((term) => text.includes(term));
      return {
        tracks: this.tracks.filter((t) => match(t.search)).slice(0, 300),
        albums: this.albums.filter((a) => match(fold(a.title + ' ' + a.artist))).slice(0, 12),
        artists: this.artists.filter((a) => match(fold(a.name))).slice(0, 8)
      };
    }

    async artURL(artKey) {
      if (!artKey) return null;
      if (this.artURLs.has(artKey)) return this.artURLs.get(artKey);
      const p = (async () => {
        let blob = this.artBlobs.get(artKey);
        if (!blob && artKey.startsWith('folder:')) {
          const e = this.imageEntries.get(artKey.slice(7));
          if (e) blob = await e.getFile().catch(() => null);
        }
        if (!blob) blob = await idb.get('art', artKey);
        return blob ? URL.createObjectURL(blob) : null;
      })();
      this.artURLs.set(artKey, p);
      return p;
    }

    async lyricsFor(track) {
      if (track.lrc) {
        try { return H.lrc.parse(await (await track.lrc.getFile()).text()); } catch (e) { /* fall through */ }
      }
      if (track.lyrics) return H.lrc.parse(track.lyrics);
      return null;
    }

    async forget() {
      await idb.clear('meta');
      await idb.clear('art');
      await idb.del('kv', 'root');
      stats.reset();
      for (const p of this.artURLs.values()) p.then((u) => u && URL.revokeObjectURL(u));
      this.artURLs.clear();
      this.artBlobs.clear();
      this.artWritten.clear();
      this.reset();
      this.dispatchEvent(new Event('change'));
    }
  }

  H.Library = Library;
  H.stats = stats;
  H.entries = { fromHandle: entriesFromHandle, fromFiles: entriesFromFiles, AUDIO, LRC, M3U, COVER };
  H.util = { compare, fold };
})(window.Helium = window.Helium || {});
