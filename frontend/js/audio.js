// CallShield — microphone capture -> 16 kHz mono Float32 ring buffer -> 16-bit PCM WAV.
// Uses an AudioWorklet (inline, via Blob URL) with a ScriptProcessor fallback.

export const SAMPLE_RATE = 16000;

const WORKLET_CODE = `
class CallShieldCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0]) {
      const chs = input.length, len = input[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < chs; c++) s += input[c][i];
        this.buf[this.n++] = s / chs;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('callshield-capture', CallShieldCapture);
`;

// Windowed-sinc (Blackman) low-pass FIR used as the anti-alias filter before decimation.
function designLowpass(inRate, cutoffHz, taps = 63) {
  const fc = cutoffHz / inRate;
  const m = taps - 1;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - m / 2;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m);
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/** Streaming resampler: FIR low-pass (when downsampling) + linear interpolation. */
class Resampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.passthrough = Math.abs(this.step - 1) < 1e-6;
    this.h = this.step > 1 ? designLowpass(inRate, outRate * 0.45) : null;
    this.hist = new Float32Array(this.h ? this.h.length - 1 : 0);
    this.carry = new Float32Array(0);
    this.pos = 0;
  }
  process(input) {
    if (this.passthrough) return input;
    let x = input;
    if (this.h) {
      const h = this.h, L = h.length, hl = this.hist.length;
      const ext = new Float32Array(hl + input.length);
      ext.set(this.hist);
      ext.set(input, hl);
      x = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        let acc = 0;
        for (let k = 0; k < L; k++) acc += h[k] * ext[i + k];
        x[i] = acc;
      }
      this.hist = ext.slice(input.length);
    }
    const buf = new Float32Array(this.carry.length + x.length);
    buf.set(this.carry);
    buf.set(x, this.carry.length);
    const out = [];
    let pos = this.pos;
    while (pos + 1 < buf.length) {
      const i = Math.floor(pos), f = pos - i;
      out.push(buf[i] * (1 - f) + buf[i + 1] * f);
      pos += this.step;
    }
    const drop = Math.min(Math.floor(pos), buf.length);
    this.carry = buf.slice(drop);
    this.pos = pos - drop;
    return Float32Array.from(out);
  }
}

/**
 * Microphone capture with a rolling ring buffer (default 30 s) at 16 kHz mono.
 *   await mic.start(); mic.getLast(8) -> Float32Array; mic.bufferedSeconds; mic.level (0..1 RMS)
 *   mic.startRecording(); ... mic.stopRecording() -> Float32Array of the full take
 */
export class MicCapture {
  constructor({ ringSeconds = 30 } = {}) {
    this.ring = new Float32Array(Math.round(ringSeconds * SAMPLE_RATE));
    this.listeners = new Set();
    this.running = false;
    this.mode = null;
    this.reset();
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  }

  reset() {
    this.write = 0;
    this.total = 0;
    this.level = 0;
  }

  /** start() captures the mic; start({ stream }) captures any audio MediaStream (e.g. a call's remote audio). */
  async start({ stream = null } = {}) {
    if (this.running) return;
    if (!MicCapture.isSupported()) throw new Error('Microphone capture is not supported in this browser');
    // Keep the raw voice: no noise suppression / AGC (they smear the artefacts deepfake detection looks for).
    this.ownsStream = !stream;
    this.stream = stream || await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null, source = null;
    try {
      ctx = new AC({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      source = ctx.createMediaStreamSource(this.stream);
    } catch (e) {
      try { if (ctx) ctx.close(); } catch { /* ignore */ }
      ctx = new AC({ latencyHint: 'interactive' });
      source = ctx.createMediaStreamSource(this.stream);
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    this.ctx = ctx;
    this.source = source;
    this.resampler = new Resampler(ctx.sampleRate, SAMPLE_RATE);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // keep the graph pulling without playing the mic back
    this.sink.connect(ctx.destination);

    let node = null;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      let url = null;
      try {
        url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        node = new AudioWorkletNode(ctx, 'callshield-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e) => this._ingest(e.data);
        this.mode = 'audio-worklet';
      } catch (e) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor', e);
        node = null;
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    }
    if (!node) {
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => {
        const ib = e.inputBuffer;
        const chs = ib.numberOfChannels;
        const mono = new Float32Array(ib.length);
        for (let c = 0; c < chs; c++) {
          const d = ib.getChannelData(c);
          for (let i = 0; i < d.length; i++) mono[i] += d[i] / chs;
        }
        this._ingest(mono);
      };
      this.mode = 'script-processor';
    }
    source.connect(node);
    node.connect(this.sink);
    this.node = node;
    this.running = true;
    const track = this.stream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', () => { this.stop(); if (this.onended) this.onended(); });
  }

  stop() {
    if (!this.running && !this.stream) return;
    this.running = false;
    try { if (this.node && this.node.port) this.node.port.onmessage = null; } catch { /* ignore */ }
    try { this.source && this.source.disconnect(); } catch { /* ignore */ }
    try { this.node && this.node.disconnect(); } catch { /* ignore */ }
    try { this.sink && this.sink.disconnect(); } catch { /* ignore */ }
    try { this.ctx && this.ctx.close(); } catch { /* ignore */ }
    if (this.stream && this.ownsStream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.level = 0;
  }

  onData(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** A local copy of the captured audio as a live MediaStreamTrack (Chrome's speech recognition rejects
   *  a call's remote WebRTC track but takes a Web Audio one). Stops with the capture. */
  tapTrack() {
    if (!this.running) return null;
    const dest = this.ctx.createMediaStreamDestination();
    this.source.connect(dest);
    return dest.stream.getAudioTracks()[0];
  }

  _ingest(chunk) {
    if (!this.running) return;
    const x = this.resampler.process(chunk);
    const n = x.length;
    if (!n) return;
    const R = this.ring, RL = R.length;
    if (n >= RL) {
      R.set(x.subarray(n - RL));
      this.write = 0;
    } else {
      const first = Math.min(n, RL - this.write);
      R.set(x.subarray(0, first), this.write);
      if (first < n) R.set(x.subarray(first), 0);
      this.write = (this.write + n) % RL;
    }
    this.total += n;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / n);
    this.level = Math.max(rms, this.level * 0.85); // fast attack, slow release

    if (this.recording) {
      this.recording.push(x);
      this.recordedSamples += n;
    }
    for (const fn of this.listeners) {
      try { fn(x); } catch (e) { console.error(e); }
    }
  }

  /** Seconds of audio currently available in the ring buffer. */
  get bufferedSeconds() { return Math.min(this.total, this.ring.length) / SAMPLE_RATE; }

  /** Level as 0..1 on a -60..0 dBFS scale (for meters). */
  get meterLevel() {
    const db = 20 * Math.log10(this.level + 1e-9);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  /** Copy of the most recent `seconds` of audio (or less if not yet buffered). */
  getLast(seconds) {
    const RL = this.ring.length;
    const n = Math.min(Math.round(seconds * SAMPLE_RATE), Math.min(this.total, RL));
    const out = new Float32Array(n);
    if (!n) return out;
    const start = (this.write - n + RL) % RL;
    const first = Math.min(n, RL - start);
    out.set(this.ring.subarray(start, start + first));
    if (first < n) out.set(this.ring.subarray(0, n - first), first);
    return out;
  }

  /** Audio between two `total` sample counters (e.g. marked when the caller started and stopped a reply).
   *  Clipped to what is still in the ring buffer. */
  getRange(from, to) {
    const RL = this.ring.length;
    to = Math.min(to, this.total);
    from = Math.max(from, this.total - Math.min(this.total, RL));
    const n = Math.max(0, to - from);
    const out = new Float32Array(n);
    if (!n) return out;
    const start = (((this.write - (this.total - from)) % RL) + RL) % RL;
    const first = Math.min(n, RL - start);
    out.set(this.ring.subarray(start, start + first));
    if (first < n) out.set(this.ring.subarray(0, n - first), first);
    return out;
  }

  startRecording() {
    this.recording = [];
    this.recordedSamples = 0;
  }

  get recordedSeconds() { return this.recording ? this.recordedSamples / SAMPLE_RATE : 0; }

  stopRecording() {
    const parts = this.recording || [];
    this.recording = null;
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Float32Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * Remove the runs of exact digital zeros (>= `minRun` s) that a WebRTC call inserts while the caller is quiet.
 * They aren't natural silence: in call clips they were 60-70% of the audio, dragged a genuine caller's speaker
 * match from 0.85 down to 0.21 and made the deepfake check spike. Natural pauses (room noise) are kept, and
 * since the cuts sit on zeros the joins are seamless.
 */
export function dropDigitalSilence(samples, sampleRate = SAMPLE_RATE, minRun = 0.06) {
  // "Zero" = what encodeWav writes as 0 (setInt16 truncates: |x| < 1/32767). The call's silence reaches us as
  // tiny floats, not exact 0. Natural room noise in call audio is >= ~3e-3, two orders of magnitude above.
  const Z = 1 / 32767;
  const m = Math.round(minRun * sampleRate);
  const out = new Float32Array(samples.length);
  let o = 0;
  let i = 0;
  while (i < samples.length) {
    if (Math.abs(samples[i]) >= Z) { out[o++] = samples[i++]; continue; }
    let j = i;
    while (j < samples.length && Math.abs(samples[j]) < Z) j++;
    if (j - i < m) { while (i < j) out[o++] = samples[i++]; }  // short zero stretch: part of the waveform
    i = j;
  }
  return out.slice(0, o);
}

/** Encode mono Float32 samples as a 16-bit PCM WAV Blob. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);       // PCM chunk size
  v.setUint16(20, 1, true);        // PCM
  v.setUint16(22, 1, true);        // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Rough voice-activity estimate: seconds of 20 ms frames whose RMS exceeds an adaptive threshold.
 * Used only to avoid spending credits on silent clips — DetectifAI does the real check.
 */
export function estimateSpeechSeconds(samples, sampleRate = SAMPLE_RATE) {
  const frame = Math.round(sampleRate * 0.02);
  const frames = Math.floor(samples.length / frame);
  if (!frames) return 0;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * frame, e = i + frame; i < e; i++) s += samples[i] * samples[i];
    rms[f] = Math.sqrt(s / frame);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(frames * 0.1)] || 0;
  const thr = Math.max(0.004, Math.min(floor * 3, 0.02));
  let voiced = 0;
  for (let f = 0; f < frames; f++) if (rms[f] > thr) voiced++;
  return (voiced * frame) / sampleRate;
}
