/**
 * Stem Check (TOOL / 007) — Pre-Mix Stem Validator DSP & Native Header Engine.
 * Zero DOM dependencies — runs identically in browsers and Node.js tests.
 *
 * Implements:
 * - Native binary container header parsing BEFORE Web Audio decode (WAV/RF64, FLAC, AIFF/AIFC, MP3, M4A, OGG)
 *   so true source sample rates (e.g. 44.1 kHz vs 48 kHz) are never hidden by OS AudioContext resampling.
 * - Automatic stem role classification ('beat' | 'vocal' | 'fx') with manual override support.
 * - Per-stem DSP: Sample Peak (dBFS), 4x oversampled 12-tap Kaiser-windowed sinc True Peak (dBTP),
 *   RMS (dBFS), DC offset, digital clipping & hard clip burst (>= 3 consecutive samples) detector,
 *   0:00 start/activity bounds, abrupt-start click detection, 240-bin waveform & clip flags.
 * - Baked-in Stereo FX / Reverb detection via Mid/Side energy ratio, stereo width %, phase correlation,
 *   and vocal phrase release-tail ratio.
 * - Cross-stem session validation against Saint Gordon Collective's Collaborate Transmission Protocol
 *   + Markdown Stem Validation Certificate exporter.
 */

export const VALID_AUDIO_EXTENSIONS = [
  '.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.webm',
];

export const STEM_ROLES = ['beat', 'vocal', 'fx'];

export const ROLE_LABELS = {
  beat: 'Beat / Inst',
  vocal: 'Dry Vocal',
  fx: 'FX / Other',
};

/* --------------------------------------------------------------------------
 * Formatting & Basic Utilities
 * -------------------------------------------------------------------------- */

export function isSupportedAudioFilename(filename) {
  const name = String(filename || '').trim();
  if (!name) return false;
  const base = name.split(/[/\\]/).pop() || name;
  if (base.startsWith('.') || base.startsWith('._')) return false;
  const lower = base.toLowerCase();
  return VALID_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function formatTime(seconds, showTenths = false) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (showTenths) {
    const totalTenths = Math.round(safe * 10);
    const tenths = totalTenths % 10;
    const totalSeconds = Math.floor(totalTenths / 10);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
  }
  const totalSeconds = Math.floor(safe);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatTimePrecise(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalHundredths = Math.round(safe * 100);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

export function formatSampleRate(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return 'Unknown Hz';
  const khz = hz / 1000;
  if (Math.abs(khz - Math.round(khz)) < 0.001) {
    return `${Math.round(khz)} kHz`;
  }
  return `${Number(khz.toFixed(2))} kHz`;
}

export function formatDb(val, unit = 'dBFS', digits = 1) {
  if (!Number.isFinite(val) || val <= -119) return `-∞ ${unit}`;
  const rounded = Number(val.toFixed(digits));
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized.toFixed(digits)} ${unit}`;
}

export function formatSignedDb(val, digits = 1) {
  if (!Number.isFinite(val)) return '—';
  const rounded = Number(val.toFixed(digits));
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  const sign = normalized > 0 ? '+' : '';
  return `${sign}${normalized.toFixed(digits)} dB`;
}

export function formatSignedDeltaSec(sec) {
  if (!Number.isFinite(sec)) return '—';
  const r = Number(sec.toFixed(2));
  const n = Object.is(r, -0) ? 0 : r;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}s`;
}

export function formatChannels(ch) {
  if (ch === 1) return 'MONO';
  if (ch === 2) return 'STEREO';
  if (Number.isFinite(ch) && ch > 2) return `${ch}CH`;
  return '—';
}

function round1(v) {
  if (!Number.isFinite(v)) return v;
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function round2(v) {
  if (!Number.isFinite(v)) return v;
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function round3(v) {
  if (!Number.isFinite(v)) return v;
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function readAscii(bytes, offset, length) {
  let s = '';
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readU64LE(bytes, offset) {
  const lo = readU32LE(bytes, offset);
  const hi = readU32LE(bytes, offset + 4);
  return hi * 4294967296 + lo;
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Decode 80-bit IEEE 754 extended precision float (used for AIFF sample rate).
 */
export function decodeIeee80Extended(bytes, offset) {
  if (offset + 10 > bytes.length) return 0;
  const sign = (bytes[offset] & 0x80) ? -1 : 1;
  const exponent = ((bytes[offset] & 0x7f) << 8) | bytes[offset + 1];
  const hiMant = readU32BE(bytes, offset + 2);
  const loMant = readU32BE(bytes, offset + 6);

  if (exponent === 0 && hiMant === 0 && loMant === 0) return 0;
  if (exponent === 0x7fff) return NaN;

  const exp = exponent - 16383;
  // Value = (hiMant * 2^32 + loMant) * 2^(exp - 63)
  const val = hiMant * Math.pow(2, exp - 31) + loMant * Math.pow(2, exp - 63);
  return sign * val;
}

/* --------------------------------------------------------------------------
 * Native Binary Audio Header Parsers (Pre-Decode)
 * -------------------------------------------------------------------------- */

function parseWavHeader(bytes) {
  if (bytes.length < 12) return null;
  const magic = readAscii(bytes, 0, 4);
  const waveId = readAscii(bytes, 8, 4);
  if ((magic !== 'RIFF' && magic !== 'RF64') || waveId !== 'WAVE') return null;

  let audioFormat = null;
  let channels = null;
  let sampleRate = null;
  let byteRate = null;
  let bitsPerSample = null;
  let dataSize = null;
  let rf64DataSize = null;
  let isFloat = false;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readU32LE(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (chunkId === 'ds64' && dataOffset + 24 <= bytes.length) {
      // RF64 ds64 chunk: riffSize(8), dataSize(8), sampleCount(8)
      rf64DataSize = readU64LE(bytes, dataOffset + 8);
    } else if (chunkId === 'fmt ' && dataOffset + 16 <= bytes.length) {
      audioFormat = readU16LE(bytes, dataOffset);
      channels = readU16LE(bytes, dataOffset + 2);
      sampleRate = readU32LE(bytes, dataOffset + 4);
      byteRate = readU32LE(bytes, dataOffset + 8);
      bitsPerSample = readU16LE(bytes, dataOffset + 14);

      if (audioFormat === 3) {
        isFloat = true;
      } else if (audioFormat === 65534 && dataOffset + 40 <= bytes.length) {
        // WAVE_FORMAT_EXTENSIBLE: validBitsPerSample at +18, SubFormat GUID starts at +24
        const validBits = readU16LE(bytes, dataOffset + 18);
        if (validBits > 0 && validBits <= bitsPerSample) {
          bitsPerSample = validBits;
        }
        const subFormatTag = readU16LE(bytes, dataOffset + 24);
        isFloat = subFormatTag === 3;
      }
    } else if (chunkId === 'data') {
      if (magic === 'RF64' && chunkSize === 0xffffffff && rf64DataSize != null) {
        dataSize = rf64DataSize;
      } else {
        dataSize = chunkSize;
      }
      // Once we have both fmt and data, we can stop scanning
      if (sampleRate != null) break;
    }

    // Chunks are padded to even byte boundaries
    const paddedSize = chunkSize + (chunkSize & 1);
    if (paddedSize === 0 && chunkId === '\0\0\0\0') break;
    const next = dataOffset + paddedSize;
    if (next <= offset) break;
    offset = next;
  }

  if (!sampleRate || !channels) return null;

  const computedByteRate =
    byteRate && byteRate > 0
      ? byteRate
      : bitsPerSample
        ? sampleRate * channels * (bitsPerSample / 8)
        : 0;
  const durationSec =
    dataSize != null && computedByteRate > 0 ? dataSize / computedByteRate : null;

  return {
    format: 'WAV',
    container: magic,
    sampleRate,
    channels,
    bitsPerSample: bitsPerSample || null,
    bitrateKbps: computedByteRate ? Math.round((computedByteRate * 8) / 1000) : null,
    durationSec: durationSec != null ? round3(durationSec) : null,
    isLossy: false,
    isFloat,
    parsed: true,
  };
}

function parseFlacHeader(bytes) {
  if (bytes.length < 42) return null;
  if (readAscii(bytes, 0, 4) !== 'fLaC') return null;

  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const headerByte = bytes[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7f;
    const blockLength =
      (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const blockStart = offset + 4;

    if (blockType === 0 && blockLength >= 34 && blockStart + 18 <= bytes.length) {
      // STREAMINFO layout:
      // 0..1 minBlockSize, 2..3 maxBlockSize, 4..6 minFrameSize, 7..9 maxFrameSize
      // 10..17 (64 bits): sampleRate(20) | channels-1(3) | bps-1(5) | totalSamples(36)
      const b10 = bytes[blockStart + 10];
      const b11 = bytes[blockStart + 11];
      const b12 = bytes[blockStart + 12];
      const b13 = bytes[blockStart + 13];

      const sampleRate = (b10 << 12) | (b11 << 4) | (b12 >> 4);
      const channels = ((b12 >> 1) & 0x07) + 1;
      const bitsPerSample = (((b12 & 0x01) << 4) | (b13 >> 4)) + 1;

      const totalSamplesHi = b13 & 0x0f;
      const totalSamplesLo = readU32BE(bytes, blockStart + 14);
      const totalSamples = totalSamplesHi * 4294967296 + totalSamplesLo;

      const durationSec =
        sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : null;

      return {
        format: 'FLAC',
        container: 'FLAC',
        sampleRate,
        channels,
        bitsPerSample,
        bitrateKbps: null,
        durationSec: durationSec != null ? round3(durationSec) : null,
        isLossy: false,
        isFloat: false,
        parsed: true,
      };
    }

    offset = blockStart + blockLength;
    if (isLast) break;
  }

  return null;
}

function parseAiffHeader(bytes) {
  if (bytes.length < 12) return null;
  if (readAscii(bytes, 0, 4) !== 'FORM') return null;
  const formType = readAscii(bytes, 8, 4);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readU32BE(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (chunkId === 'COMM' && dataOffset + 18 <= bytes.length) {
      const channels = readU16BE(bytes, dataOffset);
      const sampleFrames = readU32BE(bytes, dataOffset + 2);
      const bitsPerSample = readU16BE(bytes, dataOffset + 6);
      const rawRate = decodeIeee80Extended(bytes, dataOffset + 8);
      const sampleRate = Number.isFinite(rawRate) && rawRate > 0 ? Math.round(rawRate) : null;

      let isFloat = false;
      if (formType === 'AIFC' && dataOffset + 22 <= bytes.length) {
        const compType = readAscii(bytes, dataOffset + 18, 4).toLowerCase();
        if (compType === 'fl32' || compType === 'fl64') isFloat = true;
      }

      const durationSec =
        sampleRate && sampleFrames > 0 ? sampleFrames / sampleRate : null;

      if (!sampleRate || !channels) return null;

      return {
        format: 'AIFF',
        container: formType,
        sampleRate,
        channels,
        bitsPerSample: bitsPerSample || null,
        bitrateKbps: bitsPerSample
          ? Math.round((sampleRate * channels * bitsPerSample) / 1000)
          : null,
        durationSec: durationSec != null ? round3(durationSec) : null,
        isLossy: false,
        isFloat,
        parsed: true,
      };
    }

    const paddedSize = chunkSize + (chunkSize & 1);
    const next = dataOffset + paddedSize;
    if (next <= offset) break;
    offset = next;
  }

  return null;
}

const MP3_BITRATES = {
  // MPEG 1
  '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer II
  '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer III
  // MPEG 2 / 2.5
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // Layer I
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // Layer II & III
  '2-1': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MP3_SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

function decodeMpegFrameAt(bytes, pos) {
  if (pos + 4 > bytes.length) return null;
  const b0 = bytes[pos];
  const b1 = bytes[pos + 1];
  const b2 = bytes[pos + 2];
  const b3 = bytes[pos + 3];

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionId = (b1 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
  const layerId = (b1 >> 1) & 0x03; // 0=reserved, 1=III, 2=II, 3=I
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const srIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  const channelMode = (b3 >> 6) & 0x03; // 3 = mono

  if (versionId === 1 || layerId === 0) return null;
  if (bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;

  const rateTable = MP3_SAMPLE_RATES[versionId];
  const brKey = `${versionId === 3 ? 3 : 2}-${layerId}`;
  const brTable = MP3_BITRATES[brKey];
  if (!rateTable || !brTable) return null;

  const sampleRate = rateTable[srIdx];
  const bitrateKbps = brTable[bitrateIdx];
  if (!sampleRate || !bitrateKbps) return null;

  const samplesPerFrame =
    layerId === 3 ? 384 : layerId === 2 ? 1152 : versionId === 3 ? 1152 : 576;

  let frameLength = 0;
  if (layerId === 3) {
    frameLength = Math.floor(((12 * bitrateKbps * 1000) / sampleRate + padding) * 4);
  } else {
    const coef = samplesPerFrame / 8;
    frameLength = Math.floor((coef * bitrateKbps * 1000) / sampleRate + padding);
  }

  if (frameLength < 16) return null;

  return {
    versionId,
    layerId,
    sampleRate,
    bitrateKbps,
    channels: channelMode === 3 ? 1 : 2,
    samplesPerFrame,
    frameLength,
  };
}

function parseMp3Header(bytes, lowerName) {
  if (bytes.length < 4) return null;
  let offset = 0;
  let hasId3 = false;

  // Skip ID3v2 tag(s) if present
  while (offset + 10 <= bytes.length && readAscii(bytes, offset, 3) === 'ID3') {
    hasId3 = true;
    const flags = bytes[offset + 5];
    const size =
      ((bytes[offset + 6] & 0x7f) << 21) |
      ((bytes[offset + 7] & 0x7f) << 14) |
      ((bytes[offset + 8] & 0x7f) << 7) |
      (bytes[offset + 9] & 0x7f);
    const footerSize = (flags & 0x10) ? 10 : 0;
    offset += 10 + size + footerSize;
  }

  const maxScan = Math.min(bytes.length - 4, offset + 65536);
  let fallbackFrame = null;

  for (let i = offset; i <= maxScan; i += 1) {
    const frame = decodeMpegFrameAt(bytes, i);
    if (!frame) continue;

    if (!fallbackFrame) fallbackFrame = { frame, pos: i };

    // Verify next frame header if within buffer to reject false sync words
    const nextPos = i + frame.frameLength;
    if (nextPos + 4 <= bytes.length) {
      const nextFrame = decodeMpegFrameAt(bytes, nextPos);
      if (
        nextFrame &&
        nextFrame.versionId === frame.versionId &&
        nextFrame.layerId === frame.layerId &&
        nextFrame.sampleRate === frame.sampleRate
      ) {
        return buildMp3Result(bytes, i, frame);
      }
    } else if (hasId3 || lowerName.endsWith('.mp3')) {
      return buildMp3Result(bytes, i, frame);
    }
  }

  if (fallbackFrame && (hasId3 || lowerName.endsWith('.mp3'))) {
    return buildMp3Result(bytes, fallbackFrame.pos, fallbackFrame.frame);
  }
  return null;
}

function buildMp3Result(bytes, framePos, frame) {
  let durationSec = null;

  // Check Xing / Info VBR header inside the first frame
  const sideInfoSize =
    frame.versionId === 3
      ? frame.channels === 1
        ? 17
        : 32
      : frame.channels === 1
        ? 9
        : 17;
  const xingPos = framePos + 4 + sideInfoSize;
  if (xingPos + 12 <= bytes.length) {
    const tag = readAscii(bytes, xingPos, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = readU32BE(bytes, xingPos + 4);
      if (flags & 0x01) {
        const totalFrames = readU32BE(bytes, xingPos + 8);
        if (totalFrames > 0) {
          durationSec = (totalFrames * frame.samplesPerFrame) / frame.sampleRate;
        }
      }
    }
  }

  // Fallback CBR estimate if full file buffer is available and > 4 frames
  if (durationSec == null && bytes.length > framePos + frame.frameLength * 4) {
    const audioBytes = Math.max(0, bytes.length - framePos);
    durationSec = (audioBytes * 8) / (frame.bitrateKbps * 1000);
  }

  return {
    format: 'MP3',
    container: 'MPEG',
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    bitsPerSample: null,
    bitrateKbps: frame.bitrateKbps,
    durationSec: durationSec != null ? round3(durationSec) : null,
    isLossy: true,
    isFloat: false,
    parsed: true,
  };
}

function parseOggHeader(bytes) {
  if (bytes.length < 36) return null;
  if (readAscii(bytes, 0, 4) !== 'OggS') return null;

  const segCount = bytes[26];
  const payloadStart = 27 + segCount;
  if (payloadStart + 16 > bytes.length) {
    return {
      format: 'OGG',
      container: 'OGG',
      sampleRate: null,
      channels: null,
      bitsPerSample: null,
      bitrateKbps: null,
      durationSec: null,
      isLossy: true,
      isFloat: false,
      parsed: false,
    };
  }

  const head = readAscii(bytes, payloadStart, 8);
  if (head === 'OpusHead' && payloadStart + 16 <= bytes.length) {
    const channels = bytes[payloadStart + 9];
    return {
      format: 'OPUS',
      container: 'OGG',
      sampleRate: 48000, // Opus always decodes at 48 kHz
      channels: channels || null,
      bitsPerSample: null,
      bitrateKbps: null,
      durationSec: null,
      isLossy: true,
      isFloat: false,
      parsed: true,
    };
  }

  if (
    bytes[payloadStart] === 0x01 &&
    readAscii(bytes, payloadStart + 1, 6) === 'vorbis' &&
    payloadStart + 16 <= bytes.length
  ) {
    const channels = bytes[payloadStart + 11];
    const sampleRate = readU32LE(bytes, payloadStart + 12);
    return {
      format: 'OGG',
      container: 'OGG',
      sampleRate: sampleRate > 0 ? sampleRate : null,
      channels: channels || null,
      bitsPerSample: null,
      bitrateKbps: null,
      durationSec: null,
      isLossy: true,
      isFloat: false,
      parsed: Boolean(sampleRate),
    };
  }

  return {
    format: 'OGG',
    container: 'OGG',
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    bitrateKbps: null,
    durationSec: null,
    isLossy: true,
    isFloat: false,
    parsed: false,
  };
}

function parseMp4Header(bytes, lowerName) {
  if (bytes.length < 12) return null;
  if (readAscii(bytes, 4, 4) !== 'ftyp') return null;

  // Lightweight scan for mp4a / alac audio sample entry to grab native sample rate if present
  let sampleRate = null;
  let channels = null;
  let isLossy = true;
  let format = lowerName.endsWith('.aac') ? 'AAC' : 'M4A';

  const scanLen = Math.min(bytes.length - 28, 131072);
  for (let i = 8; i < scanLen; i += 1) {
    if (
      bytes[i] === 0x6d &&
      bytes[i + 1] === 0x70 &&
      bytes[i + 2] === 0x34 &&
      bytes[i + 3] === 0x61
    ) {
      // AudioSampleEntry: 4(type) + 6(reserved) + 2(dataRef) + 8(reserved) + 2(ch) + 2(sampleSize) + 4(predef/res) + 4(sr 16.16)
      const ch = readU16BE(bytes, i + 20);
      const sr = readU16BE(bytes, i + 28);
      if (sr >= 8000 && sr <= 192000 && ch >= 1 && ch <= 8) {
        sampleRate = sr;
        channels = ch;
        break;
      }
    }
    if (
      bytes[i] === 0x61 &&
      bytes[i + 1] === 0x6c &&
      bytes[i + 2] === 0x61 &&
      bytes[i + 3] === 0x63
    ) {
      isLossy = false;
      format = 'ALAC';
    }
  }

  return {
    format,
    container: 'MP4',
    sampleRate,
    channels,
    bitsPerSample: null,
    bitrateKbps: null,
    durationSec: null,
    isLossy,
    isFloat: false,
    parsed: Boolean(sampleRate),
  };
}

/**
 * Parse TRUE native audio container headers directly from raw bytes BEFORE
 * Web Audio's decodeAudioData resamples to the OS AudioContext sample rate.
 */
export function parseNativeAudioHeader(uint8Array, filename = '') {
  const bytes =
    uint8Array instanceof Uint8Array
      ? uint8Array
      : new Uint8Array(uint8Array || 0);
  const lowerName = String(filename || '').toLowerCase();

  if (bytes.length >= 12) {
    const wav = parseWavHeader(bytes);
    if (wav) return wav;

    const flac = parseFlacHeader(bytes);
    if (flac) return flac;

    const aiff = parseAiffHeader(bytes);
    if (aiff) return aiff;

    const ogg = parseOggHeader(bytes);
    if (ogg) return ogg;

    const mp4 = parseMp4Header(bytes, lowerName);
    if (mp4) return mp4;
  }

  if (bytes.length >= 4) {
    const mp3 = parseMp3Header(bytes, lowerName);
    if (mp3) return mp3;
  }

  // Graceful fallback by extension
  const extMatch = lowerName.match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toUpperCase() : 'AUDIO';
  const isLossy = ['MP3', 'M4A', 'AAC', 'OGG', 'OPUS', 'WEBM'].includes(ext);

  return {
    format: ext,
    container: ext,
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    bitrateKbps: null,
    durationSec: null,
    isLossy,
    isFloat: false,
    parsed: false,
  };
}

/* --------------------------------------------------------------------------
 * Stem Role Auto-Detection & Generic Name Check
 * -------------------------------------------------------------------------- */

const BEAT_PATTERN =
  /(^|[\s_\-.(\[])(beat|inst|instrumental|2[-_ ]?track|prod|backing[-_ ]?track|music|trackout)($|[\s_\-.)\]0-9])/i;

const EXPLICIT_FX_BUS_PATTERN =
  /(^|[\s_\-.(\[])(reverb|verb|delay|dly|fx|sfx|send|return|bus)($|[\s_\-.)\]0-9])/i;

const INSTRUMENT_FX_PATTERN =
  /(^|[\s_\-.(\[])(synth|pad|guitar|piano|keys|bass|drum|drums|808|perc|percussion|kick|snare|hat|hihat|strings|brass|melody|arp)($|[\s_\-.)\]0-9])/i;

const VOCAL_PATTERN =
  /(^|[\s_\-.(\[])(vox|vocal|vocals|lead|verse|hook|chorus|main|double|dbl|adlib|adlibs|ad[-_ ]?lib|harm|harmony|harmonies|bgv|backing|back|rap|take|mic|dry|bridge|acapella)($|[\s_\-.)\]0-9])/i;

const WET_ONLY_PATTERN = /(^|[\s_\-.(\[])(wet)($|[\s_\-.)\]0-9])/i;

const GENERIC_NAME_PATTERN =
  /^(\d{1,2}[-_ ]+)?(audio|track|untitled|recording|new[-_ ]?recording|voice[-_ ]?memo|bounce|export|mixdown|stem|file|take)([-_ ]*\d+)?$/i;

/**
 * Automatically classify a stem filename into 'beat' | 'vocal' | 'fx'.
 */
export function classifyStemRole(filename) {
  const base = String(filename || '')
    .split(/[/\\]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .trim();

  if (!base) return 'vocal';

  if (BEAT_PATTERN.test(base)) return 'beat';
  if (EXPLICIT_FX_BUS_PATTERN.test(base)) return 'fx';
  if (VOCAL_PATTERN.test(base)) return 'vocal';
  if (INSTRUMENT_FX_PATTERN.test(base) || WET_ONLY_PATTERN.test(base)) return 'fx';

  return 'vocal';
}

export function isGenericStemFilename(filename) {
  const base = String(filename || '')
    .split(/[/\\]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .trim();
  if (!base) return true;
  return GENERIC_NAME_PATTERN.test(base);
}

/* --------------------------------------------------------------------------
 * 4x Oversampled True Peak (dBTP) — 12-Tap Kaiser-Windowed Sinc Polyphase FIR
 * -------------------------------------------------------------------------- */

function besselI0(x) {
  let sum = 1.0;
  let term = 1.0;
  const halfX = x * 0.5;
  for (let k = 1; k <= 18; k += 1) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function buildPolyphaseSinc4x(tapsPerPhase = 12, beta = 6.0) {
  const factor = 4;
  const totalTaps = tapsPerPhase * factor;
  const half = (totalTaps - 1) / 2;
  const denom = besselI0(beta);
  const phases = [
    new Float64Array(tapsPerPhase),
    new Float64Array(tapsPerPhase),
    new Float64Array(tapsPerPhase),
    new Float64Array(tapsPerPhase),
  ];

  // Phase 0 is exact original sample; phases 1, 2, 3 are 0.25, 0.50, 0.75 fractional offsets
  for (let p = 0; p < factor; p += 1) {
    const frac = p / factor;
    let sum = 0;
    for (let k = 0; k < tapsPerPhase; k += 1) {
      const idx = k - (tapsPerPhase / 2 - 1);
      const t = idx - frac;
      const nPos = k * factor + p;
      const wArg = (2 * nPos) / (totalTaps - 1) - 1;
      const wVal = Math.abs(wArg) <= 1 ? besselI0(beta * Math.sqrt(1 - wArg * wArg)) / denom : 0;
      const sinc = Math.abs(t) < 1e-12 ? 1.0 : Math.sin(Math.PI * t) / (Math.PI * t);
      const coeff = sinc * wVal;
      phases[p][k] = coeff;
      sum += coeff;
    }
    if (sum !== 0) {
      for (let k = 0; k < tapsPerPhase; k += 1) {
        phases[p][k] /= sum;
      }
    }
  }
  return phases;
}

const POLYPHASE_4X = buildPolyphaseSinc4x(12, 6.0);

/**
 * Fast & accurate 4x oversampled True Peak detector across channels.
 */
export function computeTruePeak(channelDataList) {
  let maxSamplePeak = 0;
  let maxTruePeak = 0;
  const p1 = POLYPHASE_4X[1];
  const p2 = POLYPHASE_4X[2];
  const p3 = POLYPHASE_4X[3];

  for (let c = 0; c < channelDataList.length; c += 1) {
    const data = channelDataList[c];
    const len = data.length;
    if (len === 0) continue;

    // First pass for exact sample peak
    let chSampleMax = 0;
    for (let i = 0; i < len; i += 1) {
      const a = Math.abs(data[i]);
      if (a > chSampleMax) chSampleMax = a;
    }
    if (chSampleMax > maxSamplePeak) maxSamplePeak = chSampleMax;
    if (chSampleMax > maxTruePeak) maxTruePeak = chSampleMax;

    // Only run 12-tap polyphase FIR near samples that could plausibly exceed current true peak
    // (windowed sinc overshoot on worst-case step is < 1.5x local sample magnitude)
    const threshold = Math.max(1e-5, maxTruePeak * 0.45);
    const halfTap = 5;

    for (let i = 0; i < len; i += 1) {
      const cur = Math.abs(data[i]);
      const nxt = i + 1 < len ? Math.abs(data[i + 1]) : 0;
      if (cur < threshold && nxt < threshold) continue;

      let y1 = 0;
      let y2 = 0;
      let y3 = 0;
      for (let k = 0; k < 12; k += 1) {
        const sIdx = i - halfTap + k;
        const s = sIdx >= 0 && sIdx < len ? data[sIdx] : 0;
        y1 += s * p1[k];
        y2 += s * p2[k];
        y3 += s * p3[k];
      }
      const peakLocal = Math.max(Math.abs(y1), Math.abs(y2), Math.abs(y3));
      if (peakLocal > maxTruePeak) maxTruePeak = peakLocal;
    }
  }

  return {
    samplePeakLinear: maxSamplePeak,
    samplePeakDbfs: maxSamplePeak > 0 ? round2(20 * Math.log10(maxSamplePeak)) : -Infinity,
    truePeakLinear: maxTruePeak,
    truePeakDbtp: maxTruePeak > 0 ? round2(20 * Math.log10(maxTruePeak)) : -Infinity,
  };
}

/* --------------------------------------------------------------------------
 * Per-Stem Audio DSP Analysis
 * -------------------------------------------------------------------------- */

const CLIP_SAMPLE_THRESHOLD = 0.9999;
const ACTIVE_FRAME_DBFS = -55;
const STEREO_ACTIVE_DBFS = -48;
const ABRUPT_START_DBFS = -24;
const WAVEFORM_BINS = 240;

/**
 * Analyze one stem's decoded PCM channel arrays alongside its pre-decode native header.
 */
export function analyzeStemChannels(
  channelDataList,
  sampleRate,
  nativeHeader = null,
  role = null,
  filename = 'stem.wav'
) {
  const channels = Array.isArray(channelDataList) ? channelDataList : [];
  const numChannels = channels.length;
  const numSamples = numChannels > 0 ? channels[0].length : 0;
  const decodedSr = Number(sampleRate) > 0 ? Number(sampleRate) : 44100;
  const header = nativeHeader || {
    format: 'AUDIO',
    container: 'AUDIO',
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    bitrateKbps: null,
    durationSec: null,
    isLossy: false,
    isFloat: false,
    parsed: false,
  };

  const resolvedRole = STEM_ROLES.includes(role) ? role : classifyStemRole(filename);
  const decodedDurationSec = numSamples > 0 ? numSamples / decodedSr : 0;

  // Prefer native header duration when parsed & coherent with decoded length (within 2.5s or 15%)
  let durationSec = decodedDurationSec;
  if (
    header.parsed &&
    Number.isFinite(header.durationSec) &&
    header.durationSec > 0
  ) {
    const diff = Math.abs(header.durationSec - decodedDurationSec);
    if (decodedDurationSec === 0 || diff <= Math.max(2.5, decodedDurationSec * 0.15)) {
      durationSec = header.durationSec;
    }
  }

  const nativeSampleRate =
    header.parsed && Number.isFinite(header.sampleRate) && header.sampleRate > 0
      ? header.sampleRate
      : decodedSr;

  const nativeChannels =
    header.parsed && Number.isFinite(header.channels) && header.channels > 0
      ? header.channels
      : numChannels;

  // 1. Sample Peak & 4x True Peak
  const peaks = computeTruePeak(channels);

  // 2. RMS, DC Offset, Digital Clipping, Hard Clip Bursts, Waveform Peaks & Clip Flags
  let sumSqAll = 0;
  let maxAbsDc = 0;
  let clippedSamples = 0;
  let hardClipBursts = 0;
  const clipTimestamps = [];
  const waveformPeaks = new Float32Array(WAVEFORM_BINS);
  const clipBinFlags = new Array(WAVEFORM_BINS).fill(false);

  const binSize = numSamples > 0 ? numSamples / WAVEFORM_BINS : 1;

  for (let c = 0; c < numChannels; c += 1) {
    const data = channels[c];
    let chSum = 0;
    let consecClips = 0;
    let burstStartSample = -1;

    for (let i = 0; i < numSamples; i += 1) {
      const s = data[i];
      const absS = Math.abs(s);
      sumSqAll += s * s;
      chSum += s;

      const bin = Math.min(WAVEFORM_BINS - 1, Math.floor(i / binSize));
      if (absS > waveformPeaks[bin]) waveformPeaks[bin] = absS;

      if (absS >= CLIP_SAMPLE_THRESHOLD) {
        clippedSamples += 1;
        clipBinFlags[bin] = true;
        if (consecClips === 0) burstStartSample = i;
        consecClips += 1;
      } else {
        if (consecClips >= 3) {
          hardClipBursts += 1;
          if (clipTimestamps.length < 5) {
            clipTimestamps.push(round2(burstStartSample / decodedSr));
          }
        }
        consecClips = 0;
      }
    }

    if (consecClips >= 3) {
      hardClipBursts += 1;
      if (clipTimestamps.length < 5) {
        clipTimestamps.push(round2(burstStartSample / decodedSr));
      }
    }

    if (numSamples > 0) {
      const dc = Math.abs(chSum / numSamples);
      if (dc > maxAbsDc) maxAbsDc = dc;
    }
  }

  // Fallback isolated clip timestamps if clippedSamples > 0 but no >=3 burst
  if (clippedSamples > 0 && clipTimestamps.length === 0) {
    for (let i = 0; i < numSamples && clipTimestamps.length < 5; i += 1) {
      let isClip = false;
      for (let c = 0; c < numChannels; c += 1) {
        if (Math.abs(channels[c][i]) >= CLIP_SAMPLE_THRESHOLD) {
          isClip = true;
          break;
        }
      }
      if (isClip) {
        const ts = round2(i / decodedSr);
        if (
          clipTimestamps.length === 0 ||
          ts - clipTimestamps[clipTimestamps.length - 1] >= 0.25
        ) {
          clipTimestamps.push(ts);
        }
      }
    }
  }

  const totalSampleCount = Math.max(1, numSamples * Math.max(1, numChannels));
  const overallRmsLin = Math.sqrt(sumSqAll / totalSampleCount);
  const rmsDbfs = overallRmsLin > 0 ? round2(20 * Math.log10(overallRmsLin)) : -Infinity;

  // 3. 20ms Frame Scan: First/Last Audio, Active RMS, Abrupt Start, Mid/Side, Phrase Release Tail
  const frameSamples = Math.max(1, Math.round(decodedSr * 0.02)); // 20 ms
  const numFrames = numSamples > 0 ? Math.ceil(numSamples / frameSamples) : 0;
  const activeThreshLin = Math.pow(10, ACTIVE_FRAME_DBFS / 20);
  const stereoThreshLin = Math.pow(10, STEREO_ACTIVE_DBFS / 20);
  const abruptThreshLin = Math.pow(10, ABRUPT_START_DBFS / 20);

  let firstAudioSec = null;
  let lastAudioSec = null;
  let activeSqSum = 0;
  let activeCount = 0;
  const frameRmsList = new Float32Array(numFrames);

  // Mid/Side & Phase Correlation accumulators over active frames
  let msSumMidSq = 0;
  let msSumSideSq = 0;
  let phaseSumLR = 0;
  let phaseSumL2 = 0;
  let phaseSumR2 = 0;
  let stereoActiveFrames = 0;

  const hasStereo = numChannels >= 2;
  const left = hasStereo ? channels[0] : null;
  const right = hasStereo ? channels[1] : null;

  for (let f = 0; f < numFrames; f += 1) {
    const start = f * frameSamples;
    const end = Math.min(numSamples, start + frameSamples);
    const count = end - start;
    if (count <= 0) continue;

    let frameSq = 0;
    for (let c = 0; c < numChannels; c += 1) {
      const ch = channels[c];
      for (let i = start; i < end; i += 1) {
        frameSq += ch[i] * ch[i];
      }
    }
    const frameRms = Math.sqrt(frameSq / (count * Math.max(1, numChannels)));
    frameRmsList[f] = frameRms;

    if (frameRms > activeThreshLin) {
      if (firstAudioSec === null) firstAudioSec = round2(start / decodedSr);
      lastAudioSec = round2(end / decodedSr);
      activeSqSum += frameSq / Math.max(1, numChannels);
      activeCount += count;
    }

    if (hasStereo && frameRms > stereoThreshLin) {
      stereoActiveFrames += 1;
      for (let i = start; i < end; i += 1) {
        const l = left[i];
        const r = right[i];
        const m = 0.5 * (l + r);
        const s = 0.5 * (l - r);
        msSumMidSq += m * m;
        msSumSideSq += s * s;
        phaseSumLR += l * r;
        phaseSumL2 += l * l;
        phaseSumR2 += r * r;
      }
    }
  }

  // Fallback for quiet stereo stems with no frames > -48 dBFS
  if (hasStereo && stereoActiveFrames === 0 && numSamples > 0) {
    for (let i = 0; i < numSamples; i += 1) {
      const l = left[i];
      const r = right[i];
      const m = 0.5 * (l + r);
      const s = 0.5 * (l - r);
      msSumMidSq += m * m;
      msSumSideSq += s * s;
      phaseSumLR += l * r;
      phaseSumL2 += l * l;
      phaseSumR2 += r * r;
    }
  }

  const activeRmsLin = activeCount > 0 ? Math.sqrt(activeSqSum / activeCount) : overallRmsLin;
  const activeRmsDbfs = activeRmsLin > 0 ? round2(20 * Math.log10(activeRmsLin)) : -Infinity;
  const isSilent = peaks.samplePeakDbfs < -60 || firstAudioSec === null;

  // Abrupt non-zero transient in first 2ms (potential sliced region or missing fade-in)
  const first2msCount = Math.min(numSamples, Math.max(1, Math.round(decodedSr * 0.002)));
  let first2msPeak = 0;
  for (let c = 0; c < numChannels; c += 1) {
    const ch = channels[c];
    for (let i = 0; i < first2msCount; i += 1) {
      const a = Math.abs(ch[i]);
      if (a > first2msPeak) first2msPeak = a;
    }
  }
  const startsAbruptlyAtZero = first2msPeak > abruptThreshLin;

  // 4. Mid/Side Stereo FX Classification
  const isNativeMono = numChannels === 1;
  let sideToMidDb = -Infinity;
  let stereoWidthPct = 0;
  let phaseCorrelation = 1.0;

  if (!isNativeMono && hasStereo) {
    const rmsM = Math.sqrt(msSumMidSq);
    const rmsS = Math.sqrt(msSumSideSq);
    if (rmsM > 1e-12 && rmsS > 1e-12) {
      sideToMidDb = round1(20 * Math.log10(rmsS / rmsM));
    } else if (rmsS > 1e-12 && rmsM <= 1e-12) {
      sideToMidDb = 0; // pure out-of-phase side
    } else {
      sideToMidDb = -Infinity;
    }

    const totalMS = rmsM + rmsS;
    stereoWidthPct = totalMS > 1e-12 ? round1((rmsS / totalMS) * 100) : 0;

    const denom = Math.sqrt(phaseSumL2 * phaseSumR2);
    phaseCorrelation = denom > 1e-12 ? round3(phaseSumLR / denom) : 1.0;
  }

  // 5. Phrase Release Tail Indicator (20ms frames: detects lingering wet decay after vocal phrases)
  let tailRatio = 0;
  if (numFrames >= 25 && !isSilent) {
    const phraseThresh = Math.pow(10, -26 / 20);
    let tailSamples = 0;
    let tailRatioSum = 0;
    let inPhrase = false;
    let phrasePeak = 0;

    for (let f = 0; f < numFrames - 22; f += 1) {
      const r = frameRmsList[f];
      if (r >= phraseThresh) {
        inPhrase = true;
        if (r > phrasePeak) phrasePeak = r;
      } else if (inPhrase && r < phrasePeak * 0.25) {
        // Phrase ended at f; inspect decay window 160ms..440ms (frames f+8 .. f+22)
        let tailSum = 0;
        let tailCount = 0;
        let interrupted = false;
        for (let k = f + 8; k < Math.min(numFrames, f + 22); k += 1) {
          if (frameRmsList[k] >= phraseThresh) {
            interrupted = true;
            break;
          }
          tailSum += frameRmsList[k];
          tailCount += 1;
        }
        if (!interrupted && tailCount > 0 && phrasePeak > 0) {
          tailRatioSum += (tailSum / tailCount) / phrasePeak;
          tailSamples += 1;
        }
        inPhrase = false;
        phrasePeak = 0;
      }
    }
    if (tailSamples > 0) {
      tailRatio = round3(tailRatioSum / tailSamples);
    }
  }

  // Classify stereo FX verdict for current role
  const stereoEval = evaluateStereoFx(resolvedRole, {
    isNativeMono,
    sideToMidDb,
    stereoWidthPct,
    phaseCorrelation,
    isSilent,
  });

  // Classify headroom verdict for current role
  const headroomEval = evaluateHeadroom(resolvedRole, {
    samplePeakDbfs: peaks.samplePeakDbfs,
    truePeakDbtp: peaks.truePeakDbtp,
    clippedSamples,
    hardClipBursts,
    isSilent,
  });

  return {
    filename,
    role: resolvedRole,
    nativeHeader: header,
    format: header.format || 'AUDIO',
    isLossy: Boolean(header.isLossy),
    isFloat: Boolean(header.isFloat),
    bitsPerSample: header.bitsPerSample || null,
    bitrateKbps: header.bitrateKbps || null,
    nativeSampleRate,
    decodedSampleRate: decodedSr,
    nativeChannels,
    decodedChannels: numChannels,
    durationSec: round3(durationSec),
    decodedDurationSec: round3(decodedDurationSec),
    samplePeakDbfs: peaks.samplePeakDbfs,
    truePeakDbtp: peaks.truePeakDbtp,
    rmsDbfs,
    activeRmsDbfs,
    dcOffset: round4(maxAbsDc),
    clippedSamples,
    hardClipBursts,
    clipTimestamps,
    isSilent,
    firstAudioSec,
    lastAudioSec,
    startsAbruptlyAtZero,
    isNativeMono,
    sideToMidDb,
    stereoWidthPct,
    phaseCorrelation,
    tailRatio,
    stereoFxStatus: stereoEval.status,
    stereoLabel: stereoEval.label,
    headroomStatus: headroomEval.status,
    headroomLabel: headroomEval.label,
    hasGenericName: isGenericStemFilename(filename),
    waveformPeaks: Array.from(waveformPeaks, (v) => round3(v)),
    clipBinFlags,
  };
}

function round4(v) {
  if (!Number.isFinite(v)) return v;
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

export function evaluateStereoFx(role, metrics) {
  if (metrics.isSilent) {
    return { status: 'pass', label: 'Silent' };
  }
  if (metrics.isNativeMono) {
    return { status: 'pass', label: 'Pure Mono' };
  }

  const s2m = metrics.sideToMidDb;
  const width = metrics.stereoWidthPct;
  const corr = metrics.phaseCorrelation;

  if (role === 'vocal') {
    if (!Number.isFinite(s2m) || (s2m <= -48 && width < 0.5)) {
      return { status: 'pass', label: 'Dual-Mono (Dry)' };
    }
    if (s2m > -24 || width > 6 || corr < 0.92) {
      return { status: 'fail', label: 'Baked-In Stereo FX' };
    }
    return { status: 'warn', label: 'Light Stereo Content' };
  }

  // Beat / FX stems are expected to be stereo
  if (!Number.isFinite(s2m) || (s2m <= -48 && width < 0.5)) {
    return { status: 'pass', label: 'Dual-Mono' };
  }
  return { status: 'pass', label: 'Stereo' };
}

export function evaluateHeadroom(role, metrics) {
  if (metrics.isSilent) {
    return { status: 'fail', label: 'Silent Track' };
  }
  if (metrics.hardClipBursts > 0 || metrics.clippedSamples >= 10) {
    return { status: 'fail', label: 'Hard Clipping' };
  }
  if (metrics.clippedSamples > 0 || metrics.truePeakDbtp > 0.0 || metrics.samplePeakDbfs > -0.3) {
    return { status: 'warn', label: 'Near / Over 0 dB' };
  }
  if (role === 'vocal') {
    if (metrics.samplePeakDbfs > -1.0) {
      return { status: 'warn', label: 'Hot Vocal Peak' };
    }
    if (metrics.samplePeakDbfs < -30.0) {
      return { status: 'warn', label: 'Very Quiet Vocal' };
    }
  }
  return { status: 'pass', label: 'Clean Headroom' };
}

/* --------------------------------------------------------------------------
 * Cross-Stem Session Validation
 * -------------------------------------------------------------------------- */

/**
 * Validate an entire batch of analyzed stems together.
 * Re-evaluates role-dependent flags so changing a stem's role updates every check cleanly.
 */
export function validateStemSession(rawStems = []) {
  const stemsInput = Array.isArray(rawStems) ? rawStems : [];
  if (stemsInput.length === 0) {
    return {
      verdict: 'EMPTY',
      verdictHeadline: 'Awaiting Stems.',
      verdictSubtitle: 'Drop your beat and vocal stems to run the pre-mix transmission audit.',
      referenceDurationSec: 0,
      referenceSource: 'None',
      referenceFilename: null,
      targetSampleRate: null,
      uniqueSampleRates: [],
      stems: [],
      checklist: [],
      summary: {
        stemCount: 0,
        beatCount: 0,
        vocalCount: 0,
        fxCount: 0,
        failCount: 0,
        warnCount: 0,
        passCount: 0,
        totalClippedSamples: 0,
        flaggedStereoVocals: 0,
        mismatchedLengthCount: 0,
        mismatchedSampleRateCount: 0,
      },
    };
  }

  // 1. Determine Reference Duration (prefer longest beat stem; else longest stem overall)
  const beatStems = stemsInput.filter((s) => s.role === 'beat');
  let refStem = null;
  let referenceSource = 'Longest Stem';

  if (beatStems.length > 0) {
    refStem = beatStems.reduce((best, s) =>
      s.durationSec > best.durationSec ? s : best
    );
    referenceSource = 'Beat Stem';
  } else {
    refStem = stemsInput.reduce((best, s) =>
      s.durationSec > best.durationSec ? s : best
    );
  }
  const referenceDurationSec = refStem ? refStem.durationSec : 0;

  // 2. Determine Session Target Sample Rate (majority native SR; ties -> beat SR or 48k)
  const srCounts = new Map();
  for (const s of stemsInput) {
    const sr = s.nativeSampleRate;
    if (Number.isFinite(sr) && sr > 0) {
      srCounts.set(sr, (srCounts.get(sr) || 0) + 1);
    }
  }
  const uniqueSampleRates = Array.from(srCounts.keys()).sort((a, b) => a - b);
  const beatSr = refStem && refStem.role === 'beat' ? refStem.nativeSampleRate : null;

  let targetSampleRate = uniqueSampleRates[0] || 44100;
  let bestCount = -1;
  for (const [sr, count] of srCounts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      targetSampleRate = sr;
    } else if (count === bestCount) {
      // Break ties in favor of Beat SR, else 48000, else higher SR
      if (beatSr && sr === beatSr) {
        targetSampleRate = sr;
      } else if (beatSr && targetSampleRate === beatSr) {
        // keep beatSr
      } else if (sr === 48000) {
        targetSampleRate = sr;
      } else if (targetSampleRate !== 48000 && sr > targetSampleRate) {
        targetSampleRate = sr;
      }
    }
  }

  // 3. Annotate every stem with cross-stem checks & re-evaluate role-dependent statuses
  const annotatedStems = stemsInput.map((stem) => {
    const stereoEval = evaluateStereoFx(stem.role, stem);
    const headroomEval = evaluateHeadroom(stem.role, stem);

    const lengthDeltaSec = round2(stem.durationSec - referenceDurationSec);
    const absDelta = Math.abs(lengthDeltaSec);

    let lengthStatus = 'pass';
    let lengthNote = 'Matches reference length';
    let looksSlicedNotZero = false;

    if (stemsInput.length > 1) {
      if (absDelta > 1.5) {
        lengthStatus = 'fail';
        if (
          stem.role === 'vocal' &&
          lengthDeltaSec < -1.5 &&
          (stem.firstAudioSec === null || stem.firstAudioSec < 0.5)
        ) {
          looksSlicedNotZero = true;
          lengthNote =
            'Vocal looks exported from region start instead of 0:00 / Bar 1';
        } else if (lengthDeltaSec < -1.5) {
          lengthNote = `${Math.abs(lengthDeltaSec).toFixed(2)}s shorter than reference timeline`;
        } else {
          lengthNote = `${lengthDeltaSec.toFixed(2)}s longer than reference timeline`;
        }
      } else if (absDelta > 0.25) {
        lengthStatus = 'warn';
        lengthNote = `Minor ${formatSignedDeltaSec(lengthDeltaSec)} tail/padding difference`;
      }
    }

    const sampleRateMismatch =
      uniqueSampleRates.length > 1 && stem.nativeSampleRate !== targetSampleRate;

    let clipStatus = 'pass';
    if (stem.isSilent) {
      clipStatus = 'fail';
    } else if (stem.hardClipBursts > 0 || stem.clippedSamples >= 10) {
      clipStatus = 'fail';
    } else if (
      stem.clippedSamples > 0 ||
      stem.samplePeakDbfs > -0.3 ||
      stem.truePeakDbtp > 0.0
    ) {
      clipStatus = 'warn';
    }

    const lossyVocalWarn = stem.role === 'vocal' && stem.isLossy;
    const dcWarn = stem.dcOffset > 0.01;
    const abruptWarn = stem.role === 'vocal' && stem.startsAbruptlyAtZero;

    const issues = [];
    if (sampleRateMismatch) {
      issues.push(
        `Sample rate ${formatSampleRate(stem.nativeSampleRate)} conflicts with session ${formatSampleRate(targetSampleRate)}`
      );
    }
    if (lengthStatus === 'fail') issues.push(lengthNote);
    else if (lengthStatus === 'warn') issues.push(lengthNote);

    if (stem.isSilent) {
      issues.push('Track is completely silent (< -60 dBFS) — verify track was not muted on export');
    } else if (clipStatus === 'fail') {
      issues.push(
        `Hard digital clipping (${stem.clippedSamples} clipped samples, ${stem.hardClipBursts} burst${stem.hardClipBursts === 1 ? '' : 's'})`
      );
    } else if (clipStatus === 'warn') {
      issues.push(
        `Peak reaches ${formatDb(stem.samplePeakDbfs, 'dBFS')} (${formatDb(stem.truePeakDbtp, 'dBTP')}) — leave more headroom`
      );
    } else if (headroomEval.status === 'warn') {
      issues.push(`${headroomEval.label} (${formatDb(stem.samplePeakDbfs, 'dBFS')})`);
    }

    if (stereoEval.status === 'fail') {
      issues.push(
        `Baked-in stereo FX / reverb detected (Side/Mid ${formatSignedDb(stem.sideToMidDb)}, width ${stem.stereoWidthPct}%)`
      );
    } else if (stereoEval.status === 'warn') {
      issues.push(
        `Light stereo content detected (Side/Mid ${formatSignedDb(stem.sideToMidDb)}, width ${stem.stereoWidthPct}%) — confirm FX bypassed`
      );
    }

    if (stem.role === 'vocal' && stem.tailRatio >= 0.14 && stereoEval.status !== 'fail') {
      issues.push('Noticeable vocal decay tail detected — verify mono reverb/delay plugins are bypassed');
    }
    if (lossyVocalWarn) {
      issues.push(`Lossy ${stem.format} vocal — export uncompressed 24-bit WAV for mixing`);
    }
    if (abruptWarn) {
      issues.push('Loud transient right at 0:00 (first 2ms) — check for un-faded click or sliced region start');
    }
    if (dcWarn) {
      issues.push(`DC offset detected (${stem.dcOffset}) — enable high-pass / DC removal`);
    }
    if (stem.hasGenericName) {
      issues.push('Generic filename — rename clearly (e.g. Main Vox, Main Double, Adlibs, Harmonies, Beat)');
    }

    const hasFail =
      sampleRateMismatch ||
      lengthStatus === 'fail' ||
      clipStatus === 'fail' ||
      stereoEval.status === 'fail' ||
      stem.isSilent;
    const hasWarn =
      !hasFail &&
      (lengthStatus === 'warn' ||
        clipStatus === 'warn' ||
        headroomEval.status === 'warn' ||
        stereoEval.status === 'warn' ||
        lossyVocalWarn ||
        abruptWarn ||
        dcWarn ||
        stem.hasGenericName);

    const stemStatus = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

    return {
      ...stem,
      stereoFxStatus: stereoEval.status,
      stereoLabel: stereoEval.label,
      headroomStatus: headroomEval.status,
      headroomLabel: headroomEval.label,
      lengthDeltaSec,
      lengthStatus,
      lengthNote,
      looksSlicedNotZero,
      sampleRateMismatch,
      clipStatus,
      lossyVocalWarn,
      abruptWarn,
      dcWarn,
      issues,
      stemStatus,
    };
  });

  // 4. Build Session Checklist (Pass / Warn / Fail)
  const checklist = [];

  // CHECK 1: 0:00 Start & Matching Length
  const lengthFails = annotatedStems.filter((s) => s.lengthStatus === 'fail');
  const lengthWarns = annotatedStems.filter((s) => s.lengthStatus === 'warn');
  const slicedVocals = lengthFails.filter((s) => s.looksSlicedNotZero);

  if (annotatedStems.length === 1) {
    checklist.push({
      id: 'length-sync',
      status: 'warn',
      category: '0:00 SYNC & LENGTH',
      title: 'Only 1 stem loaded — drop your full session to verify alignment',
      detail: `Loaded ${annotatedStems[0].filename} (${formatTimePrecise(annotatedStems[0].durationSec)}). Drop your beat and all vocal stems together to check 0:00 timeline sync.`,
      affectedFiles: [annotatedStems[0].filename],
      fixAction: 'Add your instrumental beat and all vocal tracks so Stem Check can verify matching start/end bounds.',
    });
  } else if (lengthFails.length > 0) {
    const slicedNote =
      slicedVocals.length > 0
        ? ` ${slicedVocals.map((s) => s.filename).join(', ')} start immediately near 0:00 while ending early — vocal looks exported from region start instead of 0:00 / Bar 1.`
        : '';
    checklist.push({
      id: 'length-sync',
      status: 'fail',
      category: '0:00 SYNC & LENGTH',
      title: `${lengthFails.length} stem${lengthFails.length === 1 ? '' : 's'} do not match the ${formatTimePrecise(referenceDurationSec)} reference timeline`,
      detail: `Reference duration is ${formatTimePrecise(referenceDurationSec)} (${referenceSource}: ${refStem.filename}).${slicedNote}`,
      affectedFiles: lengthFails.map(
        (s) => `${s.filename} (${formatTimePrecise(s.durationSec)}, ${formatSignedDeltaSec(s.lengthDeltaSec)})`
      ),
      fixAction:
        'In your DAW, set the export cycle/loop range from Bar 1 (0:00) to the end of the beat, then bounce/export every stem across that exact full range.',
    });
  } else if (lengthWarns.length > 0) {
    checklist.push({
      id: 'length-sync',
      status: 'warn',
      category: '0:00 SYNC & LENGTH',
      title: `Minor tail/padding difference (0.25s–1.5s) on ${lengthWarns.length} stem${lengthWarns.length === 1 ? '' : 's'}`,
      detail: `All stems are close to ${formatTimePrecise(referenceDurationSec)}, but slight end-tail differences were detected. Audition Play All from 0:00 to confirm vocals sit right on the beat.`,
      affectedFiles: lengthWarns.map(
        (s) => `${s.filename} (${formatSignedDeltaSec(s.lengthDeltaSec)})`
      ),
      fixAction: 'Verify the beat and vocals drop in sync from 0:00 in the multi-track deck above.',
    });
  } else {
    checklist.push({
      id: 'length-sync',
      status: 'pass',
      category: '0:00 SYNC & LENGTH',
      title: `All ${annotatedStems.length} stems match the ${formatTimePrecise(referenceDurationSec)} timeline`,
      detail: `Every file aligns within ±0.25s of the ${referenceSource.toLowerCase()} (${refStem.filename}) — ready to drop straight onto Bar 1 / 0:00.`,
      affectedFiles: [],
      fixAction: null,
    });
  }

  // CHECK 2: Native Sample-Rate Consistency (44.1 kHz vs 48 kHz)
  if (uniqueSampleRates.length > 1) {
    const rateSummary = uniqueSampleRates.map((sr) => formatSampleRate(sr)).join(' vs ');
    const mismatched = annotatedStems.filter((s) => s.sampleRateMismatch);
    checklist.push({
      id: 'sample-rate',
      status: 'fail',
      category: 'SAMPLE RATE',
      title: `Sample-rate mismatch detected (${rateSummary})`,
      detail: `Mixing ${rateSummary} stems in the same folder causes pitch/speed drift or sloppy resampling on import. Majority/session rate is ${formatSampleRate(targetSampleRate)}.`,
      affectedFiles: mismatched.map(
        (s) => `${s.filename} (${formatSampleRate(s.nativeSampleRate)})`
      ),
      fixAction: `Re-export the mismatched track${mismatched.length === 1 ? '' : 's'} at ${formatSampleRate(targetSampleRate)} (24-bit WAV) so every stem shares one matching sample rate.`,
    });
  } else {
    checklist.push({
      id: 'sample-rate',
      status: 'pass',
      category: 'SAMPLE RATE',
      title: `Uniform native sample rate (${formatSampleRate(targetSampleRate)})`,
      detail: `Pre-decode header inspection confirmed every stem shares ${formatSampleRate(targetSampleRate)} with zero 44.1 kHz / 48 kHz conflicts.`,
      affectedFiles: [],
      fixAction: null,
    });
  }

  // CHECK 3: Digital Clipping (0 dBFS) & Silent Stems
  const silentStems = annotatedStems.filter((s) => s.isSilent);
  const clipFails = annotatedStems.filter((s) => !s.isSilent && s.clipStatus === 'fail');
  const clipWarns = annotatedStems.filter(
    (s) => !s.isSilent && (s.clipStatus === 'warn' || s.headroomStatus === 'warn')
  );

  if (silentStems.length > 0) {
    checklist.push({
      id: 'silent-stems',
      status: 'fail',
      category: 'SIGNAL CHECK',
      title: `${silentStems.length} stem${silentStems.length === 1 ? ' is' : 's are'} completely silent (< -60 dBFS)`,
      detail: 'Silent exports usually happen when a track was muted or routed to the wrong bus during bounce.',
      affectedFiles: silentStems.map((s) => s.filename),
      fixAction: 'Unmute the track in your DAW and re-export the dry audio.',
    });
  }

  if (clipFails.length > 0) {
    checklist.push({
      id: 'clipping',
      status: 'fail',
      category: 'CLIPPING & HEADROOM',
      title: `Digital clipping (0 dBFS) found on ${clipFails.length} stem${clipFails.length === 1 ? '' : 's'}`,
      detail:
        'Hard-clipped samples permanently flatten vocal transients and create harsh distortion that cannot be undone during mixing.',
      affectedFiles: clipFails.map(
        (s) =>
          `${s.filename} (${s.clippedSamples} clipped, ${s.hardClipBursts} burst${s.hardClipBursts === 1 ? '' : 's'}, ${formatDb(s.truePeakDbtp, 'dBTP')})`
      ),
      fixAction:
        'Lower track fader / clip gain by 3–6 dB (aiming for -6 to -12 dBFS peaks on dry vocals) and re-export, or re-record if the preamp itself clipped.',
    });
  } else if (clipWarns.length > 0) {
    checklist.push({
      id: 'clipping',
      status: 'warn',
      category: 'CLIPPING & HEADROOM',
      title: `Headroom warning on ${clipWarns.length} stem${clipWarns.length === 1 ? '' : 's'}`,
      detail:
        'Peaks are very hot (near 0 dBFS / > 0 dBTP) or unusually quiet (< -30 dBFS). Dry vocals mix cleanest around -6 to -12 dBFS peak.',
      affectedFiles: clipWarns.map(
        (s) => `${s.filename} (${formatDb(s.samplePeakDbfs, 'dBFS')} / ${formatDb(s.truePeakDbtp, 'dBTP')})`
      ),
      fixAction: 'Bypass master-bus limiters on export and adjust channel gain for comfortable headroom.',
    });
  } else if (silentStems.length < annotatedStems.length) {
    checklist.push({
      id: 'clipping',
      status: 'pass',
      category: 'CLIPPING & HEADROOM',
      title: 'Zero digital clipping across all stems',
      detail: 'No hard clip bursts or 0 dBFS sample breaches detected; healthy headroom preserved for mixing.',
      affectedFiles: [],
      fixAction: null,
    });
  }

  // CHECK 4: Dry Vocal Stereo FX / Reverb Detection (Mid/Side Check)
  const vocalStems = annotatedStems.filter((s) => s.role === 'vocal');
  const stereoFxFails = vocalStems.filter((s) => s.stereoFxStatus === 'fail');
  const stereoFxWarns = vocalStems.filter((s) => s.stereoFxStatus === 'warn');

  if (vocalStems.length === 0) {
    checklist.push({
      id: 'dry-vocals',
      status: 'warn',
      category: 'DRY VOCAL CHECK',
      title: 'No stems classified as Dry Vocal',
      detail:
        'If you uploaded vocal takes, switch their role to "Dry Vocal" in the stem audit table below so Mid/Side stereo FX detection can audit them.',
      affectedFiles: [],
      fixAction: 'Review the Role column in 002 / STEM-BY-STEM AUDIT.',
    });
  } else if (stereoFxFails.length > 0) {
    checklist.push({
      id: 'dry-vocals',
      status: 'fail',
      category: 'DRY VOCAL CHECK',
      title: `Baked-in stereo FX / reverb detected on ${stereoFxFails.length} vocal stem${stereoFxFails.length === 1 ? '' : 's'}`,
      detail:
        'Strong stereo Side (L - R) energy was detected inside a dry vocal stem — indicating stereo reverb, delay, chorus, or a widener was left active on export. Solo the flagged stem and click SIDE [S] in the console to hear the baked-in FX.',
      affectedFiles: stereoFxFails.map(
        (s) =>
          `${s.filename} (Side/Mid ${formatSignedDb(s.sideToMidDb)}, width ${s.stereoWidthPct}%, phase ${s.phaseCorrelation.toFixed(2)})`
      ),
      fixAction:
        'Bypass ALL insert plugins and FX sends (reverb, delay, chorus, widener, EQ, autotune) and re-export each vocal stem as a 100% dry mono WAV.',
    });
  } else if (stereoFxWarns.length > 0) {
    checklist.push({
      id: 'dry-vocals',
      status: 'warn',
      category: 'DRY VOCAL CHECK',
      title: `Light stereo content on ${stereoFxWarns.length} vocal stem${stereoFxWarns.length === 1 ? '' : 's'}`,
      detail:
        'Subtle L/R difference detected (-48 to -24 dB Side/Mid). Could be a subtle widener, stereo room mic, or gentle plugin left active.',
      affectedFiles: stereoFxWarns.map(
        (s) => `${s.filename} (Side/Mid ${formatSignedDb(s.sideToMidDb)}, width ${s.stereoWidthPct}%)`
      ),
      fixAction: 'Solo the stem and switch the monitor matrix to SIDE [S] to verify no effects were accidentally printed.',
    });
  } else {
    checklist.push({
      id: 'dry-vocals',
      status: 'pass',
      category: 'DRY VOCAL CHECK',
      title: `All ${vocalStems.length} vocal stem${vocalStems.length === 1 ? '' : 's'} verified dry (Pure Mono / Dual-Mono)`,
      detail: 'Zero stereo Side (L - R) reverb, delay, or widener energy found on any dry vocal track.',
      affectedFiles: [],
      fixAction: null,
    });
  }

  // CHECK 5: Lossless Format & Beat Presence (Saint Gordon Collaborate FAQ)
  const lossyVocals = vocalStems.filter((s) => s.lossyVocalWarn);
  const hasBeat = annotatedStems.some((s) => s.role === 'beat');

  if (lossyVocals.length > 0) {
    checklist.push({
      id: 'format-lossless',
      status: 'warn',
      category: 'FORMAT & BEAT',
      title: `${lossyVocals.length} dry vocal${lossyVocals.length === 1 ? ' is' : 's are'} lossy (${[...new Set(lossyVocals.map((s) => s.format))].join('/')}) instead of WAV`,
      detail:
        'Saint Gordon Collaborate accepts WAV or high-quality MP3 for the beat, but dry vocals should be uncompressed WAV (24-bit or 16-bit) so compression artifacts do not build up under vocal EQ and compression.',
      affectedFiles: lossyVocals.map((s) => `${s.filename} (${s.format})`),
      fixAction: 'Re-export dry vocal stems as uncompressed 24-bit WAV files.',
    });
  } else {
    checklist.push({
      id: 'format-lossless',
      status: 'pass',
      category: 'FORMAT & BEAT',
      title: 'Lossless format confirmed for all dry vocals',
      detail: hasBeat
        ? 'Dry vocals are uncompressed lossless audio and your instrumental beat is included.'
        : 'All loaded dry vocals are uncompressed lossless audio.',
      affectedFiles: [],
      fixAction: null,
    });
  }

  if (!hasBeat) {
    checklist.push({
      id: 'beat-included',
      status: 'warn',
      category: 'SESSION COMPLETENESS',
      title: 'No instrumental Beat stem detected in this drop',
      detail:
        'Remember to include your beat (WAV or high-quality MP3) alongside your vocal stems so timing and key/BPM can be verified together.',
      affectedFiles: [],
      fixAction: 'Drop your beat file here, or switch an existing file’s Role to "Beat / Inst" if it was mislabeled.',
    });
  }

  // CHECK 6: Stem Naming & Organization
  const genericNamed = annotatedStems.filter((s) => s.hasGenericName);
  if (genericNamed.length > 0) {
    checklist.push({
      id: 'stem-naming',
      status: 'warn',
      category: 'TRACK LABELS',
      title: `${genericNamed.length} stem${genericNamed.length === 1 ? ' has a' : 's have'} generic DAW filename${genericNamed.length === 1 ? '' : 's'}`,
      detail:
        'Clear track labels help the engineer identify leads, doubles, adlibs, and harmonies immediately without guessing.',
      affectedFiles: genericNamed.map((s) => s.filename),
      fixAction:
        'Rename before zipping using Saint Gordon Collaborate labels: Main Vox, Main Double, Adlibs, Harmonies, Backing, Beat.',
    });
  } else {
    checklist.push({
      id: 'stem-naming',
      status: 'pass',
      category: 'TRACK LABELS',
      title: 'All stem filenames are clearly labeled',
      detail: 'Every file carries a descriptive track name ready to zip into your artist/song folder.',
      affectedFiles: [],
      fixAction: null,
    });
  }

  // Order checklist: fail -> warn -> pass
  const rank = { fail: 0, warn: 1, pass: 2 };
  checklist.sort((a, b) => rank[a.status] - rank[b.status]);

  const failCount = checklist.filter((c) => c.status === 'fail').length;
  const warnCount = checklist.filter((c) => c.status === 'warn').length;
  const passCount = checklist.filter((c) => c.status === 'pass').length;

  let verdict = 'READY';
  let verdictHeadline = 'Transmission Approved.';
  let verdictSubtitle =
    'All stems match sample rate, start cleanly from 0:00, hold clean headroom, and pass dry-vocal inspection. Ready to zip and send.';

  if (failCount > 0) {
    verdict = 'FIX REQUIRED';
    verdictHeadline = 'Fix Before Sending.';
    verdictSubtitle = `${failCount} critical issue${failCount === 1 ? '' : 's'} detected that will break session sync, clipping headroom, or dry-vocal mixability. Follow the checklist below before bouncing your zip.`;
  } else if (warnCount > 0) {
    verdict = 'REVIEW';
    verdictHeadline = 'Review Warnings.';
    verdictSubtitle = `No hard blockers found, but ${warnCount} advisory warning${warnCount === 1 ? '' : 's'} deserve a quick ear check before you zip and send your stems.`;
  }

  return {
    verdict,
    verdictHeadline,
    verdictSubtitle,
    referenceDurationSec: round3(referenceDurationSec),
    referenceSource,
    referenceFilename: refStem ? refStem.filename : null,
    targetSampleRate,
    uniqueSampleRates,
    stems: annotatedStems,
    checklist,
    summary: {
      stemCount: annotatedStems.length,
      beatCount: annotatedStems.filter((s) => s.role === 'beat').length,
      vocalCount: vocalStems.length,
      fxCount: annotatedStems.filter((s) => s.role === 'fx').length,
      failCount,
      warnCount,
      passCount,
      totalClippedSamples: annotatedStems.reduce((acc, s) => acc + s.clippedSamples, 0),
      flaggedStereoVocals: stereoFxFails.length,
      mismatchedLengthCount: lengthFails.length,
      mismatchedSampleRateCount: annotatedStems.filter((s) => s.sampleRateMismatch).length,
    },
  };
}

/* --------------------------------------------------------------------------
 * Markdown Stem Validation Certificate Export
 * -------------------------------------------------------------------------- */

export function buildStemReportMarkdown(session, generatedAt = new Date()) {
  const isoDate =
    generatedAt instanceof Date ? generatedAt.toISOString().slice(0, 10) : String(generatedAt);

  const lines = [
    '# Saint Gordon Collective — Stem Check Validation Certificate',
    '',
    `- **Tool:** Stem Check (TOOL / 007 — Pre-Mix Stem Validator)`,
    `- **Date:** ${isoDate}`,
    `- **Verdict:** **${session.verdict}** — ${session.verdictHeadline}`,
    `- **Stems Audited:** ${session.summary.stemCount} (${session.summary.beatCount} Beat · ${session.summary.vocalCount} Dry Vocal · ${session.summary.fxCount} FX/Other)`,
    `- **Reference Timeline:** ${formatTimePrecise(session.referenceDurationSec)} (${session.referenceSource}${session.referenceFilename ? `: \`${session.referenceFilename}\`` : ''})`,
    `- **Native Sample Rate(s):** ${session.uniqueSampleRates.map((sr) => formatSampleRate(sr)).join(', ') || '—'}`,
    '',
    '## 001 / Transmission Checklist',
    '',
  ];

  for (const item of session.checklist) {
    const tag = item.status === 'fail' ? '[FIX]' : item.status === 'warn' ? '[WARN]' : '[PASS]';
    lines.push(`- **${tag} ${item.category}:** ${item.title}`);
    lines.push(`  - ${item.detail}`);
    if (item.affectedFiles && item.affectedFiles.length > 0) {
      lines.push(`  - Affected: ${item.affectedFiles.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (item.fixAction) {
      lines.push(`  - Action: ${item.fixAction}`);
    }
  }

  lines.push(
    '',
    '## 002 / Stem-by-Stem Audit',
    '',
    '| Status | File | Role | Format | Native SR | Ch | Length (Δ) | Peak / True Peak | Clips | Dry / Mid-Side |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  );

  for (const s of session.stems) {
    const badge = s.stemStatus === 'fail' ? 'FIX' : s.stemStatus === 'warn' ? 'WARN' : 'PASS';
    const fmt = s.bitsPerSample
      ? `${s.bitsPerSample}-bit ${s.format}`
      : s.bitrateKbps
        ? `${s.format} ${s.bitrateKbps}k`
        : s.format;
    const lenCol = `${formatTimePrecise(s.durationSec)} (${formatSignedDeltaSec(s.lengthDeltaSec)})`;
    const peakCol = `${formatDb(s.samplePeakDbfs, 'dBFS')} / ${formatDb(s.truePeakDbtp, 'dBTP')}`;
    const clipCol =
      s.clippedSamples > 0
        ? `${s.clippedSamples} (${s.hardClipBursts} burst${s.hardClipBursts === 1 ? '' : 's'})`
        : '0';
    const dryCol = s.isNativeMono
      ? s.stereoLabel
      : `${s.stereoLabel} (${formatSignedDb(s.sideToMidDb)}, ${s.stereoWidthPct}%)`;

    lines.push(
      `| **${badge}** | \`${s.filename}\` | ${ROLE_LABELS[s.role] || s.role} | ${fmt} | ${formatSampleRate(s.nativeSampleRate)} | ${formatChannels(s.nativeChannels)} | ${lenCol} | ${peakCol} | ${clipCol} | ${dryCol} |`
    );
  }

  lines.push(
    '',
    '---',
    '*Generated 100% client-side by [Stem Check](https://firewallaby.github.io/stem-check/) · [Saint Gordon Collaborate Protocol](https://saintgordon.vercel.app/collaboration.html)*',
    ''
  );

  return lines.join('\n');
}
