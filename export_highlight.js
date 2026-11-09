// export_highlight.js
//
// This script reads the curated highlight moments from test_highlights.json
// and cuts an actual video clip out of test_clip.mp4 for each one, using
// ffmpeg. For every highlight it generates 4 variants — every combination
// of orientation (native 16:9 / vertical 9:16 for shorts/reels) and audio
// (with / without) — so you end up with a ready-to-use set of clips for
// whichever platform you're posting to.

const fs = require("fs");
const { execFileSync } = require("child_process");

// ---- Step 0: Configuration ----

const MATCH_ID = "ME1_20659395";

// Raw video recordings stay in the project root; everything derived from
// them (highlights, exported clips) lives together under matches/<matchId>/.
const MATCH_DIR = `matches/${MATCH_ID}`;
const CLIPS_DIR = `${MATCH_DIR}/clips`;

const VIDEO_PATH = "swiftplay_clip.mp4";
const HIGHLIGHTS_FILE = `${MATCH_DIR}/swiftplay_highlights.json`;

// How much extra footage to include around each highlight's videoTime.
const PAD_BEFORE_SECONDS = 5;
const PAD_AFTER_SECONDS = 8;

// Standard vertical (portrait) output size for shorts/reels.
const VERTICAL_WIDTH = 1080;
const VERTICAL_HEIGHT = 1920;

// ---- Step 1: Small helpers for working with "MM:SS" timestamps ----

// Turns "03:28" into 208 (total seconds).
function parseTimeToSeconds(timeStr) {
  const [minutes, seconds] = timeStr.split(":").map(Number);
  return minutes * 60 + seconds;
}

// Turns a total-seconds number into "HH:MM:SS", which is what ffmpeg's
// -ss flag expects. Clamped to 0 so padding near the start of the video
// never produces a negative timestamp.
function formatTimestamp(totalSeconds) {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0")
  );
}

// ---- Step 2: Cut one clip with ffmpeg ----
// orientation: "native" (unchanged 16:9) or "vertical" (cropped/scaled to 9:16)
// includeAudio: true or false
function exportClip(startSeconds, durationSeconds, orientation, includeAudio, outputPath) {
  const args = [
    "-y", // overwrite existing output
    "-loglevel", "error", // suppress ffmpeg's normal banner/progress spam —
                           // we're calling this 16 times in a row
    "-ss", formatTimestamp(startSeconds), // seek first (fast), then...
    "-i", VIDEO_PATH,
    "-t", String(durationSeconds), // ...grab exactly this many seconds
    "-c:v", "libx264", // re-encode video so the cut lands on an exact frame
                        // (rather than the nearest keyframe, which -c copy
                        // would give us) — same approach as test_highlight.mp4
  ];

  if (orientation === "vertical") {
    // Fit-and-pad: scale the whole 16:9 frame down to fit inside the 9:16
    // canvas without cropping any of the action, then fill the empty top/
    // bottom bars with a blurred, zoomed-in copy of the same frame instead
    // of plain letterbox bars.
    const filterComplex =
      `[0:v]split=2[bg][fg];` +
      `[bg]scale=${VERTICAL_WIDTH}:${VERTICAL_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${VERTICAL_WIDTH}:${VERTICAL_HEIGHT},gblur=sigma=20[bg];` +
      `[fg]scale=${VERTICAL_WIDTH}:${VERTICAL_HEIGHT}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]`;
    args.push("-filter_complex", filterComplex, "-map", "[vout]");
    if (includeAudio) {
      args.push("-map", "0:a");
    }
  }
  // "native" gets no video filter — the source is already 1920x1080.

  if (includeAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an"); // strip audio entirely
  }

  args.push(outputPath);

  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
}

// ---- Step 3: Tie it all together ----
function main() {
  const highlights = JSON.parse(fs.readFileSync(HIGHLIGHTS_FILE, "utf-8"));
  const verticalOnly = process.argv.includes("--vertical-only");

  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  console.log(`Exporting clips for ${highlights.length} highlights from ${VIDEO_PATH}...\n`);

  const allVariants = [
    { orientation: "native", includeAudio: true, suffix: "native_audio" },
    { orientation: "native", includeAudio: false, suffix: "native_noaudio" },
    { orientation: "vertical", includeAudio: true, suffix: "vertical_audio" },
    { orientation: "vertical", includeAudio: false, suffix: "vertical_noaudio" },
  ];
  const variants = verticalOnly
    ? allVariants.filter((v) => v.orientation === "vertical")
    : allVariants;

  const generatedFiles = [];

  highlights.forEach((highlight, index) => {
    const highlightNumber = index + 1;
    const centerSeconds = parseTimeToSeconds(highlight.videoTime);
    const startSeconds = centerSeconds - PAD_BEFORE_SECONDS;
    const durationSeconds = PAD_BEFORE_SECONDS + PAD_AFTER_SECONDS;

    console.log(`Highlight ${highlightNumber}: "${highlight.title}" (video ${highlight.videoTime})`);

    for (const variant of variants) {
      const outputPath = `${CLIPS_DIR}/highlight${highlightNumber}_${variant.suffix}.mp4`;
      exportClip(startSeconds, durationSeconds, variant.orientation, variant.includeAudio, outputPath);
      generatedFiles.push(outputPath);
      console.log(`  -> ${outputPath}`);
    }
    console.log("");
  });

  console.log(`Done. Generated ${generatedFiles.length} clips.`);
}

main();
