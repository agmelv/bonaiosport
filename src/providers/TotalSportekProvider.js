const cheerio = require('cheerio');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');
const { redactUrl } = require('../redact');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// How long after kickoff a fixture is still worth listing. The listing keeps
// finished games on the page indefinitely, so without a window the catalog
// fills with matches that ended days ago and whose players resolve to nothing.
const LIVE_WINDOW_MS = 4 * 60 * 60 * 1000;

// The words the listing's status attribute uses for a game that is over. The
// site leaves finished cards on the page and is right about them in a way a
// clock cannot be, since a game can end early or run long past its window.
const ENDED_STATUSES = new Set(['ended', 'finished', 'ft']);

// How many of a slug's trailing words can be league rather than team. A slug is
// two club names and then, sometimes, the competition -- `...-nba-basketball`,
// `...-england-league-cup-football` -- and three words is enough of that tail to
// name a sport without reaching back into the second club's name.
const LEAGUE_TAIL_WORDS = 3;

// The words that actually name a sport or a competition, and the only ones the
// tail above is read for.
//
// Most slugs have no competition on the end at all, so the tail is simply the
// second club's name -- and club names are full of sports. Matching on
// substrings the way categories are normally matched read the racing in Racing
// de Santander as motor racing and filed a league fixture under it. Note what
// is absent: racing, united, city, athletic, sporting, real. A word that names
// as many clubs as it does sports names neither here.
const LEAGUE_WORDS = new Set([
  'football', 'soccer', 'basketball', 'baseball', 'hockey', 'rugby', 'cricket',
  'tennis', 'golf', 'darts', 'boxing', 'mma', 'ufc', 'wwe', 'nxt', 'aew',
  'nfl', 'nba', 'wnba', 'mlb', 'nhl', 'ncaa', 'mls',
  'f1', 'formula', 'motogp', 'nascar', 'indycar'
]);

// The game pages carry both mirrors, and each one is a whole chain of its own.
// Two is what the site publishes; the cap is here so a page that repeats a link
// a dozen times cannot turn one tile into a dozen resolutions.
const MAX_MIRRORS = 2;

// What normalizeCategory is able to name. It hands back its own cleaned input
// when nothing matches, so a fixture whose slug says only "elche-vs-real-
// oviedo" would otherwise be filed under a category called
// "elchevsrealoviedo" -- a tab of one, in a catalog that has no such sport.
const NAMED_CATEGORIES = new Set([
  'american_football', 'football', 'motorsport', 'mma', 'basketball', 'golf',
  'rugby', 'cricket', 'tennis', 'hockey', 'baseball', 'darts', 'other'
]);

// The two player mirrors, as they are written into the game page.
const PLAYER_LINK = /https?:\/\/(?:bestropes|esportsurge)\.st\/player\.php\/[A-Za-z0-9\-/]+/g;

/**
 * A kickoff from the listing, in epoch milliseconds.
 *
 * The listing writes a bare wall clock with no zone marker on it, and that
 * clock is UTC: the two fixtures this page times at 19:00 and 19:30 are the
 * two ESPN's scoreboard times at 19:00Z and 19:30Z. Read as the server's own
 * local time instead, every fixture lands an hour or more out -- far enough to
 * show under the wrong day and to open its live window at the wrong moment.
 */
function _kickoff(stamp) {
  if (!stamp) return null;
  return parseTimezone(String(stamp).trim(), 'UTC');
}

/**
 * The fixtures on the listing page, finished ones left out.
 *
 * `now` is a parameter rather than a call to the clock so that what counts as
 * finished is decided by the caller and can be asserted.
 */
function _parseListing(html, now = Date.now()) {
  const out = [];
  if (!html) return out;

  let $;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    return out;
  }

  $('a.game-card').each((i, el) => {
    const card = $(el);
    const href = String(card.attr('href') || '');
    const slug = (href.split('/game/')[1] || '').split(/[?#]/)[0].replace(/\/+$/, '');
    if (!slug) return;

    const teams = card.find('.game-team-name')
      .map((j, n) => $(n).text().trim()).get().filter(Boolean);
    if (teams.length < 2) return;

    const timer = card.find('[data-status]').first();
    // The attribute is read in both spellings because the page is generated
    // markup: a parser that lowercases attribute names and one that does not
    // disagree about `dateTime`, and neither is wrong about the page.
    const timeEl = card.find('time').first();
    const stamp = timeEl.attr('datetime') || timeEl.attr('dateTime')
      || [timer.attr('data-start-date'), timer.attr('data-start-time')].filter(Boolean).join('T');
    const kickoff = _kickoff(stamp);
    if (!kickoff) return;

    // The site's own word for the state of a game settles it in both
    // directions: one it still calls live is kept however long ago it started,
    // and one it calls ended is gone whatever the clock makes of its kickoff.
    // Only a card that commits to neither -- "Upcoming", or no status at all --
    // is left to the window below, so a game that has quietly started still
    // reads as live.
    const status = String(timer.attr('data-status') || '').trim().toLowerCase();
    if (ENDED_STATUSES.has(status)) return;

    const flagged = status === 'live';
    if (!flagged && kickoff < now - LIVE_WINDOW_MS) return;

    out.push({
      slug,
      host: (() => { try { return new URL(href).host; } catch (err) { return ''; } })(),
      title: `${teams[0]} vs ${teams[1]}`,
      teams,
      kickoff,
      live: flagged || (kickoff <= now && kickoff > now - LIVE_WINDOW_MS)
    });
  });

  return out;
}

/** Both player mirrors named on a game page, one per host. */
function _playerUrls(html) {
  const byHost = new Map();
  for (const found of String(html || '').match(PLAYER_LINK) || []) {
    const url = found.replace(/\/+$/, '');
    let host;
    try { host = new URL(url).host; } catch (err) { continue; }
    if (!byHost.has(host)) byHost.set(host, url);
    if (byHost.size >= MAX_MIRRORS) break;
  }
  return [...byHost.values()];
}

/**
 * The channel a player page is a window onto, and what it says is playing.
 *
 * Nothing is obfuscated at this hop -- the page states it as JSON -- but the
 * two mirrors answer with different channel ids for the same fixture, so this
 * has to be read per mirror rather than once per game.
 */
function _serverData(html) {
  const found = String(html || '').match(/SERVER_DATA\s*=\s*(\{[\s\S]*?\})\s*[;\n]/);
  if (!found) return null;
  let data;
  try {
    data = JSON.parse(found[1]);
  } catch (err) {
    return null;
  }
  const channel = String(data.u || '').match(/[?&]id=(\d+)/);
  if (!channel) return null;
  let origin = '';
  try { origin = new URL(data.u).origin; } catch (err) { return null; }
  return {
    channelId: channel[1],
    origin,
    league: data.league ? String(data.league) : '',
    sport: data.sport ? String(data.sport) : ''
  };
}

/**
 * A string as the player config's own JavaScript wrote it.
 *
 * The config escapes its ampersands as &, so a URL read up to the first
 * one keeps the path and drops the signature that follows it. What comes back
 * from the CDN then is a 403, which reads exactly like a blocked request and is
 * nothing of the kind.
 */
function _unescape(value) {
  return String(value)
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/');
}

/** The signed playlist URL out of a player model page, whole. */
function _playerSrc(html) {
  const body = String(html || '');
  const at = body.indexOf('PP_CLAPPR_CONFIG');
  if (at === -1) return null;
  // Read forward from the config rather than trying to bracket-match it: the
  // object runs to hundreds of kilobytes and holds nested objects, and a
  // non-greedy match for its closing brace stops at the first inner one.
  const tail = body.slice(at);
  const found = tail.match(/"src"\s*:\s*"([^"]+)"/) || tail.match(/"srcBase"\s*:\s*"([^"]+)"/);
  if (!found) return null;
  const url = _unescape(found[1]);
  return /^https?:\/\//i.test(url) ? url : null;
}

/** When a signed playlist stops being served, from the epoch it carries. */
function _expiresAt(url) {
  const found = String(url || '').match(/[?&]e=(\d{9,})/);
  return found ? Number(found[1]) * 1000 : 0;
}

class TotalSportekProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'TotalSportek';

    // The listing and the game pages are not always on the same domain, and
    // both move. live.totalsporteke.st is deliberately not here: it answers 200
    // with a page that lists no games at all, so a picker that only asks
    // whether a host is up would settle on it and then serve nothing.
    this.hosts = BaseProvider.hostList('TOTALSPORTEK_HOSTS', ['totalsporteki.uno', 'fifatotalsportek.com']);

    // Where the listing's own cards point their game links, which is not the
    // host that served the listing. Kept from the last listing parsed so a
    // rotation is followed without being configured, and defaulted so that a
    // tile opened before the first sync still resolves.
    this.gameHost = 'fifatotalsportek.com';

    this.fetchListing = this.circuitBreaker.wrap(`${this.name}_listing`, async () => {
      const res = await this.fetchFromHosts('/', { headers: { 'User-Agent': UA }, timeoutMs: 12000 });
      return await res.text();
    });

    this.fetchGame = this.circuitBreaker.wrap(`${this.name}_game`, async (url) => {
      return await this._text(url, `https://${this.gameHost}/`);
    });

    this.fetchChannel = this.circuitBreaker.wrap(`${this.name}_channel`, async (url, referer) => {
      const res = await this.proxyFetch(url, {
        headers: { 'User-Agent': UA, 'Referer': referer, 'Accept': 'application/json' },
        timeoutMs: 8000
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    this.fetchModel = this.circuitBreaker.wrap(`${this.name}_model`, async (url, referer) => {
      return await this._text(url, referer);
    });
  }

  /**
   * One page, fetched with a browser's name on it and a deadline.
   *
   * The deadline is `timeoutMs` and not an AbortSignal because proxyFetch
   * forwards the one and not the other, and a chain of five requests with no
   * deadline on them is a viewer watching a spinner.
   */
  async _text(url, referer) {
    const res = await this.proxyFetch(url, {
      headers: { 'User-Agent': UA, 'Referer': referer, 'Accept': 'text/html' },
      timeoutMs: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  /** The best name for a fixture's sport out of everything that mentions one. */
  _categoryFor(...hints) {
    for (const hint of hints) {
      if (!hint) continue;
      const named = this.normalizeCategory(hint);
      if (NAMED_CATEGORIES.has(named)) return named;
    }
    return 'other';
  }

  /**
   * The sport a game slug names, when it names one at all.
   *
   * Only the slug's trailing words are league; everything before them is two
   * club names, and normalizeCategory matches on substrings. Handed the whole
   * slug it reads Racing Club as motor racing and finds 'mma' inside Hammarby,
   * and a fixture in the wrong sport is worse than one in none: the aggregator
   * refuses to merge two rows whose categories disagree, so the same game from
   * a provider that knows its sport sits beside this one as a second row with
   * the streams split between them.
   */
  _categoryForSlug(slug) {
    const words = String(slug || '').replace(/-\d+$/, '').split('-').filter(Boolean);
    const tail = words.slice(-LEAGUE_TAIL_WORDS);
    // Only a tail that says it is a competition is read as one. Everything else
    // is the second club's name, and naming a sport from it is worse than
    // naming none: a fixture nobody could place still merges with the same game
    // from a source that placed it, while one placed wrongly does not -- it
    // stays a second tile with the streams divided between the two.
    if (!tail.some(word => LEAGUE_WORDS.has(word))) return 'other';
    return this._categoryFor(tail.join(' '));
  }

  /**
   * The fixtures, from the listing page and nothing else.
   *
   * The player slug a stream actually sits behind is on the game page rather
   * than the listing, and there are a hundred and ten of those at some 142 KB
   * each. Fetching them here would spend minutes of a two-core host on every
   * sync, for tiles nobody has opened; the whole chain is deferred to
   * resolveStream, which runs only when a viewer picks one.
   */
  async getMatches() {
    const matches = [];
    try {
      const html = await this.fetchListing.fire();
      if (!html) return [];

      const cards = _parseListing(html, Date.now());
      const linked = cards.find(c => c.host);
      if (linked) this.gameHost = linked.host;

      for (const card of cards) {
        matches.push(new MatchEntity({
          id: `tsk_${card.slug}`,
          title: card.title,
          // The listing never says which sport a game is; that arrives with the
          // player page, long after this. The league words at the end of the
          // slug are all there is, and for two club names there are none, so
          // most of these are filed as other until a merge with a provider that
          // knows better.
          category: this._categoryForSlug(card.slug),
          status: card.live ? 'live' : 'upcoming',
          timestamp: card.kickoff,
          popular: card.live ? '1' : '0',
          // Named sides, not bare strings. Everything downstream reads
          // `team1.name` and `team1.logo` -- the crest resolver, the card, the
          // cast list, and the aggregator's own crest identity -- so a string
          // here reads as a side with no name at all. That costs the crests,
          // and with them the identity two providers are merged on, which is
          // the whole reason for carrying this source beside the others.
          // The logo is left for the crest table to answer by name: the
          // listing's own badges are the site's resized copies, served from
          // its own domain.
          team1: { name: card.teams[0], logo: null },
          team2: { name: card.teams[1], logo: null },
          sources: [{ source: 'totalsportek', id: card.slug }]
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Error fetching matches:`, err.message);
    }
    return matches;
  }

  /**
   * The breaker standing in front of one mirror host.
   *
   * bestropes.st and esportsurge.st are unrelated third parties, and the
   * second one exists precisely so that the first going down costs nothing.
   * A breaker named once for the provider would undo that: both hosts would
   * share one rolling window, the dead mirror's failures would count against
   * the healthy one, and once the pooled rate tripped the fallback would hand
   * back null for both -- five minutes of a fixture with no streams at all,
   * while the mirror that was answering all along was never asked. Naming the
   * breaker after the host keeps each mirror's record its own, and since wrap
   * memoizes by name, asking for one here costs nothing after the first call.
   */
  _playerBreaker(playerUrl) {
    let host;
    try { host = new URL(playerUrl).host; } catch (err) { host = 'unknown'; }
    return this.circuitBreaker.wrap(`${this.name}_player_${host}`,
      (url, referer) => this._text(url, referer));
  }

  /**
   * One mirror, from its player page down to a playable link.
   *
   * Everything here is caught: a mirror that fails costs its own row and leaves
   * the other one to answer, which is the whole reason both are resolved.
   */
  async _resolveMirror(playerUrl, gameUrl, index) {
    try {
      const playerHtml = await this._playerBreaker(playerUrl).fire(playerUrl, gameUrl);
      if (!playerHtml) return null;

      const data = _serverData(playerHtml);
      if (!data) return null;

      const referer = `${data.origin}/`;
      const channel = await this.fetchChannel.fire(
        `${data.origin}/api/player.php?id=${data.channelId}`, referer);
      if (!channel || !channel.url) return null;

      const modelHtml = await this.fetchModel.fire(String(channel.url), referer);
      if (!modelHtml) return null;

      const src = _playerSrc(modelHtml);
      if (!src) return null;

      // The playlist itself wants nothing: no referer, no origin, no browser
      // fingerprint. It was tried four ways and answered all of them, so this
      // host has no business in the segment relay -- the signature in the URL
      // is the whole of what it checks.
      const { BASE_URL } = require('../config');
      const { manifestPath } = require('../manifestLink');
      const modelOrigin = new URL(String(channel.url)).origin;
      const url = `${BASE_URL}${manifestPath(src, `${modelOrigin}/`, modelOrigin)}`;

      // The signature runs about half an hour out, which sits inside the TTLs
      // StreamResolveCache learns, so a row is re-minted before it expires
      // rather than handed to a viewer dead.
      const expires = _expiresAt(src);
      console.log(`[${this.name}] ${data.league || data.sport || 'stream'} on channel ${data.channelId}`
        + `${expires ? `, signed until ${new Date(expires).toISOString()}` : ''}: ${redactUrl(src)}`);

      return new StreamEntity({
        name: this.name,
        // Numbered the way the other providers number their mirrors: the label
        // the viewer reads is built from this, and two rows that read the same
        // are two rows they cannot choose between.
        title: `${this.name} Stream ${index + 1}`,
        url,
        behaviorHints: { notWebReady: true },
        resolution: 'HD'
      });
    } catch (err) {
      console.warn(`[${this.name}] mirror failed for ${redactUrl(playerUrl)}: ${err.message}`);
      return null;
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const gameUrl = `https://${this.gameHost}/game/${sourceId}`;
      const html = await this.fetchGame.fire(gameUrl);
      if (!html) return [];

      const players = _playerUrls(html);
      if (!players.length) return [];

      // Both at once. They are separate hosts with separate channel ids behind
      // them, so one being slow says nothing about the other, and a viewer
      // waiting on a tile should not pay for them one after the other.
      const settled = await Promise.all(
        players.map((url, i) => this._resolveMirror(url, gameUrl, i)));
      for (const entity of settled) if (entity) streams.push(entity);
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = TotalSportekProvider;
module.exports._parseListing = _parseListing;
module.exports._playerUrls = _playerUrls;
module.exports._serverData = _serverData;
module.exports._playerSrc = _playerSrc;
module.exports._kickoff = _kickoff;
module.exports._expiresAt = _expiresAt;
module.exports._LIVE_WINDOW_MS = LIVE_WINDOW_MS;
