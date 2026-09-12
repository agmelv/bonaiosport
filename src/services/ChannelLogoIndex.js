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
// a promo still -- because every entry here is a claim that two names are one
// channel.
const ALIASES = {
  ae: 'a-and-e',
  teenick: 'teen-nick',
  cbeebies: 'bbc-cbeebies',
  'bbc-one-london': 'bbc-one',
  'willow-cricket': 'willow',
  'willow-cricket-2': 'willow-xtra'
};

// Families filed under a pattern rather than a name.
const REWRITES = [
  [/^movistar-(.+)$/, '$1-por-movistar-plus'],
  [/^sony-sports-network-(\d+)$/, 'sony-ten-$1'],
  [/^sony-sports-network$/, 'sony-ten-1']
];

const slug = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\+/g, ' plus ').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

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
        const m = /^(.*?)(-hz)?-([a-z]{2})$/.exec(file);
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
function lookup(name) {
  warm();
  if (!index || !name) return null;

  const words = String(name).trim().split(/\s+/);
  let want = null;
  const last = (words[words.length - 1] || '').toLowerCase();
  if (words.length > 1 && COUNTRY[last]) {
    want = COUNTRY[last];
    words.pop();
  }
  const base = slug(words.join(' '));

  // The name as the feed wrote it first, then the ways tv-logos is known to
  // file the same channel differently: an alias, trailing words the logo set
  // leaves off, and a letter run into a digit ("Sport TV1" is sport-tv-1).
  const trimmed = base.replace(/-(24-7|internacional|channel)$/, '');
  const tries = [base, ALIASES[base], trimmed, base.replace(/([a-z])(\d)/g, '$1-$2')];
  for (const [re, to] of REWRITES) if (re.test(base)) tries.push(base.replace(re, to));
  let candidates = null;
  for (const t of tries) {
    if (t && index.has(t)) { candidates = index.get(t); break; }
  }
  if (!candidates || !candidates.length) return null;

  const preferred = want || 'us';
  const best = candidates.slice().sort((a, b) =>
    (a.cc !== preferred) - (b.cc !== preferred)
    || (!['us', 'uk'].includes(a.cc)) - (!['us', 'uk'].includes(b.cc))
    // The standard mark before the horizontal variant: the same URL is used for
    // the corner badge, which is square.
    || (a.hz - b.hz)
    || (a.hd - b.hd)
  )[0];
  return FILE_BASE + best.path;
}

warm();

module.exports = { lookup, warm, _slug: slug };
