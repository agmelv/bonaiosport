/**
 * segmentPolicy.js — which hosts' media this server relays for the player.
 *
 * A CDN that refuses any TLS handshake but a browser's cannot be told apart
 * from the outside; it has to be tried. When a playlist names media on a host
 * not seen before, one chunk is fetched the way a player would -- a plain
 * client sending a browser's headers. If that is refused and the
 * browser-fingerprint client is not, the host's media is relayed
 * (playlistRewrite.js, the /api/segment route); if a player can fetch it, it
 * stays direct, which costs this server nothing. The answer is kept for hours
 * per host and across restarts, so the one chunk is fetched once, not per
 * viewer or per playlist. When it is time to ask again, the old answer keeps
 * being served until the new one lands, and a try that learns nothing -- a
 * timeout, a chunk that has gone -- keeps it too: a host proven to refuse a
 * player is not handed back to the player on a blip.
 *
 * Streamed's strmd.st is relayed without asking, having been measured; it
 * also puts chunks on other hosts under other names, which is what the probe
 * is for. PROXY_SEGMENT_HOSTS names hosts to relay without asking, or "off"
 * relays none and probes nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { request } = require('undici');
const { DATA_DIR } = require('./config');
const { assertPublicUrl, publicAgent } = require('./netGuard');
const { getImpit } = require('./impitClient');
const { proxiedHosts, relayDisabled, needsSegmentProxy, absoluteEntry } = require('./playlistRewrite');

// How long an answer stands before the host is asked again.
const RELAY_TTL_MS = 6 * 60 * 60 * 1000;
const DIRECT_TTL_MS = 6 * 60 * 60 * 1000;
// A try that answered something other than a refusal (a 404, a 5xx) is looked
// at again sooner: the next playlist may name a chunk that exists.
const UNSURE_TTL_MS = 10 * 60 * 1000;
const ERROR_TTL_MS = 2 * 60 * 1000;
// An answer nobody has asked about for this long is forgotten.
const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// A playlist poll waits on this once per host, so it is short: each client
// gets its own try within one overall budget, and the second is not robbed of
// its whole turn by a slow first.
const PROBE_BUDGET_MS = 4000;
const PROBE_TRY_MS = 2500;
const PROBE_MAX_BYTES = 64 * 1024;
const PROBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const MAX_DECIDED = 500;
const STATE_FILE = path.join(DATA_DIR, 'segment-policy.json');
const SAVE_AFTER_MS = 5000;

const decided = new Map();   // host -> { relay, until, at }
const probing = new Map();   // host -> Promise<boolean>
let saveTimer = null;

const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

function load() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return; }   // first run
  if (!saved || !Array.isArray(saved.hosts)) return;
  const now = Date.now();
  for (const entry of saved.hosts) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
    const r = entry[1];
    if (num(r.at) < now - FORGET_AFTER_MS) continue;
    decided.set(entry[0].toLowerCase(), { relay: !!r.relay, until: Math.min(num(r.until), now + RELAY_TTL_MS), at: num(r.at) });
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ hosts: [...decided] }));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) {
      // A data directory that cannot be written costs the memory across restarts, nothing else.
    }
  }, SAVE_AFTER_MS);
  if (saveTimer.unref) saveTimer.unref();
}

load();

/** Read a little of a body, then let it go: enough to know the answer. */
async function drain(body) {
  let n = 0;
  try {
    for await (const chunk of body) { n += chunk.length; if (n >= PROBE_MAX_BYTES) break; }
  } catch (e) { /* the answer was the status */ }
  try { if (body && body.destroy) body.destroy(); } catch (e) { /* already gone */ }
}

/** The status a player's own client gets. */
async function plainFetch(url, headers, signal) {
  const r = await request(url, { headers, signal, dispatcher: publicAgent, headersTimeout: PROBE_TRY_MS, bodyTimeout: PROBE_TRY_MS });
  await drain(r.body);
  return r.statusCode;
}

/** The status the browser-fingerprint client gets, or 0 without one. */
async function browserFetch(url, headers, signal) {
  const impit = getImpit();
  if (!impit) return 0;
  const r = await impit.fetch(url, { headers, signal, timeout: PROBE_TRY_MS });
  // A little of the body, as above; a host that ignores the Range header
  // would otherwise be read whole.
  try {
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      let n = 0;
      while (n < PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value ? value.byteLength : 0;
      }
      await reader.cancel().catch(() => {});
    }
  } catch (e) { /* the status is the answer */ }
  return r.status;
}

/**
 * One try of a host. `prev` is what was known before, kept whenever this
 * try learns nothing new.
 */
async function probe(sampleUrl, referer, origin, deps, prev) {
  const plain = (deps && deps.plain) || plainFetch;
  const browser = (deps && deps.browser) || browserFetch;
  const assertPublic = (deps && deps.assertPublic) || assertPublicUrl;
  const headers = { 'User-Agent': PROBE_UA, Range: `bytes=0-${PROBE_MAX_BYTES - 1}` };
  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  const keep = (ttl) => ({ relay: prev ? !!prev.relay : false, ttl });
  const deadline = Date.now() + PROBE_BUDGET_MS;
  // One try, bounded: its own turn, or what is left of the whole budget.
  const attempt = async (fn) => {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), Math.max(500, Math.min(PROBE_TRY_MS, deadline - Date.now())));
    try { return await fn(control.signal); } finally { clearTimeout(timer); }
  };
  try { await assertPublic(sampleUrl); } catch (e) { return keep(ERROR_TTL_MS); }
  let p;
  try { p = await attempt(signal => plain(sampleUrl, headers, signal)); } catch (e) { return keep(ERROR_TTL_MS); }
  if (p >= 200 && p < 300) return { relay: false, ttl: DIRECT_TTL_MS };
  // Only a refusal can be a fingerprint refusal. Anything else -- a 404, a
  // 5xx -- is the chunk or the host, and says nothing about the client.
  if (p !== 403 && p !== 401 && p !== 429) return keep(UNSURE_TTL_MS);
  let b;
  try { b = await attempt(signal => browser(sampleUrl, headers, signal)); } catch (e) {
    // The player is certain to be refused; the relay was merely slow to
    // answer. Relay, and ask again soon.
    return { relay: true, ttl: ERROR_TTL_MS };
  }
  return b >= 200 && b < 300 ? { relay: true, ttl: RELAY_TTL_MS } : keep(UNSURE_TTL_MS);
}

function remember(host, verdict) {
  if (decided.size >= MAX_DECIDED) {
    const now = Date.now();
    for (const [h, d] of decided) if (d.until <= now) decided.delete(h);
    if (decided.size >= MAX_DECIDED) decided.delete(decided.keys().next().value);
  }
  decided.set(host, { relay: verdict.relay, until: Date.now() + verdict.ttl, at: Date.now() });
  save();
}

/**
 * Whether media on `host` is relayed, deciding by a probe of `sampleUrl` when
 * the host is new. An answer that is due for renewal is served while the
 * renewal runs. Resolves within the probe budget. `deps` lets a test stand in
 * for the two clients and the private-address check, whose DNS lookup would
 * otherwise refuse every made-up host.
 */
async function shouldRelay(host, sampleUrl, referer = '', origin = '', deps = null) {
  if (relayDisabled()) return false;
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (needsSegmentProxy(h, proxiedHosts())) return true;
  const known = decided.get(h);
  if (known && known.until > Date.now()) return known.relay;
  if (!sampleUrl) return known ? known.relay : false;
  let pending = probing.get(h);
  if (!pending) {
    pending = probe(sampleUrl, referer, origin, deps, known).then(verdict => {
      remember(h, verdict);
      if (verdict.relay && !(known && known.relay)) console.log(`[SegmentPolicy] relaying media on ${h}: a plain client is refused, a browser is not`);
      return verdict.relay;
    }).finally(() => probing.delete(h));
    probing.set(h, pending);
  }
  return known ? known.relay : pending;
}

/**
 * Whether a host's media is relayed as things stand, without probing: what
 * the relay route asks before it fetches anything, so a link is only ever
 * served for a host the playlist rewriting would have pointed at it -- and
 * "off" means off, whatever links are still in players' hands. A verdict
 * due for renewal still counts: the links out there were minted on it.
 */
function isRelayedHost(host) {
  if (relayDisabled()) return false;
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (needsSegmentProxy(h, proxiedHosts())) return true;
  const known = decided.get(h);
  return !!(known && known.relay);
}

const TAG_WITH_URI = /^#EXT-X-(KEY|SESSION-KEY|MAP)\b/;
const OPAQUE = /^(data|skd|blob|about):/i;

/**
 * The hosts a playlist's media lives on, each with one address to try --
 * resolved exactly as the rewrite will resolve it, token and all.
 * Sub-playlists are not media and are always proxied anyway.
 */
function mediaHosts(body, targetUrl, finalUrl) {
  const out = new Map();
  const note = (raw) => {
    if (OPAQUE.test(raw.trim())) return;
    const abs = absoluteEntry(raw, targetUrl, finalUrl);
    if (abs.includes('.m3u8')) return;
    const h = hostOf(abs);
    if (h && !out.has(h)) out.set(h, abs);
  };
  for (const line of String(body).split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (!TAG_WITH_URI.test(l)) continue;
      const m = l.match(/URI="([^"]*)"/);
      if (m && m[1]) note(m[1]);
      continue;
    }
    note(l);
  }
  return out;
}

/** The hosts in a playlist whose media should be relayed, exact names. */
async function relayHostsFor(body, targetUrl, finalUrl, referer, origin, deps = null) {
  const hosts = [];
  await Promise.all([...mediaHosts(body, targetUrl, finalUrl)].map(async ([host, sample]) => {
    if (await shouldRelay(host, sample, referer, origin, deps)) hosts.push(host);
  }));
  return hosts;
}

/** For tests: forget everything, plant an answer, or read the file back. */
function _reset() { decided.clear(); probing.clear(); clearTimeout(saveTimer); }
function _remember(host, relay, until) { decided.set(String(host).toLowerCase(), { relay, until, at: Date.now() }); }
function _load() { decided.clear(); load(); }
function _flush() { clearTimeout(saveTimer); save(); clearTimeout(saveTimer); saveTimer = null; try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ hosts: [...decided] })); } catch (e) { /* tests */ } }

module.exports = {
  shouldRelay, relayHostsFor, mediaHosts, isRelayedHost, _reset, _remember, _load, _flush,
  PROBE_BUDGET_MS, RELAY_TTL_MS
};
