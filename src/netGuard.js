/**
 * netGuard.js — keep fetches that a caller can influence on the public internet.
 *
 * The manifest proxy, the artwork routes and the embed fetcher all fetch a URL
 * that arrived in a query string. Unchecked, that makes this server a way into
 * whatever it can reach and the caller cannot: the internal resolver, the Docker
 * host, a router's admin page, a cloud metadata address. An audit mapped open
 * ports on the host that way from the outside, one error message at a time.
 *
 * Two layers:
 *   - assertPublicUrl() resolves the name first and refuses private answers.
 *   - publicAgent / guardedConnect() check at connect time, for every hop of a
 *     redirect and for the address actually dialled.
 *
 * The second layer only covers undici. impit, which the manifest proxy uses
 * first because stream hosts expect a browser's TLS handshake, resolves the
 * name again on its own, so there a name that answers publicly for the check
 * and privately a moment later (DNS rebinding) is caught by neither. The links
 * that reach that path are signed, so only a stream source serving a hostile
 * playlist could try it, and it gets back nothing unless the body happens to
 * be a playlist. Moving that path off impit would close it at the cost of
 * playback on the hosts that need the handshake.
 */

'use strict';

const dns = require('dns');
const net = require('net');
const { Agent, buildConnector } = require('undici');

// Addresses are compared as numbers against explicit prefixes. net.BlockList
// was tried first and refused every public IPv6 address -- which, in a
// container whose resolver answers with AAAA records, was every address.

const V4_BLOCKED = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],    // includes Docker's bridge networks
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4]       // reserved, broadcast
];
const V6_BLOCKED = [
  ['::', 96],            // unspecified, loopback, IPv4-compatible
  ['100::', 64],         // discard
  ['2001:db8::', 32],    // documentation
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // old site-local
  ['ff00::', 8]          // multicast
];
// IPv6 ranges that carry an IPv4 address in their last 32 bits, which is what
// decides: ::ffff:127.0.0.1 is loopback, 64:ff9b::8.8.8.8 is not.
const V6_EMBEDS_V4 = [['::ffff:0:0', 96], ['64:ff9b::', 96]];

function v4ToBig(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function v6ToBig(address) {
  let text = address;
  let tail = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = v4ToBig(dotted[2]);
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & 0xffffn)];
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = h => (h === '' ? [] : h.split(':').map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = groups(halves[0]);
  const back = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...back].some(Number.isNaN)) return null;
  const known = head.length + back.length + tail.length;
  let all;
  if (halves.length === 2) {
    if (known > 7) return null;
    all = [...head, ...new Array(8 - known).fill(0), ...back, ...tail];
  } else {
    all = [...head, ...tail];
  }
  if (all.length !== 8) return null;
  return all.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}

function inPrefix(value, base, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

const V4_RULES = V4_BLOCKED.map(([a, p]) => [v4ToBig(a), p]);
const V6_RULES = V6_BLOCKED.map(([a, p]) => [v6ToBig(a), p]);
const V6_EMBED_RULES = V6_EMBEDS_V4.map(([a, p]) => [v6ToBig(a), p]);

/** True for anything that is not a public unicast address, or not an address. */
function isBlockedAddress(ip) {
  const address = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(address);
  if (family === 4) {
    const n = v4ToBig(address);
    return n === null || V4_RULES.some(([base, p]) => inPrefix(n, base, p, 32));
  }
  if (family !== 6) return true;
  const n = v6ToBig(address);
  if (n === null) return true;
  if (V6_EMBED_RULES.some(([base, p]) => inPrefix(n, base, p, 128))) {
    const inner = n & 0xffffffffn;
    return V4_RULES.some(([base, p]) => inPrefix(inner, base, p, 32));
  }
  return V6_RULES.some(([base, p]) => inPrefix(n, base, p, 128));
}

function blockedError(what) {
  const err = new Error(`refused to fetch a private address (${what})`);
  err.code = 'E_PRIVATE_ADDRESS';
  return err;
}

/**
 * Throws unless the URL is http(s) and its host resolves only to public
 * addresses. WHATWG URL has already turned odd spellings such as
 * http://2130706433/ or http://0x7f.1/ into 127.0.0.1 by the time this looks.
 */
async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw blockedError('not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw blockedError(url.protocol);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw blockedError(host);
    return;
  }
  const answers = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => isBlockedAddress(a.address))) throw blockedError(host);
}

/** dns.lookup, minus every private answer. Used when a socket connects. */
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, answers) => {
    if (err) return callback(err);
    const usable = answers.filter(a => !isBlockedAddress(a.address));
    if (!usable.length) return callback(blockedError(hostname));
    if (options.all) return callback(null, usable);
    callback(null, usable[0].address, usable[0].family);
  });
}

/**
 * An undici connector that refuses private destinations. A literal IP skips
 * DNS entirely, so it is checked here; a name goes through guardedLookup.
 */
function guardedConnect(options = {}) {
  const connect = buildConnector({ timeout: 10000, ...options, lookup: guardedLookup });
  return (opts, callback) => {
    const host = String(opts.hostname || '').replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host)) return callback(blockedError(host), null);
    return connect(opts, callback);
  };
}

const publicAgent = new Agent({
  connect: guardedConnect({ timeout: 5000 }),
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000
});

module.exports = { isBlockedAddress, assertPublicUrl, guardedLookup, guardedConnect, publicAgent };
