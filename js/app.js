/**
 * Stem Check (TOOL / 007) — Main Interactive Application Controller.
 * Connects native header + stem DSP engine (`stem-dsp.js`) with
 * synchronized multi-track Web Audio playback (`stem-audio.js`) and
 * the Saint Gordon Collective editorial monochrome UI.
 */

import {
  ROLE_LABELS,
  analyzeStemChannels,
  buildStemReportMarkdown,
  formatChannels,
  formatDb,
  formatSampleRate,
  formatSignedDb,
  formatSignedDeltaSec,
  formatTime,
  formatTimePrecise,
  isSupportedAudioFilename,
  parseNativeAudioHeader,
  validateStemSession,
} from './stem-dsp.js';

import {
  StemAudioEngine,
  decodeAudioDataSafe,
  generateDemoStemPack,
} from './stem-audio.js';

/* --------------------------------------------------------------------------
 * State & Constants
 * -------------------------------------------------------------------------- */

const RULER_HEIGHT = 26;
const LANE_HEIGHT = 58;

const state = {
  items: [], // Array of { id, analysis, buffer }
  session: null,
  nextId: 1,
  isLoading: false,
  isScrubbing: false,
  rafId: null,
};

const engine = new StemAudioEngine();

/* --------------------------------------------------------------------------
 * DOM References
 * -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const els = {
  uploadSection: $('top'),
  dropzone: $('upload-dropzone'),
  dropzoneClickTarget: $('dropzone-click-target'),
  dropzoneHeading: $('dropzone-heading'),
  fileInput: $('file-upload-input'),
  folderInput: $('folder-upload-input'),
  btnSelectFiles: $('btn-select-files'),
  btnSelectFolder: $('btn-select-folder'),
  btnLoadDemo: $('btn-load-demo'),
  btnHeaderClear: $('btn-header-clear'),
  btnAddMoreFiles: $('btn-add-more-files'),
  btnAddMoreFolder: $('btn-add-more-folder'),
  btnClearSession: $('btn-clear-session'),
  btnExportMd: $('btn-export-md'),
  btnCopyChecklist: $('btn-copy-checklist'),

  progressWrap: $('decode-progress-container'),
  progressText: $('decode-progress-text'),
  progressPct: $('decode-progress-pct'),
  progressBar: $('decode-progress-bar'),

  errorsBanner: $('decode-errors-banner'),
  errorsTitle: $('decode-errors-title'),
  errorsList: $('decode-errors-list'),
  btnDismissErrors: $('btn-dismiss-errors'),

  auditResults: $('audit-results'),
  verdictSheet: $('verdict-sheet'),
  verdictStamp: $('verdict-stamp'),
  verdictRefMeta: $('verdict-ref-meta'),
  verdictTitle: $('verdict-title'),
  verdictSubtitle: $('verdict-subtitle'),
  verdictSessionBreakdown: $('verdict-session-breakdown'),
  verdictSessionCounts: $('verdict-session-counts'),

  metricStems: $('metric-stems'),
  metricStemsSub: $('metric-stems-sub'),
  metricSr: $('metric-sr'),
  metricSrSub: $('metric-sr-sub'),
  metricSync: $('metric-sync'),
  metricSyncSub: $('metric-sync-sub'),
  metricClips: $('metric-clips'),
  metricClipsSub: $('metric-clips-sub'),
  metricDry: $('metric-dry'),
  metricDrySub: $('metric-dry-sub'),

  studioDeck: $('studio-deck'),
  deckStatePill: $('deck-state-pill'),
  deckMonitorReadout: $('deck-monitor-readout'),
  deckTimeCurrent: $('deck-time-current'),
  deckTimeTotal: $('deck-time-total'),
  multitrackGutter: $('multitrack-gutter'),
  multitrackWrap: $('multitrack-canvas-wrap'),
  multitrackCanvas: $('multitrack-canvas'),
  vuMeterL: $('vu-meter-l'),
  vuMeterR: $('vu-meter-r'),
  clipLedL: $('clip-led-l'),
  clipLedR: $('clip-led-r'),

  btnPlayPause: $('btn-play-pause'),
  playBtnGlyph: $('play-btn-glyph'),
  playBtnText: $('play-btn-text'),
  btnRestart: $('btn-restart'),
  btnClearSolo: $('btn-clear-solo'),
  btnJumpZero: $('btn-jump-zero'),
  btnJumpFirstVox: $('btn-jump-first-vox'),
  btnJumpClip: $('btn-jump-clip'),
  btnSoloWetSide: $('btn-solo-wet-side'),
  volumeSlider: $('master-volume-slider'),

  checklistSummaryPill: $('checklist-summary-pill'),
  checklistList: $('checklist-list'),
  stemTableBody: $('stem-table-body'),
  toastContainer: $('toast-container'),
  footerYear: $('footer-year'),
};

/* --------------------------------------------------------------------------
 * Toasts & Helpers
 * -------------------------------------------------------------------------- */

function showToast(message, isError = false) {
  const el = document.createElement('div');
  el.className = isError ? 'toast toast-error' : 'toast';
  el.textContent = message;
  els.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setProgress(visible, text = '', pct = 0) {
  els.progressWrap.classList.toggle('hidden', !visible);
  if (visible) {
    els.progressText.textContent = text;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    els.progressPct.textContent = `${clamped}%`;
    els.progressBar.style.width = `${clamped}%`;
  }
}

function showErrors(errors) {
  if (!errors || errors.length === 0) {
    els.errorsBanner.classList.add('hidden');
    return;
  }
  els.errorsTitle.textContent =
    errors.length === 1
      ? '1 file could not be loaded'
      : `${errors.length} files could not be loaded`;
  els.errorsList.innerHTML = errors
    .map((e) => `<li><strong>${escapeHtml(e.filename)}</strong>: ${escapeHtml(e.reason)}</li>`)
    .join('');
  els.errorsBanner.classList.remove('hidden');
}

/* --------------------------------------------------------------------------
 * Recursive Folder Drag & Drop Traversal
 * -------------------------------------------------------------------------- */

function readEntryFiles(entry) {
  return new Promise((resolve) => {
    if (!entry) {
      resolve([]);
      return;
    }
    if (entry.isFile) {
      entry.file(
        (file) => resolve([file]),
        () => resolve([])
      );
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => {
        reader.readEntries(
          async (entries) => {
            if (!entries || entries.length === 0) {
              resolve(collected);
              return;
            }
            for (const child of entries) {
              const childFiles = await readEntryFiles(child);
              collected.push(...childFiles);
            }
            readBatch();
          },
          () => resolve(collected)
        );
      };
      readBatch();
      return;
    }
    resolve([]);
  });
}

async function extractDroppedFiles(dataTransfer) {
  const items = dataTransfer?.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = [];
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const all = [];
      for (const entry of entries) {
        const found = await readEntryFiles(entry);
        all.push(...found);
      }
      return all;
    }
  }
  return Array.from(dataTransfer?.files || []);
}

/* --------------------------------------------------------------------------
 * Audio Ingestion Pipeline (Native Header -> Web Audio Decode -> Stem DSP)
 * -------------------------------------------------------------------------- */

async function ingestSources(sources, { replaceExisting = false } = {}) {
  if (state.isLoading || !sources || sources.length === 0) return;

  const supported = sources.filter((src) => isSupportedAudioFilename(src.filename));
  if (supported.length === 0) {
    showToast('No supported audio files found (WAV, FLAC, AIFF, MP3, M4A, OGG).', true);
    return;
  }

  state.isLoading = true;
  if (replaceExisting) {
    engine.clearAll();
    state.items = [];
  } else {
    engine.pause();
  }

  const errors = [];
  const ctx = engine.ensureContext();
  setProgress(true, `Reading native headers (0 / ${supported.length})...`, 4);

  for (let i = 0; i < supported.length; i += 1) {
    const src = supported[i];
    const pct = ((i + 0.35) / supported.length) * 100;
    setProgress(true, `Inspecting & decoding ${src.filename} (${i + 1} / ${supported.length})...`, pct);

    // Yield a frame so UI progress bar stays responsive on large WAV folders
    await new Promise((r) => setTimeout(r, 0));

    try {
      const arrayBuffer = src.arrayBuffer
        ? src.arrayBuffer
        : await src.file.arrayBuffer();
      const rawBytes = new Uint8Array(arrayBuffer);

      // 1. Parse TRUE native header BEFORE Web Audio decode resamples to OS sample rate!
      const nativeHeader = parseNativeAudioHeader(rawBytes, src.filename);

      // 2. Decode PCM via Web Audio API
      let audioBuffer;
      try {
        audioBuffer = await decodeAudioDataSafe(ctx, arrayBuffer);
      } catch (decodeErr) {
        const hint =
          nativeHeader.format === 'AIFF'
            ? 'AIFF decoding is supported on Safari; convert to WAV in your DAW for Chrome/Firefox.'
            : 'Unsupported codec or corrupted audio file.';
        errors.push({ filename: src.filename, reason: hint });
        continue;
      }

      // 3. Extract PCM channel Float32Arrays & run pure-JS Stem DSP analysis
      const channelDataList = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c += 1) {
        channelDataList.push(audioBuffer.getChannelData(c));
      }

      const id = `stem-${state.nextId++}`;
      const analysis = analyzeStemChannels(
        channelDataList,
        audioBuffer.sampleRate,
        nativeHeader,
        null,
        src.filename
      );
      analysis.id = id;

      engine.addStem(id, audioBuffer);
      state.items.push({ id, analysis, buffer: audioBuffer });
    } catch (err) {
      errors.push({
        filename: src.filename,
        reason: err?.message || 'Could not read file.',
      });
    }
  }

  setProgress(false);
  state.isLoading = false;

  showErrors(errors);

  if (state.items.length === 0) {
    showToast('Could not decode any audio stems from that selection.', true);
    return;
  }

  sortItemsOrder();
  runValidationAndRender();
  showToast(
    `Audited ${supported.length - errors.length} stem${supported.length - errors.length === 1 ? '' : 's'}.`
  );
}

function sortItemsOrder() {
  const roleOrder = { beat: 0, vocal: 1, fx: 2 };
  state.items.sort((a, b) => {
    const rDiff = (roleOrder[a.analysis.role] ?? 1) - (roleOrder[b.analysis.role] ?? 1);
    if (rDiff !== 0) return rDiff;
    return a.analysis.filename.localeCompare(b.analysis.filename, undefined, { numeric: true });
  });
}

async function handleFileList(fileList) {
  const files = Array.from(fileList || []);
  const sources = files.map((file) => ({
    filename: file.name,
    file,
  }));
  await ingestSources(sources, { replaceExisting: false });
}

async function handleLoadDemoSession() {
  if (state.isLoading) return;
  setProgress(true, 'Synthesizing 4-stem demo session (44.1 kHz & 48 kHz WAVs)...', 15);
  await new Promise((r) => setTimeout(r, 20));
  const pack = generateDemoStemPack();
  const sources = pack.map((item) => ({
    filename: item.filename,
    arrayBuffer: item.bytes.buffer.slice(
      item.bytes.byteOffset,
      item.bytes.byteOffset + item.bytes.byteLength
    ),
  }));
  await ingestSources(sources, { replaceExisting: true });
}

/* --------------------------------------------------------------------------
 * Validation & Full UI Rendering
 * -------------------------------------------------------------------------- */

function runValidationAndRender() {
  if (state.items.length === 0) {
    state.session = null;
    els.uploadSection.dataset.state = 'empty';
    els.dropzoneHeading.textContent = 'Drag & Drop Stem Files or a Whole Folder Here';
    els.auditResults.classList.add('hidden');
    els.btnHeaderClear.classList.add('hidden');
    stopAnimationLoop();
    return;
  }

  const rawAnalyses = state.items.map((item) => item.analysis);
  const session = validateStemSession(rawAnalyses);
  state.session = session;

  // Keep item analyses synced with role & annotated status
  const byId = new Map(session.stems.map((s) => [s.id, s]));
  for (const item of state.items) {
    if (byId.has(item.id)) {
      item.analysis = byId.get(item.id);
    }
  }

  els.uploadSection.dataset.state = 'loaded';
  els.dropzoneHeading.textContent = `${session.summary.stemCount} Stems Loaded — Drop More Files or a New Folder Anytime`;
  els.auditResults.classList.remove('hidden');
  els.btnHeaderClear.classList.remove('hidden');

  renderVerdictSheet(session);
  renderQuickAuditionButtons(session);
  renderDeckGutter(session);
  renderChecklist(session);
  renderStemTable(session);
  updateTransportUI();
  resizeAndDrawCanvas();
}

function renderVerdictSheet(session) {
  const verdictKey =
    session.verdict === 'READY'
      ? 'ready'
      : session.verdict === 'REVIEW'
        ? 'review'
        : 'fix';

  els.verdictSheet.dataset.verdict = verdictKey;
  els.verdictStamp.textContent =
    verdictKey === 'ready'
      ? '✳ TRANSMISSION APPROVED'
      : verdictKey === 'review'
        ? '⚠ REVIEW WARNINGS'
        : '✕ FIX BEFORE SENDING';

  els.verdictRefMeta.textContent = `REF TIMELINE · ${formatTimePrecise(session.referenceDurationSec)} (${session.referenceSource.toUpperCase()})`;
  els.verdictTitle.textContent = session.verdictHeadline;
  els.verdictSubtitle.textContent = session.verdictSubtitle;

  const { summary } = session;
  els.verdictSessionBreakdown.textContent = `${summary.stemCount} Stem${summary.stemCount === 1 ? '' : 's'} (${summary.beatCount} Beat · ${summary.vocalCount} Dry Vocal · ${summary.fxCount} FX)`;
  els.verdictSessionCounts.textContent = `${summary.failCount} FIX · ${summary.warnCount} WARN · ${summary.passCount} PASS`;

  // Metric 1: Stems
  els.metricStems.textContent = String(summary.stemCount);
  els.metricStemsSub.textContent = `${summary.vocalCount} Vocal · ${summary.beatCount} Beat`;
  els.metricStems.parentElement.dataset.state = summary.beatCount === 0 ? 'warn' : 'pass';

  // Metric 2: Sample Rate
  if (session.uniqueSampleRates.length > 1) {
    els.metricSr.textContent = 'MISMATCH';
    els.metricSrSub.textContent = session.uniqueSampleRates
      .map((sr) => formatSampleRate(sr))
      .join(' vs ');
    els.metricSr.parentElement.dataset.state = 'fail';
  } else {
    els.metricSr.textContent = formatSampleRate(session.targetSampleRate);
    els.metricSrSub.textContent = 'All headers matched';
    els.metricSr.parentElement.dataset.state = 'pass';
  }

  // Metric 3: Sync Alignment
  if (summary.mismatchedLengthCount > 0) {
    els.metricSync.textContent = `${summary.mismatchedLengthCount} OFF-SYNC`;
    els.metricSyncSub.textContent = `Ref ${formatTimePrecise(session.referenceDurationSec)}`;
    els.metricSync.parentElement.dataset.state = 'fail';
  } else if (session.stems.some((s) => s.lengthStatus === 'warn')) {
    els.metricSync.textContent = 'CHECK TAIL';
    els.metricSyncSub.textContent = '0.25s–1.5s delta';
    els.metricSync.parentElement.dataset.state = 'warn';
  } else {
    els.metricSync.textContent = '0:00 LOCKED';
    els.metricSyncSub.textContent = `All ${formatTimePrecise(session.referenceDurationSec)}`;
    els.metricSync.parentElement.dataset.state = 'pass';
  }

  // Metric 4: Digital Clipping
  const clipFailCount = session.stems.filter((s) => s.clipStatus === 'fail').length;
  const clipWarnCount = session.stems.filter((s) => s.clipStatus === 'warn').length;
  if (clipFailCount > 0) {
    els.metricClips.textContent = `${clipFailCount} CLIPPING`;
    els.metricClipsSub.textContent = `${summary.totalClippedSamples} clipped samples`;
    els.metricClips.parentElement.dataset.state = 'fail';
  } else if (clipWarnCount > 0) {
    els.metricClips.textContent = `${clipWarnCount} HOT PEAK`;
    els.metricClipsSub.textContent = 'Near or over 0 dBTP';
    els.metricClips.parentElement.dataset.state = 'warn';
  } else {
    els.metricClips.textContent = 'CLEAN 0';
    els.metricClipsSub.textContent = 'No 0 dBFS clips';
    els.metricClips.parentElement.dataset.state = 'pass';
  }

  // Metric 5: Dry Vocal Check
  const wetWarnCount = session.stems.filter(
    (s) => s.role === 'vocal' && s.stereoFxStatus === 'warn'
  ).length;
  if (summary.flaggedStereoVocals > 0) {
    els.metricDry.textContent = `${summary.flaggedStereoVocals} WET FX`;
    els.metricDrySub.textContent = 'Stereo reverb/delay found';
    els.metricDry.parentElement.dataset.state = 'fail';
  } else if (wetWarnCount > 0) {
    els.metricDry.textContent = `${wetWarnCount} LIGHT ST`;
    els.metricDrySub.textContent = 'Verify FX bypassed';
    els.metricDry.parentElement.dataset.state = 'warn';
  } else if (summary.vocalCount === 0) {
    els.metricDry.textContent = 'NO VOCALS';
    els.metricDrySub.textContent = 'Set vocal role below';
    els.metricDry.parentElement.dataset.state = 'warn';
  } else {
    els.metricDry.textContent = '100% DRY';
    els.metricDrySub.textContent = `${summary.vocalCount} mono/dual-mono`;
    els.metricDry.parentElement.dataset.state = 'pass';
  }
}

function renderQuickAuditionButtons(session) {
  const firstClipStem = session.stems.find(
    (s) => s.clipTimestamps && s.clipTimestamps.length > 0
  );
  els.btnJumpClip.classList.toggle('hidden', !firstClipStem);

  const firstWetVocal = session.stems.find(
    (s) => s.role === 'vocal' && (s.stereoFxStatus === 'fail' || s.stereoFxStatus === 'warn')
  );
  els.btnSoloWetSide.classList.toggle('hidden', !firstWetVocal);
}

function renderDeckGutter(session) {
  const anySolo = engine.hasAnySolo();
  const rows = [
    `<div class="gutter-ruler-head micro"><span>STEMS (${session.stems.length})</span><span>M / S</span></div>`,
  ];

  for (const stem of session.stems) {
    const st = engine.getStemState(stem.id);
    const effectivelyMuted = anySolo ? !st.solo : st.mute;
    const roleShort =
      stem.role === 'beat' ? 'BEAT' : stem.role === 'vocal' ? 'VOX' : 'FX';

    rows.push(`
      <div class="gutter-row ${effectivelyMuted ? 'is-muted' : ''}" data-stem-id="${escapeHtml(stem.id)}">
        <div class="gutter-row-info">
          <span class="gutter-stem-name" title="${escapeHtml(stem.filename)}">${escapeHtml(stem.filename)}</span>
          <span class="gutter-stem-meta">
            <span class="gutter-status-dot" data-status="${stem.stemStatus}"></span>
            <span>${roleShort}</span>
            <span>·</span>
            <span>${formatSampleRate(stem.nativeSampleRate)}</span>
          </span>
        </div>
        <div class="gutter-ms-btns">
          <button
            type="button"
            class="ms-btn ${st.mute ? 'active-mute' : ''}"
            data-action="mute"
            data-stem-id="${escapeHtml(stem.id)}"
            title="Mute ${escapeHtml(stem.filename)}"
            aria-pressed="${st.mute}"
          >M</button>
          <button
            type="button"
            class="ms-btn ${st.solo ? 'active-solo' : ''}"
            data-action="solo"
            data-stem-id="${escapeHtml(stem.id)}"
            title="Solo ${escapeHtml(stem.filename)}"
            aria-pressed="${st.solo}"
          >S</button>
        </div>
      </div>
    `);
  }

  els.multitrackGutter.innerHTML = rows.join('');

  const anyMuteOrSolo = session.stems.some((s) => {
    const st = engine.getStemState(s.id);
    return st.mute || st.solo;
  });
  els.btnClearSolo.classList.toggle('hidden', !anyMuteOrSolo);
}

function renderChecklist(session) {
  const { summary } = session;
  els.checklistSummaryPill.textContent = `${summary.failCount} FIX · ${summary.warnCount} WARN · ${summary.passCount} PASS`;

  els.checklistList.innerHTML = session.checklist
    .map((item) => {
      const stampLabel =
        item.status === 'fail' ? 'FIX' : item.status === 'warn' ? 'WARN' : 'PASS';
      const filesHtml =
        item.affectedFiles && item.affectedFiles.length > 0
          ? `<div class="checklist-files">${item.affectedFiles
              .map((f) => `<span class="file-chip">${escapeHtml(f)}</span>`)
              .join('')}</div>`
          : '';
      const actionHtml = item.fixAction
        ? `<p class="checklist-fix"><strong>DAW Action:</strong> ${escapeHtml(item.fixAction)}</p>`
        : '';

      return `
        <li class="checklist-item">
          <div>
            <span class="status-stamp status-${item.status}">${stampLabel}</span>
          </div>
          <div>
            <span class="micro checklist-cat">${escapeHtml(item.category)}</span>
            <div class="checklist-label">${escapeHtml(item.title)}</div>
            <p class="checklist-detail">${escapeHtml(item.detail)}</p>
            ${filesHtml}
            ${actionHtml}
          </div>
        </li>
      `;
    })
    .join('');
}

function renderStemTable(session) {
  els.stemTableBody.innerHTML = session.stems
    .map((s) => {
      const st = engine.getStemState(s.id);
      const stampLabel =
        s.stemStatus === 'fail' ? 'FIX' : s.stemStatus === 'warn' ? 'WARN' : 'PASS';

      const fmtBits = s.bitsPerSample
        ? `${s.bitsPerSample}-bit ${s.isFloat ? 'Float ' : ''}${s.format}`
        : s.bitrateKbps
          ? `${s.format} ${s.bitrateKbps} kbps`
          : s.format;

      const srFlag = s.sampleRateMismatch
        ? `<div class="stem-flag-text">MISMATCH (SESSION ${formatSampleRate(session.targetSampleRate)})</div>`
        : s.lossyVocalWarn
          ? `<div class="stem-warn-text">LOSSY VOCAL — USE WAV</div>`
          : '';

      const lenFlag =
        s.lengthStatus === 'fail'
          ? `<div class="stem-flag-text">${s.looksSlicedNotZero ? 'NOT FROM 0:00' : formatSignedDeltaSec(s.lengthDeltaSec)}</div>`
          : s.lengthStatus === 'warn'
            ? `<div class="stem-warn-text">Δ ${formatSignedDeltaSec(s.lengthDeltaSec)}</div>`
            : '';

      const clipFlag = s.isSilent
        ? `<div class="stem-flag-text">SILENT TRACK</div>`
        : s.clipStatus === 'fail'
          ? `<div class="stem-flag-text">${s.clippedSamples} CLIPS (${s.hardClipBursts} BURST${s.hardClipBursts === 1 ? '' : 'S'})</div>`
          : s.clipStatus === 'warn' || s.headroomStatus === 'warn'
            ? `<div class="stem-warn-text">${escapeHtml(s.headroomLabel)}</div>`
            : '';

      const dryDetail = s.isNativeMono
        ? '1ch Mono · 0% Side'
        : `Side/Mid ${formatSignedDb(s.sideToMidDb)} · ${s.stereoWidthPct}% width`;

      const dryFlag =
        s.stereoFxStatus === 'fail'
          ? `<div class="stem-flag-text">BAKED-IN STEREO FX</div>`
          : s.stereoFxStatus === 'warn'
            ? `<div class="stem-warn-text">LIGHT STEREO</div>`
            : '';

      const firstAudioText =
        s.firstAudioSec != null ? `First audio @ ${formatTimePrecise(s.firstAudioSec)}` : 'No active signal';

      const issuesListHtml =
        s.issues.length > 0
          ? `<ul class="stem-issue-list">${s.issues.map((iss) => `<li>${escapeHtml(iss)}</li>`).join('')}</ul>`
          : `<p class="stem-cell-sub" style="margin:6px 0 0;">All stem checks passed cleanly.</p>`;

      return `
        <div class="stem-row" data-status="${s.stemStatus}" data-stem-id="${escapeHtml(s.id)}">
          <div class="stem-row-main">
            <div>
              <span class="status-stamp status-${s.stemStatus}">${stampLabel}</span>
            </div>

            <div class="stem-name-col">
              <div class="stem-filename">${escapeHtml(s.filename)}</div>
              <label class="sr-only" for="role-${escapeHtml(s.id)}">Stem role for ${escapeHtml(s.filename)}</label>
              <select
                id="role-${escapeHtml(s.id)}"
                class="stem-role-select"
                data-action="role"
                data-stem-id="${escapeHtml(s.id)}"
              >
                <option value="beat" ${s.role === 'beat' ? 'selected' : ''}>Beat / Inst</option>
                <option value="vocal" ${s.role === 'vocal' ? 'selected' : ''}>Dry Vocal</option>
                <option value="fx" ${s.role === 'fx' ? 'selected' : ''}>FX / Other</option>
              </select>
            </div>

            <div>
              <div class="stem-cell-main">${escapeHtml(fmtBits)}</div>
              <div class="stem-cell-sub">${formatSampleRate(s.nativeSampleRate)} · ${formatChannels(s.nativeChannels)}</div>
              ${srFlag}
            </div>

            <div>
              <div class="stem-cell-main">${formatTimePrecise(s.durationSec)} · Δ ${formatSignedDeltaSec(s.lengthDeltaSec)}</div>
              <div class="stem-cell-sub">${firstAudioText}</div>
              ${lenFlag}
            </div>

            <div>
              <div class="stem-cell-main">${formatDb(s.samplePeakDbfs, 'dBFS')}</div>
              <div class="stem-cell-sub">TP ${formatDb(s.truePeakDbtp, 'dBTP')} · RMS ${formatDb(s.activeRmsDbfs, 'dB')}</div>
              ${clipFlag}
            </div>

            <div>
              <div class="stem-cell-main">${escapeHtml(s.stereoLabel)}</div>
              <div class="stem-cell-sub">${escapeHtml(dryDetail)}</div>
              ${dryFlag}
            </div>

            <div class="stem-row-actions">
              <button
                type="button"
                class="table-ms-btn ${st.mute ? 'active' : ''}"
                data-action="mute"
                data-stem-id="${escapeHtml(s.id)}"
                title="Mute stem"
                aria-pressed="${st.mute}"
              >M</button>
              <button
                type="button"
                class="table-ms-btn ${st.solo ? 'active' : ''}"
                data-action="solo"
                data-stem-id="${escapeHtml(s.id)}"
                title="Solo stem"
                aria-pressed="${st.solo}"
              >S</button>
              <button
                type="button"
                class="table-remove-btn"
                data-action="remove"
                data-stem-id="${escapeHtml(s.id)}"
                title="Remove stem from session"
                aria-label="Remove ${escapeHtml(s.filename)}"
              >×</button>
            </div>
          </div>

          <details class="stem-row-details">
            <summary class="micro">Technical Diagnostics &amp; Notes (${s.issues.length} note${s.issues.length === 1 ? '' : 's'})</summary>
            <div class="stem-detail-grid">
              <div><strong>Header Parsed:</strong> ${s.nativeHeader.parsed ? `Yes (${s.nativeHeader.container})` : 'Fallback (Web Audio)'}</div>
              <div><strong>Phase Corr:</strong> ${s.isNativeMono ? '+1.000 (Mono)' : s.phaseCorrelation.toFixed(3)}</div>
              <div><strong>DC Offset:</strong> ${s.dcOffset}</div>
              <div><strong>Tail Ratio:</strong> ${s.tailRatio}</div>
              <div><strong>Abrupt 0:00:</strong> ${s.startsAbruptlyAtZero ? 'Yes (transient in first 2ms)' : 'No'}</div>
              <div><strong>Clip Timestamps:</strong> ${s.clipTimestamps.length ? s.clipTimestamps.map((t) => formatTimePrecise(t)).join(', ') : 'None'}</div>
            </div>
            ${issuesListHtml}
          </details>
        </div>
      `;
    })
    .join('');
}

/* --------------------------------------------------------------------------
 * Multi-Track Synchronized Waveform Canvas
 * -------------------------------------------------------------------------- */

function getCanvasLogicalHeight() {
  const count = state.session ? state.session.stems.length : 1;
  return RULER_HEIGHT + Math.max(1, count) * LANE_HEIGHT;
}

function resizeAndDrawCanvas() {
  if (!state.session || state.session.stems.length === 0) return;
  const wrap = els.multitrackWrap;
  const canvas = els.multitrackCanvas;
  const cssW = Math.max(200, wrap.clientWidth || 720);
  const cssH = getCanvasLogicalHeight();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  wrap.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  drawMultitrackCanvas();
}

function drawMultitrackCanvas() {
  if (!state.session || state.session.stems.length === 0) return;

  const canvas = els.multitrackCanvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const stems = state.session.stems;
  const maxDur = Math.max(
    0.1,
    engine.maxDurationSec,
    ...stems.map((s) => s.durationSec)
  );
  const refDur = state.session.referenceDurationSec;
  const anySolo = engine.hasAnySolo();

  ctx.save();
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, width, height);

  // Top Ruler Strip
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  ctx.strokeStyle = '#2e2e2e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_HEIGHT - 0.5);
  ctx.lineTo(width, RULER_HEIGHT - 0.5);
  ctx.stroke();

  // Compute pleasant ruler interval (1s, 2s, 5s, 10s, 15s, 30s, 60s)
  const targetTicks = Math.max(4, Math.floor(width / 92));
  const rawStep = maxDur / targetTicks;
  const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const stepSec = niceSteps.find((s) => s >= rawStep) || Math.ceil(rawStep / 60) * 60;

  ctx.font = '700 10px "Courier New", ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';

  for (let t = 0; t <= maxDur + 0.001; t += stepSec) {
    const x = Math.min(width - 1, (t / maxDur) * width);
    // Vertical faint grid line across all lanes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();

    // Ruler tick
    ctx.strokeStyle = '#666666';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, RULER_HEIGHT - 6);
    ctx.lineTo(x + 0.5, RULER_HEIGHT);
    ctx.stroke();

    if (x < width - 34) {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillText(formatTime(t, maxDur < 15), x + 4, RULER_HEIGHT * 0.48);
    }
  }

  // Draw Each Stem Lane
  for (let idx = 0; idx < stems.length; idx += 1) {
    const stem = stems[idx];
    const topY = RULER_HEIGHT + idx * LANE_HEIGHT;
    const midY = topY + LANE_HEIGHT / 2;
    const st = engine.getStemState(stem.id);
    const muted = anySolo ? !st.solo : st.mute;

    // Alternating subtle row tint
    ctx.fillStyle = idx % 2 === 0 ? '#0d0d0d' : '#121212';
    ctx.fillRect(0, topY, width, LANE_HEIGHT);

    // Lane divider
    ctx.strokeStyle = '#252525';
    ctx.beginPath();
    ctx.moveTo(0, topY + LANE_HEIGHT - 0.5);
    ctx.lineTo(width, topY + LANE_HEIGHT - 0.5);
    ctx.stroke();

    // Center axis line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const stemEndX = Math.max(2, (stem.durationSec / maxDur) * width);

    // Hatched gap region if stem ends noticeably before maxDur
    if (stem.durationSec < maxDur - 0.15) {
      const gapW = width - stemEndX;
      ctx.save();
      ctx.beginPath();
      ctx.rect(stemEndX, topY, gapW, LANE_HEIGHT);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(stemEndX, topY, gapW, LANE_HEIGHT);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = 1;
      for (let hx = stemEndX - LANE_HEIGHT; hx < width + LANE_HEIGHT; hx += 10) {
        ctx.beginPath();
        ctx.moveTo(hx, topY + LANE_HEIGHT);
        ctx.lineTo(hx + LANE_HEIGHT, topY);
        ctx.stroke();
      }
      ctx.restore();

      // Stem actual end boundary line
      ctx.strokeStyle = stem.lengthStatus === 'fail' ? '#ff4f4f' : '#888888';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(stemEndX, topY + 2);
      ctx.lineTo(stemEndX, topY + LANE_HEIGHT - 2);
      ctx.stroke();
    }

    // Draw Waveform Bins scaled proportionally to stemEndX
    const peaks = stem.waveformPeaks || [];
    const clipFlags = stem.clipBinFlags || [];
    const binCount = peaks.length;
    if (binCount > 0) {
      const barW = Math.max(1, stemEndX / binCount);
      const maxAmpH = LANE_HEIGHT * 0.42;

      for (let b = 0; b < binCount; b += 1) {
        const amp = peaks[b];
        const x = (b / binCount) * stemEndX;
        const h = Math.max(1, amp * maxAmpH);
        const isClip = Boolean(clipFlags[b]);

        if (isClip) {
          ctx.fillStyle = muted ? 'rgba(255, 79, 79, 0.4)' : '#ff4f4f';
          ctx.fillRect(x, midY - h, Math.max(1.5, barW - 0.4), h * 2);
          // Crisp clip hazard tick at top edge of lane
          ctx.fillRect(x, topY + 2, Math.max(2, barW), 4);
        } else {
          if (muted) {
            ctx.fillStyle = 'rgba(180, 180, 180, 0.25)';
          } else if (stem.role === 'beat') {
            ctx.fillStyle = 'rgba(210, 210, 210, 0.72)';
          } else if (stem.stereoFxStatus === 'fail') {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
          } else {
            ctx.fillStyle = 'rgba(242, 242, 242, 0.85)';
          }
          ctx.fillRect(x, midY - h, Math.max(1, barW - 0.5), h * 2);
        }
      }
    }

    // Subtle badge overlay on canvas right if flagged
    if (stem.stereoFxStatus === 'fail') {
      ctx.fillStyle = 'rgba(16, 16, 16, 0.82)';
      ctx.fillRect(width - 116, topY + 6, 110, 16);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(width - 116, topY + 6, 110, 16);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('WET STEREO FX', width - 110, topY + 14);
    } else if (stem.looksSlicedNotZero) {
      ctx.fillStyle = 'rgba(16, 16, 16, 0.85)';
      ctx.fillRect(width - 112, topY + 6, 106, 16);
      ctx.strokeStyle = '#ff4f4f';
      ctx.lineWidth = 1;
      ctx.strokeRect(width - 112, topY + 6, 106, 16);
      ctx.fillStyle = '#ff8a8a';
      ctx.fillText('NOT FROM 0:00', width - 106, topY + 14);
    }
  }

  // Reference End Vertical Dashed Line
  if (refDur > 0 && refDur <= maxDur + 0.01) {
    const refX = Math.min(width - 1.5, (refDur / maxDur) * width);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(refX, RULER_HEIGHT);
    ctx.lineTo(refX, height);
    ctx.stroke();
    ctx.restore();
  }

  // Live Playhead
  const nowSec = engine.getCurrentTime();
  const playX = Math.max(0, Math.min(width, (nowSec / maxDur) * width));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(playX - 1, 0, 2, height);
  // Playhead triangle marker in ruler
  ctx.beginPath();
  ctx.moveTo(playX - 5, 0);
  ctx.lineTo(playX + 5, 0);
  ctx.lineTo(playX, 8);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // Update time readouts & slider aria
  els.deckTimeCurrent.textContent = formatTime(nowSec, true);
  els.deckTimeTotal.textContent = formatTime(maxDur, true);
  els.multitrackWrap.setAttribute('aria-valuemax', String(Math.round(maxDur * 10)));
  els.multitrackWrap.setAttribute('aria-valuenow', String(Math.round(nowSec * 10)));
}

function updateMetersUI() {
  const snap = engine.getMeterSnapshot();
  els.vuMeterL.style.height = `${snap.leftPct.toFixed(1)}%`;
  els.vuMeterR.style.height = `${snap.rightPct.toFixed(1)}%`;
  els.clipLedL.classList.toggle('clipping', snap.clippingL);
  els.clipLedR.classList.toggle('clipping', snap.clippingR);
}

function startAnimationLoop() {
  if (state.rafId) return;
  const tick = () => {
    drawMultitrackCanvas();
    updateMetersUI();
    if (engine.isPlaying) {
      state.rafId = requestAnimationFrame(tick);
    } else {
      state.rafId = null;
    }
  };
  state.rafId = requestAnimationFrame(tick);
}

function stopAnimationLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  updateMetersUI();
  drawMultitrackCanvas();
}

function updateTransportUI() {
  const playing = engine.isPlaying;
  els.studioDeck.dataset.state = playing ? 'playing' : 'paused';
  els.deckStatePill.textContent = playing ? 'PLAYING' : 'STANDBY';
  els.playBtnGlyph.textContent = playing ? '❚❚' : '▶';
  els.playBtnText.textContent = playing ? 'Pause' : 'Play All';

  const modeLabels = {
    stereo: 'STEREO MONITOR',
    mono: 'MONO SUM (L + R)',
    side: 'SIDE (L − R) · ISOLATES STEREO FX',
  };
  els.deckMonitorReadout.textContent = modeLabels[engine.monitorMode] || 'STEREO MONITOR';

  document.querySelectorAll('.monitor-matrix .deck-seg-btn').forEach((btn) => {
    const active = btn.dataset.monitor === engine.monitorMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

/* --------------------------------------------------------------------------
 * Playback Actions
 * -------------------------------------------------------------------------- */

async function togglePlayPause() {
  if (!state.session || state.session.stems.length === 0) return;
  if (engine.isPlaying) {
    engine.pause();
    updateTransportUI();
    stopAnimationLoop();
  } else {
    await engine.play();
    updateTransportUI();
    startAnimationLoop();
  }
}

async function restartFromZero() {
  if (!state.session || state.session.stems.length === 0) return;
  await engine.play(0);
  updateTransportUI();
  startAnimationLoop();
}

function setMonitorMode(mode) {
  engine.setMonitorMode(mode);
  updateTransportUI();
}

function toggleStemMute(id) {
  const st = engine.getStemState(id);
  engine.setMute(id, !st.mute);
  if (state.session) {
    renderDeckGutter(state.session);
    renderStemTable(state.session);
    drawMultitrackCanvas();
  }
}

function toggleStemSolo(id) {
  const st = engine.getStemState(id);
  engine.setSolo(id, !st.solo);
  if (state.session) {
    renderDeckGutter(state.session);
    renderStemTable(state.session);
    drawMultitrackCanvas();
  }
}

function changeStemRole(id, newRole) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  item.analysis.role = newRole;
  sortItemsOrder();
  runValidationAndRender();
  showToast(`Updated ${item.analysis.filename} role to ${ROLE_LABELS[newRole]}.`);
}

function removeStem(id) {
  const idx = state.items.findIndex((it) => it.id === id);
  if (idx === -1) return;
  const removed = state.items[idx];
  state.items.splice(idx, 1);
  engine.removeStem(id);
  runValidationAndRender();
  showToast(`Removed ${removed.analysis.filename}.`);
}

function clearSession() {
  engine.clearAll();
  state.items = [];
  state.session = null;
  els.errorsBanner.classList.add('hidden');
  runValidationAndRender();
  showToast('Session cleared.');
}

/* --------------------------------------------------------------------------
 * Export & Clipboard Actions
 * -------------------------------------------------------------------------- */

function exportMarkdownReport() {
  if (!state.session) return;
  const md = buildStemReportMarkdown(state.session);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stem-check-report-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Downloaded Stem Check audit report (.md).');
}

async function copyChecklistToClipboard() {
  if (!state.session) return;
  const lines = [
    `STEM CHECK VERDICT: ${state.session.verdict} (${state.session.summary.stemCount} stems · Ref ${formatTimePrecise(state.session.referenceDurationSec)})`,
    '',
    ...state.session.checklist.map((c) => {
      const tag = c.status === 'fail' ? '[FIX]' : c.status === 'warn' ? '[WARN]' : '[PASS]';
      const files = c.affectedFiles.length ? ` — ${c.affectedFiles.join(', ')}` : '';
      return `${tag} ${c.category}: ${c.title}${files}`;
    }),
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Copied checklist to clipboard.');
  } catch (_) {
    showToast('Clipboard access unavailable — use Export Report (.md).', true);
  }
}

/* --------------------------------------------------------------------------
 * Event Wiring
 * -------------------------------------------------------------------------- */

function wireEvents() {
  if (els.footerYear) {
    els.footerYear.textContent = String(new Date().getFullYear());
  }

  engine.onEnded = () => {
    updateTransportUI();
    stopAnimationLoop();
  };

  // File & Folder buttons
  els.btnSelectFiles.addEventListener('click', (e) => {
    e.stopPropagation();
    els.fileInput.click();
  });
  els.btnSelectFolder.addEventListener('click', (e) => {
    e.stopPropagation();
    els.folderInput.click();
  });
  els.btnLoadDemo.addEventListener('click', (e) => {
    e.stopPropagation();
    handleLoadDemoSession();
  });
  els.dropzoneClickTarget.addEventListener('click', () => {
    els.fileInput.click();
  });

  els.btnAddMoreFiles.addEventListener('click', () => els.fileInput.click());
  els.btnAddMoreFolder.addEventListener('click', () => els.folderInput.click());
  els.btnHeaderClear.addEventListener('click', clearSession);
  els.btnClearSession.addEventListener('click', clearSession);
  els.btnDismissErrors.addEventListener('click', () => els.errorsBanner.classList.add('hidden'));

  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) handleFileList(e.target.files);
    e.target.value = '';
  });
  els.folderInput.addEventListener('change', (e) => {
    if (e.target.files?.length) handleFileList(e.target.files);
    e.target.value = '';
  });

  // Drag & Drop (supports files & nested folders!)
  let dragDepth = 0;
  ['dragenter', 'dragover'].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === 'dragenter') dragDepth += 1;
      els.dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === 'dragleave') {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) els.dropzone.classList.remove('drag-over');
      } else {
        dragDepth = 0;
        els.dropzone.classList.remove('drag-over');
      }
    });
  });

  els.dropzone.addEventListener('drop', async (e) => {
    const files = await extractDroppedFiles(e.dataTransfer);
    if (files.length > 0) {
      await handleFileList(files);
    }
  });

  // Allow dropping anywhere on the page too once results are open
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    if (els.dropzone.contains(e.target)) return;
    e.preventDefault();
    const files = await extractDroppedFiles(e.dataTransfer);
    if (files.length > 0) {
      await handleFileList(files);
    }
  });

  // Export & Copy
  els.btnExportMd.addEventListener('click', exportMarkdownReport);
  els.btnCopyChecklist.addEventListener('click', copyChecklistToClipboard);

  // Transport controls
  els.btnPlayPause.addEventListener('click', togglePlayPause);
  els.btnRestart.addEventListener('click', restartFromZero);
  els.btnClearSolo.addEventListener('click', () => {
    engine.clearAllSoloMute();
    if (state.session) {
      renderDeckGutter(state.session);
      renderStemTable(state.session);
      drawMultitrackCanvas();
    }
  });

  els.volumeSlider.addEventListener('input', (e) => {
    engine.setVolume(parseFloat(e.target.value));
  });

  document.querySelectorAll('.monitor-matrix .deck-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMonitorMode(btn.dataset.monitor));
  });

  // Quick Audition Buttons
  els.btnJumpZero.addEventListener('click', restartFromZero);

  els.btnJumpFirstVox.addEventListener('click', async () => {
    if (!state.session) return;
    const vocals = state.session.stems.filter(
      (s) => s.role === 'vocal' && s.firstAudioSec != null
    );
    const earliest = vocals.length
      ? Math.min(...vocals.map((v) => v.firstAudioSec))
      : 0;
    await engine.play(Math.max(0, earliest - 0.15));
    updateTransportUI();
    startAnimationLoop();
  });

  els.btnJumpClip.addEventListener('click', async () => {
    if (!state.session) return;
    const clipStem = state.session.stems.find(
      (s) => s.clipTimestamps && s.clipTimestamps.length > 0
    );
    if (!clipStem) return;
    engine.soloExclusive(clipStem.id);
    setMonitorMode('stereo');
    renderDeckGutter(state.session);
    renderStemTable(state.session);
    const targetSec = Math.max(0, clipStem.clipTimestamps[0] - 0.25);
    await engine.play(targetSec);
    updateTransportUI();
    startAnimationLoop();
    showToast(`Soloed ${clipStem.filename} at clip (${formatTimePrecise(clipStem.clipTimestamps[0])}).`);
  });

  els.btnSoloWetSide.addEventListener('click', async () => {
    if (!state.session) return;
    const wetStem = state.session.stems.find(
      (s) => s.role === 'vocal' && (s.stereoFxStatus === 'fail' || s.stereoFxStatus === 'warn')
    );
    if (!wetStem) return;
    engine.soloExclusive(wetStem.id);
    setMonitorMode('side');
    renderDeckGutter(state.session);
    renderStemTable(state.session);
    const startAt = Math.max(0, (wetStem.firstAudioSec || 0) - 0.1);
    await engine.play(startAt);
    updateTransportUI();
    startAnimationLoop();
    showToast(`Soloed ${wetStem.filename} in SIDE (L−R) mode — listen for baked-in stereo reverb/FX!`);
  });

  // Delegated Mute / Solo buttons in Gutter
  els.multitrackGutter.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, stemId } = btn.dataset;
    if (action === 'mute') toggleStemMute(stemId);
    else if (action === 'solo') toggleStemSolo(stemId);
  });

  // Delegated Actions in Stem Audit Table
  els.stemTableBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, stemId } = btn.dataset;
    if (action === 'mute') toggleStemMute(stemId);
    else if (action === 'solo') toggleStemSolo(stemId);
    else if (action === 'remove') removeStem(stemId);
  });

  els.stemTableBody.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-action="role"]');
    if (!sel) return;
    changeStemRole(sel.dataset.stemId, sel.value);
  });

  // Multi-Track Canvas Scrubbing
  const scrubFromPointer = async (clientX) => {
    if (!state.session || engine.maxDurationSec <= 0) return;
    const rect = els.multitrackWrap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const targetSec = frac * engine.maxDurationSec;
    await engine.seek(targetSec);
    drawMultitrackCanvas();
  };

  els.multitrackWrap.addEventListener('pointerdown', async (e) => {
    state.isScrubbing = true;
    els.multitrackWrap.setPointerCapture?.(e.pointerId);
    await scrubFromPointer(e.clientX);
  });

  els.multitrackWrap.addEventListener('pointermove', async (e) => {
    if (!state.isScrubbing) return;
    await scrubFromPointer(e.clientX);
  });

  ['pointerup', 'pointercancel'].forEach((evt) => {
    els.multitrackWrap.addEventListener(evt, () => {
      state.isScrubbing = false;
    });
  });

  // Responsive Canvas Redraw
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resizeAndDrawCanvas());
    ro.observe(els.multitrackWrap);
  }
  window.addEventListener('resize', resizeAndDrawCanvas);

  // Keyboard Shortcuts
  window.addEventListener('keydown', async (e) => {
    if (!state.session || state.session.stems.length === 0) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      await togglePlayPause();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      await restartFromZero();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      setMonitorMode(engine.monitorMode === 'mono' ? 'stereo' : 'mono');
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      setMonitorMode(engine.monitorMode === 'side' ? 'stereo' : 'side');
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      await engine.seek(Math.max(0, engine.getCurrentTime() - 2));
      drawMultitrackCanvas();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      await engine.seek(Math.min(engine.maxDurationSec, engine.getCurrentTime() + 2));
      drawMultitrackCanvas();
    }
  });
}

wireEvents();
