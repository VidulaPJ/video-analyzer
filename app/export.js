// =============================================================================
// export.js -- cuts the highlights and review moments out of a session's video.
//
// "Analyze last match" leaves two files in the session folder:
//   highlights.json -> the best moments, each with a stretch of video (a "clip window")
//   report.json     -> the performance report, with the deaths picked for review
// This file turns each of those stretches into its own small video file, in a
// "clips" folder inside the session folder. The cutting is done by ffmpeg, a
// separate program that must be installed (the app already uses its sister
// program ffprobe to measure videos).
//
// For every clip two files are made, one with sound and one without:
//   Yunara_ARAM_Mayhem_12-34_kills_Heimerdinger_native_audio.mp4
//   Yunara_ARAM_Mayhem_12-34_kills_Heimerdinger_native_noaudio.mp4
// (champion, game mode, game time, what happened, framing, sound - see
// clipFileBase). Clips exported before this naming keep their old names,
// e.g. highlight1_Mel_kills_Heimerdinger_native_audio.mp4.
//
// A review moment whose stretch of video overlaps a highlight's (or another
// review moment's) is joined with it into one clip. Every row also gets a
// "who" line, written by who.js from the game log.
//
// The picture is the same in both, so it is only encoded once: the version
// without sound is a copy of the first with the sound left out, which takes
// well under a second.
//
// The way the vertical picture is built comes from export_highlight.js in the
// project root (that script itself is not used or changed).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJson, mmss } = require('./analyze'); // our own analyze.js (mmss: the one rounding rule for times)
const who = require('./who'); // our own who.js: writes the "who" line of each row

const CLIPS_FOLDER_NAME = 'clips'; // the subfolder of the session folder the clips go in

// The size of the vertical (portrait) picture, as used for shorts and reels.
const VERTICAL_WIDTH = 1080;
const VERTICAL_HEIGHT = 1920;
// The blurred background of the vertical picture is made from a copy this many
// times smaller and then stretched back up. A blurred picture has no detail to
// lose, so it looks the same, and blurring a small picture is much faster.
const BLUR_SHRINK = 4;
const BLUR_STRENGTH = 5; // how blurred (on the small copy; the same as 20 on the full size)

// The two framings you can choose between when exporting.
const FRAMINGS = {
  native: 'native (the video as recorded, 1920x1080)',
  vertical: `vertical 9:16 (${VERTICAL_WIDTH}x${VERTICAL_HEIGHT}, fit-and-pad)`,
};

// An "encoder" is the part of ffmpeg that squeezes the picture into a video
// file. There are two to choose from, tried in this order:
//   h264_nvenc -> done by the NVIDIA graphics card: fast
//   libx264    -> done by the processor: works on every PC, but slower
// The settings after each name ask for about the same picture quality.
const ENCODERS = [
  { name: 'h264_nvenc', label: 'hardware (h264_nvenc, the graphics card)', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '22', '-b:v', '0'] },
  { name: 'libx264', label: 'software (libx264, the processor)', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] },
];

// ---- What can be exported ---------------------------------------------------

// Read the session's files and list every clip that can be cut.
// Returns:
//   sessionFolder, clipsFolder
//   videoFile           -> "videoFile" from session.json (null if there is none)
//   videoExists         -> whether that file is still there
//   skippedFramePercent -> "obsSkippedFramePercent" from session.json (null if it isn't in there)
//   clips               -> one entry per row to show (built below)
//   notes               -> things worth telling the user, as plain sentences
// This function never throws.
function listClips(sessionFolder) {
  const list = {
    sessionFolder,
    clipsFolder: path.join(sessionFolder, CLIPS_FOLDER_NAME),
    videoFile: null,
    videoExists: false,
    skippedFramePercent: null,
    noVideo: false, // true if the moments only have game times (the session has no video)
    clips: [],
    notes: [],
  };

  const info = readJson(path.join(sessionFolder, 'session.json'));
  const game = (!info.error && info.data.game) || {};
  if (info.error) {
    list.notes.push(`session.json couldn't be read (${info.error}), so the video to cut from isn't known.`);
  } else {
    if (info.data.videoFile) {
      list.videoFile = path.normalize(info.data.videoFile);
      list.videoExists = fs.existsSync(list.videoFile);
      if (!list.videoExists) list.notes.push(`The video is not there any more (${list.videoFile}), so nothing can be exported.`);
    } else {
      list.notes.push('No video was recorded (or kept) for this session, so there is nothing to cut clips from: Export is switched off.');
    }
    if (typeof info.data.obsSkippedFramePercent === 'number') list.skippedFramePercent = info.data.obsSkippedFramePercent;
  }

  const highlights = readJson(path.join(sessionFolder, 'highlights.json'));
  const report = readJson(path.join(sessionFolder, 'report.json'));

  // The game log, for the "who" line of each row (see who.js). Without it the
  // lines saved in highlights.json and report.json are shown as they are.
  const playerName = (!highlights.error && highlights.data.player) || (!report.error && report.data.player) || '';
  const logRead = readJson(path.join(sessionFolder, 'live_log.json'));
  const whoContext = logRead.error ? null : who.contextFromLog(logRead.data, playerName);

  // One moment from one of the two files. `oldParts` finds the moment's
  // events for a file from before they were saved in it.
  let leftOut = 0;
  const moments = [];
  // `gameTimesOnly` is true for a file made for a session with no video (it
  // says noVideo: true): its moments have no stretch of video. They are still
  // listed, in the order of their game times, so the list can be read.
  const addMoment = (kind, number, moment, title, oldParts, gameTimesOnly) => {
    if (gameTimesOnly && typeof moment.gameSeconds === 'number') {
      list.noVideo = true;
      moments.push({
        id: `${kind}${number}`,
        kind,
        number,
        label: `${kind === 'highlight' ? 'Highlight' : 'Review'} ${number}`,
        title,
        gameSeconds: moment.gameSeconds,
        gameTime: mmss(moment.gameSeconds),
        videoTime: '-',
        start: moment.gameSeconds,
        end: moment.gameSeconds, // no length: only two moments at the very same second share a row
        savedWho: typeof moment.who === 'string' ? moment.who : '',
        whoParts: Array.isArray(moment.whoParts) ? moment.whoParts : (whoContext ? oldParts(moment, whoContext) : null),
      });
      return;
    }
    const start = moment.clipStartSeconds;
    const end = moment.clipEndSeconds;
    if (typeof start !== 'number' || typeof end !== 'number' || !(end > start)) {
      leftOut += 1;
      return;
    }
    moments.push({
      id: `${kind}${number}`,
      kind,                  // 'highlight' or 'review'
      number,
      label: `${kind === 'highlight' ? 'Highlight' : 'Review'} ${number}`,
      title,
      gameSeconds: moment.gameSeconds,
      // The text times are made from the saved numbers by the one rule (mmss),
      // so a file written before that rule still shows the right time.
      gameTime: typeof moment.gameSeconds === 'number' ? mmss(moment.gameSeconds) : moment.gameTime,
      videoTime: typeof moment.videoSeconds === 'number' ? mmss(moment.videoSeconds) : moment.videoTime,
      start,
      end,
      savedWho: typeof moment.who === 'string' ? moment.who : '',
      whoParts: Array.isArray(moment.whoParts) ? moment.whoParts : (whoContext ? oldParts(moment, whoContext) : null),
    });
  };

  if (highlights.error) {
    list.notes.push(`No highlights to show: highlights.json couldn't be read (${highlights.error}).`);
  } else {
    (highlights.data.highlights || []).forEach((h, i) => addMoment('highlight', i + 1, h, String(h.title || ''),
      who.partsOfOldHighlight, highlights.data.noVideo === true));
  }
  if (report.error) {
    list.notes.push(`No review moments to show: report.json couldn't be read (${report.error}).`);
  } else {
    (report.data.reviewMoments || []).forEach((m, i) => addMoment('review', i + 1, m,
      `Death ${m.ref}: killed by ${m.killedBy} (review score ${m.score})`, who.partsOfOldReview, report.data.noVideo === true));
  }

  // Moments whose stretches of video overlap become ONE row: a review moment
  // that falls inside a highlight, or two review moments close together. The
  // row's stretch runs from the earliest start to the latest end.
  const groups = [];
  for (const moment of [...moments].sort((a, b) => a.start - b.start)) {
    const group = groups[groups.length - 1];
    if (group && moment.start <= group.end) {
      group.end = Math.max(group.end, moment.end);
      group.moments.push(moment);
    } else {
      groups.push({ start: moment.start, end: moment.end, moments: [moment] });
    }
  }

  let withoutWho = 0;
  for (const group of groups) {
    // A joined row is named after its first highlight; if it has none, after
    // its first review moment. That is also the start of the file name.
    const byNumber = [...group.moments].sort((a, b) => (a.kind === b.kind ? a.number - b.number : (a.kind === 'highlight' ? -1 : 1)));
    const main = byNumber[0];
    const first = group.moments[0]; // the earliest one

    // The "who" line and the words for the file name: from the events of all
    // the row's moments together, in the order they happened.
    const steps = whoContext && group.moments.every((m) => m.whoParts)
      ? who.stepsFromParts(group.moments.flatMap((m) => m.whoParts), whoContext) : null;
    let whoText = steps ? who.lineFromSteps(steps) : '';
    if (!whoText) {
      // The events couldn't be found: fall back on the lines saved in the files.
      whoText = group.moments.map((m) => (group.moments.length > 1 && m.savedWho ? `${m.gameTime} ${m.savedWho}` : m.savedWho))
        .filter(Boolean).join(', then ');
    }
    if (!whoText) withoutWho += 1;

    list.clips.push({
      id: main.id,
      kind: main.kind,
      label: byNumber.map((m) => m.label).join(' + '),
      who: whoText,
      fileWords: steps ? who.slugFromSteps(steps) : '', // e.g. "Mel_kills_Heimerdinger", for the file name
      title: byNumber.map((m) => m.title).filter(Boolean).join(' + '),
      mergedFrom: group.moments.map((m) => m.id),
      gameTime: first.gameTime,
      videoTime: first.videoTime,
      clipStart: list.noVideo ? '-' : mmss(group.start),
      clipEnd: list.noVideo ? '-' : mmss(group.end),
      startSeconds: list.noVideo ? null : group.start,
      durationSeconds: list.noVideo ? null : Math.round((group.end - group.start) * 10) / 10,
    });
  }
  // Highlights first, then the review moments, each in the order of their numbers.
  const position = (clip) => (clip.kind === 'highlight' ? 0 : 1000) + Number(clip.id.replace(/\D/g, ''));
  list.clips.sort((a, b) => position(a) - position(b));
  // The start of each clip's file name, e.g. "Yunara_ARAM_Mayhem_12-34".
  const champion = game.champion || (!report.error && report.data.champion) || '';
  setFileStarts(list.clips, champion, game.modeName || game.mode || '');

  if (leftOut > 0) {
    list.notes.push(`${leftOut} moment${leftOut === 1 ? ' was' : 's were'} left out because the file doesn't say which stretch of video ` +
      'to cut (it was made by an older version of the app). Click "Analyze last match" again to fix that.');
  }
  if (withoutWho > 0) {
    list.notes.push(`${withoutWho} row${withoutWho === 1 ? ' has' : 's have'} no "who" line because ` +
      `${logRead.error ? `live_log.json couldn't be read (${logRead.error})` : 'the events could not be found in the game log'}. ` +
      'Clicking "Analyze last match" again may fix that.');
  }
  return list;
}

// Give every clip its `fileStart`: champion, game mode and game time, e.g.
// "Yunara_ARAM_Mayhem_12-34" (Windows doesn't allow ":" in a name, so the
// time uses "-"). A champion or mode that isn't known is left out; a clip with
// no game time uses its id instead ("highlight1"). Two clips at the same
// second get _2, _3, ... after the time, so their files can't overwrite each
// other. `clips` must already be in their final order, so the same clip gets
// the same name every time it is exported.
function setFileStarts(clips, champion, mode) {
  const seen = new Map(); // fileStart -> how many clips have it so far
  for (const clip of clips) {
    const time = clip.gameTime && clip.gameTime !== '-' ? String(clip.gameTime).replace(/:/g, '-') : clip.id;
    const start = [champion, mode, time].map((part) => who.safeForFileName(part || '')).filter(Boolean).join('_');
    const count = (seen.get(start) || 0) + 1;
    seen.set(start, count);
    clip.fileStart = count === 1 ? start : `${start}_${count}`;
  }
}

// The name of a clip's files without "_audio.mp4" / "_noaudio.mp4", e.g.
// "Yunara_ARAM_Mayhem_12-34_kills_Heimerdinger_native" (the words in the
// middle are already safe for a file name, see safeForFileName in who.js).
function clipFileBase(clip, framing) {
  return [clip.fileStart || clip.id, clip.fileWords, framing].filter(Boolean).join('_');
}

// ---- Running ffmpeg ---------------------------------------------------------

let running = null;     // the ffmpeg process that is working right now (null when none is)
let cancelled = false;  // true once cancelExport() was called during an export

// Run ffmpeg once and wait for it to finish. While it works it prints lines
// like "out_time_us=4500000" (how much video it has written so far, in
// millionths of a second), which we turn into a number from 0 to 1 for
// onFraction. Throws if ffmpeg can't be started or reports an error.
function runFfmpeg(args, durationSeconds, onFraction) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    running = child;
    let errors = '';
    let unfinishedLine = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      const lines = (unfinishedLine + text).split('\n');
      unfinishedLine = lines.pop(); // the last piece may be half a line - keep it for next time
      for (const line of lines) {
        const match = line.match(/^out_time_(?:us|ms)=(\d+)/); // both names mean millionths of a second
        if (match && onFraction) onFraction(Math.min(1, Number(match[1]) / 1e6 / durationSeconds));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => { errors = (errors + text).slice(0, 2000); }); // only the start is worth keeping

    child.on('error', (err) => {
      running = null;
      reject(new Error(err.code === 'ENOENT' ? 'ffmpeg was not found - it has to be installed and on the PATH' : err.message));
    });
    child.on('close', (code) => {
      running = null;
      if (code === 0) return resolve();
      // ffmpeg's first complaints say what went wrong; the later ones only
      // say that it then gave up. Each starts with a technical label in
      // square brackets, which is left out.
      const firstLines = errors.trim().split(/\r?\n/).slice(0, 2)
        .map((line) => line.replace(/^(\[[^\]]*\]\s*)+/, '').trim()).filter(Boolean).join(' / ');
      reject(new Error(firstLines || `ffmpeg stopped with code ${code}`));
    });
  });
}

// Stop an export that is under way (used when a session starts or the app
// closes). The clip being written at that moment is thrown away.
function cancelExport() {
  if (!running) return;
  cancelled = true;
  running.kill();
}

// The instructions for ffmpeg to cut one clip, with sound, in one framing.
function clipArgs(videoFile, clip, framing, encoder, outFile) {
  const args = [
    '-y',                    // replace the output file if it is already there
    '-hide_banner', '-loglevel', 'error', '-nostats', // print nothing except real errors...
    '-progress', 'pipe:1',   // ...and the progress lines that runFfmpeg reads
    '-ss', String(clip.startSeconds), // jump to the start of the clip first (fast), then...
    '-i', videoFile,
    '-t', String(clip.durationSeconds), // ...take exactly this many seconds
  ];

  if (framing === 'vertical') {
    // Fit-and-pad, as in export_highlight.js: the whole 16:9 picture is scaled
    // down until it fits inside the tall 9:16 picture, so nothing is cropped.
    // That leaves empty space above and below, which is filled with a blurred,
    // zoomed-in copy of the same picture instead of black bars.
    //   split    -> two copies of each frame: one for the background, one for the front
    //   [back]   -> zoomed in until it covers the whole tall picture, cut to size, blurred
    //   [front]  -> scaled to fit entirely inside the tall picture
    //   overlay  -> the front laid over the middle of the background
    const smallW = VERTICAL_WIDTH / BLUR_SHRINK;
    const smallH = VERTICAL_HEIGHT / BLUR_SHRINK;
    const filter =
      '[0:v]split=2[copy1][copy2];' +
      `[copy1]scale=${smallW}:${smallH}:force_original_aspect_ratio=increase,crop=${smallW}:${smallH},` +
      `gblur=sigma=${BLUR_STRENGTH},scale=${VERTICAL_WIDTH}:${VERTICAL_HEIGHT}[back];` +
      `[copy2]scale=${VERTICAL_WIDTH}:${VERTICAL_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2[front];` +
      '[back][front]overlay=(W-w)/2:(H-h)/2,setsar=1[out]';
    args.push('-filter_complex', filter, '-map', '[out]');
  } else {
    args.push('-map', '0:v:0'); // "native": the picture exactly as recorded
  }
  args.push(
    '-map', '0:a:0?',        // the sound (the ? means: carry on if the video has none)
    ...encoder.args,
    '-pix_fmt', 'yuv420p',   // the colour format every player and phone can show
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', // lets the clip start playing before it has fully loaded
    '-f', 'mp4', outFile,
  );
  return args;
}

// The instructions for ffmpeg to copy a finished clip with the sound left out.
// "-c copy" means nothing is encoded again, so the picture is identical.
function silentCopyArgs(fromFile, outFile) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', fromFile,
    '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', '-f', 'mp4', outFile];
}

async function removeIfThere(file) {
  try {
    await fs.promises.unlink(file);
  } catch (err) {
    // it wasn't there (or can't be deleted): nothing more to do
  }
}

// =============================================================================
// Export clips.
//   list       -> what listClips returned
//   clipIds    -> which rows to export, e.g. ['highlight1', 'review2']
//   framing    -> 'native' or 'vertical'
//   say(text)  -> called with each line to show in the window
//   onProgress({ fraction, text }) -> called often while it works; fraction
//                 goes from 0 to 1 over the whole export
// Returns { folder, files: [{ name, sizeBytes }], failed: [ids], encoders:
// [labels used], cancelled }. This function never throws.
// =============================================================================
async function exportClips({ list, clipIds, framing, say, onProgress }) {
  const result = { folder: list.clipsFolder, files: [], failed: [], encoders: [], cancelled: false };
  cancelled = false;
  try {
    if (!FRAMINGS[framing]) {
      say(`[Export: "${framing}" is not a framing - it must be native or vertical.]\n`);
      return result;
    }
    const clips = list.clips.filter((clip) => clipIds.includes(clip.id));
    if (clips.length === 0) {
      say('[Export: there is nothing to export.]\n');
      return result;
    }
    if (!list.videoFile || !fs.existsSync(list.videoFile)) {
      say(`[Export: the video ${list.videoFile || '(none in session.json)'} is not there, so no clips can be cut.]\n`);
      return result;
    }
    try {
      fs.mkdirSync(list.clipsFolder, { recursive: true });
    } catch (err) {
      say(`[Export: couldn't create the folder ${list.clipsFolder} (${err.message}).]\n`);
      return result;
    }

    say(`\n[Exporting ${clips.length} clip${clips.length === 1 ? '' : 's'} as ${FRAMINGS[framing]}, each with and without sound]\n` +
      `[From: ${list.videoFile}]\n[To:   ${list.clipsFolder}]\n`);

    let encoderIndex = 0; // which of ENCODERS to use; moves on to the next one if this one fails
    const startedAt = Date.now();

    for (let i = 0; i < clips.length && !cancelled; i++) {
      const clip = clips[i];
      const base = clipFileBase(clip, framing); // e.g. "Yunara_ARAM_Mayhem_12-34_kills_Heimerdinger_native"
      const audioFile = path.join(list.clipsFolder, `${base}_audio.mp4`);
      const silentFile = path.join(list.clipsFolder, `${base}_noaudio.mp4`);
      // Each file is written under a temporary name and only given its real
      // name once it is complete, so a half-written clip never looks finished.
      const audioPart = `${audioFile}.part`;
      const silentPart = `${silentFile}.part`;
      const progress = (fraction) => onProgress({
        fraction: (i + fraction) / clips.length,
        text: `Clip ${i + 1} of ${clips.length}: ${clip.label} - ${Math.round(fraction * 100)}%`,
      });
      progress(0);

      // 1. The clip with sound. If the hardware encoder fails, try again with
      //    the software one, and use that one for the rest of this export.
      let done = false;
      let problem = null;
      while (!done && !cancelled && encoderIndex < ENCODERS.length) {
        const encoder = ENCODERS[encoderIndex];
        try {
          await runFfmpeg(clipArgs(list.videoFile, clip, framing, encoder, audioPart), clip.durationSeconds,
            (fraction) => progress(fraction * 0.95));
          done = true;
          if (!result.encoders.includes(encoder.label)) result.encoders.push(encoder.label);
        } catch (err) {
          if (cancelled) break;
          problem = err.message;
          const next = ENCODERS[encoderIndex + 1];
          say(`[The ${encoder.label} encoder failed (${err.message})${next ? ` - falling back to ${next.label}` : ''}]\n`);
          encoderIndex += 1;
        }
      }
      if (cancelled) {
        await removeIfThere(audioPart);
        break;
      }
      if (!done) {
        await removeIfThere(audioPart);
        result.failed.push(clip.id);
        say(`[${clip.label} could not be exported: ${problem}]\n`);
        encoderIndex = ENCODERS.length - 1; // the next clip still gets a try with the software encoder
        continue;
      }

      // 2. The same clip without sound, copied from the one just made.
      try {
        await runFfmpeg(silentCopyArgs(audioPart, silentPart), clip.durationSeconds, null);
        await fs.promises.rename(audioPart, audioFile);
        await fs.promises.rename(silentPart, silentFile);
      } catch (err) {
        await removeIfThere(audioPart);
        await removeIfThere(silentPart);
        if (cancelled) break;
        result.failed.push(clip.id);
        say(`[${clip.label} could not be exported: ${err.message}]\n`);
        continue;
      }
      progress(1);

      for (const file of [audioFile, silentFile]) {
        const sizeBytes = fs.statSync(file).size;
        result.files.push({ name: path.basename(file), sizeBytes });
        say(`  ${path.basename(file)}  (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)\n`);
      }
    }

    result.cancelled = cancelled;
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (result.cancelled) say('[The export was stopped before it finished. The clips listed above are complete.]\n');
    if (result.encoders.length > 0) say(`[Encoder used: ${result.encoders.join(', then ')}]\n`);
    say(`[Export ${result.cancelled ? 'stopped' : 'finished'}: ${result.files.length} file${result.files.length === 1 ? '' : 's'} in ${seconds} seconds` +
      `${result.failed.length > 0 ? `, ${result.failed.length} clip${result.failed.length === 1 ? '' : 's'} failed` : ''}. Folder: ${list.clipsFolder}]\n`);
    return result;
  } catch (err) {
    say(`[The export stopped because of an unexpected error: ${err.message}]\n`);
    return result;
  }
}

module.exports = { listClips, exportClips, cancelExport, clipFileBase, FRAMINGS, CLIPS_FOLDER_NAME };
