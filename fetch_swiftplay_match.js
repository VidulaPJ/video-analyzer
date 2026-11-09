// fetch_swiftplay_match.js
//
// One-off helper: fetch both the full match summary and the full match
// timeline for the Swiftplay match ME1_20659395 (paired with the real
// recording swiftplay_clip.mp4, confirmed offset: video-time + 12s =
// game-time), and save them to disk for the next steps (highlight-finding,
// clip export) to read.

process.loadEnvFile();

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}

// Match-V5 is routed through the same regional endpoint as account
// lookups — ME1 (Middle East) routes through "europe".
const REGIONAL_ROUTE = "europe";
const MATCH_ID = "ME1_20659395";

const fs = require("fs");

async function getJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText} — ${body}`);
  }
  return response.json();
}

async function main() {
  console.log(`Fetching match summary for ${MATCH_ID}...`);
  const matchUrl = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${MATCH_ID}?api_key=${API_KEY}`;
  const match = await getJson(matchUrl, "match summary");
  const matchFile = `match_${MATCH_ID}.json`;
  fs.writeFileSync(matchFile, JSON.stringify(match, null, 2));
  console.log(`Saved ${matchFile}`);

  console.log(`\nGame mode: ${match.info.gameMode} | Queue: ${match.info.queueId} | Duration: ${match.info.gameDuration}s`);
  console.log("Participants:");
  for (const p of match.info.participants) {
    const name = p.riotIdGameName && p.riotIdTagline
      ? `${p.riotIdGameName}#${p.riotIdTagline}`
      : p.summonerName || "Unknown";
    console.log(`  ${p.participantId}. ${name} — ${p.championName}`);
  }

  console.log(`\nFetching full timeline for ${MATCH_ID}...`);
  const timelineUrl = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${MATCH_ID}/timeline?api_key=${API_KEY}`;
  const timeline = await getJson(timelineUrl, "timeline");
  const timelineFile = `timeline_${MATCH_ID}.json`;
  fs.writeFileSync(timelineFile, JSON.stringify(timeline, null, 2));
  console.log(`Saved ${timelineFile}`);

  const frameCount = timeline.info.frames.length;
  const eventCount = timeline.info.frames.reduce((sum, f) => sum + f.events.length, 0);
  console.log(`\nTimeline has ${frameCount} frames and ${eventCount} total events.`);
}

main().catch((error) => {
  console.error("\nSomething went wrong:");
  console.error(error.message);
  process.exit(1);
});
