'use strict';

/**
 * Derives a team's colour from its own crest.
 *
 * The matchup card wants each side painted in that club's colours. ESPN does
 * publish a `color` field per team, but only for the leagues in the bundled
 * table — soccer crests arrive as provider-supplied URLs with no metadata at
 * all, and soccer is the majority of our fixtures. Reading the crest itself is
 * the one source that covers every card.
 *
 * PNG only, and deliberately so: every crest we serve is a PNG (ESPN's
 * /i/teamlogos/... 500px assets and the soccer feeds' copies of them). Anything
 * else returns null and the caller falls back to the category colour rather
 * than shipping a wrong one.
 */

const zlib = require('zlib');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Bytes per pixel by PNG colour type. Indexes are the spec's type numbers;
// holes (1, 5) are invalid types.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const cache = new Map();
const CACHE_MAX = 500;

function parseChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  const out = { idat: [], plte: null, trns: null, ihdr: null };
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) break;
    if (type === 'IHDR') {
      out.ihdr = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8],
        colorType: buf[start + 9],
        interlace: buf[start + 12]
      };
    } else if (type === 'PLTE') out.plte = buf.subarray(start, end);
    else if (type === 'tRNS') out.trns = buf.subarray(start, end);
    else if (type === 'IDAT') out.idat.push(buf.subarray(start, end));
    else if (type === 'IEND') break;
    off = end + 4; // skip CRC
  }
  return out.ihdr ? out : null;
}

/** Undo per-scanline filtering in place, returning raw samples. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      switch (filter) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (v + pred) & 0xff;
          break;
        }
        default: return null; // unknown filter: refuse rather than guess
      }
    }
  }
  return out;
}

function rgbToHsv(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function toHex(r, g, b) {
  return [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/**
 * The crest's colours, strongest first, as 6-digit hex strings — or null.
 *
 * More than one matters: when both teams in a fixture come back the same colour
 * (two oranges) the card stops reading as two halves, and the second-strongest
 * colour of one crest (Miami's green behind its orange) separates them without
 * inventing a colour the club doesn't wear.
 *
 * Crests are mostly white/black outline and transparent background, so a plain
 * average returns grey every time. Instead: drop transparent, near-white,
 * near-black and washed-out pixels, bucket what remains by hue, and average the
 * heaviest bucket. A crest with no saturated pixels at all (a plain white
 * wordmark) legitimately has no colour — those return null.
 */
function palette(buffer, max = 3) {
  const png = parseChunks(buffer);
  if (!png) return null;
  const { width, height, bitDepth, colorType, interlace } = png.ihdr;
  // 8-bit non-interlaced covers every crest we've seen; the rest is not worth
  // carrying a decoder for, and a wrong colour is worse than the fallback.
  if (bitDepth !== 8 || interlace !== 0 || !CHANNELS[colorType]) return null;
  if (!width || !height || width * height > 4_000_000) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(png.idat));
  } catch {
    return null;
  }

  const bpp = CHANNELS[colorType];
  if (raw.length < (width * bpp + 1) * height) return null;
  const px = unfilter(raw, width, height, bpp);
  if (!px) return null;

  // 24 hue buckets: fine enough to keep navy and royal blue apart, coarse
  // enough that anti-aliasing on an edge doesn't split a crest's own colour.
  const BUCKETS = 24;
  const bins = Array.from({ length: BUCKETS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  // Whether the crest carries light pixels of its own — a white outline or
  // wordmark. One that does reads fine on a dark half; one that doesn't
  // (Richmond's solid navy spider) vanishes into a background derived from its
  // own colour, and the caller lifts that half instead.
  let opaque = 0;
  let light = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * bpp;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const idx = px[i];
        if (!png.plte || idx * 3 + 2 >= png.plte.length) continue;
        r = png.plte[idx * 3]; g = png.plte[idx * 3 + 1]; b = png.plte[idx * 3 + 2];
        if (png.trns && idx < png.trns.length) a = png.trns[idx];
      } else if (colorType === 0) {
        r = g = b = px[i];
      } else if (colorType === 4) {
        r = g = b = px[i]; a = px[i + 1];
      } else {
        r = px[i]; g = px[i + 1]; b = px[i + 2];
        if (colorType === 6) a = px[i + 3];
      }
      if (a < 128) continue;
      opaque++;

      const { h, s, v } = rgbToHsv(r, g, b);
      if (v > 0.82) light++;
      // White is already excluded by the saturation test above; a separate
      // brightness ceiling would throw away a pure, fully-saturated crest
      // colour (an orange at v=1.0 is exactly what we want to keep).
      if (s < 0.25 || v < 0.15) continue;
      const bin = bins[Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS))];
      // Weight by saturation so a crest's true colour outvotes a large wash of
      // barely-tinted pixels.
      const w = s * v;
      bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
    }
  }

  const ranked = bins
    .filter(bin => bin.w >= 1)
    .sort((x, y) => y.w - x.w)
    .slice(0, max)
    .map(bin => toHex(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w));
  return { colors: ranked, light: opaque ? light / opaque : 0 };
}

/** The single strongest colour — palette()[0], kept for callers that want one. */
function dominantColor(buffer) {
  const p = palette(buffer, 1);
  return p && p.colors.length ? p.colors[0] : null;
}

/** Cached by crest URL — the same crests recur across an entire catalog page. */
function paletteForCrest(url, entry) {
  if (!entry || !entry.buffer) return null;
  // By size as well as URL: a crest replaced upstream under the same address
  // gets its own palette.
  const key = url ? `${url}|${entry.buffer.length}` : null;
  if (key && cache.has(key)) return cache.get(key);
  let colors = null;
  try {
    colors = palette(entry.buffer);
  } catch {
    colors = null;
  }
  if (key) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, colors);
  }
  return colors;
}

// Official team colours, keyed like the crests ("nfl/mia"), taken from ESPN's
// team lists at build time (scripts/build-espn-teams.js). A crest's pixels are
// a poor witness to a team's colours: the Raiders' silver-and-black shield has
// no colour in it at all, and the Dolphins' aqua outweighs their orange by a
// few percent of pixels. Without the table, palettes alone, as before.
let BRAND = null;
function brandTable() {
  if (BRAND === null) {
    try { BRAND = require('./data/espn-team-colors.json'); } catch { BRAND = {}; }
  }
  return BRAND;
}

// TeamLogoService's crest key, repeated rather than required so this module
// keeps no dependencies. Rugby crests carry an extra "teams" segment
// (teamlogos/rugby/teams/500/<id>.png), as the build script knows.
function crestKey(url) {
  const m = /\/teamlogos\/([^/]+)\/(?:teams\/)?\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i.exec(String(url || ''));
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : '';
}

/** A team's official [primary, alternate] colours for a crest URL, or null. */
function brandForCrest(url) {
  const k = crestKey(url);
  const colors = k ? brandTable()[k] : null;
  if (!Array.isArray(colors)) return null;
  const valid = colors.map(c => String(c || '').toLowerCase()).filter(c => /^[0-9a-f]{6}$/.test(c));
  // Black and one shade of red is ESPN's stand-in for "no colours on file",
  // shared by over a hundred clubs. It says nothing about any of them.
  if (valid.length === 2 && valid[0] === '000000' && valid[1] === 'c60000') return null;
  return valid.length ? valid : null;
}

/** A colour at all, by the same test palette() applies to crest pixels. */
function isChromatic(hex) {
  const n = parseInt(hex, 16);
  const { s, v } = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return s >= 0.25 && v >= 0.15;
}

/** Everything a card's colours are chosen from, for one side. */
function statsForCrest(url, entry) {
  const p = paletteForCrest(url, entry);
  return {
    colors: p ? p.colors : [],
    // null, not 0, when the crest could not be read (a JPEG, WebP, SVG or an
    // unusual PNG): unknown is not "dark".
    light: p ? p.light : null,
    crest: !!(entry && entry.buffer),
    brand: brandForCrest(url) || []
  };
}

function clear() {
  cache.clear();
}

module.exports = { palette, dominantColor, paletteForCrest, rgbToHsv, brandForCrest, isChromatic, statsForCrest, clear };
