/**
 * One genre vocabulary for 24/7 channels, whichever source listed them.
 *
 * Every channel source files its channels differently -- USA TV Next says
 * "Premium" and "Documentaries", TimStreams says "Cartoons" and
 * "News/Politics", iptv-org says "general" -- and with several hundred channels
 * in one tab the tab needs a single set of groups to sort into and to filter by.
 */

// The order groups appear in the Channels tab, and the options a player offers.
const GENRES = [
  'Sports', 'News', 'Local', 'Entertainment', 'Movies',
  'Kids', 'Documentary', 'Music', 'Lifestyle', 'International'
];

// When two sources list the same channel under different genres, the more
// specific one wins. Entertainment is last because every source uses it as the
// catch-all; Sports is first because this is a sports addon.
const SPECIFICITY = [
  'Sports', 'News', 'Kids', 'Movies', 'Documentary',
  'Music', 'Lifestyle', 'Local', 'International', 'Entertainment'
];

const FROM_SOURCE = {
  sports: 'Sports',
  news: 'News', 'news/politics': 'News', politics: 'News', weather: 'News',
  local: 'Local', general: 'Local',
  entertainment: 'Entertainment', series: 'Entertainment', comedy: 'Entertainment',
  premium: 'Movies', movies: 'Movies',
  kids: 'Kids', cartoons: 'Kids', animation: 'Kids', family: 'Kids',
  documentaries: 'Documentary', documentary: 'Documentary', education: 'Documentary', science: 'Documentary',
  music: 'Music',
  lifestyle: 'Lifestyle', cooking: 'Lifestyle', travel: 'Lifestyle', shop: 'Lifestyle',
  latino: 'International', international: 'International'
};

/** A source's own genre label, as one of GENRES, or null when it has no mapping. */
function normalizeGenre(raw) {
  if (!raw) return null;
  return FROM_SOURCE[String(raw).trim().toLowerCase()] || null;
}

const SPORT_WORDS = /\b(sports?|espn\w*|fs[12]|nfl|nba|mlb|nhl|golf|tennis|ufc|fight|racing|motogp|f1|cricket|willow|rugby|dazn|bein|premier|laliga|serie a|bundesliga|redzone|big ten|acc network|sec network|sportsnet|tsn|eleven|arena|nbc sports|cbs sports)\b/i;
const NEWS_WORDS = /\b(news|cnn|msnbc|cnbc|bloomberg|c-span|weather|hln|newsmax)\b/i;
const KIDS_WORDS = /\b(kids?|junior|jr|nick\w*|cartoon|disney|boomerang|cbeebies|teen ?nick|pbs kids)\b/i;

/**
 * The genre a channel's name gives away. For channels whose source sent no
 * genre (the few 24/7 listings from event feeds, and channels added by hand),
 * so they sort with their peers instead of collecting at the bottom.
 */
function inferGenre(title) {
  const t = String(title || '');
  if (SPORT_WORDS.test(t)) return 'Sports';
  if (NEWS_WORDS.test(t)) return 'News';
  if (KIDS_WORDS.test(t)) return 'Kids';
  return 'Entertainment';
}

/** The genre that should win when two sources disagree. */
function moreSpecific(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return SPECIFICITY.indexOf(a) <= SPECIFICITY.indexOf(b) ? a : b;
}

/** Where a genre sorts in the tab; unknown genres go last. */
function genreOrder(g) {
  const i = GENRES.indexOf(g);
  return i === -1 ? GENRES.length : i;
}

module.exports = { GENRES, normalizeGenre, inferGenre, moreSpecific, genreOrder };
