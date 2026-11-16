/*
 * Helium: metadata reader.
 * Reads tags, embedded cover art and stream properties straight from local
 * files, without external libraries. Supported containers:
 *   ID3v2.2/2.3/2.4 (+ID3v1) · MPEG audio (MP3) · ADTS AAC · FLAC (Vorbis comments, PICTURE)
 *   Ogg Vorbis / Opus · MP4/M4A (AAC, ALAC; iTunes ilst atoms) · RIFF WAVE (LIST/INFO, id3 chunk)
 * Only the byte ranges that are needed are read, so even large lossless files index quickly.
 */
(function (root) {
  'use strict';

  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  const utf16le = new TextDecoder('utf-16le');
  const utf16be = new TextDecoder('utf-16be');

  async function read(file, start, end) {
    return new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
  }
  const str = (b, o, n) => latin1.decode(b.subarray(o, o + n));
  const u16be = (b, o) => (b[o] << 8) | b[o + 1];
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u24be = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const u32le = (b, o) => ((b[o + 3] << 24) >>> 0) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o]);
  const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  const clean = (s) => (s || '').replace(/\0+$/g, '').replace(/\0/g, ', ').trim();

  function emptyMeta() {
    return {
      title: '', artist: '', album: '', albumArtist: '', genre: '', year: '',
      track: 0, trackTotal: 0, disc: 0,
      duration: 0, codec: '', lossless: false, sampleRate: 0, bitDepth: 0, bitrate: 0, channels: 0,
      picture: null, // { mime, data: Uint8Array }
      lyrics: ''
    };
  }

  function setNumberPair(meta, value, key, totalKey) {
    const m = String(value).match(/(\d+)(?:\s*\/\s*(\d+))?/);
    if (!m) return;
    if (!meta[key]) meta[key] = parseInt(m[1], 10);
    if (totalKey && m[2] && !meta[totalKey]) meta[totalKey] = parseInt(m[2], 10);
  }

  function setIfEmpty(meta, key, value) {
    if (value && !meta[key]) meta[key] = value;
  }

  /* ------------------------------------------------------------------ ID3v2 */

  function deunsync(b) {
    const out = new Uint8Array(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
      out[j++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  function decodeText(enc, b) {
    if (!b.length) return '';
    switch (enc) {
      case 1: // UTF-16 with BOM
        if (b[0] === 0xfe && b[1] === 0xff) return clean(utf16be.decode(b.subarray(2)));
        if (b[0] === 0xff && b[1] === 0xfe) return clean(utf16le.decode(b.subarray(2)));
        return clean(utf16le.decode(b));
      case 2: return clean(utf16be.decode(b));
      case 3: return clean(utf8.decode(b));
      default: return clean(latin1.decode(b));
    }
  }

  // Index of the encoding-appropriate terminator at or after `start`.
  function findTerminator(b, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
      return b.length;
    }
    const i = b.indexOf(0, start);
    return i < 0 ? b.length : i;
  }
  const termLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

  const ID3V22 = { TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TCO: 'TCON', PIC: 'APIC', ULT: 'USLT' };

  function parseID3(tag, meta) {
    const ver = tag[3];
    const flags = tag[5];
    const size = synchsafe(tag, 6);
    let b = tag.subarray(0, 10 + size);
    if (ver < 4 && (flags & 0x80)) {
      const body = deunsync(b.subarray(10));
      const merged = new Uint8Array(10 + body.length);
      merged.set(b.subarray(0, 10));
      merged.set(body, 10);
      b = merged;
    }
    let pos = 10;
    if (flags & 0x40) pos += ver === 3 ? 4 + u32be(b, 10) : ver === 4 ? synchsafe(b, 10) : 0;

    let picture = null;
    while (pos < b.length) {
      let id, fsize, hsize, fflags = 0;
      if (ver === 2) {
        if (pos + 6 > b.length) break;
        id = ID3V22[str(b, pos, 3)] || str(b, pos, 3);
        fsize = u24be(b, pos + 3);
        hsize = 6;
      } else {
        if (pos + 10 > b.length) break;
        id = str(b, pos, 4);
        fsize = ver === 4 ? synchsafe(b, pos + 4) : u32be(b, pos + 4);
        fflags = b[pos + 9];
        hsize = 10;
      }
      if (!/^[A-Z0-9]{3,4}$/.test(id) || fsize <= 0) break;
      let d = b.subarray(pos + hsize, pos + hsize + fsize);
      pos += hsize + fsize;

      if (ver === 4) {
        if (fflags & 0x0c) continue; // compressed / encrypted
        if (fflags & 0x01) d = d.subarray(4); // data length indicator
        if (fflags & 0x02) d = deunsync(d);
      } else if (ver === 3) {
        if (fflags & 0xc0) continue;
        if (fflags & 0x20) d = d.subarray(1);
      }
      if (!d.length) continue;

      if (id[0] === 'T' && id !== 'TXXX') {
        const text = decodeText(d[0], d.subarray(1));
        switch (id) {
          case 'TIT2': setIfEmpty(meta, 'title', text); break;
          case 'TPE1': setIfEmpty(meta, 'artist', text); break;
          case 'TPE2': setIfEmpty(meta, 'albumArtist', text); break;
          case 'TALB': setIfEmpty(meta, 'album', text); break;
          case 'TRCK': setNumberPair(meta, text, 'track', 'trackTotal'); break;
          case 'TPOS': setNumberPair(meta, text, 'disc'); break;
          case 'TYER': case 'TDRC': case 'TORY': setIfEmpty(meta, 'year', text.slice(0, 4)); break;
          case 'TCON': setIfEmpty(meta, 'genre', text.replace(/^\(\d+\)/, '').trim() || text); break;
        }
      } else if (id === 'APIC') {
        const enc = d[0];
        let p, mime;
        if (ver === 2) {
          const fmt = str(d, 1, 3).toUpperCase();
          mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
          p = 4;
        } else {
          const end = d.indexOf(0, 1);
          mime = str(d, 1, end - 1).toLowerCase() || 'image/jpeg';
          if (!mime.includes('/')) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
          p = end + 1;
        }
        const type = d[p];
        const descEnd = findTerminator(d, p + 1, enc);
        const data = d.subarray(descEnd + termLen(enc));
        if (data.length && (!picture || (type === 3 && picture.type !== 3))) picture = { type, mime, data };
      } else if (id === 'USLT' && !meta.lyrics) {
        const enc = d[0];
        const descEnd = findTerminator(d, 4, enc);
        meta.lyrics = decodeText(enc, d.subarray(descEnd + termLen(enc)));
      }
    }
    if (picture && !meta.picture) meta.picture = { mime: picture.mime, data: picture.data.slice() };
  }

  function parseID3v1(b, meta) {
    if (str(b, 0, 3) !== 'TAG') return;
    const s = (o, n) => clean(latin1.decode(b.subarray(o, o + n)));
    setIfEmpty(meta, 'title', s(3, 30));
    setIfEmpty(meta, 'artist', s(33, 30));
    setIfEmpty(meta, 'album', s(63, 30));
    setIfEmpty(meta, 'year', s(93, 4));
    if (b[125] === 0 && b[126] && !meta.track) meta.track = b[126];
  }

  /* --------------------------------------------------------- MPEG / ADTS */

  const BR = {
    V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  const SR_MPEG = [44100, 48000, 32000];
  const SR_ADTS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function mpegHeader(b, i) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
    const verBits = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (b[i + 1] >> 1) & 3; // 1 = L3, 2 = L2, 3 = L1
    const brIdx = b[i + 2] >> 4;
    const srIdx = (b[i + 2] >> 2) & 3;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const v1 = verBits === 3;
    const layer = 4 - layerBits;
    const table = v1 ? (layer === 1 ? BR.V1L1 : layer === 2 ? BR.V1L2 : BR.V1L3) : (layer === 1 ? BR.V2L1 : BR.V2L3);
    const bitrate = table[brIdx] * 1000;
    const sampleRate = SR_MPEG[srIdx] / (v1 ? 1 : verBits === 2 ? 2 : 4);
    const padding = (b[i + 2] >> 1) & 1;
    const mono = (b[i + 3] >> 6) === 3;
    const spf = layer === 1 ? 384 : layer === 3 && !v1 ? 576 : 1152;
    const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor((spf / 8) * bitrate / sampleRate) + padding;
    return { v1, layer, bitrate, sampleRate, mono, spf, length };
  }

  async function parseMPEG(file, start, meta, tailHasID3v1) {
    const b = await read(file, start, start + 131072);
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] !== 0xff) continue;
      // ADTS AAC (layer bits 00)
      if ((b[i + 1] & 0xf6) === 0xf0) {
        const sr = SR_ADTS[(b[i + 2] >> 2) & 0xf];
        if (!sr) continue;
        meta.codec = 'AAC';
        meta.sampleRate = sr;
        meta.channels = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
        return;
      }
      const h = mpegHeader(b, i);
      if (!h) continue;
      // Confirm with the following frame to avoid false syncs inside garbage data.
      if (i + h.length + 4 < b.length && !mpegHeader(b, i + h.length)) continue;

      meta.codec = h.layer === 3 ? 'MP3' : 'MP' + h.layer;
      meta.sampleRate = h.sampleRate;
      meta.channels = h.mono ? 1 : 2;
      const side = h.v1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
      const x = i + 4 + side;
      const xing = str(b, x, 4);
      let frames = 0, bytes = 0;
      if (xing === 'Xing' || xing === 'Info') {
        const flags = u32be(b, x + 4);
        let p = x + 8;
        if (flags & 1) { frames = u32be(b, p); p += 4; }
        if (flags & 2) bytes = u32be(b, p);
      } else if (str(b, i + 36, 4) === 'VBRI') {
        bytes = u32be(b, i + 36 + 10);
        frames = u32be(b, i + 36 + 14);
      }
      const audioBytes = file.size - start - i - (tailHasID3v1 ? 128 : 0);
      if (frames) {
        meta.duration = (frames * h.spf) / h.sampleRate;
        meta.bitrate = xing === 'Info' ? h.bitrate : Math.round(((bytes || audioBytes) * 8) / meta.duration);
      } else {
        meta.bitrate = h.bitrate;
        meta.duration = (audioBytes * 8) / h.bitrate;
      }
      return;
    }
  }

  /* ------------------------------------------------------ Vorbis comments */

  function parseFlacPicture(b, o) {
    const type = u32be(b, o);
    const mimeLen = u32be(b, o + 4);
    const mime = str(b, o + 8, mimeLen) || 'image/jpeg';
    let p = o + 8 + mimeLen;
    p += 4 + u32be(b, p); // description
    p += 16; // width, height, depth, colours
    const len = u32be(b, p);
    return { type, mime, data: b.slice(p + 4, p + 4 + len) };
  }

  function base64ToBytes(s) {
    const bin = atob(s.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function parseVorbisComments(b, o, meta) {
    const end = b.length;
    o += 4 + u32le(b, o); // vendor
    const n = u32le(b, o);
    o += 4;
    const multi = {};
    for (let i = 0; i < n && o + 4 <= end; i++) {
      const len = u32le(b, o);
      const s = utf8.decode(b.subarray(o + 4, o + 4 + len));
      o += 4 + len;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const key = s.slice(0, eq).toUpperCase();
      const val = s.slice(eq + 1).trim();
      if (key === 'METADATA_BLOCK_PICTURE') {
        try {
          const pic = parseFlacPicture(base64ToBytes(val), 0);
          if (!meta.picture || pic.type === 3) meta.picture = { mime: pic.mime, data: pic.data };
        } catch (e) { /* malformed picture */ }
        continue;
      }
      (multi[key] = multi[key] || []).push(val);
    }
    const get = (k) => (multi[k] ? multi[k].join(', ') : '');
    setIfEmpty(meta, 'title', get('TITLE'));
    setIfEmpty(meta, 'artist', get('ARTIST'));
    setIfEmpty(meta, 'album', get('ALBUM'));
    setIfEmpty(meta, 'albumArtist', get('ALBUMARTIST') || get('ALBUM ARTIST'));
    setIfEmpty(meta, 'genre', get('GENRE'));
    setIfEmpty(meta, 'year', (get('DATE') || get('YEAR')).slice(0, 4));
    setIfEmpty(meta, 'lyrics', get('LYRICS') || get('UNSYNCEDLYRICS'));
    if (multi.TRACKNUMBER) setNumberPair(meta, multi.TRACKNUMBER[0], 'track', 'trackTotal');
    if (!meta.trackTotal && (multi.TRACKTOTAL || multi.TOTALTRACKS)) meta.trackTotal = parseInt((multi.TRACKTOTAL || multi.TOTALTRACKS)[0], 10) || 0;
    if (multi.DISCNUMBER) setNumberPair(meta, multi.DISCNUMBER[0], 'disc');
  }

  /* ---------------------------------------------------------------- FLAC */

  async function parseFLAC(file, start, meta) {
    meta.codec = 'FLAC';
    meta.lossless = true;
    let pos = start + 4;
    for (let guard = 0; guard < 128 && pos + 4 <= file.size; guard++) {
      const h = await read(file, pos, pos + 4);
      const last = h[0] & 0x80;
      const type = h[0] & 0x7f;
      const len = u24be(h, 1);
      if (type === 0 || type === 4 || type === 6) {
        const b = await read(file, pos + 4, pos + 4 + len);
        if (type === 0) {
          meta.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
          meta.channels = ((b[12] >> 1) & 7) + 1;
          meta.bitDepth = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
          const total = (b[13] & 0x0f) * 4294967296 + u32be(b, 14);
          if (meta.sampleRate && total) meta.duration = total / meta.sampleRate;
        } else if (type === 4) {
          parseVorbisComments(b, 0, meta);
        } else if (type === 6) {
          const pic = parseFlacPicture(b, 0);
          if (!meta.picture || pic.type === 3) meta.picture = { mime: pic.mime, data: pic.data };
        }
      }
      pos += 4 + len;
      if (last) break;
    }
    if (meta.duration) meta.bitrate = Math.round((file.size * 8) / meta.duration);
  }

  /* ----------------------------------------------------------------- Ogg */

  function oggPackets(b, want) {
    const packets = [];
    let cur = [];
    let o = 0;
    while (o + 27 <= b.length && packets.length < want) {
      if (str(b, o, 4) !== 'OggS') return { packets, complete: false };
      const nseg = b[o + 26];
      const lace = b.subarray(o + 27, o + 27 + nseg);
      let p = o + 27 + nseg;
      for (let i = 0; i < nseg; i++) {
        if (p + lace[i] > b.length) return { packets, complete: false };
        cur.push(b.subarray(p, p + lace[i]));
        p += lace[i];
        if (lace[i] < 255) {
          const total = cur.reduce((n, c) => n + c.length, 0);
          const pk = new Uint8Array(total);
          let q = 0;
          for (const c of cur) { pk.set(c, q); q += c.length; }
          packets.push(pk);
          cur = [];
          if (packets.length >= want) break;
        }
      }
      o = p;
    }
    return { packets, complete: packets.length >= want };
  }

  async function parseOgg(file, start, meta) {
    let span = 262144;
    let packets = [];
    for (;;) {
      const b = await read(file, start, start + span);
      const r = oggPackets(b, 2);
      packets = r.packets;
      if (r.complete || start + span >= file.size || span >= 16777216) break;
      span *= 4;
    }
    if (!packets.length) return;
    const id = packets[0];
    let rate = 0, preskip = 0;
    if (str(id, 0, 7) === '\x01vorbis') {
      meta.codec = 'Vorbis';
      meta.channels = id[11];
      meta.sampleRate = rate = u32le(id, 12);
      const nominal = u32le(id, 20) | 0;
      if (nominal > 0) meta.bitrate = nominal;
      if (packets[1] && str(packets[1], 0, 7) === '\x03vorbis') parseVorbisComments(packets[1], 7, meta);
    } else if (str(id, 0, 8) === 'OpusHead') {
      meta.codec = 'Opus';
      meta.channels = id[9];
      preskip = u16le(id, 10);
      meta.sampleRate = u32le(id, 12) || 48000;
      rate = 48000;
      if (packets[1] && str(packets[1], 0, 8) === 'OpusTags') parseVorbisComments(packets[1], 8, meta);
    } else if (str(id, 0, 5) === '\x7fFLAC') {
      meta.codec = 'FLAC';
      meta.lossless = true;
      const si = id.subarray(13 + 4);
      rate = meta.sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      meta.channels = ((si[12] >> 1) & 7) + 1;
      meta.bitDepth = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
      if (packets[1]) parseVorbisComments(packets[1], 4, meta);
    }
    if (!rate) return;
    // Duration: granule position of the last page.
    const tail = await read(file, Math.max(start, file.size - 65536), file.size);
    for (let i = tail.length - 27; i >= 0; i--) {
      if (tail[i] === 0x4f && str(tail, i, 4) === 'OggS') {
        const granule = u32le(tail, i + 10) * 4294967296 + u32le(tail, i + 6);
        if (granule > 0 && granule < 2 ** 52) {
          meta.duration = Math.max(0, granule - preskip) / rate;
          break;
        }
      }
    }
    if (meta.duration && !meta.bitrate) meta.bitrate = Math.round((file.size * 8) / meta.duration);
  }

  /* ---------------------------------------------------------------- WAVE */

  async function parseWAV(file, meta) {
    meta.codec = 'WAV';
    meta.lossless = true;
    let pos = 12;
    let byteRate = 0;
    for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
      const h = await read(file, pos, pos + 8);
      const id = str(h, 0, 4);
      const size = u32le(h, 4);
      if (id === 'fmt ') {
        const b = await read(file, pos + 8, pos + 8 + Math.min(size, 64));
        const format = u16le(b, 0);
        meta.channels = u16le(b, 2);
        meta.sampleRate = u32le(b, 4);
        byteRate = u32le(b, 8);
        meta.bitDepth = u16le(b, 14);
        meta.bitrate = byteRate * 8;
        if (format === 3) meta.codec = 'WAV';
      } else if (id === 'data') {
        if (byteRate) meta.duration = Math.min(size, file.size - pos - 8) / byteRate;
      } else if (id === 'LIST' && size < 4194304) {
        const b = await read(file, pos + 8, pos + 8 + size);
        if (str(b, 0, 4) === 'INFO') {
          let o = 4;
          while (o + 8 <= b.length) {
            const sid = str(b, o, 4);
            const ssize = u32le(b, o + 4);
            const val = clean(utf8.decode(b.subarray(o + 8, o + 8 + ssize)));
            if (sid === 'INAM') setIfEmpty(meta, 'title', val);
            else if (sid === 'IART') setIfEmpty(meta, 'artist', val);
            else if (sid === 'IPRD') setIfEmpty(meta, 'album', val);
            else if (sid === 'ICRD') setIfEmpty(meta, 'year', val.slice(0, 4));
            else if (sid === 'IGNR') setIfEmpty(meta, 'genre', val);
            else if (sid === 'ITRK' || sid === 'IPRT') setNumberPair(meta, val, 'track', 'trackTotal');
            o += 8 + ssize + (ssize & 1);
          }
        }
      } else if ((id === 'id3 ' || id === 'ID3 ') && size < 16777216) {
        const b = await read(file, pos + 8, pos + 8 + size);
        if (str(b, 0, 3) === 'ID3') parseID3(b, meta);
      }
      pos += 8 + size + (size & 1);
    }
  }

  /* ----------------------------------------------------------------- MP4 */

  const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst']);

  function walkAtoms(b, start, end, visit) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32be(b, o);
      const type = str(b, o + 4, 4);
      let header = 8;
      if (size === 1) { size = u32be(b, o + 8) * 4294967296 + u32be(b, o + 12); header = 16; }
      else if (size === 0) size = end - o;
      if (size < header || o + size > end) break;
      visit(type, o + header, o + size);
      o += size;
    }
  }

  function parseMoov(b, meta) {
    const visit = (type, s, e) => {
      if (MP4_CONTAINERS.has(type)) return walkAtoms(b, s, e, visit);
      if (type === 'meta') {
        const fullbox = str(b, s + 4, 4) !== 'hdlr';
        return walkAtoms(b, s + (fullbox ? 4 : 0), e, visit);
      }
      if (type === 'mvhd') {
        const v = b[s];
        const scale = v === 1 ? u32be(b, s + 20) : u32be(b, s + 12);
        const dur = v === 1 ? u32be(b, s + 24) * 4294967296 + u32be(b, s + 28) : u32be(b, s + 16);
        if (scale) meta.duration = dur / scale;
        return;
      }
      if (type === 'stsd') {
        const entry = s + 8;
        const fmt = str(b, entry + 4, 4);
        if (fmt === 'mp4a') {
          meta.codec = 'AAC';
          meta.channels = u16be(b, entry + 24);
          meta.sampleRate = u32be(b, entry + 32) >>> 16;
        } else if (fmt === 'alac') {
          meta.codec = 'ALAC';
          meta.lossless = true;
          meta.channels = u16be(b, entry + 24);
          meta.sampleRate = u32be(b, entry + 32) >>> 16;
          const c = entry + 36;
          if (str(b, c + 4, 4) === 'alac') {
            meta.bitDepth = b[c + 12 + 5];
            meta.channels = b[c + 12 + 9] || meta.channels;
            meta.sampleRate = u32be(b, c + 12 + 20) || meta.sampleRate;
          } else {
            meta.bitDepth = u16be(b, entry + 26);
          }
        } else if (fmt === 'fLaC') {
          meta.codec = 'FLAC';
          meta.lossless = true;
          meta.channels = u16be(b, entry + 24);
          meta.sampleRate = u32be(b, entry + 32) >>> 16;
          meta.bitDepth = u16be(b, entry + 26);
        } else if (fmt === 'Opus') {
          meta.codec = 'Opus';
          meta.channels = u16be(b, entry + 24);
          meta.sampleRate = 48000;
        }
        return;
      }
      // ilst items: each holds a 'data' atom.
      let dataStart = -1, dataEnd = -1, dataType = 0;
      walkAtoms(b, s, e, (t, ds, de) => {
        if (t === 'data' && dataStart < 0) { dataType = u32be(b, ds) & 0xffffff; dataStart = ds + 8; dataEnd = de; }
      });
      if (dataStart < 0) return;
      const raw = b.subarray(dataStart, dataEnd);
      const text = () => clean(utf8.decode(raw));
      switch (type) {
        case '©nam': setIfEmpty(meta, 'title', text()); break;
        case '©ART': setIfEmpty(meta, 'artist', text()); break;
        case 'aART': setIfEmpty(meta, 'albumArtist', text()); break;
        case '©alb': setIfEmpty(meta, 'album', text()); break;
        case '©gen': setIfEmpty(meta, 'genre', text()); break;
        case '©day': setIfEmpty(meta, 'year', text().slice(0, 4)); break;
        case '©lyr': setIfEmpty(meta, 'lyrics', text()); break;
        case 'trkn': if (raw.length >= 6) { meta.track = meta.track || u16be(raw, 2); meta.trackTotal = meta.trackTotal || u16be(raw, 4); } break;
        case 'disk': if (raw.length >= 4) meta.disc = meta.disc || u16be(raw, 2); break;
        case 'covr':
          if (!meta.picture) meta.picture = { mime: dataType === 14 ? 'image/png' : 'image/jpeg', data: raw.slice() };
          break;
      }
    };
    walkAtoms(b, 0, b.length, visit);
  }

  async function parseMP4(file, meta) {
    let pos = 0;
    for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
      const h = await read(file, pos, pos + 16);
      let size = u32be(h, 0);
      const type = str(h, 4, 4);
      if (size === 1) size = u32be(h, 8) * 4294967296 + u32be(h, 12);
      else if (size === 0) size = file.size - pos;
      if (size < 8) break;
      if (type === 'moov') {
        const b = await read(file, pos, pos + size);
        // Re-run the walker over the moov atom itself.
        parseMoov(b, meta);
        break;
      }
      pos += size;
    }
    if (meta.duration) meta.bitrate = Math.round((file.size * 8) / meta.duration);
  }

  /* ---------------------------------------------------------------- Entry */

  async function parse(file) {
    const meta = emptyMeta();
    try {
      const head = await read(file, 0, 12);
      let offset = 0;
      if (str(head, 0, 3) === 'ID3') {
        const size = 10 + synchsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
        parseID3(await read(file, 0, size), meta);
        offset = size;
      }
      const h = offset ? await read(file, offset, offset + 12) : head;
      const sig = str(h, 0, 4);
      if (sig === 'fLaC') await parseFLAC(file, offset, meta);
      else if (sig === 'OggS') await parseOgg(file, offset, meta);
      else if (sig === 'RIFF' && str(h, 8, 4) === 'WAVE') await parseWAV(file, meta);
      else if (str(h, 4, 4) === 'ftyp') await parseMP4(file, meta);
      else {
        let hasV1 = false;
        if (file.size > 128) {
          const tail = await read(file, file.size - 128, file.size);
          hasV1 = str(tail, 0, 3) === 'TAG';
          if (hasV1) parseID3v1(tail, meta);
        }
        await parseMPEG(file, offset, meta, hasV1);
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[helium] metadata', file.name, err);
    }
    if (!isFinite(meta.duration) || meta.duration < 0) meta.duration = 0;
    return meta;
  }

  function formatKHz(sr) {
    const k = sr / 1000;
    return (Number.isInteger(k) ? k : k.toFixed(1)) + 'kHz';
  }

  // "FLAC 24-bit / 96kHz" · "MP3 320 kbps / 44.1kHz"
  function formatLabel(m) {
    if (!m || !m.codec) return '';
    let q = '';
    if (m.lossless && m.bitDepth) q = `${m.bitDepth}-bit`;
    else if (m.bitrate) q = `${Math.round(m.bitrate / 1000)} kbps`;
    const parts = [q, m.sampleRate ? formatKHz(m.sampleRate) : ''].filter(Boolean).join(' / ');
    return parts ? `${m.codec} ${parts}` : m.codec;
  }

  const api = { parse, formatLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Helium = root.Helium || {}).metadata = api;
})(typeof self !== 'undefined' ? self : this);
