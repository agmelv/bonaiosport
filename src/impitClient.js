/**
 * impitClient.js — Safe impit singleton with undici fallback
 *
 * impit is a native Rust/NAPI addon. On some architectures (ARM64 VPS,
 * Alpine/musl Linux, certain Windows Server builds) the native binary may fail
 * to load. This module wraps every call so a missing or broken impit
 * transparently falls back to undici — callers never need to worry about it.
 *
 * Usage:
 *   const { safeFetch } = require('./impitClient');
 *   const { ok, status, text } = await safeFetch(url, { headers, method });
 */

'use strict';

const { request: undiciRequest, Agent } = require('undici');

// -- Singleton -----------------------------------------------------------------
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit();
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
}

// -- Shared undici keep-alive agent -------------------------------------------
const _undiciAgent = new Agent({
  // Connecting is the one phase neither headersTimeout nor an AbortSignal
  // reliably bounds here, so the agent has to. Twenty seconds meant a host that
  // accepts nothing cost 24.6 s of a viewer's session, measured against a
  // blackholed address. A host that cannot complete a handshake in five is not
  // going to serve video.
  connect: { timeout: 5000, rejectUnauthorized: false },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000,
});

// -- Core helper --------------------------------------------------------------
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs }
 * @returns {{ ok, status, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000 } = opts;
  const impit = getImpit();

  // One budget for the whole call, not one per attempt. The fallback below used
  // to start a fresh full timeout after impit had already spent one, so a
  // caller asking for 10 seconds could wait thirty.
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());

  // -- Path A: impit ---------------------------------------------------------
  if (impit) {
    const control = new AbortController();
    let timer = null;
    try {
      const res = await Promise.race([
        impit.fetch(url, { method, headers, body, signal: control.signal }),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            // Tear the request down as well as giving up on it. Losing the race
            // used to leave the socket open and the timer pending.
            control.abort();
            rej(new Error(`impit timeout ${timeoutMs}ms`));
          }, remaining());
        }),
      ]);
      const textData = await res.text();
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => textData,
        json: async () => JSON.parse(textData),
      };
    } catch (impitErr) {
      // The fallback is for impit being broken, not for impit having already
      // spent the budget. Retrying a host that just failed to answer in the
      // time allowed only spends it twice -- which is how a 4 s budget became
      // 9.6 s against an address that accepts nothing.
      if (Date.now() >= deadline) {
        if (timer) clearTimeout(timer);
        throw impitErr;
      }
      // Transient error - fall through to undici without marking impit broken
      console.warn(`[impitClient] impit fetch failed (${impitErr.message}), falling back to undici for: ${url}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- Path B: undici --------------------------------------------------------
  // Whatever is left of the budget, not another full one -- and enforced with a
  // signal rather than the timeout options. headersTimeout only starts once the
  // request has been written, so against a host that accepts nothing the
  // agent's 20 s connect timeout governs instead and the budget is ignored.
  // Measured: a blackholed address cost 24.6 s under headersTimeout alone.
  // A signal covers connect, headers and body alike.
  const left = remaining();
  const budget = AbortSignal.timeout(left);
  const res = await undiciRequest(url, {
    method,
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, budget]) : budget,
    headersTimeout: left,
    bodyTimeout: left,
    dispatcher: _undiciAgent,
  });
  const textData = await res.body.text();
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    text: async () => textData,
    json: async () => JSON.parse(textData),
  };
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit };
