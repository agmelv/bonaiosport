/**
 * manifestLink.js — signed links to the manifest proxy.
 *
 * /api/manifest fetches the playlist named in its query string. Left open, any
 * URL anyone liked could be fed to it, and the server would fetch it from the
 * owner's own connection. Every link a provider hands out is minted here
 * instead, with an HMAC over the url, referer and origin it carries, and the
 * route refuses a link whose signature does not match. A player follows the
 * links it was given, so nothing it does changes; someone typing their own URL
 * into the query string gets a 403.
 *
 * The key is LINK_SECRET when set. Otherwise one is made once and kept in the
 * data directory, so links handed out before a restart still play after it.
 * Where that directory is not writable the key lasts as long as the process,
 * and a player that was mid-stream across a restart simply asks for streams
 * again.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let secret = null;

function readKey(file) {
  try {
    const key = fs.readFileSync(file, 'utf8').trim();
    return key.length >= 32 ? key : null;
  } catch { return null; }
}

function linkSecret() {
  if (secret) return secret;
  const fromEnv = String(process.env.LINK_SECRET || '').trim();
  if (fromEnv) return (secret = fromEnv);

  const dir = require('./config').DATA_DIR;
  const file = path.join(dir, 'link-secret');
  const kept = readKey(file);
  if (kept) return (secret = kept);

  const made = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 'wx' fails if another start got there first; theirs is then the key.
    fs.writeFileSync(file, made, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    const theirs = readKey(file);
    if (theirs) return (secret = theirs);
    if (err && err.code === 'EEXIST') {
      // There, but not a usable key -- empty after a crash or a full disk.
      // Left alone, every restart would sign with a fresh key and break every
      // link handed out before it, with nothing in the log to say why.
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, made, { mode: 0o600 });
        fs.renameSync(tmp, file);
        console.warn('[manifestLink] replaced an unusable link-secret file');
      } catch { /* this run keeps the key in memory */ }
    }
  }
  return (secret = made);
}

function signature(url, referer, origin) {
  return crypto.createHmac('sha256', linkSecret())
    .update(`${url}\n${referer}\n${origin}`)
    .digest('base64url')
    .slice(0, 32);
}

/** The path of a signed proxy link: /api/manifest?url=…&referer=…&origin=…&sig=… */
function manifestPath(url, referer = '', origin = '') {
  return `/api/manifest?url=${encodeURIComponent(url)}`
    + `&referer=${encodeURIComponent(referer)}`
    + `&origin=${encodeURIComponent(origin)}`
    + `&sig=${signature(url, referer, origin)}`;
}

/** Whether a request's url, referer and origin are the ones that were signed. */
function verifyManifestQuery(query) {
  const str = v => (typeof v === 'string' ? v : null);
  const url = str(query.url);
  const sig = str(query.sig);
  const referer = query.referer === undefined ? '' : str(query.referer);
  const origin = query.origin === undefined ? '' : str(query.origin);
  if (!url || !sig || referer === null || origin === null) return false;
  const want = Buffer.from(signature(url, referer, origin));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { manifestPath, verifyManifestQuery };
