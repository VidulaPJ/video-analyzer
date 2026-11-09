// detect_audio_spikes.js
//
// This script looks for moments in test_clip.mp4 where the audio suddenly
// gets a lot louder than its surroundings — the idea being that a kill, a
// big ability, or a team fight usually comes with a burst of sound effects
// (explosions, announcer lines, voice chat reactions) that stands out
// against the "normal" background noise of the game. Those loud moments are
// good *candidates* to go check by eye/ear — this script doesn't know what
// actually happened, it just flags "something loud happened here".
//
// How it works, in plain terms:
//
//   1. Chop the audio into small fixed-length windows (e.g. every 0.5s) and
//      ask ffmpeg how loud each window is (its RMS volume, in decibels).
//      This gives us a "volume over time" curve for the whole clip.
//
//   2. For every point on that curve, compare it to a "baseline" — the
//      typical (median) volume of a wider chunk of audio around it (e.g.
//      the surrounding 20 seconds). Using the surrounding audio instead of
//      a single fixed number means the baseline naturally adapts: a game
//      with generally loud background music won't trigger constantly, and
//      a quiet stretch will still flag a moment that's loud *for it*.
//
//   3. Any window that's significantly louder (in dB) than its local
//      baseline gets marked as a "spike".
//
//   4. A single loud moment (like a kill) usually shows up as several
//      consecutive spiking windows in a row, not just one — so nearby
//      spikes (within a few seconds of each other) get merged into one
//      event, keeping only the loudest point as that event's timestamp.
//
// The result is a list of MM:SS video-time candidates, printed and saved
// to audio_candidates.json.

const { execFileSync } = require("child_process");
const fs = require("fs");

// ---- Step 0: Configuration ----
// These are the "knobs" you'd tune if the results feel off — too many
// candidates (probably from music/ambience) or too few (missed moments).

// The raw recording stays in the project root; everything derived from it
// lives together under recordings/<name>/.
const RECORDING_DIR = "recordings/test_clip";

const VIDEO_PATH = "test_clip.mp4";
const OUTPUT_JSON = `${RECORDING_DIR}/audio_candidates.json`;

// How finely we sample volume over time. Smaller = more precise timing but
// more data to crunch; 0.5s is a good balance for catching short bursts.
const WINDOW_SECONDS = 0.5;

// How much surrounding audio (in seconds, centered on each point) we look
// at to decide what "normal" volume is at that point in the video.
const BASELINE_WINDOW_SECONDS = 20;

// How many decibels louder than the local baseline a window has to be to
// count as a "spike". dB is a logarithmic scale, so this is a *relative*
// jump in loudness, not an absolute volume level — an 8dB jump roughly
// means the audio got noticeably, unmistakably louder, not just a little.
const SPIKE_THRESHOLD_DB = 8;

// Spikes closer together than this (in seconds) are treated as the same
// underlying event and collapsed into one candidate timestamp.
const MERGE_GAP_SECONDS = 3;

// ---- Step 1: Find the audio's sample rate ----
// We need this to tell ffmpeg how many audio samples make up one
// WINDOW_SECONDS-long chunk (samples per second * seconds = samples per window).
function getAudioSampleRate(videoPath) {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0", // the first audio stream
    "-show_entries", "stream=sample_rate",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]).toString().trim();

  return parseInt(output, 10);
}

// ---- Step 2: Ask ffmpeg for the volume of every window ----
// We use two ffmpeg audio filters chained together:
//   - "asetnsamples=n=<N>" regroups the audio stream into fixed-size chunks
//     of N samples each (one "frame" per chunk), instead of ffmpeg's normal
//     variable-sized internal buffering.
//   - "astats=metadata=1:reset=1" computes volume statistics for each of
//     those chunks (reset=1 means "start fresh for every chunk" instead of
//     accumulating stats across the whole file).
//   - "ametadata=print:key=...:file=..." writes out just the stat we care
//     about (RMS_level — a standard measure of average loudness) for every
//     chunk, along with its timestamp, to a text file.
//
// "-f null -" tells ffmpeg to decode/filter the audio but not actually
// write any output file — we only want the side-effect (the stats file).
function extractVolumeLevels(videoPath, windowSamples) {
  // Deliberately just a bare filename (written to the current directory),
  // not a full path: ffmpeg's filter-string syntax treats ":" and "\" as
  // special characters, so a Windows path like "C:\Users\...\file.txt"
  // passed straight into the filter would be misparsed as filter options.
  const levelsFile = `audio_levels_${Date.now()}.txt`;

  execFileSync("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-i", videoPath,
    "-vn", // we only care about audio — skip decoding video entirely (faster)
    "-af",
    `asetnsamples=n=${windowSamples},astats=metadata=1:reset=1,` +
      `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=${levelsFile}`,
    "-f", "null",
    "-",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const raw = fs.readFileSync(levelsFile, "utf-8");
  fs.unlinkSync(levelsFile); // clean up the temp file, we've read what we need

  return parseLevelsFile(raw);
}

// ---- Step 2b: Parse ffmpeg's metadata dump into {timeSeconds, rmsDb} pairs ----
// ffmpeg's ametadata=print writes output like this, one pair of lines per chunk:
//
//   frame:14   pts:308700  pts_time:7
//   lavfi.astats.Overall.RMS_level=-18.204312
//
// We pull the timestamp from the "pts_time:" line and the loudness value
// from the line right after it.
function parseLevelsFile(raw) {
  const levels = [];
  const pattern = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.]+|-?inf|nan)/g;

  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const timeSeconds = parseFloat(match[1]);
    const rmsDb = parseDb(match[2]);
    levels.push({ timeSeconds, rmsDb });
  }

  return levels;
}

// RMS_level comes back as a normal negative number (e.g. -23.55) for
// audible chunks, but as literally "-inf" (or occasionally "nan") for a
// chunk of complete digital silence, since "zero volume" has no finite dB
// value. We clamp those to a very quiet-but-finite number so the rest of
// the math (averages, comparisons) doesn't have to special-case infinities.
const SILENCE_FLOOR_DB = -100;
function parseDb(rawValue) {
  if (rawValue === "-inf" || rawValue === "nan") return SILENCE_FLOOR_DB;
  return parseFloat(rawValue);
}

// ---- Step 3: Compute a rolling "local baseline" volume ----
// For each point in time, the baseline is the MEDIAN volume of a window of
// surrounding readings (BASELINE_WINDOW_SECONDS wide, centered on that
// point). We use the median rather than the average because a median
// mostly ignores short loud bursts sitting inside a window (which is
// exactly what we're trying to detect) — a handful of spike readings
// won't drag the "typical" value up the way an average would.
function computeRollingBaseline(levels, halfWindowSamples) {
  return levels.map((_, i) => {
    const start = Math.max(0, i - halfWindowSamples);
    const end = Math.min(levels.length - 1, i + halfWindowSamples);

    const windowValues = [];
    for (let j = start; j <= end; j++) {
      windowValues.push(levels[j].rmsDb);
    }
    windowValues.sort((a, b) => a - b);

    const mid = Math.floor(windowValues.length / 2);
    return windowValues.length % 2 === 0
      ? (windowValues[mid - 1] + windowValues[mid]) / 2
      : windowValues[mid];
  });
}

// ---- Step 4: Merge nearby spiking windows into single events ----
// A real spike (e.g. a kill sound) is usually louder than the threshold for
// several consecutive windows, not just one instant. Without merging we'd
// report the same moment 3-4 times in a row. We walk through the spikes in
// time order and group any that are within MERGE_GAP_SECONDS of the
// previous one, then keep only the loudest reading from each group as that
// event's representative timestamp.
function mergeSpikes(spikeEntries, mergeGapSeconds) {
  const events = [];
  let currentGroup = [];

  for (const entry of spikeEntries) {
    const previous = currentGroup[currentGroup.length - 1];
    if (previous && entry.timeSeconds - previous.timeSeconds > mergeGapSeconds) {
      events.push(pickLoudest(currentGroup));
      currentGroup = [];
    }
    currentGroup.push(entry);
  }
  if (currentGroup.length > 0) {
    events.push(pickLoudest(currentGroup));
  }

  return events;
}

function pickLoudest(group) {
  return group.reduce((loudest, entry) => (entry.rmsDb > loudest.rmsDb ? entry : loudest));
}

// ---- Step 5: Format seconds as "MM:SS" for video-time output ----
function formatVideoTime(totalSeconds) {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ---- Step 6: Tie it all together ----
async function main() {
  console.log(`Analyzing audio in ${VIDEO_PATH} for volume spikes...\n`);

  const sampleRate = getAudioSampleRate(VIDEO_PATH);
  console.log(`Detected audio sample rate: ${sampleRate} Hz`);

  const windowSamples = Math.round(sampleRate * WINDOW_SECONDS);
  console.log(`Sampling volume every ~${WINDOW_SECONDS}s (${windowSamples} samples/window)...`);

  const levels = extractVolumeLevels(VIDEO_PATH, windowSamples);
  console.log(`Extracted ${levels.length} volume readings.\n`);

  // Convert the baseline window from seconds into "how many readings on
  // each side of the current one" (since readings are WINDOW_SECONDS apart).
  const halfWindowSamples = Math.round((BASELINE_WINDOW_SECONDS / 2) / WINDOW_SECONDS);
  const baselines = computeRollingBaseline(levels, halfWindowSamples);

  // Flag every individual reading that's significantly above its local baseline.
  const spikeEntries = [];
  for (let i = 0; i < levels.length; i++) {
    const spikeDb = levels[i].rmsDb - baselines[i];
    if (spikeDb >= SPIKE_THRESHOLD_DB) {
      spikeEntries.push({
        timeSeconds: levels[i].timeSeconds,
        rmsDb: levels[i].rmsDb,
        baselineDb: baselines[i],
        spikeDb,
      });
    }
  }
  console.log(`${spikeEntries.length} individual readings were ${SPIKE_THRESHOLD_DB}dB+ above their local baseline.`);

  const events = mergeSpikes(spikeEntries, MERGE_GAP_SECONDS);
  console.log(`Merged into ${events.length} distinct candidate event(s) (within ${MERGE_GAP_SECONDS}s of each other).\n`);

  const results = events.map((e) => ({
    videoTime: formatVideoTime(e.timeSeconds),
    timestampSeconds: Math.round(e.timeSeconds * 10) / 10,
    rmsDb: Math.round(e.rmsDb * 10) / 10,
    baselineDb: Math.round(e.baselineDb * 10) / 10,
    spikeDb: Math.round(e.spikeDb * 10) / 10,
  }));

  console.log("Candidate timestamps (video-time):");
  for (const r of results) {
    console.log(`  ${r.videoTime}  —  ${r.rmsDb}dB vs baseline ${r.baselineDb}dB (+${r.spikeDb}dB)`);
  }

  fs.mkdirSync(RECORDING_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} candidate timestamps to ${OUTPUT_JSON}`);
}

main().catch((error) => {
  console.error("Something went wrong:");
  console.error(error.message);
  process.exit(1);
});
