// =============================================================================
// obs.js -- everything that talks to OBS Studio.
//
// OBS has a built-in "WebSocket server": a way for other programs on this PC
// to send it commands like "start recording". It has to be switched on once
// inside OBS: Tools > WebSocket Server Settings > Enable WebSocket server.
//
// main.js uses the functions exported at the bottom of this file. The
// obs-websocket-js library does the low-level talking for us.
// =============================================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { default: OBSWebSocket } = require('obs-websocket-js');
const processes = require('./processes'); // our own processes.js, in this folder

// 127.0.0.1 is the numeric form of "localhost" (this PC). We use the number
// because the name can sometimes point at a different kind of address (IPv6)
// that OBS may not be listening on.
const OBS_PORT = 4455;
const OBS_URL = `ws://127.0.0.1:${OBS_PORT}`;
const CONNECT_TIMEOUT_MS = 5000; // give up on a single connection attempt after this long
const RETRY_MS = 1000;         // how often to try again while OBS isn't answering
const LOOK_EVERY_MS = 5000;    // while it isn't answering: how often to ask Windows whether OBS is running, and read OBS's log
const RELAUNCH_GAP_MS = 60000; // never start OBS twice within this long
const PASSWORD_RETRY_MS = 5000; // how often to try again after OBS refused the password
const READY_POLL_MS = 250;     // how often whenReady() looks whether OBS has become ready
const LOG_NAME_SLACK_MS = 2000; // a log's file name only says its time to the second
const NOT_READY_CODE = 207;    // OBS's "I'm still starting up" reply
const NOT_READY_RETRIES = 10;  // how many times to retry StartRecord in that case
// Launch options that only some versions of OBS have. Each is only used if
// the obs64.exe on this PC knows it (see launchFlags).
//   --disable-shutdown-check -> don't stop at the "OBS did not shut down
//                               properly, run in Safe Mode?" question
const OPTIONAL_LAUNCH_FLAGS = ['--disable-shutdown-check'];
const STOP_CHECK_MS = 250;     // how often to look whether OBS has finished writing the video
const STOP_ASK_EVERY = 8;      // ask OBS directly every this many looks (so every 2 seconds)
const STOP_WAIT_MAX_MS = 30 * 60 * 1000; // stop waiting for OBS to finish after this long (30 minutes)
const AUTH_FAILED_CODE = 4009; // OBS's "wrong password" close code
const LOG_STOP_TRIES = 20;     // how many times to look in OBS's log for the end of a recording
const LOG_STOP_RETRY_MS = 500; // how long to wait between those looks (so about 10 seconds in all)

// The two requests that let us read and change the folder OBS records into.
// Older versions of OBS don't have them, so we check before relying on them.
const DIRECTORY_REQUESTS = ['GetRecordDirectory', 'SetRecordDirectory'];

const obs = new OBSWebSocket(); // one connection object, reused for every session

// Pause for a given number of milliseconds. Use it as: await sleep(1000);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True if the error means "OBS answered, but didn't accept our password".
// In that case OBS IS running, so we must not try to launch it again.
function isPasswordError(err) {
  return err.code === AUTH_FAILED_CODE || /authentication/i.test(err.message);
}

// `password` is what we tried to connect with (undefined if settings.json has none).
function passwordError(err, password) {
  if (!password) {
    return new Error('OBS requires a password, but "obsPassword" in settings.json is empty. ' +
      'Copy the password from Tools > WebSocket Server Settings > Show Connect Info in OBS, ' +
      'or untick "Enable Authentication" there.');
  }
  return new Error(`OBS rejected the password (${err.message}). Check "obsPassword" in settings.json ` +
    'against Tools > WebSocket Server Settings > Show Connect Info in OBS.');
}

// One attempt at connecting. Normally this succeeds or fails within
// milliseconds, but if something answers on the port without speaking OBS's
// language the library would wait forever, so we add our own time limit.
function tryConnect(password) {
  let timer;
  const timeLimit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no answer from OBS in time')), CONNECT_TIMEOUT_MS);
  });
  // Promise.race finishes as soon as either one does: the connection or the time limit.
  return Promise.race([obs.connect(OBS_URL, password), timeLimit])
    .finally(() => clearTimeout(timer));
}

// ---- Keeping a connection to OBS open -------------------------------------------
// From the moment the app opens, keepConnected() below works in the
// background: it starts OBS if it isn't running, then keeps trying to connect
// for as long as it takes. OBS can need minutes to load on a busy PC, so there
// is no time limit. If the connection is lost later, it starts trying again.
//
// What it knows at any moment is in `watch`; main.js reads it with getState().
const watch = {
  state: 'checking',   // 'checking', 'loading', 'not-running', 'ready' or 'error'
  reason: null,        // for 'error' and 'not-running': what is wrong, as a sentence
  since: Date.now(),   // when OBS started loading, as far as we know
  startedByApp: false, // true if this app started the OBS that is running now
  obsStartedAt: null,  // when that OBS was started (in milliseconds), or null if we don't know
  readySeconds: null,  // how long OBS took to answer, the last time it became ready (0 = at the very first try)
};
let connected = false;         // true while OBS is connected AND has finished loading
let watching = false;          // true once keepConnected() has been started
let watchSettings = null;      // the settings in use (see updateSettings)
let watchHooks = null;         // the functions main.js gave to keepConnected()
let lastConnectError = null;   // the error from the latest connection attempt that failed
let answeredAtFirstTry = true; // false once a connection attempt has failed
let lookedOnce = false;        // true once we know for sure whether OBS was running when the app opened
let lastLookAt = 0;            // when look() last ran (0 = run it at the next chance)
let lastLaunchAt = 0;          // when this app last started OBS (0 = never)
let startTimeAsked = false;    // true once Windows was asked when the running OBS was started
let ownRecording = false;      // true from this app's StartRecord until that recording has stopped
let outsideHook = null;        // the function main.js gave to onOutsideRecording()

function setState(state, reason = null) {
  if (watch.state === state && watch.reason === reason) return;
  watch.state = state;
  watch.reason = reason;
  if (watchHooks) watchHooks.onChange();
}

// A copy of `watch`, plus loadingMs: how long OBS has been loading so far.
function getState() {
  return { ...watch, loadingMs: Date.now() - watch.since };
}

// Is OBS connected and finished loading, right now?
function isReady() {
  return connected;
}

// Use these settings from now on (main.js reads settings.json again at the
// start of every session, so a corrected password or path is picked up).
function updateSettings(settings) {
  watchSettings = settings;
}

// Look at OBS at the next chance instead of waiting for the next 5 seconds to pass.
function lookSoon() {
  lastLookAt = 0;
}

// Wait until OBS is ready, however long that takes. isCancelled() is asked
// while we wait; if it returns true we stop waiting and throw.
async function whenReady(isCancelled = () => false) {
  while (!connected) {
    if (isCancelled()) throw new Error('Stopped while waiting for OBS.');
    await sleep(READY_POLL_MS);
  }
}

// OBS's WebSocket server isn't answering. Collect what can be found out about
// why, without guessing: is the OBS program running, how long has it been
// loading, is anything listening on OBS's port, and what does OBS's own log
// say?
//   when     -> a few words saying at which point this check was made
//   withPort -> also ask Windows what is listening on OBS's port (slower)
// Never throws: anything that couldn't be found out is left as null, with the
// reason next to it.
async function checkWhyNoAnswer(when, withPort = true) {
  const check = {
    checkedAt: new Date(),
    when,
    connectError: lastConnectError ? lastConnectError.message : null,
    obsProcessName: path.basename(watchSettings.obsPath), // e.g. "obs64.exe"
    obsRunning: null,      // true / false, or null if we couldn't find out
    obsRunningError: null,
    startedByApp: watch.startedByApp,
    loadingSeconds: Math.round((Date.now() - watch.since) / 1000),
    port: OBS_PORT,
    portListener: null,    // { pid, processName }, or null if nothing is listening
    portListenerError: null,
    log: null,             // { file, lastLine, problem }, or null if OBS has no log yet
    logError: null,
  };
  try {
    check.obsRunning = await processes.isRunning(check.obsProcessName);
  } catch (e) {
    check.obsRunningError = e.message;
  }
  if (withPort) {
    try {
      check.portListener = await processes.findPortListener(OBS_PORT);
    } catch (e) {
      check.portListenerError = e.message;
    }
  }
  if (check.obsRunning !== false) { // the log of an OBS that isn't running says nothing about now
    try {
      check.log = await readStartupLog();
    } catch (e) {
      check.logError = e.message;
    }
  }
  return check;
}

// While OBS runs it keeps an empty marker file ("run_...") in this folder, and
// deletes it when it closes properly. If a marker is still there the next
// time OBS starts, OBS concludes that it crashed and stops at its "run in Safe
// Mode?" question. Deleting the leftover markers before we start OBS makes it
// start normally. Only call this when OBS is definitely NOT running: a marker
// belonging to a running OBS must stay.
// Returns the names of the markers it deleted. Never throws: if this fails,
// OBS just asks its question as before.
async function clearCrashMarkers() {
  const deleted = [];
  if (!process.env.APPDATA) return deleted;
  const folder = path.join(process.env.APPDATA, 'obs-studio', '.sentinel');
  let names;
  try {
    names = await fs.promises.readdir(folder);
  } catch (err) {
    return deleted; // no such folder - nothing to clear
  }
  for (const name of names) {
    if (!name.startsWith('run_')) continue;
    try {
      await fs.promises.unlink(path.join(folder, name));
      deleted.push(name);
    } catch (err) {
      // couldn't delete this one - carry on with the rest
    }
  }
  return deleted;
}

// The options to start OBS with.
//   --minimize-to-tray -> start as an icon near the clock instead of a window
// plus each of OPTIONAL_LAUNCH_FLAGS that this version of OBS knows. A program
// file contains the names of its own options as plain text, so we look for
// the name inside obs64.exe. (OBS 32 has no option to skip the Safe Mode
// question, which is why clearCrashMarkers exists.)
const knownLaunchFlags = new Map(); // obsPath -> the optional flags found in that file
async function launchFlags(obsPath) {
  if (!knownLaunchFlags.has(obsPath)) {
    let found = [];
    try {
      const program = await fs.promises.readFile(obsPath);
      found = OPTIONAL_LAUNCH_FLAGS.filter((flag) => program.includes(flag.slice(2))); // without the leading "--"
    } catch (err) {
      // the file can't be read - launching will say why
    }
    knownLaunchFlags.set(obsPath, found);
  }
  return ['--minimize-to-tray', ...knownLaunchFlags.get(obsPath)];
}

// Start the OBS program. Resolves once Windows has started it; rejects if it
// couldn't be started at all (for example, the path is wrong).
//   cwd      -> OBS looks for its own files relative to the folder it is
//               started from, so it must be started from its own folder
//   detached -> OBS is its own program, not a part of this app, so it keeps
//               running if this app closes
//   stdio    -> we don't need to read anything OBS prints
function launchObs(obsPath, flags) {
  return new Promise((resolve, reject) => {
    const child = spawn(obsPath, flags, {
      cwd: path.dirname(obsPath),
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref(); // don't keep this app alive just because OBS is open
      resolve();
    });
  });
}

// While OBS is still loading, its WebSocket server already accepts connections
// but answers every request with "not ready". Keep asking a harmless question
// (GetVersion) until it gets a real answer, so whatever is asked next works.
// There is no limit: it only stops (by throwing) if the connection is lost.
async function waitUntilReady() {
  for (;;) {
    try {
      await obs.call('GetVersion');
      return;
    } catch (err) {
      if (err.code !== NOT_READY_CODE) throw err;
    }
    await sleep(RETRY_MS);
  }
}

// OBS didn't answer: find out whether it is running, start it if it isn't
// (and we may), and set the state to match. Called every few seconds by
// keepConnected() for as long as OBS isn't answering.
async function look() {
  // "Connection refused" already tells us nothing is listening on the port,
  // so Windows only needs asking about the port for any other kind of failure.
  const refused = lastConnectError && /ECONNREFUSED/.test(lastConnectError.message);
  const check = await checkWhyNoAnswer('background check', !refused);
  const name = check.obsProcessName;

  if (check.obsRunning === null) {
    setState('error', `Windows couldn't be asked whether ${name} is running (${check.obsRunningError})`);
    return;
  }
  // OBS is started by us in two cases only: it wasn't running when the app
  // opened, or a session is waiting for it. If you close OBS yourself while
  // nothing is being recorded, it stays closed.
  const mayLaunch = !lookedOnce || watchHooks.wantsLaunch();
  lookedOnce = true;

  if (check.obsRunning) {
    // If something else started it (you, or Windows at sign-in), ask Windows
    // when - once - so the loading clock and the choice of log file are right.
    if (!watch.obsStartedAt && !startTimeAsked) {
      startTimeAsked = true;
      const startedAt = await processes.startTime(name);
      if (startedAt) {
        watch.obsStartedAt = startedAt.getTime();
        watch.since = watch.obsStartedAt;
        try {
          check.log = await readStartupLog(); // read again: we may now know better which log is this OBS's
        } catch (e) {
          check.logError = e.message;
        }
      }
    }
    const listener = check.portListener;
    const portTaken = listener && listener.processName && listener.processName.toLowerCase() !== name.toLowerCase()
      ? `Port ${OBS_PORT} is in use by another program (${listener.processName}, process ID ${listener.pid}), so OBS's WebSocket server can't use it. Close that program, then restart OBS`
      : null;
    const problem = (check.log && check.log.problem) || portTaken;
    setState(problem ? 'error' : 'loading', problem);
    return;
  }

  // OBS is not running.
  watch.startedByApp = false;
  watch.obsStartedAt = null;
  startTimeAsked = false;
  const justLaunched = lastLaunchAt !== 0 && Date.now() - lastLaunchAt < RELAUNCH_GAP_MS;
  if (!mayLaunch || justLaunched) {
    setState('not-running', justLaunched ? 'this app started it a moment ago, but it has closed again' : null);
    return;
  }

  const settings = watchSettings;
  const deletedMarkers = await clearCrashMarkers();
  const flags = await launchFlags(settings.obsPath);
  lastLaunchAt = Date.now();
  try {
    await launchObs(settings.obsPath, flags);
  } catch (err) {
    setState('error', `OBS could not be started from "${settings.obsPath}" (${err.message}). Check "obsPath" in settings.json`);
    return;
  }
  watch.since = lastLaunchAt;
  watch.obsStartedAt = lastLaunchAt;
  watch.startedByApp = true;
  setState('loading');
  watchHooks.onLaunch({ obsPath: settings.obsPath, flags, deletedMarkers });
}

// Start the background work described above. Call it once, when the app opens.
//   settings -> the settings to start with (see updateSettings)
//   hooks.wantsLaunch()    -> asked when OBS isn't running: true if a session is waiting for OBS
//   hooks.onChange()       -> called whenever the state changes (read it with getState())
//   hooks.onLaunch(detail) -> called when this app has started OBS
// It never returns and never throws.
async function keepConnected(settings, hooks) {
  watchSettings = settings;
  if (watching) return;
  watching = true;
  watchHooks = hooks;

  // The connection closed (OBS was shut, or crashed): start looking again.
  // This event also fires for our own failed attempts, which `connected` filters out.
  obs.on('ConnectionClosed', () => {
    if (!connected) return;
    connected = false;
    ownRecording = false; // after a reconnect we can't tell any more whose recording is running
    watch.since = Date.now();
    // It may be a different OBS that answers next time: forget what we knew about this one.
    watch.startedByApp = false;
    watch.obsStartedAt = null;
    startTimeAsked = false;
    lastLookAt = 0;
    setState('checking');
  });

  // Every change in OBS's recording, whoever caused it. The ones that don't
  // belong to this app's own recording are passed on to main.js.
  obs.on('RecordStateChanged', (event) => {
    const mine = ownRecording;
    if (event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') ownRecording = false;
    if (!mine && outsideHook) outsideHook({ kind: 'event', event });
  });

  for (;;) {
    if (connected) {
      await sleep(RETRY_MS);
      continue;
    }
    // OBS can be set up with no password; the library wants `undefined` then.
    const password = watchSettings.obsPassword || undefined;
    try {
      await tryConnect(password);
      await waitUntilReady();
      await checkForOutsideRecording();
      // If we don't know yet when this OBS was started (it was already open
      // and answered straight away), ask Windows now: that is what tells us
      // which log file is this OBS's (see findObsLogFile).
      if (!watch.obsStartedAt) {
        const startedAt = await processes.startTime(path.basename(watchSettings.obsPath));
        if (startedAt) watch.obsStartedAt = startedAt.getTime();
      }
      connected = true;
      watch.readySeconds = answeredAtFirstTry ? 0 : Math.round((Date.now() - watch.since) / 100) / 10;
      setState('ready');
      continue;
    } catch (err) {
      lastConnectError = err;
      answeredAtFirstTry = false;
      try {
        await obs.disconnect(); // tidy up a half-made connection
      } catch (e) {
        // there was none - nothing to do
      }
    }

    try {
      if (isPasswordError(lastConnectError)) {
        // OBS answered, so it IS running: don't look for it or start it.
        setState('error', passwordError(lastConnectError, password).message);
        await sleep(PASSWORD_RETRY_MS);
        continue;
      }
      if (Date.now() - lastLookAt >= LOOK_EVERY_MS) {
        await look();
        lastLookAt = Date.now();
      }
    } catch (err) {
      setState('error', `Checking on OBS failed (${err.message})`);
    }
    await sleep(RETRY_MS);
  }
}

// ---- Recordings this app did not start ----------------------------------------
// You (or another program) can start a recording in OBS yourself. That video
// is not a session's, and the app must not mistake it for one - but it
// shouldn't go unnoticed either. main.js is told about it through the
// function given to onOutsideRecording():
//   { kind: 'already-recording' }  -> OBS was already recording when we connected
//   { kind: 'event', event }       -> a RecordStateChanged event for that recording;
//                                     event.outputPath is the file once it has stopped
function onOutsideRecording(callback) {
  outsideHook = callback;
}

// Just connected: is OBS recording already? It can't be this app's recording
// (that needs a connection to start), unless the connection dropped in the
// middle of a session - so the message in main.js allows for that too.
// Never throws: if OBS can't be asked, we simply don't know.
async function checkForOutsideRecording() {
  try {
    if (await isRecording() && outsideHook) outsideHook({ kind: 'already-recording' });
  } catch (err) {
    // couldn't ask - nothing to report
  }
}

// OBS sends a "RecordStateChanged" event every time its recording changes
// state (starting, started, stopping, stopped). This helper waits for the
// first such event that passes `isWanted`, then calls `callback` with the
// time it arrived and the event itself. It returns a function that cancels the wait.
let cancelStateWaits = []; // cancel functions for waits that haven't finished yet

function onceRecordState(isWanted, callback) {
  const handler = (event) => {
    if (!isWanted(event)) return;
    cancel();
    callback(new Date(), event);
  };
  const cancel = () => {
    obs.off('RecordStateChanged', handler);
    cancelStateWaits = cancelStateWaits.filter((c) => c !== cancel);
  };
  obs.on('RecordStateChanged', handler);
  cancelStateWaits.push(cancel);
  return cancel;
}

// Tell OBS to start recording. Returns the Date at which the command was sent.
// Right after OBS starts up it may answer "not ready yet", so we retry a few
// times in that case.
//
// "Command sent" and "actually recording" are not the same moment: OBS needs
// a little time to get its video encoder going. When OBS reports that the
// recording is really running (RecordStateChanged with outputActive true),
// onActuallyStarted is called with that time and the event (some versions of
// OBS put the new file's path in it, as event.outputPath).
async function startRecord(onActuallyStarted) {
  // Start listening BEFORE sending the command, so we can't miss the event.
  const cancel = onceRecordState((event) => event.outputActive, onActuallyStarted);
  ownRecording = true; // from here on, the recording's events are this app's own

  for (let attempt = 1; ; attempt++) {
    const sentAt = new Date();
    try {
      await obs.call('StartRecord');
      return sentAt;
    } catch (err) {
      if (err.code !== NOT_READY_CODE || attempt >= NOT_READY_RETRIES) {
        cancel();
        ownRecording = false;
        throw err;
      }
      await sleep(RETRY_MS);
    }
  }
}

// Tell OBS to stop recording, then wait until it has completely finished
// writing the file. Returns:
//   videoFile        -> the full path of the saved video file, as OBS reports it
//   videoFileFrom    -> where that path came from: 'RecordStateChanged event'
//                       (sent when the file is finished - preferred) or
//                       'StopRecord reply'; null if OBS gave no path at all
//   confirmedStopped -> true if OBS reported that it has completely finished
//                       writing the file
//   notStoppedReason -> if it didn't, why we stopped waiting
//
// "Stop" is not instant. OBS first has to finish encoding the video it has
// already captured, and on a busy PC that backlog can take MINUTES. Until it
// is done the file is incomplete and Windows won't let anyone move or rename
// it. So we wait for as long as OBS says it is still working:
//   - normally OBS tells us with a RecordStateChanged "STOPPED" event;
//   - as a backup (in case that event gets lost) we also ask it every 2
//     seconds whether the recording output is still active.
// onWaiting(ms) is called every 2 seconds with how long we've waited so far.
async function stopRecord(onWaiting = () => {}) {
  // Start listening BEFORE sending the command, so we can't miss the event.
  let stoppedEventSeen = false;
  let stoppedEventPath = null; // the finished file, as the "stopped" event names it
  const cancel = onceRecordState(
    (event) => event.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    (_at, event) => {
      stoppedEventSeen = true;
      stoppedEventPath = event.outputPath || null;
    });

  let outputPath;
  try {
    ({ outputPath } = await obs.call('StopRecord'));
  } catch (err) {
    cancel();
    ownRecording = false; // OBS refused, so there is no recording of ours to wait for
    throw err;
  }

  const startedWaitingAt = Date.now();
  let confirmedStopped = false;
  let notStoppedReason = null;
  for (let look = 1; ; look++) {
    if (stoppedEventSeen) {
      confirmedStopped = true;
      break;
    }
    const waitedMs = Date.now() - startedWaitingAt;
    if (waitedMs >= STOP_WAIT_MAX_MS) {
      notStoppedReason = `OBS was still writing the video after ${STOP_WAIT_MAX_MS / 60000} minutes`;
      break;
    }
    if (look % STOP_ASK_EVERY === 0) {
      onWaiting(waitedMs);
      try {
        if (!(await isRecording())) {
          confirmedStopped = true;
          break;
        }
      } catch (err) {
        // We can't ask any more, so we'll never hear the answer either.
        notStoppedReason = `the connection to OBS was lost while it was finishing the video (${err.message})`;
        break;
      }
    }
    await sleep(STOP_CHECK_MS);
  }
  cancel();
  const videoFile = stoppedEventPath || outputPath || null;
  let videoFileFrom = null;
  if (stoppedEventPath) videoFileFrom = 'RecordStateChanged event';
  else if (outputPath) videoFileFrom = 'StopRecord reply';
  return { videoFile, videoFileFrom, confirmedStopped, notStoppedReason };
}

// ---- The folder OBS records into ---------------------------------------------

// Ask OBS which version it is and whether it has the two "recording folder"
// requests. GetVersion's reply includes the list of every request this OBS
// understands. Returns:
//   obsVersion, webSocketVersion -> for messages
//   missingDirectoryRequests     -> the requests it does NOT have ([] = all there)
async function getVersionInfo() {
  const version = await obs.call('GetVersion');
  const available = version.availableRequests || [];
  return {
    obsVersion: version.obsVersion,
    webSocketVersion: version.obsWebSocketVersion,
    missingDirectoryRequests: DIRECTORY_REQUESTS.filter((request) => !available.includes(request)),
  };
}

// Is OBS's recording output active right now? This stays true while OBS is
// still finishing a recording it has been told to stop.
async function isRecording() {
  const status = await obs.call('GetRecordStatus');
  return status.outputActive;
}

// The folder OBS currently saves recordings into (Settings > Output > Recording Path).
async function getRecordDirectory() {
  const reply = await obs.call('GetRecordDirectory');
  return reply.recordDirectory;
}

// Change that folder. It only affects recordings started afterwards; a
// recording that is already running keeps the folder it started in.
async function setRecordDirectory(recordDirectory) {
  await obs.call('SetRecordDirectory', { recordDirectory });
}

// Change that folder using a short-lived connection of its own, separate from
// the one a session uses. This is for putting the folder back when no session
// is running (see restoreLeftoverRecordDirectory in main.js). It does NOT
// start OBS; it throws if OBS isn't running or doesn't answer in time.
async function setRecordDirectoryOnce(settings, recordDirectory) {
  const connection = new OBSWebSocket();
  let timer;
  const timeLimit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no answer from OBS in time')), CONNECT_TIMEOUT_MS);
  });
  const work = (async () => {
    await connection.connect(OBS_URL, settings.obsPassword || undefined);
    await connection.call('SetRecordDirectory', { recordDirectory });
  })();
  try {
    await Promise.race([work, timeLimit]);
  } finally {
    clearTimeout(timer);
    try {
      await connection.disconnect();
    } catch (err) {
      // already disconnected - nothing to do
    }
  }
}

// ---- OBS's own log -------------------------------------------------------------
// OBS keeps a log file for every time it is started, named after the moment
// it started, e.g. "2026-10-12 13-24-57.txt". When a recording ends, OBS
// writes lines like these into it:
//   ==== Recording Stop ================================================
//   Video stopped, number of skipped frames due to encoding lag: 157961/173389 (91.1%)
// A "skipped" frame is one the video encoder had no time for, so OBS repeated
// the previous picture instead. Many of them make the video choppy.
// (OBS leaves the second line out altogether when it skipped nothing.)

// The time in a log's file name ("2026-10-12 13-24-57.txt" is in your own
// time zone), as a number of milliseconds. NaN if the name isn't of that shape.
function logNameTime(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})\.txt$/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}

// The full path of the log of the OBS that is running now, or null if it has
// no log (yet). Throws an Error saying why if the log folder can't be read.
//
// Usually that is the newest log. But starting OBS a second time while it is
// already open leaves a newer log behind that belongs to nothing, so when we
// know when the running OBS was started we take the first log made after that.
async function findObsLogFile() {
  if (!process.env.APPDATA) throw new Error('Windows didn\'t say where the AppData folder is');
  const folder = path.join(process.env.APPDATA, 'obs-studio', 'logs');
  let names;
  try {
    // The names start with the date and time, so alphabetical order is oldest first.
    names = (await fs.promises.readdir(folder)).filter((name) => name.endsWith('.txt')).sort();
  } catch (err) {
    throw new Error(`OBS's log folder ${folder} couldn't be read (${err.message})`);
  }
  if (names.length === 0) return null;
  if (watch.obsStartedAt) {
    const mine = names.find((name) => logNameTime(name) >= watch.obsStartedAt - LOG_NAME_SLACK_MS);
    return mine ? path.join(folder, mine) : null;
  }
  return path.join(folder, names[names.length - 1]);
}

// Every line of that log, without the empty ones. Returns { file, lines }, or
// null if OBS has no log yet.
async function readObsLog() {
  const file = await findObsLogFile();
  if (!file) return null;
  const lines = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '');
  return { file, lines };
}

// A log line without the time OBS puts in front of it ("21:18:58.356: ").
function withoutLogTime(line) {
  return line.replace(/^\d\d:\d\d:\d\d\.\d+: /, '').trim();
}

// Does OBS's log show a reason why its WebSocket server will never answer?
// Returns that reason as a sentence, or null if the log shows none. These are
// the lines it goes by (copied from real logs of OBS 32):
//   Crash or unclean shutdown detected
//       -> OBS found it wasn't closed properly, and is about to ask its
//          "run in Safe Mode?" question. Its next line is the answer:
//   [Safe Mode] Normal launch selected, loading third-party plugins is enabled
//   ==== Startup complete ===============================================
//   [obs-websocket] [WebSocketServer::Start] Server started successfully on port 4455. ...
function problemInLog(lines) {
  const safeModeLines = lines.filter((line) => /safe mode/i.test(line));
  const lastSafeMode = safeModeLines[safeModeLines.length - 1];
  if (lastSafeMode && !/normal launch/i.test(lastSafeMode)) {
    return `OBS is running in Safe Mode, which switches its WebSocket server off (OBS's log says "${withoutLogTime(lastSafeMode)}"). ` +
      'Exit OBS and start it again, choosing Normal Mode';
  }
  const lastLine = lines[lines.length - 1] || '';
  if (/crash or unclean shutdown detected/i.test(lastLine)) {
    return 'OBS is waiting at its "OBS did not shut down properly" question (the last line of its log is ' +
      `"${withoutLogTime(lastLine)}"). Open OBS and choose Normal Mode`;
  }
  const startupComplete = lines.some((line) => line.includes('Startup complete'));
  const serverStarted = lines.some((line) => line.includes('[obs-websocket]') && line.includes('Server started successfully'));
  if (startupComplete && !serverStarted) {
    const webSocketLines = lines.filter((line) => line.includes('[obs-websocket]'));
    const last = webSocketLines[webSocketLines.length - 1];
    return 'OBS has finished starting, but its log doesn\'t show its WebSocket server starting ' +
      `(${last ? `its last WebSocket line is "${withoutLogTime(last)}"` : 'it has no WebSocket lines at all'}). ` +
      'In OBS, open Tools > WebSocket Server Settings and tick "Enable WebSocket server"';
  }
  return null;
}

// What the log of the OBS that is starting up says. Returns
// { file, lastLine, problem } (see problemInLog), or null if OBS has no log yet.
async function readStartupLog() {
  const log = await readObsLog();
  if (!log) return null;
  const lastLine = log.lines.length > 0 ? withoutLogTime(log.lines[log.lines.length - 1]) : null;
  return { file: log.file, lastLine, problem: problemInLog(log.lines) };
}

// ---- The video encoder ----------------------------------------------------------
// The "encoder" is the part of OBS that squeezes the picture into the video
// file. Hardware encoders do that on a chip made for it and keep up easily:
// NVENC (NVIDIA graphics cards), QuickSync (Intel) and AMF (AMD). Software
// encoders (x264, and the AV1 ones called SVT-AV1 and AOM) use the processor,
// which is already busy with the game, so frames get skipped and the video
// turns choppy.

// What kind of encoder an OBS encoder name is. OBS uses different names for
// the same encoder in different places, e.g. "obs_nvenc_h264_tex" (Advanced
// mode), "nvenc" (Simple mode), "h264_nvenc" (Custom Output (FFmpeg)) or
// "obs-nvenc" (its log), so this goes by the parts of the name. Returns:
//   kind  -> 'hardware', 'software', 'none' (no encoder chosen) or 'other' (not one we know)
//   label -> a readable name, e.g. "NVIDIA NVENC H.264" or "x264"
function describeEncoder(name) {
  const id = String(name || '').trim();
  if (id === '' || id.toLowerCase() === 'none') return { kind: 'none', label: 'no encoder' };
  let codec = 'H.264';
  if (/hevc|h265|265/i.test(id)) codec = 'HEVC';
  if (/av1/i.test(id)) codec = 'AV1';
  if (/nvenc/i.test(id)) return { kind: 'hardware', label: `NVIDIA NVENC ${codec}` };
  if (/qsv|quicksync/i.test(id)) return { kind: 'hardware', label: `Intel QuickSync ${codec}` };
  if (/amf|^amd/i.test(id)) return { kind: 'hardware', label: `AMD AMF ${codec}` };
  if (/x264/i.test(id)) return { kind: 'software', label: 'x264' };
  if (/svt/i.test(id)) return { kind: 'software', label: 'SVT-AV1 (software AV1)' };
  if (/aom|rav1e/i.test(id) || codec === 'AV1') return { kind: 'software', label: 'AOM AV1 (software AV1)' };
  return { kind: 'other', label: id };
}

// One setting of OBS's current profile (the same values as in its basic.ini).
async function profileParameter(category, name) {
  const reply = await obs.call('GetProfileParameter', { parameterCategory: category, parameterName: name });
  return reply.parameterValue ?? reply.defaultParameterValue ?? null;
}

// Which video encoder is OBS set to record with? Returns:
//   encoder     -> its name as OBS stores it, e.g. "obs_nvenc_h264_tex" or "obs_x264"
//                  (null or "" if none is chosen)
//   outputMode  -> "Simple" or "Advanced" (Settings > Output > Output Mode)
//   kind, label -> what describeEncoder says about it
//   isNvenc     -> true if that is an NVENC encoder
//   loadedInObs -> whether this OBS actually has that encoder: true, false, or
//                  null if its log doesn't say. (If a hardware encoder failed to
//                  load when OBS started, the setting still names it but OBS
//                  can't use it, and resets the choice.)
//   loadProblem -> for an encoder that isn't there: the log line that says why
// Throws if OBS can't be asked.
async function getRecordingEncoder() {
  const outputMode = await profileParameter('Output', 'Mode');
  let encoder;
  if (String(outputMode).toLowerCase() === 'advanced') {
    if ((await profileParameter('AdvOut', 'RecType')) === 'FFmpeg') {
      encoder = await profileParameter('AdvOut', 'FFVEncoder'); // the "Custom Output (FFmpeg)" recording type
    } else {
      encoder = await profileParameter('AdvOut', 'RecEncoder');
      // "none" means "use the stream encoder" there.
      if (!encoder || encoder === 'none') encoder = await profileParameter('AdvOut', 'Encoder');
    }
  } else {
    // Simple mode: the quality "Same as stream" records with the stream encoder.
    const quality = await profileParameter('SimpleOutput', 'RecQuality');
    encoder = await profileParameter('SimpleOutput', quality === 'Stream' ? 'StreamEncoder' : 'RecEncoder');
  }
  const { kind, label } = describeEncoder(encoder);
  const isNvenc = /nvenc/i.test(encoder || '');

  // OBS lists the encoders it really has in its log when it starts:
  //   Available Encoders:
  //     Video Encoders:
  //   	- obs_nvenc_h264_tex (NVIDIA NVENC H.264)
  //     Audio Encoders:
  let loadedInObs = null;
  let loadProblem = null;
  try {
    const log = await readObsLog();
    const lines = log ? log.lines.map(withoutLogTime) : [];
    const from = lines.indexOf('Video Encoders:');
    const to = lines.indexOf('Audio Encoders:');
    if (from !== -1 && to > from) {
      const available = lines.slice(from + 1, to).map((line) => (line.match(/^- (\S+)/) || [])[1]).filter(Boolean);
      if (kind === 'none') {
        // nothing chosen: nothing to look for
      } else if (available.includes(encoder)) {
        loadedInObs = true;
      } else if (kind === 'hardware') {
        // Simple mode calls them just "nvenc", "qsv" or "amd": look for any of the same make and codec.
        loadedInObs = available.some((id) => describeEncoder(id).label === label);
      } else if (String(outputMode).toLowerCase() === 'advanced') {
        loadedInObs = false;
      }
    }
    if (kind === 'hardware' && loadedInObs === false) {
      const make = /nvenc/i.test(encoder) ? /nvenc/i : /qsv|quicksync/i.test(encoder) ? /qsv|quicksync/i : /amf|amd/i;
      loadProblem = lines.find((line) => make.test(line) && /crash|not supported|failed/i.test(line)) || null;
    }
  } catch (err) {
    // the log can't be read: loadedInObs stays null ("don't know")
  }
  return { encoder, outputMode, kind, label, isNvenc, loadedInObs, loadProblem };
}

// Which encoder did OBS really start the recording with? When a recording
// starts, the encoder writes its settings into OBS's log under its own name:
//   [obs-nvenc: 'advanced_video_recording'] settings:
//   [x264 encoder: 'advanced_video_recording'] preset: veryfast
// Returns that name ("obs-nvenc", "x264 encoder"), or null if the log doesn't say.
async function readEncoderInUse() {
  try {
    const log = await readObsLog();
    if (!log) return null;
    let name = null;
    for (const line of log.lines) {
      const match = line.match(/\[([^\]:']+): '[a-z_]*video_recording'\]/);
      if (match) name = match[1].trim(); // keep the last one: it belongs to the newest recording
    }
    return name;
  } catch (err) {
    return null;
  }
}

// Read how many frames OBS skipped in the recording that has just stopped.
// Returns { percent, skipped, total, logFile }, or throws an Error saying why
// it couldn't be found out. `percent` is 0 if OBS skipped nothing.
// Call it only once OBS has reported that the recording has fully stopped.
async function readSkippedFrames() {
  const logFile = await findObsLogFile();
  if (!logFile) throw new Error('the log file of the OBS that is running now couldn\'t be found');

  // The lines about THIS recording are the ones after the last "Recording Start".
  const readThisRecording = async () => {
    const lines = (await fs.promises.readFile(logFile, 'utf8')).split(/\r?\n/);
    let start = -1;
    lines.forEach((line, i) => { if (line.includes('==== Recording Start')) start = i; });
    return start === -1 ? null : lines.slice(start);
  };

  // OBS writes these lines a moment after it tells us it has stopped, so look
  // a few times before giving up.
  let lines = null;
  for (let attempt = 1; attempt <= LOG_STOP_TRIES; attempt++) {
    lines = await readThisRecording();
    if (lines && lines.some((line) => line.includes('==== Recording Stop'))) break;
    lines = null;
    await sleep(LOG_STOP_RETRY_MS);
  }
  if (!lines) throw new Error(`OBS's log (${logFile}) doesn't show this recording stopping`);

  // The "skipped frames" line can land just after "Recording Stop": give it a
  // moment, then read once more.
  await sleep(LOG_STOP_RETRY_MS);
  lines = (await readThisRecording()) || lines;

  for (const line of lines) {
    const match = line.match(/skipped frames due to encoding lag: (\d+)\/(\d+)/);
    if (!match) continue;
    const skipped = Number(match[1]);
    const total = Number(match[2]);
    if (!(total > 0)) break;
    return { percent: Math.round((skipped / total) * 1000) / 10, skipped, total, logFile };
  }
  return { percent: 0, skipped: 0, total: null, logFile }; // no such line: nothing was skipped
}

// A session is over: stop waiting for any recording events on its behalf.
// The connection itself stays open, ready for the next session.
function forgetRecordWaits() {
  for (const cancel of cancelStateWaits) cancel();
}

// Call `callback` whenever the connection to OBS closes, for any reason
// (including failed connection attempts).
function onConnectionClosed(callback) {
  obs.on('ConnectionClosed', callback);
}

module.exports = {
  keepConnected, updateSettings, getState, isReady, whenReady, lookSoon, checkWhyNoAnswer,
  startRecord, stopRecord, forgetRecordWaits, onConnectionClosed, onOutsideRecording,
  getVersionInfo, isRecording, getRecordDirectory, setRecordDirectory, setRecordDirectoryOnce,
  getRecordingEncoder, describeEncoder, readEncoderInUse, readSkippedFrames,
};
