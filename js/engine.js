/*
 * Helium — audio engine with dual-buffer preloading.
 * Two <audio> elements alternate: while one plays, the next track is decoded into the standby
 * element. As the current track reaches its end, the standby starts on a tight timer so the hand-off
 * happens without the silence of a fresh load. (Encoder padding inside MP3/AAC files can still leave
 * a few milliseconds; FLAC, ALAC and WAV hand off cleanly.)
 */
(function (H) {
  'use strict';

  const HANDOFF = 0.012; // seconds before the end at which the standby element is started

  function makeElement() {
    const el = new Audio();
    el.preload = 'auto';
    return el;
  }

  class Engine extends EventTarget {
    constructor() {
      super();
      this.els = [makeElement(), makeElement()];
      this.urls = [null, null];
      this.idx = 0;
      this.track = null;
      this.nextTrack = null;
      this.nextReady = false;
      this.gapless = true;
      this._volume = 1;
      this._timer = 0;
      this._loadToken = 0;

      for (const el of this.els) {
        const forward = (type) => el.addEventListener(type, () => { if (el === this.el) this.emit(type); });
        ['timeupdate', 'play', 'pause', 'durationchange', 'loadedmetadata', 'seeked', 'waiting', 'playing'].forEach(forward);
        el.addEventListener('play', () => { if (el === this.el) this.watch(); });
        el.addEventListener('ended', () => { if (el === this.el) this.emit('ended'); });
        el.addEventListener('error', () => { if (el === this.el && el.src) this.recover(el); });
        el.addEventListener('playing', () => { if (el === this.el) this._recovering = false; });
        el.addEventListener('canplaythrough', () => { if (el === this.standby && this.nextTrack) this.nextReady = true; });
      }
    }

    get el() { return this.els[this.idx]; }
    get standby() { return this.els[1 - this.idx]; }
    get paused() { return this.el.paused; }
    get currentTime() { return this.el.currentTime || 0; }
    get duration() {
      const d = this.el.duration;
      return isFinite(d) && d > 0 ? d : (this.track && this.track.duration) || 0;
    }
    get volume() { return this._volume; }
    set volume(v) {
      this._volume = Math.max(0, Math.min(1, v));
      for (const el of this.els) el.volume = this._volume;
      this.emit('volumechange');
    }

    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    setSource(i, file) {
      if (this.urls[i]) URL.revokeObjectURL(this.urls[i]);
      this.urls[i] = file ? URL.createObjectURL(file) : null;
      const el = this.els[i];
      if (this.urls[i]) el.src = this.urls[i];
      else { el.removeAttribute('src'); el.load(); }
    }

    async load(track, { autoplay = true, startAt = 0 } = {}) {
      const token = ++this._loadToken;
      // Re-use the preloaded standby element when it already holds this track.
      if (this.nextTrack === track && this.standby.src && !this.standby.error) {
        this.el.pause();
        this.idx = 1 - this.idx;
        this.nextTrack = null;
        this.nextReady = false;
        this.setSource(1 - this.idx, null);
      } else {
        let file;
        try { file = await track.getFile(); } catch (e) { this.emit('error'); return; }
        if (token !== this._loadToken) return;
        this.el.pause();
        this.setSource(this.idx, file);
      }
      this.track = track;
      this._lastPos = startAt || 0;
      const el = this.el;
      el.volume = this._volume;
      try { el.currentTime = startAt; } catch (e) { /* not seekable yet */ }
      if (startAt) el.addEventListener('loadedmetadata', () => { el.currentTime = startAt; }, { once: true });
      this.emit('track', { track, gapless: false });
      if (autoplay) await this.play();
      else { this._wantPlay = false; this.emit('pause'); }
    }

    async preload(track) {
      if (!this.gapless || !track) {
        this.nextTrack = null;
        this.nextReady = false;
        if (this.standby.src) this.setSource(1 - this.idx, null);
        return;
      }
      if (this.nextTrack === track) return;
      this.nextTrack = track;
      this.nextReady = false;
      const wait = 250 - (performance.now() - (this._handoffAt || 0));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this.nextTrack !== track) return;
      let file;
      try { file = await track.getFile(); } catch (e) { this.nextTrack = null; return; }
      if (this.nextTrack !== track) return;
      const sb = this.standby;
      this.setSource(1 - this.idx, file);
      sb.volume = this._volume;
      sb.load();
    }

    async play() {
      this._wantPlay = true;
      if (!this.el.src) return;
      try { await this.el.play(); } catch (e) { if (e.name !== 'AbortError') this.emit('pause'); }
    }
    pause() { this._wantPlay = false; this.el.pause(); }
    toggle() { return this.el.paused ? this.play() : this.pause(); }

    get recovering() { return !!this._recovering; }

    seek(t) {
      const d = this.duration;
      if (!d) return;
      // Stay a little clear of the very end: some demuxers fail on a seek into the last frame.
      this._lastPos = Math.max(0, Math.min(d - 0.25, t));
      this.el.currentTime = this._lastPos;
      this.emit('timeupdate');
    }

    // A decode/read error on a file that was already playing is usually a failed seek, not a bad file.
    // Near the end, treat it as the end of the track; otherwise reload once at the last good position.
    recover(el) {
      const code = el.error ? el.error.code : 0;
      const pos = el.currentTime || this._lastPos || 0;
      if (code !== 4 && this.track && !this._recovering) {
        if (this.duration && this.duration - pos < 1.5) { this.emit('ended'); return; }
        this._recovering = true;
        this.load(this.track, { autoplay: this._wantPlay, startAt: Math.max(0, pos - 0.1) });
        return;
      }
      this._recovering = false;
      this.emit('error', { code });
    }

    // Adaptive timer: coarse while far from the end, tight (≈4ms) in the final 300ms.
    watch() {
      clearTimeout(this._timer);
      const tick = () => {
        const el = this.el;
        if (el.paused) return;
        const remaining = this.duration - el.currentTime;
        if (this.gapless && this.nextTrack && this.nextReady && remaining <= HANDOFF && this.duration > 1) {
          this.handoff();
          return;
        }
        this._timer = setTimeout(tick, remaining < 0.3 ? 4 : remaining < 2 ? 40 : 250);
      };
      tick();
    }

    handoff() {
      const old = this.el;
      const next = this.standby;
      const track = this.nextTrack;
      next.currentTime = 0;
      next.volume = this._volume;
      const p = next.play();
      this.idx = 1 - this.idx;
      this.track = track;
      this.nextTrack = null;
      this.nextReady = false;
      // Let the outgoing element finish its last few milliseconds; preload() waits before re-using it.
      this._handoffAt = performance.now();
      setTimeout(() => { if (old !== this.el && !old.paused) old.pause(); }, 200);
      this.emit('track', { track, gapless: true });
      if (p && p.catch) p.catch(() => this.emit('pause'));
      this.watch();
    }

    stop() {
      clearTimeout(this._timer);
      for (const el of this.els) el.pause();
      this.setSource(0, null);
      this.setSource(1, null);
      this.track = null;
      this.nextTrack = null;
      this.emit('pause');
    }
  }

  H.Engine = Engine;
})(window.Helium = window.Helium || {});
