/**
 * Render the catalog's cards before anyone asks for them.
 *
 * A card costs about 56 ms to rasterise. A tab holds hundreds, so the first
 * visit after a restart rendered them all at once and pegged both cores of the
 * host; the second visit cost nothing, because by then they were cached. The
 * work is not the problem, the burst is.
 *
 * So the same work happens here instead: one card at a time with a pause
 * between them, once the catalog has settled. The burst becomes a trickle the
 * host does not notice, and by the time anyone opens a tab the cards are made.
 *
 * The warmer asks the server for its own poster URLs over loopback rather than
 * building the SVGs itself. Going through the routes is the only way to be sure
 * a warmed card is keyed exactly as a requested one -- a warmer with its own
 * copy of the drawing code would fill a cache the routes then miss, and the
 * mistake would be invisible except as CPU that never went down.
 *
 * Modelled on AIOMetadata's warmers where they fit a live catalog:
 *   - warm exactly the URLs players are handed -- posters, and the wide
 *     backgrounds Nuvio on a TV shows in its rows, which were never warmed;
 *   - skip what is already made, so a second pass over an unchanged catalog
 *     costs lookups, not renders;
 *   - back off when the event loop lags or a player is loading artwork;
 *   - run straight after the cache is cleared, after each catalog re-sync, and
 *     on a cycle anchored on the last run.
 * It stays strictly serial: this host has two cores and a card is real CPU.
 */

const { request } = require('undici');
const { monitorEventLoopDelay } = require('perf_hooks');
const { PORT } = require('../config');
const imageService = require('./ImageService');

// One card at a time, with a gap. Measured at a 120 ms gap this held the host
// at 45% of a core and touched 76%, because a cold pass also downloads the
// crests each card is drawn from, not just the drawing. 250 ms roughly halves
// that. The gap doubles, up to two seconds, while the event loop lags.
const GAP_MS = Number(process.env.WARM_GAP_MS) || 250;
const MAX_GAP_MS = 2000;
const TARGET_LAG_MS = 20;

// Stop rather than churn: past the card cache's own capacity (4500, in
// ImageService), warming would evict what it had just made and the queue would
// never converge. Every tab's posters and backgrounds come to about 2600.
const MAX_CARDS = 4000;

const REQUEST_TIMEOUT_MS = 15000;

// A player fetched artwork this recently: wait before the next card.
const CLIENT_BUSY_WINDOW_MS = 2000;

// A re-sync this soon after a finished pass does not start another.
const AFTER_SYNC_MIN_MS = 10 * 60 * 1000;

const WARMER_UA = 'live-sports-warmer';

const state = {
  running: false,
  done: 0,
  skipped: 0,
  total: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastRunMs: null,
  cancelled: false,
  reason: null,
  gapMs: GAP_MS,
  lagP95Ms: null,
  rerun: false
};

let current = null;       // the run in progress, as a promise of its status
let lastClientAt = 0;
let scheduleTimer = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A snapshot for the dashboard. */
function status() {
  return {
    ...state,
    percent: state.total ? Math.round((100 * state.done) / state.total) : null
  };
}

function cancel() {
  if (state.running) state.cancelled = true;
}

/** Called by the artwork routes for every request that is not the warmer's. */
function noteClient() {
  lastClientAt = Date.now();
}

/**
 * The queue: the top of every tab before the bottom of any, posters with their
 * backgrounds, corner logos last. Deduplicated and capped.
 */
function buildQueue(collected) {
  const perCatalog = (collected && collected.perCatalog) || [];
  const seen = new Set();
  const queue = [];
  const push = u => {
    if (u && !seen.has(u) && queue.length < MAX_CARDS) {
      seen.add(u);
      queue.push(u);
    }
  };
  const longest = perCatalog.reduce((n, p) => Math.max(n, p.cards.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const p of perCatalog) (p.cards[i] || []).forEach(push);
  }
  for (const p of perCatalog) p.logos.forEach(push);
  return queue;
}

/** Already made: a finished card, or for /img a fresh copy of its image. */
function alreadyFresh(u) {
  try {
    const { pathname, search, searchParams } = new URL(u);
    if (pathname === '/img') return imageService.hasFreshImage(searchParams.get('url'));
    return imageService.hasFreshCard(pathname + search);
  } catch {
    return false;
  }
}

async function run(collectUrls, reason) {
  Object.assign(state, {
    running: true, cancelled: false, rerun: false, done: 0, skipped: 0, total: 0, errors: 0,
    lastError: null, startedAt: Date.now(), finishedAt: null, reason, gapMs: GAP_MS, lagP95Ms: null
  });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let gap = GAP_MS;

  try {
    const queue = buildQueue(await collectUrls());
    state.total = queue.length;

    for (const u of queue) {
      if (state.cancelled) break;
      if (alreadyFresh(u)) {
        state.skipped++;
        state.done++;
        continue;
      }
      // A player loading a tab right now comes first.
      if (Date.now() - lastClientAt < CLIENT_BUSY_WINDOW_MS) await sleep(MAX_GAP_MS);
      try {
        // Loopback, so the route's own cache is the one that fills.
        const res = await request(u, {
          headers: { 'User-Agent': WARMER_UA },
          headersTimeout: REQUEST_TIMEOUT_MS,
          bodyTimeout: REQUEST_TIMEOUT_MS
        });
        await res.body.dump();
        state.done++;
      } catch (err) {
        state.errors++;
        state.lastError = err.message;
      }
      const p95 = (lag.percentile(95) || 0) / 1e6;
      lag.reset();
      state.lagP95Ms = Math.round(p95);
      gap = p95 > TARGET_LAG_MS ? Math.min(gap * 2, MAX_GAP_MS) : Math.max(GAP_MS, Math.round(gap / 2));
      state.gapMs = gap;
      await sleep(gap);
    }
  } catch (err) {
    state.lastError = err.message;
    state.errors++;
  } finally {
    lag.disable();
    state.running = false;
    state.finishedAt = Date.now();
    state.lastRunMs = state.finishedAt - state.startedAt;
  }

  return status();
}

/**
 * Warm every catalog's artwork once, slowly. One run at a time: asked while
 * running, it returns the run already going.
 *
 * `collectUrls` is supplied by the caller rather than imported: the catalog
 * module already reaches into this one's siblings, and importing it here would
 * close the cycle.
 */
function warm(collectUrls, reason = 'manual') {
  if (state.running && current) return current;
  current = (async () => {
    let s = await run(collectUrls, reason);
    // Something changed while that pass ran (a re-sync): go round once more.
    while (state.rerun && !state.cancelled) s = await run(collectUrls, 'rerun');
    return s;
  })();
  return current;
}

/** Stop the pass in progress, if any, and start a new one. After a clear. */
async function restart(collectUrls, reason) {
  cancel();
  if (current) await current.catch(() => {});
  return warm(collectUrls, reason);
}

/** A pass because the catalog changed: queued behind one running, debounced. */
function request_(collectUrls, reason) {
  if (state.running) {
    state.rerun = true;
    return current;
  }
  if (reason === 'sync' && state.finishedAt && Date.now() - state.finishedAt < AFTER_SYNC_MIN_MS) {
    return Promise.resolve(status());
  }
  return warm(collectUrls, reason);
}

/** A pass every `intervalMs`, measured from the start of the last one. */
function schedule(collectUrls, intervalMs) {
  clearTimeout(scheduleTimer);
  const tick = () => {
    const since = state.startedAt ? Date.now() - state.startedAt : 0;
    const wait = Math.max(60 * 1000, intervalMs - since);
    scheduleTimer = setTimeout(() => {
      if (!state.running && (!state.startedAt || Date.now() - state.startedAt >= intervalMs)) {
        warm(collectUrls, 'interval');
      }
      tick();
    }, wait);
    if (scheduleTimer.unref) scheduleTimer.unref();
  };
  tick();
}

/**
 * The artwork a catalog hands out, addressed at this server so warming goes
 * through the same routes a client would. Per meta, the poster and the wide
 * background -- a TV row loads the second, a phone the first.
 */
function urlsFrom(metas) {
  const local = `http://127.0.0.1:${PORT}`;
  // Catalog art is minted against the public base URL; warming has to reach
  // this process, not go back out through the internet to find it.
  const here = u => String(u).replace(/^https?:\/\/[^/]+/, local);
  const cards = [];
  const logos = [];
  for (const m of metas || []) {
    const pair = [m.poster, m.background].filter(Boolean).map(here);
    if (pair.length) cards.push(pair);
    if (m.logo) logos.push(here(m.logo));
  }
  return { cards, logos };
}

module.exports = {
  warm, restart, request: request_, schedule, status, cancel, noteClient, urlsFrom,
  GAP_MS, MAX_CARDS, WARMER_UA
};
