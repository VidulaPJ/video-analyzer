// fetch_timeline.js
//
// This script fetches the full match TIMELINE for one League of Legends
// match (a frame-by-frame event log — different from the match summary
// data we fetched before), and pulls out only the CHAMPION_KILL events
// that VDRJ#0405 was personally involved in: getting a kill, getting
// killed, or getting an assist.

const fs = require("fs");

// ---- Step 0: Configuration ----

process.loadEnvFile();

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}

const REGIONAL_ROUTE = "europe";
const MATCH_ID = "ME1_18498319";

// We already fetched (and saved) the match SUMMARY data earlier — it
// contains each player's participantId (1-10) alongside their Riot ID
// (name#tag). The timeline only refers to players by participantId, so we
// reuse this file to translate those numbers back into names, instead of
// fetching participant info a second time.
const MATCH_SUMMARY_FILE = "match_ME1_18498319.json";

// The Riot ID whose events we want to filter down to.
const TARGET_NAME = "VDRJ#0405";

// ---- Step 1: Build participantId <-> "Name#Tag" lookup tables ----
function buildParticipantNameMaps(summaryFilePath) {
  const raw = fs.readFileSync(summaryFilePath, "utf-8");
  const summary = JSON.parse(raw);

  const idToName = {};
  let targetParticipantId = null;

  for (const p of summary.info.participants) {
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

// ---- Step 2: Fetch the timeline from Riot's API ----
async function getTimeline(matchId) {
  const url = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline?api_key=${API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to get timeline: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ---- Step 3: Helper to format milliseconds as "MM:SS" ----
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

// ---- Step 4: Tie it all together ----
async function main() {
  const { idToName, targetParticipantId } = buildParticipantNameMaps(MATCH_SUMMARY_FILE);

  if (!targetParticipantId) {
    throw new Error(`Could not find ${TARGET_NAME} in ${MATCH_SUMMARY_FILE}`);
  }

  console.log(`Fetching timeline for ${MATCH_ID}...\n`);
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

  // ---- Step 5: Print each event ----
  console.log(`Found ${processedEvents.length} events involving ${TARGET_NAME}:\n`);
  for (const e of processedEvents) {
    console.log(`[${e.gameTime}] (${e.eventType}) ${e.description}`);
  }

  // ---- Step 6: Save the filtered list to disk ----
  fs.writeFileSync("timeline_events.json", JSON.stringify(processedEvents, null, 2));
  console.log(`\nSaved ${processedEvents.length} events to timeline_events.json`);

  const counts = processedEvents.reduce((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `Breakdown: ${counts.kill || 0} kills, ${counts.death || 0} deaths, ${counts.assist || 0} assists.`
  );
}

main().catch((error) => {
  console.error("Something went wrong:");
  console.error(error.message);
});
