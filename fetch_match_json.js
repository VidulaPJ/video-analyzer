// One-off helper: fetch the full raw match JSON for ME1_18498319 from Riot's
// Match-V5 API and save it to disk, so analyze_moment.js has a local file to read.
process.loadEnvFile();

const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}
const REGIONAL_ROUTE = "europe";
const MATCH_ID = "ME1_18498319";

const url = `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/${MATCH_ID}?api_key=${API_KEY}`;

const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Failed to fetch match: ${response.status} ${response.statusText}`);
}
const data = await response.json();

const fs = await import("fs");
fs.writeFileSync(`match_${MATCH_ID}.json`, JSON.stringify(data, null, 2));
console.log(`Saved match_${MATCH_ID}.json`);
