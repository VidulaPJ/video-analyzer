// =============================================================================
// main.js -- the "main process" of the Electron app.
//
// Electron apps have two sides:
//   - The MAIN process (this file): plain Node.js. It creates windows and can
//     do anything Node can, like starting other programs.
//   - The RENDERER process (index.html + renderer.js): a web page shown in the
//     window. For safety it can't touch Node.js directly; it asks the main
//     process to do things through preload.js.
//
// A "session" here means: OBS is recording the screen while live_logger.js
// records what happens in the game. Starting a session starts both; ending it
// (Stop button, game over, or the waiting timeout) stops both.
// =============================================================================

// ---- Never crash because the console has gone away ---------------------------
// If the app was started by another program (a terminal, Claude Code...) and
// that program has since closed, the app's console output ("stdout" and
// "stderr") leads into a pipe nobody reads any more. Writing to it then fails
// with EPIPE ("broken pipe"). Nobody can see that output anyway, so the error
// is ignored. This comes first in the file, so it is in place before anything
// else can write to the console.
const isBrokenPipe = (err) => Boolean(err) && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED');
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', (err) => {
      if (!isBrokenPipe(err)) reportUnexpectedError(err, 'console output');
    });
  }
}

// Any other error that nothing caught would normally close the app with a
// crash dialog. Instead it is written to app\app_errors.log and shown in the
// window, and the app carries on. A broken pipe is ignored, as above.
process.on('uncaughtException', (err) => {
  if (!isBrokenPipe(err)) reportUnexpectedError(err, 'uncaught exception');
});

// Errors that happen before the window can show them wait here (see createWindow).
const errorsBeforeWindow = [];

// Where the error log goes: the project's app folder (next to settings.json),
// for `npm start` and for the built .exe alike. If that can't be worked out,
// the app's own data folder.
function errorLogPath() {
  const path = require('path');
  try {
    const { app: electronApp } = require('electron');
    const projectDir = electronApp.isPackaged ? require('./project-path.json').projectDir : path.join(__dirname, '..');
    return path.join(projectDir, 'app', 'app_errors.log');
  } catch (err) {
    return path.join(require('electron').app.getPath('userData'), 'app_errors.log');
  }
}

// Write the error to the log file and show it in the window. This must never
// throw, and never write to the console: that may be the very thing that broke.
function reportUnexpectedError(err, kind) {
  const details = err && err.stack ? err.stack : String(err);
  let logFile = '(the log file could not be written)';
  try {
    const file = errorLogPath();
    require('fs').appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${details}\n\n`, 'utf8');
    logFile = file;
  } catch (writeErr) {
    // nowhere left to write it: the window message below still says what happened
  }
  const message = `\n[UNEXPECTED ERROR inside the app (${kind}): ${err && err.message ? err.message : String(err)}. ` +
    `The app did not close. Details were saved to: ${logFile}. If something stops working, close the app and start it again.]\n`;
  try {
    if (typeof win !== 'undefined' && win && !win.isDestroyed() && !win.webContents.isLoading()) {
      sendToWindow('status', message);
    } else {
      errorsBeforeWindow.push(message);
    }
  } catch (showErr) {
    errorsBeforeWindow.push(message); // `win` doesn't exist yet: show it once the window is ready
  }
}

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { fork, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises; // the same file functions, but they don't freeze the window while they work
const path = require('path');
const obs = require('./obs'); // our own obs.js, in this folder
const game = require('./game'); // our own game.js, in this folder
const processes = require('./processes'); // our own processes.js, in this folder
const analyze = require('./analyze'); // our own analyze.js, in this folder
const report = require('./report'); // our own report.js, in this folder
const exporter = require('./export'); // our own export.js, in this folder ("export" alone is a reserved word)
const reportExport = require('./report_export'); // our own report_export.js: the report as PDF and Word
const timeCheck = require('./time_check'); // our own time_check.js: no moment may have two different video times
const endStats = require('./end_stats'); // our own end_stats.js: the League client's end-of-game numbers
const monitor = require('./resource_monitor'); // our own resource_monitor.js: resource_log.csv while waiting for a game
const noGame = require('./no_game'); // our own no_game.js: sessions with no game go to _no_game, and are deleted later

const STOP_TIMEOUT_MS = 5000; // force-kill the logger if it hasn't exited by then
const LOGGER_STARTUP_MS = 5000;     // a logger that fails within this long of starting "crashed at startup"
const LOGGER_STARTUP_RETRIES = 1;   // how many times to start it again when that happens
const LOGGER_RETRY_DELAY_MS = 1000; // how long to wait before starting it again
const FFPROBE_TIMEOUT_MS = 15000; // give up measuring the video's length after this long
const GAME_LOOKUP_TRIES = 20;       // how many times to ask the game for your champion and the mode
const GAME_LOOKUP_RETRY_MS = 3000;  // how long to wait between those tries
const FILE_BUSY_TRIES = 5;          // how many times to retry a move/rename if Windows says "in use"
const FILE_BUSY_RETRY_MS = 500;     // how long to wait between those tries
const RELEASE_WAIT_TRIES = 120;     // the same, while waiting for OBS to let go of the video (about 60 seconds in all)
const LEFTOVER_RETRY_MS = 10000;    // how often to retry putting OBS's recording folder back when OBS can't be reached
const QUIT_NOW_RESTORE_MS = 5000;   // when quitting in a hurry, give OBS this long to take its recording folder back
const OBS_WAIT_REMINDER_MS = 60000; // while a session waits for OBS: how often to say what is known about it

// The two ways a session's video can end up in the session folder (saved in
// session.json as "recordingMethod" and shown in the window):
const RECORD_INTO_FOLDER = 'recorded-into-session-folder'; // OBS writes it there directly
const MOVE_AFTER_STOP = 'moved-after-stop';                // OBS writes it to its usual folder; we move it afterwards
const GAME_PROCESS_CHECK_MS = 2000; // how often to ask Windows whether the game is running, while waiting
const FILE_AGE_SLACK_MS = 2000;     // some drives only store a file's creation time to the nearest 2 seconds
const RECORD_DIR_TRIES = 2;         // SetRecordDirectory: the first try, plus one retry if OBS reports another folder
const SAME_START_SLACK_MS = 10000;  // Attach video: a video that starts within this long of the session's own start time is that recording
// The kinds of file OBS (and most other recorders) save videos as.
const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'flv', 'ts', 'm4v', 'webm', 'avi'];

// Where the project (and live_logger.js) lives.
//  - `npm start`: the folder above this one.
//  - the built .exe: the folder saved by save_project_path.js at build time.
const PROJECT_DIR = app.isPackaged
  ? require('./project-path.json').projectDir
  : path.join(__dirname, '..');
const LOGGER_PATH = path.join(PROJECT_DIR, 'live_logger.js');

// The settings file is always read from the project's app folder (even by the
// built .exe), so you can edit it without rebuilding and the OBS password
// never gets baked into the .exe.
const SETTINGS_PATH = path.join(PROJECT_DIR, 'app', 'settings.json');
// The .env file in the project folder holds the Anthropic API key that
// "Analyze last match" needs. Like the settings, it is never baked into the .exe.
const ENV_PATH = path.join(PROJECT_DIR, '.env');
const DEFAULT_SETTINGS = {
  obsPassword: '',
  obsPath: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  waitTimeoutSeconds: 300,          // end the session if no game starts within this long
  gameProcessName: 'League of Legends.exe', // the game itself (not the client you queue up in)
  sessionsRoot: 'F:\\ME\\sessions', // each session gets its own folder in here
  noGameRetentionDays: 7,           // a session with no game is moved to <sessionsRoot>\_no_game, and deleted after this many days
  noGameKeep: [],                   // session folder names that are never deleted from _no_game, e.g. ["2026-10-23_15-21_no-game"]
  playerName: 'VDRJ',               // your in-game name without the #tag: whose highlights "Analyze last match" looks for
  highlightMode: analyze.DEFAULT_HIGHLIGHT_MODE, // which moments are picked: "mine", "mine_and_fights" or "all" (the dropdown next to Analyze)
  maxClips: analyze.DEFAULT_MAX_CLIPS,           // never more highlight clips than this
  minClips: analyze.DEFAULT_MIN_CLIPS,           // fewer qualify: the best are borrowed from the next level up
  maxClipSeconds: analyze.DEFAULT_MAX_CLIP_SECONDS, // no clip is longer than this
};

let win = null;       // the app window
let logger = null;    // the running logger child process (null when not running)
let session = null;   // the current session (null when none is running)
let waitTimer = null; // the once-a-second "still waiting for a game" timer

// A copy of what the window is showing, so it can be saved as
// session_output.txt at the end of a session:
let outputText = '';  // everything in the big text area
const statusLines = { // the latest text of the four lines above it
  'obs-status': 'Not connected',
  'game-status': '-',
  'video-path': '-',
  'session-folder': '-',
};

// ---- Messages to the window -------------------------------------------------
// Each of these sends one kind of update; preload.js passes it on to renderer.js.
function sendToWindow(channel, value) {
  if (channel === 'status') outputText += value;
  else if (channel in statusLines) statusLines[channel] = value;
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

const sendStatus = (text) => sendToWindow('status', text);          // a line for the text area
const sendRunning = (running) => sendToWindow('running', running);  // true/false, for the buttons
const sendGameStatus = (text) => sendToWindow('game-status', text); // the "Game:" line
const sendVideoPath = (text) => sendToWindow('video-path', text);   // the "Video:" line
const sendSessionFolder = (text) => sendToWindow('session-folder', text); // the "Folder:" line

// ---- The "OBS:" line --------------------------------------------------------
// The line shows one of two things:
//  - normally, what the background check in obs.js knows about OBS:
//    "Loading... 01:12", then "Ready" in green, or what is wrong in red;
//  - once a session has something to say about its recording ("Recording",
//    "Stopping...", "Not recording - ..."), that, until the session is over.
// `state` picks the colour in the window: 'loading', 'ready', 'error' or ''.
let sessionOwnsObsLine = false; // true while the line shows a session's recording
let shownObsLine = '';          // what the line shows now, so the same thing isn't sent every second

function showObsLine(text, state) {
  if (shownObsLine === `${state}|${text}`) return;
  shownObsLine = `${state}|${text}`;
  sendToWindow('obs-status', text);
  sendToWindow('obs-state', state);
}

// The Retry button next to the "OBS:" line: shown (true) or hidden (false).
let shownObsRetry = false;
function showObsRetry(shown) {
  if (shownObsRetry === shown) return;
  shownObsRetry = shown;
  sendToWindow('obs-retry-shown', shown);
}

// Used by the session for news about its recording.
function sendObsStatus(text, state = '') {
  sessionOwnsObsLine = true;
  showObsRetry(false);
  showObsLine(text, state);
}

// Is the encoder OBS records with all right? `found` is what
// obs.getRecordingEncoder() returned. Returns:
//   'missing'  -> no recording encoder is chosen at all
//   'reset'    -> one is chosen, but OBS didn't load it this time, so OBS has reset the choice
//   'software' -> x264 or a software AV1 encoder (uses the processor: may be choppy)
//   'fine'     -> a hardware encoder (NVENC, QuickSync, AMF), or one we don't know
function encoderVerdict(found) {
  if (found.kind === 'none') return 'missing';
  if (found.loadedInObs === false) return 'reset';
  if (found.kind === 'software') return 'software';
  return 'fine';
}

// While no session is running and OBS is ready, the "OBS:" line also says which
// encoder OBS records with, so a problem shows up BEFORE Start session is clicked.
let idleEncoder = null;         // { found } or { error } once OBS has been asked; null = ask again
let idleEncoderChecking = false; // true while OBS is being asked

function checkEncoderWhileIdle() {
  if (idleEncoderChecking) return;
  idleEncoderChecking = true;
  obs.getRecordingEncoder()
    .then((found) => { idleEncoder = { found }; })
    .catch((err) => { idleEncoder = { error: err.message }; })
    .finally(() => {
      idleEncoderChecking = false;
      showObsWatch();
    });
}

// The "OBS:" line when OBS is ready and no session is running.
function showReadyWithEncoder() {
  if (!idleEncoder) {
    checkEncoderWhileIdle();
    showObsLine('Ready - checking which encoder OBS records with...', 'ready');
    showObsRetry(false);
    return;
  }
  if (idleEncoder.error) {
    showObsLine(`Ready, but OBS couldn't be asked which encoder it records with (${idleEncoder.error})`, 'error');
    showObsRetry(true);
    return;
  }
  const found = idleEncoder.found;
  const verdict = encoderVerdict(found);
  if (verdict === 'missing') {
    showObsLine('No recording encoder is selected in OBS. In OBS open Settings > Output > Recording, ' +
      'choose a Video Encoder, then click Retry.', 'error');
  } else if (verdict === 'reset') {
    showObsLine(`No recording encoder is selected in OBS: it was set to ${found.label}, but that didn't load ` +
      'when OBS started, so OBS reset it. Restart OBS or choose another encoder, then click Retry.', 'error');
  } else if (verdict === 'software') {
    showObsLine(`Ready - records with ${found.label}, a software encoder, so the video may be choppy. ` +
      'Choose NVENC, QuickSync or AMF in OBS, then click Retry.', 'loading');
  } else {
    showObsLine(`Ready - records with ${found.label}`, 'ready');
  }
  showObsRetry(verdict !== 'fine');
}

// Show what the background check knows. Called once a second (for the
// loading clock) and whenever something changes.
function showObsWatch() {
  if (sessionOwnsObsLine) return;
  const watch = obs.getState();
  if (watch.state !== 'ready') idleEncoder = null; // ask again once OBS is ready (again)
  if (!(watch.state === 'ready' && !session)) showObsRetry(false);
  const clock = formatClock(watch.loadingMs);
  const waiting = session && session.waitingForObs ? ' - recording starts as soon as OBS answers' : '';
  if (watch.state === 'ready' && !session && outsideRecordingNow) {
    showObsLine('Ready, but OBS is recording something this app did not start - stop it in OBS before ' +
      'starting a session (you can add it to a session afterwards with "Attach video")', 'loading');
    showObsRetry(false);
  } else if (watch.state === 'ready' && !session) {
    showReadyWithEncoder();
  } else if (watch.state === 'ready') {
    showObsLine('Ready', 'ready');
  } else if (watch.state === 'loading') {
    showObsLine(`Loading... ${clock}${waiting}`, 'loading');
  } else if (watch.state === 'not-running') {
    showObsLine(`Not running${watch.reason ? ` (${watch.reason})` : ''} - it is started when you click Start session`, 'error');
  } else if (watch.state === 'error') {
    showObsLine(`${watch.reason}. Still trying... ${clock}`, 'error');
  } else {
    showObsLine('Checking...', 'loading');
  }
}

// ---- Recordings this app did not start --------------------------------------
// If you start a recording in OBS yourself, it isn't a session's video, but
// it shouldn't go unnoticed either: warn, and once it has stopped, say where
// the file is so it can be added to a session with "Attach video".
let outsideRecordingNow = false; // true while OBS is recording something this app didn't start
let lastOutsideRecording = null; // { file, stoppedAt } of the newest such recording that finished

function onOutsideRecording(news) {
  const bar = '='.repeat(70);
  const state = news.event ? news.event.outputState : null;
  if (news.kind === 'already-recording' || state === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
    outsideRecordingNow = true;
    const how = news.kind === 'already-recording'
      ? 'OBS WAS ALREADY RECORDING when this app connected to it'
      : 'OBS STARTED A RECORDING that this app did not ask for';
    sendStatus(`\n${bar}\n` +
      `WARNING: ${how} (you, another program, or a recording this app lost track of when the connection to OBS dropped).\n` +
      'It is not treated as a session\'s video. When it stops, this window shows its file, and you can add it\n' +
      'to a session with "Attach video".\n' +
      `${bar}\n\n`);
  } else if (state === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
    outsideRecordingNow = false;
    const file = news.event.outputPath ? path.normalize(news.event.outputPath) : null;
    lastOutsideRecording = { file, stoppedAt: wallClock() };
    sendStatus(`[The recording this app did not start has stopped. ${file ? `Its file: ${file}` : 'OBS did not say where it saved it.'} ` +
      'To use it as a session\'s video, click "Attach video".]\n');
    if (session) {
      session.info.outsideRecordings.push(lastOutsideRecording);
      saveSessionInfo(session);
    }
  } else {
    return; // "starting" and "stopping" add nothing to the two messages above
  }
  showObsWatch();
}

// Start the background check on OBS (see keepConnected in obs.js). Called
// once, when the window is ready to show messages.
function startObsWatch() {
  obs.onOutsideRecording(onOutsideRecording);
  obs.keepConnected(loadSettings(), {
    // OBS is started when the app opens; after that, only for a session that is waiting for it.
    wantsLaunch: () => Boolean(session && session.waitingForObs),
    onChange: () => {
      // While a session waits for a game, every change in OBS's state goes into resource_log.csv too.
      const watch = obs.getState();
      monitor.event(`OBS state: ${watch.state}${watch.reason ? ` (${watch.reason})` : ''}`);
      showObsWatch();
    },
    onLaunch: ({ obsPath, flags, deletedMarkers }) => {
      monitor.event('OBS launched by this app');
      sendStatus(`[OBS was not running - started it: "${obsPath}" ${flags.join(' ')}]\n`);
      if (deletedMarkers.length > 0) {
        sendStatus('[OBS was not closed properly last time. Its leftover "still running" marker was deleted first, ' +
          'so that it doesn\'t stop at its Safe Mode question.]\n');
      }
    },
  });
  setInterval(showObsWatch, 1000);
}

// ---- Small helpers ----------------------------------------------------------

// Pause for a given number of milliseconds. Use it as: await sleep(1000);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A real-world time in two formats, the same way live_logger.js stores them:
//  - iso:   precise and standard, in UTC, e.g. "2026-09-27T18:50:03.123Z"
//  - local: easy to read, in your own time zone
function wallClock(date = new Date()) {
  return { iso: date.toISOString(), local: date.toLocaleString() };
}

// Turn milliseconds into a clock like "01:23".
function formatClock(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// The built .exe unpacks itself into a temporary folder every time it starts,
// and the logger is started as a second copy of the program from that folder.
// If the folder gets emptied while the app is open, this window carries on
// (it loaded its files already) but nothing new can be started from it.
// Returns the names of the files that have gone missing ([] if all is well).
function missingAppFiles() {
  if (!app.isPackaged) return []; // `npm start` runs from node_modules, not a temporary folder
  const exeDir = path.dirname(process.execPath);
  const needed = [
    path.join(exeDir, 'icudtl.dat'),
    path.join(exeDir, 'resources.pak'),
    path.join(exeDir, 'v8_context_snapshot.bin'),
    path.join(__dirname, 'logger_runner.js'),
  ];
  return needed.filter((file) => !fs.existsSync(file)).map((file) => path.basename(file));
}

function missingAppFilesMessage(missing) {
  return `[The app's own files have been deleted from its temporary folder while it was open (missing: ${missing.join(', ')}).]\n` +
    `[Folder: ${path.dirname(process.execPath)}]\n` +
    '[Close this window and start VideoAnalyzer.exe again.]\n';
}

// Windows crash codes are huge numbers that are only recognisable in
// hexadecimal, e.g. 2147483651 is 0x80000003. Show both for those.
function describeExitCode(code) {
  if (typeof code === 'number' && code > 0xFFFF) return `${code} (0x${code.toString(16).toUpperCase()})`;
  return String(code);
}

// Read settings.json. Anything missing or invalid falls back to the default.
function loadSettings() {
  let saved = {};
  try {
    // Some editors (like older Notepad) put an invisible marker character at
    // the very start of the file, which JSON.parse can't read - remove it.
    let text = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    saved = JSON.parse(text);
  } catch (err) {
    sendStatus(`[Couldn't read ${SETTINGS_PATH} (${err.message}) - using default settings]\n`);
  }

  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!settings.obsPath) settings.obsPath = DEFAULT_SETTINGS.obsPath;
  if (!settings.sessionsRoot) settings.sessionsRoot = DEFAULT_SETTINGS.sessionsRoot;
  if (!settings.playerName || typeof settings.playerName !== 'string') settings.playerName = DEFAULT_SETTINGS.playerName;
  if (!settings.gameProcessName || typeof settings.gameProcessName !== 'string') {
    settings.gameProcessName = DEFAULT_SETTINGS.gameProcessName;
  }

  // Deleting is where a typing mistake could cost you a session, so anything
  // odd switches the automatic deleting off (null): when in doubt, keep.
  //  - noGameRetentionDays must be a whole number, 1 or more, without quotes.
  //  - noGameKeep must be a list of folder names; if it isn't, the names it
  //    was meant to protect are unknown, so nothing is deleted automatically.
  settings.noGameRetentionDays = noGame.retentionDaysFrom(saved.noGameRetentionDays);
  if (settings.noGameRetentionDays === null) {
    sendStatus('["noGameRetentionDays" in settings.json must be a whole number of days, 1 or more (without quotes) - ' +
      'nothing in _no_game is deleted automatically until it is fixed]\n');
  }
  if (!Array.isArray(settings.noGameKeep) || !settings.noGameKeep.every((name) => typeof name === 'string')) {
    sendStatus('["noGameKeep" in settings.json must be a list of folder names, like ["2026-10-23_15-21_no-game"] - ' +
      'nothing in _no_game is deleted automatically until it is fixed]\n');
    settings.noGameKeep = [];
    settings.noGameRetentionDays = null;
  }

  // The highlight settings. A wrong value is said once and the default used.
  if (!analyze.HIGHLIGHT_MODES.includes(settings.highlightMode)) {
    sendStatus(`["highlightMode" in settings.json must be one of ${analyze.HIGHLIGHT_MODES.map((m) => `"${m}"`).join(', ')} - ` +
      `using "${DEFAULT_SETTINGS.highlightMode}"]\n`);
    settings.highlightMode = DEFAULT_SETTINGS.highlightMode;
  }
  if (!(Number.isInteger(settings.maxClips) && settings.maxClips >= 1)) {
    sendStatus(`["maxClips" in settings.json must be a whole number, 1 or more (without quotes) - using ${DEFAULT_SETTINGS.maxClips}]\n`);
    settings.maxClips = DEFAULT_SETTINGS.maxClips;
  }
  if (!(Number.isInteger(settings.minClips) && settings.minClips >= 0 && settings.minClips <= settings.maxClips)) {
    const fallback = Math.min(DEFAULT_SETTINGS.minClips, settings.maxClips);
    sendStatus(`["minClips" in settings.json must be a whole number from 0 to maxClips (${settings.maxClips}) - using ${fallback}]\n`);
    settings.minClips = fallback;
  }
  // A clip needs room for its lead-in and lead-out (10 + 8 s) and a little of the fight.
  if (!(typeof settings.maxClipSeconds === 'number' && settings.maxClipSeconds >= 20)) {
    sendStatus(`["maxClipSeconds" in settings.json must be a number of seconds, 20 or more - using ${DEFAULT_SETTINGS.maxClipSeconds}]\n`);
    settings.maxClipSeconds = DEFAULT_SETTINGS.maxClipSeconds;
  }

  // The waiting timeout, in seconds. An older settings.json may still give it
  // in minutes (waitTimeoutMinutes), which is used if there are no seconds.
  // We work it out in milliseconds, plus a readable label for messages.
  let seconds = Number(saved.waitTimeoutSeconds);
  if (!(seconds > 0)) seconds = Number(saved.waitTimeoutMinutes) * 60;
  if (!(seconds > 0)) seconds = DEFAULT_SETTINGS.waitTimeoutSeconds;
  settings.waitTimeoutMs = seconds * 1000;
  settings.waitTimeoutLabel = `${seconds} seconds`;
  return settings;
}

// ---- Session info -----------------------------------------------------------
// Each session gets a small file, session.json, in its own session folder. It
// records when the OBS recording was started, which is what lets you line the
// video up with the game log later, and where the session's files are.
function saveSessionInfo(s = session) {
  try {
    fs.writeFileSync(s.infoFile, JSON.stringify(s.info, null, 2), 'utf8');
  } catch (err) {
    sendStatus(`[Couldn't save session info: ${err.message}]\n`);
  }
}

// Save everything the window is showing as session_output.txt in the session
// folder: the four status lines first, then the whole text area.
function saveSessionOutput(s) {
  const file = path.join(s.folder, 'session_output.txt');
  sendStatus(`[Saving everything shown in this window to: ${file}]\n`);
  const header =
    `OBS:    ${statusLines['obs-status']}\n` +
    `Game:   ${statusLines['game-status']}\n` +
    `Video:  ${statusLines['video-path']}\n` +
    `Folder: ${statusLines['session-folder']}\n\n`;
  try {
    fs.writeFileSync(file, header + outputText, 'utf8');
  } catch (err) {
    sendStatus(`[Couldn't save session_output.txt: ${err.message}]\n`);
  }
}

// ---- Remembering OBS's own recording folder ---------------------------------
// During a session we point OBS's recording folder at the session folder, and
// afterwards we point it back. If this app crashes or the PC loses power in
// between, OBS would be left recording into an old session folder for ever.
// So BEFORE changing the folder we write the original one down in a small
// file, and delete that file once the folder has been put back. If the file
// exists when no session is running, something went wrong last time and the
// folder still needs putting back.
//
// The file lives in the app's own data folder, which Electron provides:
// C:\Users\<you>\AppData\Roaming\videoanalyzer-app
const RECORD_DIR_STATE_PATH = path.join(app.getPath('userData'), 'obs_record_directory.json');

// Returns what was written down, or null if there is nothing (usable) there.
function readSavedRecordDirectory() {
  try {
    const saved = JSON.parse(fs.readFileSync(RECORD_DIR_STATE_PATH, 'utf8'));
    return typeof saved.originalRecordDirectory === 'string' && saved.originalRecordDirectory ? saved : null;
  } catch (err) {
    return null; // no file (the normal case), or it can't be read
  }
}

// Throws if the file can't be written - the caller must then NOT change OBS's folder.
function saveRecordDirectory(originalRecordDirectory, sessionFolder) {
  fs.mkdirSync(path.dirname(RECORD_DIR_STATE_PATH), { recursive: true });
  const saved = { originalRecordDirectory, sessionFolder, savedAt: wallClock() };
  fs.writeFileSync(RECORD_DIR_STATE_PATH, JSON.stringify(saved, null, 2), 'utf8');
}

function forgetSavedRecordDirectory() {
  try {
    fs.unlinkSync(RECORD_DIR_STATE_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') sendStatus(`[Couldn't delete ${RECORD_DIR_STATE_PATH}: ${err.message}]\n`);
  }
}

// Something went wrong earlier and OBS's recording folder was never put back.
// Put it back now, over a short connection of its own. If OBS can't be reached
// (it may simply not be open), keep trying quietly every few seconds. While a
// session is running this does nothing: the session puts the folder back
// itself as soon as it has connected to OBS (see pointObsAtSessionFolder).
let leftoverRestore = null; // a Promise for the attempt that is under way, if any
let leftoverTimer = null;   // the timer for the next attempt

function restoreLeftoverRecordDirectory(settings = null) {
  clearTimeout(leftoverTimer);
  if (session) return;
  const saved = readSavedRecordDirectory();
  if (!saved) return;

  const firstTry = !settings;
  if (firstTry) {
    settings = loadSettings();
    sendStatus(`[OBS's recording folder was left pointing at a session folder (${saved.sessionFolder}). ` +
      `Setting it back to ${saved.originalRecordDirectory}...]\n`);
  }
  leftoverRestore = obs.setRecordDirectoryOnce(settings, saved.originalRecordDirectory)
    .then(() => {
      forgetSavedRecordDirectory();
      sendStatus(`[OBS's recording folder was set back to: ${saved.originalRecordDirectory}]\n`);
    })
    .catch((err) => {
      if (firstTry) {
        sendStatus(`[Couldn't reach OBS to set it back (${err.message}). This app will keep trying every ` +
          `${LEFTOVER_RETRY_MS / 1000} seconds while it is open, and when the next session starts.]\n`);
      }
      leftoverTimer = setTimeout(() => restoreLeftoverRecordDirectory(settings), LEFTOVER_RETRY_MS);
    });
}

// Ask ffprobe (a tool that comes with ffmpeg) how long a video file is.
// Returns the length in seconds, e.g. 1834.567. Throws if ffprobe isn't
// installed or can't read the file.
//   -v error                    -> print nothing except real errors
//   -show_entries format=duration -> we only want the duration
//   -of default=...             -> print just the number, with no label
function getVideoDuration(videoFile) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoFile];
    execFile('ffprobe', args, { windowsHide: true, timeout: FFPROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      const seconds = Number(stdout.trim());
      if (!(seconds >= 0) || stdout.trim() === '') {
        return reject(new Error(`unexpected ffprobe output "${stdout.trim()}"`));
      }
      resolve(seconds);
    });
  });
}

// ---- Session folder ---------------------------------------------------------
// Every session gets one folder inside "sessionsRoot" (see settings.json):
//
//   2026-10-08_17-54\            <- created when you click Start session
//     session.json               <- the session info
//     2026-10-08 17-54-03.mp4    <- the video, written here by OBS itself, under OBS's own name
//     live_log.json              <- moved here when the logger exits
//     session_output.txt         <- everything the window showed, saved at the very end
//
// At the very end the folder is renamed to say what was in it, for example
// 2026-10-08_17-54_Kalista_ARAM_Loss, or 2026-10-08_17-54_no-game. A session
// with no game is then moved into <sessionsRoot>\_no_game (see moveSessionIfNoGame).

// Build a folder name from a date, in your own time zone, e.g. "2026-10-08_17-54".
// Windows doesn't allow ":" in names, so the time uses "-" instead.
function makeSessionFolderName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}-${pad(date.getMinutes())}`;
  return `${datePart}_${timePart}`;
}

// If a folder with this name already exists (say, two sessions started in the
// same minute), add _2, _3, ... so we never write into an existing folder.
function freeFolderPath(wanted) {
  if (!fs.existsSync(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted}_${n}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// Make a piece of text safe to use in a Windows folder name. Windows doesn't
// allow < > : " / \ | ? * or invisible control characters, and a name can't
// end with a dot or a space. Each bad character becomes "-".
function safeName(text) {
  const cleaned = String(text)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || 'Unknown';
}

// Run a file operation, trying again a few times if Windows says the file is
// in use. That happens for a moment when another program (OBS, an antivirus
// scan) still has the file open.
const isBusyError = (err) => ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);

// onBusy(err), if given, is called once: the first time Windows says "in use".
async function retryWhileBusy(operation, tries = FILE_BUSY_TRIES, onBusy = null) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isBusyError(err) || attempt >= tries) throw err;
      if (attempt === 1 && onBusy) onBusy(err);
      await sleep(FILE_BUSY_RETRY_MS);
    }
  }
}

// Are these two the same file or folder? Windows doesn't care about capital
// letters in paths, and OBS writes "F:/a/b" where Windows writes "F:\a\b";
// path.resolve irons out the slashes.
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Copy a file and check the copy is the same size as the original. It refuses
// to replace a file that is already at the destination. If anything goes
// wrong, a half-made copy is deleted again (so it can't be mistaken for the
// video later) and the error is passed on; the original is never touched.
async function copyFileChecked(from, to) {
  try {
    // COPYFILE_EXCL means "fail instead of overwriting an existing file".
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const [original, copy] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
    if (original.size !== copy.size) {
      throw new Error(`the copy is not the same size as the original (${copy.size} instead of ${original.size} bytes), ` +
        'so the original was left in place');
    }
  } catch (err) {
    // EEXIST: the file at the destination was already there before - it isn't ours to delete.
    if (err.code !== 'EEXIST') await fsp.unlink(to).catch(() => {});
    throw err;
  }
}

// Move a file. It refuses to replace a file that is already at the
// destination, so nothing can ever be overwritten.
//  - Normally Windows just relabels the file, which is instant. If Windows
//    says the file is in use we try again, `tries` times.
//  - If that can't work - the file is on a different drive (error code
//    EXDEV), or Windows kept saying "in use" to the very end - we fall back
//    to the slow way: copy it, check the copy is the same size, and only then
//    delete the original. If the copy goes wrong the original stays put.
// Returns how it was done:
//   method       -> 'moved' or 'copied'
//   whyCopied    -> for 'copied': why the quick way wasn't possible
//   originalLeft -> for 'copied': why the original couldn't be deleted (null if it was)
async function moveFile(from, to, tries = FILE_BUSY_TRIES) {
  if (fs.existsSync(to)) throw new Error(`"${to}" already exists`);
  let whyCopied;
  try {
    await retryWhileBusy(() => fsp.rename(from, to), tries);
    return { method: 'moved' };
  } catch (err) {
    if (err.code === 'EXDEV') whyCopied = 'it was on a different drive';
    else if (isBusyError(err)) whyCopied = `Windows kept refusing to move it (${err.message})`;
    else throw err;
  }

  await copyFileChecked(from, to);
  let originalLeft = null;
  try {
    await retryWhileBusy(() => fsp.unlink(from));
  } catch (err) {
    originalLeft = err.message; // the copy is good, so carry on with it
  }
  return { method: 'copied', whyCopied, originalLeft };
}

// Move one of the session's files into the session folder.
//   infoKey     -> which entry of session.json holds the file's path ('videoFile' or 'logFile')
//   originalKey -> where to remember the path it had before the move
//   newName     -> the file's name inside the session folder
//   label       -> what to call it in messages
//   tries       -> how many times to retry if Windows says the file is in use
// Returns what moveFile returned, or null if there was nothing to move or the
// move failed - in which case we say why and the file simply stays where it was.
async function moveIntoSessionFolder(s, infoKey, originalKey, newName, label, tries = FILE_BUSY_TRIES) {
  const from = s.info[infoKey];
  if (!from) return null; // there is no such file this session (e.g. no game, so no log)

  const to = path.join(s.folder, newName);
  try {
    const result = await moveFile(from, to, tries);
    s.info[originalKey] = from;
    s.info[infoKey] = to;
    saveSessionInfo(s);
    if (result.method === 'moved') {
      sendStatus(`[Moved the ${label} to: ${to}]\n`);
    } else {
      const original = result.originalLeft
        ? `but the original could not be deleted (${result.originalLeft}) - it is still at ${from}`
        : 'and the original was deleted';
      sendStatus(`[Copied the ${label} to: ${to} because ${result.whyCopied}. ` +
        `The copy was checked to be the same size, ${original}]\n`);
    }
    return result;
  } catch (err) {
    sendStatus(`[Couldn't move the ${label} into the session folder: ${err.message}. It is still at ${from}]\n`);
    return null;
  }
}

// Rename the session folder to say what was in it, then fix the paths in
// session.json, which would otherwise still point at the old folder name.
//
// The video is inside this folder now, and Windows refuses to rename a folder
// while any program has a file in it open. So this must only be called after
// OBS has fully stopped. Even then OBS (or an antivirus scan of the new
// video) can hold on for a moment longer, so we keep trying for about 60
// seconds. If it still fails, the folder just keeps its plain name.
async function renameSessionFolder(s) {
  let suffix = 'no-game';
  if (s.gameStarted) {
    // The mode goes in under its readable name, e.g. "ARAM Mayhem" rather than "KIWI".
    const { champion, mode, result } = s.info.game;
    suffix = [champion, game.modeName(mode), result].map((part) => safeName(part || 'Unknown')).join('_');
  }

  const oldFolder = s.folder;
  const newFolder = freeFolderPath(`${oldFolder}_${suffix}`);
  const seconds = (RELEASE_WAIT_TRIES * FILE_BUSY_RETRY_MS) / 1000;
  try {
    await retryWhileBusy(() => fsp.rename(oldFolder, newFolder), RELEASE_WAIT_TRIES, (err) => {
      sendStatus(`[The session folder can't be renamed yet (${err.message}) - ` +
        `trying again for up to ${seconds} seconds...]\n`);
    });
  } catch (err) {
    const why = isBusyError(err)
      ? `after trying for ${seconds} seconds a program still had a file in it open, most likely OBS with the video (${err.message})`
      : err.message;
    sendStatus(`[Couldn't rename the session folder to ${path.basename(newFolder)}: ${why}. ` +
      `It keeps the name ${oldFolder}]\n`);
    return;
  }
  sendStatus(`[Renamed the session folder to: ${newFolder}]\n`);

  // The files moved along with the folder, so update every path that was inside it.
  for (const key of ['videoFile', 'logFile']) {
    if (s.info[key] && samePath(path.dirname(s.info[key]), oldFolder)) {
      s.info[key] = path.join(newFolder, path.basename(s.info[key]));
    }
  }
  s.folder = newFolder;
  s.info.sessionFolder = newFolder;
  s.infoFile = path.join(newFolder, 'session.json');
}

// ---- Game details (for the folder name) -------------------------------------

// Called when a game is detected: ask the game which champion you're playing
// and the mode. The game can take a moment to have the answers, so we try a
// few times. This runs in the background while the session carries on.
async function lookUpGameDetails(s) {
  for (let attempt = 1; attempt <= GAME_LOOKUP_TRIES && !s.ended; attempt++) {
    try {
      const details = await game.getLiveDetails();
      if (s.ended) return;
      // Keep whatever we learned, without wiping an earlier answer with "unknown".
      for (const key of ['playerName', 'champion', 'mode']) {
        if (details[key]) s.info.game[key] = details[key];
      }
      // "mode" stays the game's own code (e.g. "KIWI"); "modeName" is the
      // readable version of it (e.g. "ARAM Mayhem"), which is what we show.
      s.info.game.modeName = game.modeName(s.info.game.mode);
      if (s.info.game.champion && s.info.game.mode) {
        saveSessionInfo(s);
        sendGameStatus(`In progress - ${s.info.game.champion} (${s.info.game.modeName})`);
        sendStatus(`[Playing ${s.info.game.champion} - mode: ${s.info.game.modeName}]\n`);
        return;
      }
    } catch (err) {
      // the game didn't answer this time - try again below
    }
    await sleep(GAME_LOOKUP_RETRY_MS);
  }
}

// Called at the end of a session that had a game: read the result (and the
// champion, if we still don't know it) from the log the logger saved.
function readGameDetailsFromLog(s) {
  if (!s.info.logFile) return;
  try {
    const details = game.readLogDetails(s.info.logFile, s.info.game.playerName);
    s.info.game.result = details.result;
    if (!s.info.game.champion) s.info.game.champion = details.champion;
    saveSessionInfo(s);
  } catch (err) {
    sendStatus(`[Couldn't read the game result from the log: ${err.message}]\n`);
  }
}

// ---- Start session ----------------------------------------------------------
async function startSession() {
  if (session) return; // already running
  if (attaching) {
    sendStatus('[A video is being attached - finish or cancel that first, then start the session.]\n');
    return;
  }
  const startedAt = new Date(); // the moment of the click

  // Cutting clips keeps the processor and graphics card busy, which would
  // slow the game and the recording: an export under way is stopped.
  if (exporting) exporter.cancelExport();

  // The window clears itself when Start is clicked (see renderer.js), so our
  // copy of what it shows starts afresh too.
  outputText = '';
  statusLines['video-path'] = '-';
  statusLines['session-folder'] = '-';
  sessionOwnsObsLine = false; // the "OBS:" line shows the background check again
  showObsWatch();

  if (!fs.existsSync(LOGGER_PATH)) {
    sendStatus(`[Can't find live_logger.js at ${LOGGER_PATH}]\n` +
      '[If you moved the project folder, run "npm run build" again in the app folder.]\n');
    return;
  }

  // Without these the logger can't start, so don't record a session for nothing.
  const missing = missingAppFiles();
  if (missing.length > 0) {
    sendStatus(`${missingAppFilesMessage(missing)}[The session was not started.]\n`);
    return;
  }

  const settings = loadSettings();

  // Create this session's folder. "recursive" also creates sessionsRoot itself
  // the first time. If the folder can't be made (for example the drive isn't
  // plugged in), don't start: better to find out now than after a game.
  const folder = freeFolderPath(path.join(settings.sessionsRoot, makeSessionFolderName(startedAt)));
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    sendStatus(`[Couldn't create the session folder ${folder} (${err.message})]\n` +
      '[Check "sessionsRoot" in settings.json. The session was not started.]\n');
    return;
  }

  session = {
    folder,               // this session's folder (renamed at the very end)
    infoFile: path.join(folder, 'session.json'),
    settings,             // the settings as they were when the session started
    startedAtMs: startedAt.getTime(), // when Start session was clicked, as a number of milliseconds
    obsSetup: null,       // a Promise that finishes when the OBS setup is over, whether it worked or not
    waitingForObs: false, // true while the session is waiting for OBS to become ready
    waitedForObs: false,  // true if it had to wait at all (the recording then starts late)
    gameDetectedAtMs: null, // when the logger first saw a game, as a number of milliseconds
    recording: false,     // true while OBS is recording for this session
    obsOriginalDirectory: null, // OBS's own recording folder, while it still has to be put back
    gameStarted: false,   // true once the logger has seen a game
    stopRequested: false, // true once something has asked the session to end
    ended: false,         // true once the session has started wrapping up
    loggerCrashed: false, // true if the logger crashed at startup, even after a retry
    loggerOutput: '',     // an unfinished line of logger output (see watchLoggerOutput)
    // Facts collected for the "may this empty recording be deleted?" decision:
    loggerStarts: 0,           // how many times the logger was started (more than 1 = it had to be retried)
    loggerExitCode: undefined, // the exit code of the logger that ran last (0 = finished normally)
    loggerForceKilled: false,  // true if we had to force the logger to close
    loggerError: null,         // set if the logger process reported an error
    gameProcessSeen: false,    // true once the game process has been seen running
    gameProcessCheckFailed: false, // true if we couldn't ask Windows about the game process
    // This part is what gets written to the session info file:
    info: {
      sessionStartedAt: wallClock(startedAt),
      sessionFolder: folder,      // this session's folder
      obsRecordStartSentAt: null, // wall-clock time StartRecord was sent to OBS
      obsRecordingActuallyStartedAt: null, // wall-clock time OBS said it was really recording
      obsRecordingStartedLateSeconds: null, // if the session had to wait for OBS: seconds from the Start session click to the recording really starting
      obsReadySeconds: null,      // how long OBS took to load before it answered (0 = it answered at the app's very first try)
      obsVideoEncoder: null,      // the video encoder OBS is set to record with, e.g. "obs_nvenc_h264_tex"
      obsVideoEncoderName: null,  // a readable name for it, e.g. "NVIDIA NVENC H.264"
      obsVideoEncoderVerdict: null, // 'fine', 'software', 'missing' or 'reset' (see encoderVerdict)
      obsVideoEncoderInUse: null, // the encoder's name in OBS's log once the recording started, e.g. "obs-nvenc"
      obsWebSocketChecks: [],     // what we found each time we looked at an OBS that wasn't answering yet
      secondsToGameDetected: null, // seconds from the Start session click to the first game detection
      recordingMethod: null,      // how the video gets into the session folder (see RECORD_INTO_FOLDER / MOVE_AFTER_STOP)
      recordingMethodReason: null, // if the video has to be moved afterwards: why
      obsOriginalRecordDirectory: null, // OBS's own recording folder, as it was before this session
      obsRecordDirectoryRestored: null, // true once it was put back; false if that failed
      obsRecordDirectoryAtStart: null, // the recording folder OBS reported just before StartRecord
      obsReportedFileAtStart: null, // the file OBS said it started writing (only some OBS versions say)
      videoFile: null,            // the full path of the video
      videoFileFoundBy: null,     // how we know that path: 'RecordStateChanged event', 'StopRecord reply' or 'searched for it'
      originalVideoFile: null,    // where OBS first saved it, if we had to move it
      videoDurationSeconds: null, // how long the saved video is, measured by ffprobe
      obsStopSeconds: null,       // seconds from StopRecord until OBS had finished writing the video
      obsSkippedFramePercent: null, // how many of the video's frames OBS skipped because encoding couldn't keep up (from OBS's log)
      noGame: null,               // for a session with no game: { reason } and either movedTo (_no_game) or keptBecause
      outsideRecordings: [],      // recordings this app did NOT start that finished during the session
      attachedVideo: null,        // filled in if a video was added later with the Attach video button
      logFile: null,              // where the game log is now
      originalLogFile: null,      // where the logger first saved it, before we moved it
      game: null,                 // champion, mode and result, if a game was detected
      sessionEndedAt: null,
      endReason: null,
    },
  };
  // session.done is a Promise that finishes when the session has fully ended
  // (logger exited AND recording stopped). stopSession() hands it out.
  session.done = new Promise((resolve) => { session.resolveDone = resolve; });

  saveSessionInfo(); // session.json exists from the very start
  sendSessionFolder(folder);
  sendStatus(`[Session started]\n[Session folder: ${folder}]\n`);
  sendRunning(true);
  showClips(null); // the list of clips belongs to an older session: put it away

  // Start the logger and the OBS setup at the same time. The logger is running
  // from this very moment; the OBS setup (which waits for OBS for as long as
  // it needs if OBS is still loading) carries on in the background. Note there
  // is no "await" in front of startObsRecording: we don't wait for it here.
  // endSession() waits for it instead, so a recording is never left running.
  obs.updateSettings(settings); // the background check uses the settings just read
  // resource_log.csv: how busy the PC is from now until a game is detected
  // (see resource_monitor.js). It stops in watchLoggerOutput, stopSession or endSession.
  monitor.start(folder);
  monitor.event('Start session clicked', startedAt);
  monitor.event(`OBS state when the session started: ${obs.getState().state}`);
  startLogger();
  startWaitTimer(session);
  session.obsSetup = startObsRecording(session);
}

// Start recording as soon as OBS is ready. If OBS is still loading when the
// session starts, the logger is already running; this waits in the background
// for as long as the session lasts and starts the recording the moment OBS
// answers. It only stops without a recording if the session ends first, or if
// OBS answers but can't record (we then say why and carry on, so the game
// still gets logged without video). This function never throws.
async function startObsRecording(s) {
  // If the session is ending there is no point in starting a recording.
  const isCancelled = () => s.stopRequested || s.ended;
  try {
    for (;;) {
      await waitForObs(s, isCancelled);
      try {
        await recordWithObs(s, isCancelled);
        return;
      } catch (err) {
        // If it failed because OBS went away again (it was closed, or it
        // crashed), go back to waiting for it. Anything else is a real "no".
        if (isCancelled() || s.recording || obs.isReady()) throw err;
        sendStatus(`[OBS stopped answering before the recording could start (${err.message}) - waiting for it again.]\n`);
      }
    }
  } catch (err) {
    // No recording was started, so if OBS's folder was changed, put it back now.
    await restoreObsRecordDirectory(s);
    obs.forgetRecordWaits();
    if (isCancelled()) {
      sendStatus('[OBS: the session ended before OBS was ready, so no recording was started.]\n');
    } else {
      sendObsStatus('Not recording - see the message below', 'error');
      sendStatus(`[OBS: ${err.message}]\n[Continuing without video - the game is still being logged.]\n`);
    }
  }
}

// Wait until OBS is ready, for as long as the session runs. While waiting,
// say what is actually known about OBS: at once, and then every minute.
// Throws only if the session ends first.
async function waitForObs(s, isCancelled) {
  if (obs.isReady()) return;
  s.waitingForObs = true;
  s.waitedForObs = true;
  obs.lookSoon(); // if OBS isn't running, start it now rather than in a few seconds
  showObsWatch();
  sendStatus('[OBS is not ready yet. The game is being logged from now; the recording starts by itself as soon as ' +
    'OBS answers. This app keeps trying for as long as the session runs.]\n');

  const report = async (when) => {
    const check = await obs.checkWhyNoAnswer(when);
    if (s.waitingForObs && !obs.isReady()) reportObsWait(s, check); // OBS may have answered while we were looking
  };
  report('Start session was clicked').catch(() => {});
  const reminder = setInterval(() => report('still waiting').catch(() => {}), OBS_WAIT_REMINDER_MS);
  try {
    await obs.whenReady(isCancelled);
  } finally {
    clearInterval(reminder);
    s.waitingForObs = false;
  }
}

// OBS is ready: check the encoder, point OBS at the session folder and start
// the recording. Throws an Error with a readable message if no recording was
// started.
async function recordWithObs(s, isCancelled) {
  const cancelled = () => new Error('The session ended before OBS was ready, so no recording was started.');
  if (isCancelled()) throw cancelled();

  const watch = obs.getState();
  s.info.obsReadySeconds = watch.readySeconds;
  saveSessionInfo(s);
  monitor.event(`OBS ready (took ${watch.readySeconds} seconds to load) - setting up the recording`);
  if (s.waitedForObs) {
    sendStatus(`[OBS is ready. It took ${formatClock(watch.readySeconds * 1000)} to load` +
      `${watch.startedByApp ? ' (counted from when this app started it)' : ''}.]\n`);
  }

  // If OBS is in the middle of some other recording, leave it completely alone.
  if (await obs.isRecording()) {
    throw new Error('OBS is already recording something else, so this session gets no video of its own ' +
      'and OBS\'s recording folder was not touched. Stop that recording in OBS before starting a session. ' +
      'When it stops, this window shows its file, and you can add it to this session with "Attach video".');
  }

  // Warn now, before the recording starts, if the video is likely to be choppy.
  await checkVideoEncoder(s);

  // Make OBS record straight into the session folder (or decide to move the
  // video afterwards instead, if this OBS can't do that).
  await pointObsAtSessionFolder(s);
  if (isCancelled()) throw cancelled();

  // The function we pass in runs a moment later, when OBS confirms the
  // recording is really running (see startRecord in obs.js). That moment is
  // where the video begins, which is what "Analyze last match" lines the game
  // up with - however late it is.
  const sentAt = await obs.startRecord((actuallyStartedAt, event) => {
    monitor.event('StartRecord confirmed by OBS (the recording really started)', actuallyStartedAt);
    s.info.obsRecordingActuallyStartedAt = wallClock(actuallyStartedAt);
    // Some versions of OBS say which file they have started writing. If they
    // do, check now that it is in the session folder, not only at the end.
    if (event && event.outputPath) {
      s.info.obsReportedFileAtStart = path.normalize(event.outputPath);
      if (!samePath(path.dirname(s.info.obsReportedFileAtStart), s.folder)) {
        sendStatus(`[WARNING: OBS is writing the video to ${s.info.obsReportedFileAtStart}, NOT into the session folder. ` +
          'It will be moved into the session folder once the recording has stopped.]\n');
      }
    }
    saveSessionInfo(s);
    sendStatus(`[OBS confirmed the recording actually started at ${s.info.obsRecordingActuallyStartedAt.local}]\n`);
    reportLateStart(s, actuallyStartedAt);
    confirmEncoderInUse(s);
  });

  s.recording = true;
  monitor.event('StartRecord sent to OBS', sentAt);
  s.info.obsRecordStartSentAt = wallClock(sentAt);
  saveSessionInfo(s); // save right away, in case something crashes later
  const verdict = s.info.obsVideoEncoderVerdict;
  if (verdict === 'missing' || verdict === 'reset') {
    sendObsStatus('Recording, but no recording encoder is selected in OBS - see the message below', 'error');
  } else {
    sendObsStatus(`Recording${s.info.obsVideoEncoderName ? ` with ${s.info.obsVideoEncoderName}` : ''}`,
      verdict === 'software' ? 'loading' : 'ready');
  }
  sendStatus(`[StartRecord sent to OBS at ${s.info.obsRecordStartSentAt.local}]\n`);
}

// The recording has really started. If the session had to wait for OBS, say
// how late the video begins and whether any of the game was missed.
function reportLateStart(s, actuallyStartedAt) {
  if (!s.waitedForObs) return;
  const startedMs = actuallyStartedAt.getTime();
  const lateMs = startedMs - s.startedAtMs;
  s.info.obsRecordingStartedLateSeconds = Math.round(lateMs / 100) / 10;
  saveSessionInfo(s);

  const missed = s.gameDetectedAtMs !== null && s.gameDetectedAtMs < startedMs
    ? `The game was detected ${formatClock(startedMs - s.gameDetectedAtMs)} before that, so the first ` +
      `${formatClock(startedMs - s.gameDetectedAtMs)} of the game is NOT on the video. "Analyze last match" leaves out ` +
      'what happened before the video starts.'
    : 'No game had been detected yet, so nothing of the game was missed.';
  sendStatus(`[THE RECORDING STARTED LATE: the video begins ${formatClock(lateMs)} after you clicked Start session, ` +
    `because OBS was still loading. ${missed}]\n`);
}

// Find out which video encoder OBS will record with, save it in session.json
// and say which one it is. Hardware encoders (NVENC, QuickSync, AMF) are fine;
// warn only for a software one (x264, software AV1) or when no encoder is
// selected. This function never throws: if OBS can't be asked, the recording
// simply starts without the check.
async function checkVideoEncoder(s) {
  let found;
  try {
    found = await obs.getRecordingEncoder();
  } catch (err) {
    sendStatus(`[Couldn't ask OBS which video encoder it records with: ${err.message}]\n`);
    return;
  }
  const verdict = encoderVerdict(found);
  s.info.obsVideoEncoder = found.encoder;
  s.info.obsVideoEncoderName = found.label;
  s.info.obsVideoEncoderVerdict = verdict;
  saveSessionInfo(s);

  const bar = '='.repeat(70);
  const howToChoose = 'In OBS open Settings > Output > Recording and choose a hardware Video Encoder:\n' +
    'NVIDIA NVENC, Intel QuickSync or AMD AMF (whichever your PC has).\n';
  if (verdict === 'missing') {
    sendStatus(`\n${bar}\n` +
      'WARNING: NO RECORDING ENCODER IS SELECTED IN OBS, so the recording may fail to start.\n' +
      howToChoose +
      `${bar}\n\n`);
  } else if (verdict === 'reset') {
    sendStatus(`\n${bar}\n` +
      `WARNING: NO RECORDING ENCODER IS SELECTED IN OBS. It was set to ${found.label} (${found.encoder}), but that did NOT ` +
      `load when OBS started this time${found.loadProblem ? ` (OBS's log says: "${found.loadProblem}")` : ''}, so OBS reset it.\n` +
      'The recording may fail to start, or fall back to a slower encoder and BE CHOPPY.\n' +
      'To get it back, exit OBS and start it again while no game is loading. Or ' + howToChoose.charAt(0).toLowerCase() +
      howToChoose.slice(1) +
      `${bar}\n\n`);
  } else if (verdict === 'software') {
    sendStatus(`\n${bar}\n` +
      `WARNING: OBS records with ${found.label} (${found.encoder}), a SOFTWARE encoder, so THE VIDEO MAY BE CHOPPY.\n` +
      'It uses the processor, which the game needs too. To fix it: ' + howToChoose +
      `${bar}\n\n`);
  } else {
    const kind = found.kind === 'hardware' ? ', a hardware encoder - fine' : '';
    sendStatus(`[Video encoder: ${found.label} (${found.encoder})${kind}` +
      `${found.loadedInObs === null ? ' - OBS\'s log doesn\'t say whether it loaded' : ''}]\n`);
  }
}

// The recording is running: read from OBS's log which encoder it really
// started with, say which one, and warn if that is a software one when the
// setting promised a hardware one. Never throws.
async function confirmEncoderInUse(s) {
  await sleep(1000); // give OBS a moment to write those lines
  const inUse = await obs.readEncoderInUse();
  if (!inUse) return;
  s.info.obsVideoEncoderInUse = inUse;
  const described = obs.describeEncoder(inUse);
  // The log says only "obs-nvenc", not H.264 or HEVC: if it's the same make as
  // the setting, use the setting's fuller name.
  const make = described.label.split(' ').slice(0, 2).join(' '); // e.g. "NVIDIA NVENC"
  if (described.kind === 'hardware' && (s.info.obsVideoEncoderName || '').startsWith(make)) {
    described.label = s.info.obsVideoEncoderName;
  }
  if (described.kind === 'software' && s.info.obsVideoEncoderVerdict !== 'software') {
    s.info.obsVideoEncoderVerdict = 'software';
    sendStatus(`[WARNING: OBS's log shows the recording started with ${described.label} ("${inUse}"), a software encoder, ` +
      'so THE VIDEO MAY BE CHOPPY.]\n');
    if (s.recording && session === s) {
      sendObsStatus(`Recording with ${described.label} (software encoder - may be choppy)`, 'loading');
    }
  } else {
    sendStatus(`[OBS's log shows the recording is using: ${described.label} ("${inUse}")]\n`);
  }
  saveSessionInfo(s);
}

// ---- Recording straight into the session folder -----------------------------
// Called once we're connected to OBS, just before StartRecord. Instead of
// letting OBS record to its usual folder and moving the (huge) video
// afterwards, we tell OBS to write it into the session folder to begin with:
//
//   1. GetVersion         -> does this OBS have the two requests we need?
//   2. GetRecordDirectory -> what is OBS's recording folder now? Write it down.
//   3. SetRecordDirectory -> change it to the session folder.
//
// If any of that isn't possible we fall back to the old way (move the video
// after OBS has stopped) and say so in the window. This function never throws.
async function pointObsAtSessionFolder(s) {
  const moveInstead = (why) => {
    s.info.recordingMethod = MOVE_AFTER_STOP;
    s.info.recordingMethodReason = why;
    saveSessionInfo(s);
    sendStatus(`[Video method: MOVE AFTER RECORDING, because ${why}. OBS records to its usual folder, and ` +
      'the video is moved into the session folder once OBS has fully stopped.]\n');
  };

  let version;
  try {
    version = await obs.getVersionInfo();
  } catch (err) {
    return moveInstead(`OBS couldn't be asked which requests it supports (${err.message})`);
  }
  const versionText = `OBS ${version.obsVersion}, obs-websocket ${version.webSocketVersion}`;
  if (version.missingDirectoryRequests.length > 0) {
    return moveInstead(`this version of OBS (${versionText}) doesn't have the ` +
      `${version.missingDirectoryRequests.join(' and ')} request${version.missingDirectoryRequests.length > 1 ? 's' : ''}`);
  }

  // If OBS's folder was left pointing at an OLD session folder (see
  // restoreLeftoverRecordDirectory), put it back first. Otherwise step 2
  // below would mistake that old session folder for OBS's own folder.
  await leftoverRestore; // an attempt may be under way right now - let it finish
  const leftover = readSavedRecordDirectory();
  if (leftover) {
    try {
      await obs.setRecordDirectory(leftover.originalRecordDirectory);
      forgetSavedRecordDirectory();
      sendStatus(`[OBS's recording folder had been left at ${leftover.sessionFolder} - ` +
        `set it back to: ${leftover.originalRecordDirectory}]\n`);
    } catch (err) {
      return moveInstead(`OBS's recording folder was left over from an earlier session and couldn't be set back (${err.message})`);
    }
  }

  let original;
  try {
    original = await obs.getRecordDirectory();
    saveRecordDirectory(original, s.folder); // written down BEFORE anything is changed
  } catch (err) {
    return moveInstead(`OBS's current recording folder couldn't be read and saved (${err.message})`);
  }
  s.obsOriginalDirectory = original; // from here on it has to be put back
  s.info.obsOriginalRecordDirectory = original;

  // Point OBS at the session folder. Don't take OBS's word for it: ask what
  // the folder is now. If it isn't the session folder, say so and try once more.
  let problem = null;
  for (let attempt = 1; attempt <= RECORD_DIR_TRIES; attempt++) {
    problem = null;
    try {
      await obs.setRecordDirectory(s.folder);
      const now = await obs.getRecordDirectory();
      if (samePath(now, s.folder)) s.info.obsRecordDirectoryAtStart = now;
      else problem = `OBS reports its recording folder is "${now}"`;
    } catch (err) {
      problem = err.message;
    }
    if (!problem) break;
    sendStatus(`[After SetRecordDirectory, OBS's recording folder is NOT the session folder (${problem}).` +
      `${attempt < RECORD_DIR_TRIES ? ' Trying once more...' : ''}]\n`);
  }
  if (problem) {
    await restoreObsRecordDirectory(s);
    s.info.obsRecordDirectoryAtStart = original;
    return moveInstead(`OBS didn't accept the session folder as its recording folder, even on a second try (${problem})`);
  }
  sendStatus(`[Checked: OBS's recording folder is now the session folder (${s.info.obsRecordDirectoryAtStart})]\n`);

  s.info.recordingMethod = RECORD_INTO_FOLDER;
  saveSessionInfo(s);
  sendStatus(`[Video method: RECORD STRAIGHT INTO THE SESSION FOLDER (${versionText} supports it). ` +
    `OBS's own recording folder, ${original}, is saved and will be set back after the recording.]\n`);
}

// Put OBS's recording folder back the way it was before the session, using
// the session's connection to OBS. Does nothing if the session never changed
// it (or has already put it back). This function never throws: if OBS can't be
// reached, the small file from saveRecordDirectory stays, and the folder is
// put back later (see restoreLeftoverRecordDirectory).
async function restoreObsRecordDirectory(s) {
  const original = s.obsOriginalDirectory;
  if (!original) return;
  try {
    await obs.setRecordDirectory(original);
    s.obsOriginalDirectory = null;
    s.info.obsRecordDirectoryRestored = true;
    forgetSavedRecordDirectory();
    sendStatus(`[OBS's recording folder was set back to: ${original}]\n`);
  } catch (err) {
    s.info.obsRecordDirectoryRestored = false;
    sendStatus(`[Couldn't set OBS's recording folder back to ${original} (${err.message}). ` +
      'This app will set it back as soon as it can reach OBS again.]\n');
  }
  saveSessionInfo(s);
}

// The session is waiting for OBS. Save what obs.js found out about it (see
// checkWhyNoAnswer there) in session.json and show it in the window. Only
// facts: Safe Mode or a waiting question is mentioned only if OBS's own log
// shows one (that is what check.log.problem is).
function reportObsWait(s, check) {
  s.info.obsWebSocketChecks.push({ ...check, checkedAt: wallClock(check.checkedAt) });
  saveSessionInfo(s);

  const loading = formatClock(check.loadingSeconds * 1000);
  let running = `couldn't find out whether ${check.obsProcessName} is running (${check.obsRunningError})`;
  if (check.obsRunning === true) {
    running = `${check.obsProcessName} is running and has been loading for ${loading}` +
      `${check.startedByApp ? ' (this app started it)' : ''}`;
  }
  if (check.obsRunning === false) running = `${check.obsProcessName} is NOT running - this app is starting it`;

  let listener = 'nothing is listening on it yet';
  if (check.portListenerError) listener = `couldn't find out what is listening on it (${check.portListenerError})`;
  if (check.portListener) {
    listener = `${check.portListener.processName || 'an unknown process'} (process ID ${check.portListener.pid}) is listening on it`;
  }

  let log = '';
  if (check.logError) {
    log = ` OBS's log couldn't be read (${check.logError}).`;
  } else if (check.obsRunning !== false && !check.log) {
    log = ' OBS has not started writing its log yet.';
  } else if (check.log && check.log.problem) {
    log = ` ${check.log.problem}.`;
  } else if (check.log) {
    log = ` OBS's log (${path.basename(check.log.file)}) shows no Safe Mode and no question waiting for an answer` +
      `${check.log.lastLine ? `; its last line is "${check.log.lastLine}"` : ''}.`;
  }

  sendStatus(`[OBS, ${check.when}: ${running}. Port ${check.port}: ${listener}.${log}]\n`);
}

// If OBS goes away in the middle of a recording (for example, it was closed),
// we can no longer ask it to stop, tell us the file name, or take its
// recording folder back. The session carries on logging the game; at the end
// we look for the video ourselves (see findSessionVideo), and the
// folder is put back as soon as OBS can be reached again.
obs.onConnectionClosed(() => {
  // Whether OBS is recording is asked again on reconnecting (see checkForOutsideRecording in obs.js).
  outsideRecordingNow = false;
  if (session && session.recording) {
    session.recording = false;
    sendObsStatus('Connection to OBS was lost while recording', 'error');
    sendStatus('\n[Lost the connection to OBS while recording. Check OBS for the video file.]\n');
  }
});

// `attempt` is 1 for the first start and 2 for the retry after a startup crash.
function startLogger(attempt = 1) {
  const startedAt = Date.now();
  session.loggerStarts = attempt;

  // fork() starts a new Node.js process running logger_runner.js and opens a
  // message channel to it (used by stopSession to send "stop"). In the built
  // .exe that process is a second copy of the app's own program.
  //   [LOGGER_PATH]     -> tells logger_runner.js which live_logger.js to run
  //   silent: true      -> capture its output instead of printing it to a terminal
  //   cwd               -> run from the project folder, like `node live_logger.js` would
  //   windowsHide: true -> don't pop up a console window
  logger = fork(path.join(__dirname, 'logger_runner.js'), [LOGGER_PATH], {
    silent: true,
    cwd: PROJECT_DIR,
    windowsHide: true,
  });
  logger.once('spawn', () => monitor.event(`Logger started (attempt ${attempt})`));

  // Forward everything the logger prints to the window. Its normal output
  // (stdout) is also read by us, to notice when a game starts.
  logger.stdout.setEncoding('utf8');
  logger.stderr.setEncoding('utf8');
  logger.stdout.on('data', watchLoggerOutput);
  logger.stderr.on('data', sendStatus);

  // logger_runner.js replies "stop-received" when our stop message reaches it.
  logger.on('message', (msg) => {
    if (msg === 'stop-received') sendStatus('[Logger confirmed it received the stop message]\n');
  });

  // When the logger exits (stopped by us, or the match ended), end the session.
  const thisLogger = logger;
  logger.on('exit', (code) => {
    clearTimeout(thisLogger.killTimer);
    logger = null;
    session.loggerExitCode = code; // null if it was killed rather than exiting by itself
    sendStatus(`\n[Logger exited with code ${describeExitCode(code)}]\n`);

    // Failing within a few seconds of starting, without us asking it to stop,
    // means it never got going. Try once more before giving up on the session.
    const crashedAtStartup = code !== 0 && !session.stopRequested &&
      Date.now() - startedAt < LOGGER_STARTUP_MS;
    if (crashedAtStartup && attempt <= LOGGER_STARTUP_RETRIES) {
      sendStatus('[The logger crashed while starting - trying once more...]\n');
      session.loggerOutput = ''; // forget any half line the crashed logger printed
      setTimeout(() => {
        // Stop may have been clicked during the pause.
        if (session.stopRequested) endSession();
        else startLogger(attempt + 1);
      }, LOGGER_RETRY_DELAY_MS);
      return;
    }

    if (crashedAtStartup) reportLoggerStartupCrash(code);
    endSession();
  });

  logger.on('error', (err) => {
    sendStatus(`\n[Logger error: ${err.message}]\n`);
    session.loggerError = err.message;
    // No process ID means it never started, so 'exit' will never fire.
    if (!thisLogger.pid) {
      logger = null;
      endSession();
    }
  });
}

// The logger crashed at startup and the retry crashed too: say so clearly, and
// say why if we can tell.
function reportLoggerStartupCrash(code) {
  session.loggerCrashed = true;
  session.info.endReason = 'Logger crashed at startup';

  const missing = missingAppFiles();
  const advice = missing.length > 0
    ? missingAppFilesMessage(missing)
    : '[Close this window and start the app again. If it keeps happening, the lines above from the logger say why.]\n';
  const bar = '='.repeat(70);
  sendStatus(`\n${bar}\n` +
    `THE LOGGER CRASHED AT STARTUP (exit code ${describeExitCode(code)}), twice in a row.\n` +
    'Nothing was logged, so this session is being ended.\n' +
    `${advice}${bar}\n\n`);
}

// We aren't allowed to change live_logger.js, so the only way to know what it
// is doing is to read what it prints. Output arrives in arbitrary chunks, so
// we glue chunks together and only look at complete lines.
function watchLoggerOutput(text) {
  sendStatus(text);

  const lines = (session.loggerOutput + text).split('\n');
  session.loggerOutput = lines.pop(); // the last piece may be half a line - keep it for next time

  for (const line of lines) {
    // The logger prints this each time the game's port 2999 doesn't answer yet.
    if (line.includes('Waiting for game to start...')) monitor.event('Logger: the game\'s port 2999 is not answering yet');
    if (line.includes('=== Game detected') && !session.gameStarted) {
      monitor.event('Game detected by the logger');
      monitor.stop('game detected');
      session.gameStarted = true;
      session.gameDetectedAtMs = Date.now();
      session.info.game = { playerName: null, champion: null, mode: null, modeName: null, result: null };
      // Rounded to a tenth of a second; the logger only checks every 2 seconds anyway.
      session.info.secondsToGameDetected = Math.round((Date.now() - session.startedAtMs) / 100) / 10;
      saveSessionInfo();
      stopWaitTimer();
      sendGameStatus('In progress');
      lookUpGameDetails(session); // fills in the champion and mode in the background
    }
    const match = line.match(/^Logging to: (.+)$/);
    if (match) session.info.logFile = match[1].trim();
  }
}

// ---- Waiting timeout --------------------------------------------------------
// Once a second, show how long we've been waiting for a game. If it's been
// too long, end the session (which also stops the recording).
//
// The logger only "detects" a game once the match has really begun, which can
// be minutes after the game program opens (the loading screen). So we also ask
// Windows whether the game program is running, and while it is, the clock
// stands still: time only counts towards the timeout while the game is closed.
function startWaitTimer(s) {
  const timeoutMs = s.settings.waitTimeoutMs;
  const timeoutLabel = s.settings.waitTimeoutLabel;
  const gameProcessName = s.settings.gameProcessName;

  let waitedMs = 0;            // the time that counts towards the timeout
  let lastTickAt = Date.now(); // when we last added to waitedMs
  let gameRunning = false;     // Windows' latest answer to "is the game running?"
  let checking = false;        // true while we're waiting for Windows to answer
  let lastCheckAt = 0;         // when we last asked (0 = ask straight away)

  // Asking Windows takes a moment, so it happens in the background and the
  // once-a-second timer below just uses the latest answer.
  const checkGameProcess = async () => {
    checking = true;
    const checkStartedAt = Date.now();
    try {
      gameRunning = await processes.isRunning(gameProcessName);
      monitor.event(`Game process check (tasklist): ${gameProcessName} ${gameRunning ? 'FOUND' : 'not found'} ` +
        `(took ${Date.now() - checkStartedAt} ms)`);
      if (gameRunning && !s.gameProcessSeen) {
        s.gameProcessSeen = true;
        sendStatus(`[${gameProcessName} is running - the waiting timeout is paused while it is]\n`);
      }
    } catch (err) {
      gameRunning = false; // we can't tell, so the timeout keeps counting
      monitor.event(`Game process check (tasklist) failed after ${Date.now() - checkStartedAt} ms: ${err.message}`);
      if (!s.gameProcessCheckFailed) {
        s.gameProcessCheckFailed = true;
        sendStatus(`[Couldn't ask Windows whether ${gameProcessName} is running: ${err.message}]\n`);
      }
    }
    checking = false;
  };

  const showElapsed = (ms) =>
    sendGameStatus(`Waiting for a game - ${formatClock(ms)} (gives up at ${formatClock(timeoutMs)})`);

  showElapsed(0);
  waitTimer = setInterval(() => {
    const now = Date.now();
    if (!gameRunning) waitedMs += now - lastTickAt;
    lastTickAt = now;

    if (!checking && now - lastCheckAt >= GAME_PROCESS_CHECK_MS) {
      lastCheckAt = now;
      checkGameProcess();
    }

    if (gameRunning) {
      sendGameStatus('League game is loading - not timing out');
      return;
    }
    const elapsed = waitedMs;
    showElapsed(elapsed);

    if (elapsed >= timeoutMs) {
      stopWaitTimer();
      monitor.event(`Waiting timeout reached (${timeoutLabel})`);
      sendStatus(`\n[No game started within ${timeoutLabel} - ending the session]\n`);
      stopSession(`No game started within ${timeoutLabel}`);
    }
  }, 1000);
}

function stopWaitTimer() {
  clearInterval(waitTimer);
  waitTimer = null;
}

// ---- Stop session -----------------------------------------------------------
// Asks the session to end. Returns a Promise that resolves once it has fully
// ended (logger exited, recording stopped, session info saved).
function stopSession(reason = 'Stopped by user') {
  if (!session) return Promise.resolve();

  if (!session.stopRequested) {
    session.stopRequested = true;
    session.info.endReason = reason;
    stopWaitTimer();
    monitor.stop(reason); // does nothing if it already stopped when the game was detected

    const child = logger;
    if (child) {
      sendStatus('\n[Stopping session and saving log...]\n');
      // Ask it to save and quit, and say whether the message actually went out.
      // The logger's reply ("stop-received") is shown by startLogger().
      if (child.connected) {
        child.send('stop', (err) => {
          sendStatus(err
            ? `[Couldn't send the stop message to the logger: ${err.message}]\n`
            : '[Stop message sent to the logger]\n');
        });
      } else {
        sendStatus('[Couldn\'t send the stop message - the channel to the logger is closed]\n');
      }

      // Safety net: if it somehow doesn't exit, force it.
      child.killTimer = setTimeout(() => {
        sendStatus('\n[Logger did not stop in time - forcing it to close]\n');
        session.loggerForceKilled = true;
        child.kill();
      }, STOP_TIMEOUT_MS);
    } else {
      // No logger is running right now: it crashed at startup and is about to
      // be started again. startLogger()'s retry notices stopRequested and
      // ends the session instead.
      sendStatus('\n[Stopping session...]\n');
    }
  }

  return session.done;
}

// ---- Sessions with no game --------------------------------------------------
// This is the one rule for sessions in which no game happened (it replaces the
// old "deleteEmptyRecordings", which deleted only the video, straight away).
// When such a session ends, its whole folder is moved into
// <sessionsRoot>\_no_game. Nothing is deleted then: what is in _no_game is
// deleted when the app starts, once it has been there for "noGameRetentionDays"
// days, or by hand with the Clean up button. Whether the files show a game is
// decided by judgeSession in no_game.js; this part adds what only the running
// session knows.

// Returns the reason a no-game session must stay where it is, or null if it
// may be moved into _no_game.
async function whyKeepNoGameSession(s, obsConfirmedStopped) {
  const gameProcessName = s.settings.gameProcessName;

  // 1. The logger exited cleanly. If it crashed, was restarted or had to be
  //    forced to close, "no game detected" might just mean "the logger wasn't
  //    working", so the video could be the only record of a game.
  if (s.loggerError) return `the logger reported an error (${s.loggerError})`;
  if (s.loggerForceKilled) return 'the logger did not stop by itself and had to be forced to close';
  if (s.loggerExitCode !== 0) return `the logger did not exit cleanly (exit code ${describeExitCode(s.loggerExitCode)})`;
  if (s.loggerStarts > 1) return 'the logger crashed at startup and had to be started again';

  // 2. If the logger never saw a game, the game program must never have been
  //    running either. If it was (it was loading, or it crashed - see the
  //    23 October session), the video may be the only record of what happened.
  if (!s.gameStarted) {
    if (s.gameProcessSeen) return `${gameProcessName} was running during the session, so the video may show a game`;
    if (s.gameProcessCheckFailed) return `Windows couldn't always be asked whether ${gameProcessName} was running`;
    try {
      // One last look, in case the game opened in the session's final seconds.
      if (await processes.isRunning(gameProcessName)) return `${gameProcessName} is running right now`;
    } catch (err) {
      return `Windows couldn't be asked whether ${gameProcessName} is running (${err.message})`;
    }
  }

  // 3. OBS has finished with the video (if a recording was started at all).
  if (s.info.obsRecordStartSentAt && !obsConfirmedStopped) return 'OBS did not confirm that it had finished writing the video';

  // 4. Nothing else is using the folder right now.
  if (analyzing) return '"Analyze last match" is running';
  if (attaching) return '"Attach video" is working';

  return null;
}

// Called once a session has completely ended (and, after a game, once the
// end-of-game numbers have been saved or skipped). If no game happened in it,
// move its folder into _no_game, or say why it stays. Never throws.
async function moveSessionIfNoGame(s, obsConfirmedStopped) {
  try {
    const settings = loadSettings();
    const judged = noGame.judgeSession(s.folder, { keepList: settings.noGameKeep });
    if (!judged.noGame) return; // a game (or can't be sure): the session stays, nothing to say

    const keptBecause = await whyKeepNoGameSession(s, obsConfirmedStopped);
    if (keptBecause) {
      s.info.noGame = { reason: judged.reason, keptBecause };
      saveSessionInfo(s);
      sendStatus(`[No game in this session (${judged.reason}), but it stays in ${settings.sessionsRoot}: ${keptBecause}.]\n`);
      return;
    }

    // Saved before the move, so session.json in _no_game says why it is there.
    const oldFolder = s.folder;
    s.info.noGame = { reason: judged.reason, movedTo: noGame.noGameFolder(settings.sessionsRoot), movedAt: wallClock() };
    saveSessionInfo(s);
    const moved = await noGame.moveToNoGame(settings.sessionsRoot, oldFolder, judged.reason, 'automatic');
    sendStatus(`[No game in this session (${judged.reason}), so it was moved to: ${moved.to} ` +
      `(${noGame.megabytes(moved.sizeBytes)}). It is deleted after ${settings.noGameRetentionDays ?? '(never: see the message about noGameRetentionDays)'} days, ` +
      'or use "Clean up" to delete or restore it now.]\n');
    for (const note of moved.notes) sendStatus(`[Note: ${note}.]\n`);
    // The "Folder:" and "Video:" lines still show the old place, unless a new session has started since.
    if (!session && samePath(statusLines['session-folder'], oldFolder)) {
      sendSessionFolder(moved.to);
      if (s.info.videoFile) sendVideoPath(path.join(moved.to, path.basename(s.info.videoFile)));
    }
    s.folder = moved.to;
  } catch (err) {
    sendStatus(`[This session had no game, but it couldn't be moved to _no_game: ${err.message}. It stays where it is.]\n`);
  }
}

// ---- End of session ---------------------------------------------------------
// Every way a session can end comes through here, after the logger is gone:
// the Stop button, the waiting timeout, or the game finishing.
async function endSession() {
  const ended = session;
  ended.ended = true;
  stopWaitTimer();
  // If the logger quit before a game was detected (for example it crashed),
  // the monitor is still running: stop it before the session folder is renamed.
  monitor.stop('the session ended before a game was detected');
  sendGameStatus(ended.loggerCrashed ? 'Logger crashed at startup - see the message below' : '-');

  // The OBS setup runs in the background (see startSession) and may still be
  // going. It notices that the session has ended and gives up within a few
  // seconds; wait for that, so we know for certain whether a recording is
  // running before deciding whether there is one to stop.
  await ended.obsSetup;

  // Stop the OBS recording and wait until OBS has completely finished writing
  // the video (see stopRecord in obs.js - this can take minutes). StopRecord's
  // reply tells us the video's full path.
  let confirmedStopped = false;
  if (ended.recording) {
    ended.recording = false;
    try {
      sendObsStatus('Stopping - waiting for OBS to finish writing the video...');
      sendStatus('[StopRecord sent to OBS - waiting for it to report that the recording has fully stopped...]\n');
      const stopSentAt = Date.now();
      const stopped = await obs.stopRecord((waitedMs) => {
        sendObsStatus(`Stopping - OBS is still writing the video (${formatClock(waitedMs)})`);
      });
      confirmedStopped = stopped.confirmedStopped;
      // OBS writes paths as "F:/a/b.mp4"; path.normalize turns that into the
      // usual Windows form, "F:\a\b.mp4". This is the finished file's real
      // path, wherever OBS actually wrote it.
      if (stopped.videoFile) {
        ended.info.videoFile = path.normalize(stopped.videoFile);
        ended.info.videoFileFoundBy = stopped.videoFileFrom;
        saveSessionInfo(ended);
        sendStatus(`[OBS says the finished video is: ${ended.info.videoFile} (from its ${stopped.videoFileFrom})]\n`);
      } else {
        sendStatus('[OBS stopped but did not say where it saved the video - it will be looked for.]\n');
      }

      if (confirmedStopped) {
        const seconds = Math.round((Date.now() - stopSentAt) / 100) / 10;
        ended.info.obsStopSeconds = seconds;
        sendObsStatus('Recording stopped - video saved');
        sendStatus(`[OBS reported that the recording had fully stopped, ${seconds} seconds after StopRecord]\n`);
      } else {
        sendObsStatus('Recording stopped, but OBS did not confirm it had finished - see the message below');
        sendStatus(`[OBS did not report that the recording had fully stopped: ${stopped.notStoppedReason}]\n`);
      }
    } catch (err) {
      sendObsStatus('Error - could not stop the recording');
      // OBS sometimes refuses without a message (for example when it was not
      // actually recording), so show its error code too.
      const why = err.message || 'OBS gave no reason';
      const code = err.code !== undefined ? ` (OBS error code ${err.code})` : '';
      sendStatus(`[Couldn't stop the OBS recording: ${why}${code}. Check OBS.]\n`);
    }
  }

  // The recording is over (or there never was one), so OBS gets its own
  // recording folder back. This is also where it happens when the session
  // ended in some unusual way.
  await restoreObsRecordDirectory(ended);
  await makeSureRecordDirectoryIsBack(ended);
  obs.forgetRecordWaits();

  // Measure the video. It is NOT moved: OBS wrote it straight into the
  // session folder.
  await finishVideo(ended, confirmedStopped);

  // OBS has fully stopped and the video was kept: look in OBS's own log for
  // how well the recording went.
  if (confirmedStopped && ended.info.videoFile) await checkRecordingQuality(ended);

  // If nothing asked for the stop, the logger finished by itself.
  if (!ended.info.endReason) {
    ended.info.endReason = ended.gameStarted ? 'Game ended' : 'Logger stopped before a game started';
  }
  ended.info.sessionEndedAt = wallClock();
  saveSessionInfo(ended);

  // The logger has exited (that's how we got here), so its log file is
  // complete: move it into the session folder.
  await moveIntoSessionFolder(ended, 'logFile', 'originalLogFile', 'live_log.json', 'game log');

  if (ended.gameStarted) {
    readGameDetailsFromLog(ended);
    const { champion, modeName, result } = ended.info.game;
    sendStatus(`[Game: ${champion || 'unknown champion'} - mode: ${modeName || 'unknown'} - result: ${result || 'unknown'}]\n`);
  }

  // Everything is in the folder, OBS has fully stopped and has its own
  // recording folder back: only now give the session folder its final name.
  // Then save session.json once more so it holds the new paths.
  await renameSessionFolder(ended);
  saveSessionInfo(ended);

  sendSessionFolder(ended.folder);
  if (ended.info.videoFile) sendVideoPath(ended.info.videoFile);
  sendStatus(`[Session ended: ${ended.info.endReason}]\n[Session folder: ${ended.folder}]\n`);
  saveSessionOutput(ended);
  session = null;
  sessionOwnsObsLine = false; // the "OBS:" line goes back to showing whether OBS is ready
  idleEncoder = null;         // and asks OBS about its encoder again (it may have been changed)
  showObsWatch();
  sendRunning(false);
  ended.resolveDone();

  // The League client's end-of-game numbers (damage, gold, exact CS, final
  // items, augments). The client needs a little while to add the game to its
  // history, so this runs in the background and tries a few times. It says
  // something only when it saved the file; otherwise it skips quietly (the
  // report then says the numbers weren't saved).
  // Only after that is it decided whether this was a session with no game:
  // end_stats.json counts as a sign of a game, and must not be written into a
  // folder that has just been moved away.
  let endStatsDone = Promise.resolve();
  if (ended.gameStarted) {
    const settingsNow = loadSettings();
    endStatsDone = endStats.saveEndStatsSoon({ sessionFolder: ended.folder, playerName: settingsNow.playerName, gameProcessName: settingsNow.gameProcessName })
      .then((result) => { if (result.status === 'saved') sendStatus(`[End-of-game numbers saved from the League client (${endStats.FILE_NAME}): ${result.text}.]\n`); });
  }
  endStatsDone.then(() => moveSessionIfNoGame(ended, confirmedStopped));

  // If OBS couldn't be reached to take its recording folder back, start
  // trying again in the background (this does nothing if all is well).
  restoreLeftoverRecordDirectory();
}

// The session is over: ask OBS what its recording folder is NOW. If it isn't
// the folder OBS had before the session (putting it back failed, or something
// changed it again), put it back, and show both paths in the window. Does
// nothing if the session never changed the folder. Never throws.
async function makeSureRecordDirectoryIsBack(s) {
  const original = s.info.obsOriginalRecordDirectory;
  if (!original) return;
  let before;
  try {
    before = await obs.getRecordDirectory();
  } catch (err) {
    sendStatus(`[Couldn't ask OBS whether its recording path is back to ${original} (${err.message}). ` +
      'This app will set it back as soon as it can reach OBS again.]\n');
    return;
  }
  if (samePath(before, original)) return; // it is back, and restoreObsRecordDirectory said so already

  sendStatus('[OBS\'s recording path was NOT put back after the session - putting it back now.]\n' +
    `[  Before: ${before}]\n`);
  try {
    await obs.setRecordDirectory(original);
    const after = await obs.getRecordDirectory();
    sendStatus(`[  After:  ${after}]\n`);
    if (!samePath(after, original)) throw new Error(`OBS still reports "${after}" instead of "${original}"`);
    s.obsOriginalDirectory = null;
    s.info.obsRecordDirectoryRestored = true;
    forgetSavedRecordDirectory();
  } catch (err) {
    s.info.obsRecordDirectoryRestored = false;
    sendStatus(`[Couldn't put OBS's recording path back to ${original} (${err.message}). ` +
      'This app will keep trying as soon as it can reach OBS again.]\n');
    // Make sure it is written down, so restoreLeftoverRecordDirectory keeps trying.
    try {
      saveRecordDirectory(original, s.folder);
    } catch (saveErr) {
      sendStatus(`[Couldn't write that down either (${saveErr.message}). Set it back by hand in OBS: ` +
        `Settings > Output > Recording > Recording Path = ${original}]\n`);
    }
  }
  saveSessionInfo(s);
}

// Above this many skipped frames (in percent) the video is noticeably choppy.
const SKIPPED_FRAMES_WARN_PERCENT = 5;

// Read from OBS's log how many frames it skipped during this session's
// recording (see readSkippedFrames in obs.js), save that in session.json and
// warn in the window if it is a lot. This function never throws: if the log
// can't be read, obsSkippedFramePercent simply stays null.
async function checkRecordingQuality(s) {
  let frames;
  try {
    frames = await obs.readSkippedFrames();
  } catch (err) {
    sendStatus(`[Couldn't read from OBS's log how many frames were skipped: ${err.message}]\n`);
    return;
  }
  s.info.obsSkippedFramePercent = frames.percent;
  saveSessionInfo(s);

  // This warning goes by the skipped frames alone, whatever the encoder: even
  // a hardware encoder can fall behind (for example at a very high quality setting).
  const counts = frames.total ? ` (${frames.skipped} of ${frames.total})` : '';
  const encoder = s.info.obsVideoEncoderName ? ` The encoder was ${s.info.obsVideoEncoderName}.` : '';
  if (frames.percent > SKIPPED_FRAMES_WARN_PERCENT) {
    sendStatus(`[WARNING: OBS skipped ${frames.percent}% of the video's frames${counts} because encoding couldn't keep up, ` +
      `so THE VIDEO WILL BE CHOPPY.${encoder}]\n` +
      '[To fix it for next time, in OBS open Settings > Output > Recording and use a hardware Video Encoder ' +
      '(NVENC, QuickSync or AMF) if it isn\'t one already, or lower the FPS in Settings > Video (for example from 60 to 30).]\n');
  } else {
    sendStatus(`[OBS skipped ${frames.percent}% of the video's frames${counts} - the recording kept up fine.]\n`);
  }
}

// Is this file name a video (going by the part after the dot)?
function isVideoName(name) {
  return VIDEO_EXTENSIONS.includes(path.extname(name).slice(1).toLowerCase());
}

// We don't know the video's name (OBS went away, or refused to stop, before
// it could tell us). Look for it in every folder OBS may have written it to:
// the session folder, the folder OBS reported just before StartRecord, and
// OBS's own folder. Only videos created after Start session was clicked
// count. If there are several, the one that was created closest to the moment
// StartRecord was sent is this session's. Returns the full path, or null.
async function findSessionVideo(s) {
  const folders = [];
  for (const folder of [s.folder, s.info.obsRecordDirectoryAtStart, s.info.obsOriginalRecordDirectory]) {
    if (folder && !folders.some((f) => samePath(f, folder))) folders.push(folder);
  }
  const startSentMs = s.info.obsRecordStartSentAt ? Date.parse(s.info.obsRecordStartSentAt.iso) : s.startedAtMs;

  const found = [];
  for (const folder of folders) {
    let names;
    try {
      names = await fsp.readdir(folder);
    } catch (err) {
      sendStatus(`[Couldn't look in ${folder} for the video: ${err.message}]\n`);
      continue;
    }
    for (const name of names.filter(isVideoName)) {
      const file = path.join(folder, name);
      try {
        const stats = await fsp.stat(file);
        if (stats.isFile() && stats.birthtimeMs >= s.startedAtMs - FILE_AGE_SLACK_MS) {
          found.push({ file, distance: Math.abs(stats.birthtimeMs - startSentMs) });
        }
      } catch (err) {
        // it disappeared while we looked - skip it
      }
    }
  }
  if (found.length === 0) {
    sendStatus(`[No video made during this session was found in: ${folders.join(', ')}]\n`);
    return null;
  }
  found.sort((a, b) => a.distance - b.distance);
  if (found.length > 1) {
    sendStatus(`[${found.length} videos made during this session were found (${found.map((f) => f.file).join(', ')}) - ` +
      'using the one that was created closest to when StartRecord was sent]\n');
  }
  return found[0].file;
}

// Deal with the session's video once OBS is done with it: record its full
// path and its length in session.json. The video is never renamed: it keeps
// the name OBS gave it. (A session with no game is moved to _no_game later,
// whole - see moveSessionIfNoGame.)
//
// Normally the video is already in the session folder and that's all. If it
// isn't (the fallback method, or OBS wrote it somewhere else anyway), it is
// moved there - but only once OBS has confirmed that it had fully stopped. If
// the move fails, videoFile keeps pointing at the video where it is.
async function finishVideo(s, confirmedStopped) {
  // The path OBS gave must really be a file; if it isn't, look for the video instead.
  if (s.info.videoFile && !fs.existsSync(s.info.videoFile)) {
    sendStatus(`[OBS named the video ${s.info.videoFile}, but there is no such file - looking for it.]\n`);
    s.info.videoFile = null;
    s.info.videoFileFoundBy = null;
  }
  // A recording was asked for, but OBS never said where it went: look for it,
  // so that videoFile is never left empty when a video exists.
  if (!s.info.videoFile && s.info.obsRecordStartSentAt) {
    s.info.videoFile = await findSessionVideo(s);
    if (s.info.videoFile) {
      s.info.videoFileFoundBy = 'searched for it';
      sendStatus(`[Found the video by searching: ${s.info.videoFile}]\n`);
    }
  }
  const videoFile = s.info.videoFile;
  if (!videoFile) {
    saveSessionInfo(s);
    if (s.info.outsideRecordings.length > 0) {
      sendStatus('[This session has no video of its own, but a recording this app did not start finished during it: ' +
        `${s.info.outsideRecordings.map((r) => r.file || '(OBS gave no file name)').join(', ')}. ` +
        'To use it, click "Attach video".]\n');
    }
    return; // no recording was made this session
  }
  saveSessionInfo(s);
  sendVideoPath(videoFile);
  sendStatus(`[Video saved to: ${videoFile}]\n`);

  try {
    s.info.videoDurationSeconds = await getVideoDuration(videoFile);
    saveSessionInfo(s);
    sendStatus(`[Video length: ${s.info.videoDurationSeconds} seconds` +
      `${confirmedStopped ? '' : ' (OBS did not confirm it had finished writing, so this may be too short)'}]\n`);
  } catch (err) {
    sendStatus(`[Couldn't measure the video's length with ffprobe: ${err.message}]\n`);
  }

  if (samePath(path.dirname(videoFile), s.folder)) {
    sendStatus('[Video method used: OBS recorded it straight into the session folder, so it was not moved.]\n');
    return;
  }

  // The video is somewhere else, so it has to be moved after all.
  if (s.info.recordingMethod === RECORD_INTO_FOLDER) {
    s.info.recordingMethod = MOVE_AFTER_STOP;
    s.info.recordingMethodReason = 'OBS did not save the video in the session folder even though it was asked to';
    sendStatus(`[${s.info.recordingMethodReason}, so it will be moved there instead.]\n`);
  }
  if (!confirmedStopped) {
    sendStatus('[Video method used: none - the video was NOT moved, because OBS did not confirm that it had ' +
      `finished writing it. It is still at ${videoFile}]\n`);
    return;
  }
  // Keep trying for about 60 seconds if Windows says the file is in use; after
  // that moveFile copies it instead. The video keeps OBS's own file name.
  const result = await moveIntoSessionFolder(s, 'videoFile', 'originalVideoFile',
    path.basename(videoFile), 'video', RELEASE_WAIT_TRIES);
  if (result) {
    sendStatus(`[Video method used: ${result.method === 'moved'
      ? 'moved into the session folder after OBS had fully stopped'
      : 'copied into the session folder, checked for size, then the original deleted (the last resort)'}]\n`);
  } else {
    sendStatus('[Video method used: none - the move failed, see the message above.]\n');
  }
}

// ---- Analyze last match -----------------------------------------------------
// The work itself is in analyze.js; this just starts it and passes its
// messages on to the window. It is not allowed during a session: the newest
// session folder would be the one still being recorded.
let analyzing = false; // true while an analysis is running

async function analyzeLastMatch() {
  if (analyzing) return;
  if (session) {
    sendStatus('[Analyze last match: a session is running. Stop it first, then analyze.]\n');
    return;
  }
  if (exporting) {
    sendStatus('[Analyze last match: clips are being exported. Wait for that to finish, then analyze.]\n');
    return;
  }
  if (attaching) {
    sendStatus('[Analyze last match: a video is being attached. Wait for that to finish, then analyze.]\n');
    return;
  }
  analyzing = true;
  sendToWindow('analyzing', true);
  sendStatus('\n[Analyzing the last match...]\n');
  const settings = loadSettings();
  const highlights = await analyze.analyzeLastMatch({
    sessionsRoot: settings.sessionsRoot,
    envFile: ENV_PATH,
    playerName: settings.playerName,
    measureVideo: getVideoDuration,
    say: sendStatus,
    highlightMode: settings.highlightMode,
    maxClips: settings.maxClips,
    minClips: settings.minClips,
    maxClipSeconds: settings.maxClipSeconds,
  });
  // Then the performance report, for the same session folder. If the
  // highlights couldn't be made (no session, no API key, ...) the report is
  // skipped: the same problem would stop it too.
  if (highlights) {
    // The League client's end-of-game numbers, if they weren't saved when the
    // session ended (one try; an end_stats.json that is there is kept as it is).
    const saved = await endStats.saveEndStats({
      sessionFolder: highlights.sessionFolder, playerName: settings.playerName, gameProcessName: settings.gameProcessName,
    });
    if (saved.status === 'saved') sendStatus(`[End-of-game numbers saved from the League client (${endStats.FILE_NAME}): ${saved.text}.]\n`);
    else if (saved.status === 'skipped') sendStatus(`[End-of-game numbers skipped: ${saved.text}.]\n`);
    await report.writeReport({
      sessionFolder: highlights.sessionFolder,
      envFile: ENV_PATH,
      playerName: settings.playerName,
      measureVideo: getVideoDuration,
      say: sendStatus,
    });
    // Check the two files just written: the same moment must never have two
    // different video times. If it does, say so where it can't be missed.
    const timeResult = timeCheck.checkSession(highlights.sessionFolder);
    if (timeResult.problems.length > 0) sendStatus(`\n${timeCheck.loudLines(highlights.sessionFolder, timeResult)}\n`);
    else sendStatus(`[Time check passed: ${timeResult.checkedTimes} times in ${timeResult.filesChecked.join(' and ')} agree.]\n`);
    // Show the highlights and review moments as rows with Export buttons.
    showClips(highlights.sessionFolder);
  }
  analyzing = false;
  sendToWindow('analyzing', false);
}

// ---- The highlight mode dropdown --------------------------------------------
// The dropdown next to "Analyze last match" saves its choice as
// "highlightMode" in settings.json. Only that one value is changed; everything
// else in the file is kept. If the file can't be read as it is, it is left
// alone (it holds the OBS password, among other things).
function setHighlightMode(mode) {
  const showCurrent = () => sendToWindow('highlight-mode', loadSettings().highlightMode);
  if (!analyze.HIGHLIGHT_MODES.includes(mode)) return;
  let saved;
  try {
    let text = fs.readFileSync(SETTINGS_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // see loadSettings
    saved = JSON.parse(text);
  } catch (err) {
    sendStatus(`[Couldn't save the highlight mode: ${SETTINGS_PATH} can't be read (${err.message}). Nothing was changed.]\n`);
    showCurrent();
    return;
  }
  saved.highlightMode = mode;
  try {
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
  } catch (err) {
    sendStatus(`[Couldn't save the highlight mode in ${SETTINGS_PATH}: ${err.message}]\n`);
    showCurrent();
    return;
  }
  sendStatus(`[Highlight mode is now "${mode}" (saved in settings.json). It is used the next time you click Analyze last match.]\n`);
}

// ---- Export clips -----------------------------------------------------------
// The work itself is in export.js; this decides when it may run, asks the one
// question (choppy video) and passes messages on to the window.
let clipList = null;     // what export.js found to export in the session shown in the window (null = nothing shown)
let exporting = false;   // true while clips are being cut

// Show the clips of one session folder in the window, or put the list away (null).
function showClips(sessionFolder) {
  clipList = sessionFolder ? exporter.listClips(sessionFolder) : null;
  // The Open button opens this session's own saved report, if it has one:
  // <Champion>_report.pdf/.docx, or report.pdf/.docx in an older session.
  lastReportFile = sessionFolder ? reportExport.findReportFile(sessionFolder) : null;
  if (clipList) {
    // The "Save report as" buttons need report.json, not a video.
    clipList.reportExists = fs.existsSync(path.join(sessionFolder, 'report.json'));
    clipList.reportFile = lastReportFile;
    for (const note of clipList.notes) sendStatus(`[Export: ${note}]\n`);
    const percent = clipList.skippedFramePercent;
    clipList.choppy = percent !== null && percent > SKIPPED_FRAMES_WARN_PERCENT;
    const count = `${clipList.clips.length} ${clipList.noVideo ? 'moment' : 'clip'}${clipList.clips.length === 1 ? '' : 's'}`;
    if (clipList.clips.length > 0 && clipList.noVideo) {
      sendStatus(`[${count} listed above this text, with game times only. Export is switched off: this session has no video.]\n`);
    } else if (clipList.clips.length > 0) {
      sendStatus(`[${count} can be exported - see the list above this text.]\n`);
    }
  }
  sendToWindow('clips', clipList);
}

// When the app opens: if the newest session has been analyzed already, show
// its clips straight away, so exporting later doesn't need a second (paid)
// "Analyze last match".
function showClipsOfNewestSession() {
  try {
    const folder = analyze.findNewestSessionFolder(loadSettings().sessionsRoot);
    if (folder && fs.existsSync(path.join(folder, 'highlights.json'))) showClips(folder);
  } catch (err) {
    // no sessions folder yet: there is nothing to show
  }
}

// clipIds: which rows to export. framing: 'native' or 'vertical'.
async function exportClips(clipIds, framing) {
  if (exporting || !clipList) return;
  // The window greys the buttons out in these cases; this is the same rule
  // again on this side, so nothing can slip through.
  if (session) {
    sendStatus('[Export: a session is running. Encoding now would slow the game and the recording - export after the session.]\n');
    return;
  }
  if (analyzing || attaching) return;

  // Warn before starting if OBS skipped a lot of frames while recording: the
  // clips are cut from that same video, so they will be just as choppy.
  if (clipList.choppy) {
    sendStatus(`[WARNING: OBS skipped ${clipList.skippedFramePercent}% of this video's frames while recording, so the clips WILL LOOK CHOPPY.]\n`);
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'The clips will look choppy',
      message: `OBS skipped ${clipList.skippedFramePercent}% of this video's frames while recording ` +
        `(more than ${SKIPPED_FRAMES_WARN_PERCENT}% is noticeable).`,
      detail: 'The clips are cut from that same video, so they will look choppy too. Exporting can\'t repair that.',
      buttons: ['Export anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) {
      sendStatus('[Export cancelled.]\n');
      return;
    }
    if (session || exporting || !clipList) return; // something changed while the question was open
  } else if (clipList.skippedFramePercent === null) {
    sendStatus('[Export: session.json doesn\'t say how many frames OBS skipped (obsSkippedFramePercent), so it can\'t be checked whether this video is choppy.]\n');
  }

  exporting = true;
  sendToWindow('exporting', true);
  const list = clipList;
  const result = await exporter.exportClips({
    list,
    clipIds,
    framing,
    say: sendStatus,
    onProgress: (progress) => sendToWindow('export-progress', progress),
  });
  exporting = false;
  sendToWindow('exporting', false);
  sendToWindow('export-done', {
    files: result.files.length,
    failed: result.failed.length,
    cancelled: result.cancelled,
    folderExists: fs.existsSync(list.clipsFolder),
  });
}

// The "Open folder" button: show the clips folder in Windows Explorer.
async function openClipsFolder() {
  if (!clipList) return;
  const problem = await shell.openPath(clipList.clipsFolder); // gives back '' when it worked
  if (problem) sendStatus(`[Couldn't open ${clipList.clipsFolder}: ${problem}]\n`);
}

// ---- Save the report as PDF or Word -----------------------------------------
// The work itself is in report_export.js. Only report.json (and highlights.json)
// are needed, so this works for a session with no video, and costs nothing.
let savingReport = false;  // true while a report file is being made
let lastReportFile = null; // the file the window's Open button opens (null = none yet)

// format: 'pdf' or 'docx'
async function saveReport(format) {
  if (savingReport || analyzing || !clipList) return; // "Analyze last match" may be rewriting report.json
  savingReport = true;
  sendToWindow('report-saving', true);
  const label = format === 'pdf' ? 'PDF' : 'Word';
  const result = await reportExport.saveReport(clipList.sessionFolder, format);
  savingReport = false;
  if (result.error) {
    sendStatus(`[The report couldn't be saved as ${label}: ${result.error}]\n`);
    sendToWindow('report-saved', { error: `Couldn't save the ${label} file - see the text below.` });
  } else {
    lastReportFile = result.file;
    for (const note of result.notes) sendStatus(`[Report: ${note}]\n`);
    sendStatus(`[Report saved as ${label}: ${result.file} (${(result.sizeBytes / 1024).toFixed(0)} KB)]\n`);
    let warning = '';
    if (result.timeProblems.length > 0) {
      sendStatus(`\n${timeCheck.loudLines(clipList.sessionFolder, { problems: result.timeProblems })}\n` +
        '[The PDF/Word file shows every time by the one rounding rule, but report.json itself still disagrees with itself. ' +
        'Clicking "Analyze last match" again writes a corrected report.json.]\n');
      warning = `TIME CHECK FAILED: report.json gives ${result.timeProblems.length === 1 ? 'a moment' : 'moments'} two different video times - see the text below.`;
    }
    sendToWindow('report-saved', { file: result.file, warning });
  }
  sendToWindow('report-saving', false);
}

// The Open button next to the saved report: open it in Word / the PDF viewer.
async function openReportFile() {
  if (!lastReportFile) return;
  const problem = await shell.openPath(lastReportFile); // gives back '' when it worked
  if (problem) sendStatus(`[Couldn't open ${lastReportFile}: ${problem}]\n`);
}

// ---- Attach video -----------------------------------------------------------
// The "Attach video" button: pick a session folder and any video file, and
// make that file the session's video (videoFile and videoDurationSeconds in
// its session.json). If the video is somewhere else, you choose whether it is
// moved into the session folder, copied there, or left where it is. Nothing is
// ever overwritten, and a video the session already had is never deleted.
//
// "Analyze last match" places the game's moments on the video by the time the
// video started. For a video that wasn't this session's own recording, that
// time is worked out from the file itself: the time it was last written to
// (= when the recording ended) minus its length. That stays right even if the
// file was copied, because copying keeps that time.
let attaching = false; // true while Attach video is working

// Read a session.json. Throws an Error saying why if it can't.
function readSessionJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // see loadSettings
  return JSON.parse(text);
}

async function attachVideo() {
  if (attaching) return;
  if (session) {
    sendStatus('[Attach video: a session is running. Stop it first - the running session rewrites its session.json.]\n');
    return;
  }
  if (analyzing || exporting) {
    sendStatus('[Attach video: wait until the analysis or the export has finished.]\n');
    return;
  }
  attaching = true;
  sendToWindow('attaching', true);
  try {
    await attachVideoSteps();
  } catch (err) {
    sendStatus(`[Attach video failed: ${err.message}. Nothing in session.json was changed.]\n`);
  }
  attaching = false;
  sendToWindow('attaching', false);
}

async function attachVideoSteps() {
  const settings = loadSettings();

  // 1. Which session? Start in the newest session folder: usually the one you want.
  let newest = null;
  try {
    newest = analyze.findNewestSessionFolder(settings.sessionsRoot);
  } catch (err) {
    // no sessions folder yet - start in sessionsRoot itself
  }
  const folderPick = await dialog.showOpenDialog(win, {
    title: 'Attach video - step 1 of 2: choose the SESSION folder',
    defaultPath: newest || settings.sessionsRoot,
    properties: ['openDirectory'],
  });
  if (folderPick.canceled || folderPick.filePaths.length === 0) return;
  const folder = folderPick.filePaths[0];
  const infoFile = path.join(folder, 'session.json');
  if (!fs.existsSync(infoFile)) {
    sendStatus(`[Attach video: ${folder} has no session.json, so it isn't a session folder. Nothing was changed.]\n`);
    return;
  }
  const info = readSessionJson(infoFile);

  // 2. Which video? Start where it most likely is: a recording this app
  //    didn't start, else this session's OBS folder, else the session folder.
  let startIn = folder;
  if (lastOutsideRecording && lastOutsideRecording.file && fs.existsSync(lastOutsideRecording.file)) {
    startIn = lastOutsideRecording.file;
  } else if (info.obsOriginalRecordDirectory && fs.existsSync(info.obsOriginalRecordDirectory)) {
    startIn = path.normalize(info.obsOriginalRecordDirectory);
  }
  const videoPick = await dialog.showOpenDialog(win, {
    title: `Attach video - step 2 of 2: choose the video for ${path.basename(folder)}`,
    defaultPath: startIn,
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }],
  });
  if (videoPick.canceled || videoPick.filePaths.length === 0) return;
  const picked = path.normalize(videoPick.filePaths[0]);

  // 3. Measure it. If ffprobe can't read it, it is most likely not a video
  //    (or still being written), so say so and let you decide.
  const stats = await fsp.stat(picked);
  let duration = null;
  let measureProblem = null;
  try {
    duration = await getVideoDuration(picked);
  } catch (err) {
    measureProblem = err.message;
  }

  // 4. When did the video start? (See the explanation above attachVideo.)
  const sessionStart = info.obsRecordingActuallyStartedAt || info.obsRecordStartSentAt;
  const sessionStartMs = sessionStart ? Date.parse(sessionStart.iso) : NaN;
  let startMs = null;
  let startFrom = null;
  if (duration !== null) {
    startMs = stats.mtimeMs - duration * 1000;
    startFrom = 'the time the file was last written to, minus its length';
  } else if (stats.birthtimeMs) {
    startMs = stats.birthtimeMs;
    startFrom = 'the time the file was created (its length is unknown, so this is wrong if it was copied)';
  }
  // Within a few seconds of the session's own start time, it IS that
  // recording, and the time the app saved then is the more precise one.
  const keepSessionStart = startMs !== null && Math.abs(startMs - sessionStartMs) <= SAME_START_SLACK_MS;

  // 5. Ask what to do.
  const inFolder = samePath(path.dirname(picked), folder);
  const oldVideo = info.videoFile && fs.existsSync(info.videoFile) && !samePath(info.videoFile, picked) ? info.videoFile : null;
  const target = path.join(folder, path.basename(picked));
  const details = [
    `Video: ${picked}`,
    `Length: ${duration !== null ? `${Math.round(duration)} seconds` : `unknown - ffprobe couldn't read it (${measureProblem})`}`,
    keepSessionStart
      ? `It starts at the same time as this session's own recording (${sessionStart.local}), so that time is kept.`
      : `Video times will be counted from ${startMs !== null ? new Date(startMs).toLocaleString() : 'an unknown time'}, worked out from ${startFrom || 'nothing'}.`,
  ];
  if (oldVideo) details.push(`This session already has a video (${oldVideo}). It is NOT deleted - session.json just stops pointing at it.`);
  if (!inFolder && fs.existsSync(target)) {
    details.push(`A file called ${path.basename(picked)} is already in the session folder, so it can only be left where it is.`);
  }
  const canBringIn = !inFolder && !fs.existsSync(target);
  const choices = canBringIn
    ? ['Move it into the session folder', 'Copy it into the session folder', 'Leave it where it is', 'Cancel']
    : ['Attach', 'Cancel'];
  const answer = await dialog.showMessageBox(win, {
    type: measureProblem ? 'warning' : 'question',
    title: 'Attach video',
    message: `Attach this video to ${path.basename(folder)}?`,
    detail: details.join('\n\n'),
    buttons: choices,
    defaultId: 0,
    cancelId: choices.length - 1,
  });
  const choice = choices[answer.response];
  if (choice === 'Cancel') {
    sendStatus('[Attach video cancelled. Nothing was changed.]\n');
    return;
  }

  // 6. Move or copy it, if that was chosen. If that fails, the video stays
  //    where it is and is attached from there.
  let videoFile = picked;
  let how = inFolder ? 'already in the session folder' : 'left where it is';
  if (choice.startsWith('Move')) {
    sendStatus(`[Attach video: moving ${picked} into the session folder...]\n`);
    try {
      const result = await moveFile(picked, target, RELEASE_WAIT_TRIES);
      videoFile = target;
      how = result.method === 'moved' ? 'moved into the session folder'
        : `copied into the session folder because ${result.whyCopied}; ` +
          (result.originalLeft ? `the original could not be deleted (${result.originalLeft})` : 'the original was deleted after the size check');
    } catch (err) {
      how = `left where it is, because moving it failed (${err.message})`;
    }
  } else if (choice.startsWith('Copy')) {
    sendStatus(`[Attach video: copying ${picked} into the session folder...]\n`);
    try {
      await copyFileChecked(picked, target);
      videoFile = target;
      how = 'copied into the session folder (checked for size); the original was kept';
    } catch (err) {
      how = `left where it is, because copying it failed (${err.message})`;
    }
  }

  // 7. Write it into session.json. Read it again first, in case it changed
  //    while the questions were open.
  const latest = readSessionJson(infoFile);
  latest.attachedVideo = {
    pickedFile: picked,
    how,
    attachedAt: wallClock(),
    fileModifiedAt: wallClock(stats.mtime),
    fileCreatedAt: wallClock(stats.birthtime),
    replacedVideoFile: latest.videoFile || null,
    videoStartWorkedOut: startMs !== null ? wallClock(new Date(startMs)) : null,
    videoStartWorkedOutFrom: startFrom,
    replacedRecordingStart: null,
  };
  latest.videoFile = videoFile;
  latest.videoDurationSeconds = duration;
  latest.videoFileFoundBy = 'attached by hand';
  if (!samePath(videoFile, picked)) latest.originalVideoFile = picked;
  if (startMs !== null && !keepSessionStart) {
    latest.attachedVideo.replacedRecordingStart = latest.obsRecordingActuallyStartedAt || null;
    latest.obsRecordingActuallyStartedAt = wallClock(new Date(startMs));
  }
  fs.writeFileSync(infoFile, JSON.stringify(latest, null, 2), 'utf8');

  sendStatus(`[Attached the video to ${folder}: ${videoFile} (${how}). ` +
    `Length: ${duration !== null ? `${duration} seconds` : 'unknown'}.]\n`);
  // The "Video:" line shows the last session's video: update it if that is this session.
  if (statusLines['session-folder'] !== '-' && samePath(statusLines['session-folder'], folder)) sendVideoPath(videoFile);
  // If this session's clips are shown, show them again: Export now has a video to cut from.
  if (clipList && samePath(clipList.sessionFolder, folder)) showClips(folder);
}

// ---- Clean up: the sessions in _no_game -------------------------------------
// The work itself is in no_game.js. Nothing is ever deleted while a session
// is recording (or while Attach video may be pointing at a folder), and every
// deletion by hand is asked about first.
let cleaningUp = false; // true while a deletion or restore is under way

const mayDeleteNow = () => !session && !attaching;

// When the app opens: delete what has been in _no_game for longer than
// "noGameRetentionDays". Each deletion gets a line in _no_game_log.txt.
async function purgeOldNoGameSessions() {
  const settings = loadSettings();
  if (settings.noGameRetentionDays === null) return; // loadSettings has said why
  try {
    const result = await noGame.purgeOld(settings.sessionsRoot, {
      retentionDays: settings.noGameRetentionDays, keepList: settings.noGameKeep, mayDelete: mayDeleteNow,
    });
    for (const item of result.deleted) {
      sendStatus(`[Clean up: deleted ${item.name} (${noGame.megabytes(item.sizeBytes)}) from _no_game - ` +
        `it had been there more than ${settings.noGameRetentionDays} days. See ${noGame.logFile(settings.sessionsRoot)}]\n`);
    }
    for (const item of result.failed) sendStatus(`[Clean up: couldn't delete ${item.name} from _no_game: ${item.error}]\n`);
  } catch (err) {
    sendStatus(`[Clean up: couldn't look in ${noGame.noGameFolder(settings.sessionsRoot)}: ${err.message}]\n`);
  }
}

// Send the list of what is in _no_game to the window (the Clean up panel).
async function sendCleanupList() {
  const settings = loadSettings();
  try {
    const list = await noGame.listNoGame(settings.sessionsRoot, {
      retentionDays: settings.noGameRetentionDays, keepList: settings.noGameKeep,
    });
    sendToWindow('cleanup-list', { ...list, retentionDays: settings.noGameRetentionDays });
  } catch (err) {
    sendToWindow('cleanup-list', { folder: noGame.noGameFolder(settings.sessionsRoot), items: [], totalBytes: 0, error: err.message });
  }
}

// Ask before deleting. Returns true if "Delete" was clicked.
async function confirmDelete(message, detail) {
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Delete for good?',
    message,
    detail: `${detail}\n\nThis can't be undone: the files do not go to the Recycle Bin.`,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return answer.response === 0;
}

// names: the items to delete (one, or all of them for "Delete all now").
async function cleanupDelete(names, all) {
  if (cleaningUp) return;
  if (!mayDeleteNow()) {
    sendStatus('[Clean up: nothing is deleted while a session is running or a video is being attached.]\n');
    return;
  }
  cleaningUp = true;
  try {
    const settings = loadSettings();
    const { items } = await noGame.listNoGame(settings.sessionsRoot, { keepList: settings.noGameKeep });
    const chosen = items.filter((item) => names.includes(item.name) && !item.kept);
    if (chosen.length === 0) {
      const kept = items.filter((item) => names.includes(item.name) && item.kept).map((item) => item.name);
      sendStatus(kept.length > 0
        ? `[Clean up: ${kept.join(', ')} is on the "noGameKeep" list in settings.json, so it is not deleted.]\n`
        : '[Clean up: there is nothing to delete.]\n');
      return;
    }
    const total = noGame.megabytes(chosen.reduce((sum, item) => sum + item.sizeBytes, 0));
    const ok = await confirmDelete(
      all ? `Delete all ${chosen.length} items in _no_game (${total})?` : `Delete ${chosen[0].name} (${total})?`,
      chosen.map((item) => `${item.name} - ${noGame.megabytes(item.sizeBytes)}`).join('\n'));
    if (!ok) {
      sendStatus('[Clean up: deleting was cancelled. Nothing was deleted.]\n');
      return;
    }
    for (const item of chosen) {
      try {
        const result = await noGame.deleteItem(settings.sessionsRoot, item.name, {
          keepList: settings.noGameKeep, mayDelete: mayDeleteNow, why: all ? 'by hand, Delete all now' : 'by hand',
        });
        sendStatus(`[Clean up: deleted ${item.name} (${noGame.megabytes(result.sizeBytes)}).]\n`);
      } catch (err) {
        sendStatus(`[Clean up: couldn't delete ${item.name}: ${err.message}]\n`);
      }
    }
  } catch (err) {
    sendStatus(`[Clean up failed: ${err.message}]\n`);
  } finally {
    cleaningUp = false;
    await sendCleanupList();
  }
}

async function cleanupRestore(name) {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    const restored = await noGame.restoreItem(loadSettings().sessionsRoot, name);
    sendStatus(`[Clean up: ${name} was moved back to ${restored.to}]\n`);
  } catch (err) {
    sendStatus(`[Clean up: couldn't restore ${name}: ${err.message}]\n`);
  } finally {
    cleaningUp = false;
    await sendCleanupList();
  }
}

// ---- Window -----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 760, // tall enough for the list of clips above the text area
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // keep the web page separate from Node.js (safer)
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // Once the page is ready to show messages: start checking on OBS in the
  // background (starting it if it isn't running), and if OBS's recording
  // folder was left pointing at a session folder last time (a crash, a power
  // cut), put it back.
  win.webContents.once('did-finish-load', () => {
    // Errors that happened before the window could show them (see reportUnexpectedError).
    for (const message of errorsBeforeWindow.splice(0)) sendStatus(message);
    sendToWindow('highlight-mode', loadSettings().highlightMode); // what the dropdown shows
    startObsWatch();
    restoreLeftoverRecordDirectory();
    showClipsOfNewestSession();
    purgeOldNoGameSessions();
  });

  // Closing the window in the middle of a session: keep the window open, end
  // the session properly (stop the recording, wait for OBS to finish, give OBS
  // its recording folder back), and close when that is done. Since OBS can
  // take minutes to finish, closing the window a second time quits at once.
  win.on('close', (event) => {
    if (!session) return; // nothing is running: close normally
    event.preventDefault(); // "don't close yet"
    if (!closeRequested) {
      closeRequested = true;
      sendStatus('\n[Ending the session before closing. This window closes by itself when everything is saved. ' +
        'If OBS takes very long to finish the video, close the window again to quit straight away.]\n');
      stopSession('App was closed').then(() => {
        if (win && !win.isDestroyed()) win.close();
      });
    } else {
      quitRightNow();
    }
  });
}

let closeRequested = false; // true once the window was closed during a session
let quittingNow = false;    // true once quitRightNow() has started

// The window was closed a second time while the session was still being
// ended (most likely we are waiting for OBS to finish a long video). Save
// what we have and quit without waiting any longer. OBS finishes the video
// by itself; the session folder just doesn't get its final name.
async function quitRightNow() {
  if (quittingNow || !session) return;
  quittingNow = true;
  const s = session;
  sendStatus('\n[Quitting now without waiting for the session to finish saving. OBS will still finish the video ' +
    'by itself, but the session folder keeps its plain name.]\n');
  if (logger) logger.kill();

  // A recording that is already running keeps its folder, so it is safe to
  // give OBS its own folder back now. Don't wait long for it: if it doesn't
  // work, it is put back the next time the app starts.
  await Promise.race([restoreObsRecordDirectory(s), sleep(QUIT_NOW_RESTORE_MS)]);

  s.info.endReason = `${s.info.endReason || 'App was closed'} (quit before the session had finished saving)`;
  s.info.sessionEndedAt = wallClock();
  saveSessionInfo(s);
  saveSessionOutput(s);
  app.exit(0); // quit immediately
}

// ---- Handle button clicks sent from the window (via preload.js) -------------
ipcMain.on('start-session', () => { startSession(); });
ipcMain.on('stop-session', () => { stopSession(); });
ipcMain.on('analyze-last-match', () => { analyzeLastMatch(); });
ipcMain.on('set-highlight-mode', (_event, mode) => { if (typeof mode === 'string') setHighlightMode(mode); });
ipcMain.on('export-clips', (_event, request) => {
  const ids = request && Array.isArray(request.clipIds) ? request.clipIds.map(String) : [];
  exportClips(ids, request ? request.framing : null);
});
ipcMain.on('open-clips-folder', () => { openClipsFolder(); });
ipcMain.on('save-report', (_event, format) => {
  if (format === 'pdf' || format === 'docx') saveReport(format);
});
ipcMain.on('open-report-file', () => { openReportFile(); });
ipcMain.on('attach-video', () => { attachVideo(); });
// The Clean up panel: what is in _no_game, and its Delete / Restore buttons.
ipcMain.on('cleanup-list', () => { sendCleanupList(); });
ipcMain.on('cleanup-delete', (_event, name) => { if (typeof name === 'string') cleanupDelete([name], false); });
ipcMain.on('cleanup-delete-all', async () => {
  const settings = loadSettings();
  try {
    const { items } = await noGame.listNoGame(settings.sessionsRoot, { keepList: settings.noGameKeep });
    cleanupDelete(items.map((item) => item.name), true);
  } catch (err) {
    sendStatus(`[Clean up failed: ${err.message}]\n`);
  }
});
ipcMain.on('cleanup-restore', (_event, name) => { if (typeof name === 'string') cleanupRestore(name); });
// Retry next to the "OBS:" line: ask OBS about its recording encoder again.
ipcMain.on('obs-retry', () => {
  if (session) return; // during a session the line shows the recording instead
  idleEncoder = null;
  showObsWatch();
});

// ---- App lifecycle ----------------------------------------------------------
// Only one copy of the app may run at a time: two would fight over OBS and the
// logger. A second copy gets `false` here and quits; the first copy is told
// about it ('second-instance') and brings its window to the front instead.
const isFirstCopy = app.requestSingleInstanceLock();
if (!isFirstCopy) app.quit();

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (isFirstCopy) createWindow();
});

// If the app is asked to quit some other way while a session is running (the
// window's own close button is handled in createWindow), stop the session
// cleanly first so the log and the video still get saved, then quit.
let quitting = false;
app.on('before-quit', (event) => {
  if (session && !quitting) {
    event.preventDefault();
    quitting = true;
    stopSession('App was closed').then(() => app.quit());
  }
});

// Don't leave ffmpeg working on a clip after the app has gone.
app.on('will-quit', () => exporter.cancelExport());

app.on('window-all-closed', () => app.quit());
