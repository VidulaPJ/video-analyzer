// =============================================================================
// processes.js -- questions about other programs running on this PC.
//
// Windows comes with two small command-line tools that we use here:
//   tasklist -> lists the programs ("processes") that are running
//   netstat  -> lists network connections, including which program is
//               "listening" (waiting for connections) on which port
// We run them in the background and read what they print.
// =============================================================================

const { execFile } = require('child_process');

const COMMAND_TIMEOUT_MS = 10000; // give up on a single tasklist/netstat run after this long

// Run a command and return everything it printed. Rejects if it couldn't be
// run, failed, or took too long.
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Is a program with this file name (e.g. "obs64.exe") running right now?
// Returns true or false. Throws if Windows couldn't be asked.
//   /FI "IMAGENAME eq ..." -> only list processes with exactly this name
//   /FO CSV                -> print each one as "name","pid",... (the default
//                             table layout cuts long names short)
//   /NH                    -> no header line
async function isRunning(exeName) {
  const stdout = await run('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH']);
  return stdout.toLowerCase().includes(`"${exeName.toLowerCase()}"`);
}

// The file name of the process with this process ID ("PID"), or null if
// there is no such process (any more).
async function nameOfPid(pid) {
  const stdout = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const match = stdout.match(/^"([^"]+)"/m); // the first quoted thing on a line is the name
  return match ? match[1] : null;
}

// Which process is listening on this TCP port? Returns { pid, processName },
// or null if nothing is. Throws if Windows couldn't be asked.
//
// `netstat -ano` prints lines like:
//   TCP    0.0.0.0:4455    0.0.0.0:0    LISTENING    12345
// (-a = include listening ports, -n = numbers instead of names, which is much
// faster, -o = add the process ID). A listening port is the one whose "other
// end" is all zeros, because nobody is connected to it yet.
async function findPortListener(port) {
  const stdout = await run('netstat', ['-ano']);
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[0] !== 'TCP') continue;
    const [, localAddress, otherEnd] = parts;
    if (!localAddress.endsWith(`:${port}`)) continue;
    if (otherEnd !== '0.0.0.0:0' && otherEnd !== '[::]:0') continue;

    const pid = Number(parts[parts.length - 1]);
    let processName = null;
    try {
      processName = await nameOfPid(pid);
    } catch (err) {
      // we still know the PID, which is better than nothing
    }
    return { pid, processName };
  }
  return null;
}

// When was the program with this file name (e.g. "obs64.exe") started?
// Returns a Date, or null if it isn't running or Windows won't say (it
// doesn't for a program that runs "as administrator"). If several copies are
// running, the oldest one counts.
//
// tasklist can't tell us this, so we ask PowerShell, which also comes with
// Windows. It is slower to start, so only ask once in a while.
//   -NoProfile -NonInteractive -> start quickly and never stop to ask a question
async function startTime(exeName) {
  const name = exeName.replace(/\.exe$/i, '').replace(/'/g, "''"); // PowerShell wants "obs64", not "obs64.exe"
  const script = `(Get-Process -Name '${name}' -ErrorAction Stop | Sort-Object StartTime | ` +
    "Select-Object -First 1).StartTime.ToUniversalTime().ToString('o')";
  try {
    const stdout = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const time = new Date(stdout.trim());
    return Number.isNaN(time.getTime()) ? null : time;
  } catch (err) {
    return null;
  }
}

module.exports = { isRunning, findPortListener, startTime };
