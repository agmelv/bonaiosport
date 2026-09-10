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

const { request, Agent, interceptors } = require('undici');

// The soccer feeds serve every crest as a 302 to their CDN. Plain request()
// hands back the redirect itself, the 200-only check in getImage() rejects it,
// and the card falls back to a name plate — which is why no soccer fixture had
// a crest. undici 8 dropped the maxRedirections option in favour of this.
const redirectAgent = new Agent().compose(interceptors.redirect({ maxRedirections: 3 }));
const crestColor = require('./CrestColorService');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const IMAGE_TTL_MS = 10 * 60 * 1000;   // 10 minutes
const CACHE_MAX_ENTRIES = 120;
const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 3000;

const cache = new Map();     // url -> { buffer, contentType, expiresAt }
const inFlight = new Map();  // url -> Promise
const negatives = new Map(); // url -> expiry ts (recently failed/slow sources)

const NEG_TTL_MS = 60 * 1000;

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
  const bg = accentColor(color);
  const lines = wrapLines(text, 24, 5);
  const fontSize = lines.length >= 5 ? 34 : lines.length === 4 ? 40 : lines.length === 3 ? 44 : lines.length === 2 ? 52 : 58;
  const lead = fontSize + 12;
  const startY = h / 2 - ((lines.length - 1) * lead) / 2;
  const textEls = lines.map((line, i) => {
    const y = startY + i * lead;
    const isVs = /^(vs|v|at|-)$/i.test(line);
    return `<text x="50%" y="${y.toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${isVs ? Math.round(fontSize * 0.6) : fontSize}" font-weight="${isVs ? 400 : 700}" fill="${isVs ? '#9aa0a6' : '#ffffff'}" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#111111"/>
  <rect x="0" y="0" width="${w}" height="10" fill="${bg}"/>
  <rect x="0" y="${h - 10}" width="${w}" height="10" fill="${bg}"/>
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
function cardColors(aStats, bStats, fallback) {
  const hexOk = v => (/^([0-9a-fA-F]{6})$/.test(String(v)) ? String(v) : null);
  const base = hexOk(fallback) || '1f2430';
  const read = st => {
    if (!st) return { colors: [], light: 0 };
    if (Array.isArray(st)) return { colors: st.map(hexOk).filter(Boolean), light: 1 };
    return { colors: (st.colors || []).map(hexOk).filter(Boolean), light: st.light || 0 };
  };
  const A = read(aStats);
  const B = read(bStats);

  const spread = (x, y) => [0, 1, 2].reduce((acc, i) =>
    acc + Math.abs(parseInt(x.slice(i * 2, i * 2 + 2), 16) - parseInt(y.slice(i * 2, i * 2 + 2), 16)), 0);

  // A crest with no colour at all (a black-and-white badge) has no half of its
  // own. A dark shade of the opponent's colour keeps the card coherent; the
  // category colour nudged lighter produced washed-out pinks.
  let a = A.colors[0] || (B.colors.length ? shade(B.colors[0], -0.55) : base);
  // Two teams that both come back orange stop reading as two halves. Prefer a
  // colour the crest actually wears over distorting its primary one.
  let b = B.colors.find(c => spread(c, a) >= 90) || B.colors[0] ||
    (A.colors.length ? shade(A.colors[0], -0.55) : base);

  // Crests sit on top of this, most of them white-heavy, so a very light half
  // would swallow its own logo. Only the genuinely light colours get pulled
  // down, and gently: darkening an orange toward black turns it to mud.
  //
  // The opposite failure needs the crest's own make-up to spot: a dark crest
  // WITH a white outline reads fine on a dark half, while one without it
  // (Richmond's solid navy spider) disappears — so only that second kind gets
  // its half lifted.
  const seat = (c, stats, derived) => {
    const l = luminance(c);
    if (l > 0.75) return shade(c, -0.38);
    if (l > 0.45) return shade(c, -0.26);
    if (l > 0.20) return shade(c, -0.16);
    if (!derived && l < 0.15 && stats.light < 0.12) return shade(c, 0.32);
    if (l < 0.04) return shade(c, 0.10);
    return c;
  };
  a = seat(a, A, !A.colors.length);
  b = seat(b, B, !B.colors.length);

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
    crestColor.paletteForCrest(aUrl, aEntry),
    crestColor.paletteForCrest(bUrl, bEntry),
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

function evictIfNeeded() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byAccess = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const excess = cache.size - CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) cache.delete(byAccess[i][0]);
}

/**
 * Fetch a remote image once, validate it, cache it. Returns
 * { buffer, contentType } or null on any failure.
 */
async function getImage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;

  const now = Date.now();
  const neg = negatives.get(url);
  if (neg) {
    if (now < neg) return null; // recently failed/slow: do not re-attempt yet
    negatives.delete(url);
  }

  const hit = cache.get(url);
  if (hit) {
    if (now < hit.expiresAt) { hit.lastAccess = now; return hit; }
    cache.delete(url);
  }

  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = (async () => {
    let result = null;
    try {
      // AbortSignal caps the TOTAL request (headers + body): a slow-loris upstream
      // that trickles bytes can otherwise hang past headersTimeout/bodyTimeout.
      const res = await request(url, {
        headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' },
        headersTimeout: FETCH_TIMEOUT_MS,
        bodyTimeout: FETCH_TIMEOUT_MS,
        dispatcher: redirectAgent,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS + 1000)
      });

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
        if (!tooBig && total >= 32) {
          result = {
            buffer: Buffer.concat(chunks),
            contentType,
            expiresAt: Date.now() + IMAGE_TTL_MS,
            lastAccess: Date.now()
          };
          cache.set(url, result);
          evictIfNeeded();
        }
      }
    } catch (_) {
      result = null;
    } finally {
      inFlight.delete(url);
    }
    if (result) negatives.delete(url);
    else {
      negatives.set(url, Date.now() + NEG_TTL_MS);
      if (negatives.size > 500) negatives.clear();
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
  return `${baseUrl}/img?url=${encodeURIComponent(validUrl)}&text=${encodeURIComponent(text)}&color=${color}`;
}

function placeholderUrl(baseUrl, text, color) {
  return `${baseUrl}/img/placeholder?text=${encodeURIComponent(text || '')}&color=${color || '333333'}`;
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
function matchupUrl(baseUrl, { a, b, aLogo, bLogo, aLogos, bLogos, color = '333333', fallback = null }) {
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
  return `${baseUrl}/img/matchup?${q.join('&')}`;
}

module.exports = {
  svgPlaceholder,
  cardColors,
  svgMatchup,
  wrapLines,
  getImage,
  proxyUrl,
  placeholderUrl,
  matchupUrl,
  normalizeUrl
};
