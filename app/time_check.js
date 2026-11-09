// =============================================================================
// time_check.js -- checks that no moment has two different video times.
//
// It reads report.json and highlights.json in a session folder and looks for:
//   1. a text time that doesn't match the number saved next to it, by the one
//      rounding rule (e.g. "videoTime": "49:20" next to "videoSeconds": 2961,
//      which is 49:21)
//   2. the same moment (the same game time, to a tenth of a second) shown
//      with two different video times in different places
//   3. a review moment whose video time differs from the fact it cites
//   4. a citation such as [F35: game 45:00 / video 49:21] whose time differs
//      from fact F35's own time
//
// The app runs it after "Analyze last match" and before saving the report as
// PDF or Word, and shows any problem in capitals. It can also be run by hand:
//   node time_check.js "F:\ME\sessions\2026-10-15_22-28_Mel_Summoner's Rift_Win"
// which prints "TIME CHECK FAILED" and ends with exit code 1 if there is a problem.
// =============================================================================

const path = require('path');
const { readJson, mmss } = require('./analyze'); // our own analyze.js (mmss: the one rounding rule)

// The pairs of (text time, saved number) that must agree.
const PAIRS = [
  ['videoTime', 'videoSeconds'],
  ['atVideoTime', 'videoSeconds'],
  ['clipStart', 'clipStartSeconds'],
  ['clipEnd', 'clipEndSeconds'],
];

// The video part of a "when", e.g. "game 45:00 / video 49:21" -> "49:21" (null if none).
const videoPartOf = (when) => {
  const m = typeof when === 'string' ? when.match(/ \/ video (\S+)$/) : null;
  return m ? m[1] : null;
};

// Check the contents of the two files (either may be null).
// Returns { problems: [sentences], checkedTimes }. Never throws.
function checkData(report, highlights) {
  const problems = [];
  let checkedTimes = 0;
  const byGameSeconds = new Map(); // game time -> [{ video, where }]

  // Walk through everything in a file, looking at every object that has times.
  const walk = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${where}[${i}]${item && item.ref ? ` (${item.ref})` : ''}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [textKey, numberKey] of PAIRS) {
      if (typeof value[textKey] === 'string' && typeof value[numberKey] === 'number') {
        checkedTimes += 1;
        const expected = mmss(value[numberKey]);
        if (value[textKey] !== expected) {
          problems.push(`${where}: "${textKey}" says ${value[textKey]}, but "${numberKey}" ${value[numberKey]} is ${expected}`);
        }
      }
    }
    const video = typeof value.videoTime === 'string' ? value.videoTime : value.atVideoTime;
    if (typeof value.gameSeconds === 'number' && typeof video === 'string') {
      if (!byGameSeconds.has(value.gameSeconds)) byGameSeconds.set(value.gameSeconds, []);
      byGameSeconds.get(value.gameSeconds).push({ video, where });
    }
    for (const [key, inner] of Object.entries(value)) {
      if (inner && typeof inner === 'object') walk(inner, `${where}.${key}`);
    }
  };
  if (report && report.noVideo !== true) walk(report, 'report.json');
  if (highlights && highlights.noVideo !== true) walk(highlights, 'highlights.json');

  // 2. The same moment with two different video times.
  for (const [gameSeconds, seen] of byGameSeconds) {
    const different = [...new Set(seen.map((s) => s.video))];
    if (different.length > 1) {
      problems.push(`the moment at game time ${mmss(gameSeconds)} (${gameSeconds} s) has ${different.length} different video times: ` +
        seen.map((s) => `${s.video} in ${s.where}`).join('; '));
    }
  }

  if (report && report.noVideo !== true && Array.isArray(report.facts)) {
    const facts = new Map(report.facts.map((fact) => [fact.id, fact]));
    // 3. A review moment and the fact it cites.
    for (const m of report.reviewMoments || []) {
      const fact = facts.get(m.fact);
      const factVideo = fact ? videoPartOf(fact.when) : null;
      if (factVideo && m.videoTime) {
        checkedTimes += 1;
        if (factVideo !== m.videoTime) {
          problems.push(`review moment ${m.ref} says video ${m.videoTime}, but the fact it cites (${m.fact}) says video ${factVideo}`);
        }
      }
    }
    // 4. Every citation with a time, in the citations lists and inside the sentences.
    const citationsIn = (item, where) => {
      for (const c of item.citations || []) {
        const fact = facts.get(c.fact);
        if (fact && c.when) {
          checkedTimes += 1;
          if (c.when !== fact.when) problems.push(`${where} cites ${c.fact} as "${c.when}", but ${c.fact} says "${fact.when}"`);
        }
      }
      for (const text of [item.text, item.detail, item.note]) {
        if (typeof text !== 'string') continue;
        // One bracket may cite several facts: [F8: game 20:56 / video 25:06; F9: game 24:12 / video 28:22]
        for (const [, inside] of text.matchAll(/\[([^\]]+)\]/g)) {
          for (const part of inside.split(/;\s*/)) {
            const m = part.match(/^(F\d+): (.+)$/);
            const fact = m ? facts.get(m[1]) : null;
            if (!fact || !fact.when) continue;
            checkedTimes += 1;
            if (m[2] !== fact.when) problems.push(`${where} writes [${m[1]}: ${m[2]}], but ${m[1]} says "${fact.when}"`);
          }
        }
      }
    };
    for (const section of ['summary', 'wentWell', 'toImprove', 'points', 'reviewMoments']) {
      (report[section] || []).forEach((item, i) => citationsIn(item, `report.json ${section}[${i}]${item.ref ? ` (${item.ref})` : ''}`));
    }
  }
  return { problems, checkedTimes };
}

// Check the files of one session folder. Returns { problems, checkedTimes,
// filesChecked }. A file that isn't there is skipped (it has nothing to
// contradict); a file that can't be read is a problem. Never throws.
function checkSession(sessionFolder) {
  const filesChecked = [];
  const problems = [];
  const load = (name) => {
    const read = readJson(path.join(sessionFolder, name));
    if (!read.error) {
      filesChecked.push(name);
      return read.data;
    }
    if (read.error !== 'the file does not exist') problems.push(`${name} couldn't be read: ${read.error}`);
    return null;
  };
  const report = load('report.json');
  const highlights = load('highlights.json');
  const result = checkData(report, highlights);
  return { problems: [...problems, ...result.problems], checkedTimes: result.checkedTimes, filesChecked };
}

// The lines to show in the window for a check that found problems.
function loudLines(sessionFolder, result) {
  return [
    `[TIME CHECK FAILED: ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} in ${path.basename(sessionFolder)} - ` +
      'the same moment has two different video times:]',
    ...result.problems.map((problem) => `[  - ${problem}]`),
  ].join('\n');
}

// Run by hand: node time_check.js <session folder> [<session folder> ...]
if (require.main === module) {
  const folders = process.argv.slice(2);
  if (folders.length === 0) {
    console.error('Usage: node time_check.js <session folder> [<session folder> ...]');
    process.exit(2);
  }
  let failed = false;
  for (const folder of folders) {
    const result = checkSession(folder);
    if (result.problems.length > 0) {
      failed = true;
      console.error(`\n!!! TIME CHECK FAILED: ${folder}`);
      for (const problem of result.problems) console.error(`  - ${problem}`);
    } else {
      console.log(`OK: ${folder} (${result.checkedTimes} times checked in ${result.filesChecked.join(' and ') || 'no files'})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { checkSession, checkData, loudLines };
