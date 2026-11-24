# Stem Check — Pre-Mix Stem Validator (`TOOL / 007`)

**Stem Check** is a 100% client-side, zero-dependency pre-mix stem validator built for the [Saint Gordon Collective](https://saintgordon.vercel.app) and its free [Collaborate](https://saintgordon.vercel.app/collaboration.html) vocal mixing & guest feature workflow.

**Live App:** https://saintgordon.github.io/stem-check/

Drop a folder of vocal takes and your beat into the browser before you zip and send them — no server uploads, no DAW plugins required, and zero audio leaves your machine.

---

## Why Stem Check Exists

Sending stems to a mix engineer is where most sessions stall: a single track bounced at 48 kHz instead of 44.1 kHz, an adlib exported from region start instead of `0:00 / Bar 1`, a vocal printed with stereo reverb still active, or digital clipping at `0 dBFS`.

Stem Check automates the technical half of the [Saint Gordon Collaborate Transmission Protocol](https://saintgordon.vercel.app/collaboration.html) in seconds.

---

## Validation Checks

1. **Native Sample-Rate Inspection (`44.1 kHz` vs `48 kHz`)**
   - Web Audio's `decodeAudioData()` silently resamples files to your OS output sample rate, hiding mismatches.
   - Stem Check parses raw binary headers **before decode** (`WAV / RF64`, `FLAC STREAMINFO`, `AIFF / AIFC` 80-bit IEEE extended float, `MP3` MPEG sync frames with ID3v2 skipping, `M4A`, and `OGG / Opus`) to reveal every stem's true native sample rate, bit depth, channel count, and format.
2. **0:00 Start & Timeline Length Sync**
   - Compares every stem against the session reference timeline (Beat stem if present, otherwise longest stem).
   - Flags stems shorter or longer than `±1.5s` (and specifically catches vocal stems starting immediately near `0:00` that were exported from region start instead of `0:00 / Bar 1`).
   - Detects abrupt non-zero transients in the first `2 ms` (missing fade-in / sliced vocal click).
3. **Digital Clipping (`0 dBFS`) & 4× True Peak (`dBTP`)**
   - Counts exact clipped samples (`|s| >= 0.9999`), hard clip bursts (`>= 3` consecutive clipped samples) with timestamps, 4× oversampled 12-tap Kaiser-windowed sinc True Peak (`dBTP`), RMS, DC offset, and silent tracks (`< -60 dBFS`).
4. **Dry Vocal Stereo FX / Reverb Detection (Mid/Side Ratio)**
   - Measures active-frame Side-to-Mid energy (`M = 0.5*(L+R)`, `S = 0.5*(L-R)`), stereo width %, phase correlation, and phrase release-tail decay.
   - Pure mono (`1ch`) and dual-mono stereo (`L === R`) vocals pass cleanly; vocals with baked-in stereo reverb, delay, chorus, or wideners are flagged immediately.
5. **Lossless Format, Beat Presence & Track Labels**
   - Confirms dry vocals are uncompressed lossless audio (`WAV / FLAC / AIFF`) while allowing `WAV` or high-quality `MP3` for the instrumental beat.
   - Flags generic DAW filenames (`Audio 1.wav`, `Untitled.wav`) and suggests Saint Gordon Collaborate naming (`Main Vox`, `Main Double`, `Adlibs`, `Harmonies`, `Backing`, `Beat`).

---

## Synchronized Multi-Track Deck & Built-In Demo Pack

- **Sample-Locked Multi-Track Playback:** Plays every stem simultaneously from `0:00` with clickless real-time **Mute (`M`)** and **Solo (`S`)**, plus a stacked multi-track waveform timeline showing short stems and red clip ticks.
- **Stereo / Mono / Side (`L - R`) Monitor Matrix:** Solo any flagged vocal and click **Side (`S`)** (or press **Solo Flagged Vocal + SIDE**) — dry mono signals vanish to silence while baked-in stereo reverb/delay pops right out.
- **One-Click Demo Session:** Click **Load Demo Session (4 Stems)** to synthesize 4 real in-memory WAV files (`01_Beat_Instrumental_44k.wav`, `02_Main_Vox_Dry_Mono.wav`, `03_Hook_Double_WET_48k.wav`, and `04_Adlibs_Clipped_Short.wav`) that exercise every check and audition mode immediately.
- **Exportable Validation Certificate:** Download a complete Markdown report (`.md`) or copy the Pass/Fix checklist to paste alongside your stem download link.

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause all stems |
| `R` | Restart synchronized playback from `0:00` |
| `M` | Toggle **Mono Sum (`L + R`)** monitor |
| `S` | Toggle **Side (`L - R`)** monitor (isolates stereo FX) |
| `←` / `→` | Scrub timeline backward / forward by 2 seconds |

---

## Running Locally & Running Tests

No build step or `npm install` is required.

```bash
# Serve locally with any static server
python3 -m http.server 8080

# Run pure-JS DSP & native header parser unit tests (Node 18+)
node --test tests/stem-dsp.test.mjs
```

---

## Browser Compatibility

Built with vanilla ES Modules, Canvas 2D, and Web Audio API (`AudioContext || webkitAudioContext`, Promise + callback `decodeAudioData` compatibility). Tested for Chrome, Safari / iOS Safari, Firefox, and Edge.

*(Note: AIFF header parsing works in all browsers; AIFF audio playback decoding is natively supported in Safari and via WAV export in Chrome/Firefox.)*

---

## Links

- **Saint Gordon Collective:** https://saintgordon.vercel.app
- **Collaborate (Free Vocal Mixing & Features):** https://saintgordon.vercel.app/collaboration.html
- **The Collection:** https://saintgordon.vercel.app/collection.html
