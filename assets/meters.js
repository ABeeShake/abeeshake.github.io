/* Audio meters: a MiniMeters-style player for the music page.
 *
 * Markup:
 *   <div class="meters" data-src="assets/audio/track.mp3" data-peaks="assets/audio/track.peaks.json"
 *        data-title="Track title" data-artist="Artist"></div>
 *   <script src="assets/meters.js" defer></script>
 *
 * Modules: waveform overview (click to seek), spectrum analyzer (L/R or M/S, adjustable slope),
 * spectrogram, oscilloscope, stereometer with correlation, and peak / LUFS (ITU-R BS.1770).
 * Audio must be served from the same site (browsers block analysis of other sites' audio).
 */
(() => {
  'use strict';

  const script = document.currentScript;
  const WORKLET_URL = new URL('meters-worklet.js', script ? script.src : location.href).href;

  const C = {
    bg: '#0E1018', grid: '#232838', gridSoft: '#1A1E2B', label: '#6E7590', text: '#C9CDDA',
    ind: '#8E91FF', indDeep: '#4C4FD8', org: '#F29A55', cream: '#FFE9C9', side: '#5ED0B0',
  };
  const FMIN = 20, FMAX = 20000;
  const FFT = 8192;

  let ctx = null;
  const players = [];

  function audioContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  const fmtTime = (s) => {
    if (!isFinite(s)) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  const lufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
  const fmtDb = (v, digits = 1) => (isFinite(v) && v > -99 ? v.toFixed(digits) : '−∞').replace('-', '−');

  // Colour map for the spectrogram: near-black, indigo, violet, orange, cream.
  const LUT = (() => {
    const stops = [[0, [14, 16, 24]], [0.3, [40, 42, 120]], [0.55, [120, 70, 200]], [0.78, [242, 140, 75]], [1, [255, 240, 214]]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
      const u = (t - t0) / (t1 - t0);
      for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
    }
    return lut;
  })();

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  // A canvas that keeps its backing store matched to its CSS size and pixel ratio.
  function fitCanvas(canvas, onResize) {
    const apply = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        onResize && onResize();
      }
    };
    new ResizeObserver(apply).observe(canvas);
    apply();
  }

  class Meters {
    constructor(root) {
      this.root = root;
      this.src = root.dataset.src;
      this.peaksUrl = root.dataset.peaks;
      this.mode = 'lr';        // spectrum mode: 'lr' or 'ms'
      this.slope = 4.5;        // spectrum tilt in dB per octave
      this.source = 'track';   // 'track' or 'mic'
      this.peaks = null;
      this.running = false;
      this.idleFrames = 0;
      this.corr = 0;
      this.peakHold = [-Infinity, -Infinity];
      this.peakBar = [-Infinity, -Infinity];
      this.resetLoudness();
      this.build();
      this.loadPeaks();
      this.drawAll(true);
    }

    /* ---------- DOM ---------- */

    build() {
      const r = this.root;
      r.classList.add('mm');
      r.innerHTML = '';

      this.audio = el('audio');
      this.audio.preload = 'metadata';
      this.audio.src = this.src;
      this.audio.crossOrigin = 'anonymous';
      r.appendChild(this.audio);

      const top = el('div', 'mm-top');
      this.playBtn = el('button', 'mm-play', '<span aria-hidden="true">▶</span>');
      this.playBtn.type = 'button';
      this.playBtn.setAttribute('aria-label', 'Play');
      const title = el('div', 'mm-title');
      title.appendChild(el('strong', null, this.root.dataset.title || 'Untitled'));
      if (this.root.dataset.artist) title.appendChild(el('span', null, this.root.dataset.artist));
      this.timeEl = el('div', 'mm-time', '0:00 / 0:00');
      const srcSwitch = el('div', 'mm-seg');
      srcSwitch.setAttribute('role', 'group');
      srcSwitch.setAttribute('aria-label', 'Input');
      this.trackBtn = el('button', null, 'Track'); this.trackBtn.type = 'button';
      this.micBtn = el('button', null, 'Mic'); this.micBtn.type = 'button';
      this.micBtn.title = 'Visualize your microphone instead of the track';
      srcSwitch.append(this.trackBtn, this.micBtn);
      top.append(this.playBtn, title, this.timeEl, srcSwitch);
      r.appendChild(top);

      this.wave = el('canvas', 'mm-wave');
      this.wave.tabIndex = 0;
      this.wave.setAttribute('role', 'slider');
      this.wave.setAttribute('aria-label', 'Seek');
      this.wave.setAttribute('aria-valuemin', '0');
      r.appendChild(this.wave);

      const grid = el('div', 'mm-grid');
      const mod = (cls, label, extra) => {
        const m = el('section', `mm-mod ${cls}`);
        const h = el('header');
        h.appendChild(el('span', 'mm-label', label));
        if (extra) h.appendChild(extra);
        const cv = el('canvas');
        m.append(h, cv);
        grid.appendChild(m);
        return cv;
      };

      const specCtl = el('div', 'mm-ctl');
      this.modeBtn = el('button', null, 'L / R'); this.modeBtn.type = 'button';
      this.modeBtn.title = 'Switch between left/right and mid/side';
      this.slopeBtn = el('button', null, '4.5 dB/oct'); this.slopeBtn.type = 'button';
      this.slopeBtn.title = 'Spectrum tilt, so a balanced mix reads roughly flat';
      specCtl.append(this.modeBtn, this.slopeBtn);

      this.specCv = mod('mm-spectrum', 'Spectrum', specCtl);
      this.stereoCv = mod('mm-stereo', 'Stereometer');
      this.loudCv = mod('mm-loud', 'Peak / LUFS');
      this.sgCv = mod('mm-sg', 'Spectrogram');
      this.oscCv = mod('mm-osc', 'Oscilloscope');
      r.appendChild(grid);

      this.loudRead = el('dl', 'mm-read');
      this.loudCv.parentNode.appendChild(this.loudRead);
      this.status = el('p', 'mm-status');
      this.status.setAttribute('aria-live', 'polite');
      r.appendChild(this.status);

      // Events
      this.playBtn.addEventListener('click', () => this.toggle());
      this.trackBtn.addEventListener('click', () => this.useTrack());
      this.micBtn.addEventListener('click', () => this.useMic());
      this.modeBtn.addEventListener('click', () => {
        this.mode = this.mode === 'lr' ? 'ms' : 'lr';
        this.modeBtn.textContent = this.mode === 'lr' ? 'L / R' : 'M / S';
        this.drawAll(true);
      });
      this.slopeBtn.addEventListener('click', () => {
        this.slope = this.slope === 4.5 ? 0 : this.slope === 0 ? 3 : 4.5;
        this.slopeBtn.textContent = `${this.slope} dB/oct`;
        this.drawAll(true);
      });
      this.audio.addEventListener('loadedmetadata', () => this.updateTime());
      this.audio.addEventListener('timeupdate', () => this.updateTime());
      this.audio.addEventListener('play', () => this.onPlayState());
      this.audio.addEventListener('pause', () => this.onPlayState());
      this.audio.addEventListener('ended', () => this.onPlayState());
      this.audio.addEventListener('seeked', () => this.resetLoudness(true));
      this.audio.addEventListener('error', () => { this.status.textContent = 'The audio file could not be loaded.'; });

      const seekTo = (clientX) => {
        const rect = this.wave.getBoundingClientRect();
        const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const d = this.duration();
        if (d) { this.audio.currentTime = t * d; this.drawWave(); }
      };
      let dragging = false;
      this.wave.addEventListener('pointerdown', (e) => { dragging = true; this.wave.setPointerCapture(e.pointerId); seekTo(e.clientX); });
      this.wave.addEventListener('pointermove', (e) => {
        const rect = this.wave.getBoundingClientRect();
        this.hoverX = (e.clientX - rect.left) / rect.width;
        if (dragging) seekTo(e.clientX); else this.drawWave();
      });
      this.wave.addEventListener('pointerup', () => { dragging = false; });
      this.wave.addEventListener('pointerleave', () => { this.hoverX = null; this.drawWave(); });
      this.wave.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 30 : 5;
        if (e.key === 'ArrowRight') { this.audio.currentTime = Math.min(this.duration(), this.audio.currentTime + step); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { this.audio.currentTime = Math.max(0, this.audio.currentTime - step); e.preventDefault(); }
        if (e.key === ' ' || e.key === 'k') { this.toggle(); e.preventDefault(); }
        this.drawWave();
      });

      fitCanvas(this.wave, () => { this.waveCache = null; this.drawWave(); });
      fitCanvas(this.specCv, () => { this.specMap = null; this.drawSpectrum(); });
      fitCanvas(this.sgCv, () => this.clearSpectrogram());
      fitCanvas(this.oscCv, () => this.drawOsc());
      fitCanvas(this.stereoCv, () => this.clearStereo());
      fitCanvas(this.loudCv, () => this.drawLoud());
      this.updateSourceButtons();
    }

    duration() {
      const d = this.audio.duration;
      return isFinite(d) && d > 0 ? d : (this.peaks ? this.peaks.duration : 0);
    }

    updateTime() {
      const d = this.duration(), t = this.audio.currentTime;
      this.timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
      this.wave.setAttribute('aria-valuemax', String(Math.round(d)));
      this.wave.setAttribute('aria-valuenow', String(Math.round(t)));
      this.wave.setAttribute('aria-valuetext', `${fmtTime(t)} of ${fmtTime(d)}`);
      if (!this.running) this.drawWave();
    }

    updateSourceButtons() {
      this.trackBtn.setAttribute('aria-pressed', String(this.source === 'track'));
      this.micBtn.setAttribute('aria-pressed', String(this.source === 'mic'));
    }

    async loadPeaks() {
      if (!this.peaksUrl) return;
      try {
        const res = await fetch(this.peaksUrl);
        this.peaks = await res.json();
        this.waveCache = null;
        this.updateTime();
        this.drawWave();
      } catch (e) { /* the overview simply stays empty */ }
    }

    /* ---------- Audio graph ---------- */

    async ensureGraph() {
      if (this.graph) return;
      const ac = audioContext();
      const g = {};
      g.input = ac.createGain();
      g.input.channelCount = 2;
      g.input.channelCountMode = 'explicit';
      g.input.channelInterpretation = 'speakers'; // mono sources (a microphone) are copied to both sides
      g.split = ac.createChannelSplitter(2);
      g.input.connect(g.split);

      const analyser = () => {
        const a = ac.createAnalyser();
        a.fftSize = FFT;
        a.smoothingTimeConstant = 0.55;
        a.minDecibels = -120; a.maxDecibels = 0;
        return a;
      };
      g.aL = analyser(); g.aR = analyser(); g.aM = analyser(); g.aS = analyser();
      g.split.connect(g.aL, 0); g.split.connect(g.aR, 1);
      g.mid = ac.createGain(); g.side = ac.createGain();
      const gain = (v) => { const n = ac.createGain(); n.gain.value = v; return n; };
      const mL = gain(0.5), mR = gain(0.5), sL = gain(0.5), sR = gain(-0.5);
      g.split.connect(mL, 0); g.split.connect(mR, 1); g.split.connect(sL, 0); g.split.connect(sR, 1);
      mL.connect(g.mid); mR.connect(g.mid); sL.connect(g.side); sR.connect(g.side);
      g.mid.connect(g.aM); g.side.connect(g.aS);

      // Analysers and the worklet are pulled through a silent node so every browser keeps them running.
      g.mute = gain(0);
      g.mute.connect(ac.destination);
      [g.aL, g.aR, g.aM, g.aS].forEach((a) => a.connect(g.mute));

      try {
        await ac.audioWorklet.addModule(WORKLET_URL);
        g.loud = new AudioWorkletNode(ac, 'loudness-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
        g.loud.port.onmessage = (e) => this.onLoudBlock(e.data);
        g.input.connect(g.loud);
        g.loud.connect(g.mute);
      } catch (e) {
        g.loud = null; // LUFS needs AudioWorklet (https or localhost); the other meters still run
      }

      g.media = ac.createMediaElementSource(this.audio);
      g.media.connect(ac.destination);
      g.media.connect(g.input);

      g.bufL = new Float32Array(FFT); g.bufR = new Float32Array(FFT);
      g.bufM = new Float32Array(FFT);
      g.fA = new Float32Array(FFT / 2); g.fB = new Float32Array(FFT / 2);
      this.graph = g;
    }

    async toggle() {
      if (this.source === 'mic') { this.useTrack(); }
      await this.ensureGraph();
      await audioContext().resume();
      if (this.audio.paused) {
        players.forEach((p) => { if (p !== this) p.pause(); });
        try { await this.audio.play(); } catch (e) { this.status.textContent = 'Playback was blocked by the browser. Press play again.'; }
      } else {
        this.audio.pause();
      }
    }

    pause() {
      if (!this.audio.paused) this.audio.pause();
      if (this.source === 'mic') this.useTrack();
    }

    onPlayState() {
      const playing = !this.audio.paused && !this.audio.ended;
      this.playBtn.innerHTML = `<span aria-hidden="true">${playing ? '❚❚' : '▶'}</span>`;
      this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this.root.classList.toggle('is-playing', playing);
      if (playing) this.start();
    }

    async useMic() {
      if (this.source === 'mic') return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.status.textContent = 'This browser does not allow microphone input here.';
        return;
      }
      try {
        await this.ensureGraph();
        await audioContext().resume();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        players.forEach((p) => p.pause());
        this.audio.pause();
        this.graph.media.disconnect(this.graph.input);
        this.micStream = stream;
        this.micNode = audioContext().createMediaStreamSource(stream);
        this.micNode.connect(this.graph.input); // not connected to the speakers, so no feedback
        this.source = 'mic';
        this.resetLoudness(true);
        this.status.textContent = 'Showing your microphone. Nothing is recorded or sent anywhere.';
        this.updateSourceButtons();
        this.root.classList.add('is-mic');
        this.start();
      } catch (e) {
        this.status.textContent = 'Microphone access was not granted.';
      }
    }

    useTrack() {
      if (this.source !== 'mic') return;
      if (this.micNode) this.micNode.disconnect();
      if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
      this.micNode = null; this.micStream = null;
      this.graph.media.connect(this.graph.input);
      this.source = 'track';
      this.status.textContent = '';
      this.root.classList.remove('is-mic');
      this.resetLoudness(true);
      this.updateSourceButtons();
    }

    active() {
      return this.source === 'mic' || (!this.audio.paused && !this.audio.ended);
    }

    start() {
      if (this.running) return;
      this.running = true;
      const loop = () => {
        if (this.active()) this.idleFrames = 0; else this.idleFrames++;
        this.frame();
        if (this.idleFrames < 90) requestAnimationFrame(loop); // let meters fall back after a pause
        else { this.running = false; this.drawWave(); }
      };
      requestAnimationFrame(loop);
    }

    /* ---------- Loudness (BS.1770) ---------- */

    resetLoudness(tellWorklet) {
      this.blocks = [];          // per-100 ms channel-summed mean squares
      this.gated = [];           // 400 ms block powers for integrated loudness
      this.loud = { m: -Infinity, s: -Infinity, i: -Infinity, maxPeak: -Infinity, maxM: -Infinity };
      this.peakHold = [-Infinity, -Infinity];
      if (tellWorklet && this.graph && this.graph.loud) this.graph.loud.port.postMessage('reset');
    }

    onLoudBlock({ ms, peak }) {
      if (!this.active()) return;
      const p = ms[0] + ms[1];
      this.blocks.push(p);
      if (this.blocks.length > 30) this.blocks.shift();
      const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
      if (this.blocks.length >= 4) {
        const m = mean(this.blocks.slice(-4));
        this.gated.push(m);
        this.loud.m = lufs(m);
        this.loud.maxM = Math.max(this.loud.maxM, this.loud.m);
      }
      if (this.blocks.length >= 30) this.loud.s = lufs(mean(this.blocks));
      // Integrated: absolute gate at -70 LUFS, then relative gate 10 LU below the gated mean.
      const abs = this.gated.filter((x) => lufs(x) > -70);
      if (abs.length) {
        const rel = lufs(mean(abs)) - 10;
        const kept = abs.filter((x) => lufs(x) > rel);
        if (kept.length) this.loud.i = lufs(mean(kept));
      }
      this.loud.maxPeak = Math.max(this.loud.maxPeak, db(Math.max(peak[0], peak[1])));
    }

    /* ---------- Drawing ---------- */

    frame() {
      const g = this.graph;
      if (!g) return;
      g.aL.getFloatTimeDomainData(g.bufL);
      g.aR.getFloatTimeDomainData(g.bufR);
      g.aM.getFloatTimeDomainData(g.bufM);
      if (this.idleFrames > 0) { g.bufL.fill(0); g.bufR.fill(0); g.bufM.fill(0); }
      this.drawSpectrum();
      this.drawSpectrogram();
      this.drawOsc();
      this.drawStereo();
      this.drawLoud();
      this.drawWave();
    }

    drawAll() {
      this.drawWave(); this.drawSpectrum(); this.drawOsc(); this.drawLoud();
      this.clearStereo(); this.clearSpectrogram();
    }

    // Overview: colour from low / mid / high energy, height from peak and RMS.
    buildWaveCache() {
      const cv = this.wave, w = cv.width, h = cv.height, P = this.peaks;
      const make = (dim) => {
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const x = off.getContext('2d');
        if (!P) return off;
        const mid = h / 2;
        for (let px = 0; px < w; px++) {
          const a = Math.floor(px / w * P.bins), b = Math.max(a + 1, Math.floor((px + 1) / w * P.bins));
          let pk = 0, rm = 0, lo = 0, mi = 0, hi = 0;
          for (let i = a; i < b; i++) {
            pk = Math.max(pk, P.peak[i]); rm = Math.max(rm, P.rms[i]);
            lo += P.low[i]; mi += P.mid[i]; hi += P.high[i];
          }
          const n = b - a; lo = (lo / n) ** 2.5; mi = (mi / n) ** 2.5; hi = (hi / n) ** 2.5;
          const tot = lo + mi + hi + 1e-6;
          // low = indigo, mid = orange, high = cream
          const r = (lo * 110 + mi * 242 + hi * 255) / tot;
          const gg = (lo * 112 + mi * 150 + hi * 236) / tot;
          const bb = (lo * 255 + mi * 85 + hi * 214) / tot;
          const k = dim ? 0.4 : 1;
          x.fillStyle = `rgba(${r | 0},${gg | 0},${bb | 0},${0.45 * k})`;
          const ph = pk * mid * 0.95;
          x.fillRect(px, mid - ph, 1, ph * 2);
          x.fillStyle = `rgba(${r | 0},${gg | 0},${bb | 0},${k})`;
          const rh = Math.min(ph, rm * mid * 1.9);
          x.fillRect(px, mid - rh, 1, rh * 2);
        }
        return off;
      };
      this.waveCache = { dim: make(true), lit: make(false) };
    }

    drawWave() {
      const cv = this.wave, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      if (!this.waveCache) this.buildWaveCache();
      x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
      const d = this.duration();
      const pos = d ? this.audio.currentTime / d : 0;
      const px = Math.round(pos * w);
      x.drawImage(this.waveCache.dim, 0, 0);
      x.drawImage(this.waveCache.lit, 0, 0, px, h, 0, 0, px, h);
      if (!this.peaks) {
        x.fillStyle = C.label; x.font = `${12 * (w / cv.clientWidth)}px Inter, sans-serif`;
        x.fillText('Loading overview…', 10, h / 2);
      }
      if (this.hoverX != null && d) {
        const hx = Math.round(this.hoverX * w);
        x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(hx, 0, 1, h);
        const dpr = w / cv.clientWidth;
        x.font = `600 ${11 * dpr}px Inter, sans-serif`;
        const label = fmtTime(this.hoverX * d);
        const tw = x.measureText(label).width + 10 * dpr;
        const lx = Math.min(w - tw, Math.max(0, hx - tw / 2));
        x.fillStyle = 'rgba(14,16,24,0.85)'; x.fillRect(lx, 2 * dpr, tw, 16 * dpr);
        x.fillStyle = C.text; x.fillText(label, lx + 5 * dpr, 14 * dpr);
      }
      x.fillStyle = C.cream; x.fillRect(px - 1, 0, 2, h);
    }

    // Maps each pixel column to a frequency range of FFT bins on a log axis.
    spectrumMap(w) {
      if (this.specMap && this.specMap.w === w) return this.specMap;
      const sr = audioContext().sampleRate, binHz = sr / FFT, nb = FFT / 2;
      const lo = new Int32Array(w), hi = new Int32Array(w), frac = new Float32Array(w), f = new Float32Array(w);
      for (let px = 0; px < w; px++) {
        const f0 = FMIN * Math.pow(FMAX / FMIN, px / w), f1 = FMIN * Math.pow(FMAX / FMIN, (px + 1) / w);
        f[px] = f0;
        lo[px] = Math.min(nb - 1, Math.floor(f0 / binHz));
        hi[px] = Math.min(nb - 1, Math.max(lo[px], Math.floor(f1 / binHz)));
        frac[px] = f0 / binHz - lo[px];
      }
      this.specMap = { w, lo, hi, frac, f };
      return this.specMap;
    }

    // Reads one spectrum column: interpolated at low frequencies, max over bins at high ones.
    specAt(map, data, px) {
      const a = map.lo[px], b = map.hi[px];
      if (b > a) { let m = -200; for (let i = a; i <= b; i++) if (data[i] > m) m = data[i]; return m; }
      const n = Math.min(data.length - 1, a + 1);
      return data[a] + (data[n] - data[a]) * map.frac[px];
    }

    drawGridFreq(x, w, h, dpr, labels) {
      x.strokeStyle = C.gridSoft; x.lineWidth = 1;
      x.fillStyle = C.label; x.font = `${10 * dpr}px Inter, sans-serif`;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const px = Math.round(Math.log(f / FMIN) / Math.log(FMAX / FMIN) * w) + 0.5;
        x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke();
        if (labels) x.fillText(f >= 1000 ? `${f / 1000}k` : String(f), px + 3 * dpr, h - 4 * dpr);
      }
    }

    drawSpectrum() {
      const cv = this.specCv, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      const dpr = w / Math.max(1, cv.clientWidth);
      x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
      const top = -18, bottom = -108; // dB range after slope
      const yOf = (v) => (top - v) / (top - bottom) * h;
      x.strokeStyle = C.gridSoft; x.lineWidth = 1;
      x.fillStyle = C.label; x.font = `${10 * dpr}px Inter, sans-serif`;
      for (let v = -24; v >= -96; v -= 12) {
        const y = Math.round(yOf(v)) + 0.5;
        x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
        x.fillText(String(v).replace('-', '−'), 4 * dpr, y - 3 * dpr);
      }
      this.drawGridFreq(x, w, h, dpr, true);
      const g = this.graph;
      if (!g || this.idleFrames > 60) return;
      const map = this.spectrumMap(w);
      const [aA, aB, cA, cB] = this.mode === 'lr' ? [g.aL, g.aR, C.ind, C.org] : [g.aM, g.aS, C.ind, C.side];
      aA.getFloatFrequencyData(g.fA); aB.getFloatFrequencyData(g.fB);
      const curve = (data) => {
        const pts = new Float32Array(w);
        for (let px = 0; px < w; px++) {
          const v = this.specAt(map, data, px) + this.slope * Math.log2(map.f[px] / 1000);
          pts[px] = yOf(v);
        }
        return pts;
      };
      const draw = (pts, color, fill) => {
        x.beginPath(); x.moveTo(0, pts[0]);
        for (let px = 1; px < w; px++) x.lineTo(px, pts[px]);
        if (fill) {
          x.lineTo(w, h); x.lineTo(0, h); x.closePath();
          const grd = x.createLinearGradient(0, 0, 0, h);
          grd.addColorStop(0, color + '66'); grd.addColorStop(1, color + '05');
          x.fillStyle = grd; x.fill();
          x.beginPath(); x.moveTo(0, pts[0]);
          for (let px = 1; px < w; px++) x.lineTo(px, pts[px]);
        }
        x.strokeStyle = color; x.lineWidth = 1.5 * dpr; x.stroke();
      };
      draw(curve(g.fB), cB, false);
      draw(curve(g.fA), cA, true);
      x.font = `600 ${10 * dpr}px Inter, sans-serif`;
      const names = this.mode === 'lr' ? ['L', 'R'] : ['M', 'S'];
      x.fillStyle = cA; x.fillText(names[0], w - 34 * dpr, 14 * dpr);
      x.fillStyle = cB; x.fillText(names[1], w - 20 * dpr, 14 * dpr);
    }

    clearSpectrogram() {
      const cv = this.sgCv, x = cv.getContext('2d');
      x.fillStyle = C.bg; x.fillRect(0, 0, cv.width, cv.height);
      this.sgCol = null;
    }

    drawSpectrogram() {
      const g = this.graph, cv = this.sgCv, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      if (!g || this.idleFrames > 0) return;
      const step = Math.max(1, Math.round(w / cv.clientWidth)); // one CSS pixel per frame
      x.drawImage(cv, -step, 0);
      g.aM.getFloatFrequencyData(g.fA);
      if (!this.sgCol || this.sgCol.height !== h) this.sgCol = x.createImageData(1, h);
      const col = this.sgCol.data;
      const sr = audioContext().sampleRate, binHz = sr / FFT;
      for (let y = 0; y < h; y++) {
        const f = FMIN * Math.pow(FMAX / FMIN, 1 - y / h);
        const i = Math.min(FFT / 2 - 1, Math.round(f / binHz));
        const v = g.fA[i] + 3 * Math.log2(f / 1000);
        const t = Math.min(255, Math.max(0, ((v + 100) / 80) * 255)) | 0;
        col[y * 4] = LUT[t * 3]; col[y * 4 + 1] = LUT[t * 3 + 1]; col[y * 4 + 2] = LUT[t * 3 + 2]; col[y * 4 + 3] = 255;
      }
      for (let s = 0; s < step; s++) x.putImageData(this.sgCol, w - step + s, 0);
    }

    drawOsc() {
      const cv = this.oscCv, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      const dpr = w / Math.max(1, cv.clientWidth);
      x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
      x.strokeStyle = C.gridSoft; x.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75]) { const y = Math.round(h * f) + 0.5; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); }
      const g = this.graph;
      if (!g) return;
      const buf = g.bufM, N = 2048, n = buf.length;
      // Trigger on a rising zero crossing so periodic sounds hold still.
      let start = n - N;
      for (let i = n - N; i > n - N - 2048 && i > 1; i--) {
        if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
      }
      let pk = 0;
      for (let i = 0; i < N; i++) { const a = Math.abs(buf[start + i]); if (a > pk) pk = a; }
      // Gentle auto-gain so quiet passages still fill the screen.
      const target = Math.min(8, 0.9 / Math.max(pk, 0.02));
      this.oscGain = this.oscGain ? this.oscGain + (target - this.oscGain) * (target < this.oscGain ? 0.3 : 0.03) : target;
      x.beginPath();
      for (let i = 0; i < N; i++) {
        const px = i / (N - 1) * w, y = h / 2 - buf[start + i] * this.oscGain * h * 0.5;
        i ? x.lineTo(px, y) : x.moveTo(px, y);
      }
      x.strokeStyle = C.ind; x.lineWidth = 1.5 * dpr; x.stroke();
    }

    clearStereo() {
      const cv = this.stereoCv, x = cv.getContext('2d');
      x.fillStyle = C.bg; x.fillRect(0, 0, cv.width, cv.height);
      this.drawStereoGuides(x, cv);
    }

    drawStereoGuides(x, cv) {
      const w = cv.width, h = cv.height, dpr = w / Math.max(1, cv.clientWidth);
      const barH = 18 * dpr, size = Math.min(w, h - barH) * 0.46, cx = w / 2, cy = (h - barH) / 2;
      x.strokeStyle = C.grid; x.lineWidth = 1;
      x.beginPath();
      x.moveTo(cx, cy - size); x.lineTo(cx + size, cy); x.lineTo(cx, cy + size); x.lineTo(cx - size, cy); x.closePath();
      x.moveTo(cx - size / 2, cy - size / 2); x.lineTo(cx + size / 2, cy + size / 2);
      x.moveTo(cx + size / 2, cy - size / 2); x.lineTo(cx - size / 2, cy + size / 2);
      x.moveTo(cx, cy - size); x.lineTo(cx, cy + size);
      x.stroke();
      x.fillStyle = C.label; x.font = `${10 * dpr}px Inter, sans-serif`;
      x.fillText('L', cx - size / 2 - 12 * dpr, cy - size / 2 - 2 * dpr);
      x.fillText('R', cx + size / 2 + 4 * dpr, cy - size / 2 - 2 * dpr);
      x.fillText('M', cx + 4 * dpr, cy - size + 10 * dpr);
      return { size, cx, cy, barH, dpr };
    }

    drawStereo() {
      const g = this.graph, cv = this.stereoCv, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      if (!g) return;
      // Fade the previous frame for a phosphor trail.
      x.fillStyle = 'rgba(14,16,24,0.35)'; x.fillRect(0, 0, w, h);
      const { size, cx, cy, barH, dpr } = this.drawStereoGuides(x, cv);
      const L = g.bufL, R = g.bufR, n = L.length, N = 2048;
      let sLR = 0, sLL = 0, sRR = 0;
      x.fillStyle = 'rgba(142,145,255,0.55)';
      const dot = Math.max(1, dpr);
      for (let i = n - N; i < n; i++) {
        const l = L[i], r = R[i];
        sLR += l * r; sLL += l * l; sRR += r * r;
        // Square-root radial scale: quiet material stays visible, full-scale mono reaches the corner.
        const ux = (r - l) / 2, uy = (l + r) / 2, m = Math.hypot(ux, uy);
        if (m < 1e-6) continue;
        const sc = Math.min(1, Math.sqrt(m)) / m * size;
        x.fillRect(cx + ux * sc, cy - uy * sc, dot, dot);
      }
      const c = sLL > 1e-9 && sRR > 1e-9 ? sLR / Math.sqrt(sLL * sRR) : 0;
      this.corr += (c - this.corr) * 0.15;
      // Correlation bar, −1 to +1.
      const by = h - barH + 4 * dpr, bw = w - 24 * dpr, bx = 12 * dpr, bh = 6 * dpr;
      x.fillStyle = C.bg; x.fillRect(0, h - barH, w, barH);
      x.fillStyle = C.grid; x.fillRect(bx, by, bw, bh);
      const mx = bx + (this.corr + 1) / 2 * bw;
      x.fillStyle = this.corr < 0 ? C.org : C.ind;
      x.fillRect(Math.min(bx + bw / 2, mx), by, Math.abs(mx - (bx + bw / 2)), bh);
      x.fillStyle = C.text; x.fillRect(mx - dpr, by - 2 * dpr, 2 * dpr, bh + 4 * dpr);
      x.fillStyle = C.label; x.font = `${9 * dpr}px Inter, sans-serif`;
      x.fillText('−1', bx - 10 * dpr, by + bh + 1 * dpr);
      x.fillText('+1', bx + bw + 1 * dpr, by + bh + 1 * dpr);
    }

    drawLoud() {
      const cv = this.loudCv, x = cv.getContext('2d'), w = cv.width, h = cv.height;
      const dpr = w / Math.max(1, cv.clientWidth);
      x.fillStyle = C.bg; x.fillRect(0, 0, w, h);
      const g = this.graph;
      // Sample peak per channel from the analysers, with a short hold and a steady fall.
      for (let ch = 0; ch < 2; ch++) {
        let pk = 0;
        if (g) { const b = ch ? g.bufR : g.bufL; for (let i = b.length - 2048; i < b.length; i++) { const a = Math.abs(b[i]); if (a > pk) pk = a; } }
        const v = db(pk);
        this.peakBar[ch] = Math.max(v, (isFinite(this.peakBar[ch]) ? this.peakBar[ch] : -90) - 0.6);
        if (v > this.peakHold[ch] || !isFinite(this.peakHold[ch])) this.peakHold[ch] = v;
      }
      const floor = -60, pad = 8 * dpr, top = pad, bot = h - 16 * dpr;
      const yOf = (v) => top + (Math.min(0, Math.max(floor, v)) / floor) * (bot - top);
      // scale
      x.fillStyle = C.label; x.font = `${9 * dpr}px Inter, sans-serif`;
      x.strokeStyle = C.gridSoft;
      for (let v = 0; v >= floor; v -= 12) {
        const y = Math.round(yOf(v)) + 0.5;
        x.beginPath(); x.moveTo(pad + 18 * dpr, y); x.lineTo(w - pad, y); x.stroke();
        x.fillText(String(v).replace('-', '−'), pad - 2 * dpr, y + 3 * dpr);
      }
      const barW = Math.min(16 * dpr, (w - pad * 2 - 30 * dpr) / 5);
      const x0 = pad + 26 * dpr;
      const bars = [
        { v: this.peakBar[0], hold: this.peakHold[0], label: 'L', color: C.ind },
        { v: this.peakBar[1], hold: this.peakHold[1], label: 'R', color: C.ind },
        { v: this.loud.m, hold: this.loud.maxM, label: 'M', color: C.org },
        { v: this.loud.s, hold: null, label: 'S', color: C.cream },
      ];
      bars.forEach((b, i) => {
        const bx = x0 + i * (barW + 6 * dpr) + (i >= 2 ? 6 * dpr : 0);
        x.fillStyle = C.gridSoft; x.fillRect(bx, top, barW, bot - top);
        if (isFinite(b.v) && b.v > floor) {
          const y = yOf(b.v);
          x.fillStyle = b.v > -1 && i < 2 ? '#FF6B6B' : b.color;
          x.fillRect(bx, y, barW, bot - y);
        }
        if (b.hold != null && isFinite(b.hold) && b.hold > floor) {
          x.fillStyle = C.text; x.fillRect(bx, yOf(b.hold) - dpr, barW, 2 * dpr);
        }
        x.fillStyle = C.label; x.font = `600 ${9 * dpr}px Inter, sans-serif`;
        x.fillText(b.label, bx + barW / 2 - 3 * dpr, h - 4 * dpr);
      });
      // readouts
      const hasLufs = !this.graph || this.graph.loud;
      const L = this.loud;
      const html = hasLufs
        ? `<div><dt>Momentary</dt><dd>${fmtDb(L.m)} <small>LUFS</small></dd></div><div><dt>Short-term</dt><dd>${fmtDb(L.s)} <small>LUFS</small></dd></div><div><dt>Integrated</dt><dd>${fmtDb(L.i)} <small>LUFS</small></dd></div><div><dt>Peak</dt><dd>${fmtDb(L.maxPeak)} <small>dBFS</small></dd></div>`
        : '<div><dt>LUFS</dt><dd>needs https</dd></div>';
      if (html !== this._readHtml) { this.loudRead.innerHTML = html; this._readHtml = html; }
    }
  }

  function init() {
    document.querySelectorAll('.meters').forEach((root) => {
      if (!root.dataset.ready) { root.dataset.ready = '1'; players.push(new Meters(root)); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
