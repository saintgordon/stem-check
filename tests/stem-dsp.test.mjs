import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeStemChannels,
  buildStemReportMarkdown,
  classifyStemRole,
  decodeIeee80Extended,
  isGenericStemFilename,
  isSupportedAudioFilename,
  parseNativeAudioHeader,
  validateStemSession,
} from '../js/stem-dsp.js';

import { encodeWavPcm16, generateDemoStemPack } from '../js/stem-audio.js';

/* --------------------------------------------------------------------------
 * Binary Header Fixture Builders
 * -------------------------------------------------------------------------- */

function makeWav24BitHeader(sampleRate, channels, numFrames) {
  const bitsPerSample = 24;
  const blockAlign = channels * 3;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const putStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };
  putStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  putStr(8, 'WAVE');
  putStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  putStr(36, 'data');
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

function makeFlacHeader(sampleRate, channels, bitsPerSample, totalSamples) {
  // 'fLaC' (4) + block header (4) + STREAMINFO (34) = 42 bytes
  const bytes = new Uint8Array(42);
  bytes[0] = 0x66; // f
  bytes[1] = 0x4c; // L
  bytes[2] = 0x61; // a
  bytes[3] = 0x43; // C
  bytes[4] = 0x80; // isLast=1, type=0 (STREAMINFO)
  bytes[5] = 0x00;
  bytes[6] = 0x00;
  bytes[7] = 34;

  const base = 8;
  const chMinus1 = (channels - 1) & 0x07;
  const bpsMinus1 = (bitsPerSample - 1) & 0x1f;
  const totalHi = Math.floor(totalSamples / 4294967296) & 0x0f;
  const totalLo = totalSamples >>> 0;

  bytes[base + 10] = (sampleRate >> 12) & 0xff;
  bytes[base + 11] = (sampleRate >> 4) & 0xff;
  bytes[base + 12] =
    ((sampleRate & 0x0f) << 4) | (chMinus1 << 1) | ((bpsMinus1 >> 4) & 0x01);
  bytes[base + 13] = ((bpsMinus1 & 0x0f) << 4) | totalHi;
  bytes[base + 14] = (totalLo >>> 24) & 0xff;
  bytes[base + 15] = (totalLo >>> 16) & 0xff;
  bytes[base + 16] = (totalLo >>> 8) & 0xff;
  bytes[base + 17] = totalLo & 0xff;
  return bytes;
}

function encodeIeee80Extended(value) {
  const out = new Uint8Array(10);
  if (value <= 0) return out;
  const expFloat = Math.floor(Math.log2(value));
  const biasedExp = expFloat + 16383;
  const norm = value / Math.pow(2, expFloat); // [1, 2)
  const hiMant = Math.floor(norm * 0x80000000) >>> 0;
  const rem = norm * 0x80000000 - hiMant;
  const loMant = Math.floor(rem * 0x100000000) >>> 0;

  out[0] = (biasedExp >> 8) & 0x7f;
  out[1] = biasedExp & 0xff;
  out[2] = (hiMant >>> 24) & 0xff;
  out[3] = (hiMant >>> 16) & 0xff;
  out[4] = (hiMant >>> 8) & 0xff;
  out[5] = hiMant & 0xff;
  out[6] = (loMant >>> 24) & 0xff;
  out[7] = (loMant >>> 16) & 0xff;
  out[8] = (loMant >>> 8) & 0xff;
  out[9] = loMant & 0xff;
  return out;
}

function makeAiffHeader(sampleRate, channels, bitsPerSample, sampleFrames) {
  // FORM(12) + COMM header(8) + COMM payload(18) = 38 bytes
  const buf = new ArrayBuffer(38);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const putStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i));
  };
  putStr(0, 'FORM');
  v.setUint32(4, 30, false);
  putStr(8, 'AIFF');
  putStr(12, 'COMM');
  v.setUint32(16, 18, false);
  v.setUint16(20, channels, false);
  v.setUint32(22, sampleFrames, false);
  v.setUint16(26, bitsPerSample, false);
  u8.set(encodeIeee80Extended(sampleRate), 28);
  return u8;
}

function makeMp3WithId3({ sampleRate = 44100, bitrateIdx = 14, channelMode = 0 } = {}) {
  // ID3v2 header (10 bytes) + 16 bytes tag payload + 2 valid consecutive MPEG1 Layer III frames
  const srIdx = sampleRate === 44100 ? 0 : sampleRate === 48000 ? 1 : 2;
  const brMap = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrateKbps = brMap[bitrateIdx];
  const frameLen = Math.floor((144 * bitrateKbps * 1000) / sampleRate);

  const id3Payload = 16;
  const start = 10 + id3Payload;
  const bytes = new Uint8Array(start + frameLen * 2 + 4);
  bytes[0] = 0x49; // I
  bytes[1] = 0x44; // D
  bytes[2] = 0x33; // 3
  bytes[3] = 3; // v2.3
  bytes[9] = id3Payload; // synchsafe size

  const writeFrameHeader = (pos) => {
    bytes[pos] = 0xff;
    bytes[pos + 1] = 0xfb; // sync + MPEG1(3) + LayerIII(1) + noCRC(1)
    bytes[pos + 2] = (bitrateIdx << 4) | (srIdx << 2);
    bytes[pos + 3] = channelMode << 6;
  };
  writeFrameHeader(start);
  writeFrameHeader(start + frameLen);
  return bytes;
}

function makeSine(sr, durSec, freq = 440, amp = 0.5, startSec = 0) {
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  const startIdx = Math.round(sr * startSec);
  for (let i = startIdx; i < n; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * (i - startIdx)) / sr);
  }
  return out;
}

function decodePcm16WavChannels(wavBytes) {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  const numFrames = dataSize / (channels * 2);
  const out = Array.from({ length: channels }, () => new Float32Array(numFrames));
  let pos = 44;
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      out[c][i] = view.getInt16(pos, true) / 32768;
      pos += 2;
    }
  }
  return { channels: out, sampleRate };
}

/* --------------------------------------------------------------------------
 * 1. Native Container Header Parser Tests
 * -------------------------------------------------------------------------- */

test('Native WAV parser reads 16-bit 44.1 kHz mono & 24-bit 48 kHz stereo accurately', () => {
  const mono44 = encodeWavPcm16([makeSine(44100, 2.5, 330, 0.3)], 44100);
  const h1 = parseNativeAudioHeader(mono44, 'Main_Vox.wav');
  assert.equal(h1.parsed, true);
  assert.equal(h1.format, 'WAV');
  assert.equal(h1.sampleRate, 44100);
  assert.equal(h1.channels, 1);
  assert.equal(h1.bitsPerSample, 16);
  assert.equal(h1.isLossy, false);
  assert.ok(Math.abs(h1.durationSec - 2.5) < 0.01);

  const stereo48 = makeWav24BitHeader(48000, 2, 48000 * 12);
  const h2 = parseNativeAudioHeader(stereo48, 'Beat_48k.wav');
  assert.equal(h2.parsed, true);
  assert.equal(h2.format, 'WAV');
  assert.equal(h2.sampleRate, 48000);
  assert.equal(h2.channels, 2);
  assert.equal(h2.bitsPerSample, 24);
  assert.equal(h2.isLossy, false);
  assert.equal(h2.durationSec, 12);
});

test('Native FLAC STREAMINFO parser reads 24-bit 48 kHz stereo & duration', () => {
  const flacBytes = makeFlacHeader(48000, 2, 24, 48000 * 10);
  const h = parseNativeAudioHeader(flacBytes, 'Lead_Vox.flac');
  assert.equal(h.parsed, true);
  assert.equal(h.format, 'FLAC');
  assert.equal(h.sampleRate, 48000);
  assert.equal(h.channels, 2);
  assert.equal(h.bitsPerSample, 24);
  assert.equal(h.isLossy, false);
  assert.equal(h.durationSec, 10);
});

test('Native AIFF COMM parser decodes 80-bit IEEE extended float at 44.1 kHz and 48 kHz', () => {
  const aiff44 = makeAiffHeader(44100, 1, 24, 44100 * 6);
  const h44 = parseNativeAudioHeader(aiff44, 'Verse_Take.aiff');
  assert.equal(h44.parsed, true);
  assert.equal(h44.format, 'AIFF');
  assert.equal(h44.sampleRate, 44100);
  assert.equal(h44.channels, 1);
  assert.equal(h44.bitsPerSample, 24);
  assert.equal(h44.isLossy, false);
  assert.equal(h44.durationSec, 6);

  const aiff48 = makeAiffHeader(48000, 2, 16, 48000 * 4);
  const h48 = parseNativeAudioHeader(aiff48, 'Beat.aif');
  assert.equal(h48.sampleRate, 48000);
  assert.equal(h48.channels, 2);
  assert.equal(h48.durationSec, 4);

  assert.equal(Math.round(decodeIeee80Extended(encodeIeee80Extended(96000), 0)), 96000);
});

test('Native MP3 parser skips ID3v2 and extracts sample rate, bitrate, channels, and isLossy', () => {
  const mp3Stereo = makeMp3WithId3({ sampleRate: 44100, bitrateIdx: 14, channelMode: 0 });
  const h1 = parseNativeAudioHeader(mp3Stereo, 'Beat.mp3');
  assert.equal(h1.parsed, true);
  assert.equal(h1.format, 'MP3');
  assert.equal(h1.sampleRate, 44100);
  assert.equal(h1.bitrateKbps, 320);
  assert.equal(h1.channels, 2);
  assert.equal(h1.isLossy, true);

  const mp3Mono = makeMp3WithId3({ sampleRate: 48000, bitrateIdx: 11, channelMode: 3 });
  const h2 = parseNativeAudioHeader(mp3Mono, 'Main_Vox.mp3');
  assert.equal(h2.parsed, true);
  assert.equal(h2.sampleRate, 48000);
  assert.equal(h2.bitrateKbps, 192);
  assert.equal(h2.channels, 1);
  assert.equal(h2.isLossy, true);
});

/* --------------------------------------------------------------------------
 * 2. Stem Role Classification & Filename Validation
 * -------------------------------------------------------------------------- */

test('classifyStemRole accurately classifies Beat, Vocal, and FX stems', () => {
  assert.equal(classifyStemRole('Beat.mp3'), 'beat');
  assert.equal(classifyStemRole('01_Beat_Instrumental_44k.wav'), 'beat');
  assert.equal(classifyStemRole('2-Track_Prod.wav'), 'beat');
  assert.equal(classifyStemRole('Backing_Track.wav'), 'beat');

  assert.equal(classifyStemRole('Main Vox.wav'), 'vocal');
  assert.equal(classifyStemRole('02_Main_Vox_Dry_Mono.wav'), 'vocal');
  assert.equal(classifyStemRole('03_Hook_Double_WET_48k.wav'), 'vocal');
  assert.equal(classifyStemRole('04_Adlibs_Clipped_Short.wav'), 'vocal');
  assert.equal(classifyStemRole('Harmonies_High.wav'), 'vocal');
  assert.equal(classifyStemRole('Backing_Vox.wav'), 'vocal');

  assert.equal(classifyStemRole('Reverb Bus.wav'), 'fx');
  assert.equal(classifyStemRole('Vox_Delay_Return.wav'), 'fx');
  assert.equal(classifyStemRole('808_Bass.wav'), 'fx');

  assert.equal(isGenericStemFilename('Audio 1.wav'), true);
  assert.equal(isGenericStemFilename('Untitled.wav'), true);
  assert.equal(isGenericStemFilename('Main Vox.wav'), false);
  assert.equal(isSupportedAudioFilename('._Main_Vox.wav'), false);
  assert.equal(isSupportedAudioFilename('Main_Vox.wav'), true);
});

/* --------------------------------------------------------------------------
 * 3. Clipping & Mid/Side Stereo FX Detection Tests
 * -------------------------------------------------------------------------- */

test('Digital clipping detector catches 0 dBFS hard clip bursts vs clean -6 dBFS vocal', () => {
  const sr = 44100;
  const clean = makeSine(sr, 2.0, 260, 0.5, 0.25); // ~ -6 dBFS
  const cleanRes = analyzeStemChannels([clean], sr, null, 'vocal', 'Main_Vox.wav');
  assert.equal(cleanRes.clippedSamples, 0);
  assert.equal(cleanRes.hardClipBursts, 0);
  assert.equal(cleanRes.headroomStatus, 'pass');
  assert.ok(cleanRes.samplePeakDbfs > -6.3 && cleanRes.samplePeakDbfs < -5.8);

  const clipped = makeSine(sr, 2.0, 260, 1.8, 0.25);
  for (let i = 0; i < clipped.length; i += 1) {
    if (clipped[i] > 1) clipped[i] = 1;
    if (clipped[i] < -1) clipped[i] = -1;
  }
  const clipRes = analyzeStemChannels([clipped], sr, null, 'vocal', 'Adlibs_Clipped.wav');
  assert.ok(clipRes.clippedSamples > 50);
  assert.ok(clipRes.hardClipBursts > 5);
  assert.ok(clipRes.clipTimestamps.length > 0);
  assert.equal(clipRes.headroomStatus, 'fail');
  assert.ok(clipRes.clipBinFlags.some(Boolean));
});

test('Mid/Side stereo FX check distinguishes Pure Mono, Dual-Mono, Light Stereo, and Baked-In Stereo FX', () => {
  const sr = 44100;
  const sig = makeSine(sr, 2.0, 300, 0.35, 0.1);

  // 1. Pure Mono (1ch) -> PASS
  const monoRes = analyzeStemChannels([sig], sr, null, 'vocal', 'Main_Vox_Mono.wav');
  assert.equal(monoRes.isNativeMono, true);
  assert.equal(monoRes.stereoFxStatus, 'pass');
  assert.equal(monoRes.stereoWidthPct, 0);

  // 2. Dual-Mono Stereo (L === R) -> PASS
  const dualMonoRes = analyzeStemChannels([sig, new Float32Array(sig)], sr, null, 'vocal', 'Main_Vox_Stereo.wav');
  assert.equal(dualMonoRes.isNativeMono, false);
  assert.equal(dualMonoRes.stereoFxStatus, 'pass');
  assert.equal(dualMonoRes.stereoWidthPct, 0);

  // 3. Light Stereo (-32 dB Side relative to Mid) -> WARN
  const sideSubtle = makeSine(sr, 2.0, 517, 0.35 * Math.pow(10, -32 / 20), 0.1);
  const lightL = new Float32Array(sig.length);
  const lightR = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i += 1) {
    lightL[i] = sig[i] + sideSubtle[i];
    lightR[i] = sig[i] - sideSubtle[i];
  }
  const lightRes = analyzeStemChannels([lightL, lightR], sr, null, 'vocal', 'Double_Light_Stereo.wav');
  assert.equal(lightRes.stereoFxStatus, 'warn');
  assert.ok(lightRes.sideToMidDb > -48 && lightRes.sideToMidDb <= -24);

  // 4. Heavy Baked-In Stereo Reverb/Chorus (-8 dB Side/Mid) -> FAIL
  const sideWet = makeSine(sr, 2.0, 517, 0.35 * Math.pow(10, -8 / 20), 0.1);
  const wetL = new Float32Array(sig.length);
  const wetR = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i += 1) {
    wetL[i] = sig[i] + sideWet[i];
    wetR[i] = sig[i] - sideWet[i];
  }
  const wetRes = analyzeStemChannels([wetL, wetR], sr, null, 'vocal', 'Hook_Wet.wav');
  assert.equal(wetRes.stereoFxStatus, 'fail');
  assert.ok(wetRes.sideToMidDb > -24);
});

/* --------------------------------------------------------------------------
 * 4. Cross-Stem Session Validation & Report Tests
 * -------------------------------------------------------------------------- */

test('Clean 100%-passing session returns READY (including MP3 Beat + 24-bit WAV dry vocals)', () => {
  const sr = 44100;
  const beatHdr = {
    format: 'MP3',
    container: 'MPEG',
    sampleRate: 44100,
    channels: 2,
    bitsPerSample: null,
    bitrateKbps: 320,
    durationSec: 6.0,
    isLossy: true,
    isFloat: false,
    parsed: true,
  };
  const voxHdr = {
    format: 'WAV',
    container: 'RIFF',
    sampleRate: 44100,
    channels: 1,
    bitsPerSample: 24,
    bitrateKbps: 1058,
    durationSec: 6.0,
    isLossy: false,
    isFloat: false,
    parsed: true,
  };

  const beatL = makeSine(sr, 6.0, 110, 0.45, 0.05);
  const beatR = makeSine(sr, 6.0, 165, 0.45, 0.05);
  const vox = makeSine(sr, 6.0, 280, 0.35, 1.5);

  const sBeat = analyzeStemChannels([beatL, beatR], sr, beatHdr, 'beat', 'Beat_Instrumental.mp3');
  const sVox = analyzeStemChannels([vox], sr, voxHdr, 'vocal', 'Main_Vox.wav');

  const session = validateStemSession([sBeat, sVox]);
  assert.equal(session.verdict, 'READY');
  assert.equal(session.summary.failCount, 0);
  assert.equal(session.summary.warnCount, 0);
  assert.equal(session.targetSampleRate, 44100);
});

test('Session validation warns on lossy MP3 dry vocal while passing MP3 beat', () => {
  const sr = 44100;
  const mp3Hdr = {
    format: 'MP3',
    container: 'MPEG',
    sampleRate: 44100,
    channels: 1,
    bitsPerSample: null,
    bitrateKbps: 320,
    durationSec: 5.0,
    isLossy: true,
    isFloat: false,
    parsed: true,
  };
  const sBeat = analyzeStemChannels(
    [makeSine(sr, 5.0, 110, 0.4, 0.05), makeSine(sr, 5.0, 160, 0.4, 0.05)],
    sr,
    { ...mp3Hdr, channels: 2 },
    'beat',
    'Beat.mp3'
  );
  const sVox = analyzeStemChannels([makeSine(sr, 5.0, 300, 0.35, 1.0)], sr, mp3Hdr, 'vocal', 'Main_Vox.mp3');
  const session = validateStemSession([sBeat, sVox]);

  assert.equal(session.verdict, 'REVIEW');
  assert.equal(session.summary.failCount, 0);
  assert.ok(session.checklist.some((c) => c.id === 'format-lossless' && c.status === 'warn'));
});

test('Built-in 4-stem Demo Pack triggers all 4 real-world failures & generates valid Markdown certificate', () => {
  const pack = generateDemoStemPack();
  assert.equal(pack.length, 4);

  const analyzed = pack.map(({ filename, bytes }) => {
    const hdr = parseNativeAudioHeader(bytes, filename);
    const { channels, sampleRate } = decodePcm16WavChannels(bytes);
    return analyzeStemChannels(channels, sampleRate, hdr, null, filename);
  });

  // Verify exact native headers on demo stems
  assert.equal(analyzed[0].nativeSampleRate, 44100);
  assert.equal(analyzed[0].role, 'beat');
  assert.equal(analyzed[1].nativeSampleRate, 44100);
  assert.equal(analyzed[1].role, 'vocal');
  assert.equal(analyzed[1].isNativeMono, true);
  assert.equal(analyzed[2].nativeSampleRate, 48000);
  assert.equal(analyzed[2].role, 'vocal');
  assert.equal(analyzed[3].nativeSampleRate, 44100);
  assert.equal(analyzed[3].durationSec, 3.5);

  const session = validateStemSession(analyzed);
  assert.equal(session.verdict, 'FIX REQUIRED');

  // Check each of the 4 critical fails fired!
  const byId = new Map(session.checklist.map((c) => [c.id, c]));
  assert.equal(byId.get('length-sync').status, 'fail');
  assert.equal(byId.get('sample-rate').status, 'fail');
  assert.equal(byId.get('clipping').status, 'fail');
  assert.equal(byId.get('dry-vocals').status, 'fail');

  // Verify per-stem flags
  const [beat, mainVox, wetDouble, shortAdlib] = session.stems;
  assert.equal(beat.stemStatus, 'pass');
  assert.equal(mainVox.stemStatus, 'pass');
  assert.equal(wetDouble.sampleRateMismatch, true);
  assert.equal(wetDouble.stereoFxStatus, 'fail');
  assert.equal(shortAdlib.looksSlicedNotZero, true);
  assert.equal(shortAdlib.clipStatus, 'fail');

  // Markdown certificate export
  const md = buildStemReportMarkdown(session, new Date('2026-11-24T00:00:00Z'));
  assert.ok(md.includes('Stem Check Validation Certificate'));
  assert.ok(md.includes('FIX REQUIRED'));
  assert.ok(md.includes('03_Hook_Double_WET_48k.wav'));
  assert.ok(md.includes('04_Adlibs_Clipped_Short.wav'));
  assert.ok(md.includes('https://saintgordon.vercel.app/collaboration.html'));
});
