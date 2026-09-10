'use strict';

/**
 * HomeAwayService.js
 *
 * Says which side of a fixture is at home, so cards can put the visiting team
 * on the left and the title can read "Away @ Home".
 *
 * The providers don't carry this. Their team1/team2 is just the order the title
 * was written in, and 573 of 673 fixtures separate the sides with "vs", which
 * encodes nothing — the whole of soccer included. Inferring it from the
 * separator gets it wrong on real fixtures: the feed says "Florida A&M Rattlers
 * vs Miami Hurricanes" while ESPN has Miami at home.
 *
 * So this reads ESPN's scoreboards, which state homeAway per competitor, and
 * indexes them by team pair. A fixture ESPN doesn't list falls back to the
 * separator convention rather than blocking the card.
 *
 * The index is refreshed in the background and read synchronously: a catalog
 * build must never wait on ESPN, and a scoreboard that fails to load costs
 * orientation, never the catalog.
 */

const { request } = require('undici');

const HOST = 'https://site.web.api.espn.com/apis/site/v2/sports';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 6000;
// ESPN truncates at whatever `limit` says, but only up to a point: 400 returns
// exactly 400 for a busy soccer week, 1000 returns the real 897, and 2000
// returns 25 — the parameter stops being honoured and the response goes wrong.
const REQUEST_LIMIT = 1000;
const TTL_MS = 20 * 60 * 1000;         // scoreboards move slowly; fixtures don't swap venues
const COLD_WAIT_MS = 4000;             // most a first request will wait on a cold index
const STALE_SERVE_MS = 6 * 60 * 60 * 1000; // keep serving a stale index this long if ESPN is down

// Which ESPN scoreboards answer for a given addon category. Ordering is not
// significant — a fixture is looked up by team pair, so an event from the wrong
// board simply never matches.
const CATEGORY_BOARDS = {
  american_football: ['football/nfl', 'football/college-football', 'football/cfl', 'australian-football/afl'],
  football: ['soccer/all'],
  basketball: ['basketball/nba', 'basketball/wnba', 'basketball/mens-college-basketball'],
  baseball: ['baseball/mlb', 'baseball/college-baseball'],
  hockey: ['hockey/nhl'],
  college: ['football/college-football', 'basketball/mens-college-basketball', 'baseball/college-baseball']
};

const ALL_BOARDS = [...new Set(Object.values(CATEGORY_BOARDS).flat())];

// pair key -> normalized name of whichever side is at home
let index = new Map();
let fetchedAt = 0;
let inFlight = null;
let lastStats = null;

// Shared with TeamLogoService rather than copied: provider names and ESPN names
// only meet if both sides normalize identically, and two copies would drift.
const { normalize } = require('./TeamLogoService');

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** UTC calendar day of an ISO timestamp, as YYYYMMDD. */
function dayOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * A crest URL reduced to league + file, so ESPN's two spellings of the same
 * asset agree: the scoreboard serves .../teamlogos/nfl/500/scoreboard/lar.png
 * while the bundled table has .../teamlogos/nfl/500/lar.png. Both give nfl/lar.
 *
 * Matching on this rather than on names is what makes the alias problem go
 * away: the feed's "Los Angeles FC" and ESPN's "LAFC" never agree as strings,
 * but both resolve to the same crest.
 */
function logoKey(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/\/teamlogos\/([^/]+)\/\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : '';
}

/**
 * Every name a team might be written under. The providers are not consistent
 * with ESPN — "Miami" for "Miami Hurricanes", "Bodø/Glimt" for "Bodo/Glimt" —
 * and indexing each variant against each of the opponent's costs a few hundred
 * keys per board while turning most near-misses into hits.
 */
function nameVariants(team) {
  if (!team) return [];
  const out = new Set();
  for (const field of [team.displayName, team.shortDisplayName, team.name, team.nickname, team.location, team.abbreviation]) {
    const n = normalize(field);
    if (n.length >= 2) out.add(n);
  }
  return [...out];
}

// The catalog lists fixtures up to ~10 weeks ahead, so orientation has to cover
// that whole horizon: a window of a few days left two thirds of soccer guessing.
const HORIZON_DAYS = 70;
const NEAR_DAYS = 9;         // dense enough to need one request per day
const FAR_CHUNK = 5;         // sparse out here, but kept under the response cap
const SPARSE_CHUNK = 14;     // boards that never approach the response cap

// soccer/all carries an order of magnitude more events than any other board and
// is the only one that hits ESPN's response cap; the rest are fetched in wider
// chunks because they never come close.
const DENSE_BOARDS = new Set(['soccer/all']);

function stampFor(now, offsetDays) {
  const d = new Date(now + offsetDays * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The requests a refresh makes.
 *
 * Per-day for the busy near window on dense boards, because ESPN caps a
 * response at `limit` and silently drops the overflow — soccer/all over six
 * days returns 400 as one range but 914 fetched a day at a time, and every
 * dropped event is a fixture that falls back to a guess.
 */
function plan(now) {
  const jobs = [];
  for (const board of ALL_BOARDS) {
    if (DENSE_BOARDS.has(board)) {
      for (let i = -1; i <= NEAR_DAYS; i++) jobs.push({ board, dates: stampFor(now, i) });
      for (let s = NEAR_DAYS + 1; s <= HORIZON_DAYS; s += FAR_CHUNK) {
        jobs.push({ board, dates: `${stampFor(now, s)}-${stampFor(now, Math.min(s + FAR_CHUNK - 1, HORIZON_DAYS))}` });
      }
    } else {
      for (let s = -1; s <= HORIZON_DAYS; s += SPARSE_CHUNK) {
        jobs.push({ board, dates: `${stampFor(now, s)}-${stampFor(now, Math.min(s + SPARSE_CHUNK - 1, HORIZON_DAYS))}` });
      }
    }
  }
  return jobs;
}

/** Cap concurrent requests so a refresh doesn't open 60+ sockets at once. */
async function pool(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]).then(
        v => ({ status: 'fulfilled', value: v }),
        e => ({ status: 'rejected', reason: e })
      );
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchBoard(board, dates) {
  const url = `${HOST}/${board}/scoreboard?dates=${dates}&limit=${REQUEST_LIMIT}`;
  const res = await request(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout: FETCH_TIMEOUT_MS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 1000)
  });
  if (res.statusCode === 404) {
    // ESPN answers 404 for a board with no events on that date (an off-season
    // league). That is an empty day, not a failure.
    res.body.dump();
    return [];
  }
  if (res.statusCode !== 200) {
    res.body.dump();
    throw new Error(`${board}: HTTP ${res.statusCode}`);
  }
  const json = await res.body.json();
  return Array.isArray(json?.events) ? json.events : [];
}

function addEvent(map, event, board) {
  const comp = event?.competitions?.[0];
  const competitors = comp?.competitors;
  if (!Array.isArray(competitors) || competitors.length !== 2) return 0;

  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return 0;

  // Neutral sites are NOT skipped. ESPN still designates a home side there and
  // names the event "A at B" accordingly — dropping them lost every such
  // fixture, including a regular-season NFL game ESPN flags neutralSite.
  // "@" in a listing means the designated visitor, not the deed to the stadium.

  // Board and day are part of every key, and both are load-bearing.
  //
  // Without the day, the two legs of a tie share one key and the first one
  // indexed decides both — so the return fixture is served the exact inverse of
  // its true orientation. Any home-and-home pair inside the horizon does this.
  //
  // Without the board, the same two universities meeting in another sport share
  // a key too: Tennessee host Vanderbilt at basketball, Vanderbilt host
  // Tennessee at baseball, and whichever is indexed first speaks for both.
  const day = dayOf(event.date);
  if (!day) return 0;
  const scope = `${board}:${day}`;
  let added = 0;

  // Crest pair first — the strongest key, since both sides of the comparison
  // come from the same ESPN asset namespace.
  const hLogo = logoKey(home.team && home.team.logo);
  const aLogo = logoKey(away.team && away.team.logo);
  if (hLogo && aLogo && hLogo !== aLogo) {
    const key = `L:${scope}:${pairKey(hLogo, aLogo)}`;
    if (!map.has(key)) { map.set(key, hLogo); added++; }
  }

  const homeNames = nameVariants(home.team);
  const awayNames = nameVariants(away.team);
  for (const h of homeNames) {
    for (const a of awayNames) {
      if (h === a) continue;
      const key = `N:${scope}:${pairKey(h, a)}`;
      // Within one board on one day, a duplicate really is the same event.
      if (!map.has(key)) { map.set(key, h); added++; }
    }
  }
  return added;
}

async function rebuild() {
  const jobs = plan(Date.now());
  const results = await pool(jobs, 8, ({ board, dates }) => fetchBoard(board, dates));
  const next = new Map();
  const stats = { requests: jobs.length, ok: 0, failed: [], events: 0, keys: 0, capped: [] };

  results.forEach((r, i) => {
    if (!r || r.status !== 'fulfilled') { stats.failed.push(`${jobs[i].board}@${jobs[i].dates}`); return; }
    stats.ok++;
    // A response exactly at the cap means ESPN truncated it and this window
    // needs splitting further. Recorded rather than guessed at.
    if (r.value.length >= REQUEST_LIMIT) stats.capped.push(`${jobs[i].board}@${jobs[i].dates}`);
    for (const ev of r.value) {
      stats.events++;
      stats.keys += addEvent(next, ev, jobs[i].board);
    }
  });

  // Every request failing means ESPN or egress is down, not that fixtures lost
  // their venues — keep whatever the last good index was.
  if (!stats.ok && index.size) return lastStats;
  index = next;
  fetchedAt = Date.now();
  lastStats = stats;
  return stats;
}

/**
 * Refresh if stale. Awaited by the catalog handler, but only ever blocks on a
 * cold start: once an index exists, a stale one is served while the refresh
 * runs behind it.
 */
async function ensureFresh() {
  const age = Date.now() - fetchedAt;
  if (index.size && age < TTL_MS) return;

  if (!inFlight) {
    inFlight = rebuild()
      .catch(() => null)
      .finally(() => { inFlight = null; });
  }
  if (!index.size) {
    // Cold, with nothing to serve: wait, but not indefinitely. A slow ESPN
    // costs this request its orientation, never its catalog. index.js primes
    // the index at boot so this path is rarely taken in practice.
    await Promise.race([inFlight, new Promise(r => setTimeout(r, COLD_WAIT_MS))]);
  }
}

/**
 * Orientation for a fixture, or null when ESPN doesn't list it.
 *
 * Scoped to the boards that answer for this category and to the fixture's own
 * day (±1, since the provider's clock and ESPN's can straddle midnight). Both
 * are what keep a second meeting between the same two teams from inheriting the
 * first meeting's answer.
 *
 * Crest URLs are tried before names: the feed's team names and ESPN's rarely
 * agree letter-for-letter, but a resolved crest is the same asset on both
 * sides.
 *
 * Returns { away, home } as the caller's own strings, not normalized ones.
 */
function orient(a, b, aLogo = null, bLogo = null, category = null, dateMs = null) {
  if (!a || !b || !index.size) return null;
  if (Date.now() - fetchedAt > STALE_SERVE_MS) return null;

  const t = Number(dateMs);
  // No date means no safe key: an undated fixture could be either leg of a tie,
  // and guessing between them is the failure this scoping exists to prevent.
  if (!Number.isFinite(t) || t <= 0) return null;

  // A category with no scoreboard has no evidence to offer, and searching every
  // board for it would only invite a cross-sport coincidence — a boxing card
  // matching two universities' names. Better to decline and let the caller fall
  // back to the title.
  const boards = CATEGORY_BOARDS[category];
  if (!boards) return null;
  const days = [0, -1, 1].map(off => {
    const d = new Date(t + off * 86400000);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  });

  const la = logoKey(aLogo);
  const lb = logoKey(bLogo);
  const na = normalize(a);
  const nb = normalize(b);
  const logoPair = la && lb && la !== lb ? pairKey(la, lb) : null;
  const namePair = na && nb && na !== nb ? pairKey(na, nb) : null;
  if (!logoPair && !namePair) return null;

  for (const board of boards) {
    for (const day of days) {
      const scope = `${board}:${day}`;
      if (logoPair) {
        const homeLogo = index.get(`L:${scope}:${logoPair}`);
        if (homeLogo === la) return { away: b, home: a };
        if (homeLogo === lb) return { away: a, home: b };
      }
      if (namePair) {
        const homeName = index.get(`N:${scope}:${namePair}`);
        if (homeName === na) return { away: b, home: a };
        if (homeName === nb) return { away: a, home: b };
      }
    }
  }
  return null;
}

function stats() {
  return { size: index.size, ageMs: fetchedAt ? Date.now() - fetchedAt : null, last: lastStats };
}

module.exports = { ensureFresh, orient, stats, normalize, _rebuild: rebuild };
