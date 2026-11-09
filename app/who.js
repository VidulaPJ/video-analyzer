// =============================================================================
// who.js -- the "who" line of a highlight or a review moment, e.g.
//   Mel (VDRJ) killed Heimerdinger, assisted by Pantheon and Janna
//   Miss Fortune (VDRJ) double kill: Morgana, then Corki
//   02:15 Mel (VDRJ) killed Heimerdinger, then 02:17 was killed by Heimerdinger
//
// Every word of it comes from the game log (live_log.json): the events say who
// did what to whom, and the player snapshots say which champion each name
// plays. Nothing Claude wrote is used.
//
// analyze.js and report.js save, with each moment, WHICH events it is made of
// ("whoParts": the game's own event numbers) next to the line itself ("who").
// export.js reads those numbers back, so that it can join two moments whose
// clips overlap into one line and one file name.
//
// This file uses nothing from the other files of the app, so any of them can
// use it.
// =============================================================================

// Kills by the same killer with no more than this long between them are told
// as one run ("double kill: A, then B"). The same figure as in analyze.js.
const RUN_GAP_SECONDS = 10;
// What the game calls a run of 2, 3, 4 and 5 kills.
const MULTIKILL_NAMES = { 2: 'double kill', 3: 'triple kill', 4: 'quadra kill', 5: 'penta kill' };
// The longest the descriptive part of a file name may be, in characters.
const MAX_SLUG_LENGTH = 80;

// Turn seconds (e.g. 135.5) into a clock like "02:15".
function clock(totalSeconds) {
  const whole = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

// "A", "A and B", "A, B and C".
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// What is needed to write "who" lines for one match:
//   players    -> everyone in the match, from the newest player snapshot (who
//                 plays which champion doesn't change during a match)
//   events     -> every event in the log
//   playerName -> your in-game name, without the #tag
function contextFromLog(log, playerName) {
  const snapshots = Array.isArray(log && log.snapshots) ? log.snapshots : [];
  let players = [];
  for (const snapshot of snapshots) {
    if (Array.isArray(snapshot.players) && snapshot.players.length > 0) players = snapshot.players;
  }
  return { players, events: Array.isArray(log && log.events) ? log.events : [], playerName: String(playerName || '') };
}

// How to show a name that an event uses ("VDRJ", "Heimerdinger Bot").
//   full  -> for the line:      "Mel (VDRJ)", "Heimerdinger"
//   short -> for the file name: "Mel", "Heimerdinger"
// The champion comes first; the player's name follows in brackets only if it
// says something the champion doesn't: not when it is the champion's own name
// (ARAM Mayhem shows the other players that way) or "<Champion> Bot", ignoring
// capitals. A name that is not a player in the snapshots (a turret, a minion),
// or that belongs to players with different champions, is shown exactly as
// the event has it: nothing is guessed.
function showName(rawName, players) {
  const name = String(rawName ?? 'unknown');
  const plain = name.split('#')[0];
  const champions = new Set(players
    .filter((player) => [player.summonerName, player.riotIdGameName, player.riotId]
      .some((value) => typeof value === 'string' && (value === name || value.split('#')[0] === plain)))
    .map((player) => player.championName)
    .filter(Boolean));
  if (champions.size !== 1) return { full: name, short: name };
  const champion = [...champions][0];
  const sameAsChampion = [champion, `${champion} Bot`].some((same) => same.toLowerCase() === plain.toLowerCase());
  return { full: sameAsChampion ? champion : `${champion} (${plain})`, short: champion };
}

function isPlayer(rawName, playerName) {
  return typeof rawName === 'string' && playerName !== '' && rawName.toLowerCase().split('#')[0] === playerName.toLowerCase();
}

// An event that is not a champion kill (a turret, a dragon, an inhibitor...):
// the logger's own line for it, with each name in it shown the champion-first
// way. `style` is 'full' or 'short'.
function objectiveText(logEvent, players, style) {
  const raw = logEvent.event || {};
  const names = [raw.KillerName, raw.Recipient, raw.VictimName, ...(Array.isArray(raw.Assisters) ? raw.Assisters : [])]
    .filter((name) => typeof name === 'string' && name !== '')
    .sort((a, b) => b.length - a.length); // the longest first, so "Zaahen Bot" is not read as "Zaahen"
  const text = String(logEvent.description || raw.EventName || 'event');
  if (names.length === 0) return text;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // a name only counts where it is not in the middle of a longer word
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  return text.replace(pattern, (found) => showName(found, players)[style]);
}

// Turn a list of log events into "steps": the pieces a line is made of. Each
// step is { gameTime, subject, text, slugSubject, slugText }, where subject
// is who the step is about ("Mel (VDRJ)") and text is what happened ("killed
// Heimerdinger"). The slug parts are the same thing for a file name.
function stepsFromEvents(events, context) {
  const { players, playerName } = context;
  const ordered = [...events].sort((a, b) => a.gameTime - b.gameTime || (a.event.EventID ?? 0) - (b.event.EventID ?? 0));
  const steps = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const logEvent = ordered[i];
    const raw = logEvent.event || {};
    if (raw.EventName !== 'ChampionKill') {
      steps.push({ gameTime: logEvent.gameTime, subject: null, text: objectiveText(logEvent, players, 'full'),
        slugSubject: null, slugText: objectiveText(logEvent, players, 'short') });
      continue;
    }

    // A run: the kills that follow by the same killer, each soon after the last.
    const run = [logEvent];
    while (i + 1 < ordered.length && (ordered[i + 1].event || {}).EventName === 'ChampionKill'
      && ordered[i + 1].event.KillerName === raw.KillerName
      && ordered[i + 1].gameTime - run[run.length - 1].gameTime <= RUN_GAP_SECONDS) {
      i += 1;
      run.push(ordered[i]);
    }
    const killer = showName(raw.KillerName, players);
    if (run.length > 1) {
      // It is only called a "double kill" (and so on) if the game announced
      // one of that size for this killer at the last kill of the run.
      const lastKill = run[run.length - 1];
      const announced = context.events.some((other) => other.event && other.event.EventName === 'Multikill'
        && other.event.KillerName === raw.KillerName && other.event.KillStreak === run.length
        && Math.abs(other.gameTime - lastKill.gameTime) <= 1);
      const what = announced && MULTIKILL_NAMES[run.length] ? MULTIKILL_NAMES[run.length] : `${run.length} kills`;
      const victims = run.map((kill) => showName(kill.event.VictimName, players));
      steps.push({ gameTime: logEvent.gameTime, subject: killer.full, text: `${what}: ${victims.map((v) => v.full).join(', then ')}`,
        slugSubject: killer.short, slugText: `${what} ${victims.map((v) => v.short).join(' ')}` });
      continue;
    }

    const victim = showName(raw.VictimName, players);
    const assisters = (Array.isArray(raw.Assisters) ? raw.Assisters : []).map((name) => showName(name, players).full);
    const assisted = assisters.length > 0 ? `, assisted by ${joinNames(assisters)}` : '';
    if (isPlayer(raw.VictimName, playerName)) {
      // the player's own death is told from the player's side
      steps.push({ gameTime: logEvent.gameTime, subject: victim.full, text: `was killed by ${killer.full}${assisted}`,
        slugSubject: victim.short, slugText: `killed by ${killer.short}` });
    } else {
      steps.push({ gameTime: logEvent.gameTime, subject: killer.full, text: `killed ${victim.full}${assisted}`,
        slugSubject: killer.short, slugText: `kills ${victim.short}` });
    }
  }
  return steps;
}

// The steps of one or more moments. `parts` is what is saved as "whoParts":
//   { type: 'events', eventIds: [...] }    -> those events, as they happened
//   { type: 'survival', eventIds: [...] }  -> teammates were killed (those
//                                             events) and the player lived
// Returns null if an event number is not in the log (the files don't belong
// together), so that nothing wrong is shown.
function stepsFromParts(parts, context) {
  const byId = new Map(context.events.filter((e) => e.event && e.event.EventID !== undefined).map((e) => [e.event.EventID, e]));
  const plain = new Map(); // events of every 'events' part, each only once
  const steps = [];
  for (const part of parts || []) {
    const found = (part.eventIds || []).map((id) => byId.get(id));
    if (found.length === 0 || found.some((e) => !e)) return null;
    if (part.type === 'survival') {
      const me = showName(context.playerName, context.players);
      const killed = found.map((e) => showName(e.event.VictimName, context.players).full);
      steps.push({ gameTime: found[0].gameTime, subject: me.full, text: `stayed alive while ${joinNames(killed)} ${killed.length === 1 ? 'was' : 'were'} killed`,
        slugSubject: me.short, slugText: 'survives' });
    } else {
      for (const e of found) plain.set(e.event.EventID, e);
    }
  }
  steps.push(...stepsFromEvents([...plain.values()], context));
  return steps.sort((a, b) => a.gameTime - b.gameTime);
}

// The line. One step: "Mel (VDRJ) killed Heimerdinger". Several: each with
// its game time, and the subject only where it changes:
//   "02:15 Mel (VDRJ) killed Heimerdinger, then 02:17 was killed by Heimerdinger"
function lineFromSteps(steps) {
  if (steps.length === 0) return '';
  const withSubject = (step, previous) => (step.subject && !(previous && previous.subject === step.subject) ? `${step.subject} ` : '') + step.text;
  if (steps.length === 1) return withSubject(steps[0], null);
  let line = '';
  steps.forEach((step, i) => {
    const previous = steps[i - 1];
    // a step that already has a comma in it is closed with a semicolon, to keep the line readable
    if (previous) line += previous.text.includes(',') ? '; then ' : ', then ';
    line += `${clock(step.gameTime)} ${withSubject(step, previous)}`;
  });
  return line;
}

// Make text safe to use inside a Windows file name: only letters, digits, -
// and _ are kept (so none of < > : " / \ | ? * can be in it, nor an
// apostrophe or a full stop), and spaces become _.
function safeForFileName(text) {
  return String(text).normalize('NFC').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/[\s_]+/g, '_');
}

// The descriptive part of a file name, e.g. "Mel_kills_Heimerdinger" or
// "Mel_kills_Heimerdinger_then_killed_by_Heimerdinger". Never longer than
// MAX_SLUG_LENGTH characters.
function slugFromSteps(steps) {
  const pieces = steps.map((step, i) => {
    const previous = steps[i - 1];
    const subject = step.slugSubject && !(previous && previous.slugSubject === step.slugSubject) ? `${step.slugSubject} ` : '';
    return safeForFileName(subject + step.slugText);
  }).filter(Boolean);
  return pieces.join('_then_').slice(0, MAX_SLUG_LENGTH).replace(/_+$/, '');
}

// The "who" line of one moment (or of several joined), or '' if it can't be
// worked out from the log.
function whoLine(parts, context) {
  const steps = stepsFromParts(parts, context);
  return steps ? lineFromSteps(steps) : '';
}

// ---- Files from before "whoParts" was saved ---------------------------------
// Highlights and review moments made by an older version of the app don't say
// which events they are made of. These two find the events again in the log
// by what the old file does say; they return null if that doesn't work out.

// An old highlight has the logger's line of each of its events, e.g.
// "E65: VDRJ killed Morgana Bot", and the game time of the first one.
function partsOfOldHighlight(highlight, context) {
  const lines = Array.isArray(highlight.timelineLines) ? highlight.timelineLines : [];
  if (lines.length === 0 || typeof highlight.gameSeconds !== 'number') return null;
  if (lines.some((line) => /^S\d+:/.test(line))) return null; // a survival moment: the old file doesn't say who was killed
  const eventIds = [];
  let after = highlight.gameSeconds - 0.1; // the saved time is rounded to a tenth of a second
  for (const line of lines) {
    const text = String(line).replace(/^E\d+:\s*/, '');
    const found = context.events.find((e) => e.gameTime >= after && e.description === text
      && e.event && e.event.EventID !== undefined && !eventIds.includes(e.event.EventID));
    if (!found) return null;
    if (eventIds.length === 0 && found.gameTime - highlight.gameSeconds > 0.1) return null; // the first one must be AT the saved time
    eventIds.push(found.event.EventID);
    after = found.gameTime;
  }
  return [{ type: 'events', eventIds }];
}

// An old review moment has the game time of the death and who the killer was.
function partsOfOldReview(moment, context) {
  if (typeof moment.gameSeconds !== 'number') return null;
  const found = context.events.find((e) => e.event && e.event.EventName === 'ChampionKill' && e.event.EventID !== undefined
    && isPlayer(e.event.VictimName, context.playerName) && e.event.KillerName === moment.killedBy
    && Math.abs(e.gameTime - moment.gameSeconds) <= 0.1);
  return found ? [{ type: 'events', eventIds: [found.event.EventID] }] : null;
}

module.exports = {
  contextFromLog, stepsFromParts, lineFromSteps, slugFromSteps, whoLine, safeForFileName,
  partsOfOldHighlight, partsOfOldReview,
};
