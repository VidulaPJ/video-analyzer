// =============================================================================
// tidy_sessions.js -- a one-off tidy-up: brings each session's files into its
// own session folder.
//
//   node tools/tidy_sessions.js           <- DRY RUN: only prints what it would do
//   node tools/tidy_sessions.js --apply   <- really moves the files
//
// Older versions of the app left some videos in OBS's own recording folder and
// only wrote the path down in session.json. This script reads every
// session.json under "sessionsRoot" and looks at the file paths saved in it:
//
//   videoFile          -> where the session's video is now
//   originalVideoFile  -> where OBS first saved it, if the app moved it
//   logFile            -> where the game log is now
//   originalLogFile    -> where the logger first saved it
//   (and any saved path that points at a session_*.json file in the project folder)
//
// A file belongs to a session ONLY if that session's session.json names its
// exact path. Nothing is matched by file name, date or time. Everything else
// is listed as "unmatched, left alone" and is never touched.
//
// With --apply, for each file to bring in:
//   - same drive as the session folder: a plain move (Windows just relabels
//     the file, which is instant and can't half-happen);
//   - another drive: copy it, check the copy is exactly the same size, and
//     only then delete the original. If anything goes wrong the original stays.
// Afterwards the paths inside session.json are updated (the old session.json is
// kept next to it as session_before_tidy.json).
//
// This script uses nothing but Node.js itself, and changes no other script.
// =============================================================================

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply'); // without this word nothing is changed
const PROJECT_DIR = path.join(__dirname, '..');  // this file is in <project>\tools
const SETTINGS_FILE = path.join(PROJECT_DIR, 'app', 'settings.json');
const DEFAULT_SESSIONS_ROOT = 'F:\\ME\\sessions'; // the app's own default
const BACKUP_NAME = 'session_before_tidy.json';

// The pairs of entries in session.json: [where the file is now, where it first was].
const FILE_KEYS = [
  { now: 'videoFile', original: 'originalVideoFile', label: 'video' },
  { now: 'logFile', original: 'originalLogFile', label: 'game log' },
];

// ---- Small helpers ----------------------------------------------------------

// Read a JSON file. Returns { data } or { error } - it never throws.
function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // an invisible marker some editors put first
    return { data: JSON.parse(text) };
  } catch (err) {
    return { error: err.message };
  }
}

// Two paths written differently can be the same file: Windows ignores capital
// letters, and OBS writes "F:/a/b" where Windows writes "F:\a\b". This gives
// every path one standard spelling, used only for comparing.
const key = (file) => path.resolve(file).toLowerCase();
const samePath = (a, b) => key(a) === key(b);
const isInside = (file, folder) => key(file).startsWith(key(folder) + path.sep);
const driveOf = (file) => path.parse(path.resolve(file)).root.toLowerCase();

// Is there an ordinary file at this path? Returns its size in bytes, or null.
function fileSize(file) {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? stats.size : null;
  } catch (err) {
    return null;
  }
}

function readableSize(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

// Print rows as a table with lined-up columns.
function printTable(headers, rows) {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

// ---- Step 1: read every session.json ----------------------------------------

function findSessionsRoot() {
  const settings = readJson(SETTINGS_FILE);
  const saved = settings.data && typeof settings.data.sessionsRoot === 'string' ? settings.data.sessionsRoot : '';
  return saved || DEFAULT_SESSIONS_ROOT;
}

// Returns { sessions: [{ name, folder, infoFile, info }], skipped: [text] }.
function readSessions(sessionsRoot) {
  const sessions = [];
  const skipped = [];
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(sessionsRoot, entry.name);
    const infoFile = path.join(folder, 'session.json');
    if (!fs.existsSync(infoFile)) {
      skipped.push(`${entry.name}: no session.json, so it is not looked at`);
      continue;
    }
    const read = readJson(infoFile);
    if (read.error || !read.data || typeof read.data !== 'object') {
      skipped.push(`${entry.name}: session.json can't be read (${read.error || 'not a JSON object'})`);
      continue;
    }
    sessions.push({ name: entry.name, folder, infoFile, info: read.data });
  }
  return { sessions, skipped };
}

// ---- Step 2: work out what to do, without doing it --------------------------
// Every saved path gets one entry in `findings`:
//   action 'move'   -> the file is outside the session folder and can be brought in
//   action 'none'   -> nothing to do (the note says why)
//   action 'cannot' -> something is wrong; it is reported and left alone
function planSession(session) {
  const findings = [];
  const add = (finding) => findings.push({ session, ...finding });

  for (const keys of FILE_KEYS) {
    const now = typeof session.info[keys.now] === 'string' && session.info[keys.now] ? session.info[keys.now] : null;
    const original = typeof session.info[keys.original] === 'string' && session.info[keys.original] ? session.info[keys.original] : null;
    const nowInside = now !== null && isInside(now, session.folder);
    const nowSize = now === null ? null : fileSize(now);

    // (a) Where session.json says the file is now.
    if (now !== null && !nowInside) {
      if (nowSize === null) {
        add({ action: 'cannot', label: keys.label, field: keys.now, from: now, note: 'session.json names this file, but it is not there' });
      } else {
        add({ action: 'move', label: keys.label, field: keys.now, originalField: keys.original, from: now,
          to: path.join(session.folder, path.basename(now)), size: nowSize });
      }
    } else if (now !== null && nowSize === null) {
      add({ action: 'cannot', label: keys.label, field: keys.now, from: now, note: 'session.json says it is in the session folder, but it is not there' });
    }

    // (b) Where it was before the app moved it. Normally that file is gone.
    if (original !== null && !isInside(original, session.folder) && !(now !== null && samePath(now, original))) {
      const originalSize = fileSize(original);
      if (originalSize === null) continue; // gone, as it should be: nothing to do
      if (nowInside && nowSize !== null) {
        // The session folder already has its copy. The leftover is NOT
        // deleted: equal size alone doesn't prove the two are the same file.
        add({ action: 'none', label: keys.label, field: keys.original, from: original, size: originalSize,
          note: `a leftover original: the session folder already has this ${keys.label} (${originalSize === nowSize ? 'same size' : 'DIFFERENT size'}) - left alone, delete it by hand if you want` });
      } else if (now === null || nowSize === null) {
        // The only copy there is: bring it in and point the "now" entry at it.
        // Any earlier finding for the missing "now" file is replaced by this one.
        const stale = findings.findIndex((f) => f.field === keys.now && f.action === 'cannot');
        if (stale !== -1) findings.splice(stale, 1);
        add({ action: 'move', label: keys.label, field: keys.now, originalField: keys.original, from: original,
          to: path.join(session.folder, path.basename(original)), size: originalSize });
      }
    }
  }

  // (c) A copy of the session info in the project folder: any other saved path
  //     that points at a session_*.json file there.
  for (const [field, value] of Object.entries(session.info)) {
    if (typeof value !== 'string' || FILE_KEYS.some((keys) => keys.now === field || keys.original === field)) continue;
    if (!/^session_.*\.json$/i.test(path.basename(value)) || !samePath(path.dirname(path.resolve(value)), PROJECT_DIR)) continue;
    const size = fileSize(value);
    if (size === null) continue;
    add({ action: 'move', label: 'session info copy', field, originalField: null, from: value,
      to: path.join(session.folder, path.basename(value)), size });
  }
  return findings;
}

// Checks that need all sessions together. Turns unsafe moves into 'cannot'.
function checkMoves(findings, sessions) {
  const moves = findings.filter((f) => f.action === 'move');
  for (const move of moves) {
    const refuse = (note) => { move.action = 'cannot'; move.note = note; };
    const claimedBy = moves.filter((other) => samePath(other.from, move.from)).map((other) => other.session.name);
    const otherSession = sessions.find((s) => s !== move.session && isInside(move.from, s.folder));
    if (new Set(claimedBy).size > 1) {
      refuse(`more than one session names this file (${[...new Set(claimedBy)].join(', ')}), so it is not clear whose it is`);
    } else if (otherSession) {
      refuse(`the file is inside another session's folder (${otherSession.name})`);
    } else if (fs.existsSync(move.to)) {
      refuse(`a file called ${path.basename(move.to)} is already in the session folder (${readableSize(fileSize(move.to))}) - nothing is ever overwritten`);
    } else if (moves.some((other) => other !== move && other.action === 'move' && samePath(other.to, move.to))) {
      refuse(`two files would both become ${path.basename(move.to)} in the session folder`);
    } else {
      move.method = driveOf(move.from) === driveOf(move.to) ? 'move (same drive)' : 'copy, check size, delete original';
    }
  }
}

// ---- Step 3: "unmatched, left alone" ----------------------------------------
// Everything that sits next to the files session.json names, but which no
// session names: the project folder, and each folder a saved path points into
// (for example OBS's recording folder). Only the top level is listed; a
// folder is one line. None of it is ever touched.
function listUnmatched(findings, sessions, sessionsRoot) {
  const folders = new Map([[key(PROJECT_DIR), PROJECT_DIR]]);
  const consider = (folder) => {
    if (!folder || isInside(folder, sessionsRoot) || samePath(folder, sessionsRoot)) return;
    try {
      if (fs.statSync(folder).isDirectory()) folders.set(key(folder), path.resolve(folder));
    } catch (err) {
      // the folder isn't there: nothing to list
    }
  };
  for (const session of sessions) {
    for (const keys of FILE_KEYS) {
      for (const field of [keys.now, keys.original]) {
        if (typeof session.info[field] === 'string' && session.info[field]) consider(path.dirname(session.info[field]));
      }
    }
    if (typeof session.info.obsOriginalRecordDirectory === 'string') consider(session.info.obsOriginalRecordDirectory);
  }

  const matched = new Set(findings.filter((f) => f.from).map((f) => key(f.from)));
  const rows = [];
  for (const folder of folders.values()) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (matched.has(key(full))) continue;
      rows.push([full, entry.isDirectory() ? '(folder)' : readableSize(fileSize(full))]);
    }
  }
  return rows;
}

// ---- Step 4 (only with --apply): move the files -----------------------------

// Move one file. Returns { how, originalLeft } or throws; when it throws, the
// original is still where it was.
function moveFile(from, to, expectedSize) {
  if (fs.existsSync(to)) throw new Error(`"${to}" already exists`);
  if (fileSize(from) !== expectedSize) throw new Error('the file changed size since it was looked at (is something still writing it?)');

  if (driveOf(from) === driveOf(to)) {
    try {
      fs.renameSync(from, to);
      if (fileSize(to) !== expectedSize) throw new Error('after the move the file is not the expected size');
      return { how: 'moved', originalLeft: null };
    } catch (err) {
      if (err.code !== 'EXDEV') throw err; // EXDEV = "not the same drive after all": copy instead
    }
  }

  // COPYFILE_EXCL means "fail instead of overwriting an existing file".
  try {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== 'EEXIST') fs.rmSync(to, { force: true }); // remove our own half-written copy
    throw err;
  }
  const copiedSize = fileSize(to);
  if (copiedSize !== expectedSize) {
    fs.rmSync(to, { force: true }); // the bad copy goes; the original was never touched
    throw new Error(`the copy is ${copiedSize} bytes but the original is ${expectedSize} bytes, so the original was kept`);
  }
  try {
    fs.unlinkSync(from);
    return { how: 'copied, size checked, original deleted', originalLeft: null };
  } catch (err) {
    return { how: 'copied, size checked', originalLeft: err.message };
  }
}

// Save a session's changed session.json, keeping the old one as a backup.
// It is written under a temporary name first, so a crash can't leave half a file.
function saveSessionInfo(session) {
  const backup = path.join(session.folder, BACKUP_NAME);
  if (!fs.existsSync(backup)) fs.copyFileSync(session.infoFile, backup);
  const temporary = `${session.infoFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(session.info, null, 2), 'utf8');
  fs.renameSync(temporary, session.infoFile);
}

function applyMoves(moves) {
  let done = 0;
  let failed = 0;
  for (const move of moves) {
    console.log(`\n${move.session.name}: ${move.label}`);
    let result;
    try {
      result = moveFile(move.from, move.to, move.size);
    } catch (err) {
      failed += 1;
      console.log(`  FAILED: ${err.message}\n  The original is still at ${move.from}; session.json was not changed.`);
      continue;
    }
    console.log(`  ${result.how}: ${move.to}`);
    if (result.originalLeft) {
      console.log(`  BUT the original could not be deleted (${result.originalLeft}). It is still at ${move.from} - the copy is good, delete the original by hand.`);
    }

    // Update session.json: the entry now points into the session folder, and
    // the old place is remembered in the "original..." entry (as the app does).
    move.session.info[move.field] = move.to;
    if (move.originalField) move.session.info[move.originalField] = move.from;
    try {
      saveSessionInfo(move.session);
      console.log(`  session.json updated: ${move.field} = ${move.to}`);
      done += 1;
    } catch (err) {
      failed += 1;
      console.log(`  THE FILE WAS MOVED BUT session.json COULD NOT BE UPDATED (${err.message}).\n` +
        `  Edit ${move.session.infoFile} by hand: set "${move.field}" to ${move.to}`);
    }
  }
  console.log(`\nDone: ${done} file${done === 1 ? '' : 's'} brought into session folders, ${failed} failed.`);
}

// ---- The whole thing ---------------------------------------------------------

function main() {
  const sessionsRoot = findSessionsRoot();
  console.log(APPLY ? '=== APPLY: files will be moved ===' : '=== DRY RUN: nothing will be changed (run again with --apply to do it) ===');
  console.log(`Sessions folder: ${sessionsRoot}\nProject folder:  ${path.resolve(PROJECT_DIR)}\n`);

  let read;
  try {
    read = readSessions(sessionsRoot);
  } catch (err) {
    console.log(`Couldn't look in the sessions folder (${err.message}). Check "sessionsRoot" in ${SETTINGS_FILE}.`);
    process.exitCode = 1;
    return;
  }
  const { sessions, skipped } = read;
  const findings = sessions.flatMap(planSession);
  checkMoves(findings, sessions);
  const moves = findings.filter((f) => f.action === 'move');
  const problems = findings.filter((f) => f.action === 'cannot');
  const notes = findings.filter((f) => f.action === 'none');

  console.log(`Read ${sessions.length} session.json file${sessions.length === 1 ? '' : 's'}. ` +
    `${sessions.length - new Set(findings.map((f) => f.session)).size} of them have nothing outside their folder.`);
  for (const line of skipped) console.log(`  Skipped ${line}`);

  console.log(`\n--- ${APPLY ? 'TO MOVE' : 'WOULD MOVE'} (${moves.length}) ---`);
  if (moves.length === 0) console.log('Nothing.');
  else {
    printTable(['#', 'Session', 'What', 'Size', 'How'],
      moves.map((m, i) => [i + 1, m.session.name, `${m.label} (${m.field})`, readableSize(m.size), m.method]));
    console.log('');
    moves.forEach((m, i) => console.log(`${i + 1}. from: ${m.from}\n   to:   ${m.to}`));
    const total = moves.reduce((sum, m) => sum + m.size, 0);
    console.log(`\nTotal: ${readableSize(total)}. Afterwards each session.json gets the new path, and the old one is kept as ${BACKUP_NAME}.`);
  }

  console.log(`\n--- CAN'T MATCH OR CAN'T MOVE (${problems.length + notes.length}) ---`);
  if (problems.length + notes.length === 0) console.log('Nothing.');
  for (const f of [...problems, ...notes]) {
    console.log(`${f.session.name}: ${f.label} (${f.field})\n   ${f.from}${f.size ? ` (${readableSize(f.size)})` : ''}\n   ${f.note}`);
  }

  const unmatched = listUnmatched(findings, sessions, sessionsRoot);
  console.log(`\n--- UNMATCHED, LEFT ALONE (${unmatched.length}) ---`);
  console.log('No session.json names these, so they are never touched.');
  printTable(['Path', 'Size'], unmatched);

  if (!APPLY) {
    console.log('\nDRY RUN: nothing was changed.');
    return;
  }
  if (moves.length === 0) {
    console.log('\nThere is nothing to move.');
    return;
  }
  applyMoves(moves);
}

main();
