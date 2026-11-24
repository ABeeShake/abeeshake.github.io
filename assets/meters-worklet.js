// Audio-thread half of the loudness meter (ITU-R BS.1770).
// Applies K-weighting to each channel and reports, every 100 ms, the mean square of the
// K-weighted signal per channel and the sample peak of the raw signal per channel.

function biquadShelf(fs) {
  // Stage 1: high shelf (head effect), parameters as in pyloudnorm.
  const G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.974450955533;
  const A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / fs;
  const c = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q), sA = Math.sqrt(A);
  const b0 = A * ((A + 1) + (A - 1) * c + 2 * sA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * c);
  const b2 = A * ((A + 1) + (A - 1) * c - 2 * sA * alpha);
  const a0 = (A + 1) - (A - 1) * c + 2 * sA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * c);
  const a2 = (A + 1) - (A - 1) * c - 2 * sA * alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function biquadHighpass(fs) {
  // Stage 2: RLB high-pass.
  const Q = 0.5003270373238773, fc = 38.13547087602444;
  const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0];
}

class LoudnessProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.k1 = biquadShelf(sampleRate);
    this.k2 = biquadHighpass(sampleRate);
    // Per channel filter state: [x1, x2, y1, y2] for each stage.
    this.state = [new Float64Array(8), new Float64Array(8)];
    this.blockLen = Math.round(sampleRate * 0.1);
    this.reset();
    this.port.onmessage = (e) => { if (e.data === 'reset') { this.reset(); this.state.forEach(s => s.fill(0)); } };
  }
  reset() { this.n = 0; this.sum = [0, 0]; this.peak = [0, 0]; }

  filter(x, s) {
    const [b0, b1, b2, a1, a2] = this.k1;
    const y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
    s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
    const [c0, c1, c2, d1, d2] = this.k2;
    const z = c0 * y + c1 * s[4] + c2 * s[5] - d1 * s[6] - d2 * s[7];
    s[5] = s[4]; s[4] = y; s[7] = s[6]; s[6] = z;
    return z;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const data = input[Math.min(ch, input.length - 1)];
        const x = data[i];
        const ax = x < 0 ? -x : x;
        if (ax > this.peak[ch]) this.peak[ch] = ax;
        const k = this.filter(x, this.state[ch]);
        this.sum[ch] += k * k;
      }
      if (++this.n >= this.blockLen) {
        this.port.postMessage({ ms: [this.sum[0] / this.n, this.sum[1] / this.n], peak: this.peak.slice() });
        this.reset();
      }
    }
    return true;
  }
}

registerProcessor('loudness-processor', LoudnessProcessor);
