// find_highlights.js
//
// This script asks Claude to act as a highlight-reel curator. It can work
// from two different timeline formats:
//
//   1. "manual" — a hand-written timeline (e.g. manual_timeline.json), where
//      each entry already has a game-time AND a video-time timestamp plus a
//      free-form description.
//
//   2. "riot" — a real timeline filtered from Riot's Match-V5 API data
//      (e.g. timeline_ME1_20659395.json, as produced by
//      fetch_swiftplay_data.js), where each entry has a game-time
//      timestamp and a kill/death/assist event description built from real
//      Riot data. video-time isn't present in this format, so it's derived
//      from game-time using this recording's known offset.
//
// Either way, Claude picks the most highlight-worthy moments from the list
// and explains why, and we carry both timestamps through to the output so
// each highlight can be looked up either in-game or in the recording.

const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const { z } = require("zod");
const { zodOutputFormat } = require("@anthropic-ai/sdk/helpers/zod");

// ---- Step 0: Configuration ----

process.loadEnvFile();

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set — add it to your .env file.");
}

const TARGET_NAME = "VDRJ";

// The real Riot timeline identifies VDRJ by full Riot ID (name#tag) instead
// of just the plain name used in the manual timeline / prompt text.
const TARGET_RIOT_ID = "VDRJ#0405";

const MATCH_ID = "ME1_20659395";

// All of this match's files live together under matches/<matchId>/, separate
// from raw video recordings (which stay in the project root).
const MATCH_DIR = `matches/${MATCH_ID}`;
const TIMELINE_FILE = `${MATCH_DIR}/timeline_${MATCH_ID}.json`;
const MATCH_FILE = `${MATCH_DIR}/match_${MATCH_ID}.json`; // set to null to skip extra context
const OUTPUT_FILE = `${MATCH_DIR}/swiftplay_highlights.json`;

// This recording's confirmed offset: video-time + 12s = game-time, i.e.
// game-time - 12s = video-time. Only used for the "riot" timeline format —
// the manual format already carries its own videoTime per entry.
const VIDEO_OFFSET_SECONDS = 12;

const client = new Anthropic();

// ---- Step 1: Define the shape we want Claude's answer in ----
// Using a schema (via Zod) + Structured Outputs means Claude's response is
// guaranteed to match this shape exactly — no fragile parsing of free-form
// text required. We ask Claude to echo back BOTH timestamps for whichever
// moments it picks, since we need to look each one up either in-game
// (gameTime) or in the recording (videoTime).
const HighlightsSchema = z.object({
  highlights: z
    .array(
      z.object({
        gameTime: z.string().describe('Game-time timestamp in "MM:SS" format, copied from the matching event'),
        videoTime: z.string().describe('Video-recording timestamp in "MM:SS" format, copied from the matching event'),
        title: z.string().describe('Short title, e.g. "Clutch escape"'),
        reason: z.string().describe("One-sentence explanation of why this moment is highlight-worthy"),
      })
    )
    .min(3)
    .max(5),
});

// ---- Step 2: Timestamp helpers ----
function mmssToSeconds(mmss) {
  const [minutes, seconds] = mmss.split(":").map(Number);
  return minutes * 60 + seconds;
}

function secondsToMmss(totalSeconds) {
  const clamped = Math.max(0, totalSeconds); // never go negative — clip to the start of the video
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ---- Step 3: Load events, in whichever format the input file uses ----
// Both formats end up normalized to the same shape: { gameTime, videoTime, description }.
function loadEvents(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (raw.length === 0) return [];

  // The manual format's entries have a videoTime field written by hand;
  // the real Riot-derived format never does (it has eventType instead).
  const isManualFormat = Object.prototype.hasOwnProperty.call(raw[0], "videoTime");

  if (isManualFormat) {
    return raw.map((e) => ({
      gameTime: e.gameTime,
      videoTime: e.videoTime,
      description: e.description,
    }));
  }

  // Real Riot timeline format: derive videoTime from gameTime using the
  // recording's known offset instead of trusting Claude to do the math.
  return raw.map((e) => ({
    gameTime: e.gameTime,
    videoTime: secondsToMmss(mmssToSeconds(e.gameTime) - VIDEO_OFFSET_SECONDS),
    description: e.description,
  }));
}

// ---- Step 4: Pull extra match context (final stats, champions) ----
// Optional — only used when the real Riot match data is available, to give
// Claude a fuller picture than the bare kill/death/assist lines can (e.g.
// who won, what champions were actually involved, how the target player's
// game ended up).
function loadMatchContext(filePath, targetRiotId) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const match = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const participants = match.info.participants;

  const nameFor = (p) =>
    p.riotIdGameName && p.riotIdTagline
      ? `${p.riotIdGameName}#${p.riotIdTagline}`
      : p.summonerName || "Unknown";

  const target = participants.find((p) => nameFor(p) === targetRiotId);
  const championByName = {};
  for (const p of participants) {
    championByName[nameFor(p)] = p.championName;
  }

  return {
    gameMode: match.info.gameMode,
    durationSeconds: match.info.gameDuration,
    target: target
      ? {
          champion: target.championName,
          role: target.role,
          kills: target.kills,
          deaths: target.deaths,
          assists: target.assists,
          goldEarned: target.goldEarned,
          damageToChampions: target.totalDamageDealtToChampions,
          visionScore: target.visionScore,
          win: target.win,
        }
      : null,
    championByName,
  };
}

// ---- Step 5: Build the prompt and ask Claude to curate ----
async function findHighlights() {
  const events = loadEvents(TIMELINE_FILE);
  const context = loadMatchContext(MATCH_FILE, TARGET_RIOT_ID);

  const eventLines = events
    .map((e) => `[game ${e.gameTime} / video ${e.videoTime}] ${e.description}`)
    .join("\n");

  let contextBlock = "";
  if (context) {
    const t = context.target;
    const durationMmss = secondsToMmss(context.durationSeconds);
    contextBlock =
      `\nMatch context: a ${context.gameMode} game lasting ${durationMmss}. ` +
      (t
        ? `${TARGET_NAME} played ${t.champion} (${t.role}), finishing ${t.kills}/${t.deaths}/${t.assists} ` +
          `KDA with ${t.damageToChampions} damage to champions, ${t.goldEarned} gold, and ${t.visionScore} vision score, ` +
          `on the ${t.win ? "winning" : "losing"} team.\n`
        : "\n") +
      `Champions involved: ${Object.entries(context.championByName)
        .map(([name, champ]) => `${name} (${champ})`)
        .join(", ")}.\n`;
  }

  const prompt = `You are curating a highlight reel from a League of Legends match for the player ${TARGET_NAME}.
${contextBlock}
Here is a timeline of moments from the match. Each entry has the in-game timestamp, the matching timestamp in the video recording, and a short description of what happened:

${eventLines}

Pick the most highlight-worthy moments from this list (as many as genuinely earn a spot, between 3 and 5). Don't just default to picking every entry — consider things like impressive plays, dramatic turnarounds, funny or notable deaths, rivalries or repeated duels with the same opponent, or narratively interesting moments. For each moment you pick, return its exact gameTime and videoTime (copied from the entry above, don't alter them), a short punchy title, and a one-sentence reason it's highlight-worthy.`;

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: zodOutputFormat(HighlightsSchema),
    },
    messages: [{ role: "user", content: prompt }],
  });

  if (!response.parsed_output) {
    throw new Error("Claude's response could not be parsed into the expected format.");
  }

  return response.parsed_output.highlights;
}

// ---- Step 6: Run it, print results, and save them ----
findHighlights()
  .then((highlights) => {
    console.log(`Top ${highlights.length} highlight-worthy moments for ${TARGET_NAME}:\n`);
    highlights.forEach((h, i) => {
      console.log(`${i + 1}. [game ${h.gameTime} / video ${h.videoTime}] ${h.title}`);
      console.log(`   ${h.reason}\n`);
    });

    fs.mkdirSync(MATCH_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(highlights, null, 2));
    console.log(`Saved ${highlights.length} highlights to ${OUTPUT_FILE}`);
  })
  .catch((error) => {
    console.error("Something went wrong:");
    console.error(error.message);
  });
