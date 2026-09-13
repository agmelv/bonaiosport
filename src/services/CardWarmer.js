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
 */

const { request } = require('undici');
const { PORT } = require('../config');

// One card at a time, with a gap. Measured at a 120 ms gap this held the host
// at 45% of a core and touched 76%, because a cold pass also downloads the
// crests each card is drawn from, not just the drawing. 250 ms roughly halves
// that. The queue then takes several minutes, which costs nobody anything --
// the whole point is that no one is waiting on it.
const GAP_MS = Number(process.env.WARM_GAP_MS) || 250;

// Stop rather than churn: past the card cache's own capacity (3000, in
// ImageService), warming would evict what it had just made and the queue would
// never converge. A thousand stopped short of the Channels tab, which alone
// holds over seven hundred covers.
const MAX_CARDS = 2500;

const REQUEST_TIMEOUT_MS = 15000;

const state = {
  running: false,
  done: 0,
  total: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastRunMs: null,
  cancelled: false
};

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

/**
 * Fetch every catalog poster once, slowly.
 *
 * `collectUrls` is supplied by the caller rather than imported: the catalog
 * module already reaches into this one's siblings, and importing it here would
 * close the cycle.
 */
async function warm(collectUrls) {
  if (state.running) return status();

  Object.assign(state, {
    running: true, cancelled: false, done: 0, total: 0, errors: 0,
    lastError: null, startedAt: Date.now(), finishedAt: null
  });

  try {
    const collected = await collectUrls();
    const urls = [...new Set([...collected.posters, ...collected.logos].filter(Boolean))];
    state.total = Math.min(urls.length, MAX_CARDS);

    for (let i = 0; i < state.total; i++) {
      if (state.cancelled) break;
      try {
        // Loopback, so the route's own cache is the one that fills. A card the
        // cache already holds costs a lookup and nothing else, which makes a
        // second warm over an unchanged catalog nearly free.
        const res = await request(urls[i], {
          headers: { 'User-Agent': 'live-sports-warmer' },
          headersTimeout: REQUEST_TIMEOUT_MS,
          bodyTimeout: REQUEST_TIMEOUT_MS
        });
        await res.body.dump();
        state.done++;
      } catch (err) {
        state.errors++;
        state.lastError = err.message;
      }
      await sleep(GAP_MS);
    }
  } catch (err) {
    state.lastError = err.message;
    state.errors++;
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
    state.lastRunMs = state.finishedAt - state.startedAt;
  }

  return status();
}

/**
 * The posters a catalog would show, addressed at this server so warming goes
 * through the same routes a client would.
 */
function urlsFrom(metas) {
  const local = `http://127.0.0.1:${PORT}`;
  // Catalog art is minted against the public base URL; warming has to reach
  // this process, not go back out through the internet to find it.
  const here = u => String(u).replace(/^https?:\/\/[^/]+/, local);
  // Posters first, every one of them, before any corner badge. The queue is
  // capped, and a poster is the whole card a viewer waits on where a badge is a
  // small image that is usually already cached from the card that drew it.
  const posters = [];
  const logos = [];
  for (const m of metas || []) {
    if (m.poster) posters.push(here(m.poster));
    if (m.logo) logos.push(here(m.logo));
  }
  return { posters, logos };
}

module.exports = { warm, status, cancel, urlsFrom, GAP_MS, MAX_CARDS };
