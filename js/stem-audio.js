/**
 * Stem Check (TOOL / 007) — Multi-Stem Synchronized Playback Engine & Demo Pack Generator.
 *
 * Features:
 * - Cross-browser AudioContext & Promise/callback decodeAudioDataSafe
 * - Sample-locked multi-stem audition from 0:00 (or any scrubbed timestamp)
 * - Real-time clickless per-stem Mute (M) and Solo (S)
 * - Hardware Monitor Matrix: STEREO / MONO (L+R) / SIDE (L-R)
 *   (In SIDE mode, mono & dual-mono dry vocals vanish completely while baked-in stereo reverb/delay pops out!)
 * - Real-time stereo L/R RMS & Peak metering for console VU meters
 * - Pure-JS WAV PCM16 encoder & realistic 4-stem musical Demo Pack generator
 */

export function createAudioContext() {
  const Ctx =
    (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
    null;
  if (!Ctx) {
    throw new Error('Web Audio API is not supported in this browser.');
  }
  return new Ctx();
}

/**
 * Cross-browser decodeAudioData supporting both modern Promise API
 * and legacy Safari callback signature. Clones input buffer to prevent detachment.
 */
export function decodeAudioDataSafe(ctx, arrayBuffer) {
  const copy = arrayBuffer.slice(0);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onOk = (decoded) => {
      if (settled) return;
      settled = true;
      resolve(decoded);
    };
    const onErr = (err) => {
      if (settled) return;
      settled = true;
      reject(err || new Error('Browser could not decode this audio format.'));
    };

    try {
      const maybePromise = ctx.decodeAudioData(copy, onOk, onErr);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(onOk, onErr);
      }
    } catch (err) {
      onErr(err);
    }
  });
}

/* --------------------------------------------------------------------------
 * Multi-Stem Synchronized Playback Engine
 * -------------------------------------------------------------------------- */

export class StemAudioEngine {
  constructor() {
    this.ctx = null;
    this.mixBus = null;
    this.splitter = null;
    this.merger = null;
    this.matrix = null;
    this.masterGain = null;
    this.analyserL = null;
    this.analyserR = null;
    this.timeBufL = null;
    this.timeBufR = null;

    this.stems = new Map(); // id -> { id, buffer, mute, solo, gainNode, sourceNode }
    this.isPlaying = false;
    this.startCtxTime = 0;
    this.pauseOffsetSec = 0;
    this.maxDurationSec = 0;
    this.monitorMode = 'stereo'; // 'stereo' | 'mono' | 'side'
    this.volume = 0.88;
    this.onEnded = null;
    this._endTimer = null;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = createAudioContext();
    this.ctx = ctx;

    // Explicit stereo mix bus so mono stems upmix cleanly (L === R) before the M/S matrix
    const mixBus = ctx.createGain();
    mixBus.channelCount = 2;
    mixBus.channelCountMode = 'explicit';
    mixBus.channelInterpretation = 'speakers';

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    const gLL = ctx.createGain();
    const gRL = ctx.createGain();
    const gLR = ctx.createGain();
    const gRR = ctx.createGain();

    mixBus.connect(splitter);
    splitter.connect(gLL, 0);
    splitter.connect(gRL, 1);
    splitter.connect(gLR, 0);
    splitter.connect(gRR, 1);

    gLL.connect(merger, 0, 0);
    gRL.connect(merger, 0, 0);
    gLR.connect(merger, 0, 1);
    gRR.connect(merger, 0, 1);

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.volume;

    merger.connect(masterGain);
    masterGain.connect(ctx.destination);

    // Stereo post-matrix metering analysers
    const meterSplit = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    analyserL.fftSize = 1024;
    analyserR.fftSize = 1024;
    analyserL.smoothingTimeConstant = 0.72;
    analyserR.smoothingTimeConstant = 0.72;

    masterGain.connect(meterSplit);
    meterSplit.connect(analyserL, 0);
    meterSplit.connect(analyserR, 1);

    this.mixBus = mixBus;
    this.splitter = splitter;
    this.merger = merger;
    this.matrix = { gLL, gRL, gLR, gRR };
    this.masterGain = masterGain;
    this.analyserL = analyserL;
    this.analyserR = analyserR;
    this.timeBufL = new Float32Array(analyserL.fftSize);
    this.timeBufR = new Float32Array(analyserR.fftSize);

    this._applyMonitorMatrix(true);
    return ctx;
  }

  async resume() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  addStem(id, audioBuffer) {
    this.ensureContext();
    const gainNode = this.ctx.createGain();
    gainNode.connect(this.mixBus);

    this.stems.set(id, {
      id,
      buffer: audioBuffer,
      mute: false,
      solo: false,
      gainNode,
      sourceNode: null,
    });

    this._recomputeMaxDuration();
    this._applyStemGains(true);
  }

  removeStem(id) {
    const entry = this.stems.get(id);
    if (!entry) return;
    if (entry.sourceNode) {
      try {
        entry.sourceNode.stop();
        entry.sourceNode.disconnect();
      } catch (_) {
        // already stopped
      }
    }
    try {
      entry.gainNode.disconnect();
    } catch (_) {
      // ignore
    }
    this.stems.delete(id);
    this._recomputeMaxDuration();
    this._applyStemGains(false);
    if (this.stems.size === 0) {
      this.stop();
    }
  }

  clearAll() {
    this.stop();
    for (const entry of this.stems.values()) {
      try {
        entry.gainNode.disconnect();
      } catch (_) {
        // ignore
      }
    }
    this.stems.clear();
    this.maxDurationSec = 0;
    this.pauseOffsetSec = 0;
  }

  _recomputeMaxDuration() {
    let maxD = 0;
    for (const entry of this.stems.values()) {
      if (entry.buffer && entry.buffer.duration > maxD) {
        maxD = entry.buffer.duration;
      }
    }
    this.maxDurationSec = maxD;
  }

  setMute(id, muted) {
    const entry = this.stems.get(id);
    if (!entry) return;
    entry.mute = Boolean(muted);
    this._applyStemGains(false);
  }

  setSolo(id, soloed) {
    const entry = this.stems.get(id);
    if (!entry) return;
    entry.solo = Boolean(soloed);
    this._applyStemGains(false);
  }

  soloExclusive(id) {
    for (const [key, entry] of this.stems.entries()) {
      entry.solo = key === id;
      if (key === id) entry.mute = false;
    }
    this._applyStemGains(false);
  }

  clearAllSoloMute() {
    for (const entry of this.stems.values()) {
      entry.solo = false;
      entry.mute = false;
    }
    this._applyStemGains(false);
  }

  hasAnySolo() {
    for (const entry of this.stems.values()) {
      if (entry.solo) return true;
    }
    return false;
  }

  getStemState(id) {
    const entry = this.stems.get(id);
    return entry ? { mute: entry.mute, solo: entry.solo } : { mute: false, solo: false };
  }

  _applyStemGains(immediate = false) {
    if (!this.ctx) return;
    const anySolo = this.hasAnySolo();
    const now = this.ctx.currentTime;

    for (const entry of this.stems.values()) {
      const audible = anySolo ? entry.solo : !entry.mute;
      const target = audible ? 1.0 : 0.0;
      const param = entry.gainNode.gain;
      param.cancelScheduledValues(now);
      if (immediate) {
        param.setValueAtTime(target, now);
      } else {
        param.setTargetAtTime(target, now, 0.015);
      }
    }
  }

  setMonitorMode(mode) {
    if (!['stereo', 'mono', 'side'].includes(mode)) return;
    this.monitorMode = mode;
    this._applyMonitorMatrix(false);
  }

  _applyMonitorMatrix(immediate = false) {
    if (!this.ctx || !this.matrix) return;
    const now = this.ctx.currentTime;
    const { gLL, gRL, gLR, gRR } = this.matrix;

    let ll = 1;
    let rl = 0;
    let lr = 0;
    let rr = 1;

    if (this.monitorMode === 'mono') {
      ll = 0.5;
      rl = 0.5;
      lr = 0.5;
      rr = 0.5;
    } else if (this.monitorMode === 'side') {
      // Side difference L - R routed to both ears (boosted slightly for clear FX audition)
      ll = 0.7;
      rl = -0.7;
      lr = 0.7;
      rr = -0.7;
    }

    const pairs = [
      [gLL.gain, ll],
      [gRL.gain, rl],
      [gLR.gain, lr],
      [gRR.gain, rr],
    ];
    for (const [param, val] of pairs) {
      param.cancelScheduledValues(now);
      if (immediate) {
        param.setValueAtTime(val, now);
      } else {
        param.setTargetAtTime(val, now, 0.015);
      }
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, Number(val) || 0));
    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setTargetAtTime(this.volume, now, 0.015);
    }
  }

  async play(offsetSec = null) {
    if (this.stems.size === 0 || this.maxDurationSec <= 0) return;
    await this.resume();

    const startOffset =
      offsetSec != null
        ? Math.max(0, Math.min(this.maxDurationSec, offsetSec))
        : this.pauseOffsetSec >= this.maxDurationSec - 0.03
          ? 0
          : this.pauseOffsetSec;

    this._stopSources();
    this._applyStemGains(true);

    const scheduleAt = this.ctx.currentTime + 0.025;
    for (const entry of this.stems.values()) {
      if (!entry.buffer || startOffset >= entry.buffer.duration - 0.005) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = entry.buffer;
      src.connect(entry.gainNode);
      src.start(scheduleAt, startOffset);
      entry.sourceNode = src;
    }

    this.startCtxTime = scheduleAt - startOffset;
    this.pauseOffsetSec = startOffset;
    this.isPlaying = true;

    const remainingMs = Math.max(40, (this.maxDurationSec - startOffset) * 1000 + 60);
    this._clearEndTimer();
    this._endTimer = setTimeout(() => {
      if (!this.isPlaying) return;
      this._stopSources();
      this.isPlaying = false;
      this.pauseOffsetSec = 0;
      if (typeof this.onEnded === 'function') this.onEnded();
    }, remainingMs);
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseOffsetSec = this.getCurrentTime();
    this._stopSources();
    this.isPlaying = false;
  }

  stop() {
    this._stopSources();
    this.isPlaying = false;
    this.pauseOffsetSec = 0;
  }

  async seek(sec) {
    const clamped = Math.max(0, Math.min(this.maxDurationSec, Number(sec) || 0));
    this.pauseOffsetSec = clamped;
    if (this.isPlaying) {
      await this.play(clamped);
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) {
      return Math.max(0, Math.min(this.maxDurationSec, this.pauseOffsetSec));
    }
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    return Math.max(0, Math.min(this.maxDurationSec, elapsed));
  }

  _stopSources() {
    this._clearEndTimer();
    for (const entry of this.stems.values()) {
      if (entry.sourceNode) {
        try {
          entry.sourceNode.stop();
          entry.sourceNode.disconnect();
        } catch (_) {
          // ignore
        }
        entry.sourceNode = null;
      }
    }
  }

  _clearEndTimer() {
    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }
  }

  /**
   * Real-time post-matrix stereo VU meter snapshot for the dark console deck.
   */
  getMeterSnapshot() {
    if (!this.isPlaying || !this.analyserL || !this.analyserR) {
      return { leftPct: 0, rightPct: 0, clippingL: false, clippingR: false };
    }
    this.analyserL.getFloatTimeDomainData(this.timeBufL);
    this.analyserR.getFloatTimeDomainData(this.timeBufR);

    let peakL = 0;
    let peakR = 0;
    let sqL = 0;
    let sqR = 0;
    const len = this.timeBufL.length;

    for (let i = 0; i < len; i += 1) {
      const l = this.timeBufL[i];
      const r = this.timeBufR[i];
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
      sqL += l * l;
      sqR += r * r;
    }

    const rmsL = Math.sqrt(sqL / len);
    const rmsR = Math.sqrt(sqR / len);
    const dbL = rmsL > 1e-6 ? 20 * Math.log10(rmsL) : -60;
    const dbR = rmsR > 1e-6 ? 20 * Math.log10(rmsR) : -60;

    return {
      leftPct: Math.max(0, Math.min(100, ((dbL + 54) / 54) * 100)),
      rightPct: Math.max(0, Math.min(100, ((dbR + 54) / 54) * 100)),
      clippingL: peakL >= 0.995,
      clippingR: peakR >= 0.995,
    };
  }
}

/* --------------------------------------------------------------------------
 * Pure-JS WAV PCM16 Encoder & Built-In 4-Stem Demo Pack Generator
 * -------------------------------------------------------------------------- */

/**
 * Encode Float32Array channel arrays into a valid RIFF/WAVE 16-bit PCM Uint8Array.
 */
export function encodeWavPcm16(channels, sampleRate) {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const bitsPerSample = 16;
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(off + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let pos = 44;
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      let s = channels[c][i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      view.setInt16(pos, int16, true);
      pos += 2;
    }
  }

  return new Uint8Array(buffer);
}

// Deterministic pseudo-noise for crisp snares/hats without Math.random variance
function seededNoise(seed) {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return (x / 4294967295) * 2 - 1;
}

/**
 * Synthesize a vocal-like formant melody phrase (used for Dry Main Vox & Wet Hook Double).
 */
function renderVocalPhrase(numSamples, sr, startSec, notes, gain = 0.45, detuneRatio = 1.0) {
  const out = new Float32Array(numSamples);
  const startSample = Math.floor(startSec * sr);

  for (const note of notes) {
    const nStart = startSample + Math.floor(note.t * sr);
    const nLen = Math.floor(note.dur * sr);
    const baseFreq = note.freq * detuneRatio;

    for (let i = 0; i < nLen; i += 1) {
      const idx = nStart + i;
      if (idx < 0 || idx >= numSamples) continue;
      const localT = i / sr;
      const norm = i / nLen;

      // Smooth vocal ADSR envelope
      const attack = Math.min(1, localT / 0.035);
      const release = Math.min(1, (note.dur - localT) / 0.08);
      const env = Math.max(0, attack * release);

      // Gentle human vibrato
      const vibrato = 1 + 0.008 * Math.sin(2 * Math.PI * 5.2 * localT);
      const f = baseFreq * vibrato;
      const w = 2 * Math.PI * f * localT;

      // Vocal formant harmonic blend (warm chest + nasal presence)
      const sig =
        0.55 * Math.sin(w) +
        0.3 * Math.sin(2 * w + 0.4) +
        0.18 * Math.sin(3 * w + 0.9) +
        0.09 * Math.sin(4 * w + 1.5) +
        0.04 * Math.sin(5 * w);

      out[idx] += sig * env * gain * (0.85 + 0.15 * Math.sin(Math.PI * norm));
    }
  }
  return out;
}

/**
 * Generate the 4-stem built-in Demo Pack as real in-memory WAV files with
 * intentional real-world stem errors so artists can audition every check in one click!
 *
 * 1. 01_Beat_Instrumental_44k.wav  — 8.0s stereo 44.1 kHz beat -> PASS
 * 2. 02_Main_Vox_Dry_Mono.wav      — 8.0s mono 44.1 kHz dry vocal starting at 2.0s -> PASS
 * 3. 03_Hook_Double_WET_48k.wav    — 8.0s stereo 48 kHz vocal with wide stereo FX -> FAIL (SR + Stereo FX)
 * 4. 04_Adlibs_Clipped_Short.wav   — 3.5s mono 44.1 kHz clipped vocal starting at 0.00s -> FAIL (Length + Clip)
 */
export function generateDemoStemPack() {
  const sr44 = 44100;
  const sr48 = 48000;
  const fullDur = 8.0;
  const n44 = Math.round(sr44 * fullDur);
  const n48 = Math.round(sr48 * fullDur);

  // ---- 1. 01_Beat_Instrumental_44k.wav (8.0s stereo 44.1 kHz, 120 BPM) ----
  const beatL = new Float32Array(n44);
  const beatR = new Float32Array(n44);
  const chords = [
    [130.81, 155.56, 196.0, 233.08], // Cm7 (0..2s)
    [116.54, 146.83, 174.61, 220.0], // Bbmaj7 (2..4s)
    [103.83, 130.81, 155.56, 196.0], // Abmaj7 (4..6s)
    [98.0, 123.47, 146.83, 174.61], // G7 (6..8s)
  ];

  for (let i = 0; i < n44; i += 1) {
    const t = i / sr44;
    const barIdx = Math.min(3, Math.floor(t / 2.0));
    const barLocal = t - barIdx * 2.0;
    const beatLocal = t % 0.5;
    const halfBeat = t % 0.25;
    const beatNum = Math.floor(t / 0.5) % 4;

    // Warm dark pad/keys with slight stereo spread
    const chord = chords[barIdx];
    const padEnv = Math.min(1, barLocal / 0.06) * Math.exp(-barLocal * 0.55);
    let padL = 0;
    let padR = 0;
    for (let k = 0; k < chord.length; k += 1) {
      const f = chord[k];
      const v1 = Math.sin(2 * Math.PI * f * t);
      const v2 = 0.28 * Math.sin(2 * Math.PI * (f * 2.002) * t + k);
      const pan = k % 2 === 0 ? 0.65 : 0.35;
      padL += (v1 + v2) * pan;
      padR += (v1 + v2) * (1 - pan);
    }
    padL *= 0.14 * padEnv;
    padR *= 0.14 * padEnv;

    // Punchy 808 kick on beats 0 & 2.5
    let kick = 0;
    const kickTrigger = beatNum === 0 ? beatLocal : beatNum === 2 && beatLocal >= 0.25 ? beatLocal - 0.25 : -1;
    if (kickTrigger >= 0 && kickTrigger < 0.32) {
      const kFreq = 46 + 115 * Math.exp(-kickTrigger * 28);
      const kEnv = Math.exp(-kickTrigger * 9.5);
      kick = Math.sin(2 * Math.PI * kFreq * kickTrigger) * kEnv * 0.42;
    }

    // Snare on beats 1 & 3
    let snareL = 0;
    let snareR = 0;
    if ((beatNum === 1 || beatNum === 3) && beatLocal < 0.18) {
      const sEnv = Math.exp(-beatLocal * 24);
      const tone = Math.sin(2 * Math.PI * 190 * beatLocal) * Math.exp(-beatLocal * 36);
      const nL = seededNoise(i * 3 + 11);
      const nR = seededNoise(i * 3 + 29);
      snareL = (tone * 0.18 + nL * 0.22) * sEnv;
      snareR = (tone * 0.18 + nR * 0.22) * sEnv;
    }

    // Subtle closed hi-hat every 8th note
    let hat = 0;
    if (halfBeat < 0.04) {
      hat = seededNoise(i * 7 + 5) * Math.exp(-halfBeat * 85) * 0.07;
    }

    // Smooth fade out last 80ms
    const fadeOut = t > fullDur - 0.08 ? Math.max(0, (fullDur - t) / 0.08) : 1;
    beatL[i] = (padL + kick + snareL + hat * 0.85) * fadeOut;
    beatR[i] = (padR + kick + snareR + hat * 1.05) * fadeOut;
  }

  const beatWav = encodeWavPcm16([beatL, beatR], sr44);

  // ---- 2. 02_Main_Vox_Dry_Mono.wav (8.0s MONO 44.1 kHz, starts at 2.00s) ----
  const mainNotes = [
    { t: 0.0, dur: 0.42, freq: 261.63 }, // C4
    { t: 0.5, dur: 0.38, freq: 311.13 }, // Eb4
    { t: 1.0, dur: 0.65, freq: 293.66 }, // D4
    { t: 2.0, dur: 0.45, freq: 261.63 }, // C4
    { t: 2.5, dur: 0.45, freq: 233.08 }, // Bb3
    { t: 3.1, dur: 0.72, freq: 261.63 }, // C4
    { t: 4.0, dur: 0.55, freq: 311.13 }, // Eb4
  ];
  const mainVoxMono = renderVocalPhrase(n44, sr44, 2.0, mainNotes, 0.44, 1.0);
  const mainVoxWav = encodeWavPcm16([mainVoxMono], sr44);

  // ---- 3. 03_Hook_Double_WET_48k.wav (8.0s STEREO 48 kHz, baked-in stereo reverb + chorus!) ----
  const dry48 = renderVocalPhrase(n48, sr48, 2.0, mainNotes, 0.34, 1.003);
  const wetL = new Float32Array(n48);
  const wetR = new Float32Array(n48);

  // Multi-tap stereo comb reverb + opposite-phase stereo chorus -> strong Side/Mid energy!
  const tapsL = [
    { delay: Math.round(sr48 * 0.029), gain: 0.48 },
    { delay: Math.round(sr48 * 0.067), gain: 0.36 },
    { delay: Math.round(sr48 * 0.137), gain: 0.28 },
    { delay: Math.round(sr48 * 0.241), gain: 0.21 },
    { delay: Math.round(sr48 * 0.389), gain: 0.15 },
  ];
  const tapsR = [
    { delay: Math.round(sr48 * 0.037), gain: -0.46 },
    { delay: Math.round(sr48 * 0.083), gain: 0.38 },
    { delay: Math.round(sr48 * 0.163), gain: -0.29 },
    { delay: Math.round(sr48 * 0.277), gain: 0.22 },
    { delay: Math.round(sr48 * 0.431), gain: -0.16 },
  ];

  for (let i = 0; i < n48; i += 1) {
    const t = i / sr48;
    // Stereo modulated chorus delay
    const modL = Math.round(sr48 * (0.011 + 0.004 * Math.sin(2 * Math.PI * 1.4 * t)));
    const modR = Math.round(sr48 * (0.014 + 0.004 * Math.cos(2 * Math.PI * 1.7 * t)));
    let l = dry48[i] * 0.58 + (i >= modL ? dry48[i - modL] * 0.38 : 0);
    let r = dry48[i] * 0.58 + (i >= modR ? -dry48[i - modR] * 0.38 : 0);

    for (const tap of tapsL) {
      if (i >= tap.delay) l += dry48[i - tap.delay] * tap.gain;
    }
    for (const tap of tapsR) {
      if (i >= tap.delay) r += dry48[i - tap.delay] * tap.gain;
    }

    // Soft safety limit at -1.5 dBFS so this track specifically tests SR + Stereo FX (not clipping)
    wetL[i] = Math.max(-0.84, Math.min(0.84, l));
    wetR[i] = Math.max(-0.84, Math.min(0.84, r));
  }
  const wetDoubleWav = encodeWavPcm16([wetL, wetR], sr48);

  // ---- 4. 04_Adlibs_Clipped_Short.wav (3.5s MONO 44.1 kHz, starts at 0.00s + hard clipping!) ----
  const shortDur = 3.5;
  const nShort = Math.round(sr44 * shortDur);
  const adlibNotes = [
    { t: 0.0, dur: 0.36, freq: 392.0 }, // G4 right at 0.00s (sliced export!)
    { t: 0.6, dur: 0.42, freq: 466.16 }, // Bb4
    { t: 1.4, dur: 0.48, freq: 523.25 }, // C5
    { t: 2.3, dur: 0.52, freq: 392.0 }, // G4
  ];
  const rawAdlibs = renderVocalPhrase(nShort, sr44, 0.0, adlibNotes, 1.55, 1.0);
  // Hard digital clip at +/- 1.0 + immediate transient at sample 0
  for (let i = 0; i < nShort; i += 1) {
    let v = rawAdlibs[i];
    if (i < 120) {
      // Abrupt click/transient right at sample 0 simulating unsliced region start
      v += 0.35 * Math.sin(2 * Math.PI * 392 * (i / sr44));
    }
    if (v > 1.0) v = 1.0;
    else if (v < -1.0) v = -1.0;
    rawAdlibs[i] = v;
  }
  const adlibsWav = encodeWavPcm16([rawAdlibs], sr44);

  return [
    { filename: '01_Beat_Instrumental_44k.wav', bytes: beatWav },
    { filename: '02_Main_Vox_Dry_Mono.wav', bytes: mainVoxWav },
    { filename: '03_Hook_Double_WET_48k.wav', bytes: wetDoubleWav },
    { filename: '04_Adlibs_Clipped_Short.wav', bytes: adlibsWav },
  ];
}
