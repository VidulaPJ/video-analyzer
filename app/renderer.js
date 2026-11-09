// =============================================================================
// renderer.js -- the code behind the buttons in index.html.
// It talks to main.js only through window.api (defined in preload.js).
// =============================================================================

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const analyzeBtn = document.getElementById('analyze');
const modeSelect = document.getElementById('highlight-mode');
const attachBtn = document.getElementById('attach');
const output = document.getElementById('output');
const obsStatus = document.getElementById('obs-status');
const obsRetryBtn = document.getElementById('obs-retry');
const gameStatus = document.getElementById('game-status');
const videoPath = document.getElementById('video-path');
const sessionFolder = document.getElementById('session-folder');

// Add text to the bottom of the text area and scroll down to show it.
function appendOutput(text) {
  output.value += text;
  output.scrollTop = output.scrollHeight;
}

startBtn.addEventListener('click', () => {
  output.value = ''; // clear old output for the new session
  videoPath.textContent = '-'; // and the last session's video path
  sessionFolder.textContent = '-'; // and its folder
  window.api.startSession();
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true; // prevent double clicks while it's saving
  window.api.stopSession();
});

analyzeBtn.addEventListener('click', () => {
  window.api.analyzeLastMatch();
});

// The highlight mode: main.js saves it in settings.json.
modeSelect.addEventListener('change', () => {
  window.api.setHighlightMode(modeSelect.value);
});

obsRetryBtn.addEventListener('click', () => {
  window.api.retryObs();
});

attachBtn.addEventListener('click', () => {
  window.api.attachVideo();
});

// Messages coming from main.js
window.api.onStatus(appendOutput);
window.api.onObsStatus((text) => { obsStatus.textContent = text; });
// The colour of the "OBS:" line (see the .value.ready / .loading / .error styles in index.html).
window.api.onObsState((state) => { obsStatus.className = state ? `value ${state}` : 'value'; });
window.api.onObsRetryShown((shown) => { obsRetryBtn.hidden = !shown; });
window.api.onGameStatus((text) => { gameStatus.textContent = text; });
window.api.onVideoPath((text) => { videoPath.textContent = text; });
window.api.onSessionFolder((text) => { sessionFolder.textContent = text; });
window.api.onHighlightMode((mode) => { modeSelect.value = mode; });

// ---- The list of clips to export --------------------------------------------
const clipsPanel = document.getElementById('clips');
const clipRows = document.getElementById('clip-rows');
const clipsWarning = document.getElementById('clips-warning');
const exportAllBtn = document.getElementById('export-all');
const openFolderBtn = document.getElementById('open-folder');
const progressRow = document.getElementById('progress-row');
const exportProgress = document.getElementById('export-progress');
const exportText = document.getElementById('export-text');
const clipsTable = document.querySelector('.clips-table');
const savePdfBtn = document.getElementById('save-pdf');
const saveDocxBtn = document.getElementById('save-docx');
const reportRow = document.getElementById('report-row');
const reportPath = document.getElementById('report-path');
const openReportBtn = document.getElementById('open-report');

// What the window knows at the moment. The Export buttons only work when
// nothing else is going on.
let sessionRunning = false; // a session is being recorded
let analyzingNow = false;   // "Analyze last match" is working
let exportingNow = false;   // clips are being cut
let canExport = false;      // the list has clips in it and the video is there
let shownClips = [];        // the rows being shown
let noVideoShown = false;   // the rows are from a session with no video: game times only, nothing to export
let reportExists = false;   // the session shown has a report.json, so it can be saved as PDF / Word
let savingReport = false;   // a report file is being made
let attachingNow = false;   // "Attach video" is working

// Grey out (or bring back) every button, according to the facts above.
function updateButtons() {
  const exportOff = sessionRunning || analyzingNow || exportingNow || attachingNow || !canExport;
  exportAllBtn.disabled = exportOff;
  for (const button of clipRows.querySelectorAll('button')) button.disabled = exportOff;
  for (const radio of document.querySelectorAll('input[name="framing"]')) radio.disabled = exportingNow;
  analyzeBtn.disabled = analyzingNow || exportingNow || attachingNow;
  modeSelect.disabled = analyzingNow; // the analysis already running uses the mode it started with
  // Not during a session: it rewrites its own session.json all the time.
  attachBtn.disabled = sessionRunning || analyzingNow || exportingNow || attachingNow;
  startBtn.disabled = sessionRunning || attachingNow;
  // Saving the report needs no video, only report.json, so it works with no video too.
  const reportOff = analyzingNow || savingReport || !reportExists;
  savePdfBtn.disabled = reportOff;
  saveDocxBtn.disabled = reportOff;
  const reportWhy = !reportExists ? 'This session has no report.json yet - click "Analyze last match" first' : '';
  savePdfBtn.title = reportWhy;
  saveDocxBtn.title = reportWhy;
  // Why the buttons are grey, shown when the mouse rests on one.
  let why = '';
  if (noVideoShown) why = 'This session has no video, so there is nothing to cut clips from';
  else if (sessionRunning) why = 'Not while a session is running: encoding would slow the game and the recording';
  exportAllBtn.title = why;
  for (const button of clipRows.querySelectorAll('button')) button.title = noVideoShown ? why : '';
  // Clean up: nothing is deleted while a session is recording (main.js checks this again).
  const deleteOff = sessionRunning || attachingNow;
  const deleteWhy = deleteOff ? 'Not while a session is running or a video is being attached' : '';
  cleanupDeleteAllBtn.disabled = deleteOff || cleanupDeletable === 0;
  cleanupDeleteAllBtn.title = deleteWhy;
  for (const button of cleanupRows.querySelectorAll('button.danger')) {
    button.disabled = deleteOff || button.dataset.kept === 'yes';
    button.title = button.dataset.kept === 'yes' ? 'On the "noGameKeep" list in settings.json, so it is never deleted' : deleteWhy;
  }
}

// Which framing is chosen right now: 'native' or 'vertical'.
function chosenFraming() {
  return document.querySelector('input[name="framing"]:checked').value;
}

function startExport(clipIds) {
  openFolderBtn.hidden = true;
  window.api.exportClips(clipIds, chosenFraming());
}

// Fill the table: one row per highlight and review moment. `list` is what
// listClips in export.js made, or null when there is nothing to show.
window.api.onClips((list) => {
  clipRows.textContent = '';
  shownClips = list ? list.clips : [];
  canExport = Boolean(list && list.videoExists && shownClips.length > 0);
  reportExists = Boolean(list && list.reportExists);
  clipsPanel.classList.toggle('shown', shownClips.length > 0 || reportExists);
  clipsTable.classList.toggle('empty', shownClips.length === 0);
  progressRow.classList.remove('shown');
  openFolderBtn.hidden = true;
  // A report this session already has (saved earlier, or report.pdf/.docx in
  // an older session) gets its Open button straight away.
  const savedReport = list && list.reportFile;
  reportRow.classList.toggle('shown', Boolean(savedReport));
  reportPath.className = '';
  reportPath.textContent = savedReport ? `Saved earlier: ${savedReport}` : '';
  openReportBtn.hidden = !savedReport;

  // The yellow line above the table: why Export is off, or that the clips will be choppy.
  noVideoShown = Boolean(list && shownClips.length > 0 && !list.videoFile);
  const videoGone = Boolean(list && list.videoFile && !list.videoExists);
  const choppy = Boolean(list && list.choppy);
  let warning = '';
  if (noVideoShown) {
    warning = 'No video was recorded for this session. These moments are listed with game times only, and Export is switched off.';
  } else if (videoGone) {
    warning = `Export is switched off: the video is not there any more (${list.videoFile}).`;
  } else if (choppy) {
    warning = `Warning: OBS skipped ${list.skippedFramePercent}% of this video's frames, so the clips will look choppy.`;
  }
  clipsWarning.classList.toggle('shown', warning !== '');
  clipsWarning.textContent = warning;

  for (const clip of shownClips) {
    const row = document.createElement('tr');
    row.dataset.clipId = clip.id;
    const cells = [clip.label, clip.who || '-', clip.title, clip.gameTime, clip.videoTime,
      clip.durationSeconds === null ? '-' : `${clip.clipStart} - ${clip.clipEnd} (${clip.durationSeconds}s)`];
    cells.forEach((text, i) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (i === 1) cell.className = 'who';
      if (i === 2) cell.className = 'title';
      row.appendChild(cell);
    });
    const button = document.createElement('button');
    button.textContent = 'Export';
    button.addEventListener('click', () => startExport([clip.id]));
    const buttonCell = document.createElement('td');
    buttonCell.appendChild(button);
    row.appendChild(buttonCell);
    clipRows.appendChild(row);
  }
  updateButtons();
});

exportAllBtn.addEventListener('click', () => startExport(shownClips.map((clip) => clip.id)));
openFolderBtn.addEventListener('click', () => window.api.openClipsFolder());

// ---- Save the report as PDF or Word -----------------------------------------
savePdfBtn.addEventListener('click', () => window.api.saveReport('pdf'));
saveDocxBtn.addEventListener('click', () => window.api.saveReport('docx'));
openReportBtn.addEventListener('click', () => window.api.openReportFile());

window.api.onReportSaving((saving) => {
  savingReport = saving;
  if (saving) {
    reportRow.classList.add('shown');
    reportPath.className = '';
    reportPath.textContent = 'Saving the report...';
    openReportBtn.hidden = true;
  }
  updateButtons();
});

window.api.onReportSaved((result) => {
  reportRow.classList.add('shown');
  reportPath.className = result.error || result.warning ? 'error' : '';
  reportPath.textContent = result.error || `Saved: ${result.file}${result.warning ? ` - ${result.warning}` : ''}`;
  openReportBtn.hidden = Boolean(result.error);
});

window.api.onExporting((exporting) => {
  exportingNow = exporting;
  if (exporting) {
    progressRow.classList.add('shown');
    exportProgress.value = 0;
    exportText.textContent = 'Starting...';
  }
  updateButtons();
});

window.api.onExportProgress((progress) => {
  exportProgress.value = progress.fraction;
  exportText.textContent = progress.text;
});

window.api.onExportDone((result) => {
  const made = `${result.files} file${result.files === 1 ? '' : 's'} saved`;
  const failed = result.failed > 0 ? `, ${result.failed} clip${result.failed === 1 ? '' : 's'} failed (see below)` : '';
  exportText.textContent = result.cancelled ? `Stopped - ${made}` : `Done - ${made}${failed}`;
  if (!result.cancelled && result.failed === 0) exportProgress.value = 1;
  openFolderBtn.hidden = !result.folderExists;
});

// Asking Claude takes a little while: no second click until it has answered.
window.api.onAnalyzing((analyzing) => {
  analyzingNow = analyzing;
  updateButtons();
});

window.api.onAttaching((attaching) => {
  attachingNow = attaching;
  updateButtons();
});

// ---- Clean up: the sessions with no game, in _no_game -----------------------
const cleanupBtn = document.getElementById('cleanup-btn');
const cleanupPanel = document.getElementById('cleanup');
const cleanupSummary = document.getElementById('cleanup-summary');
const cleanupEmpty = document.getElementById('cleanup-empty');
const cleanupTable = document.getElementById('cleanup-table');
const cleanupRows = document.getElementById('cleanup-rows');
const cleanupDeleteAllBtn = document.getElementById('cleanup-delete-all');
const cleanupCloseBtn = document.getElementById('cleanup-close');
let cleanupDeletable = 0; // how many items in the list may be deleted (not on the keep list)

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// A date as "2026-10-24 15:07".
function shortDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

cleanupBtn.addEventListener('click', () => {
  cleanupPanel.classList.add('shown');
  cleanupSummary.textContent = 'Looking in _no_game...';
  window.api.cleanupList();
});
cleanupCloseBtn.addEventListener('click', () => cleanupPanel.classList.remove('shown'));
cleanupDeleteAllBtn.addEventListener('click', () => window.api.cleanupDeleteAll());

// Fill the Clean up table. `list` is what listNoGame in no_game.js made.
window.api.onCleanupList((list) => {
  cleanupRows.textContent = '';
  const items = list.items || [];
  cleanupDeletable = items.filter((item) => !item.kept).length;
  const auto = list.retentionDays ? `deleted automatically ${list.retentionDays} days after being moved there` : 'NOT deleted automatically (see noGameRetentionDays in settings.json)';
  cleanupSummary.textContent = list.error
    ? `Couldn't look in ${list.folder}: ${list.error}`
    : `${list.folder}: ${items.length} item${items.length === 1 ? '' : 's'}, ${megabytes(list.totalBytes)} in all - ${auto}.`;
  cleanupEmpty.style.display = items.length === 0 && !list.error ? 'block' : 'none';
  cleanupTable.classList.toggle('empty', items.length === 0);

  for (const item of items) {
    const row = document.createElement('tr');
    let autoText = 'never (only by hand)';
    if (item.kept) autoText = 'never (on the keep list)';
    else if (item.deleteAfterMs) autoText = shortDate(item.deleteAfterMs);
    const cells = [item.name, item.sessionDate || '-', megabytes(item.sizeBytes), item.reason, autoText];
    cells.forEach((text, i) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (i === 3) cell.className = 'reason';
      row.appendChild(cell);
    });
    const buttonCell = document.createElement('td');
    const restore = document.createElement('button');
    restore.textContent = 'Restore';
    restore.title = 'Move it back into the sessions folder';
    restore.addEventListener('click', () => window.api.cleanupRestore(item.name));
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.className = 'danger';
    remove.dataset.kept = item.kept ? 'yes' : 'no';
    remove.addEventListener('click', () => window.api.cleanupDelete(item.name));
    buttonCell.append(restore, ' ', remove);
    row.appendChild(buttonCell);
    cleanupRows.appendChild(row);
  }
  updateButtons();
});

window.api.onRunning((running) => {
  sessionRunning = running;
  stopBtn.disabled = !running;
  updateButtons();
});
