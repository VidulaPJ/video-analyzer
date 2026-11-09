// find_matches.js
//
// This script talks to the Riot Games API to find your most recent
// League of Legends match IDs.
//
// It works in two steps, because Riot's API doesn't let you look up
// matches directly by Riot ID (name#tag) — you first have to convert
// your Riot ID into a "PUUID" (a unique player ID), and then use that
// PUUID to ask for match history.

// ---- Step 0: Configuration ----
// These are the values that are specific to you / your account.

// Load key/value pairs from the .env file in this folder into process.env,
// so we never have to hardcode secrets directly in the script.
process.loadEnvFile();

// Your Riot API key, read from the RIOT_API_KEY entry in .env. Treat it
// like a password — that's why it lives in .env (gitignored) instead of
// here in the script. Development API keys from the Riot Developer Portal
// expire after 24 hours, so you'll need to update .env with a fresh one
// periodically.
const API_KEY = process.env.RIOT_API_KEY;
if (!API_KEY) {
  throw new Error("RIOT_API_KEY is not set — add it to your .env file.");
}

// Your Riot ID is split into two parts: the name before the "#" and
// the tag after it.
const GAME_NAME = "VDRJ";
const TAG_LINE = "0405";

// Riot's API is split across "regional" routing values (used for
// account and match data) and "platform" routing values (used for
// things like summoner data on a specific server).
// You play on ME1 (Middle East), and ME1 routes through the "europe"
// regional endpoint for account/match lookups.
const REGIONAL_ROUTE = "europe";

// How many recent match IDs to fetch.
const MATCH_COUNT = 50;

// UAE (ME1 server) is UTC+4 year-round — no daylight saving to worry about.
const UAE_UTC_OFFSET_HOURS = 4;

// Build a UTC epoch-seconds timestamp for a specific UAE local date/time.
// Example: uaeDateToEpochSeconds(2026, 9, 15, 0, 0, 0) = start of Sept 15
// in UAE time, expressed as the equivalent UTC timestamp.
function uaeDateToEpochSeconds(year, month, day, hour, minute, second) {
  // Date.UTC's month param is 0-indexed, so subtract 1 from the human month.
  const utcMs = Date.UTC(year, month - 1, day, hour - UAE_UTC_OFFSET_HOURS, minute, second);
  return Math.floor(utcMs / 1000);
}

// The day we're specifically investigating: Sept 15, 2026, UAE time.
const TARGET_DATE_START = uaeDateToEpochSeconds(2026, 9, 15, 0, 0, 0);
const TARGET_DATE_END = uaeDateToEpochSeconds(2026, 9, 15, 23, 59, 59);

// ---- Step 1: Look up your PUUID from your Riot ID ----
async function getPUUID(gameName, tagLine) {
  // This endpoint converts a Riot ID (name#tag) into a PUUID.
  const url =
    `https://${REGIONAL_ROUTE}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}` +
    `?api_key=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    // If Riot's API returns an error (e.g. wrong name/tag, bad key),
    // throw an error so we can see what went wrong.
    throw new Error(
      `Failed to get PUUID: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  // The response includes gameName, tagLine, and puuid — we only need puuid.
  return data.puuid;
}

// ---- Step 1b: Verify a PUUID actually belongs to the Riot ID we expect ----
// This is the reverse of getPUUID: given a PUUID, ask Riot what Riot ID
// (gameName#tagLine) it's currently attached to. We use this as a sanity
// check so we're never silently querying match history for the wrong
// account (e.g. from a stale/cached value).
async function verifyPUUID(puuid, expectedGameName, expectedTagLine) {
  const url =
    `https://${REGIONAL_ROUTE}.api.riotgames.com/riot/account/v1/accounts/by-puuid/` +
    `${puuid}?api_key=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to verify PUUID: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  const matches =
    data.gameName === expectedGameName && data.tagLine === expectedTagLine;

  console.log(
    `Reverse lookup for this PUUID reports Riot ID: ${data.gameName}#${data.tagLine} ` +
      `(expected ${expectedGameName}#${expectedTagLine}) — ${matches ? "MATCH" : "MISMATCH!"}`
  );

  return matches;
}

// ---- Step 2: Use the PUUID to get recent match IDs ----
// startTime/endTime are OPTIONAL Unix timestamps in seconds. When provided,
// Riot only returns matches whose game start falls in that window. When
// omitted, no date filter is applied at all — you get the most recent
// matches overall, full stop.
async function getRecentMatchIds(puuid, count, startTime, endTime) {
  // This endpoint returns a list of match ID strings for the given player,
  // most recent first. "start=0" means "start from the very latest match"
  // (this is a pagination offset, NOT a time filter).
  const params = new URLSearchParams({ start: "0", count: String(count) });
  if (startTime !== undefined) params.set("startTime", String(startTime));
  if (endTime !== undefined) params.set("endTime", String(endTime));
  params.set("api_key", API_KEY);

  const url =
    `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/by-puuid/` +
    `${puuid}/ids?${params.toString()}`;

  // Log the exact request being made, with the API key redacted, so it's
  // obvious no unintended filters are being applied.
  console.log(`  GET ${url.replace(API_KEY, "REDACTED")}`);

  const response = await fetch(url);

  // Read the raw body as text FIRST, before trying to parse it as JSON.
  // This matters because a non-200 response (e.g. 401, 403, 429) often
  // comes back as an error object like {"status":{"status_code":429,...}},
  // not a match ID array — if we only ever looked at the parsed length of
  // a successful array, an error response would either throw separately
  // or, worse, get silently misread. Printing the raw status + body makes
  // it impossible to confuse "genuinely zero matches" with "hidden error".
  const rawBody = await response.text();
  console.log(`  Status: ${response.status} ${response.statusText}`);
  console.log(`  Raw response body: ${rawBody}`);

  if (!response.ok) {
    throw new Error(
      `Failed to get match IDs: ${response.status} ${response.statusText} — ${rawBody}`
    );
  }

  // This endpoint returns a plain JSON array of match ID strings, e.g.:
  // ["EUW1_1234567890", "EUW1_1234567889", ...]
  const matchIds = JSON.parse(rawBody);
  return matchIds;
}

// ---- Step 3: Look up details (mode, queue, duration) for one match ----
async function getMatchDetails(matchId) {
  // This endpoint returns the full match data for a single match ID.
  // We only need a few fields out of it, but Riot sends back everything
  // (participants, teams, etc.) in one big JSON object.
  const url =
    `https://${REGIONAL_ROUTE}.api.riotgames.com/lol/match/v5/matches/` +
    `${matchId}?api_key=${API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to get details for ${matchId}: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  const info = data.info;

  return {
    // e.g. "ARAM", "CLASSIC", "URF" — this is usually the clearest way
    // to spot your ARAM Mayhem game.
    gameMode: info.gameMode,
    // Numeric queue ID (e.g. 450 = ARAM). Riot doesn't include a
    // human-readable name in this response, so we print the raw number —
    // you can cross-reference it against Riot's queue list if needed:
    // https://static.developer.riotgames.com/docs/lol/queues.json
    queueId: info.queueId,
    // Duration is given in seconds; convert to minutes:seconds for readability.
    durationSeconds: info.gameDuration,
    // gameCreation is a Unix timestamp in milliseconds (when the game
    // was created/started). We keep the raw number too, in case you
    // want exact millisecond precision for cross-referencing clips.
    gameCreationMs: info.gameCreation,
  };
}

// Small helper to format seconds as "MM:SS".
function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Small helper to turn a millisecond timestamp into a readable local date/time.
function formatDate(epochMs) {
  return new Date(epochMs).toLocaleString();
}

// Shared helper: fetch details for a list of match IDs and print them numbered.
async function printMatchDetails(matchIds) {
  let index = 1;
  for (const matchId of matchIds) {
    const details = await getMatchDetails(matchId);
    console.log(
      `${index}. ${matchId} | mode: ${details.gameMode} | queueId: ${details.queueId} | duration: ${formatDuration(details.durationSeconds)} | played: ${formatDate(details.gameCreationMs)}`
    );
    index++;
  }
}

// ---- Step 4: Tie it all together ----
async function main() {
  try {
    console.log(`Looking up PUUID for ${GAME_NAME}#${TAG_LINE}...`);
    const puuid = await getPUUID(GAME_NAME, TAG_LINE);
    console.log(`Found PUUID: ${puuid}`);

    // Sanity check: confirm this PUUID really is VDRJ#0405, not a stale value.
    await verifyPUUID(puuid, GAME_NAME, TAG_LINE);

    console.log(`\nFetching your ${MATCH_COUNT} most recent match IDs (no date filter, start=0)...`);
    const matchIds = await getRecentMatchIds(puuid, MATCH_COUNT);

    console.log("\nRecent matches:");
    await printMatchDetails(matchIds);

    // Now specifically ask Riot for matches within the Sept 15, 2026 UAE
    // calendar day, using startTime/endTime (in epoch seconds).
    console.log(
      `\nFetching matches specifically between ${new Date(TARGET_DATE_START * 1000).toISOString()} ` +
        `and ${new Date(TARGET_DATE_END * 1000).toISOString()} (UTC; i.e. Sept 15, 2026 in UAE time)...`
    );
    const targetDayMatchIds = await getRecentMatchIds(
      puuid,
      100,
      TARGET_DATE_START,
      TARGET_DATE_END
    );

    console.log(`\nMatches found on Sept 15, 2026 (UAE time): ${targetDayMatchIds.length}`);
    if (targetDayMatchIds.length > 0) {
      await printMatchDetails(targetDayMatchIds);
    }
  } catch (error) {
    // Print any errors in a readable way instead of a raw crash.
    console.error("\nSomething went wrong:");
    console.error(error.message);
  }
}

// Run the script.
main();
