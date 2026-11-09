// =============================================================================
// preload.js -- the safe "bridge" between the window and main.js.
//
// It runs just before the web page loads and exposes a small object,
// window.api, with only the functions the page needs. The page can call
// these, but it can't use Node.js or Electron directly.
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Buttons -> main.js
  startSession: () => ipcRenderer.send('start-session'),
  stopSession: () => ipcRenderer.send('stop-session'),
  analyzeLastMatch: () => ipcRenderer.send('analyze-last-match'),
  // the dropdown next to it: 'mine', 'mine_and_fights' or 'all' -- saved as "highlightMode" in settings.json
  setHighlightMode: (mode) => ipcRenderer.send('set-highlight-mode', mode),
  // clipIds: which rows, e.g. ['highlight1']; framing: 'native' or 'vertical'
  exportClips: (clipIds, framing) => ipcRenderer.send('export-clips', { clipIds, framing }),
  openClipsFolder: () => ipcRenderer.send('open-clips-folder'),
  // format: 'pdf' or 'docx' -- saves e.g. Mel_report.pdf / Mel_report.docx in the session folder
  saveReport: (format) => ipcRenderer.send('save-report', format),
  // the Open button next to the saved report
  openReportFile: () => ipcRenderer.send('open-report-file'),
  // the Retry button next to the "OBS:" line: ask OBS about its encoder again
  retryObs: () => ipcRenderer.send('obs-retry'),
  // the Attach video button: pick a session and a video file for it
  attachVideo: () => ipcRenderer.send('attach-video'),
  // the Clean up panel: ask for the list of _no_game, delete (main.js asks first) or restore
  cleanupList: () => ipcRenderer.send('cleanup-list'),
  cleanupDelete: (name) => ipcRenderer.send('cleanup-delete', name),
  cleanupDeleteAll: () => ipcRenderer.send('cleanup-delete-all'),
  cleanupRestore: (name) => ipcRenderer.send('cleanup-restore', name),

  // main.js -> page: new status text from the logger
  onStatus: (callback) => ipcRenderer.on('status', (_event, text) => callback(text)),

  // main.js -> page: whether a session is currently running (true/false)
  onRunning: (callback) => ipcRenderer.on('running', (_event, running) => callback(running)),

  // main.js -> page: whether "Analyze last match" is working right now (true/false)
  onAnalyzing: (callback) => ipcRenderer.on('analyzing', (_event, analyzing) => callback(analyzing)),
  // main.js -> page: the highlight mode in settings.json, for the dropdown
  onHighlightMode: (callback) => ipcRenderer.on('highlight-mode', (_event, mode) => callback(mode)),
  // main.js -> page: whether "Attach video" is working right now (true/false)
  onAttaching: (callback) => ipcRenderer.on('attaching', (_event, attaching) => callback(attaching)),

  // main.js -> page: what is in _no_game ({ folder, items, totalBytes, retentionDays, error? })
  onCleanupList: (callback) => ipcRenderer.on('cleanup-list', (_event, list) => callback(list)),

  // main.js -> page: the clips that can be exported (null = none to show)
  onClips: (callback) => ipcRenderer.on('clips', (_event, list) => callback(list)),
  // main.js -> page: whether clips are being exported right now (true/false)
  onExporting: (callback) => ipcRenderer.on('exporting', (_event, exporting) => callback(exporting)),
  // main.js -> page: how far the export is ({ fraction: 0 to 1, text })
  onExportProgress: (callback) => ipcRenderer.on('export-progress', (_event, progress) => callback(progress)),
  // main.js -> page: the export is over ({ files, failed, cancelled, folderExists })
  onExportDone: (callback) => ipcRenderer.on('export-done', (_event, result) => callback(result)),
  // main.js -> page: whether a report file is being made right now (true/false)
  onReportSaving: (callback) => ipcRenderer.on('report-saving', (_event, saving) => callback(saving)),
  // main.js -> page: a report file was made ({ file }) or couldn't be ({ error })
  onReportSaved: (callback) => ipcRenderer.on('report-saved', (_event, result) => callback(result)),

  // main.js -> page: text for the four status lines above the text area
  onObsStatus: (callback) => ipcRenderer.on('obs-status', (_event, text) => callback(text)),
  // main.js -> page: the colour of the "OBS:" line: 'loading', 'ready', 'error' or '' (none)
  onObsState: (callback) => ipcRenderer.on('obs-state', (_event, state) => callback(state)),
  // main.js -> page: show (true) or hide (false) the Retry button next to the "OBS:" line
  onObsRetryShown: (callback) => ipcRenderer.on('obs-retry-shown', (_event, shown) => callback(shown)),
  onGameStatus: (callback) => ipcRenderer.on('game-status', (_event, text) => callback(text)),
  onVideoPath: (callback) => ipcRenderer.on('video-path', (_event, text) => callback(text)),
  onSessionFolder: (callback) => ipcRenderer.on('session-folder', (_event, text) => callback(text)),
});
