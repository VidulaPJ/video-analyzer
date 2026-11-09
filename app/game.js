// =============================================================================
// game.js -- finds out which champion you played, the game mode and the result.
//
// These three things go into the session folder's name, for example
// "2026-10-08_17-54_Kalista_ARAM_Loss".
//
// live_logger.js doesn't record the game mode or which player is you, and we
// aren't allowed to change it. So while the game is running we ask the game
// the same way the logger does: through its "Live Client Data API", a small
// web server the game runs on this PC. The result (win or loss) is only known
// at the very end, so that comes from the log file the logger saved.
// =============================================================================

const https = require('https');
const fs = require('fs');

const BASE_URL = 'https://127.0.0.1:2999/liveclientdata';
const REQUEST_TIMEOUT_MS = 3000; // give up on a single request after this long

// The game's API uses a "self-signed" certificate, which Node.js would normally
// reject. This agent skips that check, and is used ONLY for requests to the
// game on this PC (127.0.0.1) - the same approach as live_logger.js.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Ask the game's API for one endpoint (e.g. '/gamestats') and return the
// parsed JSON. Rejects if the game isn't running or the answer is unusable.
function getJson(endpoint) {
  return new Promise((resolve, reject) => {
    const options = { agent: insecureAgent, timeout: REQUEST_TIMEOUT_MS };
    const req = https.get(BASE_URL + endpoint, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP status ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Response was not valid JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

// Find you in a list of players. `playerName` is your Riot ID ("Name#TAG") as
// reported by the game; it may be missing.
function findPlayer(players, playerName) {
  if (!Array.isArray(players)) return null;
  if (playerName) {
    const me = players.find((p) => p.riotId === playerName || p.summonerName === playerName);
    if (me) return me;
  }
  // In some modes the game hides everyone's name except yours, so if exactly
  // one player has a real name, that player is you.
  const named = players.filter((p) => p.riotIdGameName);
  return named.length === 1 ? named[0] : null;
}

// Ask the running game who you are, which champion you picked and the mode.
// Anything it couldn't work out is null. Throws if the game isn't answering.
async function getLiveDetails() {
  const [playerName, stats, players] = await Promise.all([
    getJson('/activeplayername'),
    getJson('/gamestats'),
    getJson('/playerlist'),
  ]);
  const name = typeof playerName === 'string' && playerName ? playerName : null;
  const me = findPlayer(players, name);
  return {
    playerName: name,
    champion: me ? me.championName : null,
    mode: stats.gameMode || null, // e.g. "ARAM", or "CLASSIC" for Summoner's Rift
  };
}

// Read the result (and, as a backup, your champion) from a saved log file.
// Anything it couldn't work out is null. Throws if the file can't be read.
function readLogDetails(logFile, playerName) {
  const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));

  // The game reports "Win" or "Lose" in its GameEnd event. If you quit early
  // there is no GameEnd event, so the result stays unknown.
  const gameEnd = (log.events || []).find((e) => e.event && e.event.EventName === 'GameEnd');
  let result = null;
  if (gameEnd) result = gameEnd.event.Result === 'Lose' ? 'Loss' : gameEnd.event.Result;

  const snapshots = log.snapshots || [];
  const lastSnapshot = snapshots[snapshots.length - 1];
  const me = lastSnapshot ? findPlayer(lastSnapshot.players, playerName) : null;

  return { champion: me ? me.championName : null, result: result || null };
}

// The game reports its mode as an internal code name. These are the ones we
// know the everyday name for; any other code is shown as it is.
const MODE_NAMES = {
  CLASSIC: "Summoner's Rift",
  SWIFTPLAY: 'Swiftplay',
  ARAM: 'ARAM',
  KIWI: 'ARAM Mayhem',
  URF: 'URF',
  ARURF: 'ARURF',
  ONEFORALL: 'One for All',
  NEXUSBLITZ: 'Nexus Blitz',
  ULTBOOK: 'Ultimate Spellbook',
  CHERRY: 'Arena',
  STRAWBERRY: 'Swarm',
  BRAWL: 'Brawl',
  PRACTICETOOL: 'Practice Tool',
  TUTORIAL: 'Tutorial',
  TFT: 'Teamfight Tactics',
};

// Turn a mode code (e.g. "KIWI") into a readable name (e.g. "ARAM Mayhem").
function modeName(mode) {
  if (!mode) return null;
  return MODE_NAMES[mode] || mode;
}

module.exports = { getLiveDetails, readLogDetails, modeName };
