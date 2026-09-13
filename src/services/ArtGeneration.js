/**
 * ArtGeneration.js — the generation every artwork URL carries.
 *
 * Players keep images by URL. A card redrawn on the server under the same URL
 * is a card nobody sees: the phone and the TV already hold a copy and have no
 * reason to ask again. Emptying the server's caches changed nothing on either,
 * which is exactly what an owner saw after pressing Clear. So every generated
 * card URL carries a generation, and clearing the cache mints a new one. The
 * next catalog a player reads names every card by a new address, and the old
 * copies are simply never asked for again.
 *
 * Kept in DATA_DIR, so a restart does not retire every player's artwork. A
 * timestamp rather than a counter: a container rebuilt without its volume mints
 * a token nobody has seen, instead of reusing a small number some device still
 * holds cards under.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let dir = require('../config').DATA_DIR;

// Two clicks in quick succession retire every player's artwork once, not twice.
const BUMP_MIN_INTERVAL_MS = 30 * 1000;

let state = null;

const file = () => path.join(dir, 'art-generation.json');
const mint = () => Date.now().toString(36);

function persist() {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      generation: state.generation, bumpedAt: state.bumpedAt, reason: state.reason
    }));
    fs.renameSync(tmp, file());
    state.persisted = true;
  } catch (err) {
    // Said once. Without a writable volume every restart mints a new token,
    // which costs players one re-download of their artwork per restart.
    if (state.persisted !== false) console.warn(`[art] generation not persisted: ${err.message}`);
    state.persisted = false;
  }
}

function load() {
  if (state) return state;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (saved && /^[0-9a-z]{4,16}$/.test(String(saved.generation))) {
      state = {
        generation: String(saved.generation),
        bumpedAt: Number(saved.bumpedAt) || null,
        reason: saved.reason || null,
        persisted: true
      };
      return state;
    }
  } catch { /* first run, or unreadable: a new one below */ }
  state = { generation: mint(), bumpedAt: null, reason: 'first run', persisted: null };
  persist();
  return state;
}

/** The current generation token. */
function get() {
  return load().generation;
}

/** For the dashboard. */
function info() {
  const s = load();
  return { generation: s.generation, bumpedAt: s.bumpedAt, reason: s.reason, persisted: !!s.persisted };
}

/**
 * A new generation, unless the same clear minted one in the last 30 seconds.
 * A different clear straight after ("cards", then "everything") still mints:
 * it may change what the cards draw.
 */
function bump(reason = 'manual') {
  const s = load();
  if (s.bumpedAt && Date.now() - s.bumpedAt < BUMP_MIN_INTERVAL_MS && s.reason === String(reason)) {
    return { bumped: false, generation: s.generation };
  }
  let next = mint();
  if (next === s.generation) next = (Date.now() + 1).toString(36);
  Object.assign(s, { generation: next, bumpedAt: Date.now(), reason: String(reason) });
  persist();
  return { bumped: true, generation: s.generation };
}

function _setDirForTest(d) {
  dir = d;
  state = null;
}

module.exports = { get, info, bump, BUMP_MIN_INTERVAL_MS, _setDirForTest };
