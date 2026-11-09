// =============================================================================
// report.js -- the performance report that "Analyze last match" writes after
// the highlights.
//
// It reads session.json and live_log.json (the same two files as analyze.js)
// and the highlights.json that analyze.js has just saved, and saves
// report.json and <Champion>_report.md (e.g. Mel_report.md) in the session folder.
//
// The report is built so that Claude can't slip in something the data doesn't
// show:
//   1. CODE works out the numbers (deaths, time dead, CS, levels, items) and
//      turns them into a list of facts. Every fact has an ID: [F1], [F2], ...
//   2. CODE gives every death a score with fixed rules and picks the highest
//      scoring ones to rewatch.
//   3. CODE picks what every part of the report is about, with fixed rules,
//      and the facts each item rests on: the summary (always the same order),
//      "What went well" and "What to improve" (by a score), and the topics
//      of the "Specific points".
//   4. Claude only writes the sentences. Every sentence must cite a fact ID.
//   5. CODE then checks every sentence: no citation, or a comparison with a
//      wider group than the fact's ("the enemies" for "your lane opponent")
//      -> the sentence is dropped; a number, time or comparison that the
//      cited facts don't contain -> it is moved to "Unchecked claims".
//
// What is sent to Claude: the facts, and a short excerpt of the game log
// around each highlight and each death picked for review. Not the whole log.
// Only text is sent. The video itself never leaves this PC.
// =============================================================================

const fs = require('fs');
const path = require('path');
const {
  MODEL, mmss, round1, readJson, readApiKey, placeOnVideo, removeVideoTimes, isMyPlayer, askClaudeForJson,
  isPlayerName, findPlayersByEventName, teamOfEventName, victimTeam,
} = require('./analyze'); // our own analyze.js, in this folder
const who = require('./who'); // our own who.js: writes the "who" line of each moment

const MIN_POINTS = 3;
const MAX_POINTS = 5;
// At most this many of the points are about things to check; the rest of the
// places go to things that went well (if there are any).
const MAX_CHECK_POINTS = 4;
const MAX_FACTS_PER_POINT = 4;
// "What went well" and "What to improve": every candidate gets a score from
// 0 to 100 (always a percentage, see chooseLists). The highest-scoring ones
// are listed, but only if they reach the minimum for their list. A strength
// has to be clearly one: a fact that came out higher only half the time is not.
const MAX_LIST_ITEMS = 3;
const MIN_WENT_WELL_SCORE = 60;
const MIN_TO_IMPROVE_SCORE = 20;
// Modes with no lanes: everyone fights in one corridor, so a "lane opponent"
// and CS (there is little to farm) say nothing about how you played. ("KIWI"
// is what the game calls ARAM Mayhem, see game.js.)
const ARAM_MODES = ['ARAM', 'KIWI'];
// What a role label that isn't a lane looks like in the log ("NONE" in ARAM).
const isRealRole = (position) => typeof position === 'string' && position !== '' && position.toUpperCase() !== 'NONE';
// A "review moment" clip runs from this long before a death to this long after.
const REVIEW_BEFORE_SECONDS = 10;
const REVIEW_AFTER_SECONDS = 4;
// Other kills this close to a death are counted with it ("who else died").
const NEARBY_SECONDS = 10;
const BLOCK_MINUTES = 5; // CS, levels and items are compared every 5 minutes
// Claude is shown the game log from this long before to this long after each
// highlight and each death picked for review - and nothing else of the log.
const EXCERPT_SECONDS = 15;

// ---- The score that picks the deaths worth reviewing --------------------------
// A run of deaths: each one came within this long of respawning from the one
// before, and you got no kill of your own in between. (Measured from the
// respawn, not from the death: late in a game you are dead for a minute, so
// three deaths can never fit in 90 seconds. An assist doesn't end a run: in
// ARAM you get one almost every minute, so then there would be no runs at all.)
const RUN_ALIVE_SECONDS = 90;
const RUN_MIN_DEATHS = 3;            // a run this long earns its deaths the extra points
const AFTER_KILL_SECONDS = 10;       // "after one of my kills"
const RIGHT_AFTER_KILL_SECONDS = 5;  // "right after one of my kills": extra points
const NO_TEAM_SECONDS = 10;          // "no teammate kill or assist in the ... before"
const BEFORE_OBJECTIVE_SECONDS = 30; // "the enemy took an objective within ... after"

// Every death gets the points of each rule it matches; the total is its score.
// The first two are the plain rules (1 point each), the other three are the
// extras (2 points each). The order is also the tie-break: of two deaths with
// the same score, the one matching the rule nearer the END of this list comes
// first, and after that the earlier death.
const SCORE_RULES = [
  { id: 'no-team-fight', points: 1, description: `no teammate got a kill or an assist in the ${NO_TEAM_SECONDS} seconds before it` },
  { id: 'after-own-kill', points: 1, description: `it came within ${AFTER_KILL_SECONDS} seconds after one of your own kills` },
  { id: 'death-run', points: 2, description: `it is part of a run of ${RUN_MIN_DEATHS} or more deaths in a row with no kill of yours in between` },
  { id: 'right-after-own-kill', points: 2, description: `it came within ${RIGHT_AFTER_KILL_SECONDS} seconds after one of your own kills` },
  { id: 'before-enemy-objective', points: 2, description: `the enemy team took an objective within ${BEFORE_OBJECTIVE_SECONDS} seconds after it` },
];
// The top-scoring deaths are picked: always the best 3 (if they scored at
// all), and a 4th and 5th only if they scored at least this much.
const MIN_REVIEW_DEATHS = 3;
const MAX_REVIEW_DEATHS = 5;
const MIN_SCORE_FOR_EXTRA_REVIEW = 4;

// What a run costs: US dollars per million tokens, from Anthropic's price
// list (October 2026). A prompt longer than `longPromptTokens` is charged at
// the `long` prices. If the model in analyze.js is changed, add its prices
// here - until then the report says the cost is unknown.
const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, longPromptTokens: 100000, long: { input: 0.50, output: 2.50 } },
};

// What the game's log simply doesn't contain. Always printed in the report.
const DATA_LIMITS = [
  'Damage dealt or taken, healing and shielding: not in the log.',
  'Gold earned, gold in hand and item gold value: not in the log (the item "price" field is not a reliable total cost).',
  'Health and mana at any moment: not in the log.',
  'Where anyone was on the map: not in the log, so it can\'t say where a death happened or who was nearby. The "position" field is only a role label: ' +
    'on Summoner\'s Rift the assigned role (TOP, JUNGLE, MIDDLE, BOTTOM or UTILITY), in ARAM Mayhem "NONE" for every player.',
  'Abilities, summoner spells and item actives used, and their cooldowns: not in the log.',
  'Where wards were placed: not in the log (only a ward score number).',
  'Why something happened: the log shows that a kill or death happened and when, never the reason.',
  'Anything between two snapshots: player numbers are read about every 10 seconds, so CS, levels and items are accurate to about 10 seconds.',
  'Exact CS: the game reports CS in steps of 10, so a CS-per-minute figure over 5 minutes can be off by about 2 either way.',
  'Finished items: the log can\'t tell a finished item from a component, so "items carried" counts both.',
  'Which of two bots is meant when both teams have the same champion: an event only gives the name (e.g. "Zaahen Bot").',
];
// Added for the modes they are about (see dataLimitsFor).
const ARAM_LIMITS = [
  'Lanes: ARAM has no lanes, so there is no lane opponent, and CS is not used as a strength or a weakness. You are compared with your teammates instead.',
];
const MAYHEM_LIMITS = [
  'ARAM Mayhem augments: the log has no list of the augments anyone picked (its "runes" field is null for every player in this mode, and no event or snapshot has an augment or perk field). The only trace is an augment that takes the place of a summoner spell (e.g. "Growth Spurt"), which this report does not use.',
];

// The augment names in end_stats.json come from the client's ARENA augment
// list. Confirmed on 21 October 2026: in the 18 October Yunara game they were
// the augments actually picked (and the Kalista and Yunara game logs agree on
// the augments they show in a summoner-spell slot). Set this back to false
// if the names ever stop matching; they are then shown as "unverified".
const AUGMENT_NAMES_VERIFIED = true;

// With the League client's end-of-game numbers (end_stats.json) some limits
// are gone or smaller. Each entry: the limit above it replaces -> what it
// becomes ('' = it is gone). The ones not here (health, abilities, positions,
// wards, why, between snapshots, which bot) the client's numbers don't change.
// "Which bot": the client's numbers are per player, but the log's events still
// only give a name, so two bots with the same name still can't be told apart.
const LIMITS_WITH_END_STATS = new Map([
  [DATA_LIMITS[0], 'Shielding, and damage or healing at any single moment: not in the data (the League client gives only whole-game totals for damage dealt, damage taken and healing).'],
  [DATA_LIMITS[1], 'Gold in hand at any moment and item gold value: not in the data (the League client gives only the whole-game gold earned and spent).'],
  [DATA_LIMITS[9], 'Finished items during the game: the game log can\'t tell a finished item from a component, so "items carried" counts both. (The final build is checked against Riot\'s item data.)'],
]);
// Exact CS: in ARAM the report only uses the final CS, which the client gives
// exactly; elsewhere the 5-minute marks still use the log's steps of 10.
const CS_LIMIT_WITH_END_STATS = 'Exact CS at the 5-minute marks: the final CS is exact (from the League client), but CS at each mark comes from the game log, which reports it in steps of 10.';
// Mayhem augments: the client lists them, but until their names have been
// checked against a real game (AUGMENT_NAMES_VERIFIED) they are marked unverified.
const AUGMENT_LIMIT_UNVERIFIED = 'ARAM Mayhem augments: the League client lists each player\'s augments, but their names come from its Arena augment list and have not been checked against a real game yet, so they are marked unverified.';

// With the client's timeline (end_timeline.json) as well, two limits change
// again, and some are added that only the timeline makes worth saying.
const LIMITS_WITH_TIMELINE = new Map([
  [DATA_LIMITS[1], 'Gold in hand between the minute marks, and item gold value: not in the data (the League client records gold only once a minute).'],
  [DATA_LIMITS[3], 'Where anyone was on the map: the League client records each player\'s position only once a minute (plus the exact spot of every kill), ' +
    'so the report does not say who was near you when you died, or where anyone was between the minute marks. ' +
    'The "position" field in the game log is only a role label: on Summoner\'s Rift the assigned role (TOP, JUNGLE, MIDDLE, BOTTOM or UTILITY), in ARAM Mayhem "NONE" for every player.'],
]);
const TIMELINE_LIMITS = [
  'The nexus being destroyed: not an event in the data (only which team won).',
  'Where the nexuses stand: not in the data, so "along the lane" is measured from fountain to fountain.',
];
const PURCHASE_LIMIT = 'When each item was bought: not in the League client\'s data for this game (only the final build).';

// Everything the data can't tell, for one game mode (e.g. "KIWI").
//   endStats -> true if the session has the League client's end-of-game numbers
//   timeline -> true if it has the client's timeline too
function dataLimitsFor(mode, { endStats = false, timeline = false } = {}) {
  const aram = ARAM_MODES.includes(mode);
  if (!endStats) return [...DATA_LIMITS, ...(aram ? ARAM_LIMITS : []), ...(mode === 'KIWI' ? MAYHEM_LIMITS : [])];
  const base = DATA_LIMITS
    .map((limit) => {
      if (limit === DATA_LIMITS[8]) return aram ? '' : CS_LIMIT_WITH_END_STATS;
      if (timeline && LIMITS_WITH_TIMELINE.has(limit)) return LIMITS_WITH_TIMELINE.get(limit);
      return LIMITS_WITH_END_STATS.has(limit) ? LIMITS_WITH_END_STATS.get(limit) : limit;
    })
    .filter(Boolean);
  const mayhem = mode === 'KIWI' && !AUGMENT_NAMES_VERIFIED ? [AUGMENT_LIMIT_UNVERIFIED] : [];
  return [...base, PURCHASE_LIMIT, ...(timeline ? TIMELINE_LIMITS : []), ...(aram ? ARAM_LIMITS : []), ...mayhem];
}

// A session with no video has no recording to check, so nothing in its report
// may talk about one. Claude usually adds it as a closing clause ("...; this
// is something to check in the recording."), which is simply taken off; a
// sentence that still mentions a recording after that is dropped (checkText).
const RECORDING_CLAUSE = /\s*[;,]\s*(?:and\s+)?(?:this|it|that)\s+(?:is|would\s+be)\s+(?:something|worth)[^.;[\]]*?\b(?:recording|video)\b/gi;
const MENTIONS_RECORDING = /\b(?:recording|video|rewatch|re-watch|replay|footage)\b/i;
function withoutRecordingAdvice(text) {
  return String(text).replace(RECORDING_CLAUSE, '').replace(/\s+([.,;])/g, '$1');
}

// The shape of one list in Claude's answer: a sentence for each item the app
// picked ("S1", "W2", "I3", ...).
function phrasedList(letter, listName) {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: `The item this is about, e.g. "${letter}1". Only items from the ${listName} list.` },
        text: { type: 'string', description: 'One sentence, citing at least one of the facts listed for that item, e.g. [F3]' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  };
}

// The shape Claude's answer must have.
const REPORT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      summary: phrasedList('S', 'SUMMARY'),
      wentWell: phrasedList('W', 'WENT WELL'),
      toImprove: phrasedList('I', 'TO IMPROVE'),
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The point this is about, e.g. "P2". Only points from the POINTS list.' },
            detail: { type: 'string', description: 'Two or three sentences, each citing at least one of the facts listed for that point' },
          },
          required: ['ref', 'detail'],
          additionalProperties: false,
        },
      },
      reviewNotes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The death the note is about, e.g. "D7". Only deaths from the PICKED list.' },
            note: { type: 'string', description: 'One or two sentences on what the facts show about this death, citing fact IDs' },
          },
          required: ['ref', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'wentWell', 'toImprove', 'points', 'reviewNotes'],
    additionalProperties: false,
  },
};

// ---- Small helpers ----------------------------------------------------------

const average = (numbers) => (numbers.length > 0 ? numbers.reduce((sum, n) => sum + n, 0) / numbers.length : null);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const otherTeam = (team) => (team === 'ORDER' ? 'CHAOS' : 'ORDER');

// The snapshot taken closest to a game time.
function nearestSnapshot(snapshots, gameTime) {
  let nearest = snapshots[0];
  for (const snapshot of snapshots) {
    if (Math.abs(snapshot.gameTime - gameTime) < Math.abs(nearest.gameTime - gameTime)) nearest = snapshot;
  }
  return nearest;
}

// The items a player is carrying, without consumables (potions, control
// wards) and without the trinket in slot 6.
function realItems(player) {
  return (player.items || []).filter((item) => !item.consumable && item.slot !== 6).map((item) => item.displayName);
}

// The team that made a kill. If the killer's name is on both teams (two bots
// with the same name), the victim settles it: the killer is on the other team.
function killingTeam(players, kill) {
  const own = teamOfEventName(players, kill.event.KillerName);
  if (own) return own;
  if (findPlayersByEventName(players, kill.event.KillerName).length === 0) return null; // a turret, a monster
  const victim = teamOfEventName(players, kill.event.VictimName);
  return victim ? otherTeam(victim) : null;
}

const compare = (mine, theirs) => (mine > theirs ? 'ahead' : mine < theirs ? 'behind' : 'equal');

// A comparison inside a fact, in the form the checker uses:
//   scope   who the player is compared with: 'teammates', 'enemies',
//           'laneOpponent' or 'killer'
//   name    for 'killer': the killer's name
//   total   how many times the two numbers were compared (1 for one moment)
//   counts  how many of those came out ahead / equal / behind
// The counts come from the two numbers themselves, so the checker can test
// "lower at 0 marks" against the count instead of reacting to the word "lower".
function comparison(scope, mine, theirs, name = null) {
  const relation = compare(mine, theirs);
  return { scope, name, total: 1, counts: { ahead: Number(relation === 'ahead'), equal: Number(relation === 'equal'), behind: Number(relation === 'behind') } };
}

const OBJECTIVE_EVENT = /^(TurretKilled|InhibKilled|DragonKill|HeraldKill|BaronKill|HordeKill)$/;
const MONSTER_NAMES = { DragonKill: 'a dragon', HeraldKill: 'the Rift Herald', BaronKill: 'Baron Nashor', HordeKill: 'a Voidgrub' };

// The team that TOOK an objective, or null if the log can't tell.
// A turret or an inhibitor has its owner in its name ("Turret_TChaos_..."),
// and the team that took it is the other one. A dragon or another monster
// goes to the team of whoever killed it or, if that name is on both teams
// (two bots with the same name), of whoever assisted.
function objectiveTeam(players, event) {
  const building = event.event.TurretKilled || event.event.InhibKilled;
  if (building) {
    if (/_TOrder_/i.test(building)) return 'CHAOS';
    if (/_TChaos_/i.test(building)) return 'ORDER';
    return null;
  }
  for (const name of [event.event.KillerName, ...(event.event.Assisters || [])]) {
    const team = teamOfEventName(players, name);
    if (team) return team;
  }
  return null;
}

// An objective in words. The logger describes most of them itself ("Fire
// dragon killed by Zaahen Bot"); for the few it only names ("HordeKill"),
// the words are made here.
function objectiveText(event) {
  if (event.description && event.description !== event.event.EventName) return event.description;
  return `${MONSTER_NAMES[event.event.EventName] || event.event.EventName} killed by ${event.event.KillerName}`;
}

// Why a death got its score, e.g. "+1 no teammate got a kill ...; +2 it is
// part of a run ...".
function scoreReasons(death) {
  return death.rules.map((id) => SCORE_RULES.find((rule) => rule.id === id)).map((rule) => `+${rule.points} ${rule.description}`);
}

// What Claude's answer cost in US dollars, or null if the model's prices are
// not in PRICES. `usage` is the token count the API sends back with every
// answer. The tokens Claude uses for thinking are part of its output tokens.
function costOf(usage) {
  const price = PRICES[MODEL];
  if (!price) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const rate = input > price.longPromptTokens ? price.long : price;
  return (input * rate.input + (usage.output_tokens || 0) * rate.output) / 1e6;
}
const dollars = (cost) => (cost === null ? 'unknown (no prices for this model in report.js)' : `$${cost.toFixed(4)}`);

// ---- Step 1: the numbers, worked out by code -----------------------------------

// Everything the report is based on. `placed` comes from placeOnVideo in
// analyze.js: the events and snapshots, each with its position in the video.
// `mode` is the game's mode code from session.json (e.g. "CLASSIC", "KIWI").
// Returns null if the player is not in the snapshots.
function buildStats(placed, playerName, mode = null) {
  const aram = ARAM_MODES.includes(mode);
  const events = placed.events;
  const snapshots = placed.snapshots
    .filter((snapshot) => Array.isArray(snapshot.players) && snapshot.players.some((p) => isMyPlayer(p, playerName)));
  if (snapshots.length === 0) return null;

  const meIn = (snapshot) => snapshot.players.find((p) => isMyPlayer(p, playerName));
  const last = snapshots[snapshots.length - 1];
  const me = meIn(last);
  const myTeam = me.team;
  const gameEnd = events.find((event) => event.event && event.event.EventName === 'GameEnd');
  const gameLengthSeconds = gameEnd ? gameEnd.gameTime : last.gameTime;
  // A moment's times, rounded by the one rule (see round1 in analyze.js). Its
  // text times are made from these same numbers by clock(), so the facts, the
  // review list and the tables can never show two different times for it.
  const moment = (entry) => ({ gameSeconds: round1(entry.gameTime), videoSeconds: round1(entry.videoSeconds) });
  const clock = (at) => ({ gameTime: mmss(at.gameSeconds), videoTime: mmss(at.videoSeconds) });

  const championKills = events.filter((event) => event.event && event.event.EventName === 'ChampionKill');
  const myKills = championKills.filter((event) => isPlayerName(event.event.KillerName, playerName));
  const myDeaths = championKills.filter((event) => isPlayerName(event.event.VictimName, playerName));
  // Turrets, inhibitors, dragons and other monsters the ENEMY team took.
  const enemyObjectives = events.filter((event) => event.event && OBJECTIVE_EVENT.test(event.event.EventName)
    && objectiveTeam(last.players, event) === otherTeam(myTeam));

  // ---- Deaths ----
  const deaths = myDeaths.map((death, i) => {
    const snapshot = nearestSnapshot(snapshots, death.gameTime);
    // Whoever killed the player is on the other team (that settles it when
    // both teams have a bot with the same name).
    const killer = findPlayersByEventName(snapshot.players, death.event.KillerName).find((p) => p.team !== myTeam) || null;

    // How long was the player dead? The first snapshot after the death says
    // how many seconds are left until the respawn.
    const after = snapshots.find((s) => s.gameTime >= death.gameTime && meIn(s).isDead);
    const secondsDead = after && after.gameTime - death.gameTime < 15
      ? round1(after.gameTime - death.gameTime + (meIn(after).respawnTimer || 0)) : null;

    // Rule "after-own-kill": the player's own kills just before this death.
    const killsBefore = myKills.filter((kill) => kill.gameTime <= death.gameTime && death.gameTime - kill.gameTime <= AFTER_KILL_SECONDS);

    // Rule "no-team-fight": did any TEAMMATE get a kill or an assist just before?
    const teammateTookPart = championKills.some((kill) => kill !== death
      && kill.gameTime <= death.gameTime && death.gameTime - kill.gameTime <= NO_TEAM_SECONDS
      && killingTeam(snapshot.players, kill) === myTeam
      && (!isPlayerName(kill.event.KillerName, playerName)
        || (kill.event.Assisters || []).some((name) => !isPlayerName(name, playerName))));

    // Who else died within a few seconds.
    const nearbyTeams = championKills
      .filter((kill) => kill !== death && Math.abs(kill.gameTime - death.gameTime) <= NEARBY_SECONDS)
      .map((kill) => victimTeam(snapshot.players, kill));
    // The death's fact (buildFacts) and its review moment (writeReport) both
    // take their times from these saved numbers.
    const at = moment(death);
    return {
      ref: `D${i + 1}`,
      ...at,
      ...clock(at),
      eventId: death.event.EventID, // the game's own number for this kill
      killedBy: death.event.KillerName,
      killerIsChampion: killer !== null,
      assistedBy: death.event.Assisters || [],
      myLevel: meIn(snapshot).level,
      killerLevel: killer ? killer.level : null,
      secondsDead,
      secondsAfterOwnKill: killsBefore.length > 0 ? round1(death.gameTime - killsBefore[killsBefore.length - 1].gameTime) : null,
      ownKillsJustBefore: killsBefore.map((kill) => kill.event.VictimName),
      teammateKillOrAssistJustBefore: teammateTookPart,
      teammatesKilledNearby: nearbyTeams.filter((team) => team === myTeam).length,
      enemiesKilledNearby: nearbyTeams.filter((team) => team !== null && team !== myTeam).length,
      enemyObjectivesJustAfter: enemyObjectives
        .filter((objective) => objective.gameTime > death.gameTime && objective.gameTime - death.gameTime <= BEFORE_OBJECTIVE_SECONDS)
        .map((objective) => ({ what: objectiveText(objective), secondsAfter: round1(objective.gameTime - death.gameTime) })),
      secondsAliveBefore: null, // filled in below
      run: null,                // filled in below
      rules: [],                // filled in below: the score rules it matches
      score: 0,                 // filled in below
      reviewRank: null,         // filled in below: 1 = the first death to review
    };
  });

  // ---- Runs of deaths: dying again soon after coming back to life, with no
  // kill of your own in between (a kill at the same moment as the death counts) ----
  const killedBetween = (previous, death) => myKills.some((kill) => kill.gameTime > previous.gameSeconds && kill.gameTime <= death.gameSeconds);
  const runs = [];
  let current = [];
  const closeRun = () => {
    if (current.length >= 2) {
      const run = { ref: `R${runs.length + 1}`, deaths: current.map((death) => death.ref), from: current[0], to: current[current.length - 1] };
      for (const death of current) death.run = run.ref;
      runs.push(run);
    }
    current = [];
  };
  deaths.forEach((death, i) => {
    const previous = deaths[i - 1];
    if (previous && previous.secondsDead !== null) {
      death.secondsAliveBefore = round1(death.gameSeconds - (previous.gameSeconds + previous.secondsDead));
    }
    if (death.secondsAliveBefore === null || death.secondsAliveBefore > RUN_ALIVE_SECONDS || killedBetween(previous, death)) closeRun();
    current.push(death);
  });
  closeRun();

  // ---- Which deaths are worth reviewing: a score from fixed rules, no model ----
  for (const death of deaths) {
    const run = runs.find((r) => r.ref === death.run);
    const matches = {
      'no-team-fight': !death.teammateKillOrAssistJustBefore,
      'after-own-kill': death.secondsAfterOwnKill !== null,
      'death-run': Boolean(run) && run.deaths.length >= RUN_MIN_DEATHS,
      'right-after-own-kill': death.secondsAfterOwnKill !== null && death.secondsAfterOwnKill <= RIGHT_AFTER_KILL_SECONDS,
      'before-enemy-objective': death.enemyObjectivesJustAfter.length > 0,
    };
    const matched = SCORE_RULES.filter((rule) => matches[rule.id]);
    death.rules = matched.map((rule) => rule.id);
    death.score = matched.reduce((sum, rule) => sum + rule.points, 0);
  }
  const lastRule = (death) => Math.max(...death.rules.map((id) => SCORE_RULES.findIndex((rule) => rule.id === id)));
  const reviewDeaths = deaths
    .filter((death) => death.score > 0)
    // highest score first, then the rule further down SCORE_RULES, then the earlier death
    .sort((a, b) => b.score - a.score || lastRule(b) - lastRule(a) || a.gameSeconds - b.gameSeconds)
    .filter((death, i) => i < MIN_REVIEW_DEATHS || (i < MAX_REVIEW_DEATHS && death.score >= MIN_SCORE_FOR_EXTRA_REVIEW))
    .map((death, i) => {
      death.reviewRank = i + 1;
      return death.ref;
    });

  const knownDeadTimes = deaths.map((death) => death.secondsDead).filter((seconds) => seconds !== null);
  const secondsDeadTotal = round1(knownDeadTimes.reduce((sum, seconds) => sum + seconds, 0));

  // ---- Every 5 minutes: CS, level, score and items against the others ----
  const marks = [];
  for (let minute = BLOCK_MINUTES; minute * 60 <= gameLengthSeconds; minute += BLOCK_MINUTES) {
    marks.push({ seconds: minute * 60, label: `the ${minute}-minute mark` });
  }
  marks.push({ seconds: gameLengthSeconds, label: 'the end of the game' });
  let previous = { gameTime: 0, videoSeconds: null, cs: 0, label: 'the start of the game' };
  const blocks = marks.map((mark) => {
    const snapshot = nearestSnapshot(snapshots, mark.seconds);
    const mine = meIn(snapshot);
    const teammates = snapshot.players.filter((p) => p.team === mine.team && p !== mine);
    const enemies = snapshot.players.filter((p) => p.team !== mine.team);
    // The lane opponent is the enemy with the same role label ("position") as
    // you. That label is only the role the game assigned, so it is used only
    // when it is a real lane, exactly one enemy has it, and the mode has lanes
    // at all (in ARAM everyone is "NONE", which would just pick the first enemy).
    const sameRole = !aram && isRealRole(mine.position) ? enemies.filter((p) => p.position === mine.position) : [];
    const opponent = sameRole.length === 1 ? sameRole[0] : null;
    const scores = mine.scores || {};
    const killsAssists = (p) => ((p.scores || {}).kills || 0) + ((p.scores || {}).assists || 0);
    const minutes = (snapshot.gameTime - previous.gameTime) / 60;
    const at = moment(snapshot);
    const block = {
      label: mark.label,
      ...at,
      atGameTime: mmss(at.gameSeconds),
      atVideoTime: mmss(at.videoSeconds),
      level: mine.level,
      teammatesAverageLevel: round1(average(teammates.map((p) => p.level))),
      enemiesAverageLevel: round1(average(enemies.map((p) => p.level))),
      laneOpponent: opponent ? opponent.championName : null,
      laneOpponentLevel: opponent ? opponent.level : null,
      cs: scores.creepScore,
      csBefore: previous.cs,
      csSince: previous.label,
      csSinceMoment: previous.videoSeconds === null ? null : { gameSeconds: round1(previous.gameTime), videoSeconds: round1(previous.videoSeconds) },
      csPerMinuteSinceLastMark: minutes > 0 ? round1((scores.creepScore - previous.cs) / minutes) : null,
      laneOpponentCs: opponent && opponent.scores ? opponent.scores.creepScore : null,
      kills: scores.kills,
      deaths: scores.deaths,
      assists: scores.assists,
      teammatesAverageDeaths: round1(average(teammates.map((p) => (p.scores || {}).deaths || 0))),
      killsAssists: killsAssists(mine),
      teammatesAverageKillsAssists: round1(average(teammates.map(killsAssists))),
      wardScore: round1(scores.wardScore || 0),
      itemCount: realItems(mine).length,
      teammatesAverageItemCount: round1(average(teammates.map((p) => realItems(p).length))),
    };
    previous = { gameTime: snapshot.gameTime, videoSeconds: snapshot.videoSeconds, cs: scores.creepScore, label: mark.label };
    return block;
  });

  // ---- Items: when each one first showed up in the player's inventory ----
  const seen = new Set();
  const itemTimeline = [];
  for (const snapshot of snapshots) {
    for (const item of realItems(meIn(snapshot))) {
      if (seen.has(item)) continue;
      seen.add(item);
      const at = moment(snapshot);
      itemTimeline.push({ item, ...at, ...clock(at) });
    }
  }

  // ---- Kills, assists, objectives ----
  const multikills = events
    .filter((event) => event.event && event.event.EventName === 'Multikill' && isPlayerName(event.event.KillerName, playerName))
    .map((event) => {
      const count = event.event.KillStreak;
      const kills = myKills.filter((kill) => kill.gameTime <= event.gameTime).slice(-count);
      const first = kills[0] || event;
      const at = moment(first);
      return { ...at, ...clock(at), kills: count, victims: kills.map((kill) => kill.event.VictimName) };
    });
  const objectives = events
    .filter((event) => event.event && /^(TurretKilled|InhibKilled|DragonKill|HeraldKill|BaronKill|HordeKill)$/.test(event.event.EventName)
      && (isPlayerName(event.event.KillerName, playerName) || (event.event.Assisters || []).some((name) => isPlayerName(name, playerName))))
    .map((event) => ({
      ...moment(event),
      ...clock(moment(event)),
      what: event.description,
      assistOnly: !isPlayerName(event.event.KillerName, playerName),
    }));
  // Every objective the player's team took (the ones the player took part in
  // are counted even if the log can't tell which team took them).
  const teamObjectives = events.filter((event) => event.event && OBJECTIVE_EVENT.test(event.event.EventName)
    && (objectiveTeam(last.players, event) === myTeam || isPlayerName(event.event.KillerName, playerName)
      || (event.event.Assisters || []).some((name) => isPlayerName(name, playerName)))).length;
  const teamKills = last.players.filter((p) => p.team === myTeam).reduce((sum, p) => sum + ((p.scores || {}).kills || 0), 0);
  const finalScores = me.scores || {};
  const teammates = last.players.filter((p) => p.team === myTeam && p !== me);
  const enemies = last.players.filter((p) => p.team !== myTeam);

  // ---- You against each teammate, over the whole game ----
  // Used in ARAM, where there is no lane opponent. A teammate's time dead is
  // worked out the same way as yours: each of their deaths, plus the respawn
  // timer in the first snapshot after it. (A player is the same one in every
  // snapshot if the team and the champion are the same.)
  const samePlayer = (a, b) => a.team === b.team && a.championName === b.championName;
  const deathsOf = (player) => championKills.filter((kill) => {
    const snapshot = nearestSnapshot(snapshots, kill.gameTime);
    const named = findPlayersByEventName(snapshot.players, kill.event.VictimName);
    const victim = named.length === 1 ? named[0] : named.find((p) => p.team === victimTeam(snapshot.players, kill));
    return Boolean(victim) && samePlayer(victim, player);
  });
  const deadTimeOf = (player) => {
    let seconds = 0;
    let unknown = 0;
    for (const kill of deathsOf(player)) {
      const after = snapshots.find((s) => s.gameTime >= kill.gameTime && (s.players.find((p) => samePlayer(p, player)) || {}).isDead);
      const them = after ? after.players.find((p) => samePlayer(p, player)) : null;
      if (them && after.gameTime - kill.gameTime < 15) seconds += after.gameTime - kill.gameTime + (them.respawnTimer || 0);
      else unknown += 1;
    }
    return { seconds: round1(seconds), unknown };
  };
  const minutesPlayed = gameLengthSeconds / 60;
  const perMinute = (count) => Math.round((count / minutesPlayed) * 100) / 100;
  const teammateRows = teammates.map((p) => {
    const s = p.scores || {};
    const dead = deadTimeOf(p);
    return {
      champion: p.championName,
      deaths: s.deaths || 0,
      deathsPerMinute: perMinute(s.deaths || 0),
      secondsDead: dead.seconds,
      deathsWithUnknownDeadTime: dead.unknown,
      killsAssists: (s.kills || 0) + (s.assists || 0),
    };
  });
  // How you compare with the teammates on one number: their average, and how
  // many of them you did better than, the same as, and worse than.
  //   lowerIsBetter -> true for deaths and time dead
  const versusTeammates = (mine, theirs, lowerIsBetter) => ({
    mine,
    teammatesAverage: Math.round(average(theirs) * 100) / 100,
    better: theirs.filter((t) => (lowerIsBetter ? mine < t : mine > t)).length,
    same: theirs.filter((t) => mine === t).length,
    worse: theirs.filter((t) => (lowerIsBetter ? mine > t : mine < t)).length,
  });
  const teamCompare = teammates.length === 0 ? null : {
    teammates: teammateRows,
    deathsPerMinute: versusTeammates(perMinute(myDeaths.length), teammateRows.map((t) => t.deathsPerMinute), true),
    secondsDead: versusTeammates(secondsDeadTotal, teammateRows.map((t) => t.secondsDead), true),
    teammatesWithUnknownDeadTime: teammateRows.filter((t) => t.deathsWithUnknownDeadTime > 0).length,
    killsAssists: versusTeammates((finalScores.kills || 0) + (finalScores.assists || 0), teammateRows.map((t) => t.killsAssists), false),
  };

  return {
    mode,
    aram,
    champion: me.championName,
    team: myTeam,
    role: isRealRole(me.position) ? me.position : null,
    teammates: teammates.length,
    teammatesThatAreBots: teammates.filter((p) => p.isBot).length,
    enemies: enemies.length,
    enemiesThatAreBots: enemies.filter((p) => p.isBot).length,
    gameLengthSeconds: round1(gameLengthSeconds),
    gameLength: mmss(gameLengthSeconds),
    final: {
      level: me.level,
      kills: finalScores.kills,
      deaths: finalScores.deaths,
      assists: finalScores.assists,
      cs: finalScores.creepScore,
      csPerMinute: round1(finalScores.creepScore / (gameLengthSeconds / 60)),
      wardScore: round1(finalScores.wardScore || 0),
      teamKills,
      killParticipationPercent: teamKills > 0 ? Math.round(((finalScores.kills + finalScores.assists) / teamKills) * 100) : null,
    },
    multikills,
    objectives,
    teamObjectives,
    deaths,
    deathRuns: runs.map((run) => ({ ref: run.ref, deaths: run.deaths })),
    reviewDeaths,
    secondsDeadTotal,
    percentOfGameDead: round1((secondsDeadTotal / gameLengthSeconds) * 100),
    deathsWithUnknownDeadTime: deaths.length - knownDeadTimes.length,
    blocks,
    itemTimeline,
    teamCompare,
  };
}

// ---- Step 2: the facts, each with an ID ----------------------------------------

// Turns the numbers into the list of facts Claude may cite. Each fact:
//   id          "F1", "F2", ...
//   text        the fact as a sentence (this is what Claude sees)
//   kind        'total' (the whole game), 'moment' (one point in the match),
//               'span' (a stretch of the match), 'run' (a run of deaths)
//   at / span   where in the match it is, for the game and video times
//   comparisons who the player is compared with, and how it came out
//   deaths      the deaths (D1, D2, ...) it is about
//   key         for some facts: a name chooseTopics and chooseLists can find
//               the fact by
//   result -> "Win" or "Loss" from session.json (anything else: no fact)
function buildFacts(stats, playerName, result = null) {
  const facts = [];
  const add = (kind, text, extra = {}) => {
    const fact = { id: `F${facts.length + 1}`, kind, text, comparisons: [], deaths: [], runs: [], ...extra };
    facts.push(fact);
    return fact;
  };
  const f = stats.final;

  // ---- The whole game ----
  if (result === 'Win' || result === 'Loss') add('total', `The match ended in a ${result.toLowerCase()} for you.`, { key: 'result' });
  add('total', `The game lasted ${Math.floor(stats.gameLengthSeconds / 60)} minutes ${Math.floor(stats.gameLengthSeconds % 60)} seconds ` +
    `(about ${Math.round(stats.gameLengthSeconds / 60)} minutes).`, { key: 'game-length' });
  add('total', `You played ${stats.champion}${stats.role ? ` (${stats.role})` : ''}. Bots (computer-controlled players): ` +
    `${stats.teammatesThatAreBots} of your ${stats.teammates} teammates and ${stats.enemiesThatAreBots} of the ${stats.enemies} opponents.`);
  add('total', `Final score: ${plural(f.kills, 'kill')}, ${plural(f.deaths, 'death')}, ${plural(f.assists, 'assist')}; final level ${f.level}.`, { key: 'final-score' });
  add('total', `Final CS: ${f.cs}, which is ${f.csPerMinute} per minute over the whole game ` +
    `${f.csExact ? '(exact, from the League client).' : '(CS is only known in steps of 10).'}`, { key: 'final-cs' });
  if (f.killParticipationPercent !== null) {
    add('total', `Your team got ${plural(f.teamKills, 'kill')} in the whole game; you had a kill or an assist in ${f.killParticipationPercent}% of them.`,
      { key: 'kill-participation' });
  }
  if (stats.teamObjectives > 0) {
    add('total', `Your team took ${plural(stats.teamObjectives, 'objective')} (turrets, inhibitors, dragons and other monsters) in the whole game; ` +
      `you took or assisted on ${stats.objectives.length} of them, which is ${Math.round((stats.objectives.length / stats.teamObjectives) * 100)}%.`,
    { key: 'objective-share' });
  }

  // ---- Kills and objectives ----
  for (const multikill of stats.multikills) {
    add('moment', `Multikill: you killed ${multikill.kills} enemies within seconds of each other (${joinNames(multikill.victims)}).`, { at: multikill, key: 'multikill' });
  }
  if (stats.multikills.length === 0) add('total', 'You got no multikills in the whole game.');
  for (const objective of stats.objectives) {
    add('moment', `Objective: ${objective.what}${objective.assistOnly ? ' (you got the assist)' : ''}.`, { at: objective, key: 'objective' });
  }

  // ---- Deaths ----
  add('total', `You died ${plural(stats.deaths.length, 'time')} in the whole game and were dead for about ${Math.round(stats.secondsDeadTotal)} seconds in total, ` +
    `which is ${stats.percentOfGameDead}% of the game.`, { key: 'deaths-total' });
  for (const death of stats.deaths) {
    const parts = [`Death ${death.ref}: killed by ${death.killedBy}`];
    parts[0] += death.killerIsChampion
      ? ` (level ${death.killerLevel}; you were level ${death.myLevel})`
      : ` (not a champion; you were level ${death.myLevel})`;
    parts[0] += death.assistedBy.length > 0 ? `, assisted by ${joinNames(death.assistedBy)}.` : ', with no assists.';
    parts.push(death.secondsDead === null ? 'How long you were dead is unknown.' : `You were dead for about ${Math.round(death.secondsDead)} seconds.`);
    if (death.secondsAliveBefore !== null) parts.push(`You had been alive for about ${Math.round(death.secondsAliveBefore)} seconds since respawning.`);
    parts.push(death.run ? `It is part of run ${death.run}.` : 'It is not part of a run of deaths.');
    if (death.secondsAfterOwnKill !== null) {
      parts.push(`It came ${plural(Math.round(death.secondsAfterOwnKill), 'second')} after you killed ${joinNames(death.ownKillsJustBefore)}.`);
    }
    parts.push(death.teammateKillOrAssistJustBefore
      ? `A teammate got a kill or an assist in the ${NO_TEAM_SECONDS} seconds before it.`
      : `No teammate got a kill or an assist in the ${NO_TEAM_SECONDS} seconds before it.`);
    parts.push(`Others killed within ${NEARBY_SECONDS} seconds of it: ${plural(death.teammatesKilledNearby, 'teammate')} and ${plural(death.enemiesKilledNearby, 'enemy').replace('enemys', 'enemies')}.`);
    for (const objective of death.enemyObjectivesJustAfter) {
      parts.push(`The enemy team took an objective ${plural(Math.round(objective.secondsAfter), 'second')} after it (${objective.what}).`);
    }
    const fact = add('moment', parts.join(' '), {
      at: death,
      deaths: [death.ref],
      runs: death.run ? [death.run] : [],
      runMembers: death.run ? [death.ref] : [],
      comparisons: death.killerIsChampion ? [comparison('killer', death.myLevel, death.killerLevel, death.killedBy)] : [],
    });
    death.factId = fact.id;
  }
  for (const run of stats.deathRuns) {
    const members = run.deaths.map((ref) => stats.deaths.find((death) => death.ref === ref));
    add('run', `Run ${run.ref}: ${run.deaths.length} deaths in a row (${run.deaths.join(', ')}), each within ${RUN_ALIVE_SECONDS} seconds of respawning from the one before, ` +
      'with no kill of yours in between. ' +
      `It starts with ${run.deaths[0]} and ends with ${run.deaths[run.deaths.length - 1]}.`, {
      span: { from: members[0], to: members[members.length - 1] },
      deaths: run.deaths,
      runs: [run.ref],
      runMembers: run.deaths,
      key: `run:${run.ref}`,
    });
  }
  if (stats.deathRuns.length === 0) {
    add('total', `No runs of deaths: you never died within ${RUN_ALIVE_SECONDS} seconds of respawning without getting a kill of your own in between.`);
  }
  const longRuns = stats.deathRuns.filter((run) => run.deaths.length >= RUN_MIN_DEATHS);
  const inLongRun = longRuns.flatMap((run) => run.deaths);
  add('total', `${inLongRun.length} of your ${stats.deaths.length} deaths were part of a run of ${RUN_MIN_DEATHS} or more deaths in a row with no kill of yours in between` +
    `${inLongRun.length > 0 ? `: ${inLongRun.join(', ')}` : ''}.`,
  { deaths: inLongRun, runs: longRuns.map((run) => run.ref), runMembers: inLongRun, key: 'run-deaths-total' });
  const afterKill = stats.deaths.filter((death) => death.secondsAfterOwnKill !== null).map((death) => death.ref);
  add('total', `${afterKill.length} of your ${stats.deaths.length} deaths came within ${AFTER_KILL_SECONDS} seconds after one of your own kills` +
    `${afterKill.length > 0 ? `: ${afterKill.join(', ')}` : ''}.`, { deaths: afterKill, key: 'after-kill-total' });
  const noTeam = stats.deaths.filter((death) => !death.teammateKillOrAssistJustBefore).map((death) => death.ref);
  add('total', `${noTeam.length} of your ${stats.deaths.length} deaths had no teammate kill or assist in the ${NO_TEAM_SECONDS} seconds before` +
    `${noTeam.length > 0 ? `: ${noTeam.join(', ')}` : ''}.`, { deaths: noTeam, key: 'no-team-total' });
  const beforeObjective = stats.deaths.filter((death) => death.enemyObjectivesJustAfter.length > 0).map((death) => death.ref);
  add('total', `${beforeObjective.length} of your ${stats.deaths.length} deaths had the enemy team take an objective within ${BEFORE_OBJECTIVE_SECONDS} seconds after` +
    `${beforeObjective.length > 0 ? `: ${beforeObjective.join(', ')}` : ''}.`, { deaths: beforeObjective, key: 'before-objective-total' });

  // ---- Every 5 minutes ----
  for (const b of stats.blocks) {
    add('moment', `At ${b.label} your score was ${plural(b.kills, 'kill')}, ${plural(b.deaths, 'death')}, ${plural(b.assists, 'assist')}.`, { at: b });
    add('moment', `At ${b.label} you were level ${b.level}; your teammates' average level was ${b.teammatesAverageLevel}.`,
      { at: b, comparisons: [comparison('teammates', b.level, b.teammatesAverageLevel)] });
    add('moment', `At ${b.label} you were level ${b.level}; the enemies' average level was ${b.enemiesAverageLevel}.`,
      { at: b, comparisons: [comparison('enemies', b.level, b.enemiesAverageLevel)] });
    if (b.laneOpponent) {
      add('moment', `At ${b.label} you were level ${b.level}; your lane opponent ${b.laneOpponent} was level ${b.laneOpponentLevel}.`,
        { at: b, comparisons: [comparison('laneOpponent', b.level, b.laneOpponentLevel)] });
      add('moment', `At ${b.label} you had ${b.cs} CS; your lane opponent ${b.laneOpponent} had ${b.laneOpponentCs} (CS is only known in steps of 10).`,
        { at: b, comparisons: [comparison('laneOpponent', b.cs, b.laneOpponentCs)] });
    }
    // (In ARAM there is little to farm, so CS pace is not a fact the report uses.)
    if (!stats.aram) {
      add('span', `Between ${b.csSince} and ${b.label} your CS went from ${b.csBefore} to ${b.cs}, which is ${b.csPerMinuteSinceLastMark} per minute (accurate to about 2 per minute).`,
        { ...(b.csSinceMoment ? { span: { from: b.csSinceMoment, to: b } } : { at: b }), key: `cs-pace:${b.label}` });
    }
    add('moment', `At ${b.label} you carried ${plural(b.itemCount, 'item')}; your teammates' average was ${b.teammatesAverageItemCount} (components count as items).`,
      { at: b, comparisons: [comparison('teammates', b.itemCount, b.teammatesAverageItemCount)], key: `items:${b.label}` });
  }

  // ---- The same comparisons over all the marks: the only facts that cover a
  // stretch of the game. A sentence like "ahead all game" has to cite one. ----
  const blocks = stats.blocks;
  const overMarks = (what, who, scope, mine, theirs, usable = () => true) => {
    const rows = blocks.filter(usable);
    if (rows.length === 0) return;
    const of = (relation) => rows.filter((b) => compare(mine(b), theirs(b)) === relation);
    const ahead = of('ahead');
    const equal = of('equal');
    const behind = of('behind');
    let text = `Over the ${rows.length} marks from ${rows[0].label} to ${rows[rows.length - 1].label}, your ${what} was higher than ${who} at ${ahead.length}, ` +
      `the same at ${equal.length} and lower at ${behind.length}.`;
    if (behind.length > 0) {
      const caughtUp = rows.find((b) => compare(mine(b), theirs(b)) !== 'behind');
      text += ` It was lower at: ${joinNames(behind.map((b) => b.label))}.`;
      if (caughtUp) text += ` The first mark where it was not lower: ${caughtUp.label}.`;
    }
    add('span', text, {
      span: { from: rows[0], to: rows[rows.length - 1] },
      comparisons: [{ scope, name: null, total: rows.length, counts: { ahead: ahead.length, equal: equal.length, behind: behind.length } }],
      key: `over:${what} vs ${scope}`,
      marks: {
        what, who, total: rows.length, ahead: ahead.length, equal: equal.length, behind: behind.length,
        firstBehind: behind.length > 0 ? behind[0].label : null,
      },
    });
  };
  const hasOpponent = (b) => b.laneOpponent !== null;
  overMarks('level', 'your teammates\' average', 'teammates', (b) => b.level, (b) => b.teammatesAverageLevel);
  overMarks('level', 'the enemies\' average', 'enemies', (b) => b.level, (b) => b.enemiesAverageLevel);
  overMarks('level', 'your lane opponent\'s', 'laneOpponent', (b) => b.level, (b) => b.laneOpponentLevel, hasOpponent);
  overMarks('CS', 'your lane opponent\'s', 'laneOpponent', (b) => b.cs, (b) => b.laneOpponentCs, hasOpponent);
  overMarks('number of items carried', 'your teammates\' average', 'teammates', (b) => b.itemCount, (b) => b.teammatesAverageItemCount);
  if (stats.aram) {
    overMarks('number of deaths', 'your teammates\' average', 'teammates', (b) => b.deaths, (b) => b.teammatesAverageDeaths);
    overMarks('number of kills plus assists', 'your teammates\' average', 'teammates', (b) => b.killsAssists, (b) => b.teammatesAverageKillsAssists);
  }

  // ---- ARAM: you against your teammates over the whole game ----
  // These take the place of the lane opponent, which ARAM doesn't have. Each
  // fact says the teammates' average AND how many teammates you did better
  // than, so the score in chooseLists is a count that is in the fact itself.
  const team = stats.teamCompare;
  if (stats.aram && team) {
    const n = team.teammates.length;
    const d = team.deathsPerMinute;
    add('total', `Deaths per minute over the whole game: you ${d.mine}, your teammates' average ${d.teammatesAverage}. ` +
      `Of your ${n} teammates, ${d.better} died more often per minute than you, ${d.same} as often and ${d.worse} less often.`,
    { key: 'aram:deaths-per-minute', comparisons: [comparison('teammates', d.mine, d.teammatesAverage)], versus: d });
    const t = team.secondsDead;
    const unknown = team.teammatesWithUnknownDeadTime > 0 || stats.deathsWithUnknownDeadTime > 0
      ? ' For some deaths the time dead is unknown, so those deaths are left out of these totals.' : '';
    add('total', `Time spent dead over the whole game: you about ${Math.round(t.mine)} seconds, your teammates' average about ${Math.round(t.teammatesAverage)} seconds. ` +
      `Of your ${n} teammates, ${t.better} spent more time dead than you, ${t.same} the same and ${t.worse} less.${unknown}`,
    { key: 'aram:time-dead', comparisons: [comparison('teammates', Math.round(t.mine), Math.round(t.teammatesAverage))], versus: t });
    const k = team.killsAssists;
    add('total', `Kills plus assists over the whole game: you ${k.mine}, your teammates' average ${k.teammatesAverage}. ` +
      `Of your ${n} teammates, ${k.worse} had more than you, ${k.same} the same and ${k.better} fewer.`,
    { key: 'aram:kills-assists', comparisons: [comparison('teammates', k.mine, k.teammatesAverage)], versus: k });
  }

  // ---- Items ----
  for (const item of stats.itemTimeline) {
    add('moment', `Item: ${item.item} first appeared in your inventory (it may be a component, not a finished item).`, { at: item });
  }

  // What the checker compares a sentence with: the numbers and the times in
  // each fact.
  for (const fact of facts) {
    fact.numbers = numbersIn(fact.text);
    fact.times = [];
    for (const m of [fact.at, fact.span && fact.span.from, fact.span && fact.span.to]) {
      if (m) fact.times.push(mmss(m.gameSeconds), mmss(m.videoSeconds));
    }
    fact.when = whenText(fact, stats.noVideo);
  }
  return facts;
}

// "game 25:08 / video 29:18" for a fact, or null for a whole-game fact.
// Just "game 25:08" for a session that has no video.
function whenText(fact, noVideo = false) {
  if (noVideo) {
    if (fact.at) return `game ${mmss(fact.at.gameSeconds)}`;
    if (fact.span) return `game ${mmss(fact.span.from.gameSeconds)}-${mmss(fact.span.to.gameSeconds)}`;
    return null;
  }
  if (fact.at) return `game ${mmss(fact.at.gameSeconds)} / video ${mmss(fact.at.videoSeconds)}`;
  if (fact.span) {
    return `game ${mmss(fact.span.from.gameSeconds)}-${mmss(fact.span.to.gameSeconds)} / ` +
      `video ${mmss(fact.span.from.videoSeconds)}-${mmss(fact.span.to.videoSeconds)}`;
  }
  return null;
}

// ---- Step 2b: the League client's end-of-game numbers --------------------------

const PLACES = ['', 'most', '2nd most', '3rd most', '4th most', '5th most'];

// What end_stats.json (saved by end_stats.js) says about you, for the report.
// Returns null if there is no such file or you are not in it. Else:
//   cs, csPerMinute -> the exact final CS (used instead of the log's steps of 10)
//   intro           -> where the numbers come from and how the game was matched
//   facts           -> ARAM and ARAM Mayhem only: [{ id: 'E1', key, text }].
//                      Each is written by the app from the numbers alone (Claude
//                      doesn't see them), and the report shows it with its ID.
// Comparisons are only with your own teammates, as everywhere else in ARAM.
//   endTimeline     -> the saved end_timeline.json (or null): adds the team gold
//                      lead, where your deaths happened along the lane, and your
//                      level and gold against your teammates at every minute
function endOfGame(endStats, playerName, mode = null, endTimeline = null) {
  if (!endStats || !endStats.game) return null;
  const game = endStats.game;
  const identity = (game.participantIdentities || []).find((x) => x.player && isPlayerName(x.player.gameName, playerName));
  const me = identity ? (game.participants || []).find((p) => p.participantId === identity.participantId) : null;
  if (!me || !me.stats || !(game.gameDuration > 0)) return null;
  const lookups = endStats.lookups || {};
  const s = me.stats;
  const cs = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);
  const result = {
    gameId: game.gameId,
    cs,
    csPerMinute: round1(cs / (game.gameDuration / 60)),
    intro: 'From the League client\'s own end-of-game numbers (end_stats.json)' +
      `${endStats.matchedBy && endStats.matchedBy.text ? `, matched to this session by ${endStats.matchedBy.text}` : ''}.`,
    facts: [],
  };
  if (!ARAM_MODES.includes(mode)) return result;

  // rank -> for the facts that may go in "What to improve", "What went well"
  // and the Summary (see listsWithEndOfGame): how you came out against your
  // teammates, as counts that are written in the fact itself.
  const add = (key, text, rank = null) => result.facts.push({ id: `E${result.facts.length + 1}`, key, text, ...(rank ? { rank } : {}) });
  const teammates = game.participants.filter((p) => p.teamId === me.teamId && p !== me);
  const team = [me, ...teammates];
  const damage = (p) => (p.stats || {}).totalDamageDealtToChampions || 0;
  // A score from comparing with each teammate: worse = how many did better than
  // you, better = how many did worse, n = how many were compared.
  const teammateRank = (family, noun, worse, better, n) => ({
    family, n, worse, better,
    improveScore: (worse / n) * 100,
    wellScore: (better / n) * 100,
    improveMeasure: `the share of your ${n} teammates who had more ${noun} than you`,
    wellMeasure: `the share of your ${n} teammates who had less ${noun} than you`,
    improveShort: `${worse} of your ${n} teammates had more ${noun} than you`,
    wellShort: `you had more ${noun} than ${better} of your ${n} teammates`,
  });

  // Damage to champions: your place on the team and your share of it.
  const teamDamage = team.reduce((sum, p) => sum + damage(p), 0);
  const place = 1 + teammates.filter((p) => damage(p) > damage(me)).length;
  const tied = teammates.filter((p) => damage(p) === damage(me)).length;
  if (teamDamage > 0) {
    add('damage', `You dealt ${fmt(damage(me))} damage to champions: the ${PLACES[place] || `${place}th most`} of the ${team.length} players on your team` +
      `${tied > 0 ? ` (tied with ${plural(tied, 'teammate')})` : ''}, which is ${Math.round((damage(me) / teamDamage) * 100)}% of your team's ${fmt(teamDamage)}.`,
    teammateRank('damage', 'damage to champions', place - 1, teammates.length - (place - 1) - tied, teammates.length));
  }

  // You against your teammates on one number: their average, and how many
  // had more, the same, and less. `value` returns null for a player it can't
  // be worked out for (they are left out, and the fact says so).
  //   noun -> for a number that may be ranked (it fits ARAM and more is
  //           better): what it is, e.g. "gold earned". null = not ranked.
  const versus = (key, what, value, noun = null, leftOutReason = '') => {
    const mine = value(me);
    if (mine === null) return;
    const theirs = teammates.map(value).filter((v) => v !== null);
    if (theirs.length === 0) return;
    const left = teammates.length - theirs.length;
    const more = theirs.filter((t) => t > mine).length;
    const less = theirs.filter((t) => t < mine).length;
    add(key, `${what}: you ${fmt(mine)}, your teammates' average ${fmt(Math.round(average(theirs)))}. Of your ${plural(theirs.length, 'teammate')}, ` +
      `${more} had more than you, ${theirs.length - more - less} the same ` +
      `and ${less} less.${left > 0 ? ` (${plural(left, 'teammate')} ${leftOutReason} left out.)` : ''}`,
    noun ? teammateRank(key, noun, more, less, theirs.length) : null);
  };
  const stat = (name) => (p) => (p.stats || {})[name] || 0;
  const perDeath = (p) => ((p.stats || {}).deaths > 0 ? Math.round(damage(p) / p.stats.deaths) : null);
  if (perDeath(me) === null) add('damage-per-death', 'You did not die, so your damage to champions per death can\'t be worked out.');
  // Ranked: damage per death, gold and damage to objectives. Not ranked, because
  // in ARAM they depend on the champion more than on how it was played: damage
  // taken (a tank takes more on purpose), crowd control and healing (some
  // champions have little or none).
  versus('damage-per-death', 'Damage to champions per death', perDeath, 'damage to champions per death', 'who did not die');
  versus('gold', 'Gold earned', stat('goldEarned'), 'gold earned');
  versus('damage-taken', 'Damage taken', stat('totalDamageTaken'));
  versus('crowd-control', 'Crowd-control score (the client\'s "time crowd-controlling others" number)', stat('timeCCingOthers'));
  versus('healing', 'Healing (the client\'s "total heal" number)', stat('totalHeal'));
  versus('objective-damage', 'Damage to objectives (turrets, inhibitors and other objectives)', stat('damageDealtToObjectives'), 'damage to objectives');
  add('exact-cs', `Exact CS from the League client: ${fmt(cs)}, which is ${result.csPerMinute} per minute over the whole game.`);

  // The final build, by name. "Finished" only where Riot's item data says so:
  // the item is made from other items and builds into nothing.
  const items = lookups.items || {};
  const itemText = (id) => {
    const item = items[id];
    if (!item) return `item ${id} (not in the client's item list)`;
    if (item.inStore === false) return `${item.name} (not a shop item)`;
    if ((item.to || []).length > 0) return `${item.name} (builds into another item)`;
    if ((item.from || []).length > 0) return `${item.name} (finished)`;
    return `${item.name} (a basic item)`;
  };
  const build = [0, 1, 2, 3, 4, 5, 6].map((i) => s[`item${i}`]).filter(Boolean);
  if (build.length > 0) {
    add('build', `Final build at the end of the game: ${joinNames(build.map(itemText))}. When each item was bought is not in this data. ` +
      '"Finished" means Riot\'s item data lists the item as made from other items and building into nothing.');
  }

  // Augments: listed as unverified until AUGMENT_NAMES_VERIFIED is set.
  const augments = [1, 2, 3, 4, 5, 6].map((i) => s[`playerAugment${i}`]).filter(Boolean)
    .map((id) => (lookups.augments || {})[id] || `augment ${id}`);
  if (augments.length > 0) {
    add('augments', AUGMENT_NAMES_VERIFIED ? `Augments: ${joinNames(augments)}.`
      : `Augments (UNVERIFIED: the names come from the client's Arena augment list and have not been checked against a real game yet): ${joinNames(augments)}.`);
  }

  // ---- From the timeline (end_timeline.json), if it was saved ----
  const frames = endTimeline && endTimeline.timeline && Array.isArray(endTimeline.timeline.frames) ? endTimeline.timeline.frames : [];
  if (frames.length < 2 || String(endTimeline.gameId) !== String(game.gameId)) return result;
  result.timeline = true;
  const teamOf = new Map(game.participants.map((p) => [String(p.participantId), p.teamId]));
  const players = (frame) => Object.values(frame.participantFrames || {});
  const minuteMark = (frame) => clockOf(frame.timestamp / 1000);
  const last = frames[frames.length - 1];
  const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));

  // a. The team gold lead: your team's total gold earned minus the enemy's.
  const leadAt = (frame) => players(frame).reduce((sum, p) => sum + (teamOf.get(String(p.participantId)) === me.teamId ? 1 : -1) * (p.totalGold || 0), 0);
  const marks = [5, 10, 15].map((minute) => frames[minute]).filter((frame) => frame && frame !== last);
  add('gold-lead', 'Team gold lead (your team\'s total gold earned minus the enemy team\'s, the five players\' totals added up, from the client\'s once-a-minute record): ' +
    `${joinNames([...marks, last].map((frame) => `${signed(leadAt(frame))} at ${minuteMark(frame)}`))}${last ? ' (the end of the game)' : ''}.`);
  let drop = null;
  for (let i = 1; i < frames.length; i += 1) {
    const fall = leadAt(frames[i - 1]) - leadAt(frames[i]);
    if (fall > 0 && (!drop || fall > drop.fall)) drop = { fall, from: frames[i - 1], to: frames[i] };
  }
  add('gold-lead-drop', drop
    ? `The largest drop in your team's gold lead from one minute mark to the next: from ${signed(leadAt(drop.from))} at ${minuteMark(drop.from)} ` +
      `to ${signed(leadAt(drop.to))} at ${minuteMark(drop.to)}, a drop of ${fmt(drop.fall)}.`
    : 'Your team\'s gold lead never dropped from one minute mark to the next.');

  // b. Where your deaths happened along the lane. The data has no position for
  // the nexuses, so the scale runs from where each team stood at the start
  // (frame 0: in the fountain). The outer turrets are placed on it from the
  // timeline's turret events; the map is the same from both sides, so a turret
  // that was never destroyed is placed by mirroring the other one.
  const start = (team) => {
    const ps = players(frames[0]).filter((p) => teamOf.get(String(p.participantId)) === team && p.position);
    return ps.length === 0 ? null : { x: average(ps.map((p) => p.position.x)), y: average(ps.map((p) => p.position.y)) };
  };
  const from = start(me.teamId);
  const to = start(me.teamId === 100 ? 200 : 100);
  const events = frames.flatMap((frame) => frame.events || []);
  const myDeaths = events.filter((e) => e.type === 'CHAMPION_KILL' && e.victimId === me.participantId && e.position);
  if (from && to && myDeaths.length > 0) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = (p) => ((p.x - from.x) * dx + (p.y - from.y) * dy) / (dx * dx + dy * dy);
    const outer = (team) => events.find((e) => e.type === 'BUILDING_KILL' && e.towerType === 'OUTER_TURRET' && e.teamId === team && e.position);
    const mine = outer(me.teamId);
    const theirs = outer(me.teamId === 100 ? 200 : 100);
    const myTurret = mine ? along(mine.position) : theirs ? 1 - along(theirs.position) : null;
    const theirTurret = theirs ? along(theirs.position) : mine ? 1 - along(mine.position) : null;
    if (myTurret !== null) {
      const pct = (t) => `${Math.round(t * 100)}%`;
      const at = myDeaths.map((e) => along(e.position));
      const own = at.filter((t) => t <= myTurret).length;
      const past = at.filter((t) => t >= theirTurret).length;
      add('deaths-along-lane', `Where your ${plural(myDeaths.length, 'death')} happened along the lane, on a scale from your team's starting fountain (0%) ` +
        'to the enemy team\'s starting fountain (100%) - the data has no position for the nexuses, so the fountains are the ends of the scale. ' +
        `Your outer turret stands at ${pct(myTurret)} and the enemy's outer turret at ${pct(theirTurret)}. ` +
        `${own} of your deaths were on your side of your own outer turret, ${myDeaths.length - own - past} between the two outer turrets ` +
        `and ${past} past the enemy's outer turret.`);
    }
  }

  // c. Your level and gold against your teammates' averages at every minute mark.
  const minuteFrames = frames.slice(1); // frame 0 is the start, when everyone is equal
  //   roundAvg -> how the teammates' average (and the gaps) are rounded: gold
  //               to whole numbers, as in the gold-earned fact above; levels to 0.1
  //   family   -> which earlier fact it counts as one with in the lists
  const versusEachMinute = (key, what, value, roundAvg, family, unit) => {
    const rows = minuteFrames.map((frame) => {
      const mineNow = players(frame).find((p) => String(p.participantId) === String(me.participantId));
      const theirs = players(frame).filter((p) => p !== mineNow && teamOf.get(String(p.participantId)) === me.teamId).map(value);
      return { frame, mine: value(mineNow), avg: roundAvg(average(theirs)) };
    });
    const higher = rows.filter((r) => r.mine > r.avg);
    const lower = rows.filter((r) => r.mine < r.avg);
    // How big the gap was: on average over the marks, and the largest one.
    const gap = (r) => r.mine - r.avg; // below the average = negative
    const averageGap = roundAvg(average(rows.map(gap)));
    const largest = rows.reduce((best, r) => (Math.abs(gap(r)) > Math.abs(gap(best)) ? r : best), rows[0]);
    const side = (n) => (n < 0 ? 'below' : 'above');
    const amount = (n) => `${fmt(roundAvg(Math.abs(n)))} ${unit}`;
    const gapText = averageGap === 0 && gap(largest) === 0 ? ' You were level with your teammates\' average at every mark.'
      : ` On average you were ${averageGap === 0 ? 'level with' : `${amount(averageGap)} ${side(averageGap)}`} your teammates' average; ` +
        `the largest gap was ${amount(gap(largest))} ${side(gap(largest))} it, at ${minuteMark(largest.frame)}.`;
    const n = rows.length;
    add(key, `Your ${what} against your teammates' average at each of the ${n} minute marks from ${minuteMark(rows[0].frame)} to ` +
      `${minuteMark(rows[n - 1].frame)} (exact, from the client's once-a-minute record): higher at ${higher.length}, ` +
      `the same at ${n - higher.length - lower.length} and lower at ${lower.length}.` +
      `${lower.length > 0 && lower.length < n ? ` It was lower at: ${joinNames(lower.map((r) => minuteMark(r.frame)))}.` : ''}` +
      `${gapText} At the end of the game: you ${fmt(rows[n - 1].mine)}, your teammates' average ${fmt(rows[n - 1].avg)}.`, {
      family, n, worse: lower.length, better: higher.length,
      improveScore: (lower.length / n) * 100,
      wellScore: (higher.length / n) * 100,
      improveMeasure: `the share of the ${n} minute marks at which your ${what} was lower than your teammates' average`,
      wellMeasure: `the share of the ${n} minute marks at which your ${what} was higher than your teammates' average`,
      improveShort: `your ${what} was below your teammates' average at ${lower.length} of ${n} minute marks, on average by ${amount(averageGap)}`,
      wellShort: `your ${what} was above your teammates' average at ${higher.length} of ${n} minute marks`,
    });
  };
  versusEachMinute('level-each-minute', 'level', (p) => p.level || 0, round1, 'level', 'levels');
  versusEachMinute('gold-each-minute', 'gold earned so far', (p) => p.totalGold || 0, Math.round, 'gold', 'gold');
  return result;
}

// "17:58" from seconds, for the minute marks of the client's timeline.
const clockOf = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
// A number with thousands separators: 32920 -> "32,920", 17.8 -> "17.8".
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });

// The one line the report shows instead, for ARAM and ARAM Mayhem without end_stats.json.
const NO_END_STATS = 'End-of-game numbers: not available - the League client\'s numbers were not saved for this session ' +
  '(the client was not running, or the game was not found in its match history).';

// ---- Step 2c: the lists, the Summary and the points as the report shows them ----
// "What went well" and "What to improve" in report.json were picked from the
// game log's facts only (chooseLists). Here the end-of-game facts that fit ARAM
// (those with a `rank`: damage, damage per death, gold, damage to objectives,
// level and gold at every minute) are scored the SAME way - a share from 0 to
// 100 that is written in the fact - and ranked together with them:
//   - a fact is a strength or a weakness, never both: it goes to the side
//     where it scores higher (a tie goes to "What to improve")
//   - the same minimums (MIN_WENT_WELL_SCORE, MIN_TO_IMPROVE_SCORE) and at
//     most MAX_LIST_ITEMS per list
//   - one item per family: e.g. gold at the end and gold at every minute, or
//     the log's level at 4 marks and the client's level at 18, count as one
//   - equal scores: the one resting on more comparisons comes first (18
//     minute marks before 4 teammates), then the game log's
// In ARAM, a list item or point about a lane opponent or CS is left out (a
// report.json from an older version of the app may still have one), and the
// "fewer items" point is checked again with today's rule (itemsGapRule).
// Returns { summaryExtra, wentWell, toImprove, points, notes }: summaryExtra
// is one more Summary sentence naming the 2 or 3 highest-scoring end-of-game
// facts ('' if none qualifies); notes say what was left out and why.
const LOG_FAMILIES = [[/level/, 'level'], [/items/, 'items'], [/kills plus assists|kills-assists/, 'kills-assists'],
  [/time-dead/, 'time-dead'], [/deaths vs|deaths-per-minute/, 'deaths'], [/objective-share/, 'objectives']];
const NOT_ARAM = /laneOpponent|lane-opponent|\bCS\b|cs-pace|slowest-cs/;
function presentedReport(report, endNumbers, mode) {
  const aram = ARAM_MODES.includes(mode);
  const s = report.stats || {};
  const notes = [];
  const familyOf = (rule) => (LOG_FAMILIES.find(([pattern]) => pattern.test(rule)) || [null, rule])[1];
  // How many comparisons a log item's score rests on, from its own measure.
  const countOf = (item) => {
    const m = String(item.measure || '').match(/the (\d+) marks|your (\d+) teammates/);
    if (m) return Number(m[1] || m[2]);
    if (/your deaths/.test(item.measure)) return (s.deaths || []).length;
    if (/team's kills/.test(item.measure)) return (s.final || {}).teamKills || 1;
    if (/team's objectives/.test(item.measure)) return s.teamObjectives || 1;
    return 1;
  };
  const fromLog = (items, side) => (items || []).filter((item) => {
    if (aram && NOT_ARAM.test(item.rule)) {
      notes.push(`"${side}" item left out because it doesn't fit ARAM (it is about a lane opponent or CS): ${item.rule}.`);
      return false;
    }
    return true;
  }).map((item, i) => ({ item, score: item.score, n: countOf(item), family: familyOf(item.rule), order: i }));

  const ranked = aram && endNumbers ? endNumbers.facts.filter((fact) => fact.rank) : [];
  const fromEnd = (side) => ranked
    .filter((fact) => (side === 'improve' ? fact.rank.improveScore >= fact.rank.wellScore : fact.rank.wellScore > fact.rank.improveScore))
    .map((fact, i) => {
      const score = side === 'improve' ? fact.rank.improveScore : fact.rank.wellScore;
      return {
        fact,
        score,
        n: fact.rank.n,
        family: fact.rank.family,
        order: 100 + i, // after the game log's items on a full tie
        item: {
          rule: `end-of-game:${fact.key}`,
          score: round1(score),
          measure: side === 'improve' ? fact.rank.improveMeasure : fact.rank.wellMeasure,
          text: `${fact.text} [${fact.id}]`,
          writtenBy: 'end-of-game', // written by the app from the client's numbers, not by Claude
        },
      };
    });
  const pick = (candidates, minimum) => {
    const families = new Set();
    return candidates
      .sort((a, b) => b.score - a.score || b.n - a.n || a.order - b.order)
      .filter((c) => c.score >= minimum)
      .filter((c) => !families.has(c.family) && families.add(c.family))
      .slice(0, MAX_LIST_ITEMS);
  };
  const well = pick([...fromLog(report.wentWell, 'What went well'), ...fromEnd('well')], MIN_WENT_WELL_SCORE);
  const improve = pick([...fromLog(report.toImprove, 'What to improve'), ...fromEnd('improve')], MIN_TO_IMPROVE_SCORE);

  // The Summary's extra sentence: the strongest end-of-game facts, by the same
  // score, each only if it reaches the minimum of its own list.
  const strongest = [...fromEnd('improve').filter((c) => c.score >= MIN_TO_IMPROVE_SCORE).map((c) => ({ ...c, short: c.fact.rank.improveShort })),
    ...fromEnd('well').filter((c) => c.score >= MIN_WENT_WELL_SCORE).map((c) => ({ ...c, short: c.fact.rank.wellShort }))];
  const summaryPicks = pick(strongest, 0);
  const summaryExtra = summaryPicks.length === 0 ? ''
    : `The strongest of the League client's numbers (ranked by the same score as the lists below): ${summaryPicks.map((c) => `${c.short} [${c.fact.id}]`).join('; ')}.`;

  // The points: in ARAM none about a lane opponent or CS, and "fewer items"
  // only if today's rule still picks it (its reason is then today's too).
  const itemsGap = itemsGapRule(s.blocks);
  const points = (report.points || []).flatMap((point) => {
    if (aram && NOT_ARAM.test(point.rule)) {
      notes.push(`Point "${point.title}" left out because it doesn't fit ARAM.`);
      return [];
    }
    if (point.rule === 'fewer-items-than-teammates') {
      if (!itemsGap.ok) {
        notes.push(`Point "${point.title}" left out: with today's rule it no longer applies (${itemsGap.why}).`);
        return [];
      }
      return [{ ...point, why: itemsGap.why }];
    }
    return [point];
  });
  return { summaryExtra, wentWell: well.map((c) => c.item), toImprove: improve.map((c) => c.item), points, notes };
}

// ---- Step 3: the topics of the "Specific points", picked by code ----------------

// "Your slowest stretch for CS" is only a topic if that stretch was at least
// this many CS per minute under the whole game (a 5-minute figure can be off
// by about 2 either way, see DATA_LIMITS).
const CS_PACE_DROP = 2;
// "Fewer items than your teammates' average" is only a topic if you were
// behind at this many marks or more, or this many items behind at the
// 15-minute mark (one mark a single item behind is just a purchase timing).
const ITEMS_BEHIND_MARKS = 3;
const ITEMS_GAP_AT_15 = 1.5;

// The rule for the "Fewer items than your teammates' average" point, worked
// out from the 5-minute marks (the "blocks" buildStats makes, which report.json
// also saves, so report_export.js can check an older report.json the same way).
// Returns { ok, byMarks, firstBehind, why }: ok = the point applies; why = the
// reason in words, with the rule.
function itemsGapRule(blocks) {
  const behind = (blocks || []).filter((b) => b.itemCount < b.teammatesAverageItemCount);
  const at15 = (blocks || []).find((b) => b.label === 'the 15-minute mark') || null;
  const gapAt15 = at15 ? round1(at15.teammatesAverageItemCount - at15.itemCount) : null;
  const rule = `(the rule: behind at ${ITEMS_BEHIND_MARKS} or more marks, or at least ${ITEMS_GAP_AT_15} items behind at the 15-minute mark)`;
  if (behind.length >= ITEMS_BEHIND_MARKS) {
    return { ok: true, byMarks: true, firstBehind: behind[0].label, why: `you carried fewer items than your teammates' average at ${plural(behind.length, 'mark')} ${rule}` };
  }
  if (gapAt15 !== null && gapAt15 >= ITEMS_GAP_AT_15) {
    return { ok: true, byMarks: false, why: `at the 15-minute mark you carried ${at15.itemCount} items against your teammates' average of ${at15.teammatesAverageItemCount}, ${gapAt15} fewer ${rule}` };
  }
  return { ok: false, why: `behind at ${plural(behind.length, 'mark')}${gapAt15 !== null ? `, ${gapAt15} items behind at the 15-minute mark` : ''} ${rule}` };
}

// Picks what the "Specific points" are about, with fixed rules, and the facts
// each one rests on. Claude only writes the sentences. Each topic:
//   ref    "P1", "P2", ...
//   rule   the name of the rule that picked it
//   title  the heading in the report (written here, not by Claude)
//   why    why the rule applied to this match
//   facts  the IDs of the facts Claude may use for it
// `lists` is what chooseLists picked. A fact is a strength or a weakness,
// never both: a point about something to check can't rest on a fact listed
// under "What went well", and a point about something that went well can't
// rest on a fact listed under "What to improve".
function chooseTopics(stats, facts, lists = { wentWell: [], toImprove: [] }) {
  const withKey = (key) => facts.filter((fact) => fact.key === key);
  const one = (key) => withKey(key)[0] || null;
  const deathFact = (death) => facts.find((fact) => fact.id === death.factId);
  // The deaths that match a score rule: highest score first, then the earlier one.
  const deathsWith = (ruleId) => stats.deaths.filter((death) => death.rules.includes(ruleId))
    .sort((a, b) => b.score - a.score || a.gameSeconds - b.gameSeconds);
  const total = stats.deaths.length;

  const toCheck = [];  // things to check, most important first
  const wentWell = []; // things that went well, most important first
  const strengthFacts = new Set(lists.wentWell.flatMap((item) => item.facts));
  const weaknessFacts = new Set(lists.toImprove.flatMap((item) => item.facts));
  const topic = (list, rule, title, why, topicFacts) => {
    const otherSide = list === toCheck ? strengthFacts : weaknessFacts;
    const given = topicFacts.filter(Boolean);
    // The first fact is the one the rule went by: if it is on the other side, so is the whole point.
    if (given.length === 0 || otherSide.has(given[0].id)) return;
    const usable = given.filter((fact) => !otherSide.has(fact.id)).slice(0, MAX_FACTS_PER_POINT);
    // every point must rest on at least one fact with a game time
    if (usable.some((fact) => fact.when)) list.push({ rule, title, why, facts: usable.map((fact) => fact.id) });
  };

  // ---- Things to check ----
  const afterKill = deathsWith('after-own-kill');
  if (afterKill.length >= 2) {
    topic(toCheck, 'deaths-after-own-kills', 'Deaths right after your own kills',
      `${afterKill.length} of your ${total} deaths came within ${AFTER_KILL_SECONDS} seconds after one of your own kills (the rule: 2 or more)`,
      [one('after-kill-total'), ...afterKill.map(deathFact)]);
  }
  const beforeObjective = deathsWith('before-enemy-objective');
  if (beforeObjective.length >= 1) {
    topic(toCheck, 'deaths-before-enemy-objectives', 'Deaths just before the enemy took an objective',
      `${beforeObjective.length} of your ${total} deaths had the enemy team take an objective within ${BEFORE_OBJECTIVE_SECONDS} seconds after (the rule: 1 or more)`,
      [one('before-objective-total'), ...beforeObjective.map(deathFact)]);
  }
  const longestRun = [...stats.deathRuns].sort((a, b) => b.deaths.length - a.deaths.length)[0];
  if (longestRun && longestRun.deaths.length >= RUN_MIN_DEATHS) {
    const member = (ref) => deathFact(stats.deaths.find((death) => death.ref === ref));
    topic(toCheck, 'run-of-deaths', 'A run of deaths in a row',
      `run ${longestRun.ref} is ${longestRun.deaths.length} deaths in a row (the rule: a run of ${RUN_MIN_DEATHS} or more)`,
      [one(`run:${longestRun.ref}`), member(longestRun.deaths[0]), member(longestRun.deaths[longestRun.deaths.length - 1])]);
  }
  const noTeam = deathsWith('no-team-fight');
  if (noTeam.length >= 3 && noTeam.length * 2 >= total) {
    topic(toCheck, 'deaths-without-team', 'Deaths with no teammate involved just before',
      `${noTeam.length} of your ${total} deaths had no teammate kill or assist in the ${NO_TEAM_SECONDS} seconds before (the rule: 3 or more, and at least half of your deaths)`,
      [one('no-team-total'), one('deaths-total'), deathFact(noTeam[0])]);
  }
  // (Not in ARAM: there CS is not a strength or a weakness.)
  const paced = stats.aram ? [] : stats.blocks.filter((block) => block.csPerMinuteSinceLastMark !== null);
  const slowest = [...paced].sort((a, b) => a.csPerMinuteSinceLastMark - b.csPerMinuteSinceLastMark)[0];
  if (paced.length >= 2 && slowest.csPerMinuteSinceLastMark <= stats.final.csPerMinute - CS_PACE_DROP) {
    topic(toCheck, 'slowest-cs-stretch', 'Your slowest stretch for CS',
      `between ${slowest.csSince} and ${slowest.label} you got ${slowest.csPerMinuteSinceLastMark} CS per minute, against ${stats.final.csPerMinute} over the whole game ` +
      `(the rule: the slowest stretch, if it is at least ${CS_PACE_DROP} per minute under the whole game)`,
      [one(`cs-pace:${slowest.label}`), one('final-cs')]);
  }
  // Only a clear gap counts (see itemsGapRule).
  const items = one('over:number of items carried vs teammates');
  const itemsGap = itemsGapRule(stats.blocks);
  if (items && itemsGap.ok) {
    topic(toCheck, 'fewer-items-than-teammates', 'Fewer items than your teammates\' average', itemsGap.why,
      itemsGap.byMarks ? [items, one(`items:${itemsGap.firstBehind}`)] : [one('items:the 15-minute mark'), items]);
  }
  const laneFacts = [one('over:level vs laneOpponent'), one('over:CS vs laneOpponent')].filter(Boolean);
  if (laneFacts.some((fact) => fact.marks.behind >= 1)) {
    topic(toCheck, 'behind-lane-opponent', 'Behind your lane opponent',
      'your level or your CS was lower than your lane opponent\'s at one mark or more (the rule: 1 or more)', laneFacts);
  }

  // ---- Things that went well ----
  if (stats.multikills.length >= 1) {
    topic(wentWell, 'multikills', 'Your multikills', `you got ${plural(stats.multikills.length, 'multikill')} (the rule: 1 or more)`, withKey('multikill'));
  }
  // Like every strength, it needs a share of at least MIN_WENT_WELL_SCORE: here,
  // of the objectives your team took.
  const objectiveShare = stats.teamObjectives > 0 ? Math.round((stats.objectives.length / stats.teamObjectives) * 100) : 0;
  if (stats.objectives.length >= 1 && objectiveShare >= MIN_WENT_WELL_SCORE) {
    topic(wentWell, 'objectives-taken', 'Objectives you took part in',
      `you took or assisted on ${stats.objectives.length} of your team's ${plural(stats.teamObjectives, 'objective')}, ${objectiveShare}% ` +
      `(the rule: ${MIN_WENT_WELL_SCORE}% or more)`, [one('objective-share'), ...withKey('objective')]);
  }
  const levels = one('over:level vs enemies');
  if (levels && levels.marks.behind === 0 && levels.marks.equal === 0) {
    topic(wentWell, 'level-above-enemies', 'Your level against the enemies\' average',
      'your level was higher than the enemies\' average at every mark (the rule: higher at every mark)', [levels]);
  }

  // Up to MAX_CHECK_POINTS things to check, then things that went well, then
  // (if there is still room) the rest of the things to check.
  const chosen = toCheck.slice(0, MAX_CHECK_POINTS);
  chosen.push(...wentWell.slice(0, MAX_POINTS - chosen.length));
  chosen.push(...toCheck.slice(MAX_CHECK_POINTS).slice(0, MAX_POINTS - chosen.length));
  return chosen.map((chosenTopic, i) => ({ ref: `P${i + 1}`, ...chosenTopic }));
}

// Picks what the summary, "What went well" and "What to improve" are about,
// with fixed rules. Claude only writes one sentence for each item.
//
// The summary is always the same three things in the same order: the result
// (with the final score and the game length), kill participation, the deaths.
//
// For the two lists every candidate gets a score from 0 to 100, and it is
// always a percentage that is already in the candidate's fact:
//   went well  -> the share of marks at which you were HIGHER than a group,
//                 or the share of your team's kills / objectives you were in
//   to improve -> the share of marks at which you were LOWER than a group,
//                 the share of your deaths that match a pattern, or the share
//                 of the game you were dead
// The MAX_LIST_ITEMS highest scores are listed, if they reach the minimum for
// the list. Equal scores: the candidate written first below wins. The three
// level comparisons count as one: only the best of them can be listed.
// Each item: { ref, rule, score, measure, facts } (the summary: ref, rule, facts).
function chooseLists(stats, facts) {
  const one = (key) => facts.find((fact) => fact.key === key) || null;
  const share = (count, of) => (of > 0 ? (count / of) * 100 : null);
  const deathCount = stats.deaths.length;

  const well = [];
  const improve = [];
  // family -> candidates of the same family count as one
  const candidate = (list, rule, score, measure, fact, family = rule) => {
    if (fact && score !== null) list.push({ rule, score: round1(score), measure, facts: [fact.id], family });
  };

  // ---- Went well ----
  candidate(well, 'kill-participation', stats.final.killParticipationPercent,
    'the share of your team\'s kills in which you had a kill or an assist', one('kill-participation'));
  candidate(well, 'objective-share', share(stats.objectives.length, stats.teamObjectives),
    'the share of your team\'s objectives that you took or assisted on', one('objective-share'));
  // ---- Both lists: the comparisons over the 5-minute marks ----
  //   [the fact's key, family, true if a LOWER number is the good one]
  // (The lane-opponent comparisons only exist when there is a lane opponent,
  // which there never is in ARAM; see buildStats.)
  const overMarks = [
    ['level vs enemies', 'level'], ['level vs laneOpponent', 'level'], ['level vs teammates', 'level'],
    ['CS vs laneOpponent', 'cs'], ['number of items carried vs teammates', 'items'],
    ['number of deaths vs teammates', 'deaths', true], ['number of kills plus assists vs teammates', 'kills-assists'],
  ];
  for (const [key, family, lowerIsBetter] of overMarks) {
    const fact = one(`over:${key}`);
    if (!fact) continue;
    const m = fact.marks;
    const higher = [share(m.ahead, m.total), `the share of the ${m.total} marks at which your ${m.what} was higher than ${m.who}`];
    const lower = [share(m.behind, m.total), `the share of the ${m.total} marks at which your ${m.what} was lower than ${m.who}`];
    const [good, bad] = lowerIsBetter ? [lower, higher] : [higher, lower];
    candidate(well, `${lowerIsBetter ? 'lower' : 'higher'}:${key}`, good[0], good[1], fact, `well:${family}`);
    candidate(improve, `${lowerIsBetter ? 'higher' : 'lower'}:${key}`, bad[0], bad[1], fact, `improve:${family}`);
  }

  // ---- ARAM: you against each of your teammates over the whole game ----
  // The score is the share of your teammates you did better (or worse) than,
  // a count that is written in the fact.
  const team = stats.teamCompare;
  if (stats.aram && team) {
    const n = team.teammates.length;
    const versus = (key, family, betterText, worseText) => {
      const fact = one(key);
      if (!fact) return;
      candidate(well, `${key}:better`, share(fact.versus.better, n), `the share of your ${n} teammates ${betterText}`, fact, `well:${family}`);
      candidate(improve, `${key}:worse`, share(fact.versus.worse, n), `the share of your ${n} teammates ${worseText}`, fact, `improve:${family}`);
    };
    versus('aram:deaths-per-minute', 'deaths', 'who died more often per minute than you', 'who died less often per minute than you');
    versus('aram:time-dead', 'time-dead', 'who spent more time dead than you', 'who spent less time dead than you');
    versus('aram:kills-assists', 'kills-assists', 'who had fewer kills plus assists than you', 'who had more kills plus assists than you');
  }
  // ---- To improve: the deaths ----
  const deathsWith = (ruleId) => stats.deaths.filter((death) => death.rules.includes(ruleId)).length;
  candidate(improve, 'deaths-without-team', share(deathsWith('no-team-fight'), deathCount),
    `the share of your deaths with no teammate kill or assist in the ${NO_TEAM_SECONDS} seconds before`, one('no-team-total'));
  candidate(improve, 'deaths-in-a-run', share(deathsWith('death-run'), deathCount),
    `the share of your deaths that were part of a run of ${RUN_MIN_DEATHS} or more deaths in a row with no kill of yours in between`, one('run-deaths-total'));
  candidate(improve, 'time-dead', deathCount > 0 ? stats.percentOfGameDead : null, 'the share of the game you were dead', one('deaths-total'), 'improve:time-dead');
  candidate(improve, 'deaths-after-own-kills', share(deathsWith('after-own-kill'), deathCount),
    `the share of your deaths that came within ${AFTER_KILL_SECONDS} seconds after one of your own kills`, one('after-kill-total'));
  candidate(improve, 'deaths-before-enemy-objectives', share(deathsWith('before-enemy-objective'), deathCount),
    `the share of your deaths with an enemy objective within ${BEFORE_OBJECTIVE_SECONDS} seconds after`, one('before-objective-total'));

  // A fact can be a strength or a weakness, not both. Where the same fact is a
  // candidate in both lists (e.g. "higher at 2 marks, lower at 2"), it stays
  // only in the list where it scores higher; on a tie it goes to "To improve".
  // (It may then still miss that list's minimum, and be in neither.)
  const scoreIn = (list, factId) => Math.max(-1, ...list.filter((item) => item.facts.includes(factId)).map((item) => item.score));
  const inBoth = new Set(well.flatMap((item) => item.facts).filter((id) => improve.some((item) => item.facts.includes(id))));
  const keep = (list, other, winsTie) => list.filter((item) => item.facts.every((id) => !inBoth.has(id)
    || scoreIn(list, id) > scoreIn(other, id) || (winsTie && scoreIn(list, id) === scoreIn(other, id))));
  const wellOnly = keep(well, improve, false);
  const improveOnly = keep(improve, well, true);

  const pick = (list, minimum, letter) => {
    const families = new Set();
    return list
      .map((item, i) => ({ item, i }))
      .sort((a, b) => b.item.score - a.item.score || a.i - b.i) // highest score first, then the order above
      .map(({ item }) => item)
      .filter((item) => item.score >= minimum)
      .filter((item) => !families.has(item.family) && families.add(item.family))
      .slice(0, MAX_LIST_ITEMS)
      .map(({ family, ...item }, i) => ({ ref: `${letter}${i + 1}`, ...item }));
  };

  const summary = [
    { rule: 'result', facts: [one('result'), one('final-score'), one('game-length')] },
    { rule: 'kill-participation', facts: [one('kill-participation')] },
    { rule: 'deaths', facts: [one('deaths-total')] },
  ].map((item) => ({ ...item, facts: item.facts.filter(Boolean).map((fact) => fact.id) }))
    .filter((item) => item.facts.length > 0)
    .map((item, i) => ({ ref: `S${i + 1}`, ...item }));

  return {
    summary,
    wentWell: pick(wellOnly, MIN_WENT_WELL_SCORE, 'W'),
    toImprove: pick(improveOnly, MIN_TO_IMPROVE_SCORE, 'I'),
  };
}

// ---- Step 4: the text that is sent to Claude ----------------------------------

// The report only uses a highlight that has a kill of your own in it: one of
// its events (its "whoParts", see who.js) is a champion kill by you. One
// where you only got an assist, or only stayed alive, is left out.
// highlights.json itself is not changed: the clips are still all there.
// Returns { kept, leftOut } (both lists of highlights). Without a game log
// nothing can be checked, so then every highlight is kept.
function highlightsWithOwnKill(highlights, log, playerName) {
  if (!log) return { kept: highlights, leftOut: [] };
  const context = who.contextFromLog(log, playerName);
  const byId = new Map(context.events.filter((e) => e.event && e.event.EventID !== undefined).map((e) => [e.event.EventID, e]));
  const hasOwnKill = (h) => {
    const parts = Array.isArray(h.whoParts) ? h.whoParts : who.partsOfOldHighlight(h, context);
    return (parts || []).some((part) => part.type === 'events' && (part.eventIds || []).some((id) => {
      const e = byId.get(id);
      return Boolean(e) && e.event.EventName === 'ChampionKill' && isPlayerName(e.event.KillerName, playerName);
    }));
  };
  return { kept: highlights.filter(hasOwnKill), leftOut: highlights.filter((h) => !hasOwnKill(h)) };
}

// The highlights analyze.js saved for this session (only those with a kill
// of your own, see highlightsWithOwnKill), as the stretch of the game each
// one covers: [{ gameSeconds, lengthSeconds }]. An empty list if
// highlights.json is not there or can't be used; `problem` then says why.
// `leftOut` is how many were left out for having no kill of yours.
function readHighlights(sessionFolder, log, playerName) {
  const read = readJson(path.join(sessionFolder, 'highlights.json'));
  if (read.error) return { highlights: [], problem: read.error, leftOut: 0 };
  if (!read.data || !Array.isArray(read.data.highlights)) return { highlights: [], problem: 'it has no list of highlights', leftOut: 0 };
  // A clip ends some seconds after the highlight's last event (see
  // PAD_AFTER_SECONDS in analyze.js); those seconds are taken off again.
  const padAfter = read.data.clipPadding && typeof read.data.clipPadding.afterSeconds === 'number' ? read.data.clipPadding.afterSeconds : 0;
  const withKill = highlightsWithOwnKill(read.data.highlights.filter(Boolean), log, playerName);
  const highlights = withKill.kept
    // (A newer highlights.json says the length itself, which also works for a
    // session with no video; an older one only has the clip's video times.)
    .filter((h) => h && typeof h.gameSeconds === 'number'
      && (typeof h.lengthSeconds === 'number' || [h.videoSeconds, h.clipEndSeconds].every((value) => typeof value === 'number')))
    .map((h) => ({
      gameSeconds: h.gameSeconds,
      lengthSeconds: typeof h.lengthSeconds === 'number' ? h.lengthSeconds : Math.max(0, h.clipEndSeconds - padAfter - h.videoSeconds),
    }));
  return { highlights, problem: null, leftOut: withKill.leftOut.length };
}

// One line per player in a snapshot, e.g. "Sett L9 1/3/2 CS 40 DEAD (12s)".
function describePlayer(player) {
  const s = player.scores || {};
  const dead = player.isDead ? ` DEAD (${Math.ceil(player.respawnTimer || 0)}s)` : '';
  return `${player.championName} L${player.level} ${s.kills ?? '?'}/${s.deaths ?? '?'}/${s.assists ?? '?'} CS ${s.creepScore ?? '?'}${dead}`;
}

// The only raw game log Claude gets: the events and snapshots from
// EXCERPT_SECONDS before to EXCERPT_SECONDS after each highlight and each
// death picked for review. Stretches that overlap become one excerpt. This is
// background for Claude: it can't be cited.
// Returns [{ about, fromGameSeconds, toGameSeconds, lines }].
function buildExcerpts(placed, playerName, stats, highlights) {
  const stretches = [
    ...highlights.map((h, i) => ({ about: `highlight ${i + 1}`, from: h.gameSeconds - EXCERPT_SECONDS, to: h.gameSeconds + h.lengthSeconds + EXCERPT_SECONDS })),
    ...stats.reviewDeaths.map((ref) => stats.deaths.find((death) => death.ref === ref))
      .map((death) => ({ about: `death ${death.ref}`, from: death.gameSeconds - EXCERPT_SECONDS, to: death.gameSeconds + EXCERPT_SECONDS })),
  ].sort((a, b) => a.from - b.from);
  const merged = [];
  for (const stretch of stretches) {
    const previous = merged[merged.length - 1];
    if (previous && stretch.from <= previous.to) {
      previous.to = Math.max(previous.to, stretch.to);
      previous.about.push(stretch.about);
    } else {
      merged.push({ about: [stretch.about], from: stretch.from, to: stretch.to });
    }
  }

  const entries = placed.events.map((event) => ({ gameTime: event.gameTime, videoSeconds: event.videoSeconds, text: event.description }));
  for (const snapshot of placed.snapshots) {
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const me = players.find((p) => isMyPlayer(p, playerName));
    if (!me) continue;
    const team = (name) => players.filter((p) => p.team === name && p !== me).map(describePlayer).join(', ');
    entries.push({
      gameTime: snapshot.gameTime,
      videoSeconds: snapshot.videoSeconds,
      text: `Snapshot - ${playerName}: ${describePlayer(me)} | teammates: ${team(me.team)} | enemies: ${team(otherTeam(me.team))}`,
    });
  }
  entries.sort((a, b) => a.gameTime - b.gameTime);

  return merged.map((stretch) => ({
    about: joinNames(stretch.about),
    fromGameSeconds: round1(Math.max(0, stretch.from)),
    toGameSeconds: round1(stretch.to),
    lines: entries.filter((entry) => entry.gameTime >= stretch.from && entry.gameTime <= stretch.to)
      .map((entry) => `[game ${mmss(entry.gameTime)}${placed.noVideo ? '' : ` / video ${mmss(entry.videoSeconds)}`}] ${entry.text}`),
  }));
}

function buildPrompt(playerName, stats, facts, lists, topics, excerpts) {
  const picked = stats.reviewDeaths.map((ref) => stats.deaths.find((death) => death.ref === ref));
  const itemLines = (items) => (items.length === 0 ? '(none)'
    : items.map((item) => `${item.ref} - write it from these facts only: ${item.facts.map((id) => `[${id}]`).join(', ')}`).join('\n'));
  return `You are writing a short, strictly factual performance report for the League of Legends player ${playerName}.

A program has already worked out every number and picked everything the report is about: the summary, what went well, what to improve, the points and the deaths to review. Your only job is to put the facts it picked into plain sentences. A second program then checks every sentence you write against the facts it cites, and removes what it can't verify.

FACTS (the only things you may state; cite them by ID)
${facts.map((fact) => `[${fact.id}]${fact.when ? ` (${fact.when})` : ''} ${fact.text}`).join('\n')}

SUMMARY (picked by the program, in this order - you can't add, remove or reorder any)
${itemLines(lists.summary)}

WENT WELL (picked by the program with a fixed score - you can't add or remove any)
${itemLines(lists.wentWell)}

TO IMPROVE (picked by the program with a fixed score - you can't add or remove any)
${itemLines(lists.toImprove)}

POINTS (picked by the program with fixed rules - you can't add, remove or rename any)
${topics.length === 0 ? '(none)' : topics.map((topic) => `${topic.ref} "${topic.title}" - write it from these facts only: ${topic.facts.map((id) => `[${id}]`).join(', ')}`).join('\n')}

DEATHS PICKED FOR REVIEW (picked by the program with a fixed score - you can't add or remove any, and the score itself is not a fact: don't mention it)
${picked.length === 0 ? '(none)' : picked.map((death) => `${death.ref} = fact [${death.factId}]. Picked because: ${death.rules.map((id) => SCORE_RULES.find((rule) => rule.id === id).description).join('; ')}.`).join('\n')}

WHAT THE DATA DOES NOT CONTAIN
${dataLimitsFor(stats.mode).map((limit) => `- ${limit}`).join('\n')}

EXCERPTS OF THE GAME LOG (background only, so you understand these moments - you may NOT cite them or take numbers from them. Each one runs from ${EXCERPT_SECONDS} seconds before to ${EXCERPT_SECONDS} seconds after a highlight or a death picked for review; the rest of the log is not shown.)
${excerpts.length === 0 ? '(none)' : excerpts.map((excerpt) => `--- Around ${excerpt.about} ---\n${excerpt.lines.join('\n') || '(nothing was logged in this stretch)'}`).join('\n')}

Write:
- "summary": one sentence for each item in the SUMMARY list (its "ref" is the S number), using only the facts listed for that item.
- "wentWell": one sentence for each item in the WENT WELL list (its "ref" is the W number), using only the facts listed for that item.
- "toImprove": one sentence for each item in the TO IMPROVE list (its "ref" is the I number), using only the facts listed for that item. Say what the fact shows${stats.noVideo ? '.' : '; you may add that it is something to check in the recording.'}
- "points": one entry for each point in the POINTS list (its "ref" is the P number), with a "detail" of two or three sentences. Use only the facts listed for that point, and don't write a title: the program adds it.
- "reviewNotes": one note for each death in the PICKED list (its "ref" is the D number), one or two sentences on what the facts show about that death.

Rules - the checking program enforces all of these:
1. EVERY sentence must cite at least one fact ID in square brackets, inside the sentence, before the full stop: "You died 15 times [F9]." or "... [F12, F15]." A sentence with no citation is deleted.
2. Say only what the facts you cite in that sentence say. Every number in a sentence must appear in a fact cited in the same sentence. Don't do arithmetic and don't round.
3. Never write a clock time. The program adds the game time and video time of every fact you cite.
4. Comparisons: name who the cited fact compares ${playerName} with in the fact's own words - "your teammates' average", "the enemies' average", "your lane opponent", or the name of the killer. Never a wider or different group: a fact about the lane opponent is NOT a fact about "the enemies", and a fact about the teammates' average is NOT a fact about "your team" or "your teammates". A sentence that widens the group is deleted. Say "higher", "lower" or "the same" only as the numbers in the cited fact show, and when you say at how many marks, use the fact's own count.
5. Stretches of the game: don't write "all game", "the whole game", "most of the game", "almost", "always", "never", "throughout" or "from the start" unless you cite a fact that covers that stretch (a whole-game total, or an "Over the N marks ..." fact), and then keep to its counts.
6. Runs of deaths: say a death is part of a run only if its fact says so, and cite that run's fact. Don't use the word "cluster".
7. The data shows WHAT happened, never WHY. Don't guess at a cause, and never mention damage, gold, health, positioning, vision, or the use of abilities or summoner spells. ${stats.noVideo
    ? 'There is NO recording of this match: never mention a recording, a video, a replay or rewatching anything. A sentence that does is deleted.'
    : 'Advice must be phrased as something to check in the recording.'}
8. Write plainly, to ${playerName} as "you". No headings or lists inside a sentence.${stats.aram
    ? '\n9. This match is ARAM: there are no lanes. Never mention a lane, a lane opponent or CS.' : ''}`;
}

// ---- Step 5: check what Claude wrote -------------------------------------------

const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const CITATION = /\[\s*(F\d+(?:\s*[,;]\s*F\d+)*)\s*\]/g;
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b/g;
const SPAN_WORDS = /\b(?:whole|entire|all) (?:game|match)\b|\ball game\b|\bthroughout\b|\balways\b|\bnever\b|\bevery\b|\bmost of\b|\balmost\b|\bfrom the start\b|\brest of the (?:game|match)\b|\bconsistently\b|\bat all times\b/i;
// The words that make a sentence a comparison, and which way each one points.
// ("led" and "leading" are left out: "what led into it" is not a comparison.)
const DIRECTIONS = [
  { relation: 'ahead', pattern: /\b(?:ahead|higher|above|outpaced)\b|\blead\b(?! (?:in)?to\b| up\b)/gi },
  { relation: 'behind', pattern: /\b(?:behind|lower|fewer|lagged|lagging|trailed|trailing|below)\b/gi },
  { relation: 'equal', pattern: /\b(?:level with|equal(?:led)?|the same(?= (?:level|number|as|at)\b)|caught up|tied)\b/gi },
];
// The exact words a sentence must use for the group a fact compares the
// player with. (For a killer it is the killer's name.)
const GROUP_NAMES = {
  teammates: { say: 'your teammates\' average', pattern: /teammates['’] average/gi },
  enemies: { say: 'the enemies\' average', pattern: /enemies['’] average/gi },
  laneOpponent: { say: 'your lane opponent', pattern: /lane opponent/gi },
};
const groupSay = (c) => (c.scope === 'killer' ? c.name : GROUP_NAMES[c.scope].say);
const groupPattern = (c) => (c.scope === 'killer'
  ? new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  : new RegExp(GROUP_NAMES[c.scope].pattern.source, 'gi'));
// Words for a group of players that is NOT one of the exact names above. In a
// comparison they mean the sentence compares the player with someone else
// than the fact does. ("2 enemies were killed" and "a teammate got a kill"
// are not groups the player is compared with, so they don't match.)
const OTHER_GROUP = /\bthe enem(?:y|ies)\b(?! (?:was|were) killed)|\benemy team\b|\bthe other team\b|\bopponents\b|\byour team\b|\b(?:your|the) teammates\b(?! (?:got|died|was killed|were killed))|\beveryone\b|\ball (?:the )?(?:other )?players\b/i;
const SAYS_RUN = /\brun\b|\bdeaths in a row\b|\bcluster\b|\bR\d+\b/i;

// The numbers in a text (digits, and words like "nine"), without clock times
// and without references like D3, R1 or F12.
function numbersIn(text) {
  const plain = String(text)
    .replace(CLOCK_TIME, ' ')
    .replace(/\b[DRF]\d+\b/g, ' ')
    .replace(/-/g, ' ')
    .toLowerCase();
  const numbers = (plain.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  for (const word of plain.match(/[a-z]+/g) || []) {
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)) numbers.push(NUMBER_WORDS[word]);
  }
  return [...new Set(numbers)];
}

// Every comparison word in a text, in the order they appear:
// [{ relation, word, at }] (`at` = where in the text the word starts).
function comparisonWords(text) {
  return DIRECTIONS
    .flatMap(({ relation, pattern }) => [...text.matchAll(pattern)].map((match) => ({ relation, word: match[0], at: match.index })))
    .sort((a, b) => a.at - b.at);
}

// How often a sentence says a comparison came out one way:
//   "lower at 2 marks" -> 2      "higher at every mark" -> 'all'
//   "lower at 0", "never lower" -> 0
//   just "higher" -> null (meaning: at least once)
//   "not lower" -> 'unclear' (it may be about one mark or about all of them,
//                  so the word is not held against the sentence)
//   until     -> where the next comparison word starts (its count is its own)
//   overMarks -> true if a cited fact counts marks; only then is "at 9" a count
function claimedCount(text, claim, until, overMarks) {
  const before = text.slice(Math.max(0, claim.at - 30), claim.at);
  if (/\bnever\b[^.,;]*$/i.test(before)) return 0;
  if (/(?:\bnot|\bno|n['’]t|\bnor|\bneither)\b[^.,;]*$/i.test(before)) return 'unclear';
  if (!overMarks) return null;
  const after = text.slice(claim.at + claim.word.length, until).match(/\bat (all|every|each|no|none|zero|one|\d+|[a-z]+)\b/i);
  if (!after) return null;
  const word = after[1].toLowerCase();
  if (/^\d+$/.test(word)) return Number(word);
  if (word === 'all' || word === 'every' || word === 'each') return 'all';
  if (word === 'no' || word === 'none' || word === 'zero') return 0;
  if (word === 'one') return 1;
  return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word) ? NUMBER_WORDS[word] : null; // "at the 5-minute mark": no count
}

// Does a sentence compare the player with a different or wider group than
// the facts it cites? ("higher than the enemies" on a lane-opponent fact.)
// Returns the reason, or null. Such a sentence is dropped, not just set aside.
function widensGroup(sentence, cited) {
  let text = sentence.replace(CITATION, ' ');
  const comparisons = cited.flatMap((fact) => fact.comparisons);
  if (comparisons.length === 0 || comparisonWords(text).length === 0) return null;
  // take out the groups the facts do name; any group word left over is another group
  for (const c of comparisons) text = text.replace(groupPattern(c), ' ');
  const other = text.match(OTHER_GROUP);
  if (!other) return null;
  return `it compares you with "${other[0]}", but the facts it cites compare you with ` +
    `${[...new Set(comparisons.map(groupSay))].map((name) => `"${name}"`).join(' or ')}`;
}

// Checks one sentence against the facts it cites. Returns a list of problems
// (empty = everything in it could be verified).
//   deathRef -> for a review note: the death the note is about
function checkSentence(sentence, cited, deathRef = null) {
  const problems = [];
  const text = sentence.replace(CITATION, ' ');

  // Times: Claude was told not to write any. One that is there must be the
  // time of a cited fact.
  for (const time of text.match(CLOCK_TIME) || []) {
    if (!cited.some((fact) => fact.times.includes(time))) problems.push(`the time ${time} is not the time of a cited fact`);
  }

  // Deaths and runs it names must be the ones the cited facts are about.
  for (const ref of new Set(text.match(/\bD\d+\b/g) || [])) {
    if (!cited.some((fact) => fact.deaths.includes(ref))) problems.push(`it names ${ref}, but no cited fact is about ${ref}`);
  }
  for (const ref of new Set(text.match(/\bR\d+\b/g) || [])) {
    if (!cited.some((fact) => fact.runs.includes(ref))) problems.push(`it names ${ref}, but no cited fact is about ${ref}`);
  }

  // Counts and other numbers: each must appear in a cited fact.
  for (const number of numbersIn(text)) {
    if (!cited.some((fact) => fact.numbers.includes(number))) problems.push(`the number ${number} is not in the cited facts`);
  }

  // A stretch of the game needs a fact that covers a stretch.
  const span = text.match(SPAN_WORDS);
  if (span && !cited.some((fact) => fact.kind === 'total' || fact.kind === 'span' || fact.kind === 'run')) {
    problems.push(`it says "${span[0]}", but the cited facts are about single moments, not a stretch of the game`);
  }

  // Comparisons: who it is against must be named in the fact's own words, and
  // what it says about the outcome must agree with the fact's NUMBERS (see
  // `comparison` above), not just with the word used.
  const said = comparisonWords(text);
  if (said.length > 0) {
    const comparisons = cited.flatMap((fact) => fact.comparisons);
    if (comparisons.length === 0) {
      problems.push(`it makes a comparison ("${said[0].word}"), but no cited fact is a comparison`);
    } else {
      const named = comparisons.filter((c) => groupPattern(c).test(text));
      if (named.length === 0) {
        problems.push(`it makes a comparison ("${said[0].word}") without naming who with in the fact's own words: ` +
          `${[...new Set(comparisons.map(groupSay))].map((name) => `"${name}"`).join(' or ')}`);
      }
      const against = named.length > 0 ? named : comparisons;
      const overMarks = against.some((c) => c.total > 1);
      said.forEach((claim, i) => {
        const nextAt = i + 1 < said.length ? said[i + 1].at : text.length;
        const count = claimedCount(text, claim, nextAt, overMarks);
        if (count === 'unclear') return;
        const holds = against.some((c) => {
          const actual = c.counts[claim.relation];
          if (count === null) return actual > 0;      // "higher": at least once
          if (count === 'all') return actual === c.total;
          return actual === count;                    // "lower at 0", "higher at 9"
        });
        if (!holds) {
          const claimed = count === null ? '' : count === 'all' ? ' every time' : count === 0 ? ' at none (or "not")' : ` at ${count}`;
          problems.push(`it says "${claim.word}"${claimed}, but the numbers in the cited facts don't show that`);
        }
      });
    }
  }

  // Runs of deaths: every death it puts in a run must be in a cited run.
  if (SAYS_RUN.test(text)) {
    // If it cites a run's own fact, the deaths must be in THAT run; a death's
    // fact alone only vouches for that one death being in a run.
    const runFacts = cited.filter((fact) => fact.kind === 'run');
    const members = new Set((runFacts.length > 0 ? runFacts : cited).flatMap((fact) => fact.runMembers || []));
    if (/\bcluster\b/i.test(text)) problems.push('it says "cluster", which is not something the facts define');
    if (members.size === 0) {
      problems.push('it talks about a run of deaths, but no cited fact is about a run');
    } else {
      const named = new Set(text.match(/\bD\d+\b/g) || []);
      if (deathRef) named.add(deathRef);
      for (const ref of named) {
        if (!members.has(ref)) problems.push(`it puts ${ref} in a run of deaths, but the cited facts don't`);
      }
    }
  }
  return problems;
}

// Splits a text into sentences. A citation Claude put just after the full
// stop is first moved back inside its sentence.
function splitSentences(text) {
  return String(text || '')
    .replace(/([.!?])\s*(\[\s*F\d+(?:\s*[,;]\s*F\d+)*\s*\])/g, ' $2$1')
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

// Checks every sentence of one piece of Claude's text.
//   review -> where the result is collected: { unchecked: [], dropped: [] };
//             with noVideo: true, talk of a recording is taken out (see withoutRecordingAdvice)
//   allowed -> for a point: the IDs of the facts the app picked for it. A
//              sentence citing any other fact goes to "Unchecked claims".
// Returns { text, cited }: the sentences that passed (with each citation
// showing its game and video time), and the facts they cite.
function checkText(text, section, factsById, review, deathRef = null, allowed = null) {
  const kept = [];
  const citedAll = [];
  for (const written of splitSentences(text)) {
    const sentence = review.noVideo ? withoutRecordingAdvice(written) : written;
    if (review.noVideo && MENTIONS_RECORDING.test(sentence.replace(CITATION, ' '))) {
      review.dropped.push({ section, sentence, reason: 'it talks about a recording, but this session has no video' });
      continue;
    }
    const ids = [...sentence.matchAll(CITATION)].flatMap((match) => match[1].split(/[,;]/).map((id) => id.trim()));
    const cited = [...new Set(ids)].map((id) => factsById.get(id)).filter(Boolean);
    const shown = sentence.replace(CITATION, (whole, list) => {
      const parts = list.split(/[,;]/).map((id) => id.trim()).map((id) => {
        const fact = factsById.get(id);
        if (!fact) return `${id}: no such fact`;
        return fact.when ? `${id}: ${fact.when}` : id;
      });
      return `[${parts.join('; ')}]`;
    });
    if (cited.length === 0) {
      review.dropped.push({ section, sentence: shown, reason: 'it cites no fact' });
      continue;
    }
    const widened = widensGroup(sentence, cited);
    if (widened) {
      review.dropped.push({ section, sentence: shown, reason: widened });
      continue;
    }
    const problems = checkSentence(sentence, cited, deathRef);
    for (const fact of cited) {
      if (allowed && !allowed.includes(fact.id)) problems.push(`it cites ${fact.id}, which is not one of the facts picked for this point`);
    }
    if (problems.length > 0) {
      review.unchecked.push({ section, sentence: shown, problems });
      continue;
    }
    kept.push(shown);
    for (const fact of cited) if (!citedAll.includes(fact)) citedAll.push(fact);
  }
  return { text: kept.join(' '), cited: citedAll };
}

// ---- Step 6: the report as readable text ---------------------------------------

// When no strength scored MIN_WENT_WELL_SCORE or more, "What went well" still
// names the plainest good facts: a win, and your kill participation. They are
// said NOT to be scored as strengths. '' if a strength was listed, or if
// there is neither fact. `report` is what is saved in report.json.
function standOutLine(report) {
  if ((report.wentWell || []).length > 0) return '';
  const parts = [];
  if (report.result === 'Win') parts.push('your team won the match');
  const kp = report.stats && report.stats.final ? report.stats.final.killParticipationPercent : null;
  if (typeof kp === 'number' && kp > 0) parts.push(`you had a kill or an assist in ${kp}% of your team's kills`);
  if (parts.length === 0) return '';
  const minimum = report.listRules ? report.listRules.minWentWell : MIN_WENT_WELL_SCORE;
  return `What stood out: ${joinNames(parts)}. ${parts.length === 1 ? 'This is' : 'These are'} not scored as strengths ` +
    `(no candidate scored ${minimum} or higher).`;
}

// The report as Markdown. `withFacts` adds the full list of facts at the end
// (left out in the window, where it would be a lot to scroll through).
function renderMarkdown(report, withFacts) {
  const s = report.stats;
  const shown = presentedReport(report, report.endOfGame, report.mode); // the lists with the end-of-game facts ranked in
  const fromFacts = (item) => (item.writtenBy === 'app' ? ' (Claude\'s sentence did not pass the checks, so this is the fact itself.)' : '');
  const list = (items, minimum) => [
    ...(items.length === 0 ? [`None: no candidate scored ${minimum} or higher.`]
      : items.map((item) => `- ${item.text}${fromFacts(item)}\n  Picked because: score ${Math.round(item.score)} out of 100 - ${item.measure}.`)),
    ...(items.length > 0 && items.length < MAX_LIST_ITEMS
      ? [`Only ${items.length} of the up to ${MAX_LIST_ITEMS} places are filled: no other candidate scored ${minimum} or higher.`] : []),
  ];
  // A session with no video has no Video column; ARAM has no lane opponent,
  // so its columns compare you with your teammates instead.
  const video = (value) => (report.noVideo ? [] : [value ?? '-']);
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const markColumns = s.aram
    ? ['Mark', 'Game', ...video('Video'), 'Level', 'Teammates avg', 'Enemies avg', 'Deaths', 'Teammates avg deaths', 'Kills+assists', 'Teammates avg K+A', 'K/D/A', 'Items', 'Teammates avg items']
    : ['Mark', 'Game', ...video('Video'), 'Level', 'Teammates avg', 'Enemies avg', 'Lane opp. level', 'CS', 'CS/min', 'Lane opp. CS', 'K/D/A', 'Items', 'Teammates avg items'];
  const markCells = (b) => (s.aram
    ? [b.label.replace(/^the /, ''), b.atGameTime, ...video(b.atVideoTime), b.level, b.teammatesAverageLevel, b.enemiesAverageLevel,
      b.deaths, b.teammatesAverageDeaths, b.killsAssists, b.teammatesAverageKillsAssists, `${b.kills}/${b.deaths}/${b.assists}`, b.itemCount, b.teammatesAverageItemCount]
    : [b.label.replace(/^the /, ''), b.atGameTime, ...video(b.atVideoTime), b.level, b.teammatesAverageLevel, b.enemiesAverageLevel,
      b.laneOpponentLevel ?? '-', b.cs, b.csPerMinuteSinceLastMark, b.laneOpponentCs ?? '-', `${b.kills}/${b.deaths}/${b.assists}`, b.itemCount, b.teammatesAverageItemCount]);
  const deathColumns = ['Death', 'Game', ...video('Video'), 'Killed by', 'Their level', 'Your level', 'Dead for', 'Alive before', 'Run', 'Score', 'Why', 'Review'];
  const lines = [
    `# Performance report: ${report.player}${report.champion ? ` (${report.champion})` : ''}${report.result ? ` - ${report.result}` : ''}`,
    '',
    `Game length ${s.gameLength}. Final score ${s.final.kills}/${s.final.deaths}/${s.final.assists}, level ${s.final.level}, ` +
      `CS ${s.final.cs} (${s.final.csExact ? 'exact, ' : ''}${s.final.csPerMinute} per minute), kill participation ${s.final.killParticipationPercent}%.`,
    `Bots: ${s.teammatesThatAreBots} of your ${s.teammates} teammates and ${s.enemiesThatAreBots} of the ${s.enemies} opponents.`,
    `Every sentence below cites the facts it rests on, e.g. [F12: game 25:08${report.noVideo ? '' : ' / video 29:18'}]. The facts are worked out by the app, not by Claude.`,
    ...(report.noVideo ? ['No video was recorded for this session, so every time in this report is a GAME time.'] : []),
    '',
    '## Summary',
    `Always in this order, set by the app: the result, your kill participation, your deaths${shown.summaryExtra ? ', then the strongest of the League client\'s numbers' : ''}.`,
    [report.summary.map((item) => `${item.text}${fromFacts(item)}`).join(' '), shown.summaryExtra].filter(Boolean).join(' '),
    '',
    '## What went well',
    `Picked by a score in the app, not by Claude: the ${MAX_LIST_ITEMS} highest-scoring candidates, if they score ${MIN_WENT_WELL_SCORE} or higher.`,
    ...list(shown.wentWell, MIN_WENT_WELL_SCORE),
    ...(standOutLine({ ...report, wentWell: shown.wentWell }) ? [standOutLine({ ...report, wentWell: shown.wentWell })] : []),
    '',
    '## What to improve',
    `Picked by a score in the app, not by Claude: the ${MAX_LIST_ITEMS} highest-scoring candidates, if they score ${MIN_TO_IMPROVE_SCORE} or higher.`,
    ...list(shown.toImprove, MIN_TO_IMPROVE_SCORE),
    '',
    '## Specific points',
    'The topics are picked by fixed rules in the app, not by Claude. Claude only wrote the sentences.',
    ...(shown.points.length === 0 ? ['None of the topic rules applied to this match.'] : shown.points.map((point, i) =>
      `${i + 1}. **${point.title}** - ${point.detail}` +
      `${point.writtenBy === 'app' ? '\n   (Claude\'s sentences for this point did not pass the checks, so these are the facts themselves.)' : ''}` +
      `\n   Picked because: ${point.why}.`)),
    ...shown.notes.map((note) => `_${note}_`),
    '',
    ...(s.aram ? [
      '## End-of-game numbers',
      ...(report.endOfGame && report.endOfGame.facts.length > 0
        ? [`${report.endOfGame.intro} Written by the app from those numbers, not by Claude.`,
          ...report.endOfGame.facts.map((fact) => `- ${fact.text} [${fact.id}]`)]
        : [NO_END_STATS]),
      '',
    ] : []),
    '## Deaths worth reviewing',
    `Picked by a score in the app, not by Claude. Every death gets points for each rule it matches (the rules are under the table of deaths below). ` +
      `The ${MIN_REVIEW_DEATHS} highest scores are picked, and up to ${MAX_REVIEW_DEATHS - MIN_REVIEW_DEATHS} more if they scored ${MIN_SCORE_FOR_EXTRA_REVIEW} or higher.`,
    ...(report.reviewMoments.length === 0 ? ['None of the deaths scored a point.'] : report.reviewMoments.map((moment, i) =>
      `${i + 1}. **${moment.ref}** - score ${moment.score} - game ${moment.gameTime}` +
      `${report.noVideo ? '' : ` / video ${moment.videoTime} (watch ${moment.clipStart} to ${moment.clipEnd})`}, killed by ${moment.killedBy}.\n` +
      `${moment.who ? `   Who: ${moment.who}.\n` : ''}` +
      `   Score ${moment.score}: ${moment.scoreReasons.join('; ')}.` +
      `${moment.note ? `\n   ${moment.note}` : ''}`)),
    '',
    // (Sentences that didn't pass the checks are not shown here; report.json
    // keeps them, under "unchecked".)
    '## Dropped sentences',
    ...(report.dropped.length === 0
      ? ['None.']
      : ['Claude wrote these, and the app removed them: they cite no fact, they compare you with a different or wider group than the cited fact does, ' +
        'or (in a session with no video) they talk about a recording.',
        ...report.dropped.map((item) => `- (${item.section}) "${item.sentence}" - ${item.reason}.`)]),
    '',
    '## The numbers behind this report',
    `- Deaths: ${s.deaths.length}. Time spent dead: about ${Math.round(s.secondsDeadTotal)} seconds (${s.percentOfGameDead}% of the game).`,
    `- Runs of deaths (each within ${RUN_ALIVE_SECONDS}s of respawning, with no kill of yours in between):${s.deathRuns.length === 0 ? 'none' : s.deathRuns.map((run) => `${run.ref} = ${run.deaths.join(', ')}`).join('; ')}.`,
    '',
    row(deathColumns),
    row(deathColumns.map(() => '---')),
    ...s.deaths.map((d) => row([d.ref, d.gameTime, ...video(d.videoTime), d.killedBy, d.killerLevel ?? '-', d.myLevel,
      d.secondsDead === null ? '?' : `${Math.round(d.secondsDead)}s`, d.secondsAliveBefore === null ? '-' : `${Math.round(d.secondsAliveBefore)}s`,
      d.run || '-', d.score, d.rules.map((id) => `+${report.scoreRules.find((rule) => rule.id === id).points} ${id}`).join(', ') || '-',
      d.reviewRank === null ? '-' : `#${d.reviewRank}`])),
    '',
    'The score rules:',
    ...report.scoreRules.map((rule) => `- **${rule.id}** (+${rule.points}): ${rule.description}.`),
    '',
    row(markColumns),
    row(markColumns.map(() => '---')),
    ...s.blocks.map((b) => row(markCells(b))),
    '',
    ...(s.aram && s.teamCompare ? [
      'You against each teammate over the whole game (ARAM has no lane opponent):',
      '',
      row(['Player', 'Deaths', 'Deaths per minute', 'Time dead', 'Kills+assists']),
      row(['---', '---', '---', '---', '---']),
      row([`You (${s.champion})`, s.final.deaths, s.teamCompare.deathsPerMinute.mine, `${Math.round(s.secondsDeadTotal)}s`, s.teamCompare.killsAssists.mine]),
      ...s.teamCompare.teammates.map((t) => row([t.champion, t.deaths, t.deathsPerMinute, `${Math.round(t.secondsDead)}s${t.deathsWithUnknownDeadTime > 0 ? ' (some unknown)' : ''}`, t.killsAssists])),
      '',
    ] : []),
    '## What this data can\'t tell',
    ...report.dataLimits.map((item) => `- ${item}`),
  ];
  if (withFacts) {
    lines.push('', '## The facts', ...report.facts.map((fact) => `- **${fact.id}**${fact.when ? ` (${fact.when})` : ''} ${fact.text}`));
  }
  lines.push('',
    `_Written by ${report.model} from ${report.sentToClaude.facts} facts and ${plural(report.sentToClaude.excerpts, 'excerpt')} of the game log ` +
    `(${report.sentToClaude.excerptLines} of its ${report.sentToClaude.logLines} lines). ` +
    `Tokens: ${report.tokens.input.toLocaleString('en-US')} in + ${report.tokens.output.toLocaleString('en-US')} out. Cost of this run: ${dollars(report.costUsd)}._`);
  return lines.join('\n');
}

// =============================================================================
// The whole thing, start to finish.
//   sessionFolder -> the session folder to report on
//   envFile       -> the .env file with ANTHROPIC_API_KEY in it
//   playerName    -> your in-game name, without the #tag (e.g. "VDRJ")
//   measureVideo(file) -> returns the video's real length in seconds, or throws
//   say(text)     -> called with each line to show in the window
// Returns what was saved in report.json, or null if it couldn't be done (the
// reason has then been shown with say). This function never throws.
// =============================================================================
async function writeReport({ sessionFolder, envFile, playerName, measureVideo, say }) {
  try {
    say('\n[Writing the performance report...]\n');

    // ---- Read the session's files ----
    const info = readJson(path.join(sessionFolder, 'session.json'));
    if (info.error) {
      say(`[No report: couldn't read session.json (${info.error}).]\n`);
      return null;
    }
    const sessionInfo = info.data;
    const logRead = readJson(path.join(sessionFolder, 'live_log.json'));
    if (logRead.error) {
      say(`[No report: couldn't read live_log.json (${logRead.error}).]\n`);
      return null;
    }
    const log = logRead.data;

    // ---- Line the game log up with the video (the same way analyze.js does) ----
    // A session with no video (OBS never became ready) still gets a report:
    // the numbers come from the game log, and every time is a game time.
    const started = sessionInfo.obsRecordingActuallyStartedAt || sessionInfo.obsRecordStartSentAt;
    const recordingStartMs = started ? Date.parse(started.iso) : NaN;
    const videoFile = sessionInfo.videoFile ? path.normalize(sessionInfo.videoFile) : null;
    const noVideo = !videoFile || Number.isNaN(recordingStartMs);
    if (noVideo) {
      say(`[${videoFile ? 'session.json doesn\'t say when the OBS recording started' : 'This session has no video'}, ` +
        'so the report uses GAME TIMES ONLY.]\n');
    }
    let videoDurationSeconds = !noVideo && typeof sessionInfo.videoDurationSeconds === 'number' && sessionInfo.videoDurationSeconds > 0
      ? sessionInfo.videoDurationSeconds : null;
    if (!noVideo) {
      try {
        const measured = await measureVideo(videoFile);
        if (measured > 0) videoDurationSeconds = measured;
      } catch (err) {
        // couldn't measure it: the length saved in session.json (if any) is used
      }
    }
    const placed = placeOnVideo(log, noVideo ? null : recordingStartMs, videoDurationSeconds);
    const outside = placed.eventsBeforeVideo + placed.eventsAfterVideo;
    if (outside > 0) {
      say(`[Note: ${outside} events are not on the video, so the report only covers the recorded part of the match.]\n`);
    }

    // ---- Steps 1 to 3: the numbers, the facts, the deaths to review, the topics ----
    const mode = sessionInfo.game ? sessionInfo.game.mode || null : null;
    const stats = buildStats(placed, playerName, mode);
    if (!stats) {
      say(`[No report: ${playerName} was not found in the game log's player snapshots. Check "playerName" in settings.json.]\n`);
      return null;
    }
    stats.noVideo = noVideo; // buildFacts leaves the video time out of every fact's "when"
    // The League client's end-of-game numbers, if end_stats.js saved them: the
    // exact final CS replaces the log's (which only counts in steps of 10).
    const endStatsRead = readJson(path.join(sessionFolder, 'end_stats.json'));
    const endTimelineRead = readJson(path.join(sessionFolder, 'end_timeline.json'));
    const endNumbers = endOfGame(endStatsRead.error ? null : endStatsRead.data, playerName, mode, endTimelineRead.error ? null : endTimelineRead.data);
    if (endNumbers) {
      stats.final.cs = endNumbers.cs;
      stats.final.csPerMinute = endNumbers.csPerMinute;
      stats.final.csExact = true;
      say(`[End-of-game numbers from the League client: ${endNumbers.facts.length} facts (E1-E${endNumbers.facts.length}); exact CS ${endNumbers.cs}.]\n`);
    } else if (ARAM_MODES.includes(mode)) {
      say('[End-of-game numbers: not saved for this session, so the report says so.]\n');
    }
    if (stats.aram) say('[ARAM: no lane opponent and no CS comparisons; you are compared with your teammates instead.]\n');
    const facts = buildFacts(stats, playerName, sessionInfo.game ? sessionInfo.game.result : null);
    const factsById = new Map(facts.map((fact) => [fact.id, fact]));
    // The lists first: a point may not rest on a fact that is listed on the other side.
    const lists = chooseLists(stats, facts);
    const topics = chooseTopics(stats, facts, lists);
    const scored = (items) => items.map((item) => `${item.rule} (${Math.round(item.score)})`).join(', ') || 'none';
    say(`[Worked out ${facts.length} facts. Deaths picked for review by their score: ` +
      `${stats.reviewDeaths.map((ref) => `${ref} (${stats.deaths.find((d) => d.ref === ref).score})`).join(', ') || 'none'}. ` +
      `Topics picked for the points: ${topics.map((topic) => topic.rule).join(', ') || 'none'}.]\n`);
    say(`[Picked by score - went well: ${scored(lists.wentWell)}. To improve: ${scored(lists.toImprove)}.]\n`);
    if (topics.length < MIN_POINTS) say(`[Only ${plural(topics.length, 'topic rule')} applied to this match, so there are fewer than ${MIN_POINTS} points.]\n`);

    // ---- The excerpts of the game log: around the highlights and those deaths ----
    const highlightsRead = readHighlights(sessionFolder, log, playerName);
    if (highlightsRead.problem) {
      say(`[Note: highlights.json could not be used (${highlightsRead.problem}), so Claude only gets the game log around the deaths picked for review.]\n`);
    }
    if (highlightsRead.leftOut > 0) {
      say(`[${plural(highlightsRead.leftOut, 'highlight')} left out of the report: you got no kill of your own in ${highlightsRead.leftOut === 1 ? 'it' : 'them'}.]\n`);
    }
    const excerpts = buildExcerpts(placed, playerName, stats, highlightsRead.highlights);
    const excerptLines = excerpts.reduce((sum, excerpt) => sum + excerpt.lines.length, 0);
    const logLines = placed.events.length + placed.snapshots.length;

    // ---- Step 4: ask Claude ----
    const apiKey = readApiKey(envFile);
    if (!apiKey) {
      say(`[No report: no ANTHROPIC_API_KEY was found in ${envFile}.]\n`);
      return null;
    }
    const prompt = buildPrompt(playerName, stats, facts, lists, topics, excerpts);
    say(`[Asking Claude (${MODEL}) to write the report for ${playerName} (${stats.champion}): sending ${facts.length} facts and ` +
      `${plural(excerpts.length, 'excerpt')} of the game log (${excerptLines} of its ${logLines} lines) as text...]\n`);
    let reply;
    try {
      reply = await askClaudeForJson(apiKey, prompt, REPORT_FORMAT);
    } catch (err) {
      say(`[Couldn't get the report from Claude: ${err.message}]\n`);
      return null;
    }
    const answer = reply.answer;

    // ---- Step 5: check every sentence ----
    const review = { unchecked: [], dropped: [], noVideo };
    const check = (text, section, deathRef) => checkText(text, section, factsById, review, deathRef);

    // Everything below was picked by the app (the item, and the facts it
    // rests on); Claude wrote the sentences. `phrase` checks what Claude wrote
    // for the items of one list. If none of its sentences for an item pass
    // the checks, the item shows the facts themselves instead, so an item
    // the app picked is never missing from the report.
    //   items   -> what the app picked: [{ ref, facts, ... }]
    //   written -> what Claude wrote for that list: [{ ref, <field>: text }]
    const refOf = (written) => String(written.ref).trim().replace(/^\[|\]$/g, '');
    const phrase = (items, written, field, sectionOf) => {
      for (const extra of written || []) {
        if (!items.some((item) => item.ref === refOf(extra))) {
          review.unchecked.push({ section: sectionOf(null), sentence: String(extra[field]), problems: [`it is about ${refOf(extra)}, which the app did not pick`] });
        }
      }
      return items.map((item) => {
        const mine = (written || []).find((entry) => refOf(entry) === item.ref);
        const checked = mine ? checkText(mine[field], sectionOf(item), factsById, review, null, item.facts) : { text: '', cited: [] };
        const itemFacts = item.facts.map((id) => factsById.get(id));
        const fromFacts = checked.text === '';
        return {
          ...item,
          text: fromFacts ? itemFacts.map((fact) => `${fact.text} [${fact.when ? `${fact.id}: ${fact.when}` : fact.id}]`).join(' ') : checked.text,
          writtenBy: fromFacts ? 'app' : 'claude',
          citations: (fromFacts ? itemFacts : checked.cited).map((fact) => ({ fact: fact.id, when: fact.when })),
        };
      });
    };
    const summary = phrase(lists.summary, answer.summary, 'text', () => 'Summary');
    const wentWell = phrase(lists.wentWell, answer.wentWell, 'text', () => 'What went well');
    const toImprove = phrase(lists.toImprove, answer.toImprove, 'text', () => 'What to improve');
    const points = phrase(topics, answer.points, 'detail', (topic) => (topic ? `Point "${topic.title}"` : 'Point'))
      .map(({ text, ...point }) => ({ ...point, detail: text }));

    // The deaths the score picked, highest score first, each with the stretch
    // of video to watch and Claude's note on it (if the note passed the checks).
    const whoContext = who.contextFromLog(log, playerName);
    const reviewMoments = stats.reviewDeaths.map((ref) => {
      const death = stats.deaths.find((d) => d.ref === ref);
      const written = (answer.reviewNotes || []).find((note) => refOf(note) === ref);
      // death.videoSeconds is the same saved number its fact uses, so the review
      // list and the facts show the same video time.
      const clipStartSeconds = round1(Math.max(0, death.videoSeconds - REVIEW_BEFORE_SECONDS));
      const clipEndSeconds = round1(videoDurationSeconds === null
        ? death.videoSeconds + REVIEW_AFTER_SECONDS
        : Math.min(videoDurationSeconds, death.videoSeconds + REVIEW_AFTER_SECONDS));
      // Who killed whom, written by the app from the game log (see who.js).
      const whoParts = [{ type: 'events', eventIds: [death.eventId] }];
      return {
        ref,
        who: who.whoLine(whoParts, whoContext),
        whoParts,
        fact: death.factId,
        rank: death.reviewRank,
        score: death.score,
        scoreReasons: scoreReasons(death),
        rules: death.rules,
        gameTime: death.gameTime,
        videoTime: death.videoTime,
        gameSeconds: death.gameSeconds,
        videoSeconds: death.videoSeconds,
        clipStart: mmss(clipStartSeconds),
        clipEnd: mmss(clipEndSeconds),
        clipStartSeconds,
        clipEndSeconds,
        killedBy: death.killedBy,
        note: written ? check(written.note, `Review note ${ref}`, ref).text : '',
      };
    });
    for (const note of answer.reviewNotes || []) {
      if (!stats.reviewDeaths.includes(refOf(note))) {
        review.unchecked.push({ section: 'Review note', sentence: String(note.note), problems: [`it is about ${refOf(note)}, which the score did not pick`] });
      }
    }

    // ---- Save and show ----
    const usage = reply.usage || {};
    const report = {
      generatedAt: new Date().toISOString(),
      sessionFolder,
      videoFile: noVideo ? null : videoFile,
      noVideo, // true = there are no video times in this file, only game times
      mode,
      player: playerName,
      champion: stats.champion,
      result: sessionInfo.game && sessionInfo.game.result ? sessionInfo.game.result : null,
      model: MODEL,
      tokens: {
        input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        output: usage.output_tokens || 0,
      },
      costUsd: costOf(usage),
      sentToClaude: { facts: facts.length, excerpts: excerpts.length, excerptLines, logLines },
      excerpts: excerpts.map((excerpt) => ({ about: excerpt.about, fromGameTime: mmss(excerpt.fromGameSeconds), toGameTime: mmss(excerpt.toGameSeconds), lines: excerpt.lines.length })),
      summary,
      wentWell,
      toImprove,
      points,
      reviewMoments,
      scoreRules: SCORE_RULES,
      // How the two lists were picked, so report_export.js can say why a list is short.
      listRules: { maxItems: MAX_LIST_ITEMS, minWentWell: MIN_WENT_WELL_SCORE, minToImprove: MIN_TO_IMPROVE_SCORE },
      unchecked: review.unchecked,
      dropped: review.dropped,
      dataLimits: dataLimitsFor(mode, { endStats: Boolean(endNumbers), timeline: Boolean(endNumbers && endNumbers.timeline) }),
      endOfGame: endNumbers, // null if the League client's numbers weren't saved
      facts: facts.map((fact) => ({ id: fact.id, kind: fact.kind, when: fact.when, text: fact.text })),
      stats,
    };
    if (noVideo) removeVideoTimes(report); // the stand-in video times (see placeOnVideo in analyze.js) must not be saved

    say(`\n${renderMarkdown(report, false)}\n\n`);
    const noCitation = review.dropped.filter((item) => item.reason === 'it cites no fact').length;
    const aboutRecording = review.dropped.filter((item) => /talks about a recording/.test(item.reason)).length;
    say(`[Checks: ${plural(review.unchecked.length, 'unchecked claim')} moved out of the report, ` +
      `${plural(review.dropped.length, 'sentence')} dropped (${noCitation} without a citation, ${aboutRecording} about a recording that doesn't exist, ` +
      `${review.dropped.length - noCitation - aboutRecording} that widened a comparison's group).]\n`);
    say(`[Report tokens used: about ${report.tokens.input.toLocaleString('en-US')} in + ${report.tokens.output.toLocaleString('en-US')} out = ` +
      `${(report.tokens.input + report.tokens.output).toLocaleString('en-US')} in total (${MODEL}). Cost of this run: ${dollars(report.costUsd)}]\n`);

    // report.json keeps its name: the app reads it back. The .md copy is for you.
    const mdName = reportFileName(report.champion, 'md');
    for (const [name, content] of [['report.json', JSON.stringify(report, null, 2)], [mdName, renderMarkdown(report, true)]]) {
      const file = path.join(sessionFolder, name);
      try {
        fs.writeFileSync(file, content, 'utf8');
        say(`[Saved to: ${file}]\n`);
      } catch (err) {
        say(`[Couldn't save ${file}: ${err.message}]\n`);
      }
    }
    return report;
  } catch (err) {
    say(`[The performance report stopped because of an unexpected error: ${err.message}]\n`);
    return null;
  }
}

// The name of a report file the user opens, e.g. "Mel_report.pdf",
// "Miss_Fortune_report.docx" or "KaiSa_report.md". Characters Windows doesn't
// allow are taken out (see safeForFileName in who.js). With no champion, or
// "unknown", it is just "report.pdf" etc.
// (report.json, highlights.json, live_log.json and session.json never use
// this: the app reads them back under their fixed names.)
function reportFileName(champion, ext) {
  const name = champion && !/^unknown$/i.test(String(champion).trim()) ? who.safeForFileName(champion) : '';
  return `${name ? `${name}_` : ''}report.${ext}`;
}

// writeReport is what main.js uses; the others are exported so they can be
// tried out on their own.
module.exports = {
  writeReport, buildStats, buildFacts, chooseTopics, chooseLists, buildExcerpts, checkSentence, checkText,
  withoutRecordingAdvice, dataLimitsFor, renderMarkdown, reportFileName, highlightsWithOwnKill,
  standOutLine, endOfGame, NO_END_STATS, ARAM_MODES, presentedReport,
  LIST_RULES: { maxItems: MAX_LIST_ITEMS, minWentWell: MIN_WENT_WELL_SCORE, minToImprove: MIN_TO_IMPROVE_SCORE },
};
