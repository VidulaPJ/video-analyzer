// build_time_map.js
//
// This script builds a lookup table between VIDEO time (how far into the
// .mp4 file we are) and GAME time (the in-game timer shown on screen at
// that moment) — useful for later mapping "something happened at X:XX in
// the game" back to "that's at Y:YY in the recording".
//
// It does this by:
//   1. Asking ffprobe how long the video is.
//   2. Extracting one frame every 30 seconds with ffmpeg.
//   3. Running the same OCR logic as read_timer.js (via timer_ocr.js) on
//      each extracted frame to read the game timer shown in it.
//   4. Saving the resulting video-time -> game-time pairs to time_map.json.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createTimerWorker, readTimerWithWorker } = require("./timer_ocr");

// ---- Step 0: Configuration ----

// The raw recording stays in the project root; everything derived from it
// (frames, the time map) lives together under recordings/<name>/.
const RECORDING_DIR = "recordings/test_clip";

const VIDEO_PATH = "test_clip.mp4";
const INTERVAL_SECONDS = 30; // how often to sample a frame
const FRAMES_DIR = `${RECORDING_DIR}/time_map_frames`; // where extracted frames are saved
const OUTPUT_JSON = `${RECORDING_DIR}/time_map.json`;

// ---- Step 1: Ask ffprobe how long the video is ----
function getVideoDurationSeconds(videoPath) {
  // execFileSync runs a command and waits for it to finish, returning its
  // output. We pass ffprobe's arguments as an array (not one big string)
  // so there's no risk of the file path being misinterpreted as extra
  // command-line flags.
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]).toString().trim();

  return parseFloat(output);
}

// ---- Step 2: Small helper to format seconds as HH:MM:SS for ffmpeg ----
function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0")
  );
}

// ---- Step 3: Extract one frame from the video at a given timestamp ----
function extractFrame(videoPath, timestampSeconds, outputPath) {
  execFileSync("ffmpeg", [
    "-y", // overwrite the output file if it already exists
    "-loglevel", "error", // suppress ffmpeg's normal banner/progress spam —
                           // we're calling this ~40 times and don't want
                           // 40 copies of ffmpeg's build info in our output
    "-ss", formatTimestamp(timestampSeconds), // seek to this point first (fast)
    "-i", videoPath,
    "-frames:v", "1", // grab exactly one frame
    outputPath,
  ], { stdio: ["ignore", "ignore", "pipe"] }); // still capture stderr so
                                                // real errors surface if
                                                // this throws
}

// ---- Step 3b: Clean up the raw OCR text ----
// Tesseract occasionally drops the thin ":" character (or, rarely, misses
// the timer text almost entirely). Since we know the format is ALWAYS
// "MM:SS", we can safely repair the common case (4 digits, no colon) by
// re-inserting the colon ourselves. Anything else we can't confidently fix,
// so we report it as unreadable instead of guessing.
function normalizeGameTime(rawText) {
  if (/^\d{2}:\d{2}$/.test(rawText)) {
    return rawText; // already well-formed, e.g. "05:57"
  }
  const digitsOnly = rawText.replace(/\D/g, "");
  if (digitsOnly.length === 4) {
    return `${digitsOnly.slice(0, 2)}:${digitsOnly.slice(2)}`; // "1027" -> "10:27"
  }
  return null; // couldn't confidently parse this one
}

// ---- Step 4: Tie it all together ----
async function main() {
  // Make sure the folder for extracted frames exists (recursive: true also
  // creates the parent recordings/<name>/ folder if it isn't there yet).
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const duration = getVideoDurationSeconds(VIDEO_PATH);
  console.log(`Video duration: ${duration.toFixed(2)}s`);

  // Build the list of video timestamps we want to sample: 0, 30, 60, ...
  // up to (but not past) the end of the video.
  const videoTimestamps = [];
  for (let t = 0; t < duration; t += INTERVAL_SECONDS) {
    videoTimestamps.push(t);
  }
  console.log(`Sampling ${videoTimestamps.length} frames, one every ${INTERVAL_SECONDS}s...\n`);

  // Create ONE OCR worker and reuse it for every frame — starting a new
  // worker per frame would reload the OCR language model each time, which
  // is much slower than reusing a single running worker.
  const worker = await createTimerWorker();

  const mappings = [];
  try {
    for (const t of videoTimestamps) {
      const videoTimestamp = formatTimestamp(t);
      const framePath = path.join(FRAMES_DIR, `frame_${String(t).padStart(5, "0")}.png`);

      extractFrame(VIDEO_PATH, t, framePath);
      const rawOcrText = await readTimerWithWorker(worker, framePath);
      const gameTime = normalizeGameTime(rawOcrText);

      mappings.push({
        videoTimestampSeconds: t,
        videoTimestamp,
        gameTime, // "MM:SS", or null if OCR couldn't be confidently parsed
        rawOcrText, // what Tesseract actually returned, kept for debugging
      });

      console.log(`video ${videoTimestamp} -> game ${gameTime ?? `(unreadable, raw: "${rawOcrText}")`}`);
    }
  } finally {
    // Always shut the worker down, even if something above throws.
    await worker.terminate();
  }

  // ---- Step 5: Save the results ----
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(mappings, null, 2));

  // ---- Step 6: Print a short summary ----
  const unreadableCount = mappings.filter((m) => m.gameTime === null).length;

  console.log(`\nSaved ${mappings.length} mappings to ${OUTPUT_JSON}`);
  console.log(`Extracted frames kept in ${FRAMES_DIR}/`);
  if (unreadableCount > 0) {
    console.log(`(${unreadableCount} of ${mappings.length} frames could not be read confidently — see "rawOcrText" for those entries in the JSON)`);
  }

  console.log("\nExample mappings:");
  const sampleIndices = [0, Math.floor(mappings.length / 2), mappings.length - 1];
  for (const i of sampleIndices) {
    const m = mappings[i];
    if (m) {
      console.log(`  video ${m.videoTimestamp} -> game ${m.gameTime ?? "(unreadable)"}`);
    }
  }
}

main().catch((error) => {
  console.error("Something went wrong:");
  console.error(error.message);
  process.exit(1);
});
