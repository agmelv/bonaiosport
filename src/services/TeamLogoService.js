/**
 * TeamLogoService.js
 *
 * Resolves the two sides of a fixture title to ESPN team logo URLs, so catalog
 * cards can show real artwork instead of a generated placeholder.
 *
 * Backed by a bundled table (data/espn-teams.json) generated from ESPN's public
 * team endpoints by scripts/build-espn-teams.js. It is a static file on purpose:
 * ESPN's site.api host 403s from some egress IPs, and a boot-time fetch would
 * make catalog artwork depend on that. Regenerate it when schools/teams change.
 *
 * Matching is deliberately conservative. A wrong logo is worse than no logo —
 * a card that confidently shows Oklahoma State for a Northwestern Oklahoma State
 * game is more misleading than one that shows the team names as text. Every rule
 * below exists to make a near-miss decline instead of guess:
 *
 *   1. exact normalized match      "los angeles rams"
 *   2. exact de-spaced match       "ottawaredblacks" -> ESPN's "Ottawa Red Blacks"
 *   3. whole-word run, >=2 words, covering >=75% of the side's words
 *
 * Bare single-word nicknames ("bombers", "argonauts", "tigers") are never used
 * as a fallback key: they collide across leagues and divisions.
 */

const TEAMS = require('./data/espn-teams.json');

// Which ESPN leagues to consult for a given addon category, in priority order.
// Ordering matters: "kansas city chiefs" must hit the NFL before the
// college-football table gets a chance at "kansas".
const CATEGORY_LEAGUES = {
  // AFL last: the providers file Australian rules under american_football, but
  // a bare "richmond" in that feed is the Spiders far more often than the
  // Tigers. resolveMatchup() still finds the Tigers when the opponent is AFL.
  american_football: ['nfl', 'cfl', 'college-football', 'afl'],
  basketball: ['nba', 'wnba', 'mens-college-basketball'],
  baseball: ['mlb'],
  hockey: ['nhl', 'mens-college-hockey', 'womens-college-hockey'],
  football: ['soccer'],
  college: ['college-football', 'mens-college-basketball', 'mens-college-hockey']
};

// Youth and reserve sides carry the senior badge, so "England U21" resolves
// through "england". Applies to clubs too ("Chelsea U21" -> Chelsea's crest).
const AGE_GROUP = /\s+u\s?(1[5-9]|2[0-3])$/;

// Club-type affixes carry no identity: the providers say "Seattle Sounders"
// where ESPN says "Seattle Sounders FC". The builder indexes stripped variants
// too; this is the query-side half. Kept in sync with scripts/build-espn-teams.js.
const AFFIX = /^(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if)\s+|\s+(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if|ii)$/;

function stripAffix(k) {
  let prev;
  let cur = k;
  while (cur !== prev) { prev = cur; cur = cur.replace(AFFIX, '').trim(); }
  return cur;
}

// National sides where the scrape providers and ESPN simply use different
// names for the same country. Only unambiguous, well-known equivalences.
const ALIASES = {
  'czech republic': 'czechia',
  'ireland': 'republic of ireland',
  'turkey': 'turkiye',
  'bosnia': 'bosnia herzegovina',
  'bosnia and herzegovina': 'bosnia herzegovina',
  'usa': 'united states',
  'united states of america': 'united states',
  'uae': 'united arab emirates',
  'ivory coast': 'cote divoire',
  'holland': 'netherlands',
  'china pr': 'china',
  'iran': 'ir iran',
  // Clubs ESPN files under a sponsor/brand name.
  'los angeles fc': 'lafc',
  'new york red bulls': 'red bull new york',
  'operario ferroviario': 'operario pr'
};

const ALL_LEAGUES = Object.keys(TEAMS);

// " vs ", " at ", " - " and friends, longest/most specific first so " vs. "
// is not consumed by the bare " v " rule.
const SEPARATORS = [' vs. ', ' vs ', ' v. ', ' v ', ' at ', ' @ ', ' - ', '—', '–'];

// Leading decoration the providers and the catalog layer add to titles.
const TITLE_PREFIX = /^(?:\s|[^\p{L}\p{N}]|live:|live|24\/7)+/iu;

const MIN_COVERAGE = 0.75;

const cache = new Map();
const CACHE_MAX = 2000;

function normalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')   // possessives: "ragin' cajuns" -> "ragin cajuns"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split "A vs B" / "A at B" into its two sides. Returns null if there is no fixture split. */
function splitSides(title) {
  if (!title || typeof title !== 'string') return null;
  const t = title.replace(TITLE_PREFIX, '');
  for (const sep of SEPARATORS) {
    const i = t.toLowerCase().indexOf(sep);
    if (i > 0) {
      const a = t.slice(0, i).trim();
      const b = t.slice(i + sep.length).trim();
      if (a && b) return [a, b];
    }
  }
  return null;
}

function leaguesFor(category) {
  const named = CATEGORY_LEAGUES[category];
  if (named) return named;
  return ALL_LEAGUES;
}

/**
 * Resolve one side of a fixture to a logo URL, or null.
 * Returns null rather than guessing whenever confidence is low.
 */
function lookupTeam(side, category, leaguesOverride = null) {
  const key = normalize(side);
  if (!key || key.length < 2) return null;

  const leagues = leaguesOverride || leaguesFor(category);
  const cacheKey = `${leagues.join(',')}|${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  // Each retry loosens one specific, identity-preserving difference. None of
  // them widen what counts as a match, so a near-miss still declines.
  let result = resolve(key, leagues);
  if (!result && ALIASES[key]) result = resolve(ALIASES[key], leagues);
  if (!result) {
    const bare = stripAffix(key);
    if (bare && bare !== key && bare.length >= 4) result = resolve(bare, leagues);
  }
  if (!result && AGE_GROUP.test(key)) {
    const senior = key.replace(AGE_GROUP, '');
    result = resolve(senior, leagues)
          || (ALIASES[senior] ? resolve(ALIASES[senior], leagues) : null)
          || resolve(stripAffix(senior), leagues);
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

/**
 * Leagues in which `side` is an outright (exact or de-spaced) hit. Used to
 * resolve a fixture jointly: "NC State vs Richmond" has one league in common
 * (college-football), so Richmond is the Spiders there — while "Richmond vs
 * Collingwood" shares only the AFL and gets the Tigers.
 */
function resolvingLeagues(side, leagues) {
  const key = normalize(side);
  if (!key || key.length < 2) return [];
  const variants = new Set([key]);
  if (ALIASES[key]) variants.add(ALIASES[key]);
  const bare = stripAffix(key);
  if (bare && bare.length >= 4) variants.add(bare);
  const out = [];
  for (const lg of leagues) {
    const map = TEAMS[lg];
    if (!map) continue;
    for (const v of variants) {
      const squashed = '~' + v.replace(/ /g, '');
      if (Object.prototype.hasOwnProperty.call(map, v) ||
          (squashed.length >= 7 && Object.prototype.hasOwnProperty.call(map, squashed))) {
        out.push(lg);
        break;
      }
    }
  }
  return out;
}

function resolve(key, leagues) {
  // 1. exact
  for (const lg of leagues) {
    const map = TEAMS[lg];
    if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  }

  // 2. de-spaced (the builder stores these under a "~" prefix)
  const squashed = '~' + key.replace(/ /g, '');
  if (squashed.length >= 7) {
    for (const lg of leagues) {
      const map = TEAMS[lg];
      if (map && Object.prototype.hasOwnProperty.call(map, squashed)) return map[squashed];
    }
  }

  // 3. multi-word whole-word run covering most of the side
  const sideWords = key.split(' ').length;
  const padded = ` ${key} `;
  for (const lg of leagues) {
    const map = TEAMS[lg];
    if (!map) continue;
    let best = null;
    let bestWords = 0;
    for (const k in map) {
      if (k.charCodeAt(0) === 126) continue;          // skip "~" de-spaced entries
      const w = k.split(' ').length;
      if (w < 2 || w <= bestWords) continue;
      if (w / sideWords < MIN_COVERAGE) continue;
      if (padded.indexOf(` ${k} `) !== -1) { best = map[k]; bestWords = w; }
    }
    if (best) return best;
  }

  return null;
}

function providedLogo(team) {
  if (!team || !team.logo || typeof team.logo !== 'string') return null;
  const u = team.logo.trim();
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  return /^https?:\/\//i.test(u) ? u : null;
}

/**
 * Resolve both sides of a match.
 *
 * Prefers the structured team names the provider supplied and falls back to
 * splitting the title, which is all most providers give us.
 *
 * Each side gets an ordered list of candidate crest URLs rather than a single
 * guess, because a URL's existence can only be known by fetching it and that
 * happens later, in /img/matchup. The bundled ESPN table comes first: its URLs
 * are stable CDN paths. A provider's own logo URL comes second — one feed
 * hands out image-proxy links that have all gone dead, and treating those as
 * authoritative is what produced crest cards with no crests on them.
 *
 * The two sides are resolved jointly. When both are outright hits in a common
 * league, both are looked up in that league only, so a name that exists in two
 * leagues of the same category ("richmond": NCAA Spiders, AFL Tigers) follows
 * its opponent.
 *
 * Returns { a, b, aLogos, bLogos, aLogo, bLogo } where a/b are display names
 * (always present when the title splits), aLogos/bLogos are the candidate
 * lists (possibly empty) and aLogo/bLogo are their first entries or null.
 */
function resolveMatchup(match) {
  if (!match) return null;

  let a = match.team1 && match.team1.name ? String(match.team1.name).trim() : null;
  let b = match.team2 && match.team2.name ? String(match.team2.name).trim() : null;

  if (!a || !b) {
    const sides = splitSides(match.title);
    if (!sides) return null;
    a = a || sides[0];
    b = b || sides[1];
  }

  const leagues = leaguesFor(match.category);
  const inA = resolvingLeagues(a, leagues);
  const inB = resolvingLeagues(b, leagues);
  const common = leagues.filter(lg => inA.includes(lg) && inB.includes(lg));
  const scope = common.length ? common : null;

  const dedupe = list => [...new Set(list.filter(Boolean))];
  const aLogos = dedupe([lookupTeam(a, match.category, scope), providedLogo(match.team1)]);
  const bLogos = dedupe([lookupTeam(b, match.category, scope), providedLogo(match.team2)]);

  return {
    a,
    b,
    aLogos,
    bLogos,
    aLogo: aLogos[0] || null,
    bLogo: bLogos[0] || null
  };
}

module.exports = {
  resolveMatchup,
  resolvingLeagues,
  lookupTeam,
  splitSides,
  normalize,
  CATEGORY_LEAGUES
};
