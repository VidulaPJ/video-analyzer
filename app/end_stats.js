// =============================================================================
// end_stats.js -- the League client's own end-of-game numbers for a session.
//
// The League client (the program you queue up in) keeps a match history with
// numbers the game log doesn't have: damage, gold, exact CS, the final items
// and the augments. After a session (and on "Analyze last match") this file
// finds the session's game in that history and saves it in the session folder
// as end_stats.json, and the game's timeline (once a minute: gold, XP, level
// and position of every player; kills and buildings with time and position)
// as end_timeline.json. report.js and report_export.js then only read those
// files, so the report works offline afterwards.
//
// How the client is reached: while it runs, it writes a "lockfile" in its
// install folder with a port number and a password for its local API. That
// API is only on this PC (127.0.0.1). The lockfile, the port and the password
// are never printed, logged or saved anywhere; every message has them taken out.
// Only GET requests are made: nothing in the client is changed.
//
// Nothing is asked while the game itself is running or loading.
// An end_stats.json that is already there is never overwritten.
// =============================================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const { readJson } = require('./analyze'); // our own analyze.js
const processes = require('./processes'); // our own processes.js

const LOCKFILE = 'C:\\Riot Games\\League of Legends\\lockfile'; // where the client keeps it (the default install folder)
const FILE_NAME = 'end_stats.json';
// The game's timeline from the client: once a minute, every player's gold,
// XP, level and position, plus the kills and buildings destroyed with their
// time and map position.
const TIMELINE_FILE_NAME = 'end_timeline.json';
const REQUEST_TIMEOUT_MS = 15000;
const HISTORY_GAMES = 20;      // how many of the newest games in the client's history are looked at
const LENGTH_TOLERANCE_SECONDS = 5; // the client's game length and the log's may differ by this much
// The game must have been created between this long before the session started
// and this long after it ended.
const BEFORE_SESSION_MINUTES = 10;
const AFTER_SESSION_MINUTES = 5;

// The port and password from the lockfile, or null if the client isn't running
// (no lockfile) or it can't be read. Never printed.
function readLockfile() {
  try {
    const [, , port, password, protocol] = fs.readFileSync(LOCKFILE, 'utf8').trim().split(':');
    if (!port || !password || protocol !== 'https') return null;
    return { port: Number(port), password };
  } catch (err) {
    return null;
  }
}

// One GET request to the client's local API. Returns the parsed answer, or
// throws an Error whose message has the port and password taken out.
function get(lock, urlPath) {
  const hide = (text) => String(text).split(lock.password).join('<password>').split(String(lock.port)).join('<port>');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: lock.port,
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`riot:${lock.password}`).toString('base64')}`, Accept: 'application/json' },
      rejectUnauthorized: false, // the client's own certificate is self-signed; only 127.0.0.1 is ever contacted
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`the client answered ${res.statusCode} for ${urlPath.split('?')[0]}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`the client's answer for ${urlPath.split('?')[0]} was not JSON`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the client did not answer in time')));
    req.on('error', (err) => reject(new Error(hide(err.message))));
    req.end();
  });
}

// "17:57" from 1077 seconds.
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

// How long the game lasted by the session's own game log: the GameEnd event,
// else the last snapshot. Null if the log has neither.
function logGameSeconds(log) {
  const end = (log.events || []).find((e) => e.event && e.event.EventName === 'GameEnd');
  if (end) return end.gameTime;
  const snapshots = log.snapshots || [];
  return snapshots.length > 0 ? snapshots[snapshots.length - 1].gameTime : null;
}

// Write a new file, never replacing one that is there: it is written under a
// temporary name, then linked to its real name - linking fails if a file of
// that name appeared meanwhile. Returns false if the file was already there.
function writeNewFile(file, content) {
  const part = `${file}.part`;
  fs.writeFileSync(part, JSON.stringify(content, null, 2), 'utf8');
  try {
    fs.linkSync(part, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(part, { force: true });
  }
}

// The client's timeline of one game, saved as end_timeline.json (with which
// game it is). Returns true if it was saved, false if the file was already there.
async function saveTimeline(lock, sessionFolder, gameId) {
  const timeline = await get(lock, `/lol-match-history/v1/game-timelines/${gameId}`);
  return writeNewFile(path.join(sessionFolder, TIMELINE_FILE_NAME), {
    savedAt: new Date().toISOString(),
    source: 'League client match history on this PC (127.0.0.1), read-only',
    gameId,
    timeline, // the client's timeline for this game, as it sent it
  });
}

// =============================================================================
// Find the session's game in the client's match history and save it as
// end_stats.json, and its timeline as end_timeline.json. A session that has
// end_stats.json but no timeline yet gets just the timeline (for the game
// end_stats.json was matched to). Returns { status, text }:
//   'saved'   -> something was saved; text says what and how it was matched
//   'exists'  -> both files were already there (they are never overwritten)
//   'skipped' -> nothing was saved; text says why (client not running, a game
//                is running, the game is not in the history yet, ...)
// Never throws.
// =============================================================================
async function saveEndStats({ sessionFolder, playerName, gameProcessName }) {
  try {
    const file = path.join(sessionFolder, FILE_NAME);
    const timelineFile = path.join(sessionFolder, TIMELINE_FILE_NAME);
    if (fs.existsSync(file)) {
      if (fs.existsSync(timelineFile)) return { status: 'exists', text: `${FILE_NAME} and ${TIMELINE_FILE_NAME} are already there` };
      // Only the timeline is missing: fetch it for the game already matched.
      const saved = readJson(file);
      const gameId = !saved.error && saved.data.matchedBy ? saved.data.matchedBy.gameId : null;
      if (!gameId) return { status: 'skipped', text: `${FILE_NAME} does not say which game it is` };
      if (await processes.isRunning(gameProcessName)) return { status: 'skipped', text: `${gameProcessName} is running` };
      const lock = readLockfile();
      if (!lock) return { status: 'skipped', text: 'the League client is not running' };
      return await saveTimeline(lock, sessionFolder, gameId)
        ? { status: 'saved', text: `${TIMELINE_FILE_NAME} saved for game ${gameId} (the game ${FILE_NAME} was matched to)` }
        : { status: 'exists', text: `${TIMELINE_FILE_NAME} is already there` };
    }

    // What the session itself knows: the champion, when it ran, how long the game lasted.
    const sessionRead = readJson(path.join(sessionFolder, 'session.json'));
    if (sessionRead.error) return { status: 'skipped', text: 'session.json could not be read' };
    const info = sessionRead.data;
    const champion = info.game && info.game.champion;
    if (!champion) return { status: 'skipped', text: 'the session does not say which champion was played' };
    const logRead = readJson(path.join(sessionFolder, 'live_log.json'));
    const logSeconds = logRead.error ? null : logGameSeconds(logRead.data);
    if (logSeconds === null) return { status: 'skipped', text: 'the game log has no game length to match' };
    const startedMs = Date.parse(info.sessionStartedAt && info.sessionStartedAt.iso);
    const endedMs = Date.parse(info.sessionEndedAt && info.sessionEndedAt.iso) || Date.now();
    if (Number.isNaN(startedMs)) return { status: 'skipped', text: 'session.json does not say when the session started' };

    // Never ask the client anything while a game is loading or running.
    if (await processes.isRunning(gameProcessName)) return { status: 'skipped', text: `${gameProcessName} is running` };
    const lock = readLockfile();
    if (!lock) return { status: 'skipped', text: 'the League client is not running' };

    const me = await get(lock, '/lol-summoner/v1/current-summoner');
    if (String(me.gameName || '').toLowerCase() !== String(playerName).toLowerCase()) {
      return { status: 'skipped', text: `the League client is logged in to another account than ${playerName}` };
    }
    const championList = await get(lock, '/lol-game-data/assets/v1/champion-summary.json');
    const championName = new Map(championList.map((c) => [c.id, c.name]));
    const history = await get(lock, `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=${HISTORY_GAMES}`);
    const games = (history.games && history.games.games) || [];

    // The match: same champion, game length within a few seconds, created during the session.
    const candidates = games.filter((g) => {
      const mine = g.participants && g.participants[0];
      return mine && championName.get(mine.championId) === champion
        && Math.abs(g.gameDuration - logSeconds) <= LENGTH_TOLERANCE_SECONDS
        && g.gameCreation >= startedMs - BEFORE_SESSION_MINUTES * 60000
        && g.gameCreation <= endedMs + AFTER_SESSION_MINUTES * 60000;
    }).sort((a, b) => Math.abs(a.gameDuration - logSeconds) - Math.abs(b.gameDuration - logSeconds));
    if (candidates.length === 0) {
      return { status: 'skipped', notYet: true, text: `no ${champion} game of about ${clock(logSeconds)} from this session is in the client's last ${HISTORY_GAMES} games` };
    }
    const found = candidates[0];
    const game = await get(lock, `/lol-match-history/v1/games/${found.gameId}`);

    // Names for the numbers in the game, from the client's own game data, so
    // the report can show them offline: champions, items (with what each is
    // built from and into), and augments.
    const stats = (game.participants || []).map((p) => p.stats || {});
    const itemIds = new Set(stats.flatMap((s) => [0, 1, 2, 3, 4, 5, 6].map((i) => s[`item${i}`])).filter(Boolean));
    const augmentIds = new Set(stats.flatMap((s) => [1, 2, 3, 4, 5, 6].map((i) => s[`playerAugment${i}`])).filter(Boolean));
    const items = {};
    for (const item of await get(lock, '/lol-game-data/assets/v1/items.json')) {
      if (itemIds.has(item.id)) items[item.id] = { name: item.name, from: item.from || [], to: item.to || [], inStore: item.inStore };
    }
    const augments = {};
    if (augmentIds.size > 0) {
      for (const augment of await get(lock, '/lol-game-data/assets/v1/cherry-augments.json')) {
        if (augmentIds.has(augment.id)) augments[augment.id] = augment.nameTRA;
      }
    }
    const champions = {};
    for (const p of game.participants || []) champions[p.championId] = championName.get(p.championId) || String(p.championId);

    const created = new Date(found.gameCreation);
    const matchedBy = {
      gameId: found.gameId,
      champion,
      clientGameSeconds: found.gameDuration,
      logGameSeconds: Math.round(logSeconds),
      gameCreatedAt: created.toISOString(),
      sessionStartedAt: new Date(startedMs).toISOString(),
      text: `game ${found.gameId} in the League client's match history: the same champion (${champion}), the same game length ` +
        `(${clock(found.gameDuration)} in the client, ${clock(logSeconds)} in the game log) and created during this session`,
    };
    const content = {
      savedAt: new Date().toISOString(),
      source: 'League client match history on this PC (127.0.0.1), read-only',
      matchedBy,
      lookups: {
        champions,
        items,
        augments,
        augmentNamesFrom: "the client's Arena augment list (cherry-augments.json)",
      },
      game, // the client's full detail for this game, as it sent it
    };

    if (!writeNewFile(file, content)) return { status: 'exists', text: `${FILE_NAME} is already there` };
    // The timeline too. If that one call fails, end_stats.json is kept; the
    // next try (or "Analyze last match") fetches just the timeline.
    let timelineNote = '';
    try {
      timelineNote = await saveTimeline(lock, sessionFolder, found.gameId) ? `, and ${TIMELINE_FILE_NAME}` : '';
    } catch (err) {
      timelineNote = ` (${TIMELINE_FILE_NAME} not saved: ${err.message})`;
    }
    return { status: 'saved', text: `${FILE_NAME}${timelineNote}: matched to ${matchedBy.text}` };
  } catch (err) {
    return { status: 'skipped', text: err.message };
  }
}

// Right after a game the client may not have it in its history yet, so this
// tries a few times, waiting in between - but only while the game is just not
// in the history yet. Any other answer (saved, already there, client closed,
// a new game running) ends it at once. Never throws.
async function saveEndStatsSoon(options, { tries = 6, waitSeconds = 20 } = {}) {
  let result = null;
  for (let i = 0; i < tries; i += 1) {
    result = await saveEndStats(options);
    if (!result.notYet) return result;
    if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
  }
  return result;
}

// The saved end_stats.json of a session folder, or null if there is none.
function readEndStats(sessionFolder) {
  const read = readJson(path.join(sessionFolder, FILE_NAME));
  return read.error ? null : read.data;
}

module.exports = { saveEndStats, saveEndStatsSoon, readEndStats, FILE_NAME, TIMELINE_FILE_NAME };
