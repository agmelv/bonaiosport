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
const redirectAgent = new Agent().compose(interceptors.redirect({ maxRedirections: 3 }));

// Generated cards are cached for a day by the client, and the URL for a given
// fixture is the same before and after a change to how they're drawn — so a
// restyle would leave viewers looking at the old artwork until the TTL expired.
// Bump this whenever svgMatchup() or svgPlaceholder() changes what they draw;
// it rides along in every generated image URL and retires the stale copies.
const RENDER_VERSION = 3;
const crestColor = require('./CrestColorService');
const crypto = require('crypto');
const sharp = require('sharp');

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
const stats = { rasterHits: 0, rasterMisses: 0, fetchHits: 0, fetchMisses: 0 };

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

/**
 * Send a generated card, rasterised unless ?format=svg was asked for. A
 * rasteriser failure falls back to the SVG rather than to no image at all.
 */
async function sendCard(req, res, svg, cacheControl) {
  res.setHeader('Cache-Control', cacheControl);
  if (String(req.query.format || '').toLowerCase() === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  }
  try {
    const jpeg = await rasterize(svg);
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(jpeg);
  } catch (err) {
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
    if (W && H && C === 4) {
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
      const dist = (i) => Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
      const TOL = 42;
      let uniform = 0;
      for (const p of edge) if (dist(p * 4) <= TOL) uniform++;

      if (clear / edge.length < 0.2 && uniform / edge.length >= 0.9) {
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
        if (legible && share >= 0.05 && share <= 0.97) {
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
      const value = (p) => Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) / 255;
      const clearAt = (p) => data[p * 4 + 3] < 128;
      const darkAt = (p) => data[p * 4 + 3] > 0 && value(p) < DARK;

      let opaque = 0, dark = 0, clear = 0;
      for (let p = 0; p < N; p++) {
        if (clearAt(p)) { clear++; continue; }
        opaque++;
        if (value(p) < DARK) dark++;
      }
      if (opaque && clear / N >= 0.05 && dark / opaque >= 0.2) {
        const lift = new Uint8Array(N);
        const stack = [];
        for (let p = 0; p < N; p++) {
          if (!darkAt(p)) continue;
          const x = p % W;
          if ((x > 0 && clearAt(p - 1)) || (x < W - 1 && clearAt(p + 1))
            || (p >= W && clearAt(p - W)) || (p < N - W && clearAt(p + W))) stack.push(p);
        }
        let reached = 0;
        while (stack.length) {
          const p = stack.pop();
          if (lift[p] || !darkAt(p)) continue;
          lift[p] = 1;
          if (!clearAt(p)) reached++;
          const x = p % W;
          if (x > 0) stack.push(p - 1);
          if (x < W - 1) stack.push(p + 1);
          if (p >= W) stack.push(p - W);
          if (p < N - W) stack.push(p + W);
        }
        // A dark shape holding light detail -- white lettering on a navy box,
        // as in LiveNOW from FOX -- is a box, not a stroke, and lifting it
        // puts white on white. Such a shape borders light pixels about as much
        // as it borders the open background; a dark wordmark borders almost
        // nothing but open background.
        let openEdges = 0, lightEdges = 0;
        const edge = (q) => {
          if (clearAt(q)) { openEdges++; return; }
          if (lift[q]) return;
          const i = q * 4;
          const mx = Math.max(data[i], data[i + 1], data[i + 2]);
          const mn = Math.min(data[i], data[i + 1], data[i + 2]);
          if (mx >= 178 && (mx - mn) / mx < 0.25) lightEdges++;
        };
        for (let p = 0; p < N; p++) {
          if (!lift[p] || clearAt(p)) continue;
          const x = p % W;
          if (x > 0) edge(p - 1);
          if (x < W - 1) edge(p + 1);
          if (p >= W) edge(p - W);
          if (p < N - W) edge(p + W);
        }
        const boxed = lightEdges > openEdges * 0.3;
        if (!boxed && reached / opaque >= 0.12) {
          for (let p = 0; p < N; p++) {
            if (!lift[p]) continue;
            // Fully dark goes to near-white; the band just under the threshold
            // blends, so the edge between a lifted and an unlifted colour does
            // not step.
            const t = Math.min(1, (DARK - value(p)) / 0.06);
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
 * because the box is the only thing making it legible.
 */
async function coverMark(entry) {
  if (!entry || !entry.buffer) return entry;
  const plain = (await knockoutBackground(entry.buffer)) || entry;
  const opened = (await knockoutBackground(entry.buffer, { allowDark: true })) || entry;
  return (await liftDarkMark(opened.buffer)) || plain;
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
  // down. It sits above centre, leaving the lower part of the card for the
  // channel's name.
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
      const scale = Math.min(maxW / nw, maxH / nh, 1);
      boxW = Math.max(1, Math.round(nw * scale));
      boxH = Math.max(1, Math.round(nh * scale));
    }
    boxX = Math.round((w - boxW) / 2);
    boxY = Math.round((coverMode ? 180 : h / 2) - boxH / 2);
  }

  const lines = wrapLines(text, 26, 3);
  const fs = lines.length >= 3 ? 34 : lines.length === 2 ? 40 : 44;
  const startY = 300;
  const textEls = lines.map((line, i) =>
    `<text x="50%" y="${(startY + i * (fs + 8)).toFixed(1)}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle" filter="url(#pdrop)">${escapeXml(line)}</text>`
  ).join('\n  ');

  // A cover's name: one clean line under the logo, two at most, no shadow.
  // It is what tells ESPN US from ESPN NZ, whose logos are the same.
  // With no logo the name is the whole card, so it moves to the middle and
  // grows; with one it sits under the logo.
  const hasMark = !!(entry && entry.buffer);
  const coverLines = wrapLines(text, 24, 2);
  const cfs = hasMark
    ? (coverLines.length === 2 ? 34 : (String(text).length > 18 ? 38 : 44))
    : (coverLines.length === 2 ? 46 : (String(text).length > 18 ? 50 : 58));
  const coverTop = hasMark
    ? (coverLines.length === 2 ? 322 : 344)
    : (coverLines.length === 2 ? 234 - (cfs + 10) / 2 : 234);
  const coverTextEls = coverLines.map((line, i) =>
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
  ${kickerEl}
  ${uri ? `${showPlate ? `<rect x="${plateX.toFixed(1)}" y="${plateY}" width="${plate}" height="${plate}" rx="30" fill="#ffffff" fill-opacity="0.95" filter="url(#pdrop)"/>` : ''}
  <image x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW}" height="${boxH}" preserveAspectRatio="xMidYMid meet" href="${uri}" xlink:href="${uri}"${showPlate || cover ? '' : ' filter="url(#pdrop)"'}/>` : ''}
  ${coverMode ? coverTextEls : (showName ? textEls : '')}
</svg>`;
}

function evictIfNeeded() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byAccess = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const excess = cache.size - CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) cache.delete(byAccess[i][0]);
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

  const now = Date.now();
  const neg = negatives.get(url);
  if (neg) {
    if (now < neg) return null; // recently failed/slow: do not re-attempt yet
    negatives.delete(url);
  }

  const hit = cache.get(url);
  if (hit) {
    if (now < hit.expiresAt) { hit.lastAccess = now; stats.fetchHits++; return hit; }
    cache.delete(url);
  }
  stats.fetchMisses++;

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
  // The proxy's own fallback is a generated card, so it versions too.
  return `${baseUrl}/img?url=${encodeURIComponent(validUrl)}&text=${encodeURIComponent(text)}&color=${color}&v=${RENDER_VERSION}`;
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
  q.push(`v=${RENDER_VERSION}`);
  return `${baseUrl}/img/event?${q.join('&')}`;
}

function placeholderUrl(baseUrl, text, color) {
  return `${baseUrl}/img/placeholder?text=${encodeURIComponent(text || '')}&color=${color || '333333'}&v=${RENDER_VERSION}`;
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
  q.push(`v=${RENDER_VERSION}`);
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
    negatives: negatives.size,
    quality: RASTER_QUALITY
  };
}

/**
 * Empty the caches. `what` is 'cards', 'upstream' or 'all'. Returns what went.
 */
function clearCache(what = 'all') {
  const before = { cards: rasterCache.size, upstream: cache.size, negatives: negatives.size };
  if (what === 'cards' || what === 'all') rasterCache.clear();
  if (what === 'upstream' || what === 'all') { cache.clear(); negatives.clear(); }
  if (what === 'all') {
    stats.rasterHits = stats.rasterMisses = stats.fetchHits = stats.fetchMisses = 0;
  }
  return before;
}

module.exports = {
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
  proxyUrl,
  placeholderUrl,
  matchupUrl,
  normalizeUrl
};
