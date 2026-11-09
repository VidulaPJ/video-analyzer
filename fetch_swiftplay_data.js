// fetch_swiftplay_data.js
//
// Fetches full match data AND the match timeline for the Swiftplay match
// ME1_20659395 (paired with the real recording swiftplay_clip.mp4) via
// Riot's Match-V5 API, routed through europe.api.riotgames.com.
//
// Saves the full match data to match_ME1_20659395.json. From the timeline,
// extracts only CHAMPION_KILL events that VDRJ was personally involved in
// (kill, death, or assist), prints each with its game-time timestamp
// converted to "MM:SS", and saves that filtered list to
// timeline_ME1_20659395.json.

const fs = require("fs");

// ---- Step 0: Configuration ----

process.loadEnvFile();

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}

// Match-V5 is routed through the same regional endpoint as account
// lookups — ME1 (Middle East) routes through "europe".
const REGIONAL_ROUTE = "europe";
const MATCH_ID = "ME1_20659395";

// All of this match's output files live together under matches/<matchId>/,
// separate from raw video recordings (which stay in the project root).
const MATCH_DIR = `matches/${MATCH_ID}`;
const MATCH_FILE = `${MATCH_DIR}/match_${MATCH_ID}.json`;
const TIMELINE_FILE = `${MATCH_DIR}/timeline_${MATCH_ID}.json`;

// The Riot ID whose events we want to filter down to.
const TARGET_NAME = "VDRJ#0405";

// ---- Step 1: Fetch the full match data ----
async function getMatch(matchId) {
  const url = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get match ${matchId}: ${response.status} ${response.statusText} — ${body}`);
  }
  return response.json();
}

// ---- Step 2: Fetch the full timeline ----
async function getTimeline(matchId) {
  const url = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get timeline for ${matchId}: ${response.status} ${response.statusText} — ${body}`);
  }
  return response.json();
}

// ---- Step 3: Build participantId <-> "Name#Tag" lookup tables ----
// The timeline only refers to players by participantId, so we build the
// mapping from the match data we just fetched instead of fetching it twice.
function buildParticipantNameMaps(match) {
  const idToName = {};
  let targetParticipantId = null;

  for (const p of match.info.participants) {
    const name =
      p.riotIdGameName && p.riotIdTagline
        ? `${p.riotIdGameName}#${p.riotIdTagline}`
        : p.summonerName || "Unknown";
    idToName[p.participantId] = name;
    if (name === TARGET_NAME) {
      targetParticipantId = p.participantId;
    }
  }

  return { idToName, targetParticipantId };
}

// ---- Step 4: Helper to format milliseconds as "MM:SS" ----
function formatGameTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// A killerId of 0 means the kill wasn't credited to a player (e.g. a turret) —
// the timeline data can contain this, so we handle it instead of printing
// "undefined".
function nameFor(participantId, idToName) {
  if (!participantId) return "(none)";
  return idToName[participantId] || `Unknown (participantId ${participantId})`;
}

// ---- Step 5: Tie it all together ----
async function main() {
  fs.mkdirSync(MATCH_DIR, { recursive: true });

  console.log(`Fetching match data for ${MATCH_ID}...`);
  const match = await getMatch(MATCH_ID);
  fs.writeFileSync(MATCH_FILE, JSON.stringify(match, null, 2));
  console.log(`Saved ${MATCH_FILE}`);

  const { idToName, targetParticipantId } = buildParticipantNameMaps(match);
  if (!targetParticipantId) {
    throw new Error(`Could not find ${TARGET_NAME} among the participants in ${MATCH_ID}`);
  }

  console.log(`\nFetching timeline for ${MATCH_ID}...`);
  const timeline = await getTimeline(MATCH_ID);

  // The timeline is broken into "frames" (roughly one per minute), each
  // containing a list of "events" that happened during that frame. We flatten
  // all frames' events together, then keep only CHAMPION_KILL events that
  // VDRJ was personally involved in as killer, victim, or assister.
  const relevantEvents = [];
  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (event.type !== "CHAMPION_KILL") continue;

      const assistIds = event.assistingParticipantIds || [];
      const isKiller = event.killerId === targetParticipantId;
      const isVictim = event.victimId === targetParticipantId;
      const isAssister = assistIds.includes(targetParticipantId);

      if (isKiller || isVictim || isAssister) {
        relevantEvents.push({ event, isKiller, isVictim, isAssister });
      }
    }
  }

  // Build a clean, readable record for each relevant event.
  const processedEvents = relevantEvents.map(({ event, isKiller, isVictim, isAssister }) => {
    const killerName = nameFor(event.killerId, idToName);
    const victimName = nameFor(event.victimId, idToName);

    let eventType;
    let description;
    if (isKiller) {
      eventType = "kill";
      description = `${TARGET_NAME} killed ${victimName}`;
    } else if (isVictim) {
      eventType = "death";
      description = `${killerName} killed ${TARGET_NAME}`;
    } else {
      eventType = "assist";
      description = `${TARGET_NAME} assisted ${killerName} in killing ${victimName}`;
    }

    return {
      timestampMs: event.timestamp,
      gameTime: formatGameTime(event.timestamp),
      eventType,
      description,
      killerName,
      victimName,
    };
  });

  // ---- Step 6: Print each event ----
  console.log(`\nFound ${processedEvents.length} events involving ${TARGET_NAME}:\n`);
  for (const e of processedEvents) {
    console.log(`[${e.gameTime}] (${e.eventType}) ${e.description}`);
  }

  // ---- Step 7: Save the filtered list to disk ----
  fs.writeFileSync(TIMELINE_FILE, JSON.stringify(processedEvents, null, 2));
  console.log(`\nSaved ${processedEvents.length} events to ${TIMELINE_FILE}`);

  const counts = processedEvents.reduce((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `Breakdown: ${counts.kill || 0} kills, ${counts.death || 0} deaths, ${counts.assist || 0} assists.`
  );
}

main().catch((error) => {
  console.error("\nSomething went wrong:");
  console.error(error.message);
  process.exit(1);
});
