// =============================================================================
// report_export.js -- saves the performance report as a PDF and as a Word file.
//
// "Analyze last match" leaves report.json (and highlights.json) in the session
// folder. This file turns those into two documents in the same folder, named
// after the champion (see reportFileName in report.js):
//   Mel_report.pdf  -> made by Electron's own "print to PDF" from an HTML page
//   Mel_report.docx -> made with the docx package, with real headings and tables
// Older sessions have report.pdf / report.docx instead. Those are never
// renamed, deleted or overwritten: findReportFile still finds them.
// Nothing is sent to Claude: everything comes from the files already there.
// report.json is only read, never changed.
//
// Both documents are drawn from the same "model" (see buildModel), so they
// always say the same thing in the same order.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { readJson, mmss } = require('./analyze'); // our own analyze.js (mmss: the one rounding rule for times)
const timeCheck = require('./time_check'); // our own time_check.js: no moment may have two video times
const who = require('./who'); // our own who.js: writes the "who" line of each moment
const {
  withoutRecordingAdvice, reportFileName, highlightsWithOwnKill, standOutLine, dataLimitsFor,
  endOfGame, NO_END_STATS, ARAM_MODES, presentedReport, LIST_RULES,
} = require('./report'); // our own report.js

// A text time made from its saved number by the one rule, or the text as saved
// if there is no number (a session with no video saves no video numbers).
const timeOf = (seconds, text) => (typeof seconds === 'number' ? mmss(seconds) : text);

const FORMATS = ['pdf', 'docx'];

// The champion the report is about, as the report's header shows it: from
// report.json, else from session.json. '' if neither says.
function championOf(sessionFolder) {
  const reportRead = readJson(path.join(sessionFolder, 'report.json'));
  if (!reportRead.error && reportRead.data.champion) return reportRead.data.champion;
  const sessionRead = readJson(path.join(sessionFolder, 'session.json'));
  return (!sessionRead.error && sessionRead.data.game && sessionRead.data.game.champion) || '';
}

// The PDF or Word report already in a session folder, for the Open button:
// the newest of <Champion>_report.pdf/.docx and the old report.pdf/.docx.
// Null if there is none.
function findReportFile(sessionFolder) {
  const champion = championOf(sessionFolder);
  const names = new Set(FORMATS.flatMap((ext) => [reportFileName(champion, ext), `report.${ext}`]));
  let newest = null;
  for (const name of names) {
    const file = path.join(sessionFolder, name);
    try {
      const time = fs.statSync(file).mtimeMs;
      if (!newest || time > newest.time) newest = { file, time };
    } catch (err) {
      // not there: try the next name
    }
  }
  return newest ? newest.file : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---- Step 1: what goes in the report ----------------------------------------

// e.g. "15 October 2026, 22:28" (in this PC's own time zone). '' if `iso` isn't a date.
function dateText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${hh}:${mm}`;
}

// The match date from the folder name, e.g. "2026-10-15_22-28_Mel_..." -> "15 October 2026, 22:28".
function dateFromFolderName(sessionFolder) {
  const m = path.basename(sessionFolder).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}` : '';
}

// A "when" from report.json, e.g. "game 37:52 / video 42:13" or just "game 36:00"
// (no video), split into its two halves. Null if it isn't in that form.
function splitWhen(when) {
  const m = typeof when === 'string' ? when.match(/^game (\S+)(?: \/ video (\S+))?$/) : null;
  return m ? { game: m[1], video: m[2] || null } : null;
}

// Read the session's files and put together everything the documents show.
// Returns { model } or { error } (a sentence saying what is missing). Never throws.
function buildModel(sessionFolder) {
  const reportRead = readJson(path.join(sessionFolder, 'report.json'));
  if (reportRead.error) return { error: `report.json couldn't be read (${reportRead.error}). Click "Analyze last match" first.` };
  const report = reportRead.data;
  // These two only add to the report: without them it is still made.
  const highlightsRead = readJson(path.join(sessionFolder, 'highlights.json'));
  const sessionRead = readJson(path.join(sessionFolder, 'session.json'));
  const session = sessionRead.error ? {} : sessionRead.data;
  const game = session.game || {};
  const stats = report.stats || {};
  const noVideo = report.noVideo === true;
  // The League client's end-of-game numbers, read from end_stats.json itself
  // (so they also show for a report.json written before that file existed).
  // The game mode: from report.json, or (a report.json from an older version
  // of the app doesn't save it) from session.json.
  const mode = report.mode !== undefined ? report.mode : (game.mode || null);
  const endStatsRead = readJson(path.join(sessionFolder, 'end_stats.json'));
  const endTimelineRead = readJson(path.join(sessionFolder, 'end_timeline.json'));
  const endNumbers = endOfGame(endStatsRead.error ? null : endStatsRead.data, report.player, mode, endTimelineRead.error ? null : endTimelineRead.data);
  const aram = ARAM_MODES.includes(mode);

  const notes = []; // things to tell the user in the window
  if (highlightsRead.error) notes.push(`highlights.json couldn't be read (${highlightsRead.error}), so the table has the review moments only.`);

  // The "who" lines are written again from the game log, from the events each
  // moment saved ("whoParts"), so they follow who.js as it is now (e.g. no
  // "Blitzcrank (Blitzcrank)"). If that can't be done, the saved line is used.
  const logRead = readJson(path.join(sessionFolder, 'live_log.json'));
  const whoContext = logRead.error ? null : who.contextFromLog(logRead.data, report.player);
  const whoOf = (m) => (whoContext && Array.isArray(m.whoParts) && who.whoLine(m.whoParts, whoContext)) || m.who || '-';

  // A session with no video has no recording, so nothing may talk about one -
  // also in a report.json written before report.js took such words out itself.
  const clean = (text) => (noVideo ? withoutRecordingAdvice(text) : String(text));

  // The moments table: every highlight with a kill of your own (see
  // highlightsWithOwnKill in report.js), then every review moment, each on its
  // own row. (The window joins rows whose clips overlap; here each keeps its own times.)
  const moments = [];
  const withKill = highlightsWithOwnKill(highlightsRead.error ? [] : (highlightsRead.data.highlights || []).filter(Boolean),
    logRead.error ? null : logRead.data, report.player);
  const highlights = withKill.kept;
  const highlightsNote = withKill.leftOut.length === 0 ? ''
    : `${withKill.leftOut.length} of the ${withKill.kept.length + withKill.leftOut.length} highlights are left out because you got no kill ` +
      `of your own in ${withKill.leftOut.length === 1 ? 'it' : 'them'} (game ${withKill.leftOut.map((h) => timeOf(h.gameSeconds, h.gameTime)).join(', ')}).`;
  const row = (label, title, m) => {
    const clipStart = timeOf(m.clipStartSeconds, m.clipStart);
    const clipEnd = timeOf(m.clipEndSeconds, m.clipEnd);
    return {
      label,
      title,
      gameTime: timeOf(m.gameSeconds, m.gameTime) || '-',
      videoTime: timeOf(m.videoSeconds, m.videoTime) || '-',
      clipWindow: clipStart && clipEnd ? `${clipStart} - ${clipEnd}` : '-',
      who: whoOf(m),
    };
  };
  highlights.forEach((h, i) => moments.push(row(`Highlight ${i + 1}`, String(h.title || ''), h)));
  (report.reviewMoments || []).forEach((m, i) => moments.push(row(`Review ${i + 1} (${m.ref})`,
    `Death ${m.ref}: killed by ${m.killedBy} (review score ${m.score})`, m)));

  // A sentence Claude wrote that failed the checks was replaced by the fact itself.
  const replacedNote = (item) => (item.writtenBy === 'app' ? ' (Claude\'s sentence did not pass the checks, so this is the fact itself.)' : '');
  const listItem = (item) => ({
    text: `${clean(item.text)}${replacedNote(item)}`,
    why: typeof item.score === 'number' ? `Picked because: score ${Math.round(item.score)} out of 100 - ${item.measure}.` : '',
  });
  // Why a list has fewer items than it could have (report.json says the rules;
  // an older one doesn't, and then nothing is said).
  // The lists, the Summary and the points as shown: the end-of-game facts are
  // ranked in with the same scores, and what doesn't fit ARAM is left out (see
  // presentedReport in report.js). The lists are picked with today's rules, so
  // the "why it is short" notes use today's rules too.
  const shown = presentedReport(report, endNumbers, mode);
  const rules = LIST_RULES;
  const shortNote = (items, minimum, what) => {
    if (!rules) return '';
    if (items.length === 0) return `None this time: no candidate scored ${minimum} or higher.`;
    if (items.length < rules.maxItems) {
      return `Fewer ${what} qualified: only ${items.length} of the up to ${rules.maxItems} candidates scored ${minimum} or higher.`;
    }
    return '';
  };

  const model = {
    noVideo,
    title: `Performance report: ${report.champion || report.player || 'unknown champion'}`,
    facts: [
      ['Champion', report.champion || game.champion || '-'],
      ['Player', report.player || '-'],
      ['Mode', game.modeName || game.mode || '-'],
      ['Result', report.result || game.result || '-'],
      ['Date', dateText(session.sessionStartedAt && session.sessionStartedAt.iso) || dateFromFolderName(sessionFolder) || '-'],
      ['Match length', stats.gameLength || '-'],
    ],
    scoreLine: stats.final
      ? `Final score ${stats.final.kills}/${stats.final.deaths}/${stats.final.assists}, level ${stats.final.level}, ` +
        `${endNumbers ? `CS ${endNumbers.cs} (exact, ${endNumbers.csPerMinute} per minute)` : `CS ${stats.final.cs} (${stats.final.csPerMinute} per minute)`}, ` +
        `kill participation ${stats.final.killParticipationPercent}%.`
      : '',
    videoNote: noVideo ? 'No video was recorded for this session, so every time in this report is a game time and there are no video times or clip windows.' : '',
    summary: [...(report.summary || []).map((item) => `${clean(item.text)}${replacedNote(item)}`), ...(shown.summaryExtra ? [shown.summaryExtra] : [])],
    wentWell: shown.wentWell.map(listItem),
    toImprove: shown.toImprove.map(listItem),
    wentWellNote: shortNote(shown.wentWell, rules.minWentWell, 'strengths'),
    standOut: clean(standOutLine({ ...report, wentWell: shown.wentWell })),
    toImproveNote: shortNote(shown.toImprove, rules.minToImprove, 'things to improve'),
    leftOut: shown.notes,
    points: shown.points.map((point) => {
      // The point's times: one per cited fact that happened at a moment (or over
      // a stretch). Facts about the whole game have no time.
      let times = [];
      for (const citation of point.citations || []) {
        const when = splitWhen(citation.when);
        if (when && !times.some((t) => t.game === when.game && t.video === when.video)) times.push(when);
      }
      // A run of deaths is shown as its one range ("game 08:00-11:00"), not
      // also as the deaths at its two ends.
      if (point.rule === 'run-of-deaths' && times.some((t) => t.game.includes('-'))) times = times.filter((t) => t.game.includes('-'));
      return {
        title: point.title,
        times,
        detail: `${clean(point.detail)}${point.writtenBy === 'app' ? ' (Claude\'s sentences for this point did not pass the checks, so these are the facts themselves.)' : ''}`,
        why: point.why ? `Picked because: ${point.why}.` : '',
      };
    }),
    // ARAM and ARAM Mayhem only: each line is a fact with its own ID (E1, E2, ...).
    endOfGame: !aram ? null : endNumbers && endNumbers.facts.length > 0
      ? { intro: `${endNumbers.intro} Written by the app from those numbers, not by Claude.`, lines: endNumbers.facts.map((fact) => `${fact.text} [${fact.id}]`) }
      : { intro: NO_END_STATS, lines: [] },
    moments,
    highlightsNote,
    // (Sentences that didn't pass the checks are not shown in the documents;
    // report.json keeps them, under "unchecked".)
    // The limits are about what the game log can hold, not about this run, so
    // they are always today's wording for the mode (an older report.json
    // keeps the wording of its day; one with no mode saved still uses that).
    limits: mode !== null ? dataLimitsFor(mode, { endStats: Boolean(endNumbers), timeline: Boolean(endNumbers && endNumbers.timeline) }) : (report.dataLimits || []),
    footer: `Made by VideoAnalyzer from report.json${highlightsRead.error ? '' : ' and highlights.json'} in ${path.basename(sessionFolder)}.`,
  };
  return { model, notes };
}

// How a point's times are written, e.g. "game 37:52, video 42:13; game 29:28, video 33:48".
// With no video, just "game 37:52; game 29:28": the note at the top already says there is no video.
function pointTimesText(point, noVideo) {
  if (point.times.length === 0) return 'Whole game (no single moment)';
  return point.times.map((t) => (noVideo ? `game ${t.game}` : `game ${t.game}, video ${t.video || '-'}`)).join('; ');
}

const EMPTY_LIST = 'None this time: no candidate scored high enough.';
// The moments table. With no video there are no video times or clip windows,
// so those two columns are left out instead of being filled with dashes.
const tableHeadings = (noVideo) => (noVideo ? ['Moment', 'Game time', 'Who'] : ['Moment', 'Game time', 'Video time', 'Clip window', 'Who']);
const momentCells = (m, noVideo) => (noVideo ? [m.label, m.gameTime, m.who] : [m.label, m.gameTime, m.videoTime, m.clipWindow, m.who]);

// ---- Step 2a: the PDF -------------------------------------------------------

// Make text safe to put inside HTML (so a "<" in a sentence stays a "<").
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The report as one HTML page, styled for printing on A4.
function buildHtml(model) {
  // A time range such as "09:17-60:47" is kept on one line instead of breaking at the dash.
  const e = (text) => escapeHtml(text).replace(/\d{1,2}:\d{2}-\d{1,2}:\d{2}/g, '<span class="nowrap">$&</span>');
  const list = (items, note) => (items.length === 0 ? `<p>${e(note || EMPTY_LIST)}</p>`
    : `<ul>${items.map((item) => `<li>${e(item.text)}${item.why ? `<div class="why">${e(item.why)}</div>` : ''}</li>`).join('')}</ul>` +
      (note ? `<p class="why">${e(note)}</p>` : ''));
  const headings = tableHeadings(model.noVideo);
  const whoColumn = headings.length - 1;
  const parts = [
    `<h1>${e(model.title)}</h1>`,
    `<table class="facts">${model.facts.map(([label, value]) => `<tr><th>${e(label)}</th><td>${e(value)}</td></tr>`).join('')}</table>`,
    model.scoreLine ? `<p>${e(model.scoreLine)}</p>` : '',
    model.videoNote ? `<p class="note">${e(model.videoNote)}</p>` : '',
    '<h2>Summary</h2>',
    model.summary.length === 0 ? '<p>-</p>' : `<p>${e(model.summary.join(' '))}</p>`,
    '<h2>What went well</h2>', list(model.wentWell, model.wentWellNote),
    model.standOut ? `<p>${e(model.standOut)}</p>` : '',
    '<h2>What to improve</h2>', list(model.toImprove, model.toImproveNote),
    '<h2>Specific points</h2>',
    model.points.length === 0 ? '<p>None of the topic rules applied to this match.</p>'
      : model.points.map((p, i) => `<div class="point"><h3>${i + 1}. ${e(p.title)}</h3>` +
        `<p class="times"><b>Times:</b> ${e(pointTimesText(p, model.noVideo))}</p>` +
        `<p>${e(p.detail)}</p>${p.why ? `<p class="why">${e(p.why)}</p>` : ''}</div>`).join(''),
    ...model.leftOut.map((note) => `<p class="why">${e(note)}</p>`),
    ...(model.endOfGame ? [
      '<h2>End-of-game numbers</h2>',
      `<p class="why">${e(model.endOfGame.intro)}</p>`,
      model.endOfGame.lines.length > 0 ? `<ul>${model.endOfGame.lines.map((line) => `<li>${e(line)}</li>`).join('')}</ul>` : '',
    ] : []),
    '<h2>Highlights and review moments</h2>',
    model.moments.length === 0 ? '<p>There are no highlights or review moments for this match.</p>'
      : `<table class="moments"><thead><tr>${headings.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>` +
        model.moments.map((m) => `<tr>${momentCells(m, model.noVideo).map((c, i) => `<td${i === whoColumn ? ' class="who"' : ''}>${e(c)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table>',
    model.highlightsNote ? `<p class="why">${e(model.highlightsNote)}</p>` : '',
    '<h2>Limits of this report</h2>',
    '<p>What this data can\'t tell:</p>',
    `<ul>${model.limits.map((l) => `<li>${e(l)}</li>`).join('')}</ul>`,
    `<p class="footer">${e(model.footer)}</p>`,
  ];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(model.title)}</title><style>
    @page { size: A4; }
    body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.4; color: #1a1a1a; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 10px; }
    h2 { font-size: 14pt; margin: 18px 0 6px; padding-bottom: 2px; border-bottom: 1px solid #c8d0dc; break-after: avoid; }
    h3 { font-size: 11.5pt; margin: 10px 0 2px; break-after: avoid; }
    p { margin: 4px 0; }
    ul { margin: 4px 0; padding-left: 20px; }
    li { margin-bottom: 4px; break-inside: avoid; }
    .why { color: #555; font-size: 9.5pt; }
    .times { color: #23466e; }
    .note { color: #8a5a00; }
    .point { break-inside: avoid; }
    .nowrap { white-space: nowrap; }
    .footer { margin-top: 18px; color: #777; font-size: 8.5pt; }
    table { border-collapse: collapse; width: 100%; break-inside: avoid; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; } /* if a table must go over a page, its heading row is repeated */
    table.facts { width: auto; margin-bottom: 8px; }
    table.facts th { text-align: left; color: #555; font-weight: normal; padding: 1px 16px 1px 0; }
    table.facts td { padding: 1px 0; font-weight: 600; }
    table.moments { font-size: 9.5pt; margin-top: 4px; }
    table.moments th { background: #e8eef7; text-align: left; padding: 4px 6px; border: 1px solid #c8d0dc; }
    table.moments td { padding: 4px 6px; border: 1px solid #c8d0dc; vertical-align: top; white-space: nowrap; }
    table.moments td.who { white-space: normal; width: 45%; }
  </style></head><body>${parts.join('\n')}</body></html>`;
}

// Turn the HTML into a PDF with Electron's own Chromium, in a hidden window.
// Must be called from main.js (Electron's main process) after the app is ready.
async function htmlToPdf(html) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true, // keeps the shaded table headings
      margins: { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 }, // in inches
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8pt; color:#777; width:100%; text-align:center;">' +
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    win.destroy();
  }
}

// ---- Step 2b: the Word file -------------------------------------------------

async function buildDocx(model) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, ShadingType, BorderStyle, Footer, AlignmentType, PageNumber,
  } = require('docx');

  // A4 is 11906 x 16838 "twips" (1/20 of a point); 1134 twips = 2 cm margins.
  const MARGIN = 1134;
  const TEXT_WIDTH = 11906 - 2 * MARGIN;
  const GREY = '555555';

  const para = (text, options = {}) => new Paragraph({ children: [new TextRun({ text, ...options.run })], spacing: { after: 80 }, ...options.paragraph });
  const heading = (text, level) => new Paragraph({ text, heading: level, keepNext: true });
  const bullet = (text, why) => [
    new Paragraph({ children: [new TextRun(text)], bullet: { level: 0 }, spacing: { after: why ? 0 : 80 } }),
    ...(why ? [new Paragraph({ children: [new TextRun({ text: why, color: GREY, size: 19 })], indent: { left: 720 }, spacing: { after: 80 } })] : []),
  ];
  const list = (items, note) => (items.length === 0 ? [para(note || EMPTY_LIST)]
    : [...items.flatMap((item) => bullet(item.text, item.why)), ...(note ? [para(note, { run: { color: GREY, size: 19 } })] : [])]);
  const headings = tableHeadings(model.noVideo);

  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C8D0DC' };
  const borders = { top: border, bottom: border, left: border, right: border };
  // The table rows can't break across a page (cantSplit), the heading row is
  // repeated if the table goes over a page (tableHeader), and every row but the
  // last says "keep with next" so Word moves a short table to the next page whole.
  const momentsTable = () => {
    // With no video the Video time and Clip window columns are left out, and Who gets their width.
    const widths = model.noVideo ? [1700, 1000, TEXT_WIDTH - 2700] : [1700, 1000, 1000, 1500, TEXT_WIDTH - 5200];
    const cell = (text, i, { header = false, keepNext = true } = {}) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      borders,
      shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EEF7' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ keepNext, children: [new TextRun({ text, bold: header, size: 19 })] })],
    });
    return new Table({
      width: { size: TEXT_WIDTH, type: WidthType.DXA },
      columnWidths: widths,
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: headings.map((h, i) => cell(h, i, { header: true })) }),
        ...model.moments.map((m, r) => new TableRow({
          cantSplit: true,
          children: momentCells(m, model.noVideo).map((c, i) => cell(c, i, { keepNext: r < model.moments.length - 1 })),
        })),
      ],
    });
  };

  const children = [
    new Paragraph({ text: model.title, heading: HeadingLevel.TITLE }),
    ...model.facts.map(([label, value]) => new Paragraph({ spacing: { after: 20 },
      children: [new TextRun({ text: `${label}: `, color: GREY }), new TextRun({ text: value, bold: true })] })),
    ...(model.scoreLine ? [para(model.scoreLine, { paragraph: { spacing: { before: 120, after: 80 } } })] : []),
    ...(model.videoNote ? [para(model.videoNote, { run: { color: '8A5A00' } })] : []),
    heading('Summary', HeadingLevel.HEADING_1),
    para(model.summary.length === 0 ? '-' : model.summary.join(' ')),
    heading('What went well', HeadingLevel.HEADING_1), ...list(model.wentWell, model.wentWellNote),
    ...(model.standOut ? [para(model.standOut)] : []),
    heading('What to improve', HeadingLevel.HEADING_1), ...list(model.toImprove, model.toImproveNote),
    heading('Specific points', HeadingLevel.HEADING_1),
    ...(model.points.length === 0 ? [para('None of the topic rules applied to this match.')] : model.points.flatMap((p, i) => [
      heading(`${i + 1}. ${p.title}`, HeadingLevel.HEADING_2),
      new Paragraph({ keepNext: true, spacing: { after: 60 },
        children: [new TextRun({ text: 'Times: ', bold: true, color: '23466E' }), new TextRun({ text: pointTimesText(p, model.noVideo), color: '23466E' })] }),
      para(p.detail),
      ...(p.why ? [para(p.why, { run: { color: GREY, size: 19 } })] : []),
    ])),
    ...model.leftOut.map((note) => para(note, { run: { color: GREY, size: 19 } })),
    ...(model.endOfGame ? [
      heading('End-of-game numbers', HeadingLevel.HEADING_1),
      para(model.endOfGame.intro, { run: { color: GREY, size: 19 } }),
      ...model.endOfGame.lines.flatMap((line) => bullet(line)),
    ] : []),
    heading('Highlights and review moments', HeadingLevel.HEADING_1),
    ...(model.moments.length === 0 ? [para('There are no highlights or review moments for this match.')] : [momentsTable()]),
    ...(model.highlightsNote ? [para(model.highlightsNote, { run: { color: GREY, size: 19 }, paragraph: { spacing: { before: 80, after: 80 } } })] : []),
    heading('Limits of this report', HeadingLevel.HEADING_1),
    para('What this data can\'t tell:'),
    ...model.limits.flatMap((l) => bullet(l)),
    para(model.footer, { run: { color: '777777', size: 17 }, paragraph: { spacing: { before: 240 } } }),
  ];

  const doc = new Document({
    title: model.title,
    creator: 'VideoAnalyzer',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, // size is in half-points: 22 = 11 pt
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: '777777' })] })] }),
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

// =============================================================================
// Save the report of one session folder as a PDF or a Word file.
//   format -> 'pdf' or 'docx'
// Returns { file, sizeBytes, notes, timeProblems } when it worked, or { error }
// (a sentence). timeProblems is what time_check.js found: the file is still
// made, and main.js shows the problems in capitals.
// The file is named <Champion>_report.pdf / .docx. Saving again replaces that
// file; an old report.pdf / report.docx next to it is left as it is.
// The file is written under a temporary name first, so a half-written report
// never replaces a good one. This function never throws.
// =============================================================================
async function saveReport(sessionFolder, format) {
  let part = null;
  try {
    if (!FORMATS.includes(format)) return { error: `"${format}" is not a report format - it must be pdf or docx.` };
    const built = buildModel(sessionFolder);
    if (built.error) return { error: built.error };
    const bytes = format === 'pdf' ? await htmlToPdf(buildHtml(built.model)) : await buildDocx(built.model);
    const file = path.join(sessionFolder, reportFileName(championOf(sessionFolder), format));
    part = `${file}.part`;
    await fs.promises.writeFile(part, bytes);
    await fs.promises.rename(part, file);
    return { file, sizeBytes: bytes.length, notes: built.notes, timeProblems: timeCheck.checkSession(sessionFolder).problems };
  } catch (err) {
    if (part) await fs.promises.unlink(part).catch(() => {}); // don't leave a half-written file behind
    // The usual reason: the file is open in Word or a PDF viewer, which locks it.
    const locked = err.code === 'EBUSY' || err.code === 'EPERM';
    return { error: locked ? `the file is open in another program (close it and try again): ${err.message}` : err.message };
  }
}

module.exports = { saveReport, findReportFile, buildModel, buildHtml };
