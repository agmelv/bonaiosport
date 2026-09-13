/**
 * A logo for a TV channel, found by its name.
 *
 * The channel feeds disagree about artwork. Some send a clean transparent logo,
 * some send a promotional still, and several send nothing, so a card drawn from
 * whatever arrived is a photo of boxers for DAZN and a blank panel for others.
 *
 * tv-logo/tv-logos is a curated set of channel logos, filed by country as
 * `countries/<country>/<channel>-<cc>.png`. That filing is the point: a name on
 * its own is ambiguous ("Golf Channel" exists in several countries, "Bravo" in
 * the US and New Zealand, and matching on name alone put a Czech logo on one
 * and a local US station's on "US Open"). So a trailing country word in the
 * channel name picks the country, the US stands in when there is none, and
 * only then does any other country's version of the same channel qualify.
 *
 * The file list comes from GitHub's tree API once a day -- one request, well
 * inside the unauthenticated limit -- and the files themselves are served from
 * jsDelivr's CDN. Lookups never wait on the list: until it has loaded they
 * return null and the card falls back to whatever it would have used before.
 */

const TREE_URL = 'https://api.github.com/repos/tv-logo/tv-logos/git/trees/main?recursive=1';
const FILE_BASE = 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/';
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Words a channel name ends with to say which country's feed it is, and the
// suffix tv-logos files that country under.
const COUNTRY = {
  usa: 'us', us: 'us', uk: 'uk', ie: 'ie', ireland: 'ie', nz: 'nz',
  germany: 'de', deutschland: 'de', italia: 'it', italy: 'it',
  spain: 'es', espana: 'es', portugal: 'pt', francais: 'fr', france: 'fr',
  pl: 'pl', poland: 'pl', australia: 'au', au: 'au', canada: 'ca', ca: 'ca',
  mexico: 'mx', brasil: 'br', brazil: 'br',
  // The short codes region labels use ("ESPN NZ", "DAZN 1 DE").
  de: 'de', it: 'it', es: 'es', pt: 'pt', fr: 'fr', mx: 'mx', br: 'br',
  ar: 'ar', argentina: 'ar', nl: 'nl', be: 'be'
};

// Names the feeds use that tv-logos files under a different slug. Kept to cases
// seen in the live catalog -- each one a channel that would otherwise have shown
// a promo still or no logo -- because every entry here is a claim that two names
// are one channel. A pair [slug, country] also says which country's file: a
// short name like "ONE 1" or "Hallmark" is only that channel in that country.
const ALIASES = {
  ae: 'a-and-e',
  teenick: 'teen-nick',
  cbeebies: 'bbc-cbeebies',
  'bbc-one-london': 'bbc-one',
  'willow-cricket': 'willow',
  'willow-cricket-2': 'willow-xtra',
  'canal-sport': 'canal-plus-sport',
  'sport-5-stars': ['5stars', 'il'],
  'one-1': ['one', 'il'],
  altitude: ['altitude-sports', 'us'],
  'national-geographic-wild': 'nat-geo-wild',
  hallmark: ['hallmark-channel', 'us']
};

// Families filed under a pattern rather than a name. A third element restricts
// the match to one country, the same way as an alias pair.
const REWRITES = [
  [/^movistar-(.+)$/, '$1-por-movistar-plus'],
  [/^sony-sports-network-(\d+)$/, 'sony-ten-$1'],
  [/^sony-sports-network$/, 'sony-ten-1'],
  // Numbered feeds of one service share its logo; the cover prints the number.
  [/^stan-sport-\d+$/, 'stan-sport', 'au'],
  [/^premiere-\d+$/, 'premiere', 'br']
];

// Channels tv-logos does not carry, with a logo checked by hand: the right
// channel, current branding, and legible on the cover's grey. Keyed by slug.
const DIRECT = {
  'pluto-tv-esportes': 'https://images.pluto.tv/channels/5f32d2db0af67400077f29c4/solidLogoPNG.png',
  'artn-tv': 'https://img1.wsimg.com/isteam/ip/d2482229-31ec-4884-9110-da7518509481/ARTN%20logo.png'
};

// Logos chosen channel by channel in an audit of every cover in the tab, each
// downloaded, looked at on the grey and checked against the channel's source
// before it went in. Most are the right file from tv-logos for a channel that
// was wearing a sibling's logo; the rest replace a promo still, a screenshot or
// another channel's artwork that a feed had attached. Keyed by channel name.
const AUDITED = {
  'AWE International': FILE_BASE + 'countries/united-states/awe-us.png',
  'AWE Plus': 'https://i.imgur.com/hL8i7Ar.png',
  'beIN SPORTS XTRA en Espanol': FILE_BASE + 'countries/united-states/bein-sports-xtra-espanol-us.png',
  'BET': FILE_BASE + 'countries/united-kingdom/bet-uk.png',
  'Binge': FILE_BASE + 'countries/united-states/binge-tv-us.png',
  'Black News Channel': 'https://i.imgur.com/oX5oR4d.png',
  'CANAL+ Extra 1': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/eb/Canal%2B_Extra_1.png/960px-Canal%2B_Extra_1.png',
  'CBS News Philly': 'https://i.imgur.com/FmtTbNY.png',
  'CBS Sports Golazo': FILE_BASE + 'countries/united-states/cbs-sports-golazo-network-us.png',
  'Diya TV': 'https://i.imgur.com/1fC7tqH.png',
  'ESPN 4 BR': FILE_BASE + 'countries/brazil/espn-4-br.png',
  'ESPN 4 MX': FILE_BASE + 'countries/world-latin-america/espn-4-lam.png',
  'ESPN News': FILE_BASE + 'countries/united-states/espnews-us.png',
  'ESPN Premium': FILE_BASE + 'countries/argentina/espn-premium-ar.png',
  'ESPN U': FILE_BASE + 'countries/united-states/espn-u-us.png',
  'ESPN+ USA': FILE_BASE + 'countries/united-states/espn-plus-us.png',
  'ESPN2 US': FILE_BASE + 'countries/united-states/espn-2-us.png',
  'Estrella News': FILE_BASE + 'misc/vod/estrella-news-vod.png',
  'FOX Sports 2 AR': FILE_BASE + 'countries/argentina/fox-sports-2-ar.png',
  'FOX Sports 2 MX': FILE_BASE + 'countries/world-latin-america/fox-sports-2-lam.png',
  'Fox Sports 501 Cricket': FILE_BASE + 'countries/australia/fox-sports-cricket-501-au.png',
  'Fox Sports 502 (League)': FILE_BASE + 'countries/australia/fox-sports-league-502-au.png',
  'Fox Sports 503': FILE_BASE + 'countries/australia/fox-sports-503-au.png',
  'Fox Sports 504 (Footy)': FILE_BASE + 'countries/australia/fox-sports-footy-504-au.png',
  'Fox Sports 505': FILE_BASE + 'countries/australia/fox-sports-505-au.png',
  'Fox Sports 506': FILE_BASE + 'countries/australia/fox-sports-506-au.png',
  'Fox Sports 507': FILE_BASE + 'countries/australia/fox-sports-507-au.png',
  'Fox Sports News': FILE_BASE + 'countries/australia/fox-sports-news-au.png',
  'Fubo Sports Network': FILE_BASE + 'countries/united-states/fubo-sports-network-us.png',
  'IFC': 'https://i.imgur.com/bQdkyF9.png',
  'Mega TV': 'https://i.imgur.com/MiPdjSX.png',
  'MLB Strike Zone': FILE_BASE + 'countries/united-states/mlb-network-strike-zone-us.png',
  'MoreMax': 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/MoreMax_Logo.svg/960px-MoreMax_Logo.svg.png',
  'MotoGP Channel': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/MotoGP_logo_%282024%29.svg/960px-MotoGP_logo_%282024%29.svg.png',
  'News of the World': 'https://i.imgur.com/MfyRQCs.png',
  'News12 Bronx': FILE_BASE + 'countries/united-states/news12-the-bronx-us.png',
  'News12 Brooklyn': FILE_BASE + 'countries/united-states/news12-brooklyn-us.png',
  'Newsy': 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Newsy_2021.svg/960px-Newsy_2021.svg.png',
  'NTD TV': 'https://i.imgur.com/iyFXcDy.png',
  'NTD TV China': 'https://i.imgur.com/iyFXcDy.png',
  'Pluto TV Deportes': 'https://images.pluto.tv/channels/5dcde07af1c85b0009b18651/solidLogoPNG.png',
  'Right Now TV': 'https://i.imgur.com/OxbIla4.png',
  'Scripps News': FILE_BASE + 'countries/united-states/scripps-news-us.png',
  'Sky Sports Mix': FILE_BASE + 'countries/united-kingdom/sky-sports-mix-uk.png',
  'Sky Sports News': FILE_BASE + 'countries/united-kingdom/sky-sports-news-uk.png',
  'Sky Sports Racing': FILE_BASE + 'countries/united-kingdom/sky-sports-racing-uk.png',
  'Sky Sports Tennis': FILE_BASE + 'countries/united-kingdom/sky-sports-tennis-uk.png',
  'Sky Sports+': FILE_BASE + 'countries/united-kingdom/sky-sports-plus-hz-uk.png',
  'Sportsnet 360': FILE_BASE + 'countries/canada/sportsnet-360-ca.png',
  'Sportsnet East': FILE_BASE + 'countries/canada/sportsnet-east-ca.png',
  'Sportsnet One': FILE_BASE + 'countries/canada/sportsnet-one-ca.png',
  'Sportsnet Ontario': FILE_BASE + 'countries/canada/sportsnet-ontario-ca.png',
  'Sportsnet West': FILE_BASE + 'countries/canada/sportsnet-west-ca.png',
  'Sportsnet World': FILE_BASE + 'countries/canada/sportsnet-world-ca.png',
  'Telemundo Internacional': 'https://i.imgur.com/j2O4ndp.png',
  'TNT Sports 3': FILE_BASE + 'countries/united-kingdom/tnt-sports-3-uk.png',
  'TNT Sports 4': FILE_BASE + 'countries/united-kingdom/tnt-sports-4-uk.png',
  'TNT Sports 5': FILE_BASE + 'countries/united-kingdom/tnt-sports-5-uk.png',
  'TNT Sports 6': FILE_BASE + 'countries/united-kingdom/tnt-sports-6-uk.png',
  'TNT Sports 8': FILE_BASE + 'countries/united-kingdom/tnt-sports-8-uk.png',
  'TSN 1': FILE_BASE + 'countries/canada/tsn-1-ca.png',
  'TSN 2': FILE_BASE + 'countries/canada/tsn-2-ca.png',
  'TSN 3': FILE_BASE + 'countries/canada/tsn-3-ca.png',
  'TSN 4': FILE_BASE + 'countries/canada/tsn-4-ca.png',
  'TSN 5': FILE_BASE + 'countries/canada/tsn-5-ca.png',
  'TSN1': FILE_BASE + 'countries/canada/tsn-1-ca.png',
  'VBS TV': 'https://i.imgur.com/kKGIAgv.png',
  'Vision Latina Network': 'https://i.imgur.com/VgYCskX.png',
  'WAPA America': 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/WAPA-TV_logo.svg/960px-WAPA-TV_logo.svg.png'
};

// Channels whose only artwork is unusable -- a news photo, a stock image, a
// broken file -- and for which no real logo exists anywhere checked. They get
// the name-only cover rather than a picture of the wrong thing.
const NO_LOGO_NAMES = [
  '30A Georgia Hollywood Review',
  '30A Lionel Nation',
  '30A Loomered TV',
  'CANAL+ Extra 2',
  'City of Fairfield Channel 26',
  'CMTV',
  'Didgah TV',
  'Las Vegas Tonight with Dale Davidson',
  'Little Guyana TV',
  'Littleton 8 TV',
  'NCTV79',
  'Ontario Public Access Channel',
  'Payvand TV',
  'PCTV 28',
  'SC Currents',
  'SFGovTV2',
  'SMCTV Channel 25',
  'Sound View Community Media',
  'TM TV',
  'VCAT',
  'WAPA Deportes',
  'WCOT',
  'Zoom News'
];

// Two-letter words that end channel names without naming a country.
const NOT_COUNTRY = new Set(['tv', 'hd', 'sd', 'fm', 'jr', 'go', 'on', 'up', 'xl', 'uhd']);

// Countries a pan-Latin-American ("lam") logo stands in for.
const LATAM = new Set(['mx', 'ar', 'co', 'cl', 'pe', 'uy', 've', 'ec', 'bo', 'py', 'cr', 'gt', 'hn', 'ni', 'pa', 'sv', 'do']);

const slug = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\+/g, ' plus ').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const DIRECT_BY_SLUG = new Map([
  ...Object.entries(DIRECT),
  ...Object.entries(AUDITED).map(([name, url]) => [slug(name), url])
]);
const NO_LOGO = new Set(NO_LOGO_NAMES.map(slug));

/** True for a channel known to have no usable logo; its cover is its name. */
function isLogoless(name) {
  return !!name && NO_LOGO.has(slug(name));
}

let index = null;         // base slug -> [{ cc, hz, hd, path }]
let loadedAt = 0;
let loading = null;

async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(TREE_URL, {
        headers: { 'User-Agent': 'AIOSports', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`tree responded ${res.status}`);
      const body = await res.json();
      const next = new Map();
      for (const item of body.tree || []) {
        if (!item || item.type !== 'blob') continue;
        const path = item.path;
        if (!path.startsWith('countries/') || !path.endsWith('.png')) continue;
        const file = path.slice(path.lastIndexOf('/') + 1, -4);
        // Two-letter country codes, and "lam" for the pan-Latin-American feeds
        // (espn-4-lam, fox-sports-2-lam) that Mexico and the rest share.
        const m = /^(.*?)(-hz)?-([a-z]{2}|lam)$/.exec(file);
        if (!m) continue;
        const add = (base, hd) => {
          if (!next.has(base)) next.set(base, []);
          next.get(base).push({ cc: m[3], hz: !!m[2], hd, path });
        };
        const base = m[1];
        const hd = path.includes('/hd/') || base.endsWith('-hd');
        add(base, hd);
        // "tnt-sports-1-hd-uk" is TNT Sports 1; the feed never says HD.
        if (base.endsWith('-hd')) add(base.slice(0, -3), true);
      }
      if (next.size) {
        index = next;
        loadedAt = Date.now();
        console.log(`[ChannelLogoIndex] ${next.size} channel logos indexed`);
      }
    } catch (err) {
      console.warn('[ChannelLogoIndex] could not load the logo list:', err.message);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function warm() {
  if (!index || Date.now() - loadedAt > REFRESH_MS) load().catch(() => {});
}

/**
 * The best logo URL for a channel name, or null.
 *
 * Exact base-name matches only. A looser rule would find a logo for more
 * channels and a wrong one for some of them, and a wrong logo is worse than the
 * fallback: it tells the viewer this is a different channel.
 */
function lookup(name, region, opts = {}) {
  warm();
  if (!name) return null;
  if (NO_LOGO.has(slug(name))) return null;
  const direct = DIRECT_BY_SLUG.get(slug(name));
  if (direct) return direct;
  if (!index) return null;

  const words = String(name).trim().split(/\s+/);
  let want = null;
  const last = (words[words.length - 1] || '').toLowerCase();
  // A named country, or any other two-letter code at the end of the name --
  // region labels use them ("Sky Sport 1 AT", "Stan Sport 2 AU") and tv-logos
  // files by the same codes. Two-letter words that are not countries are left
  // alone, so "Rally TV" is still looked up as rally-tv.
  if (words.length > 1 && (COUNTRY[last] || (/^[a-z]{2}$/.test(last) && !NOT_COUNTRY.has(last)))) {
    want = COUNTRY[last] || last;
    words.pop();
  }
  // No country in the name: the region the source filed the channel under,
  // which is how "Canal Sport" from a French feed finds the French logo rather
  // than the Polish one.
  if (!want && region) want = COUNTRY[String(region).toLowerCase()] || String(region).toLowerCase();
  const base = slug(words.join(' '));

  // The name as the feed wrote it first, then the ways tv-logos is known to
  // file the same channel differently: an alias, trailing words the logo set
  // leaves off, and a letter run into a digit ("Sport TV1" is sport-tv-1).
  const trimmed = base.replace(/-(24-7|internacional|channel)$/, '');
  const alias = ALIASES[base];
  // Each try is [slug, country the try is limited to, or null].
  // The trimmed try is loose: "Telemundo Internacional" trimmed is plain
  // Telemundo, a different channel. Strict lookups skip it.
  const tries = [
    [base, null],
    Array.isArray(alias) ? alias : [alias, null],
    [trimmed, null, true],
    [base.replace(/([a-z])(\d)/g, '$1-$2'), null]
  ];
  for (const [re, to, cc] of REWRITES) if (re.test(base)) tries.push([base.replace(re, to), cc || null]);
  let candidates = null;
  for (const [t, cc, loose] of tries) {
    if (loose && opts.strict) continue;
    if (!t || !index.has(t)) continue;
    // A country-limited name is only that channel in that country: a feed the
    // source filed elsewhere is some other channel that happens to share it.
    if (cc && want && want !== cc) continue;
    candidates = cc ? index.get(t).filter(c => c.cc === cc) : index.get(t);
    if (candidates.length) break;
  }
  if (!candidates || !candidates.length) return null;

  const preferred = want || 'us';
  const retired = (c) => /\/old\//.test(c.path);
  // The country asked for first; for a Latin-American country, the shared
  // Latin-American feed's logo next.
  const rank = (c) => (c.cc === preferred ? 0 : (LATAM.has(preferred) && c.cc === 'lam' ? 1 : 2));
  const best = candidates.slice().sort((a, b) =>
    // A logo filed under old/ is retired branding; any current logo beats it.
    retired(a) - retired(b)
    || rank(a) - rank(b)
    || (!['us', 'uk'].includes(a.cc)) - (!['us', 'uk'].includes(b.cc))
    // The standard mark before the horizontal variant: the same URL is used for
    // the corner badge, which is square.
    || (a.hz - b.hz)
    || (a.hd - b.hd)
  )[0];
  // Strict: only this channel's own logo. The country asked for (or its
  // Latin-American feed); with no country known, the US or UK version, or the
  // only country that has the name at all. Anything else is some other
  // country's channel of the same name, and a source's own logo is the safer
  // guess -- which is why a strict miss returns nothing rather than the best.
  if (opts.strict) {
    // An HD file carries an "HD" tag that is not part of the channel's name;
    // HBO 2 and HBO Zone came out labelled that way. Leave those to the source.
    if (retired(best) || best.hd) return null;
    const own = rank(best) < 2;
    const countries = new Set(candidates.filter(c => !retired(c)).map(c => c.cc));
    if (!own && !(!want && (['us', 'uk'].includes(best.cc) || countries.size === 1))) return null;
  }
  return FILE_BASE + best.path;
}

warm();

module.exports = { lookup, warm, isLogoless, _slug: slug };
