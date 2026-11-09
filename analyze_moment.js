// analyze_moment.js
//
// This script sends the full match data for one League of Legends game to
// Claude and asks for feedback on your (VDRJ#0405's) performance: what you
// did well, and what you could improve, based on the raw stats.

const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");

// ---- Step 0: Configuration ----

// Load key/value pairs from the .env file in this folder into process.env.
process.loadEnvFile();

// Which player we're analyzing feedback for (your Riot ID).
const MY_GAME_NAME = "VDRJ";
const MY_TAG_LINE = "0405";

// The match data file to load. This is the full raw response from
// Match-V5's by-matchId endpoint (metadata + info.participants etc.).
const MATCH_DATA_FILE = "match_ME1_18498319.json";

// The Anthropic SDK reads your API key automatically from the
// ANTHROPIC_API_KEY environment variable (now populated from .env above) —
// no need to hardcode it here.
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set — add it to your .env file.");
}
const client = new Anthropic();

// ---- Step 1: Load and summarize the match data ----
function loadMatchSummary(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = JSON.parse(raw);
  const info = match.info;

  // Pull out just the stats we care about for every player, so we send
  // Claude a compact, readable table instead of the entire raw JSON blob
  // (which also contains a lot of irrelevant fields).
  const participants = info.participants.map((p) => ({
    name:
      p.riotIdGameName && p.riotIdTagline
        ? `${p.riotIdGameName}#${p.riotIdTagline}`
        : p.summonerName || "Unknown",
    champion: p.championName,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    gold: p.goldEarned,
    damageToChampions: p.totalDamageDealtToChampions,
    damageTaken: p.totalDamageTaken,
    healingDone: p.totalHealsOnTeammates,
    win: p.win,
  }));

  return {
    gameDurationSeconds: info.gameDuration,
    participants,
  };
}

// ---- Step 2: Build the prompt and call Claude ----
async function analyzeMoment() {
  const summary = loadMatchSummary(MATCH_DATA_FILE);
  const myTarget = `${MY_GAME_NAME}#${MY_TAG_LINE}`;
  const me = summary.participants.find((p) => p.name === myTarget);

  if (!me) {
    throw new Error(`Could not find ${myTarget} in ${MATCH_DATA_FILE}`);
  }

  // Format the full participant list as a simple table for the prompt.
  const table = summary.participants
    .map(
      (p) =>
        `${p.name === myTarget ? "-> " : "   "}${p.name} | ${p.champion} | ` +
        `${p.kills}/${p.deaths}/${p.assists} | gold: ${p.gold} | ` +
        `dmg to champs: ${p.damageToChampions} | dmg taken: ${p.damageTaken} | ` +
        `healing: ${p.healingDone} | ${p.win ? "WIN" : "LOSS"}`
    )
    .join("\n");

  const durationMin = Math.floor(summary.gameDurationSeconds / 60);
  const durationSec = summary.gameDurationSeconds % 60;

  const prompt = `This is match data from an ARAM Mayhem match (League of Legends' ARAM game mode featuring extra chaos/power-ups) that lasted ${durationMin}m ${durationSec}s.

Here are all 10 players' final stats (the "->" marks the player we want feedback on, ${myTarget}, playing ${me.champion}):

${table}

Based on these stats, give feedback specifically on ${myTarget}'s performance (${me.champion}, ${me.kills}/${me.deaths}/${me.assists}):
1. What did they do well?
2. What could they improve?

Keep it concise and grounded strictly in the stats shown above.`;

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: prompt }],
  });

  // Print just the text portion of the response (thinking blocks are
  // omitted by default and not useful to print here).
  for (const block of response.content) {
    if (block.type === "text") {
      console.log(block.text);
    }
  }
}

analyzeMoment().catch((error) => {
  console.error("Something went wrong:");
  console.error(error.message);
});
