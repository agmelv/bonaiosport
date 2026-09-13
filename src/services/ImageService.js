/**
 * ImageService.js
 *
 * Self-hosted image pipeline for catalog artwork:
 *   - fetchAndCache(url): fetches a remote image once, validates it is really
 *     an image, caches it in memory (TTL + entry cap) and returns the entry.
 *     Returns null on ANY failure (timeout, non-image body, too large) so the
 *     caller can fall back to a generated placeholder.
 *   - svgPlaceholder(text, color): generates a category-colored poster card as
 *     an SVG string. Replaces the old external placehold.co dependency.
 *   - svgMatchup(...): composes a two-crest "A vs B" card from team logos that
 *     TeamLogoService resolved, with the logos inlined as data URIs.
 *   - proxyUrl(baseUrl, sourceUrl, opts): builds the /img proxy URL that Nuvio
 *     fetches; the proxy serves the cached image or the generated placeholder,
 *     so a dead source URL can never produce a broken image in the client.
 *
 * No new dependencies: fetches use undici (already in the dependency tree).
 */

const fs = require('fs');
const path = require('path');
const { request, Agent, interceptors } = require('undici');

// The soccer feeds serve every crest as a 302 to their CDN. Plain request()
// hands back the redirect itself, the 200-only check in getImage() rejects it,
// and the card falls back to a name plate — which is why no soccer fixture had
// a crest. undici 8 dropped the maxRedirections option in favour of this.
//
// Every hop, redirects included, connects through the private-address guard:
// the URL is whatever a caller put in /img?url=, and without it that was a way
// to read the Docker host and the home network as pictures.
const { guardedConnect } = require('../netGuard');
const redirectAgent = new Agent({ connect: guardedConnect() })
  .compose(interceptors.redirect({ maxRedirections: 3 }));

// Generated cards are cached for a day by the client, and the URL for a given
// fixture is the same before and after a change to how they're drawn — so a
// restyle would leave viewers looking at the old artwork until the TTL expired.
// Bump this whenever svgMatchup() or svgPlaceholder() changes what they draw;
// it rides along in every generated image URL and retires the stale copies.
const RENDER_VERSION = 6;
const crestColor = require('./CrestColorService');
const artGeneration = require('./ArtGeneration');
const DiskCache = require('./DiskCache');

// The version in every generated URL: how cards are drawn, plus the cache
// generation that clearing the cache bumps (see ArtGeneration.js).
function artVersion() {
  return `${RENDER_VERSION}.${artGeneration.get()}`;
}

/** Whether a request names today's artwork, not a URL a player kept from before. */
function isCurrentArt(req) {
  return String((req && req.query && req.query.v) || '') === artVersion();
}

// What players are told they may keep. Only a card drawn exactly as intended --
// first-choice logos, current URL -- is kept for a day. One drawn from a
// second-choice logo is kept briefly. One drawn around a logo that missed, or a
// provider poster standing in, is not kept at all, so the next look retries.
// Players cache by URL: a fallback they were allowed to keep is a wrong card on
// their screen for as long as they keep it, whatever the server draws meanwhile.
const CACHE_CONTROL = {
  FULL: 'public, max-age=86400, stale-while-revalidate=86400',
  SECOND_CHOICE: 'public, max-age=900',
  STALE_URL: 'public, max-age=3600',
  FALLBACK: 'no-store'
};

/**
 * How a matchup card may be cached, from what was actually drawn. `A` and `B`
 * are what firstImage() found ({ url }) or null; `askedA`/`askedB` whether that
 * side had any crest to try; `al`/`bl` the first-choice crests.
 */
function matchupDecision({ A, B, askedA = true, askedB = true, al, bl, posterUsed, current, stale = false }) {
  if (posterUsed) return { kind: 'poster', cacheControl: CACHE_CONTROL.FALLBACK, remember: false };
  const missed = (!A && askedA) || (!B && askedB);
  if (missed || (!A && !B)) {
    return { kind: !A && !B ? 'name' : 'one-sided', cacheControl: CACHE_CONTROL.FALLBACK, remember: false };
  }
  // Drawn from a crest past its freshness while a new copy is fetched -- after
  // a clear, the copy may be the very thing the clear was meant to be rid of.
  if (stale) return { kind: 'stale', cacheControl: CACHE_CONTROL.SECOND_CHOICE, remember: false };
  if ((A && al && A.url !== al) || (B && bl && B.url !== bl)) {
    return { kind: 'second-choice', cacheControl: CACHE_CONTROL.SECOND_CHOICE, remember: false };
  }
  return current
    ? { kind: 'full', cacheControl: CACHE_CONTROL.FULL, remember: true }
    : { kind: 'full', cacheControl: CACHE_CONTROL.STALE_URL, remember: false };
}
const crypto = require('crypto');
const sharp = require('sharp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Logos and crests change on the scale of seasons, not minutes. Ten minutes
// and 120 entries was sized for a few dozen fixture crests; the Channels tab
// alone draws on 700 logos, so a player opening it evicted what the warmer had
// just fetched and sent several hundred requests upstream at once. Wikimedia
// answered 429, GitHub and imgur timed out, and those channels came back as
// name-only covers.
const IMAGE_TTL_MS = 6 * 60 * 60 * 1000;
// Past its TTL a logo is still served for up to a week while a new copy is
// fetched behind it, and one is fetched early in the last tenth of its life.
const IMAGE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_AHEAD_FRACTION = 0.1;
// After a clear, how long a card waits for a new copy of a logo before drawing
// with the old one.
const REVALIDATE_WAIT_MS = 3000;

/** Past its freshness: being served while a new copy is fetched. */
function isStaleEntry(entry) {
  return !!entry && typeof entry.expiresAt === 'number' && entry.expiresAt <= Date.now();
}
const CACHE_MAX_ENTRIES = 2000;
const CACHE_MAX_BYTES = 160 * 1024 * 1024;
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
// One request. Three seconds cut off logo hosts that were merely busy; the
// deadline below is what bounds the whole wait.
const FETCH_TIMEOUT_MS = 6000;
// The whole budget for one image, queueing and a second try included. A player
// gives up on an image after about ten seconds, so a card that waits longer is
// a blank tile anyway -- better to send the card without that logo in time.
const FETCH_DEADLINE_MS = 8000;

// Wikimedia asks automated clients to name themselves, and throttles a browser
// string arriving from a server far sooner than a named one.
const BOT_UA = 'AIOSports/1.0 (https://github.com/mlp2069/aiosports)';

const cache = new Map();     // url -> { buffer, contentType, expiresAt }
const inFlight = new Map();  // url -> Promise
const negatives = new Map(); // url -> expiry ts (recently failed/slow sources)
// Fetched images on disk as well (IMAGE_DISK_MB), for as long as one may be
// served: a restart used to refetch six hundred logos, and redraw an SVG
// among them as PNG, before the first card was made.
const diskImages = new DiskCache('images', {
  maxBytes: (Number(process.env.IMAGE_DISK_MB) || 256) * 1024 * 1024,
  ttlMs: IMAGE_TTL_MS + IMAGE_STALE_MS
});

const NEG_TTL_MS = 60 * 1000;
// A fetch that never started -- its host cooling down, or no slot free before
// the deadline -- says nothing about the image, so it is asked again sooner.
const NEG_TTL_SKIPPED_MS = 10 * 1000;

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Break text into display lines. Explicit newlines are honoured first; any
 * resulting line longer than maxChars is word-wrapped rather than truncated,
 * so "Northwestern Oklahoma State Rangers" reads in full instead of becoming
 * "Northwestern Oklahoma Sta…".
 */
function wrapLines(text, maxChars, maxLines) {
  const out = [];
  const paras = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const para of paras) {
    if (para.length <= maxChars) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if ((line + ' ' + word).length <= maxChars) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
      // A single word longer than the budget (rare) still has to be cut.
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars - 1) + '-');
        line = line.slice(maxChars - 1);
      }
    }
    if (line) out.push(line);
  }
  if (!out.length) return ['Live Sports'];
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[\s.]+$/, '') + '…';
    return kept;
  }
  return out;
}

function accentColor(color) {
  return /^([0-9a-fA-F]{6})$/.test(String(color)) ? `#${color}` : '#333333';
}

/**
 * Generated poster card: dark background, category-colored accent bar and the
 * title word-wrapped across centered lines. Replaces placehold.co.
 */
function svgPlaceholder(text, color, w = 800, h = 450) {
  // Painted like the matchup card so a fixture with no crests still belongs to
  // the same catalog: same gradient, same seam, same backlights. There are no
  // team colours to use here — nothing resolved — so the category colour
  // carries it, seated dark enough for white text and split light-to-dark so
  // the card has depth instead of reading as a flat panel.
  const base = accentColor(color).slice(1);
  const seated = luminance(base) > 0.55 ? shade(base, -0.45)
    : luminance(base) > 0.32 ? shade(base, -0.28)
    : luminance(base) < 0.05 ? shade(base, 0.16)
    : base;
  const left = shade(seated, 0.10);
  const right = shade(seated, -0.22);
  const seam = shade(seated, -0.42);

  const lines = wrapLines(text, 24, 5);
  const fontSize = lines.length >= 5 ? 34 : lines.length === 4 ? 40 : lines.length === 3 ? 44 : lines.length === 2 ? 52 : 58;
  const lead = fontSize + 12;
  const startY = h / 2 - ((lines.length - 1) * lead) / 2;
  const textEls = lines.map((line, i) => {
    const y = startY + i * lead;
    const isVs = /^(vs|v|at|-)$/i.test(line);
    return `<text x="50%" y="${y.toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${isVs ? Math.round(fontSize * 0.6) : fontSize}" font-weight="${isVs ? 400 : 700}" fill="${isVs ? 'rgba(255,255,255,0.62)' : '#ffffff'}" text-anchor="middle" dominant-baseline="middle" filter="url(#pdrop)">${escapeXml(line)}</text>`;
  }).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="pbg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#${left}"/>
      <stop offset="50%" stop-color="#${seam}"/>
      <stop offset="100%" stop-color="#${right}"/>
    </linearGradient>
    <radialGradient id="pglow" cx="50%" cy="50%" r="42%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="pdrop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#pbg)"/>
  <rect width="${w}" height="${h}" fill="url(#pglow)"/>
  ${textEls}
</svg>`;
}

/**
 * Mix two hex colours. t=0 returns a, t=1 returns b.
 */
function mixHex(a, b, t) {
  const pa = [a.slice(0, 2), a.slice(2, 4), a.slice(4, 6)].map(h => parseInt(h, 16));
  const pb = [b.slice(0, 2), b.slice(2, 4), b.slice(4, 6)].map(h => parseInt(h, 16));
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function shade(hex, amount) {
  return amount < 0 ? mixHex(hex, '000000', -amount) : mixHex(hex, 'ffffff', amount);
}

function luminance(hex) {
  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map(h => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick the pair of colours the card is painted in.
 *
 * Crests are drawn on top, and most of them are mostly white, so a light half
 * would swallow its own logo — every side gets pulled into a band dark enough
 * to sit a crest on. When both sides land on the same colour (two red teams)
 * the split stops reading as two halves, so one side is pushed darker.
 */
// The half behind a team with no colour of its own: a black-and-silver shield,
// a white wordmark. It used to borrow a dark shade of the opponent's colour,
// which painted the Raiders in Dolphins teal.
const NEUTRAL_HALF = '2a2d32';
// The same, for a colourless crest that is itself dark -- no light parts to
// show up against charcoal.
const NEUTRAL_HALF_LIFTED = '5c616a';
// How close (summed RGB difference) an official colour must be to one the crest
// shows to count as that colour. At 90 Brighton's filed teal passed for the
// blue of its badge and painted the half teal.
const SAME_COLOUR = 60;

function cardColors(aStats, bStats, fallback) {
  const hexOk = v => (/^([0-9a-fA-F]{6})$/.test(String(v)) ? String(v).toLowerCase() : null);
  const base = hexOk(fallback) || '1f2430';
  const read = st => {
    if (!st) return { colors: [], light: 0, crest: false, brand: [] };
    if (Array.isArray(st)) return { colors: st.map(hexOk).filter(Boolean), light: 1, crest: true, brand: [] };
    return {
      colors: (st.colors || []).map(hexOk).filter(Boolean),
      // null when the crest could not be read: unknown, not "no light pixels".
      light: typeof st.light === 'number' ? st.light : null,
      crest: st.crest !== false,
      brand: (st.brand || []).map(hexOk).filter(Boolean)
    };
  };
  const A = read(aStats);
  const B = read(bStats);

  const spread = (x, y) => [0, 1, 2].reduce((acc, i) =>
    acc + Math.abs(parseInt(x.slice(i * 2, i * 2 + 2), 16) - parseInt(y.slice(i * 2, i * 2 + 2), 16)), 0);

  // What a side can be painted in, strongest first. An official colour the
  // crest visibly wears ranks where the crest ranks it -- Syracuse is orange,
  // not the navy ESPN lists first, and the Dolphins stay aqua ahead of orange.
  // An official colour the crest does not show at all comes after the crest's
  // own colours: some clubs are filed under a colour their badge never uses.
  // With no crest palette to judge by, official colours keep ESPN's order.
  // Near-duplicates collapse, so an alternate is a genuinely different colour.
  const choices = S => {
    const items = [];
    const represented = new Set();
    S.brand.filter(crestColor.isChromatic).forEach((c, i) => {
      const match = S.colors.findIndex(p => spread(p, c) < SAME_COLOUR);
      if (match !== -1) represented.add(match);
      items.push({ c, brand: true, rank: match !== -1 ? match : (S.colors.length ? 100 + i : i) });
    });
    S.colors.forEach((c, i) => {
      if (!represented.has(i)) items.push({ c, brand: false, rank: i + 0.5 });
    });
    items.sort((x, y) => x.rank - y.rank);
    const out = [];
    for (const item of items) if (!out.some(o => spread(o.c, item.c) < 30)) out.push(item);
    return out;
  };
  const LA = choices(A);
  const LB = choices(B);

  // Crests sit on top of this, most of them white-heavy, so a very light half
  // would swallow its own logo. Only the genuinely light colours get pulled
  // down, and gently: darkening an orange toward black turns it to mud.
  //
  // The opposite failure needs the crest's own make-up to spot: a dark crest
  // WITH a white outline reads fine on a dark half, while one without it
  // (Richmond's solid navy spider) disappears — so only that second kind gets
  // its half lifted.
  const seatPalette = (c, stats, derived) => {
    const l = luminance(c);
    if (l > 0.75) return shade(c, -0.38);
    if (l > 0.45) return shade(c, -0.26);
    if (l > 0.20) return shade(c, -0.16);
    if (!derived && l < 0.15 && stats.light != null && stats.light < 0.12) return shade(c, 0.32);
    if (l < 0.04) return shade(c, 0.10);
    return c;
  };
  // An official colour is the team's colour; it is only toned down when it is
  // light enough to wash out a white crest -- and lifted, as a crest colour
  // would be, when it is dark behind a dark crest with nothing light in it
  // (the Yankees' navy NY on navy).
  const seatBrand = (c, stats) => {
    const l = luminance(c);
    if (l > 0.75) return shade(c, -0.38);
    if (l > 0.55) return shade(c, -0.22);
    if (l < 0.15 && stats.crest && stats.light != null && stats.light < 0.12) return shade(c, 0.32);
    return c;
  };
  const seat = (choice, stats) => (choice.brand ? seatBrand(choice.c, stats) : seatPalette(choice.c, stats, false));
  const neutral = stats => (stats.crest && stats.light != null && stats.light < 0.12 ? NEUTRAL_HALF_LIFTED : NEUTRAL_HALF);

  let a;
  let b;
  if (!LA.length && !LB.length) {
    // Neither side has a colour: the category colour, as always.
    a = seatPalette(base, A, true);
    b = seatPalette(base, B, true);
  } else {
    let ca = LA[0] || null;
    // Two teams that both come back orange stop reading as two halves. Prefer a
    // colour the team actually wears over distorting its primary one.
    const cb = LB.find(x => !ca || spread(x.c, ca.c) >= 90) || LB[0] || null;
    if (ca && cb && spread(ca.c, cb.c) < 90) {
      const alt = LA.slice(1).find(x => spread(x.c, cb.c) >= 90);
      if (alt) ca = alt;
    }
    a = ca ? seat(ca, A) : neutral(A);
    b = cb ? seat(cb, B) : neutral(B);
  }

  // Still colliding (one crest, or a crest with a single colour): nudge rather
  // than leave a card that looks like one flat panel.
  if (spread(a, b) < 90) b = luminance(b) > 0.35 ? shade(b, -0.28) : shade(b, 0.24);

  return { a, b };
}

/**
 * Matchup card: each half painted in that team's colour, blending through a
 * darkened seam, with the crests inlined as data URIs. Modelled on the artwork
 * the streaming providers ship for their own fixtures, so a generated card and
 * a provider card sit next to each other without looking like two designs.
 *
 * The crests come from getImage() and are inlined as data URIs — an SVG that
 * referenced them by URL would render blank in clients that refuse external
 * refs.
 *
 * A missing logo degrades to the team's name in that half, so a one-sided
 * resolve still produces a better card than the plain placeholder.
 */
function svgMatchup(aName, bName, aEntry, bEntry, color, opts = {}) {
  const { w = 800, h = 450, aUrl = null, bUrl = null } = opts;
  const { a: colA, b: colB } = cardColors(
    crestColor.statsForCrest(aUrl, aEntry),
    crestColor.statsForCrest(bUrl, bEntry),
    color
  );

  const cx = [w * 0.27, w * 0.73];
  const crest = 250;
  const crestMid = h * 0.5;
  const crestY = crestMid - crest / 2;
  const seam = shade(mixHex(colA, colB, 0.5), -0.55);

  const half = (name, entry, i) => {
    const centerX = cx[i];
    if (entry && entry.buffer) {
      const uri = `data:${entry.contentType};base64,${entry.buffer.toString('base64')}`;
      return `<image x="${(centerX - crest / 2).toFixed(1)}" y="${crestY.toFixed(1)}" width="${crest}" height="${crest}" preserveAspectRatio="xMidYMid meet" href="${uri}" xlink:href="${uri}" filter="url(#drop)"/>`;
    }
    // No crest for this side: its name carries the half instead.
    const lines = wrapLines(name, 13, 3);
    const fs = 34;
    const y0 = crestMid - ((lines.length - 1) * (fs + 8)) / 2;
    return lines.map((l, j) =>
      `<text x="${centerX.toFixed(1)}" y="${(y0 + j * (fs + 8)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeXml(l)}</text>`
    ).join('\n  ');
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#${shade(colA, 0.06)}"/>
      <stop offset="32%" stop-color="#${colA}"/>
      <stop offset="50%" stop-color="#${seam}"/>
      <stop offset="68%" stop-color="#${colB}"/>
      <stop offset="100%" stop-color="#${shade(colB, 0.06)}"/>
    </linearGradient>
    <radialGradient id="glowA" cx="27%" cy="50%" r="27%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="73%" cy="50%" r="27%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glowA)"/>
  <rect width="${w}" height="${h}" fill="url(#glowB)"/>
  ${half(aName, aEntry, 0)}
  ${half(bName, bEntry, 1)}
  <text x="50%" y="${crestMid.toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" filter="url(#drop)">VS</text>
</svg>`;
}

/**
 * Rasterise a generated card.
 *
 * Nuvio does not draw SVG posters — it showed every generated card as a blurred
 * smear of its gradient while the provider's JPEG posters stayed sharp — so the
 * cards clients receive are JPEG. The SVG remains the source of truth and is
 * still served on ?format=svg, which is what the web configure page and any
 * debugging want.
 *
 * JPEG rather than PNG: these are opaque photographic-ish cards, and at quality
 * 88 the two are indistinguishable while the JPEG is a fifth of the size —
 * 27KB against 147KB for a full catalog page of artwork.
 */
// mozjpeg squeezes a card from 21 KB to 15 KB and costs 1.9x the CPU to do it
// (133 ms a card against 67 ms, measured on the two-core host this runs on).
// Loading a tab is dozens of cards at once, so that trade was buying 6 KB with
// a pegged CPU.
//
// The quality number itself is close to free on the ordinary encoder: every
// setting from 82 to 95 rendered within the same 67-85 ms band on that host,
// which is run-to-run noise rather than a difference. What it buys is size --
// 17 KB at 82, 21 KB at 88, 35 KB at 95. So 90: visibly cleaner gradients and
// crest edges for about 4 KB, and no measurable CPU.
const RASTER_QUALITY = 90;
const rasterCache = new Map();
// A single tab can hold 600 cards. At 160 the cache evicted faster than a
// scroll could fill it, so every pass down the list re-rendered the lot; 1200
// cards of roughly 17 KB is about 20 MB, against a container already holding
// 450 MB on a 7 GB host.
const RASTER_CACHE_MAX = 1200;

// Plain counters, for the dashboard. A hit rate that is falling is the signal
// that the cache is too small for the catalog again.
const stats = { rasterHits: 0, rasterMisses: 0, fetchHits: 0, fetchMisses: 0, cardHits: 0, cardMisses: 0 };

async function rasterize(svg) {
  const key = crypto.createHash('sha1').update(svg).digest('base64');
  const hit = rasterCache.get(key);
  if (hit) {
    // Refresh recency: a card on screen now is the one worth keeping.
    rasterCache.delete(key);
    rasterCache.set(key, hit);
    stats.rasterHits++;
    return hit;
  }
  stats.rasterMisses++;
  const buf = await sharp(Buffer.from(svg))
    .jpeg({ quality: RASTER_QUALITY })
    .toBuffer();
  if (rasterCache.size >= RASTER_CACHE_MAX) rasterCache.delete(rasterCache.keys().next().value);
  rasterCache.set(key, buf);
  return buf;
}

// Finished cards by the URL that asked for them. The raster cache above is
// keyed by the drawing, and making the drawing means fetching the logo first --
// the slow, rate-limited half. Keyed by URL, a card a player has asked for
// before, or the warmer has made, costs a map lookup. Only cards whose art
// arrived are kept; a card drawn around a missing logo must be drawn again.
const cardCache = new Map();
// Room for every tab's posters and the wide backgrounds beside them, bounded by
// bytes as well now that 1280x720 cards live here too.
const CARD_CACHE_MAX = 4500;
const CARD_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const CARD_TTL_MS = 12 * 60 * 60 * 1000;
let cardBytes = 0;
// The finished cards on disk as well (CARD_DISK_MB): a restart threw every one
// away and the warmer drew the lot again, which was most of a deploy's CPU.
// Every tab's cards come to about 60 MB. A card is written when it is made
// and read back the first time it is asked for after a start.
const diskCards = new DiskCache('cards', {
  maxBytes: (Number(process.env.CARD_DISK_MB) || 512) * 1024 * 1024,
  ttlMs: CARD_TTL_MS
});

/** The art version a card key names: what the file is filed under. */
function versionOf(key) {
  try { return new URLSearchParams(String(key).split('?')[1] || '').get('v') || ''; } catch (e) { return ''; }
}

function cardDrop(key) {
  const old = cardCache.get(key);
  if (!old) return;
  cardCache.delete(key);
  cardBytes -= old.jpeg.length;
}

function cardPut(key, entry, { persist = true } = {}) {
  cardDrop(key);
  cardCache.set(key, entry);
  cardBytes += entry.jpeg.length;
  while (cardCache.size > CARD_CACHE_MAX || (cardBytes > CARD_CACHE_MAX_BYTES && cardCache.size > 1)) {
    cardDrop(cardCache.keys().next().value);
  }
  if (persist) diskCards.put(key, { cacheControl: entry.cacheControl, v: versionOf(key) }, entry.jpeg);
}

/** Whether a finished card is held for this path and query, in memory or on disk. Touches nothing. */
function hasFreshCard(key) {
  const hit = cardCache.get(key);
  if (hit && Date.now() <= hit.expiresAt) return true;
  return diskCards.has(key);
}

function cardKey(req) {
  if (String(req.query.format || '').toLowerCase() === 'svg') return null;
  return req.originalUrl || req.url || null;
}

/** Send the card already made for this URL. True when it did. */
function sendCachedCard(req, res) {
  const key = cardKey(req);
  let hit = key ? cardCache.get(key) : null;
  if (hit && Date.now() > hit.expiresAt) {
    cardDrop(key);
    hit = null;
  }
  if (!hit && key) {
    // Made before the last restart: read back, and held in memory from here.
    const kept = diskCards.get(key);
    if (kept) {
      hit = { jpeg: kept.buffer, cacheControl: (kept.meta && kept.meta.cacheControl) || CACHE_CONTROL.FULL, expiresAt: kept.mtimeMs + CARD_TTL_MS };
      cardPut(key, hit, { persist: false });
    }
  }
  if (!hit) {
    stats.cardMisses++;
    return false;
  }
  cardCache.delete(key);
  cardCache.set(key, hit);
  stats.cardHits++;
  res.setHeader('Cache-Control', hit.cacheControl);
  res.setHeader('Content-Type', 'image/jpeg');
  res.send(hit.jpeg);
  return true;
}

/**
 * Send a generated card, rasterised unless ?format=svg was asked for. A
 * rasteriser failure falls back to the SVG rather than to no image at all.
 * `remember` keeps the finished card for sendCachedCard.
 */
async function sendCard(req, res, svg, cacheControl, opts = {}) {
  res.setHeader('Cache-Control', cacheControl);
  if (String(req.query.format || '').toLowerCase() === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  }
  try {
    const jpeg = await rasterize(svg);
    res.setHeader('Content-Type', 'image/jpeg');
    // The generation can move while a card is drawn (a clear mid-render). A
    // card that started current but finished stale is not sent or kept as one.
    let control = cacheControl;
    if (control === CACHE_CONTROL.FULL && req.query && req.query.v !== undefined && !isCurrentArt(req)) {
      control = CACHE_CONTROL.STALE_URL;
      res.setHeader('Cache-Control', control);
    }
    // Never kept here if players were told not to keep it for a day either.
    const keep = opts.remember && control === CACHE_CONTROL.FULL;
    const key = keep ? cardKey(req) : null;
    if (key) cardPut(key, { jpeg, cacheControl: control, expiresAt: Date.now() + CARD_TTL_MS });
    return res.send(jpeg);
  } catch (err) {
    // A card that failed to rasterise goes out as SVG, which players cannot
    // all draw -- so it is not something any of them should keep.
    res.setHeader('Cache-Control', CACHE_CONTROL.FALLBACK);
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  }
}

/**
 * Event card: a badge over the house gradient, for events that are not
 * team-vs-team — a race, a fight card, a tournament round. These resolve no
 * crests, so the alternative is the title alone on a plain panel.
 *
 * The badge sits on a white plate on purpose. A third of the marks worth using
 * (WWE, AEW, MotoGP, the boxing glove) are drawn in black and vanish against a
 * dark gradient without it.
 */
// The flat grey a channel cover is painted in. Logos are drawn for a neutral
// dark ground, and one even tone across every channel reads as a set where
// per-channel gradients read as noise.
const COVER_GREY = '333436';

// Background knockout results, keyed by the source image's hash.
const knockoutCache = new Map();
const KNOCKOUT_CACHE_MAX = 600;

/**
 * Make a logo's solid backdrop transparent, so it sits on the cover's grey.
 *
 * Plenty of channel logos arrive as a mark on a white or black rectangle, which
 * on a grey cover is a box pasted on a box. The backdrop is found from the
 * border: if most of the edge is one colour and not already transparent, that
 * colour is flood-filled inward from the edge and cleared, then the pixels just
 * inside the cleared area are faded rather than cut, so the edge does not leave
 * a hard fringe. Filling from the edge rather than removing the colour
 * everywhere is what keeps white lettering inside a logo on a white backdrop.
 *
 * Returns null -- use the image as it is -- for anything that does not look
 * like a logo on a plain backdrop: already transparent, a busy edge (a photo),
 * or a fill that clears almost nothing or almost everything.
 */
/** Share of pixels that are fully transparent. */
function transparentShare(data) {
  let zero = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) zero++;
  return zero / (data.length / 4);
}

async function knockoutBackground(buffer, opts = {}) {
  if (!buffer) return null;
  const key = crypto.createHash('sha1').update(buffer).digest('base64') + (opts.allowDark ? ':dark' : '');
  if (knockoutCache.has(key)) return knockoutCache.get(key);
  let result = null;
  try {
    const { data, info } = await sharp(buffer, { failOn: 'none' })
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, C = info.channels;
    // A logo that already has transparent areas has drawn its own shape. The
    // Spanish DAZN files have opaque white corners around a transparent box,
    // and filling from those corners erased the box frame and the channel
    // number, leaving loose DA ZN letters.
    if (W && H && C === 4 && transparentShare(data) < 0.01) {
      const edge = [];
      for (let x = 0; x < W; x++) edge.push(x, (H - 1) * W + x);
      for (let y = 1; y < H - 1; y++) edge.push(y * W, y * W + W - 1);

      let clear = 0, r = 0, g = 0, b = 0;
      for (const p of edge) {
        const i = p * 4;
        if (data[i + 3] < 250) clear++;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      r /= edge.length; g /= edge.length; b /= edge.length;
      // Artwork that runs off the edge (Voice of America's V and A) pulls the
      // edge average away from the backdrop. When the four corners agree and
      // are opaque, their colour is the backdrop.
      const cornerAt = [0, W - 1, (H - 1) * W, H * W - 1].map(p => p * 4);
      const cornersAgree = cornerAt.every(i => data[i + 3] >= 250
        && Math.abs(data[i] - data[cornerAt[0]]) + Math.abs(data[i + 1] - data[cornerAt[0] + 1])
          + Math.abs(data[i + 2] - data[cornerAt[0] + 2]) <= 42);
      if (cornersAgree) { r = data[cornerAt[0]]; g = data[cornerAt[0] + 1]; b = data[cornerAt[0] + 2]; }
      const dist = (i) => Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
      const TOL = 42;
      let uniform = 0;
      for (const p of edge) if (dist(p * 4) <= TOL) uniform++;

      const strictEdge = uniform / edge.length >= 0.9;
      if (clear / edge.length < 0.2 && (strictEdge || (cornersAgree && uniform / edge.length >= 0.6))) {
        const cleared = new Uint8Array(W * H);
        const stack = edge.slice();
        let count = 0;
        while (stack.length) {
          const p = stack.pop();
          if (cleared[p]) continue;
          if (dist(p * 4) > TOL) continue;
          cleared[p] = 1;
          data[p * 4 + 3] = 0;
          count++;
          const x = p % W;
          if (x > 0) stack.push(p - 1);
          if (x < W - 1) stack.push(p + 1);
          if (p >= W) stack.push(p - W);
          if (p < W * (H - 1)) stack.push(p + W);
        }
        const share = count / (W * H);
        // What is left must still show up on dark grey. A black wordmark on a
        // white rectangle is legible in its box and nearly invisible without
        // it, so when the kept pixels are mostly dark the backdrop stays.
        let lum = 0, kept = 0;
        for (let p = 0; p < W * H; p++) {
          if (cleared[p]) continue;
          const i = p * 4;
          if (data[i + 3] < 128) continue;
          lum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          kept++;
        }
        // A caller that lifts dark marks afterwards (coverMark) asks for the
        // backdrop to go regardless.
        const legible = kept > 0 && (opts.allowDark || lum / kept >= 0.28);
        // The corner rule is for a logo whose artwork runs off the edge. A
        // letterboxed promo still also has four agreeing black corners, and
        // clearing its bars exposed every shadow to the lift. A logo has a
        // few hundred distinct colours at most; a photo has thousands.
        let logoLike = true;
        if (!strictEdge) {
          const colours = new Uint8Array(4096);
          let distinct = 0;
          for (let p = 0; p < W * H && distinct <= 512; p++) {
            if (cleared[p]) continue;
            const i = p * 4;
            if (data[i + 3] < 128) continue;
            const c = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
            if (!colours[c]) { colours[c] = 1; distinct++; }
          }
          logoLike = distinct <= 512;
        }
        if (legible && logoLike && share >= 0.05 && share <= 0.97) {
          // Soften the boundary: a pixel touching the cleared area keeps an
          // alpha in proportion to how far its colour is from the backdrop.
          const SOFT = TOL * 3;
          for (let p = 0; p < W * H; p++) {
            if (cleared[p]) continue;
            const x = p % W;
            const touches = (x > 0 && cleared[p - 1]) || (x < W - 1 && cleared[p + 1])
              || (p >= W && cleared[p - W]) || (p < W * (H - 1) && cleared[p + W]);
            if (!touches) continue;
            const d = dist(p * 4);
            if (d < SOFT) data[p * 4 + 3] = Math.round(data[p * 4 + 3] * (d / SOFT));
          }
          const png = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
          result = { buffer: png, contentType: 'image/png' };
        }
      }
    }
  } catch (e) {
    result = null;
  }
  if (knockoutCache.size >= KNOCKOUT_CACHE_MAX) knockoutCache.delete(knockoutCache.keys().next().value);
  knockoutCache.set(key, result);
  return result;
}

/**
 * Make a dark logo readable on the cover's grey.
 *
 * A navy or black mark is drawn for a white page, and on dark grey it all but
 * disappears: the Stadium wordmark, Willow's lettering, the Yankees' NY. The
 * dark parts that sit on the open background -- reached from a transparent
 * pixel through dark pixels only -- are lightened to near-white, the way the
 * leagues draw their own dark-mode logos, and colour that already reads
 * (Willow's red W, Showtime) is left alone. Dark detail enclosed by a lighter
 * shape, like black lettering inside a white box, cannot be reached from
 * outside and keeps its colour.
 *
 * Returns null -- draw the logo as it is -- when little of it is dark, or when
 * it has no transparency to judge "outside" by (a photo, a filled box).
 */
const liftCache = new Map();

// sRGB channel value to linear light, for contrast; and the cover grey's own.
const LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const COVER_GREY_L = 0.2126 * LINEAR[0x33] + 0.7152 * LINEAR[0x34] + 0.0722 * LINEAR[0x36];

async function liftDarkMark(buffer) {
  if (!buffer) return null;
  const key = crypto.createHash('sha1').update(buffer).digest('base64');
  if (liftCache.has(key)) return liftCache.get(key);
  let result = null;
  try {
    const { data, info } = await sharp(buffer, { failOn: 'none' })
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, N = W * H;
    if (W && H && info.channels === 4) {
      // Brightness as the eye sees it on grey is closer to the brightest
      // channel than to luminance: pure red reads clearly, navy does not.
      const DARK = 0.42;
      // Contrast against the cover grey, measured the way WCAG does -- for
      // near-neutral pixels only. A mid-grey wordmark vanishes on the grey
      // however bright its strongest channel. A saturated colour is a brand
      // colour: judged by contrast, PBS blue, Univision's blue quarter, MASN's
      // swoosh and Telemundo's darker red all came out white. Colour is judged
      // by brightness alone, as it always was.
      const MIN_CONTRAST = 1.9;
      const SATURATED = 0.5;
      const value = (p) => Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) / 255;
      const saturation = (p) => {
        const i = p * 4;
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        return mx ? (mx - Math.min(data[i], data[i + 1], data[i + 2])) / mx : 0;
      };
      const contrast = (p) => {
        const L = 0.2126 * LINEAR[data[p * 4]] + 0.7152 * LINEAR[data[p * 4 + 1]] + 0.0722 * LINEAR[data[p * 4 + 2]];
        return (Math.max(L, COVER_GREY_L) + 0.05) / (Math.min(L, COVER_GREY_L) + 0.05);
      };
      // Above zero means too dim to read; 1 and over means fully so.
      const dimness = (p) => {
        const byValue = (DARK - value(p)) / 0.06;
        if (saturation(p) >= SATURATED) return byValue;
        return Math.max(byValue, (MIN_CONTRAST - contrast(p)) / 0.25);
      };
      const clearAt = (p) => data[p * 4 + 3] < 128;
      const darkAt = (p) => data[p * 4 + 3] > 0 && dimness(p) > 0;
      // Light detail: opaque, bright and near neutral. The half-transparent
      // fringe a knockout leaves round a stroke does not count; it made
      // News12+ Connecticut's lettering look boxed, so it was never lifted.
      const lightAt = (q) => {
        const i = q * 4;
        if (data[i + 3] < 250) return false;
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        return mx >= 178 && (mx - Math.min(data[i], data[i + 1], data[i + 2])) / mx < 0.25;
      };

      let opaque = 0, dark = 0, clear = 0;
      for (let p = 0; p < N; p++) {
        if (clearAt(p)) { clear++; continue; }
        opaque++;
        if (dimness(p) > 0) dark++;
      }
      if (opaque && clear / N >= 0.05 && dark / opaque >= 0.05) {
        // Each dark shape reachable from the open background is judged on its
        // own. One holding light detail -- the white LIVE in LiveNOW's navy box,
        // "Plus" in AWE Plus's bar -- is a box, not a stroke, and lifting it
        // puts white on white: it borders light pixels about as much as the
        // open background, where a dark wordmark borders almost nothing but
        // background. Judged over the whole logo, a large clean stroke elsewhere
        // outvoted the box and had it lifted anyway.
        const seen = new Uint8Array(N);
        const lift = new Uint8Array(N);
        let reached = 0;
        let skippedSolid = 0;
        let skippedCount = 0;
        let liftedCount = 0;
        const touchesOpen = (p) => {
          const x = p % W;
          return (x > 0 && clearAt(p - 1)) || (x < W - 1 && clearAt(p + 1))
            || (p >= W && clearAt(p - W)) || (p < N - W && clearAt(p + W));
        };
        for (let s0 = 0; s0 < N; s0++) {
          if (seen[s0] || !darkAt(s0) || !touchesOpen(s0)) continue;
          const comp = [];
          const stack = [s0];
          seen[s0] = 1;
          while (stack.length) {
            const p = stack.pop();
            comp.push(p);
            const x = p % W;
            if (x > 0 && !seen[p - 1] && darkAt(p - 1)) { seen[p - 1] = 1; stack.push(p - 1); }
            if (x < W - 1 && !seen[p + 1] && darkAt(p + 1)) { seen[p + 1] = 1; stack.push(p + 1); }
            if (p >= W && !seen[p - W] && darkAt(p - W)) { seen[p - W] = 1; stack.push(p - W); }
            if (p < N - W && !seen[p + W] && darkAt(p + W)) { seen[p + W] = 1; stack.push(p + W); }
          }
          let openEdges = 0, lightEdges = 0, colourEdges = 0, solid = 0;
          const edge = (q) => {
            if (clearAt(q)) { openEdges++; return; }
            // A neighbour that itself touches the open background is the
            // shape's own soft edge, not detail held inside it.
            if (touchesOpen(q)) return;
            if (lightAt(q)) lightEdges++;
            // Any readable colour next to the shape: yellow lettering on a
            // navy box, or a red wordmark ringed by its own dark anti-aliasing.
            if (data[q * 4 + 3] >= 250 && dimness(q) <= 0) colourEdges++;
          };
          for (const p of comp) {
            if (clearAt(p)) continue;
            solid++;
            const x = p % W;
            if (x > 0) edge(p - 1);
            if (x < W - 1) edge(p + 1);
            if (p >= W) edge(p - W);
            if (p < N - W) edge(p + W);
          }
          // A box, or a ring round coloured artwork: leave it as drawn. Grey and
          // white detail inside says box at a low ratio; coloured neighbours
          // need a higher one, since a dark stroke crossing a coloured bar is
          // exactly what the lift is for.
          if (lightEdges > openEdges * 0.3 || colourEdges > openEdges * 0.75) { skippedSolid += solid; skippedCount++; continue; }
          for (const p of comp) lift[p] = 1;
          reached += solid;
          liftedCount++;
        }
        // All or nothing when a word splits. A dark wordmark taken off white
        // had its letters judged one by one, and some came out white beside
        // others left black on the grey. That is several shapes of about the
        // same size on each side. One large shape kept as drawn beside lifted
        // lettering -- Access Tuolumne's mountains, AWE Plus's bar -- is the
        // per-shape rule working, and is left alone.
        const avgSkipped = skippedCount ? skippedSolid / skippedCount : 0;
        const avgLifted = liftedCount ? reached / liftedCount : 0;
        const splitWord = skippedCount >= 2 && liftedCount >= 2
          && skippedSolid > 0.15 * (skippedSolid + reached)
          && avgSkipped <= 3 * avgLifted && avgLifted <= 3 * avgSkipped;
        if (reached / opaque >= 0.04 && !splitWord) {
          for (let p = 0; p < N; p++) {
            if (!lift[p]) continue;
            // Fully dim goes to near-white; the band just under the threshold
            // blends, so the edge between a lifted and an unlifted colour does
            // not step.
            const t = Math.min(1, dimness(p));
            const i = p * 4;
            for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + (240 - data[i + c]) * t);
          }
          const png = await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
          result = { buffer: png, contentType: 'image/png' };
        }
      }
    }
  } catch (e) {
    result = null;
  }
  if (liftCache.size >= KNOCKOUT_CACHE_MAX) liftCache.delete(liftCache.keys().next().value);
  liftCache.set(key, result);
  return result;
}

/**
 * A logo as a channel cover draws it: its backdrop removed and its dark parts
 * lifted. A dark mark on a white box keeps the box unless the lift works,
 * because the box is the only thing making it legible -- and so does any logo
 * the knockout leaves unreadable, such as dark calligraphy that could only be
 * read on its white card.
 */
async function coverMark(entry) {
  if (!entry || !entry.buffer) return entry;
  const plain = (await knockoutBackground(entry.buffer)) || entry;
  const opened = (await knockoutBackground(entry.buffer, { allowDark: true })) || entry;
  let drawn = (await liftDarkMark(opened.buffer)) || plain;
  if (drawn !== entry && (await readableShare(drawn.buffer)) < 0.3) drawn = entry;
  return trimPadding(drawn);
}

const readableCache = new Map();

/**
 * The share of a logo's visible pixels that can be read on the cover grey:
 * enough contrast, or a saturated colour bright enough to carry on its own.
 */
async function readableShare(buffer) {
  const key = crypto.createHash('sha1').update(buffer).digest('base64');
  if (readableCache.has(key)) return readableCache.get(key);
  let share = 1;
  try {
    const { data, info } = await sharp(buffer, { failOn: 'none' })
      .resize({ width: 200, height: 200, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0, readable = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      visible++;
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      const L = 0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]];
      const c = (Math.max(L, COVER_GREY_L) + 0.05) / (Math.min(L, COVER_GREY_L) + 0.05);
      if (c >= 1.9 || (mx >= 107 && mx && (mx - mn) / mx >= 0.5)) readable++;
    }
    share = visible ? readable / visible : 1;
    void info;
  } catch (e) {
    share = 1;
  }
  if (readableCache.size >= KNOCKOUT_CACHE_MAX) readableCache.delete(readableCache.keys().next().value);
  readableCache.set(key, share);
  return share;
}

const trimCache = new Map();

/**
 * A logo cut to its visible pixels. A YouTube avatar is a wordmark in the
 * middle of a square; fitted as the square, Lacrosse TV's name came out a
 * third of the size of every other logo.
 */
async function trimPadding(entry) {
  if (!entry || !entry.buffer) return entry;
  const key = crypto.createHash('sha1').update(entry.buffer).digest('base64');
  if (trimCache.has(key)) return trimCache.get(key) || entry;
  let result = null;
  try {
    const { data, info } = await sharp(entry.buffer, { failOn: 'none' })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    if (W && H && info.channels === 4 && data[3] < 16) {
      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] < 16) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      // Only worth a new image when a real margin comes off.
      if (maxX >= 0 && w * h < 0.8 * W * H) {
        const png = await sharp(entry.buffer, { failOn: 'none' }).ensureAlpha()
          .extract({ left: minX, top: minY, width: w, height: h }).png().toBuffer();
        result = { buffer: png, contentType: 'image/png' };
      }
    }
  } catch (e) {
    result = null;
  }
  if (trimCache.size >= KNOCKOUT_CACHE_MAX) trimCache.delete(trimCache.keys().next().value);
  trimCache.set(key, result);
  return result || entry;
}

/** An image's pixel size, or zeros when it cannot be read. */
async function imageSize(buffer) {
  try {
    const m = await sharp(buffer, { failOn: 'none' }).metadata();
    return { width: m.width || 0, height: m.height || 0 };
  } catch (e) {
    return { width: 0, height: 0 };
  }
}

function svgEvent(text, entry, color, opts = {}) {
  // `plate` is the white tile the mark is seated on. A sport's badge needs it
  // -- those marks are line art that disappears on a dark card -- but a TV
  // channel's logo is already designed to sit on its own and the tile reads as
  // a sticker pasted over the artwork. Channels ask for it off.
  // `name` is the title typed under the mark. A channel's logo already says
  // which channel it is, so a channel cover drops it and lets the logo carry
  // the card on its own -- larger, and centred in the frame rather than
  // parked above where the name used to go.
  // `cover` is a channel's card: flat grey, the logo, the channel's name under
  // it. It implies no plate and a name. The older no-plate, no-name form still
  // renders as a cover, so URLs a player has cached keep drawing.
  const coverMode = !!opts.cover;
  const { w = 800, h = 450, kicker = '' } = opts;
  const showPlate = coverMode ? false : (opts.plate !== undefined ? opts.plate : true);
  const showName = coverMode ? true : (opts.name !== undefined ? opts.name : true);
  const base = accentColor(color).slice(1);
  const seated = luminance(base) > 0.55 ? shade(base, -0.45)
    : luminance(base) > 0.32 ? shade(base, -0.28)
    : luminance(base) < 0.05 ? shade(base, 0.16)
    : base;
  const left = shade(seated, 0.10);
  const right = shade(seated, -0.22);
  const seam = shade(seated, -0.42);

  const plate = 196;
  const plateX = (w - plate) / 2;
  const plateY = 46;
  // Without the tile there is no frame to sit inside, so the mark takes the
  // room the tile would have used. The drop shadow moves onto the mark itself,
  // which is what keeps a dark logo from dissolving into a dark card.
  const markSize = 144;
  const mark = showPlate ? markSize : 176;
  const cover = coverMode || (!showPlate && !showName);

  // Where the logo goes. On a channel cover it is drawn at no more than its own
  // size: a 512px ESPN wordmark stretched to 720px was visibly softer than the
  // 500px crests on the sports cards beside it, so a logo is only ever scaled
  // down. It is centred in the card; the channel's name is a quiet line along
  // the top, so nothing sits under the logo.
  let boxW = mark;
  let boxH = mark;
  let boxX = plateX + (plate - mark) / 2;
  let boxY = plateY + (plate - mark) / 2;
  if (cover) {
    const maxW = coverMode ? 560 : 720;
    const maxH = coverMode ? 190 : 320;
    const nw = Number(opts.markW) || 0;
    const nh = Number(opts.markH) || 0;
    boxW = maxW;
    boxH = maxH;
    if (coverMode && nw > 0 && nh > 0) {
      // Never enlarged -- except a logo too small to read at its own size. A
      // 141x42 wordmark drawn at 1:1 had letters six pixels tall. Grown until
      // it is 260 wide or 110 tall, whichever comes first, three times at most.
      const readable = Math.max(1, Math.min(3, 260 / nw, 110 / nh));
      const scale = Math.min(maxW / nw, maxH / nh, readable);
      boxW = Math.max(1, Math.round(nw * scale));
      boxH = Math.max(1, Math.round(nh * scale));
    }
    boxX = Math.round((w - boxW) / 2);
    boxY = Math.round(h / 2 - boxH / 2);
  }

  const lines = wrapLines(text, 26, 3);
  const fs = lines.length >= 3 ? 34 : lines.length === 2 ? 40 : 44;
  const startY = 300;
  const textEls = lines.map((line, i) =>
    `<text x="50%" y="${(startY + i * (fs + 8)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" filter="url(#pdrop)">${escapeXml(line)}</text>`
  ).join('\n  ');

  // A cover's name. With a logo it is one quiet line along the top -- where a
  // "24/7" used to say the same thing about every channel -- and the logo has
  // the rest of the card to itself. It is what tells ESPN US from ESPN NZ,
  // whose logos are the same. With no logo the name is the whole card, so it
  // sits in the middle and grows.
  const hasMark = !!(entry && entry.buffer);
  const titleText = String(text || '').trim().toUpperCase();
  const titleLine = titleText.length > 40 ? `${titleText.slice(0, 39).trimEnd()}…` : titleText;
  const coverTitleEl = `<text x="50%" y="34" font-family="Segoe UI, Arial, sans-serif" font-size="${titleLine.length > 28 ? 19 : 22}" font-weight="700" letter-spacing="2.5" fill="rgba(255,255,255,0.78)" text-anchor="middle" dominant-baseline="middle">${escapeXml(titleLine)}</text>`;
  const coverLines = wrapLines(text, 24, 2);
  const cfs = coverLines.length === 2 ? 46 : (String(text).length > 18 ? 50 : 58);
  const coverTop = coverLines.length === 2 ? 234 - (cfs + 10) / 2 : 234;
  const coverTextEls = hasMark
    ? coverTitleEl
    : coverLines.map((line, i) =>
      `<text x="50%" y="${(coverTop + i * (cfs + 10)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${cfs}" font-weight="700" letter-spacing="0.5" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`
    ).join('\n  ');

  const uri = entry && entry.buffer
    ? `data:${entry.contentType};base64,${entry.buffer.toString('base64')}`
    : null;

  // The kicker is only ever set when a series was actually named in the title,
  // never when the mark came from the category fallback — the card must not
  // assert a series it guessed.
  const kickerEl = kicker
    ? `<text x="50%" y="${(plateY - 14).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="700" letter-spacing="3" fill="rgba(255,255,255,0.60)" text-anchor="middle" dominant-baseline="middle">${escapeXml(String(kicker).toUpperCase())}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="pbg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#${left}"/>
      <stop offset="50%" stop-color="#${seam}"/>
      <stop offset="100%" stop-color="#${right}"/>
    </linearGradient>
    <radialGradient id="pglow" cx="50%" cy="34%" r="42%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="pdrop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>
  ${cover
    ? `<rect width="${w}" height="${h}" fill="#${COVER_GREY}"/>`
    : `<rect width="${w}" height="${h}" fill="url(#pbg)"/>
  <rect width="${w}" height="${h}" fill="url(#pglow)"/>`}
  ${coverMode ? '' : kickerEl}
  ${uri ? `${showPlate ? `<rect x="${plateX.toFixed(1)}" y="${plateY}" width="${plate}" height="${plate}" rx="30" fill="#ffffff" fill-opacity="0.95" filter="url(#pdrop)"/>` : ''}
  <image x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW}" height="${boxH}" preserveAspectRatio="xMidYMid meet" href="${uri}" xlink:href="${uri}"${showPlate || cover ? '' : ' filter="url(#pdrop)"'}/>` : ''}
  ${coverMode ? coverTextEls : (showName ? textEls : '')}
</svg>`;
}

// The map is kept in recency order -- a hit moves its entry to the end -- so
// the oldest entry is always the first key and eviction never sorts.
let cacheBytes = 0;

function cachePut(url, entry, { persist = true } = {}) {
  cacheDrop(url);
  cache.set(url, entry);
  cacheBytes += entry.buffer.length;
  evictIfNeeded();
  if (persist) diskImages.put(url, { contentType: entry.contentType, expiresAt: entry.expiresAt }, entry.buffer);
}

function cacheDrop(url) {
  const old = cache.get(url);
  if (!old) return;
  cache.delete(url);
  cacheBytes -= old.buffer.length;
}

function evictIfNeeded() {
  while (cache.size > CACHE_MAX_ENTRIES || (cacheBytes > CACHE_MAX_BYTES && cache.size > 1)) {
    cacheDrop(cache.keys().next().value);
  }
}

// Where the bundled marks live. Running from source this file sits two levels
// below the app root; in the build everything collapses into dist and sits one
// level below. ncc also rewrites either expression to point at its own asset
// base. Probing settles all three rather than betting on one.
const MARKS_DIRS = [
  path.join(__dirname, '..', '..', 'public', 'marks'),
  path.join(__dirname, '..', 'public', 'marks'),
  path.join(process.cwd(), 'public', 'marks')
];

/**
 * Read a bundled mark straight from disk. Returns null for anything that is
 * not one of ours, including any path that tries to climb out of the folder.
 */
function localMark(url) {
  let name;
  try {
    name = new URL(url).pathname.match(/^\/marks\/([A-Za-z0-9._-]+)$/)?.[1];
  } catch { return null; }
  if (!name || name.includes('..')) return null;

  const hit = markCache.get(name);
  if (hit !== undefined) return hit;

  let result = null;
  for (const dir of MARKS_DIRS) {
    try {
      const buffer = fs.readFileSync(path.join(dir, name));
      result = { buffer, contentType: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png' };
      break;
    } catch { /* next candidate */ }
  }
  markCache.set(name, result);
  return result;
}
const markCache = new Map();

// How many fetches one host gets at a time. A burst is what trips a host's rate
// limit, so requests past this wait their turn instead of all going at once.
const HOST_LIMITS = { 'upload.wikimedia.org': 2 };
const HOST_LIMIT_DEFAULT = 6;
const hostQueues = new Map();   // host -> { active, waiting }
// A host that answered 429 is left alone, for every URL on it, until this time.
// Retrying one URL while its neighbours kept asking is how a throttle lasts.
const hostCooldown = new Map(); // host -> epoch ms

/**
 * Run fn in one of the host's slots. Resolves null without running it when the
 * host is cooling down or no slot frees up before the deadline.
 */
function withHostSlot(host, deadline, fn) {
  const cool = hostCooldown.get(host);
  if (cool && Date.now() < cool) return Promise.resolve(null);
  if (cool) hostCooldown.delete(host);

  const limit = HOST_LIMITS[host] || HOST_LIMIT_DEFAULT;
  let q = hostQueues.get(host);
  if (!q) { q = { active: 0, waiting: [] }; hostQueues.set(host, q); }

  const release = () => {
    const next = q.waiting.shift();
    // The slot passes straight to the next in line, so nobody arriving in
    // between can slip past the limit.
    if (next) { clearTimeout(next.timer); next.grant(); }
    else if (--q.active === 0 && hostQueues.get(host) === q) hostQueues.delete(host);
  };
  const run = async () => {
    try {
      // Checked again at the moment the slot is granted: a request queued
      // behind one that just got a 429 must not go out anyway.
      const c = hostCooldown.get(host);
      if (c && Date.now() < c) return null;
      const out = await fn();
      // Set before the slot is released, for the same reason.
      if (out && out.status === 429) {
        hostCooldown.set(host, Date.now() + Math.min(Math.max(out.retryAfterMs || 0, 30000), 10 * 60 * 1000));
      }
      return out;
    } finally {
      release();
    }
  };

  if (q.active < limit) { q.active++; return run(); }
  return new Promise(resolve => {
    const waiter = { grant: () => resolve(run()), timer: null };
    waiter.timer = setTimeout(() => {
      const i = q.waiting.indexOf(waiter);
      if (i !== -1) q.waiting.splice(i, 1);
      resolve(null);
    }, Math.max(0, deadline - Date.now()));
    q.waiting.push(waiter);
  });
}

// GitHub's raw host throttles hotlinked files; jsDelivr serves the same file
// from a CDN built for it.
function viaCdn(url) {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : url;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One request, bounded by what is left of the deadline. */
async function fetchOnce(url, host, deadline) {
  const budget = deadline - Date.now();
  if (budget < 500) return { result: null, status: 0, skipped: true };
  const timeout = Math.min(FETCH_TIMEOUT_MS, budget);
  try {
    // AbortSignal caps the TOTAL request (headers + body): a slow-loris upstream
    // that trickles bytes can otherwise hang past headersTimeout/bodyTimeout.
    const pending = request(url, {
      headers: { 'User-Agent': host === 'upload.wikimedia.org' ? BOT_UA : UA, 'Accept': 'image/*,*/*;q=0.8' },
      headersTimeout: timeout,
      bodyTimeout: timeout,
      dispatcher: redirectAgent,
      signal: AbortSignal.timeout(timeout)
    });
    // The abort signal does not cut a connection that is still being opened:
    // an unreachable host held a fetch for ten seconds, undici's own connect
    // timeout, past the whole deadline. So the wait is bounded here too. A
    // response that lands after we stopped waiting is drained, not leaked.
    let timer;
    const res = await Promise.race([
      pending,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); })
    ]).finally(() => clearTimeout(timer));
    if (!res) {
      pending.then(late => late && late.body && late.body.dump().catch(() => {}), () => {});
      return { result: null, status: 0 };
    }
    const contentType = String(res.headers['content-type'] || '').split(';')[0].trim();
    // Intentional destroys below (non-image body / size cap) make the undici
    // body emit an 'error' event; without a listener that crashes the process.
    res.body.on('error', () => {});
    if (res.statusCode === 200 && contentType.startsWith('image/')) {
      // Read with a hard size cap so a huge file can never blow the heap.
      const chunks = [];
      let total = 0;
      let tooBig = false;
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > IMAGE_MAX_BYTES) { tooBig = true; res.body.destroy(); break; }
        chunks.push(chunk);
      }
      if (!tooBig && total >= 32) return { result: { buffer: Buffer.concat(chunks), contentType }, status: 200 };
      return { result: null, status: 200 };
    }
    await res.body.dump().catch(() => {});
    const retryAfter = Number(res.headers['retry-after']);
    return {
      result: null,
      status: res.statusCode,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0
    };
  } catch (_) {
    return { result: null, status: 0 };
  }
}

/**
 * An image, fetched politely and within one deadline: a slot per host, the CDN
 * copy of a GitHub file before the file, the whole host left alone after a 429,
 * and a second try only for a server error with time to spare.
 */
async function fetchImage(url) {
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  const attempt = async (target) => {
    let host;
    try { host = new URL(target).hostname; } catch { return { result: null, status: 0 }; }
    const out = (await withHostSlot(host, deadline, () => fetchOnce(target, host, deadline)))
      || { result: null, status: 0, skipped: true };
    // (A 429 has already put the host on cooldown inside withHostSlot: as long
    // as the host asked, but thirty seconds at least and ten minutes at most.)
    return out;
  };

  const cdn = viaCdn(url);
  let out = await attempt(cdn);
  if (out.result) return out;
  // Whatever went wrong with the CDN copy, the original file is next.
  if (cdn !== url) {
    out = await attempt(url);
    if (out.result) return out;
  }
  // A timeout is not retried: it would spend the viewer's whole wait. Nor is a
  // 429: the host is cooling down.
  if (out.status >= 500 && deadline - Date.now() > 2000) {
    await sleep(500);
    out = await attempt(url);
  }
  return out;
}

/**
 * A fetched image redrawn as PNG, for anything that should not be passed on as
 * it arrived. An SVG is a document that can carry script; a PNG is pixels.
 */
async function toPng(buffer) {
  try {
    // The density is for vector input: at the default 72 dpi an SVG whose
    // width says 64 became a 64-pixel PNG. Raster input ignores it.
    const png = await sharp(buffer, { failOn: 'none', density: 288 })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return { buffer: png, contentType: 'image/png' };
  } catch (e) {
    return null;
  }
}

/**
 * Fetch a remote image once, validate it, cache it. Returns
 * { buffer, contentType } or null on any failure.
 */
async function getImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  // Our own bundled marks come off disk. They are addressed by URL so a card
  // can name one the same way it names a crest, but fetching them over the
  // network would make a card depend on this container still answering at the
  // address baked into the URL when the card was minted.
  const local = localMark(url);
  if (local) return local;

  let now = Date.now();
  let hit = cache.get(url);
  if (!hit) {
    // Fetched before the last restart: read back, with the freshness it had.
    const kept = diskImages.get(url);
    if (kept && kept.meta && kept.meta.contentType && kept.buffer.length) {
      const expiresAt = Number(kept.meta.expiresAt) || 0;
      hit = { buffer: kept.buffer, contentType: kept.meta.contentType, expiresAt, staleUntil: expiresAt + IMAGE_STALE_MS, lastAccess: now };
      cachePut(url, hit, { persist: false });
    }
  }
  // Just cleared: the copy held may be the very thing the owner cleared to be
  // rid of. A new copy gets a few seconds to arrive before a card is drawn from
  // the old one -- which, if it comes to that, is stale and kept by nobody.
  if (hit && hit.revalidate && now < (hit.staleUntil || 0) && !(negatives.get(url) > now)) {
    const pending = inFlight.get(url) || startFetch(url, { background: true });
    const fresh = await Promise.race([pending, sleep(REVALIDATE_WAIT_MS).then(() => null)]);
    if (fresh) return fresh;
    now = Date.now();
    hit = cache.get(url);
  }
  if (hit && now < (hit.staleUntil || hit.expiresAt)) {
    hit.lastAccess = now;
    // Move to the end: the most recently used entry is the last to go.
    cache.delete(url);
    cache.set(url, hit);
    stats.fetchHits++;
    // Near the end of its life, or past it: hand over the copy we have and
    // fetch a new one behind it. A logo that drew a card an hour ago keeps
    // drawing it while its host is slow, busy or briefly down -- a logo gone
    // cold instead is how a card got drawn without its crest.
    if (now > hit.expiresAt - IMAGE_TTL_MS * REFRESH_AHEAD_FRACTION) refreshImage(url);
    return hit;
  }
  if (hit) cacheDrop(url);

  const neg = negatives.get(url);
  if (neg) {
    if (now < neg) return null; // recently failed/slow: do not re-attempt yet
    negatives.delete(url);
  }
  stats.fetchMisses++;

  return inFlight.get(url) || startFetch(url);
}

/** A new copy of a cached image, fetched behind the one being served. */
function refreshImage(url) {
  if (inFlight.has(url)) return;
  const neg = negatives.get(url);
  if (neg && Date.now() < neg) return;
  startFetch(url, { background: true });
}

function startFetch(url, { background = false } = {}) {
  const p = (async () => {
    let result = null;
    let out = null;
    try {
      out = await fetchImage(url);
      if (out.result) {
        const t = Date.now();
        result = { ...out.result, expiresAt: t + IMAGE_TTL_MS, staleUntil: t + IMAGE_TTL_MS + IMAGE_STALE_MS, lastAccess: t };
        cachePut(url, result);
      }
    } catch (_) {
      result = null;
    } finally {
      inFlight.delete(url);
    }
    if (result) negatives.delete(url);
    else {
      // A source that says the image is gone is believed, stale copy and all.
      if (background && out && (out.status === 404 || out.status === 410)) { cacheDrop(url); diskImages.delete(url); }
      // A 429 is remembered at least as long as the host asked for.
      const ttl = out && out.status === 429 ? Math.max(out.retryAfterMs || 0, NEG_TTL_MS)
        : out && out.skipped ? NEG_TTL_SKIPPED_MS
          : NEG_TTL_MS;
      negatives.set(url, Date.now() + ttl);
      // Oldest out first. Clearing the lot at the cap also dropped the markers
      // that keep a throttled host from being asked again at once.
      if (negatives.size > 2000) negatives.delete(negatives.keys().next().value);
    }
    return result;
  })();

  inFlight.set(url, p);
  return p;
}

/**
 * Build the /img proxy URL that Nuvio fetches. The proxy serves the cached
 * upstream image or falls back to the generated placeholder, so a dead source
 * URL never reaches the client as a broken image.
 */
function proxyUrl(baseUrl, sourceUrl, { text = '', color = '333333' } = {}) {
  const validUrl = normalizeUrl(sourceUrl);
  if (!validUrl) return null;
  // The proxy's own fallback is a generated card, so it versions too.
  return `${baseUrl}/img?url=${encodeURIComponent(validUrl)}&text=${encodeURIComponent(text)}&color=${color}&v=${artVersion()}`;
}

/**
 * Build the /img/event URL. Carries a second mark so a series logo that fails
 * to load still leaves the card its sport icon.
 */
function eventUrl(baseUrl, { text, mark, mark2 = null, kicker = null, color = '333333', plate = true, name = true, cover = false }) {
  // A channel cover can be drawn with no logo at all: the name alone on grey.
  if (!mark && !cover) return null;
  const q = [
    `text=${encodeURIComponent(text || '')}`,
    `color=${color}`
  ];
  if (mark) q.push(`mark=${encodeURIComponent(mark)}`);
  if (mark2) q.push(`mark2=${encodeURIComponent(mark2)}`);
  if (kicker) q.push(`kicker=${encodeURIComponent(kicker)}`);
  if (!plate) q.push('plate=0');
  if (!name) q.push('notext=1');
  if (cover) q.push('cover=1');
  q.push(`v=${artVersion()}`);
  return `${baseUrl}/img/event?${q.join('&')}`;
}

function placeholderUrl(baseUrl, text, color) {
  return `${baseUrl}/img/placeholder?text=${encodeURIComponent(text || '')}&color=${color || '333333'}&v=${artVersion()}`;
}

/**
 * Build the /img/matchup URL.
 *
 * Carries up to two candidate crest URLs per side (al/al2, bl/bl2) and, when
 * the provider shipped its own poster, that poster as `fb`. The route tries
 * candidates in order and falls back to the poster, so the decision about
 * which image actually exists is made where it can be known — at fetch time —
 * instead of guessed here. Returns null when neither side has a candidate.
 */
function matchupUrl(baseUrl, { a, b, aLogo, bLogo, aLogos, bLogos, color = '333333', fallback = null, w = null, h = null }) {
  const A = (Array.isArray(aLogos) ? aLogos : [aLogo]).filter(Boolean).slice(0, 2);
  const B = (Array.isArray(bLogos) ? bLogos : [bLogo]).filter(Boolean).slice(0, 2);
  if (!A.length && !B.length) return null;
  const q = [
    `a=${encodeURIComponent(a || '')}`,
    `b=${encodeURIComponent(b || '')}`,
    `color=${color}`
  ];
  if (A[0]) q.push(`al=${encodeURIComponent(A[0])}`);
  if (A[1]) q.push(`al2=${encodeURIComponent(A[1])}`);
  if (B[0]) q.push(`bl=${encodeURIComponent(B[0])}`);
  if (B[1]) q.push(`bl2=${encodeURIComponent(B[1])}`);
  const fb = normalizeUrl(fallback);
  if (fb) q.push(`fb=${encodeURIComponent(fb)}`);
  if (w) q.push(`w=${w}`);
  if (h) q.push(`h=${h}`);
  q.push(`v=${artVersion()}`);
  return `${baseUrl}/img/matchup?${q.join('&')}`;
}

/** What the caches hold, for the dashboard. */
function cacheStats() {
  let rasterBytes = 0;
  for (const buf of rasterCache.values()) rasterBytes += buf.length;
  let fetchBytes = 0;
  for (const entry of cache.values()) fetchBytes += (entry.buffer ? entry.buffer.length : 0);
  const rate = (h, m) => (h + m ? Math.round((100 * h) / (h + m)) : null);
  return {
    cards: { entries: rasterCache.size, max: RASTER_CACHE_MAX, bytes: rasterBytes,
      hits: stats.rasterHits, misses: stats.rasterMisses, hitRate: rate(stats.rasterHits, stats.rasterMisses) },
    upstream: { entries: cache.size, bytes: fetchBytes,
      hits: stats.fetchHits, misses: stats.fetchMisses, hitRate: rate(stats.fetchHits, stats.fetchMisses) },
    generation: artGeneration.info(),
    renderVersion: RENDER_VERSION,
    finished: { entries: cardCache.size, max: CARD_CACHE_MAX, bytes: cardBytes,
      hits: stats.cardHits, misses: stats.cardMisses, hitRate: rate(stats.cardHits, stats.cardMisses) },
    negatives: negatives.size,
    quality: RASTER_QUALITY,
    disk: { cards: diskCards.stats(), images: diskImages.stats() }
  };
}

/**
 * Empty the caches. `what` is 'cards', 'upstream' or 'all'. Returns what went.
 *
 * Fetched logos are not thrown away, only marked stale: the next card that
 * needs one draws with the copy it has and fetches a new one behind it. Thrown
 * away, the next browse started cold, and a cold burst is what draws cards
 * around logos that missed their deadline. A host's 429 back-off is kept for
 * the same reason -- dropping it is how a throttle gets extended.
 */
function clearCache(what = 'all') {
  const before = { cards: rasterCache.size, finished: cardCache.size, upstream: cache.size, negatives: negatives.size };
  if (what === 'cards' || what === 'all') {
    rasterCache.clear();
    cardCache.clear();
    cardBytes = 0;
    diskCards.clear();
  }
  if (what === 'upstream' || what === 'all') {
    for (const entry of cache.values()) {
      entry.expiresAt = 0;
      entry.revalidate = true;
      delete entry.png;
    }
    negatives.clear();
    cardCache.clear();
    cardBytes = 0;
    // The copies on disk would come back fresh after a restart; the ones in
    // memory are kept, stale, for the reason above.
    diskCards.clear();
    diskImages.clear();
  }
  if (what === 'all') {
    crestColor.clear();
    try { require('./TeamLogoService').clearMemo(); } catch (_) { /* nothing memoised */ }
    stats.rasterHits = stats.rasterMisses = stats.fetchHits = stats.fetchMisses = 0;
    stats.cardHits = stats.cardMisses = 0;
  }
  return before;
}

/**
 * Whether a fetched image is held and still fresh -- or on disk and still
 * servable, which the warmer treats the same: one that is past its freshness
 * is refetched behind the first card that asks. Touches nothing.
 */
function hasFreshImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return false;
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expiresAt) return true;
  return diskImages.has(url);
}

/** For tests: forget everything held in memory, as a restart would, keeping the disk. */
function _forgetMemory() {
  rasterCache.clear();
  cardCache.clear();
  cardBytes = 0;
  cache.clear();
  cacheBytes = 0;
}

/** Cards drawn for an earlier art generation: no player will ask for them again. */
function pruneOldCards() {
  diskCards.clear(meta => !!meta && meta.v === artVersion());
}

module.exports = {
  sendCachedCard,
  coverMark,
  liftDarkMark,
  cacheStats,
  clearCache,
  svgPlaceholder,
  svgEvent,
  knockoutBackground,
  imageSize,
  eventUrl,
  rasterize,
  sendCard,
  cardColors,
  svgMatchup,
  wrapLines,
  getImage,
  toPng,
  artVersion,
  isCurrentArt,
  CACHE_CONTROL,
  matchupDecision,
  hasFreshCard,
  hasFreshImage,
  isStaleEntry,
  NEUTRAL_HALF,
  proxyUrl,
  placeholderUrl,
  matchupUrl,
  normalizeUrl,
  pruneOldCards,
  _forgetMemory,
  _disk: { cards: diskCards, images: diskImages }
};

// Once, at the start: the cards of an earlier generation go, the current ones stay.
pruneOldCards();
