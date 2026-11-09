// fetch_match_details.js
//
// This script fetches full match details for a single League of Legends
// match ID using Riot's Match-V5 API, and prints each player's key stats.

// ---- Step 0: Configuration ----

// Load key/value pairs from the .env file in this folder into process.env.
process.loadEnvFile();

// Your Riot API key, read from the RIOT_API_KEY entry in .env instead of
// being hardcoded here. Development API keys from the Riot Developer
// Portal expire after 24 hours, so update .env with a fresh one as needed.
const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}

// Match-V5 is routed through the same regional endpoint as account
// lookups — ME1 (Middle East) routes through "europe".
const REGIONAL_ROUTE = "europe";

// The match we're investigating: the ARAM game on May 11, 2026.
const MATCH_ID = "ME1_18498319";

// ---- Step 1: Fetch the full match data for a given match ID ----
async function getMatch(matchId) {
  const url =
    `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/` +
    `${matchId}?api_key=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to get match ${matchId}: ${response.status} ${response.statusText}`
    );
  }

  // This returns one big JSON object with "metadata" (match id, participant
  // PUUIDs) and "info" (everything about the game: teams, participants, etc).
  return response.json();
}

// ---- Step 2: Pull out the stats we care about for each player ----
function summarizeParticipant(participant) {
  return {
    // Riot ID (name#tag) is the modern replacement for the old, now-mostly-
    // blank "summonerName" field, so we build a display name from it,
    // falling back to summonerName just in case.
    name:
      participant.riotIdGameName && participant.riotIdTagline
        ? `${participant.riotIdGameName}#${participant.riotIdTagline}`
        : participant.summonerName || "Unknown",
    champion: participant.championName,
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    gold: participant.goldEarned,
    damageToChampions: participant.totalDamageDealtToChampions,
  };
}

// ---- Step 3: Tie it all together ----
async function main() {
  try {
    console.log(`Fetching match details for ${MATCH_ID}...\n`);
    const match = await getMatch(MATCH_ID);

    // Every player in the match is listed here, regardless of team.
    const participants = match.info.participants;

    console.log(`Game mode: ${match.info.gameMode} | Duration: ${match.info.gameDuration}s\n`);
    console.log("Player stats:");
    console.log(
      "Name".padEnd(20) +
        "Champion".padEnd(14) +
        "K/D/A".padEnd(10) +
        "Gold".padEnd(8) +
        "Dmg to Champs"
    );

    participants.forEach((participant) => {
      const stats = summarizeParticipant(participant);
      const kda = `${stats.kills}/${stats.deaths}/${stats.assists}`;
      console.log(
        stats.name.padEnd(20) +
          stats.champion.padEnd(14) +
          kda.padEnd(10) +
          String(stats.gold).padEnd(8) +
          String(stats.damageToChampions)
      );
    });
  } catch (error) {
    // Print any errors in a readable way instead of a raw crash.
    console.error("\nSomething went wrong:");
    console.error(error.message);
  }
}

// Run the script.
main();
