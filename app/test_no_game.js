// =============================================================================
// test_no_game.js -- tries out no_game.js on FAKE session folders.
//
// Run it with:  node test_no_game.js
// It makes a new temporary folder (in Windows' temp folder, never in your real
// sessions folder), builds fake sessions in it, runs the rule on them, prints
// PASS or FAIL for each check, and deletes the temporary folder at the end.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const noGame = require('./no_game');

const DAY_MS = 24 * 60 * 60 * 1000;
let failures = 0;
function check(what, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? `  (${extra})` : ''}`);
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'no_game_test_'));
const sessionsRoot = path.join(testRoot, 'sessions');
const outside = path.join(testRoot, 'outside_must_survive'); // stands in for anything outside _no_game
fs.mkdirSync(sessionsRoot);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not delete');

// A fake session folder. log: undefined = no live_log.json, a string = written as is, else JSON.
function makeSession(name, { log, files = {}, video = 1000 } = {}) {
  const folder = path.join(sessionsRoot, name);
  fs.mkdirSync(folder);
  if (log !== undefined) fs.writeFileSync(path.join(folder, 'live_log.json'), typeof log === 'string' ? log : JSON.stringify(log));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), text);
  if (video) fs.writeFileSync(path.join(folder, `${name.slice(0, 10)} 12-00-00.mp4`), Buffer.alloc(video));
  fs.writeFileSync(path.join(folder, 'session.json'), JSON.stringify({
    sessionFolder: folder, videoFile: path.join(folder, `${name.slice(0, 10)} 12-00-00.mp4`), logFile: null,
  }));
  return folder;
}
const ev = (name, t) => ({ gameTime: t, event: { EventName: name, EventTime: t } });
const snap = (t) => ({ gameTime: t, players: [] });

console.log(`Test folder: ${testRoot}\n`);
console.log('--- 1. Deciding: game or no game? ---');
const cases = [
  ['2026-01-01_10-00_no-game', { }, true, 'no live_log.json, nothing else'],
  ['2026-01-01_10-05_empty', { log: { events: [], snapshots: [] } }, true, 'live_log.json with no events'],
  ['2026-01-01_10-10_Mel_short', { log: { events: [ev('GameStart', 0), ev('MinionsSpawning', 30)], snapshots: [snap(35)] } }, true, '35 s, only GameStart + MinionsSpawning'],
  ['2026-01-01_10-15_Mel_73s', { log: { events: [ev('GameStart', 0), ev('MinionsSpawning', 30)], snapshots: [snap(73)] } }, false, '73 s of game time (60 or more)'],
  ['2026-01-01_10-20_Mel_kill', { log: { events: [ev('GameStart', 0), ev('ChampionKill', 20)], snapshots: [snap(25)] } }, false, '25 s but has a kill'],
  ['2026-01-01_10-25_dragon', { log: { events: [ev('GameStart', 0), ev('DragonKill', 40)] } }, false, '40 s but has an objective'],
  ['2026-01-01_10-30_unknown', { log: { events: [ev('GameStart', 0), ev('SomethingNew', 5)] } }, false, 'an event name we do not know'],
  ['2026-01-01_10-35_report', { files: { 'report.json': '{}' } }, false, 'no log, but report.json'],
  ['2026-01-01_10-40_highlights', { files: { 'highlights.json': '{}' } }, false, 'no log, but highlights.json'],
  ['2026-01-01_10-45_endstats', { files: { 'end_stats.json': '{}' } }, false, 'no log, but end_stats.json'],
  ['2026-01-01_10-50_pdf', { log: { events: [ev('GameStart', 0)] }, files: { 'Kalista_report.pdf': 'x' } }, false, 'short game, but Kalista_report.pdf'],
  ['2026-01-01_10-55_broken', { log: '{ this is not json' }, false, 'live_log.json that cannot be read'],
  ['2026-01-01_11-00_keep-me', { }, false, 'no game, but on the noGameKeep list'],
];
for (const [name, opts, expected, what] of cases) {
  const folder = makeSession(name, opts);
  const judged = noGame.judgeSession(folder, { keepList: ['2026-01-01_11-00_keep-me'] });
  check(`${what} -> ${expected ? 'no game' : 'keep'}`, judged.noGame === expected, judged.reason);
}

console.log('\n--- 2. Moving a no-game session into _no_game ---');
const movedFrom = path.join(sessionsRoot, '2026-01-01_10-00_no-game');
const moved = noGame.moveToNoGame(sessionsRoot, movedFrom, 'no game log (live_log.json)', 'automatic');
(async () => {
  const m = await moved;
  check('folder is now in _no_game', fs.existsSync(m.to) && !fs.existsSync(movedFrom), m.to);
  check('no_game.json says when and why', JSON.parse(fs.readFileSync(path.join(m.to, 'no_game.json'), 'utf8')).reason === 'no game log (live_log.json)');
  const info = JSON.parse(fs.readFileSync(path.join(m.to, 'session.json'), 'utf8'));
  check('session.json points at the new place', info.sessionFolder === m.to && path.dirname(info.videoFile) === m.to, info.videoFile);
  check('log line written', fs.readFileSync(noGame.logFile(sessionsRoot), 'utf8').includes('MOVED (automatic)  2026-01-01_10-00_no-game'));
  let refused = false;
  try { await noGame.moveToNoGame(sessionsRoot, outside, 'test'); } catch (err) { refused = true; }
  check('refuses to move a folder that is not directly inside the sessions folder', refused && fs.existsSync(outside));

  // More items in _no_game, with different ages.
  const box = noGame.noGameFolder(sessionsRoot);
  const age = async (name, days) => {
    const r = await noGame.moveToNoGame(sessionsRoot, makeSession(name), 'test');
    const markerFile = path.join(r.to, 'no_game.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    marker.movedAt.iso = new Date(Date.now() - days * DAY_MS).toISOString();
    fs.writeFileSync(markerFile, JSON.stringify(marker));
  };
  await age('2026-01-02_10-00_old8days', 8);
  await age('2026-01-02_11-00_new2days', 2);
  await age('2026-01-02_12-00_kept30days', 30);
  fs.mkdirSync(path.join(box, '2026-01-02_13-00_nomarker')); // put there by hand: no no_game.json
  fs.writeFileSync(path.join(box, '2026-01-02_13-00_nomarker', 'x.mp4'), Buffer.alloc(500));

  console.log('\n--- 3. Listing _no_game ---');
  const keepList = ['2026-01-02_12-00_kept30days'];
  const list = await noGame.listNoGame(sessionsRoot, { retentionDays: 7, keepList });
  check('lists all 5 items', list.items.length === 5, list.items.map((i) => i.name).join(', '));
  check('total size adds up', list.totalBytes === list.items.reduce((s, i) => s + i.sizeBytes, 0), `${list.totalBytes} bytes`);
  check('item without no_game.json is never deleted automatically', list.items.find((i) => i.name.endsWith('nomarker')).deleteAfterMs === null);

  console.log('\n--- 4. The purge when the app starts (7 days) ---');
  const whileRecording = await noGame.purgeOld(sessionsRoot, { retentionDays: 7, keepList, mayDelete: () => false });
  check('while a session is recording, nothing is deleted', whileRecording.deleted.length === 0 && fs.existsSync(path.join(box, '2026-01-02_10-00_old8days')),
    whileRecording.failed.map((f) => f.error).join('; '));
  const off = await noGame.purgeOld(sessionsRoot, { retentionDays: null, keepList });
  check('with noGameRetentionDays switched off (null), nothing is deleted', off.deleted.length === 0);
  const purge = await noGame.purgeOld(sessionsRoot, { retentionDays: 7, keepList });
  check('only the 8-day-old item is deleted', purge.deleted.map((d) => d.name).join() === '2026-01-02_10-00_old8days', JSON.stringify(purge));
  check('the 2-day-old item is still there', fs.existsSync(path.join(box, '2026-01-02_11-00_new2days')));
  check('the 30-day-old item on the keep list is still there', fs.existsSync(path.join(box, '2026-01-02_12-00_kept30days')));
  check('the item without no_game.json is still there', fs.existsSync(path.join(box, '2026-01-02_13-00_nomarker')));
  check('the deletion is in the log', fs.readFileSync(noGame.logFile(sessionsRoot), 'utf8').includes('DELETED (automatic, moved here more than 7 days ago)  2026-01-02_10-00_old8days'));

  console.log('\n--- 5. Safety: things that must never be deleted ---');
  const refuse = async (what, name, opts = {}) => {
    let error = null;
    try { await noGame.deleteItem(sessionsRoot, name, { keepList, ...opts }); } catch (err) { error = err.message; }
    check(`refused: ${what}`, error !== null, error);
  };
  await refuse('".." (the folder above)', '..');
  await refuse('a path leading outside', '..\\..\\outside_must_survive');
  await refuse('a full path outside', outside);
  await refuse('an item on the keep list', '2026-01-02_12-00_kept30days');
  fs.symlinkSync(outside, path.join(box, 'shortcut_to_outside'), 'junction');
  await refuse('a junction (shortcut) in _no_game that leads outside', 'shortcut_to_outside');
  fs.mkdirSync(path.join(box, '2026-01-02_14-00_haslink'));
  fs.symlinkSync(outside, path.join(box, '2026-01-02_14-00_haslink', 'inner_link'), 'junction');
  await refuse('a folder that contains a shortcut leading outside', '2026-01-02_14-00_haslink');
  fs.mkdirSync(path.join(box, 'Riot Vanguard'));
  await refuse('anything with Riot or Vanguard in its path', 'Riot Vanguard');
  await refuse('while a session is recording', '2026-01-02_11-00_new2days', { mayDelete: () => false });
  check('everything outside _no_game is untouched', fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8') === 'do not delete');
  check('the other sessions are untouched', fs.readdirSync(sessionsRoot).filter((n) => n.startsWith('2026-')).length === cases.length - 1);

  console.log('\n--- 6. Delete by hand and Restore ---');
  const del = await noGame.deleteItem(sessionsRoot, '2026-01-02_13-00_nomarker', { keepList });
  check('Delete removes the item', !fs.existsSync(path.join(box, '2026-01-02_13-00_nomarker')), `${del.sizeBytes} bytes`);
  const back = await noGame.restoreItem(sessionsRoot, '2026-01-01_10-00_no-game');
  const backInfo = JSON.parse(fs.readFileSync(path.join(back.to, 'session.json'), 'utf8'));
  check('Restore moves it back to the sessions folder', back.to === movedFrom && fs.existsSync(movedFrom), back.to);
  check('after Restore, session.json points at the sessions folder again', backInfo.sessionFolder === movedFrom && path.dirname(backInfo.videoFile) === movedFrom);

  console.log('\n--- 7. The noGameRetentionDays setting ---');
  check('missing -> 7', noGame.retentionDaysFrom(undefined) === 7);
  check('3 -> 3', noGame.retentionDaysFrom(3) === 3);
  check('0 -> off', noGame.retentionDaysFrom(0) === null);
  check('"7" in quotes -> off', noGame.retentionDaysFrom('7') === null);
  check('2.5 -> off', noGame.retentionDaysFrom(2.5) === null);

  console.log('\n--- The log file the test wrote ---');
  console.log(fs.readFileSync(noGame.logFile(sessionsRoot), 'utf8'));

  // Remove the shortcuts first (only the shortcuts, not what they point to), then the test folder.
  fs.unlinkSync(path.join(box, 'shortcut_to_outside'));
  fs.unlinkSync(path.join(box, '2026-01-02_14-00_haslink', 'inner_link'));
  fs.rmSync(testRoot, { recursive: true });
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => { console.error('TEST CRASHED:', err); process.exitCode = 1; });
