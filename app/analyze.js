// =============================================================================
// analyze.js -- the "Analyze last match" button.
//
// It takes the newest session folder, works out where in the VIDEO each thing
// in the game log happened, and picks the best moments for your player by
// fixed rules with a score (see "Step 3" below; settings.json "highlightMode"
// says which moments may be picked). Claude (Anthropic's AI) then only writes
// a short title and one sentence for each clip. The list is saved as
// highlights.json in the session folder.
//
// Only text is sent to Claude: the game log lines of the picked clips. The
// video itself never leaves this PC.
//
// main.js uses the one function exported at the bottom of this file. The
// approach follows find_highlights.js in the project folder.
// =============================================================================

const fs = require('fs');
const path = require('path');
const util = require('util');
const who = require('./who'); // our own who.js: writes the "who" line of each moment

// The cheapest Claude model. Writing a title and a sentence for a handful of
// clips is well within what it can do.
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 16000;   // the most Claude may write back (it needs far less)

// ---- Which moments, and how many (settings.json can change these) ----
//   "mine"            -> only moments with a kill of your own
//   "mine_and_fights" -> those, plus team fights you had a kill or assist in
//   "all"             -> every kill moment, also ones you took no part in
const HIGHLIGHT_MODES = ['mine', 'mine_and_fights', 'all'];
const DEFAULT_HIGHLIGHT_MODE = 'mine_and_fights';
const DEFAULT_MAX_CLIPS = 5;        // never more clips than this
const DEFAULT_MIN_CLIPS = 2;        // fewer: borrow the best from the next level up
const DEFAULT_MAX_CLIP_SECONDS = 45; // no clip is longer than this

// Each clip starts this long before the moment and ends this long after it,
// so the lead-up and the aftermath are in the clip.
const PAD_BEFORE_SECONDS = 10;
const PAD_AFTER_SECONDS = 8;
// Kills with no more than this long between them are one fight; your own
// kills that close together are a multi-kill (the game's own multikill window).
const FIGHT_GAP_SECONDS = 10;
// A fight with at least this many kills by your team is a "team fight".
const TEAM_FIGHT_KILLS = 3;
// Your team's objective (Ace, turret, inhibitor, dragon...) this soon after a
// fight's last kill belongs to the fight: the clip runs on to show it.
const OBJECTIVE_AFTER_SECONDS = 15;
// A death this soon after your kill is noted ("You died 1.6 s later").
const DEATH_NOTE_SECONDS = 10;
// A borrowed clip with a score below this is marked "weak".
const WEAK_SCORE = 4;

// ---- The score ----
const POINTS = {
  myKill: 3,             // each of your kills
  multiKill: 2,          // once per moment: 2 or more of your kills within FIGHT_GAP_SECONDS
  streakAbove: 2,        // +1 for each kill of your streak above this many...
  streakMax: 5,          // ...but never more than this
  teamKill: 1,           // each kill by your team in the clip
  diedRightAfter: -2,    // each of your kills followed by your death within...
  diedRightAfterSeconds: 3, // ...this many seconds
};
const OBJECTIVE_POINTS = {
  TurretKilled: 2, InhibKilled: 3, Ace: 2, DragonKill: 3, HeraldKill: 3, AtakhanKill: 3, BaronKill: 5,
};
// The same rules in words, shown in the window and saved in highlights.json.
const SCORE_RULES = [
  `each of your kills +${POINTS.myKill}`,
  `2 or more of your kills within ${FIGHT_GAP_SECONDS} s +${POINTS.multiKill} (once per clip)`,
  `kill streak +1 for each kill above ${POINTS.streakAbove} (at most +${POINTS.streakMax})`,
  `each kill by your team in the clip +${POINTS.teamKill}`,
  `your team's objective during the fight or up to ${OBJECTIVE_AFTER_SECONDS} s after: ` +
    'turret +2, inhibitor +3, Ace +2, dragon/herald/Atakhan +3, Baron +5',
  `you die within ${POINTS.diedRightAfterSeconds} s after your kill ${POINTS.diedRightAfter} (per kill)`,
  'equal scores: more kills + assists by you first, then the earlier one',
].join('; ');

// Session folders are named like "2026-10-10_22-35_Hwei_KIWI_Loss". Because
// the name starts with the date and time, the newest one is simply the last
// one in alphabetical order.
const SESSION_FOLDER_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}/;

// The shape Claude's answer must have: a title and a sentence for each clip,
// by the clip's number. The app has already picked the clips and their times.
const ANSWER_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer', description: 'The clip number, as given in the list (1, 2, ...)' },
            title: { type: 'string', description: 'Short factual title, e.g. "Double kill on Corki and Morgana"' },
            reason: { type: 'string', description: 'One factual sentence: what the clip\'s lines show happened' },
          },
          required: ['number', 'title', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['clips'],
    additionalProperties: false,
  },
};

// ---- Small helpers ----------------------------------------------------------

// ---- The one rounding rule for every time in the app ----
// A time (game or video) is first rounded to a tenth of a second: that is the
// number saved in the files, e.g. "videoSeconds": 2961. Its "mm:ss" text is
// always that rounded number with the tenths dropped: 2960.97 -> 2961.0 -> "49:21".
// Rounding a number that is already rounded changes nothing, so the text comes
// out the same whether it is made from the raw time or from the saved number.
// (Before, the raw time 2960.97 gave "49:20" in one place and "49:21" in another.)
// report.js, export.js, report_export.js and time_check.js all use these two.
function round1(seconds) {
  return Math.round(seconds * 10) / 10;
}

// Turn seconds (e.g. 754.3) into a clock like "12:34", by the rule above.
function mmss(totalSeconds) {
  const whole = Math.max(0, Math.floor(round1(totalSeconds)));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

// The middle value of a list of numbers.
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Read a JSON file. Returns { data } or { error } - it never throws.
function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // see loadSettings in main.js
    return { data: JSON.parse(text) };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'the file does not exist' : err.message };
  }
}

// The full path of the newest session folder in sessionsRoot, or null if
// there is none. Throws if sessionsRoot can't be read.
function findNewestSessionFolder(sessionsRoot) {
  const names = fs.readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SESSION_FOLDER_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return names.length > 0 ? path.join(sessionsRoot, names[names.length - 1]) : null;
}

// The Anthropic API key: from the .env file in the project folder, or failing
// that from Windows' own environment variables. Returns null if there is none.
function readApiKey(envFile) {
  try {
    const key = util.parseEnv(fs.readFileSync(envFile, 'utf8')).ANTHROPIC_API_KEY;
    if (key) return key;
  } catch (err) {
    // no .env file (or it can't be read) - try the environment instead
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

// ---- Step 2: where in the video did each thing happen? -----------------------

// Works out the video position of every event and snapshot in the log.
//
// A snapshot's game time and wall-clock time are read at the same moment, so
//   videoSeconds = the snapshot's wall-clock time - recordingStartMs
// is exact, and it tells us how far the video clock is ahead of the game
// clock at that point in the match.
//
// An event's wall-clock time is only when the logger NOTICED it, up to a few
// seconds after it happened. Its game time is exact, though, so:
//   videoSeconds = the event's game time + how far the video clock is ahead
//                  of the game clock in the snapshot nearest to it
// (the nearest one, rather than one figure for the whole match, so that a
// paused game doesn't throw off everything after the pause). Only if the log
// has no snapshots at all is the event's own wall-clock time used.
//
// Anything before the start of the video (negative) or after its end is left
// out of `events` / `snapshots` and counted instead.
//
// A session can have NO video (OBS never became ready). recordingStartMs is
// then null, nothing is left out, and the result says noVideo: true. So that
// the rest of the code needn't be written twice, every "videoSeconds" is then
// simply the game time; removeVideoTimes() takes those stand-ins out again
// before anything is saved or shown.
function placeOnVideo(log, recordingStartMs, videoDurationSeconds) {
  const noVideo = recordingStartMs === null;
  const byWallClock = (entry) => ({
    ...entry,
    videoSeconds: noVideo ? entry.gameTime : (Date.parse(entry.wallClockTime) - recordingStartMs) / 1000,
  });
  const usable = (entry) => typeof entry.gameTime === 'number' && !Number.isNaN(Date.parse(entry.wallClockTime));
  const allSnapshots = (log.snapshots || []).filter(usable).map(byWallClock);

  const eventsUseGameClock = allSnapshots.length > 0;
  const byGameClock = (entry) => {
    let nearest = allSnapshots[0];
    for (const snapshot of allSnapshots) {
      if (Math.abs(snapshot.gameTime - entry.gameTime) < Math.abs(nearest.gameTime - entry.gameTime)) nearest = snapshot;
    }
    return { ...entry, videoSeconds: entry.gameTime + (nearest.videoSeconds - nearest.gameTime) };
  };
  const allEvents = (log.events || []).filter(usable).map(eventsUseGameClock ? byGameClock : byWallClock);

  const isBefore = (entry) => entry.videoSeconds < 0;
  const isAfter = (entry) => videoDurationSeconds !== null && entry.videoSeconds > videoDurationSeconds;
  const isInside = (entry) => !isBefore(entry) && !isAfter(entry);

  // How far the video clock is ahead of the game clock over the whole match,
  // for saying which stretch of the match the video shows.
  const source = eventsUseGameClock ? allSnapshots : allEvents;
  const videoAheadOfGame = source.length > 0
    ? median(source.map((entry) => entry.videoSeconds - entry.gameTime))
    : null;

  return {
    noVideo,
    events: allEvents.filter(isInside),
    snapshots: allSnapshots.filter(isInside),
    eventsUseGameClock,
    totalEvents: allEvents.length,
    eventsBeforeVideo: allEvents.filter(isBefore).length,
    eventsAfterVideo: allEvents.filter(isAfter).length,
    // The stretch of the match that the video shows, in game seconds:
    videoStartsAtGameSeconds: videoAheadOfGame === null ? null : Math.max(0, -videoAheadOfGame),
    videoEndsAtGameSeconds: videoAheadOfGame === null || videoDurationSeconds === null
      ? null : videoDurationSeconds - videoAheadOfGame,
    matchEndsAtGameSeconds: allEvents.length > 0 ? allEvents[allEvents.length - 1].gameTime : null,
  };
}

// For a session with no video: set every video time in `value` (and in
// everything inside it) to null, so a stand-in game time can never be
// mistaken for a position in a video. The game times stay.
const VIDEO_TIME_KEYS = new Set(['videoTime', 'videoSeconds', 'atVideoTime', 'clipStart', 'clipEnd', 'clipStartSeconds', 'clipEndSeconds']);
function removeVideoTimes(value) {
  if (Array.isArray(value)) {
    value.forEach(removeVideoTimes);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (VIDEO_TIME_KEYS.has(key)) value[key] = null;
      else removeVideoTimes(value[key]);
    }
  }
}

// ---- Who is who ---------------------------------------------------------------

// True if a name from an event (e.g. "VDRJ" or "VDRJ#0405") is the player.
function isPlayerName(value, playerName) {
  return typeof value === 'string' && value.toLowerCase().split('#')[0] === playerName.toLowerCase();
}

// The players in a snapshot that an event's name could refer to. Usually one;
// none for a turret or a monster; TWO when both teams have the same champion
// as a bot (both are then called e.g. "Zaahen Bot").
function findPlayersByEventName(players, eventName) {
  return players.filter((player) => [player.summonerName, player.riotIdGameName, player.riotId]
    .some((value) => typeof value === 'string' && (value === eventName || value.split('#')[0] === eventName)));
}

// The team a name in an event belongs to, or null if it isn't a player or
// the name is on both teams.
function teamOfEventName(players, eventName) {
  const teams = new Set(findPlayersByEventName(players, eventName).map((player) => player.team));
  return teams.size === 1 ? [...teams][0] : null;
}

// The team of the VICTIM of a kill. If the victim's name is on both teams,
// the killer settles it: the victim is on the other team.
function victimTeam(players, kill) {
  const own = teamOfEventName(players, kill.event.VictimName);
  if (own) return own;
  const killerTeam = teamOfEventName(players, kill.event.KillerName);
  if (!killerTeam || findPlayersByEventName(players, kill.event.VictimName).length === 0) return null;
  return killerTeam === 'ORDER' ? 'CHAOS' : 'ORDER';
}

function isMyPlayer(player, playerName) {
  const name = playerName.toLowerCase();
  return [player.riotIdGameName, player.riotId, player.summonerName]
    .some((value) => typeof value === 'string' && value.toLowerCase().split('#')[0] === name);
}

// ---- Step 3: pick the moments -------------------------------------------------
//
// 1. Fights. Every kill in the video (by either team) joins the kill before
//    it if it came no more than FIGHT_GAP_SECONDS later. Your team's
//    objectives (Ace, turret, ...) during a fight or up to
//    OBJECTIVE_AFTER_SECONDS after it belong to it. Fights whose clips would
//    overlap become one fight, so each fight has ONE clip in every mode.
// 2. The clip: from PAD_BEFORE_SECONDS before the fight's first event to
//    PAD_AFTER_SECONDS after its last one. If that is longer than the cap, it
//    starts PAD_BEFORE_SECONDS before the main part (your kills; if none, the
//    first kill you assisted; if none, the busiest part of the fight) and
//    keeps as much as fits of what follows.
// 3. The score, from what is inside the clip (see POINTS / SCORE_RULES).
// 4. The mode says which fights may be picked; if fewer than the minimum
//    qualify, the best ones from the next level up are borrowed:
//      mine:            your kill -> + team fights -> + any kill/assist of yours
//      mine_and_fights: your kill or team fight -> + any kill/assist of yours
//      all:             every fight
//    A fight you had no kill or assist in is only ever picked in "all".

// Group events (in game-time order) into runs, each no more than
// FIGHT_GAP_SECONDS after the one before.
function runsOf(events) {
  const runs = [];
  for (const event of events) {
    const run = runs[runs.length - 1];
    if (run && event.gameTime - run[run.length - 1].gameTime <= FIGHT_GAP_SECONDS) run.push(event);
    else runs.push([event]);
  }
  return runs;
}

// The team that took an objective: the Ace says so itself; otherwise the
// killer's team, or for a minion its name ("Minion_T100..." is ORDER's), or
// for a turret or inhibitor the opposite of its owner ("Turret_TOrder_..." is
// ORDER's). null if it can't be told.
function teamOfObjective(raw, players) {
  if (raw.EventName === 'Ace') return raw.AcingTeam || null;
  const team = teamOfEventName(players, raw.KillerName);
  if (team) return team;
  const killer = String(raw.KillerName || '');
  if (/^Minion_T100/.test(killer)) return 'ORDER';
  if (/^Minion_T200/.test(killer)) return 'CHAOS';
  const target = String(raw.TurretKilled || raw.InhibKilled || '');
  if (/TOrder/.test(target)) return 'CHAOS';
  if (/TChaos/.test(target)) return 'ORDER';
  return null;
}

// Every fight of the match, each with its clip and score. `players` is who
// plays which champion (from the newest snapshot); `allEvents` is the whole
// log (for the kill streak, which counts from the start of the match).
function findFights({ placed, allEvents, players, playerName, videoDurationSeconds, maxClipSeconds }) {
  const me = players.find((player) => isMyPlayer(player, playerName));
  if (!me) return [];
  const enemyTeam = me.team === 'ORDER' ? 'CHAOS' : 'ORDER';
  const isKill = (e) => e.event && e.event.EventName === 'ChampionKill';
  const isMyKill = (k) => isPlayerName(k.event.KillerName, playerName);
  const isMyAssist = (k) => (Array.isArray(k.event.Assisters) ? k.event.Assisters : []).some((name) => isPlayerName(name, playerName));
  const isMyDeath = (k) => isPlayerName(k.event.VictimName, playerName);
  const isTeamKill = (k) => victimTeam(players, k) === enemyTeam;

  const kills = placed.events.filter(isKill);
  const objectives = placed.events.filter((e) => e.event && OBJECTIVE_POINTS[e.event.EventName] !== undefined
    && teamOfObjective(e.event, players) === me.team);

  // 1. Fights, then the ones whose clips would overlap joined.
  const fullWindow = (fight) => {
    const times = [...fight.kills, ...fight.objectives].map((e) => e.gameTime);
    return { start: Math.min(...times) - PAD_BEFORE_SECONDS, end: Math.max(...times) + PAD_AFTER_SECONDS };
  };
  const fights = [];
  for (const run of runsOf(kills)) {
    const first = run[0].gameTime;
    const last = run[run.length - 1].gameTime;
    const fight = { kills: run, objectives: objectives.filter((o) => o.gameTime >= first && o.gameTime <= last + OBJECTIVE_AFTER_SECONDS) };
    const previous = fights[fights.length - 1];
    if (previous && fullWindow(fight).start <= fullWindow(previous).end) {
      previous.kills.push(...run);
      for (const o of fight.objectives) if (!previous.objectives.includes(o)) previous.objectives.push(o);
    } else {
      fights.push(fight);
    }
  }

  const myTimeline = allEvents.filter((e) => isKill(e) && (isPlayerName(e.event.KillerName, playerName) || isMyDeath(e)));
  return fights.map((fight) => {
    // 2. The clip.
    const full = fullWindow(fight);
    const myKills = fight.kills.filter(isMyKill);
    let anchor;
    if (myKills.length > 0) {
      // your biggest multi-kill (the first, if two are as big)
      anchor = runsOf(myKills).reduce((best, run) => (run.length > best.length ? run : best))[0];
    } else {
      anchor = fight.kills.find(isMyAssist);
    }
    if (!anchor) {
      const around = (k) => fight.kills.filter((other) => Math.abs(other.gameTime - k.gameTime) <= FIGHT_GAP_SECONDS).length;
      anchor = fight.kills.reduce((best, k) => (around(k) > around(best) ? k : best));
    }
    let start = full.start;
    let end = full.end;
    const capped = end - start > maxClipSeconds;
    if (capped) {
      start = Math.max(full.start, anchor.gameTime - PAD_BEFORE_SECONDS);
      end = Math.min(full.end, start + maxClipSeconds);
      start = Math.max(full.start, end - maxClipSeconds);
    }
    const inClip = (e) => e.gameTime >= start && e.gameTime <= end;
    const clipKills = fight.kills.filter(inClip);
    const clipObjectives = fight.objectives.filter(inClip);
    const clipEvents = [...clipKills, ...clipObjectives].sort((a, b) => a.gameTime - b.gameTime);
    // The video runs ahead of the game clock by the same amount all through
    // one clip; the anchor's own placing says by how much.
    const videoAhead = anchor.videoSeconds - anchor.gameTime;
    const clipStartSeconds = Math.max(0, start + videoAhead);
    const clipEndSeconds = videoDurationSeconds === null ? end + videoAhead : Math.min(videoDurationSeconds, end + videoAhead);

    // 3. The score.
    const mine = clipKills.filter(isMyKill);
    const lastMine = mine[mine.length - 1];
    let streak = 0;
    if (lastMine) {
      for (const e of myTimeline) {
        if (e.gameTime > lastMine.gameTime) break;
        streak = isMyDeath(e) ? 0 : streak + 1;
      }
    }
    const deaths = kills.filter(isMyDeath);
    const traded = mine.filter((k) => deaths.some((d) => d.gameTime >= k.gameTime && d.gameTime - k.gameTime <= POINTS.diedRightAfterSeconds));
    const teamKills = clipKills.filter(isTeamKill).length;
    // The score from `counted` (the kills that earn team-kill points) and
    // `objectivesCounted`; your own kills, multi-kill, streak and the death
    // penalty always count.
    const scoreFrom = (counted, objectivesCounted) => {
      const parts = {
        myKills: POINTS.myKill * mine.length,
        multiKill: runsOf(mine).some((run) => run.length >= 2) ? POINTS.multiKill : 0,
        streak: Math.min(POINTS.streakMax, Math.max(0, streak - POINTS.streakAbove)),
        teamKills: POINTS.teamKill * counted.length,
        objectives: objectivesCounted.reduce((sum, o) => sum + OBJECTIVE_POINTS[o.event.EventName], 0),
        diedRightAfter: POINTS.diedRightAfter * traded.length,
      };
      const words = [
        parts.myKills && `your kills ${mine.length} x ${POINTS.myKill} = +${parts.myKills}`,
        parts.multiKill && `multi-kill +${parts.multiKill}`,
        parts.streak && `kill streak ${streak} +${parts.streak}`,
        parts.teamKills && `team kills ${counted.length} = +${parts.teamKills}`,
        parts.objectives && `${objectivesCounted.map((o) => o.event.EventName.replace(/Killed$|Kill$/, '').toLowerCase()).join(' + ')} +${parts.objectives}`,
        parts.diedRightAfter && `died within ${POINTS.diedRightAfterSeconds} s of your kill ${parts.diedRightAfter}`,
      ].filter(Boolean);
      return {
        score: Object.values(parts).reduce((sum, value) => sum + value, 0),
        scoreParts: parts,
        scoreText: words.length > 0 ? words.join(', ') : '0',
      };
    };
    // "mine_and_fights" and "all": the whole fight in the clip counts.
    const fightScore = scoreFrom(clipKills.filter(isTeamKill), clipObjectives);
    // "mine": only your own kills count (and your team's objective up to
    // OBJECTIVE_AFTER_SECONDS after your last kill); the other kills in the
    // fight only make the clip longer.
    const ownScore = lastMine
      ? scoreFrom(mine, clipObjectives.filter((o) => o.gameTime >= mine[0].gameTime && o.gameTime <= lastMine.gameTime + OBJECTIVE_AFTER_SECONDS))
      : null;
    const assists = clipKills.filter(isMyAssist).length;

    // Your deaths in the clip, e.g. "You died 1.6 s later (04:41, after your kill on Vel'Koz)".
    const notes = deaths.filter(inClip).map((d) => {
      const before = mine.filter((k) => k.gameTime <= d.gameTime && d.gameTime - k.gameTime <= DEATH_NOTE_SECONDS).pop();
      return before
        ? `You died ${round1(d.gameTime - before.gameTime)} s later (${mmss(d.gameTime)}, after your kill on ${before.event.VictimName})`
        : `You died at ${mmss(d.gameTime)}`;
    });
    if (capped) {
      const cut = [...fight.kills, ...fight.objectives].filter((e) => !inClip(e)).length;
      notes.push(`Capped at ${maxClipSeconds} s (the whole fight is ${Math.round(full.end - full.start)} s; ` +
        `${cut === 0 ? 'nothing is left out, only the lead-in or lead-out is shorter' : `${cut} event${cut === 1 ? '' : 's'} left out`})`);
    }
    // Did you die soon after your last kill or assist? (Saved as before.)
    const lastOwn = clipKills.filter((k) => isMyKill(k) || isMyAssist(k)).pop();
    const deathAfter = lastOwn ? deaths.find((d) => d.gameTime > lastOwn.gameTime && d.gameTime - lastOwn.gameTime <= DEATH_NOTE_SECONDS) : null;

    const hasKill = mine.length > 0;
    const hasAssist = assists > 0;
    const teamFight = teamKills >= TEAM_FIGHT_KILLS;
    let kind = 'fight without you';
    if (hasKill) kind = teamFight ? 'your kill in a team fight' : 'your kill';
    else if (hasAssist) kind = teamFight ? 'team fight' : 'kill/assist moment';
    return {
      kind,
      levels: { mine: hasKill, fights: hasKill || (teamFight && hasAssist), involved: hasKill || hasAssist, all: true },
      ...fightScore,     // score, scoreParts, scoreText
      ownScore,          // the same three for "mine" (null if you have no kill in the clip)
      yourKillsAndAssists: mine.length + assists,
      notes,
      capped,
      clipEvents,
      first: clipEvents[0],
      last: clipEvents[clipEvents.length - 1],
      clipStartSeconds,
      clipEndSeconds,
      playerDiedSecondsAfter: deathAfter ? round1(deathAfter.gameTime - lastOwn.gameTime) : null,
    };
  });
}

// Pick the clips for one mode. Returns them best first, each marked
// borrowed (from the next level up) and weak (borrowed, score below WEAK_SCORE).
function pickClips(fights, mode, maxClips, minClips) {
  const ladders = {
    mine: ['mine', 'fights', 'involved'],
    mine_and_fights: ['fights', 'involved'],
    all: ['all'],
  };
  const ladder = ladders[mode] || ladders[DEFAULT_HIGHLIGHT_MODE];
  // In "mine" a moment with your kill is scored by your own kills only; a
  // fight borrowed from the next level up keeps its whole-fight score.
  const scored = mode === 'mine' ? fights.map((f) => (f.ownScore ? { ...f, ...f.ownScore } : f)) : fights;
  const ranked = [...scored].sort((a, b) => b.score - a.score
    || b.yourKillsAndAssists - a.yourKillsAndAssists || a.first.gameTime - b.first.gameTime);
  const picked = ranked.filter((f) => f.levels[ladder[0]]).slice(0, maxClips)
    .map((f) => ({ ...f, borrowed: false, weak: false }));
  for (const level of ladder.slice(1)) {
    for (const f of ranked) {
      if (picked.length >= minClips) break;
      if (f.levels[level] && !picked.some((p) => p.first === f.first)) {
        picked.push({ ...f, borrowed: true, weak: f.score < WEAK_SCORE });
      }
    }
  }
  return picked;
}

// Step 3 for one session, start to finish: the clips for `highlightMode`,
// best first. Needs no API key, so it can also be tried on old sessions.
function pickHighlights({ placed, log, playerName, videoDurationSeconds, highlightMode, maxClips, minClips, maxClipSeconds }) {
  const { players } = who.contextFromLog(log, playerName);
  const fights = findFights({
    placed, allEvents: Array.isArray(log.events) ? log.events : [], players, playerName, videoDurationSeconds, maxClipSeconds,
  });
  return pickClips(fights, highlightMode, maxClips, minClips);
}

// Who is who: the champion and team of every player, taken from one snapshot.
function describeRoster(snapshots, playerName) {
  const players = snapshots.length > 0 && Array.isArray(snapshots[snapshots.length - 1].players)
    ? snapshots[snapshots.length - 1].players : [];
  const me = players.find((player) => isMyPlayer(player, playerName));
  const list = (team) => players.filter((player) => player.team === team)
    .map((player) => `${player.riotIdGameName || player.summonerName || 'unknown'} (${player.championName})`).join(', ');
  return {
    champion: me ? me.championName : null,
    text: me
      ? `${playerName} plays ${me.championName} on team ${me.team}.\n` +
        `Team ORDER: ${list('ORDER')}\nTeam CHAOS: ${list('CHAOS')}`
      : `(${playerName} was not found in the player list.)`,
  };
}

// The clips are already picked; Claude only words them. Each clip is sent as
// its game log lines, plus the app's own notes (e.g. that the player died).
function buildPrompt(playerName, roster, clips, sessionInfo) {
  const game = sessionInfo.game || {};
  const context = [
    game.mode ? `Game mode: ${game.mode}.` : null,
    game.result ? `Final result for ${playerName}: ${game.result}.` : null,
  ].filter(Boolean).join(' ');
  const list = clips.map((clip, i) => [
    `Clip ${i + 1} (${clip.kind}):`,
    ...clip.clipEvents.map((e) => `  [game ${mmss(e.gameTime)}] ${e.description}`),
    ...clip.notes.filter((note) => note.startsWith('You died')).map((note) => `  Note: ${note.replace(/^You/, playerName)}.`),
  ].join('\n')).join('\n\n');

  return `You are writing the captions of a highlight reel from a League of Legends match for the player ${playerName}.

${roster.text}
${context}

The clips are already chosen. Each one is listed with the game log lines it shows (kills, multikills, turrets, aces), in order. Events name players by their champion or by their player name.

${list}

For EVERY clip, by its number, write:
- "title": short and factual, e.g. "Double kill on Corki and Morgana" or "Team fight with an Ace".
- "reason": one factual sentence: what ${playerName} did in it (kill or assist), who else killed whom, and what it led to (an Ace, a turret). If a note says ${playerName} died, the sentence MUST say so.
Keep to what the lines show. No judgement words (clutch, strong, key, huge, impressive), and no claims about leads, threats, positioning, damage or importance - the data doesn't show those.`;
}

// ---- Step 4: ask Claude for the words -------------------------------------------

// Sends the prompt and returns { clips, usage }. Throws an Error with a
// readable message if anything goes wrong.
async function askClaude(apiKey, prompt) {
  const { answer, usage } = await askClaudeForJson(apiKey, prompt, ANSWER_FORMAT);
  if (!Array.isArray(answer.clips)) throw new Error('Claude\'s answer had no list of clips.');
  return { clips: answer.clips, usage };
}

// Sends a prompt whose answer must have the shape `format` describes, and
// returns { answer, usage }. Throws an Error with a readable message if
// anything goes wrong. report.js uses this too.
async function askClaudeForJson(apiKey, prompt, format) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (err) {
    throw new Error('the Anthropic library is not installed. Run "npm install" in the app folder.');
  }
  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'medium', format },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Anthropic rejected the API key. Check ANTHROPIC_API_KEY in the .env file.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Anthropic says too many requests were made (or the account is out of credit). Try again in a minute.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new Error(`Anthropic couldn't be reached - check the internet connection (${err.message}).`);
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic returned an error (${err.status}): ${err.message}`);
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('Claude\'s answer was cut off before it was finished.');

  const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (err) {
    throw new Error('Claude\'s answer was not in the expected format.');
  }
  if (!answer || typeof answer !== 'object') throw new Error('Claude\'s answer was not in the expected format.');
  return { answer, usage: response.usage };
}

// =============================================================================
// The whole thing, start to finish.
//   sessionsRoot -> the folder that holds the session folders
//   envFile      -> the .env file with ANTHROPIC_API_KEY in it
//   playerName   -> your in-game name, without the #tag (e.g. "VDRJ")
//   measureVideo(file) -> returns the video's real length in seconds, or
//                   throws (main.js passes in its ffprobe function)
//   say(text)    -> called with each line to show in the window
//   highlightMode, maxClips, minClips, maxClipSeconds -> from settings.json
//                   (see HIGHLIGHT_MODES and the defaults at the top)
// Returns what was saved in highlights.json, or null if it couldn't be done
// (the reason has then been shown with say). This function never throws.
// =============================================================================
async function analyzeLastMatch({
  sessionsRoot, sessionFolder, envFile, playerName, measureVideo, say,
  highlightMode = DEFAULT_HIGHLIGHT_MODE, maxClips = DEFAULT_MAX_CLIPS, minClips = DEFAULT_MIN_CLIPS,
  maxClipSeconds = DEFAULT_MAX_CLIP_SECONDS,
}) {
  try {
    // ---- Step 1: find the newest session and read its files ----
    // (sessionFolder is only given when one particular session is wanted;
    // the button in the window always takes the newest.)
    let folder;
    try {
      folder = sessionFolder || findNewestSessionFolder(sessionsRoot);
    } catch (err) {
      say(`[Couldn't look in the sessions folder ${sessionsRoot} (${err.message}). Check "sessionsRoot" in settings.json.]\n`);
      return null;
    }
    if (!folder) {
      say(`[There are no session folders in ${sessionsRoot} yet. Record a session first.]\n`);
      return null;
    }
    say(`[${sessionFolder ? 'Session' : 'Newest session'}: ${folder}]\n`);

    const infoFile = path.join(folder, 'session.json');
    const info = readJson(infoFile);
    if (info.error) {
      say(`[Couldn't read ${infoFile}: ${info.error}. Without it the video can't be lined up with the game.]\n`);
      return null;
    }
    const sessionInfo = info.data;

    const logFile = path.join(folder, 'live_log.json');
    const logRead = readJson(logFile);
    if (logRead.error) {
      say(`[Couldn't read ${logFile}: ${logRead.error}.` +
        `${fs.existsSync(logFile) ? '' : ' No game was logged in this session, so there is nothing to analyze.'}]\n`);
      return null;
    }
    const log = logRead.data;
    if (!Array.isArray(log.events) || log.events.length === 0) {
      say('[The game log has no events in it, so there is nothing to analyze.]\n');
      return null;
    }

    // The video: whatever session.json says, wherever OBS put it. A session
    // can have none (OBS never became ready): the highlights are then picked
    // from the game log alone and listed with game times only.
    const videoFile = sessionInfo.videoFile ? path.normalize(sessionInfo.videoFile) : null;
    let noVideo = false;
    if (!videoFile) {
      noVideo = true;
      say('[No video was recorded (or kept) for this session. The highlights are picked from the game log alone and ' +
        'listed with GAME TIMES ONLY; clips can\'t be exported.]\n');
    } else {
      say(`[Video: ${videoFile}]\n`);
      if (!fs.existsSync(videoFile)) {
        say('[Warning: that video file is not there any more (moved or deleted?). The timestamps are still worked out.]\n');
      }
    }

    // ---- Step 2: line the game log up with the video ----
    const actuallyStarted = sessionInfo.obsRecordingActuallyStartedAt;
    const startSent = sessionInfo.obsRecordStartSentAt;
    let timingBasedOn = null;
    let recordingStartMs = null;
    if (noVideo) {
      // nothing to line up
    } else if (actuallyStarted && !Number.isNaN(Date.parse(actuallyStarted.iso))) {
      timingBasedOn = 'obsRecordingActuallyStartedAt';
      recordingStartMs = Date.parse(actuallyStarted.iso);
    } else if (startSent && !Number.isNaN(Date.parse(startSent.iso))) {
      timingBasedOn = 'obsRecordStartSentAt';
      recordingStartMs = Date.parse(startSent.iso);
      say('[Warning: session.json doesn\'t say when OBS actually started recording, so the time StartRecord was SENT is used ' +
        'instead. The video timestamps may be a few seconds off.]\n');
    } else {
      noVideo = true;
      say('[session.json doesn\'t say when the OBS recording started, so the video can\'t be lined up with the game. ' +
        'The highlights are listed with GAME TIMES ONLY.]\n');
    }

    // How long is the video? Measure the file itself rather than trusting
    // session.json: that number is written at the end of the session, and
    // if OBS was still writing the video at that moment it is too short.
    // Only if the file can't be measured is the saved number used.
    const saved = typeof sessionInfo.videoDurationSeconds === 'number' && sessionInfo.videoDurationSeconds > 0
      ? sessionInfo.videoDurationSeconds : null;
    let videoDurationSeconds = null;
    let videoDurationFrom = null;
    if (!noVideo) try {
      const measured = await measureVideo(videoFile);
      if (!(measured > 0)) throw new Error(`ffprobe reported a length of ${measured} seconds`);
      videoDurationSeconds = measured;
      videoDurationFrom = 'measured with ffprobe';
      if (saved !== null && Math.abs(measured - saved) > 1) {
        say(`[The video is ${mmss(measured)} long (measured just now). session.json says ${mmss(saved)}, ` +
          'which is out of date - the measured length is used.]\n');
      }
    } catch (err) {
      if (saved !== null) {
        videoDurationSeconds = saved;
        videoDurationFrom = 'session.json';
        say(`[Warning: couldn't measure the video's length with ffprobe (${err.message}). Using the length saved in ` +
          `session.json (${mmss(saved)}) instead, which may be too short.]\n`);
      } else {
        say(`[Warning: couldn't measure the video's length with ffprobe (${err.message}) and session.json doesn't say ` +
          'either, so events after the end of the video can\'t be left out.]\n');
      }
    }

    const placed = placeOnVideo(log, noVideo ? null : recordingStartMs, videoDurationSeconds);
    if (!placed.eventsUseGameClock && !noVideo) {
      say('[Warning: the game log has no player snapshots, so each event is placed by the time the logger noticed it. ' +
        'The video timestamps may be a few seconds late.]\n');
    }
    const outside = placed.eventsBeforeVideo + placed.eventsAfterVideo;
    if (noVideo) {
      say(`[All ${placed.events.length} events of the game log are used.]\n`);
    } else {
      say(`[${placed.events.length} of ${placed.totalEvents} events are inside the video` +
        `${videoDurationSeconds === null ? '' : ` (${mmss(videoDurationSeconds)} long)`}. ` +
        `${outside} fell outside it: ${placed.eventsBeforeVideo} before the recording started, ` +
        `${placed.eventsAfterVideo} after it ended.]\n`);
    }
    if (placed.videoStartsAtGameSeconds !== null && placed.videoEndsAtGameSeconds !== null) {
      const matchEnd = placed.matchEndsAtGameSeconds;
      say(placed.eventsAfterVideo > 0
        ? `[The video stops covering the match at game time ${mmss(placed.videoEndsAtGameSeconds)}; ` +
          `the match went on until ${mmss(matchEnd)}, so the last ${mmss(matchEnd - placed.videoEndsAtGameSeconds)} is not on video.]\n`
        : '[The video covers the match right to the end.]\n');
      if (placed.videoStartsAtGameSeconds > 0) {
        say(`[The video only starts at game time ${mmss(placed.videoStartsAtGameSeconds)}.]\n`);
      }
    }
    if (placed.events.length === 0) {
      say(noVideo
        ? '[The game log has no usable events, so there is nothing to pick highlights from.]\n'
        : '[None of the game\'s events are inside the video, so there is nothing to pick highlights from.]\n');
      return null;
    }

    // ---- Step 3: pick the clips, by the rules (see findFights) ----
    say(`[Highlight mode "${highlightMode}": up to ${maxClips} clips (at least ${minClips} if the match has them), ` +
      `each at most ${maxClipSeconds} s.]\n`);
    const clips = pickHighlights({ placed, log, playerName, videoDurationSeconds, highlightMode, maxClips, minClips, maxClipSeconds });
    const what = highlightMode === 'all' ? 'kill' : `moment with a kill or assist by ${playerName}`;
    if (clips.length === 0) {
      say(`[No highlights: there is no ${what} in the ${noVideo ? 'game log' : 'video'}.]\n`);
      return null;
    }
    if (clips.length < minClips) {
      say(`[Only ${clips.length} clip${clips.length === 1 ? '' : 's'}: the ${noVideo ? 'game log' : 'video'} has no other ${what}.]\n`);
    }

    // ---- Step 4: ask Claude for a title and a sentence for each clip ----
    const apiKey = readApiKey(envFile);
    if (!apiKey) {
      say(`[No ANTHROPIC_API_KEY was found in ${envFile}. Add a line "ANTHROPIC_API_KEY=..." to that file.]\n`);
      return null;
    }
    const roster = describeRoster(placed.snapshots, playerName);
    const prompt = buildPrompt(playerName, roster, clips, sessionInfo);
    say(`[Asking Claude (${MODEL}) for a title and a sentence for each of the ${clips.length} clips...]\n`);

    let answer;
    try {
      answer = await askClaude(apiKey, prompt);
    } catch (err) {
      say(`[Couldn't get the clip titles from Claude: ${err.message}]\n`);
      return null;
    }

    // Claude's words, by clip number. A clip Claude left out is worded by the app.
    const written = new Map();
    for (const item of answer.clips) {
      const number = Number(item.number);
      if (Number.isInteger(number) && number >= 1 && number <= clips.length && !written.has(number)) written.set(number, item);
    }

    // The "who" line of each highlight is written by the app from the game
    // log (see who.js), not taken from Claude's title or reason.
    const whoContext = who.contextFromLog(log, playerName);
    // Each text time is made from the very number that is saved next to it.
    const highlights = clips.map((clip, i) => {
      // Which events of the game log this clip shows (by the game's own event
      // numbers). who.js writes the "who" line from them.
      const whoParts = [{ type: 'events', eventIds: clip.clipEvents.map((e) => e.event.EventID) }];
      const whoText = who.whoLine(whoParts, whoContext);
      const words = written.get(i + 1);
      if (!words) say(`[Claude wrote nothing for clip ${i + 1}, so the app's own words are used for it.]\n`);
      const gameSeconds = round1(clip.first.gameTime);
      const videoSeconds = round1(clip.first.videoSeconds);
      const clipStartSeconds = round1(clip.clipStartSeconds);
      const clipEndSeconds = round1(clip.clipEndSeconds);
      const timelineLines = clip.clipEvents.map((e) => `E${e.event.EventID}: ${e.description}`);
      return {
        who: whoText,
        whoParts,
        gameTime: mmss(gameSeconds),
        videoTime: mmss(videoSeconds),
        clipStart: mmss(clipStartSeconds),
        clipEnd: mmss(clipEndSeconds),
        gameSeconds,
        lengthSeconds: round1(clip.last.gameTime - clip.first.gameTime), // from the clip's first event to its last
        videoSeconds,
        clipStartSeconds,
        clipEndSeconds,
        title: words ? String(words.title) : clip.kind.charAt(0).toUpperCase() + clip.kind.slice(1),
        reason: words ? String(words.reason) : whoText,
        playerDiedSecondsAfter: clip.playerDiedSecondsAfter,
        mergedFrom: 1,
        timelineLine: timelineLines[0],
        timelineLines,
        // How the app picked it (see findFights and pickClips):
        kind: clip.kind,         // "your kill", "your kill in a team fight", "team fight", "kill/assist moment", "fight without you"
        score: clip.score,
        scoreParts: clip.scoreParts,
        scoreText: clip.scoreText,
        borrowed: clip.borrowed, // true = taken from the next level up, to reach minClips
        weak: clip.weak,         // true = borrowed, and its score is below WEAK_SCORE
        capped: clip.capped,     // true = the fight was longer than maxClipSeconds
        notes: clip.notes,       // e.g. "You died 1.6 s later (04:41, after your kill on Vel'Koz)"
      };
    });

    // ---- Step 4: save and show ----
    const usage = answer.usage || {};
    const tokens = {
      input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      output: usage.output_tokens || 0,
    };
    const result = {
      generatedAt: new Date().toISOString(),
      sessionFolder: folder,
      videoFile: noVideo ? null : videoFile,
      noVideo, // true = there are no video times in this file, only game times
      player: playerName,
      champion: roster.champion,
      model: MODEL,
      timingBasedOn,
      eventPositionsFrom: noVideo ? 'none (no video)' : (placed.eventsUseGameClock ? 'game clock' : 'logger wall clock'),
      videoDurationSeconds,
      videoDurationFrom,
      events: {
        total: placed.totalEvents,
        insideVideo: placed.events.length,
        beforeVideo: placed.eventsBeforeVideo,
        afterVideo: placed.eventsAfterVideo,
      },
      videoCoversGameTime: placed.videoEndsAtGameSeconds === null ? null : {
        from: mmss(placed.videoStartsAtGameSeconds),
        to: mmss(Math.min(placed.videoEndsAtGameSeconds, placed.matchEndsAtGameSeconds)),
        matchEnded: mmss(placed.matchEndsAtGameSeconds),
      },
      tokens,
      sentToClaude: { clips: clips.length, events: clips.reduce((sum, clip) => sum + clip.clipEvents.length, 0) },
      clipPadding: { beforeSeconds: PAD_BEFORE_SECONDS, afterSeconds: PAD_AFTER_SECONDS },
      highlightMode,
      maxClips,
      minClips,
      maxClipSeconds,
      scoreRules: SCORE_RULES,
      highlights,
    };
    if (noVideo) removeVideoTimes(result); // the stand-in video times (see placeOnVideo) must not be saved

    say(`\nHighlights for ${playerName}${roster.champion ? ` (${roster.champion})` : ''}, mode "${highlightMode}"` +
      `${noVideo ? ' (game times only - no video)' : ''}:\n`);
    highlights.forEach((h, i) => {
      const when = noVideo ? `game ${h.gameTime}`
        : `video ${h.videoTime}  (game ${h.gameTime})  clip ${h.clipStart}-${h.clipEnd} (${Math.round(h.clipEndSeconds - h.clipStartSeconds)} s)`;
      const label = [h.kind, h.borrowed ? 'borrowed' : null, h.weak ? 'WEAK' : null].filter(Boolean).join(', ');
      say(`${i + 1}. score ${h.score}  ${when}  [${label}]  ${h.title}\n` +
        `${h.who ? `   Who: ${h.who}\n` : ''}` +
        `   Score: ${h.scoreText}\n` +
        h.notes.map((note) => `   Note: ${note}\n`).join('') +
        `   ${h.reason}\n`);
    });
    say(`[How the score is worked out: ${SCORE_RULES}.]\n`);
    say(`\n[Tokens used: about ${tokens.input.toLocaleString('en-US')} in + ${tokens.output.toLocaleString('en-US')} out = ` +
      `${(tokens.input + tokens.output).toLocaleString('en-US')} in total (${MODEL})]\n`);

    const outFile = path.join(folder, 'highlights.json');
    try {
      fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
      say(`[Saved to: ${outFile}]\n`);
    } catch (err) {
      say(`[Couldn't save ${outFile}: ${err.message}]\n`);
    }
    return result;
  } catch (err) {
    say(`[Analyze last match stopped because of an unexpected error: ${err.message}]\n`);
    return null;
  }
}

// analyzeLastMatch is what main.js uses, with the highlight settings below.
// The rest is shared with report.js, which reads the same files and asks
// Claude in the same way.
module.exports = {
  analyzeLastMatch, findNewestSessionFolder, MODEL, mmss, round1, readJson, readApiKey, placeOnVideo, removeVideoTimes, isMyPlayer, askClaudeForJson,
  isPlayerName, findPlayersByEventName, teamOfEventName, victimTeam, pickHighlights,
  HIGHLIGHT_MODES, DEFAULT_HIGHLIGHT_MODE, DEFAULT_MAX_CLIPS, DEFAULT_MIN_CLIPS, DEFAULT_MAX_CLIP_SECONDS,
};
