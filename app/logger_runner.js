// =============================================================================
// logger_runner.js
//
// A tiny "wrapper" that runs ../live_logger.js so the app can stop it cleanly.
//
// Why this exists: live_logger.js saves its file when it receives Ctrl+C
// (a "SIGINT" signal). On Windows, one program can't send Ctrl+C to another
// in the background -- trying to just kills it instantly, and the final save
// never happens. So instead, main.js starts THIS file, which loads
// live_logger.js into the same process. When the app sends us a "stop"
// message, we fire the SIGINT event ourselves, which runs live_logger.js's
// normal Ctrl+C handler: it saves the log and exits, exactly as if you had
// pressed Ctrl+C in a terminal.
// =============================================================================

const path = require('path');

// Listen for messages from the app (main.js).
process.on('message', (msg) => {
  if (msg === 'stop') {
    // First tell the app "I got your stop message", so the window can show
    // it. The save-and-quit code exits this process straight away, which
    // could cut that reply off, so we only run it once the reply has gone out
    // (that's what the function passed to process.send is for).
    process.send('stop-received', () => {
      process.emit('SIGINT'); // triggers live_logger.js's "save and quit" code
    });
  }
});

// The message channel to the app would normally keep this process alive
// forever. unref() means: "don't stay alive just for this channel". So if the
// logger finishes by itself (e.g. the match ends), this process exits normally.
if (process.channel) process.channel.unref();

// Load and start the logger. It starts running as soon as it's loaded.
// It still saves its JSON file next to itself (in the project folder).
// main.js passes the logger's full path as the first argument; if it's
// missing, fall back to the project folder one level up.
const loggerPath = process.argv[2] || path.join(__dirname, '..', 'live_logger.js');
require(loggerPath);
