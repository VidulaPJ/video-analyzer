// read_timer.js
//
// This script reads the in-game timer that appears in the top-right corner
// of a screenshot, using OCR (Optical Character Recognition) — a technique
// that lets a computer "read" text out of an image — via the tesseract.js
// library. The actual OCR logic lives in timer_ocr.js, so both this script
// and build_time_map.js (which reads many frames) share the exact same code.

const { readTimer } = require("./timer_ocr");

// ---- Step 0: Configuration ----

// The screenshot we're reading the timer from, taken from the command line,
// e.g. `node read_timer.js some_other_frame.png`. process.argv is an array
// of everything typed on the command line — argv[0] is "node" and argv[1]
// is this script's path, so the first real argument is argv[2].
const IMAGE_PATH = process.argv[2];

if (!IMAGE_PATH) {
  console.error("Usage: node read_timer.js <frame.png>");
  process.exit(1);
}

// ---- Step 1: Run it and print just the clean extracted text ----
readTimer(IMAGE_PATH)
  .then((timerText) => {
    // Print only the bare timer value (e.g. "05:57") — no extra wording —
    // so this script's output can be piped into other tools/scripts later.
    console.log(timerText);
  })
  .catch((error) => {
    // Print any errors in a readable way instead of a raw crash.
    console.error("Something went wrong:");
    console.error(error.message);
  });
