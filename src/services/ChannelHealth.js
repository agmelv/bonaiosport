/**
 * Which 24/7 channels actually play.
 *
 * A channel is listed because a source lists it, and a listing is not a
 * stream. A sweep of the live Channels tab found 136 of 733 channels that
 * opened to nothing: USA TV Next still lists FS1, FS2 and every FanDuel
 * regional long after their feeds died, and iptv-org keeps streams nobody
 * pruned. Each was a tile that looked like a channel and was a dead end.
 *
 * So every channel is opened in the background, slowly, and one that comes
 * back with no streams twice running is left out of the tab until a later
 * check finds it playing again. The check itself says "unknown" rather than
 * "none" whenever it cannot be sure (see countChannelStreams), and unknown
 * never hides anything. A channel never checked is shown: the tab never waits
 * on this, and a restart does not empty it.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

// Long enough for a sweep of the whole tab, one channel at a time with a gap,
// to finish inside it; short enough that a channel that comes back returns
// within a couple of hours.
const SWEEP_EVERY_MS = 90 * 60 * 1000;
// One empty result can be a bad minute, so a channel is hidden only when a
// second check agrees -- at least this long after its own first empty result.
// Timed per channel: timed from the start of the sweep, a channel checked at
// the end of a long sweep was confirmed seconds after its first look.
const CONFIRM_AFTER_MS = 15 * 60 * 1000;
// How often a confirmation pass may run.
const CONFIRM_EVERY_MS = 5 * 60 * 1000;
// A check where every source failed is unknown, not empty -- but a channel
// whose hosts refuse every connection never answers anything else. Hidden
// once this many checks in a row have all failed, over at least two
// confirmation intervals, so an outage of a few minutes cannot do it.
const FAILS_TO_HIDE = 3;
// How long a "no streams" result is trusted. Past it the channel is shown again
// until the next check says otherwise.
const DEAD_FOR_MS = 4 * 60 * 60 * 1000;
// One channel at a time with a pause. Opening a channel can mean scraping its
// sources, and a burst of that is what gets a server rate-limited.
const GAP_MS = Number(process.env.HEALTH_GAP_MS) || 1000;
// HIDE_EMPTY_CHANNELS=0 lists every channel whether it plays or not.
const ENABLED = process.env.HIDE_EMPTY_CHANNELS !== '0';

const results = new Map(); // match id -> { count, at, zeroStreak, failStreak, firstFailAt, lastFailAt }
// lastSweepAt is when the last full sweep began (what gates the next one);
// lastSweepDoneAt when one last finished, which is the one worth keeping: a
// sweep cut short by a restart has not checked everything, so the next start
// must not think it did.
const state = { running: false, lastSweepAt: 0, lastSweepDoneAt: 0, lastConfirmAt: 0, lastRunMs: null, checked: 0, unknown: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// What the checks found, kept across restarts. A deploy restarts the process,
// and with the results in memory alone every dead tile came back until a new
// sweep found it again -- Marquee Sports Network, whose one host no longer
// resolves, reappeared after each of a day's deploys -- while the sweep itself,
// six hundred channels one second apart, started over on every restart.
const STATE_FILE = path.join(DATA_DIR, 'channel-health.json');
const SAVE_AFTER_MS = 5000;
let saveTimer = null;

function load() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return; }   // first run
  if (!saved || !Array.isArray(saved.results)) return;
  const now = Date.now();
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  for (const entry of saved.results) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
    const r = entry[1];
    // A result older than it would be trusted for says nothing any more.
    if (Math.max(num(r.at), num(r.lastFailAt)) < now - DEAD_FOR_MS) continue;
    results.set(entry[0], {
      count: r.count === null ? null : num(r.count), at: num(r.at), zeroStreak: num(r.zeroStreak),
      failStreak: num(r.failStreak), firstFailAt: num(r.firstFailAt), lastFailAt: num(r.lastFailAt)
    });
  }
  // A clock that went backwards must not postpone the next sweep for years.
  state.lastSweepAt = Math.min(num(saved.lastSweepAt), now);
  state.lastSweepDoneAt = state.lastSweepAt;
}

/** Written a few seconds after the last change, so a sweep is not a thousand writes. */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ lastSweepAt: state.lastSweepDoneAt, results: [...results] }));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      // A data directory that cannot be written costs the memory across restarts, nothing else.
    }
  }, SAVE_AFTER_MS);
  if (saveTimer.unref) saveTimer.unref();
}

if (ENABLED) load();

function record(id, count) {
  const prev = results.get(id);
  const zeroStreak = count === 0 ? ((prev && prev.zeroStreak) || 0) + 1 : 0;
  results.set(id, { count, at: Date.now(), zeroStreak, failStreak: 0, firstFailAt: 0, lastFailAt: 0 });
  save();
}

/** A check on which every source failed. Keeps what the last real count said. */
function recordFailure(id) {
  const prev = results.get(id);
  const now = Date.now();
  const failStreak = ((prev && prev.failStreak) || 0) + 1;
  results.set(id, {
    count: prev ? prev.count : null,
    at: prev ? prev.at : 0,
    zeroStreak: prev ? prev.zeroStreak : 0,
    failStreak,
    firstFailAt: prev && prev.failStreak ? prev.firstFailAt : now,
    lastFailAt: now
  });
  save();
}

/**
 * True when two checks in a row, the last recently enough, found no streams --
 * or when every source has failed on several checks in a row, over long
 * enough that it is the hosts being down rather than a bad minute.
 */
function isDead(id) {
  if (!ENABLED) return false;
  const r = results.get(id);
  if (!r) return false;
  const now = Date.now();
  if (r.count === 0 && r.zeroStreak >= 2 && now - r.at < DEAD_FOR_MS) return true;
  return r.failStreak >= FAILS_TO_HIDE
    && now - r.firstFailAt >= 2 * CONFIRM_AFTER_MS
    && now - r.lastFailAt < DEAD_FOR_MS;
}

/**
 * Check the channels that are due: all of them when a sweep is due, or just the
 * ones that came back empty once when their confirmation is due.
 *
 * `countStreams` is supplied by the caller rather than imported: it lives in
 * streams.js, which the catalog already imports. It resolves to a count, or
 * throws when the answer is unknown.
 */
function sweep(channels, countStreams) {
  if (!ENABLED || state.running || !Array.isArray(channels) || !channels.length) return;
  const now = Date.now();
  let queue;
  let full = false;
  if (now - state.lastSweepAt >= SWEEP_EVERY_MS) {
    queue = channels.slice();
    full = true;
    state.lastSweepAt = now;
  } else if (now - state.lastConfirmAt >= CONFIRM_EVERY_MS) {
    queue = channels.filter(m => {
      const r = results.get(m.id);
      if (!r) return false;
      if (r.failStreak > 0) return r.failStreak < FAILS_TO_HIDE && now - r.lastFailAt >= CONFIRM_AFTER_MS;
      return r.count === 0 && r.zeroStreak === 1 && now - r.at >= CONFIRM_AFTER_MS;
    });
    if (!queue.length) return;
    state.lastConfirmAt = now;
  } else {
    return;
  }

  state.running = true;
  const startedAt = Date.now();
  (async () => {
    let checked = 0;
    let unknown = 0;
    for (const m of queue) {
      try {
        record(m.id, await countStreams(m));
        checked++;
      } catch (err) {
        // Unknown: keep what we knew, and never hide on it -- except that a
        // check on which every source failed is counted toward FAILS_TO_HIDE.
        if (err && err.allFailed) recordFailure(m.id);
        unknown++;
      }
      await sleep(GAP_MS);
    }
    state.checked = checked;
    state.unknown = unknown;
  })().catch(() => {}).finally(() => {
    state.running = false;
    state.lastRunMs = Date.now() - startedAt;
    // Forget channels no longer listed, so the map does not grow without end.
    // Only after a full sweep: a confirmation pass sees a handful of channels.
    if (full) {
      const listed = new Set(queue.map(m => m.id));
      for (const id of results.keys()) if (!listed.has(id)) results.delete(id);
      state.lastSweepDoneAt = Date.now();
    }
    save();
  });
}

/** A snapshot for the stats endpoint. */
function status() {
  let hidden = 0;
  let pending = 0;
  for (const [id, r] of results) {
    if (isDead(id)) hidden++;
    else if ((r.count === 0 && r.zeroStreak === 1) || r.failStreak > 0) pending++;
  }
  return { enabled: ENABLED, ...state, known: results.size, hidden, awaitingConfirmation: pending };
}

module.exports = { sweep, isDead, record, recordFailure, status };
