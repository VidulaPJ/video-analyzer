// =============================================================================
// resource_monitor.js -- a small "how busy is this PC?" diary for one session.
//
// From the moment Start session is clicked until the game is detected, the
// waiting timeout ends the session, or Stop is clicked, this writes
// resource_log.csv into the session folder. It is there to find out whether
// this app or OBS slows the PC down while League loads.
//
// Each line of the file is one of these kinds:
//   sample      -> every 2 seconds: free memory, how busy the processor is,
//                  and how much of that is this app's own main process
//   disk        -> every 5 seconds: how busy the disks are
//   top_memory  -> every 10 seconds: the 5 programs using the most memory
//                  (by name only)
//   event       -> something this app did, e.g. "StartRecord sent to OBS"
//
// Keeping it cheap and harmless:
//   - Free memory and processor use come from Node.js itself (os.freemem and
//     os.cpus), which just reads numbers Windows keeps anyway. No program is
//     started for them.
//   - Disk use comes from ONE copy of "typeperf", a tool that comes with
//     Windows and prints a standard Windows performance counter
//     ("PhysicalDisk(_Total)\% Idle Time") every 5 seconds. It is started once
//     per session, not every 5 seconds.
//   - The memory top 5 comes from "tasklist", the same Windows tool the app
//     already uses to see whether League is running. It prints the list of
//     running programs with their memory use, like Task Manager shows. It does
//     not open, read, or change any program.
//   - Nothing here needs administrator rights.
//   - Lines are collected in memory and added to the file every 10 seconds,
//     and the file stops growing at MAX_BYTES.
// =============================================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const FILE_NAME = 'resource_log.csv';
const SAMPLE_MS = 2000;          // how often to write a "sample" line
const DISK_EVERY_SECONDS = 5;    // how often typeperf reports the disks
const TOP_MEMORY_MS = 10000;     // how often to write the memory top 5
const TOP_MEMORY_COUNT = 5;
const FLUSH_MS = 10000;          // how often the collected lines are added to the file
const MAX_BYTES = 3 * 1024 * 1024; // the file never grows past this (3 MB)
const COMMAND_TIMEOUT_MS = 10000; // give up on a single tasklist run after this long
// typeperf stops by itself after this many reports (1 hour at one per 5
// seconds), so it can't be left running forever if the app crashes.
const TYPEPERF_SAMPLES = 720;

const COLUMNS = ['time', 'seconds_since_start', 'kind', 'free_memory_mb', 'cpu_percent',
  'app_cpu_percent', 'disk_busy_percent', 'detail'];

let state = null; // null while no monitor is running

// ---- Small helpers ----------------------------------------------------------

// "2026-10-23 14:03:05.123" in the PC's own time zone.
function localTime(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// A value as it goes into a CSV file: text with commas or quotes is put in
// quotes, and quotes inside it are doubled.
function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const round1 = (n) => Math.round(n * 10) / 10;

// The processor's time so far, added up over all its cores: how much of it
// was spent idle, and how much in total (in milliseconds).
function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// ---- Writing lines ----------------------------------------------------------

// Collect one line; it reaches the file at the next flush.
function addRow(kind, fields = {}, at = new Date()) {
  if (!state || state.full) return;
  const row = [
    localTime(at),
    round1((at.getTime() - state.startedAtMs) / 1000),
    kind,
    fields.freeMemoryMb,
    fields.cpuPercent,
    fields.appCpuPercent,
    fields.diskBusyPercent,
    fields.detail,
  ].map(csvValue).join(',') + '\r\n';

  if (state.bytes + row.length > MAX_BYTES) {
    // Leave a note saying why the file ends here, then write nothing more.
    state.full = true;
    state.pending.push(`${csvValue(localTime(at))},,note,,,,,"The file reached ${MAX_BYTES / 1024 / 1024} MB, so nothing more is written"\r\n`);
    return;
  }
  state.bytes += row.length;
  state.pending.push(row);
}

// Add the collected lines to the file. Never throws: if the file can't be
// written (for example the drive was unplugged), the monitor gives up quietly.
function flush() {
  if (!state || state.pending.length === 0) return;
  const text = state.pending.join('');
  state.pending = [];
  try {
    fs.appendFileSync(state.file, text, 'utf8');
  } catch (err) {
    state.full = true; // stop collecting lines that can't be saved
  }
}

// ---- What gets measured -----------------------------------------------------

// Every 2 seconds: free memory, the whole PC's processor use, and how much of
// the processor this app's main process used (on the same scale, so 1.0 means
// 1% of the whole processor).
function takeSample() {
  const now = new Date();
  const cpu = cpuTotals();
  const app = process.cpuUsage(); // microseconds this process has used so far

  const totalDelta = cpu.total - state.lastCpu.total;
  const cpuPercent = totalDelta > 0 ? round1(100 * (1 - (cpu.idle - state.lastCpu.idle) / totalDelta)) : null;
  const elapsedMs = now.getTime() - state.lastSampleAtMs;
  const appUsedMs = (app.user - state.lastAppCpu.user + app.system - state.lastAppCpu.system) / 1000;
  const appCpuPercent = elapsedMs > 0 ? round1(100 * appUsedMs / (elapsedMs * os.cpus().length)) : null;

  state.lastCpu = cpu;
  state.lastAppCpu = app;
  state.lastSampleAtMs = now.getTime();

  addRow('sample', {
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    cpuPercent,
    appCpuPercent,
  }, now);

  if (now.getTime() - state.lastTopMemoryAtMs >= TOP_MEMORY_MS) {
    state.lastTopMemoryAtMs = now.getTime();
    checkTopMemory();
  }
}

// Every 10 seconds: the 5 programs using the most memory. tasklist prints one
// line per running program, like:  "chrome.exe","1234","Console","1","123,456 K"
// Programs with the same name (Chrome has many) are added together.
function checkTopMemory() {
  if (state.topMemoryRunning) return; // the previous one hasn't finished yet
  state.topMemoryRunning = true;
  const mine = state;
  const startedAtMs = Date.now();
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (err, stdout) => {
    mine.topMemoryRunning = false;
    if (state !== mine) return; // the monitor was stopped in the meantime
    const tookMs = Date.now() - startedAtMs;
    if (err) {
      addRow('top_memory', { detail: `tasklist failed: ${err.message}` });
      return;
    }
    const byName = new Map();
    for (const line of stdout.split('\n')) {
      const fields = line.trim().match(/"[^"]*"/g);
      if (!fields || fields.length < 5) continue;
      const name = fields[0].slice(1, -1);
      const kb = Number(fields[fields.length - 1].replace(/\D/g, '')); // "123,456 K" -> 123456
      if (!Number.isFinite(kb)) continue;
      byName.set(name, (byName.get(name) || 0) + kb);
    }
    const top = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_MEMORY_COUNT)
      .map(([name, kb]) => `${name} ${Math.round(kb / 1024)} MB`);
    addRow('top_memory', { detail: `${top.join('; ')} (tasklist took ${tookMs} ms)` });
  });
}

// Start typeperf, which prints how idle the disks were every 5 seconds, as
// lines like:  "10/23/2026 14:03:05.123","97.512"
// Disk busy % is 100 minus that. Some Windows languages write 97,512.
function startDiskCounter() {
  const mine = state;
  let child;
  try {
    child = spawn('typeperf', ['\\PhysicalDisk(_Total)\\% Idle Time',
      '-si', String(DISK_EVERY_SECONDS), '-sc', String(TYPEPERF_SAMPLES)], { windowsHide: true });
  } catch (err) {
    addRow('event', { detail: `Disk counter (typeperf) could not be started: ${err.message}` });
    return;
  }
  mine.diskProcess = child;
  let unfinished = '';
  let reportedProblem = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    if (state !== mine) return;
    const lines = (unfinished + text).split('\n');
    unfinished = lines.pop(); // the last piece may be half a line
    for (const line of lines) {
      const match = line.trim().match(/^"[^"]*","\s*([0-9.,]+)\s*"$/);
      if (match) {
        const idle = Number(match[1].replace(',', '.'));
        if (Number.isFinite(idle)) {
          addRow('disk', { diskBusyPercent: round1(Math.min(100, Math.max(0, 100 - idle))) });
        }
      } else if (/error/i.test(line) && !reportedProblem) {
        reportedProblem = true;
        addRow('event', { detail: `Disk counter (typeperf) says: ${line.trim()}` });
      }
    }
  });
  child.on('error', (err) => {
    if (state === mine) addRow('event', { detail: `Disk counter (typeperf) failed: ${err.message}` });
  });
  child.on('exit', (code) => {
    if (state === mine && mine.diskProcess === child) {
      mine.diskProcess = null;
      addRow('event', { detail: `Disk counter (typeperf) stopped by itself (exit code ${code}) - no more disk lines` });
    }
  });
}

// ---- Start and stop ---------------------------------------------------------

// Start writing resource_log.csv in this folder. If a monitor is already
// running it is stopped first. Never throws.
function start(folder) {
  if (state) stop('a new session started');
  const now = new Date();
  state = {
    file: path.join(folder, FILE_NAME),
    startedAtMs: now.getTime(),
    pending: [],
    bytes: 0,
    full: false,
    lastCpu: cpuTotals(),
    lastAppCpu: process.cpuUsage(),
    lastSampleAtMs: now.getTime(),
    lastTopMemoryAtMs: 0, // 0 = take the first top 5 at the first sample
    topMemoryRunning: false,
    diskProcess: null,
    sampleTimer: null,
    flushTimer: null,
  };
  state.pending.push(COLUMNS.join(',') + '\r\n');
  state.bytes = state.pending[0].length;
  addRow('event', { detail: `Monitor started (${os.cpus().length} processor threads, ` +
    `${Math.round(os.totalmem() / 1024 / 1024)} MB memory in all)` }, now);
  flush(); // the file exists from the very start

  state.sampleTimer = setInterval(takeSample, SAMPLE_MS);
  state.flushTimer = setInterval(flush, FLUSH_MS);
  startDiskCounter();
}

// Write one "event" line: something the app did. `at` is when it happened
// (default: now). Does nothing while no monitor is running.
function event(detail, at = new Date()) {
  addRow('event', { detail }, at);
}

// Stop: write a last line, stop typeperf and save everything to the file.
// Finishes at once (nothing is left writing to the session folder, so it can
// be renamed straight after). Does nothing if no monitor is running.
function stop(reason) {
  if (!state) return;
  addRow('event', { detail: `Monitor stopped: ${reason}` });
  clearInterval(state.sampleTimer);
  clearInterval(state.flushTimer);
  if (state.diskProcess) {
    const child = state.diskProcess;
    state.diskProcess = null;
    try {
      child.kill();
    } catch (err) {
      // it has already gone
    }
  }
  flush();
  state = null;
}

function isRunning() {
  return state !== null;
}

module.exports = { start, event, stop, isRunning, FILE_NAME };
