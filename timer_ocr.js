// timer_ocr.js
//
// Shared OCR logic for reading the in-game timer out of a screenshot.
// Both read_timer.js (reads one frame) and build_time_map.js (reads many
// frames) use this same code, so there's only one place that knows how to
// find and read the timer.

const { createWorker } = require("tesseract.js");

// The pixel region where the timer appears (see read_timer.js for how
// these coordinates were found — the clock icon + "05:57" text sits at
// x=1800-1920, y=0-35 on a 1920x1080 frame).
const TIMER_REGION = {
  left: 1800,
  top: 0,
  width: 1920 - 1800,
  height: 35,
};

// Starts a Tesseract OCR worker configured for reading a "MM:SS" timer.
// Creating a worker loads the OCR language model, which takes a moment —
// when reading MANY frames (like build_time_map.js does), create the
// worker ONCE and reuse it, rather than once per frame.
async function createTimerWorker() {
  const worker = await createWorker("eng");
  await worker.setParameters({
    // Only digits and colon can appear in a timer — this stops Tesseract
    // from mis-reading a digit as a similar-looking letter.
    tessedit_char_whitelist: "0123456789:",
    // Treat the crop as a single line of text, not a full page layout.
    tessedit_pageseg_mode: "7",
  });
  return worker;
}

// Runs OCR on one image using an already-created worker, and returns the
// cleaned-up timer text (e.g. "05:57").
async function readTimerWithWorker(worker, imagePath) {
  const { data } = await worker.recognize(imagePath, {
    rectangle: TIMER_REGION,
  });
  return data.text.trim();
}

// Convenience one-shot version: creates a worker, reads one image, shuts
// the worker down. Use this when you only need to read a single frame.
async function readTimer(imagePath) {
  const worker = await createTimerWorker();
  try {
    return await readTimerWithWorker(worker, imagePath);
  } finally {
    await worker.terminate();
  }
}

module.exports = { TIMER_REGION, createTimerWorker, readTimerWithWorker, readTimer };
