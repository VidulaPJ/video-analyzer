// =============================================================================
// live_logger.js
//
// Records a League of Legends match while you play, using the game's built-in
// "Live Client Data API" (a small web server the game runs on your own PC at
// https://127.0.0.1:2999 while a match is in progress).
//
// How to run:   node live_logger.js
// Start it before or during a match. It waits for the game, records events and
// player snapshots, then saves everything to a JSON file when the game ends --
// either when the GameEnd event arrives, or when the game stops responding
// (for example, if you quit or close the match early).
// Press Ctrl+C at any time to stop early (your data is still saved).
//
// This script uses only modules built into Node.js, so there's nothing to install.
// =============================================================================

// ---- Built-in Node.js modules ----------------------------------------------
const https = require('https'); // for making HTTPS requests to the game
const fs = require('fs');       // for writing the JSON file to disk
const path = require('path');   // for building the file path safely

// ---- Settings (change these if you like) -------------------------------------
const BASE_URL = 'https://127.0.0.1:2999/liveclientdata';
const WAIT_POLL_MS = 2000;       // how often to check whether a game has started
const EVENT_POLL_MS = 2000;      // how often to check for new events
const SNAPSHOT_MS = 10000;       // how often to take a snapshot of all players
const REQUEST_TIMEOUT_MS = 3000; // give up on a single request after this long
const MAX_FAILURES = 3;          // this many failed polls in a row = game is over

// ---- Certificate handling ---------------------------------------------------
// The game's API uses a "self-signed" certificate, which Node.js would normally
// reject as untrusted. We create a special "agent" that skips this check, and
// we pass it ONLY to our requests to the game. Every other HTTPS request in
// Node.js keeps full certificate checking. This is safe here because the
// address is 127.0.0.1, which is always your own computer.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// =============================================================================
// Helper functions
// =============================================================================

// Pause for a given number of milliseconds. Use it as: await sleep(2000);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ask the game's API for one endpoint (e.g. '/eventdata') and return the
// parsed JSON. If anything goes wrong (game not running, bad response, timeout)
// the returned Promise "rejects", which we catch with try/catch elsewhere.
function getJson(endpoint) {
  return new Promise((resolve, reject) => {
    const options = { agent: insecureAgent, timeout: REQUEST_TIMEOUT_MS };

    const req = https.get(BASE_URL + endpoint, options, (res) => {
      // The response arrives in pieces ("chunks"); collect them into one string.
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });

      // Once all pieces have arrived, check the status and parse the JSON.
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP status ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Response was not valid JSON'));
        }
      });
    });

    // If the request takes too long, cancel it (this triggers the 'error' below).
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    // Connection refused, reset, timed out, etc.
    req.on('error', reject);
  });
}

// Capture the current real-world time in two formats:
//  - iso:   a precise, standard format in UTC, e.g. "2026-09-27T18:50:03.123Z"
//  - local: easy-to-read in your own time zone, e.g. "9/27/2026, 11:50:03 AM"
function wallClockNow() {
  const now = new Date();
  return { iso: now.toISOString(), local: now.toLocaleString() };
}

// Turn seconds (e.g. 754.3) into a readable game clock like "12:34".
function formatGameTime(seconds) {
  if (typeof seconds !== 'number') return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Build a file name from a date, e.g. "live_log_2026-09-27_1150AM.json".
function makeFileName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  let hours = date.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12; // convert 0-23 to 1-12 (0 becomes 12)

  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(hours)}${pad(date.getMinutes())}${ampm}`;
  return `live_log_${datePart}_${timePart}.json`;
}

// Turn a raw turret/inhibitor ID from the API into a readable name, e.g.
// "Turret_T2_R_03_A" -> "Red team bot outer turret". The game uses two naming
// styles depending on the map, so we handle both. Anything we don't recognise
// is returned unchanged (the raw ID is always kept in the saved event anyway).
//
// Team codes: T1 / TOrder = Blue side, T2 / TChaos = Red side.
const TEAM_NAMES = { T1: 'Blue', T2: 'Red', TOrder: 'Blue', TChaos: 'Red' };

function describeStructure(id) {
  if (typeof id !== 'string') return id;
  let m;

  // Style 1 (Summoner's Rift), turrets: Turret_<team>_<lane>_<number>_A
  //   lane L = top, C = mid, R = bot
  //   top/bot:  03 = outer, 02 = inner, 01 = inhibitor turret
  //   mid:      05 = outer, 04 = inner, 03 = inhibitor turret, 02/01 = nexus turrets
  m = id.match(/^Turret_(T[12])_([LCR])_0(\d)_A$/);
  if (m) {
    const team = TEAM_NAMES[m[1]];
    const lane = m[2];
    const num = Number(m[3]);
    if (lane === 'C' && num <= 2) return `${team} team nexus turret`;
    const laneName = { L: 'top', C: 'mid', R: 'bot' }[lane];
    const tier = { 3: 'outer', 2: 'inner', 1: 'inhibitor' }[lane === 'C' ? num - 2 : num];
    if (tier) return `${team} team ${laneName} ${tier} turret`;
  }

  // Style 1, inhibitors: Barracks_<team>_<lane>1
  m = id.match(/^Barracks_(T[12])_([LCR])1$/);
  if (m) {
    const laneName = { L: 'top', C: 'mid', R: 'bot' }[m[2]];
    return `${TEAM_NAMES[m[1]]} team ${laneName} inhibitor`;
  }

  // Style 2 (seen on ARAM), turrets: Turret_<TOrder|TChaos>_L<lane>_P<position>_<id>
  //   P3 = outer, P2 = inner, P1 = inhibitor turret, P4/P5 = nexus turrets
  //   Only lane L1 ("mid") has been confirmed from real game data so far;
  //   any other lane number is shown as-is.
  const style2Lane = (n) => (n === '1' ? 'mid' : `lane ${n}`);
  m = id.match(/^Turret_(TOrder|TChaos)_L(\d)_P(\d)_/);
  if (m) {
    const team = TEAM_NAMES[m[1]];
    if (m[3] === '4' || m[3] === '5') return `${team} team nexus turret`;
    const tier = { 3: 'outer', 2: 'inner', 1: 'inhibitor' }[m[3]];
    if (tier) return `${team} team ${style2Lane(m[2])} ${tier} turret`;
  }

  // Style 2, inhibitors: Inhib_<TOrder|TChaos>_L<lane>_P1_<id>
  m = id.match(/^Inhib_(TOrder|TChaos)_L(\d)_P\d_/);
  if (m) return `${TEAM_NAMES[m[1]]} team ${style2Lane(m[2])} inhibitor`;

  return id; // unknown format - show the raw ID
}

// Turn a raw event from the API into a short human-readable sentence.
// Each event type has different fields, so we handle the common ones and
// fall back to just the event name for anything else.
function describeEvent(ev) {
  switch (ev.EventName) {
    case 'GameStart':       return 'Game started';
    case 'MinionsSpawning': return 'Minions are spawning';
    case 'FirstBlood':      return `FIRST BLOOD by ${ev.Recipient}`;
    case 'ChampionKill': {
      const assists = ev.Assisters && ev.Assisters.length
        ? ` (assists: ${ev.Assisters.join(', ')})`
        : '';
      return `${ev.KillerName} killed ${ev.VictimName}${assists}`;
    }
    case 'Multikill':       return `${ev.KillerName} got a multikill (x${ev.KillStreak})`;
    case 'Ace':             return `ACE! ${ev.Acer} aced for team ${ev.AcingTeam}`;
    case 'FirstBrick':      return `First turret destroyed by ${ev.KillerName}`;
    case 'TurretKilled':    return `${describeStructure(ev.TurretKilled)} destroyed by ${ev.KillerName}`;
    case 'InhibKilled':     return `${describeStructure(ev.InhibKilled)} destroyed by ${ev.KillerName}`;
    case 'InhibRespawningSoon': return `${describeStructure(ev.InhibRespawningSoon)} respawning soon`;
    case 'InhibRespawned':  return `${describeStructure(ev.InhibRespawned)} respawned`;
    case 'DragonKill':
      return `${ev.DragonType} dragon killed by ${ev.KillerName}${ev.Stolen === 'True' ? ' (STOLEN!)' : ''}`;
    case 'HeraldKill':
      return `Rift Herald killed by ${ev.KillerName}${ev.Stolen === 'True' ? ' (STOLEN!)' : ''}`;
    case 'BaronKill':
      return `Baron Nashor killed by ${ev.KillerName}${ev.Stolen === 'True' ? ' (STOLEN!)' : ''}`;
    case 'GameEnd':         return `Game over: ${ev.Result}`;
    default:                return ev.EventName; // any event type we don't know about
  }
}

// =============================================================================
// The log: everything we record lives in this one object, which becomes
// the JSON file.
// =============================================================================
const log = {
  gameDetectedAt: null, // wall-clock time we first saw the game running
  gameEndedAt: null,    // wall-clock time we stopped recording
  events: [],           // every event (kills, dragons, turrets, ...)
  snapshots: [],        // every 10-second snapshot of all players
};

let outputFile = null; // full path of the JSON file (set once the game is found)

// Write the log object to disk as nicely indented JSON.
// We call this after every snapshot too, so if your PC crashes mid-game
// you still keep almost everything.
function saveLog() {
  if (!outputFile) return; // nothing to save if no game was ever detected
  fs.writeFileSync(outputFile, JSON.stringify(log, null, 2), 'utf8');
}

// =============================================================================
// Step 1: Wait for a game to start
// =============================================================================
async function waitForGame() {
  while (true) {
    try {
      // /gamestats is a small endpoint - if it answers, a match is running.
      const stats = await getJson('/gamestats');
      return stats; // success! leave the loop
    } catch (err) {
      console.log('Waiting for game to start...');
      await sleep(WAIT_POLL_MS);
    }
  }
}

// =============================================================================
// Step 2a: Check for new events
// =============================================================================
// The /eventdata endpoint always returns the FULL list of events since the
// game began. Each event has an increasing "EventID", so we remember the
// highest ID we've already recorded and only keep events newer than that.
let lastEventId = -1;

// Returns true if the GameEnd event (victory/defeat) has arrived, so the main
// loop knows to stop.
async function pollEvents() {
  let sawGameEnd = false;
  const data = await getJson('/eventdata'); // throws if the game is gone
  const capturedAt = wallClockNow();        // real-world time of this capture

  for (const ev of data.Events || []) {
    if (ev.EventID <= lastEventId) continue; // already recorded
    lastEventId = ev.EventID;

    log.events.push({
      gameTime: ev.EventTime,            // in-game seconds, from the API
      wallClockTime: capturedAt.iso,     // real-world time we captured it
      wallClockLocal: capturedAt.local,
      description: describeEvent(ev),
      event: ev,                         // the full raw event, untouched
    });

    console.log(`  [${formatGameTime(ev.EventTime)}] ${describeEvent(ev)}`);
    if (ev.EventName === 'GameEnd') sawGameEnd = true;
  }

  return sawGameEnd;
}

// =============================================================================
// Step 2b: Take a snapshot of every player's stats
// =============================================================================
async function takeSnapshot() {
  // /playerlist has each player's level, items, scores, etc. but not the game
  // clock, so we also ask /gamestats for the current in-game time.
  const [stats, players] = await Promise.all([
    getJson('/gamestats'),
    getJson('/playerlist'),
  ]);
  const capturedAt = wallClockNow();

  log.snapshots.push({
    gameTime: stats.gameTime,          // in-game seconds, from the API
    wallClockTime: capturedAt.iso,     // real-world time we captured it
    wallClockLocal: capturedAt.local,
    players: players,                  // full raw player list
  });

  saveLog(); // save progress so far
  console.log(`  [${formatGameTime(stats.gameTime)}] Snapshot #${log.snapshots.length} saved (${players.length} players)`);
}

// =============================================================================
// Finish: save the file and print a summary
// =============================================================================
let finished = false;

function finish(reason) {
  if (finished) return; // make sure we only do this once
  finished = true;

  log.gameEndedAt = wallClockNow();
  saveLog();

  console.log('');
  console.log(`=== ${reason} ===`);
  if (outputFile) {
    console.log(`Recorded ${log.events.length} events and ${log.snapshots.length} snapshots.`);
    console.log(`Saved to: ${outputFile}`);
  } else {
    console.log('No game was detected, so nothing was saved.');
  }
}

// If you press Ctrl+C, save what we have before quitting.
process.on('SIGINT', () => {
  finish('Stopped by user (Ctrl+C)');
  process.exit(0);
});

// =============================================================================
// Main program
// =============================================================================
async function main() {
  console.log('League of Legends Live Logger');
  console.log('Press Ctrl+C at any time to stop and save.');
  console.log('');

  // ---- Step 1: wait for the match ----
  const firstStats = await waitForGame();

  const detectedDate = new Date();
  log.gameDetectedAt = { iso: detectedDate.toISOString(), local: detectedDate.toLocaleString() };
  outputFile = path.join(__dirname, makeFileName(detectedDate));

  console.log('');
  console.log(`=== Game detected at ${log.gameDetectedAt.local} (game clock ${formatGameTime(firstStats.gameTime)}) ===`);
  console.log(`Logging to: ${outputFile}`);
  console.log('');

  // ---- Step 2: record until the game ends, whichever of these comes first:
  //   - the GameEnd event arrives (victory/defeat), or
  //   - the API stops responding several times in a row (you quit/closed the match)
  let failuresInARow = 0;
  let lastSnapshotAt = 0; // 0 means "take a snapshot right away"
  let endReason = null;

  while (!finished) {
    // Check for new events every loop (every 2 seconds).
    try {
      const gameEnded = await pollEvents();
      failuresInARow = 0; // it worked, so reset the failure counter

      if (gameEnded) {
        // The API is still up at this moment, so grab one last snapshot
        // to capture everyone's final stats before we stop.
        try {
          await takeSnapshot();
        } catch (err) {
          console.log(`  (Final snapshot failed: ${err.message})`);
        }
        endReason = 'Game ended (GameEnd event received)';
        break;
      }
    } catch (err) {
      // One failure could just be a hiccup, so we only give up after
      // several failures in a row.
      failuresInARow++;
      console.log(`  (API did not respond: ${err.message} - attempt ${failuresInARow}/${MAX_FAILURES})`);
      if (failuresInARow >= MAX_FAILURES) {
        endReason = 'Game ended or was closed (API stopped responding)';
        break;
      }
    }

    // Take a player snapshot if 10 seconds have passed since the last one.
    if (failuresInARow === 0 && Date.now() - lastSnapshotAt >= SNAPSHOT_MS) {
      lastSnapshotAt = Date.now();
      try {
        await takeSnapshot();
      } catch (err) {
        console.log(`  (Snapshot failed: ${err.message})`);
      }
    }

    await sleep(EVENT_POLL_MS);
  }

  // ---- Step 3: the game is over, so save and finish ----
  finish(endReason);
}

// Start the program. If something totally unexpected happens, save what we
// have and show the error.
main().catch((err) => {
  console.error('Unexpected error:', err);
  finish('Stopped because of an error');
  process.exit(1);
});
