// =============================================================================
// no_game.js -- sessions in which no game happened.
//
// A session with no game is not deleted straight away: it is moved into
// <sessionsRoot>\_no_game. Anything in there for longer than
// "noGameRetentionDays" (settings.json) is deleted when the app starts, and
// the "Clean up" button lists it so it can be deleted or restored by hand.
// Everything that is moved, deleted or restored gets a line in
// <sessionsRoot>\_no_game_log.txt.
//
// This file is plain Node.js (no Electron), so it can be tried out on fake
// session folders: see test_no_game.js.
//
// SAFETY: the only thing this file ever deletes is a folder or file that sits
// directly inside <sessionsRoot>\_no_game (checked on the real paths, after
// any shortcuts are followed), contains no links to other places, is not on
// the "noGameKeep" list and is not a Riot or Vanguard path. The caller also
// says, just before each deletion, whether deleting is allowed right now
// (never while a session is recording).
// =============================================================================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const NO_GAME_FOLDER_NAME = '_no_game';
const LOG_FILE_NAME = '_no_game_log.txt';   // next to _no_game, never inside it
const MARKER_FILE_NAME = 'no_game.json';    // written into each moved folder: when and why it was moved
const MAX_GAME_SECONDS = 60;                // a game shorter than this, with nothing in it, counts as no game
const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY_TRIES = 10;                      // a move is retried this often if Windows says "in use"
const BUSY_RETRY_MS = 500;

// Events that happen in every game, even one nobody played in. Any other
// event (a kill, a death, a turret, a dragon, ... or one we don't know)
// means something happened, so the session is kept.
const NOT_GAMEPLAY_EVENTS = ['GameStart', 'MinionsSpawning', 'GameEnd'];

// Never delete anything whose real path looks like the game's own files.
const PROTECTED_PATH = /riot|vanguard/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusyError = (err) => ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const noGameFolder = (sessionsRoot) => path.join(sessionsRoot, NO_GAME_FOLDER_NAME);
const logFile = (sessionsRoot) => path.join(sessionsRoot, LOG_FILE_NAME);

// "2026-10-24 15:07:32" in your own time zone.
function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function readJsonFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // see loadSettings in main.js
  return JSON.parse(text);
}

// Add one line to _no_game_log.txt. Never throws: returns the error message
// if the line couldn't be written, or null.
function writeLog(sessionsRoot, text) {
  try {
    fs.appendFileSync(logFile(sessionsRoot), `${localStamp()}  ${text}\n`, 'utf8');
    return null;
  } catch (err) {
    return err.message;
  }
}

// "noGameRetentionDays" from settings.json: a whole number of days, 1 or more.
// Anything else gives null, which means "don't delete anything automatically"
// (when in doubt, keep).
function retentionDaysFrom(value) {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// ---- Was there a game? ------------------------------------------------------

// Does this session folder have something that only a real game leaves
// behind? Returns what it found, or null.
function gameLeftovers(folder) {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isFile() && /report/i.test(name) && /\.(json|md|pdf|docx)$/i.test(name)) return `it has a report (${name})`;
    if (entry.isFile() && /^highlights.*\.json$/i.test(name)) return `it has highlights (${name})`;
    if (entry.isFile() && sameName(name, 'end_stats.json')) return 'it has end_stats.json';
    if (entry.isDirectory() && sameName(name, 'clips') && fs.readdirSync(path.join(folder, name)).length > 0) {
      return 'it has exported clips';
    }
  }
  return null;
}

// Decide from a session folder's files whether a game happened in it.
// Returns { noGame: true/false, reason }. `reason` says why, either way.
// A session is "no game" only if it has no report, highlights, end_stats.json
// or clips, AND one of these:
//   - there is no live_log.json, or it has no events at all
//   - the game lasted under MAX_GAME_SECONDS and has no kill, death or objective event
// If anything can't be read, the answer is "keep".
function judgeSession(folder, { keepList = [] } = {}) {
  const keep = (reason) => ({ noGame: false, reason });
  try {
    if (keepList.some((name) => sameName(name, path.basename(folder)))) return keep('it is on the "noGameKeep" list in settings.json');
    const leftovers = gameLeftovers(folder);
    if (leftovers) return keep(leftovers);

    const logPath = path.join(folder, 'live_log.json');
    if (!fs.existsSync(logPath)) return { noGame: true, reason: 'no game log (live_log.json)' };
    let log;
    try {
      log = readJsonFile(logPath);
    } catch (err) {
      return keep(`live_log.json could not be read (${err.message}), so it can't be sure no game happened`);
    }
    if (!log || !Array.isArray(log.events)) return keep('live_log.json has no list of events, so it can\'t be sure no game happened');
    if (log.events.length === 0) return { noGame: true, reason: 'the game log has no events' };

    const gameplay = log.events.filter((e) => !NOT_GAMEPLAY_EVENTS.includes(e && e.event && e.event.EventName));
    if (gameplay.length > 0) return keep(`the game log has ${gameplay.length} kill, death or objective event${gameplay.length === 1 ? '' : 's'}`);

    const times = [...log.events, ...(Array.isArray(log.snapshots) ? log.snapshots : [])]
      .map((e) => (e ? Number(e.gameTime) : NaN))
      .filter((t) => Number.isFinite(t));
    const gameSeconds = times.length > 0 ? Math.max(...times) : 0;
    if (gameSeconds >= MAX_GAME_SECONDS) return keep(`the game ran for ${Math.round(gameSeconds)} seconds (${MAX_GAME_SECONDS} or more)`);
    return { noGame: true, reason: `the game ran for only ${Math.round(gameSeconds)} seconds, with no kills, deaths or objectives` };
  } catch (err) {
    return keep(`the folder could not be checked (${err.message})`);
  }
}

// ---- Folder helpers ---------------------------------------------------------

// The total size of a file or folder, in bytes. Links are not followed.
async function sizeOf(target) {
  const stats = await fsp.lstat(target);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const name of await fsp.readdir(target)) total += await sizeOf(path.join(target, name));
  return total;
}

// The first link (symbolic link or junction) inside a folder, or null. A
// link could lead out of _no_game, so a folder with one is never deleted.
async function findLink(target) {
  const stats = await fsp.lstat(target);
  if (stats.isSymbolicLink()) return target;
  if (!stats.isDirectory()) return null;
  for (const name of await fsp.readdir(target)) {
    const found = await findLink(path.join(target, name));
    if (found) return found;
  }
  return null;
}

// `wanted`, or `wanted_2`, `wanted_3`, ... if that already exists.
function freePath(wanted) {
  if (!fs.existsSync(wanted)) return wanted;
  for (let n = 2; ; n++) {
    if (!fs.existsSync(`${wanted}_${n}`)) return `${wanted}_${n}`;
  }
}

async function renameWhileBusy(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (!isBusyError(err) || attempt >= BUSY_TRIES) throw err;
      await sleep(BUSY_RETRY_MS);
    }
  }
}

// Is `child` inside `parent` (or the same)? Windows ignores capital letters.
function isInside(child, parent) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The folder was moved: session.json still has the old paths in it (the
// session's folder, its video and its game log), and "Analyze last match" and
// Export go by them. Point them at the new place. Returns null, or why it
// couldn't be done (the move itself still counts).
function fixSessionJsonPaths(newFolder, oldFolder) {
  const file = path.join(newFolder, 'session.json');
  if (!fs.existsSync(file)) return null;
  try {
    const info = readJsonFile(file);
    let changed = false;
    for (const key of ['sessionFolder', 'videoFile', 'logFile']) {
      const value = info[key];
      if (typeof value === 'string' && isInside(path.normalize(value), oldFolder)) {
        info[key] = path.join(newFolder, path.relative(oldFolder, path.normalize(value)));
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8');
    return null;
  } catch (err) {
    return `the paths in session.json could not be updated (${err.message})`;
  }
}

// ---- Moving into _no_game ---------------------------------------------------

// Move one session folder (directly inside sessionsRoot) into _no_game and
// write down when and why. `how` says who decided: 'automatic' or 'by hand'.
// Returns { to, sizeBytes, notes }. Throws if it couldn't be moved; nothing
// is changed then.
async function moveToNoGame(sessionsRoot, folder, reason, how = 'automatic') {
  const box = noGameFolder(sessionsRoot);
  if (!sameName(path.resolve(path.dirname(folder)), path.resolve(sessionsRoot))) {
    throw new Error(`${folder} is not directly inside ${sessionsRoot}`);
  }
  if (sameName(path.basename(folder), NO_GAME_FOLDER_NAME)) throw new Error('that is the _no_game folder itself');
  if (!(await fsp.lstat(folder)).isDirectory()) throw new Error(`${folder} is not a folder`);

  const sizeBytes = await sizeOf(folder);
  await fsp.mkdir(box, { recursive: true });
  const to = freePath(path.join(box, path.basename(folder)));
  await renameWhileBusy(folder, to);

  const notes = [];
  const marker = { movedAt: { iso: new Date().toISOString(), local: localStamp() }, reason, how, movedFrom: folder };
  try {
    fs.writeFileSync(path.join(to, MARKER_FILE_NAME), JSON.stringify(marker, null, 2), 'utf8');
  } catch (err) {
    notes.push(`${MARKER_FILE_NAME} could not be written (${err.message}), so it will not be deleted automatically - only by hand`);
  }
  const pathProblem = fixSessionJsonPaths(to, folder);
  if (pathProblem) notes.push(pathProblem);
  const logProblem = writeLog(sessionsRoot, `MOVED (${how})  ${path.basename(folder)} -> ${to}  ${megabytes(sizeBytes)}  reason: ${reason}`);
  if (logProblem) notes.push(`the line in ${LOG_FILE_NAME} could not be written (${logProblem})`);
  return { to, sizeBytes, notes };
}

// ---- What is in _no_game ----------------------------------------------------

// The session's date and time from its folder name ("2026-10-19_22-35_no-game"
// -> "2026-10-19 22:35"), or null.
function dateFromName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/.exec(name);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : null;
}

// Everything in _no_game, oldest move first. Each item:
//   name, path, sessionDate, sizeBytes, reason,
//   movedAtMs (null if no_game.json is missing or unreadable),
//   deleteAfterMs (when the automatic purge may delete it; null = never automatically),
//   kept (true if it is on the noGameKeep list)
// Returns { folder, items, totalBytes }. A missing _no_game is just empty.
async function listNoGame(sessionsRoot, { retentionDays = DEFAULT_RETENTION_DAYS, keepList = [] } = {}) {
  const box = noGameFolder(sessionsRoot);
  const items = [];
  let names = [];
  try {
    names = await fsp.readdir(box);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const name of names) {
    const full = path.join(box, name);
    const item = { name, path: full, sessionDate: dateFromName(name), sizeBytes: 0, reason: '-', movedAtMs: null, deleteAfterMs: null, kept: false };
    item.kept = keepList.some((k) => sameName(k, name));
    try {
      item.sizeBytes = await sizeOf(full);
    } catch (err) {
      item.reason = `its size could not be measured (${err.message})`;
    }
    try {
      const marker = readJsonFile(path.join(full, MARKER_FILE_NAME));
      const movedAtMs = Date.parse(marker.movedAt && marker.movedAt.iso);
      if (Number.isFinite(movedAtMs)) item.movedAtMs = movedAtMs;
      if (marker.reason) item.reason = String(marker.reason);
    } catch (err) {
      item.reason = `unknown: it has no readable ${MARKER_FILE_NAME}, so it is only deleted by hand`;
    }
    if (item.movedAtMs !== null && retentionDays !== null && !item.kept) item.deleteAfterMs = item.movedAtMs + retentionDays * DAY_MS;
    items.push(item);
  }
  items.sort((a, b) => (a.movedAtMs || 0) - (b.movedAtMs || 0) || a.name.localeCompare(b.name));
  return { folder: box, items, totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) };
}

// ---- Deleting and restoring -------------------------------------------------

// Throws an Error saying why, unless `name` is something directly inside
// _no_game that may be deleted. Returns its full (real) path.
async function checkDeletable(sessionsRoot, name, keepList) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name !== path.basename(name)) {
    throw new Error(`"${name}" is not a plain name of something in ${NO_GAME_FOLDER_NAME}`);
  }
  if (sameName(name, MARKER_FILE_NAME) || sameName(name, LOG_FILE_NAME)) throw new Error(`${name} is this app's own file`);
  if (keepList.some((k) => sameName(k, name))) throw new Error(`${name} is on the "noGameKeep" list in settings.json`);

  // Compare the real paths: a shortcut (link or junction) can't lead outside.
  const realRoot = await fsp.realpath(sessionsRoot);
  const realBox = await fsp.realpath(noGameFolder(sessionsRoot));
  const realTarget = await fsp.realpath(path.join(noGameFolder(sessionsRoot), name));
  if (!sameName(path.basename(realBox), NO_GAME_FOLDER_NAME) || !sameName(path.dirname(realBox), realRoot)) {
    throw new Error(`${noGameFolder(sessionsRoot)} leads somewhere else (${realBox})`);
  }
  if (!sameName(path.dirname(realTarget), realBox)) throw new Error(`${name} is not directly inside ${realBox}`);
  if (PROTECTED_PATH.test(realTarget)) throw new Error(`${realTarget} looks like a Riot or Vanguard path`);
  const link = await findLink(path.join(realBox, name));
  if (link) throw new Error(`it contains a link to another place (${link})`);
  return realTarget;
}

// Delete one item of _no_game for good. `mayDelete()` is asked just before
// deleting (false = a session is recording, so not now). `why` goes in the
// log, e.g. 'by hand' or 'automatic, moved here more than 7 days ago'.
// Returns { sizeBytes }. Throws if it was not deleted (or only partly).
async function deleteItem(sessionsRoot, name, { keepList = [], mayDelete = () => true, why = 'by hand' } = {}) {
  const target = await checkDeletable(sessionsRoot, name, keepList);
  const sizeBytes = await sizeOf(target);
  if (!mayDelete()) throw new Error('a session is recording, so nothing is deleted now');
  try {
    await fsp.rm(target, { recursive: true, maxRetries: 3, retryDelay: 500 });
  } catch (err) {
    writeLog(sessionsRoot, `DELETE FAILED (${why})  ${name}  ${err.message}`);
    throw err;
  }
  writeLog(sessionsRoot, `DELETED (${why})  ${name}  ${megabytes(sizeBytes)}`);
  return { sizeBytes };
}

// Move one item of _no_game back into sessionsRoot. Returns { to }.
async function restoreItem(sessionsRoot, name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name !== path.basename(name)) {
    throw new Error(`"${name}" is not a plain name of something in ${NO_GAME_FOLDER_NAME}`);
  }
  const from = path.join(noGameFolder(sessionsRoot), name);
  await fsp.lstat(from); // throws if it isn't there
  const to = freePath(path.join(sessionsRoot, name));
  await renameWhileBusy(from, to);
  // Note in no_game.json that it came back (the file stays, as a record).
  try {
    const markerFile = path.join(to, MARKER_FILE_NAME);
    const marker = readJsonFile(markerFile);
    marker.restoredAt = { iso: new Date().toISOString(), local: localStamp() };
    fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2), 'utf8');
  } catch (err) {
    // no marker (or not a folder): nothing to note
  }
  fixSessionJsonPaths(to, from);
  writeLog(sessionsRoot, `RESTORED  ${name} -> ${to}`);
  return { to };
}

// ---- The purge when the app starts ------------------------------------------

// Delete everything in _no_game that was moved there more than
// `retentionDays` ago. Items without a readable no_game.json, and items on
// the keep list, are never deleted here. Returns { deleted, failed }:
// lists of { name, sizeBytes } and { name, error }. A missing _no_game is fine.
async function purgeOld(sessionsRoot, { retentionDays, keepList = [], mayDelete = () => true, now = Date.now() } = {}) {
  const deleted = [];
  const failed = [];
  if (retentionDays === null) return { deleted, failed };
  const { items } = await listNoGame(sessionsRoot, { retentionDays, keepList });
  for (const item of items) {
    if (item.deleteAfterMs === null || item.deleteAfterMs > now) continue;
    try {
      const why = `automatic, moved here more than ${retentionDays} day${retentionDays === 1 ? '' : 's'} ago`;
      const result = await deleteItem(sessionsRoot, item.name, { keepList, mayDelete, why });
      deleted.push({ name: item.name, sizeBytes: result.sizeBytes });
    } catch (err) {
      failed.push({ name: item.name, error: err.message });
    }
  }
  return { deleted, failed };
}

module.exports = {
  NO_GAME_FOLDER_NAME, LOG_FILE_NAME, MARKER_FILE_NAME, MAX_GAME_SECONDS, DEFAULT_RETENTION_DAYS,
  judgeSession, moveToNoGame, listNoGame, deleteItem, restoreItem, purgeOld,
  retentionDaysFrom, noGameFolder, logFile, megabytes, writeLog,
};
