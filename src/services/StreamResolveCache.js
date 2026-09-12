/**
 * StreamResolveCache - prewarm / verify-before-serve cache for resolved streams.
 *
 * Design: DELIVERY/nuvio-prewarm-cache-design.md
 *  - Single-flight mints: N concurrent requests for the same source -> ONE resolveStream call.
 *  - Per-source adaptive TTLs: healthy pre-flight doubles the TTL (cap 10 min),
 *    a failed pre-flight halves it (floor 60 s) and evicts the entry.
 *  - Negative cache (~30 s) for sources that resolve to nothing or fail, so dead
 *    sources are not re-scraped on every click. getOrCreate NEVER rejects.
 *  - Entries are shallow-cloned on read, so label/preflight mutations in
 *    streams.js never touch the cached originals.
 *  - LRU cap + pruneEnded() keep memory bounded and drop ended matches.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
// One warmed live board is already more than 200 keys -- 24 matches times up
// to 12 sources each -- so the cap was evicting entries the prewarm had just
// paid for, before anybody clicked them. Entries are small (a handful of
// stream objects), and pruneEnded drops a match as soon as it is over.
const MAX_ENTRIES = 1200;
const CHANNEL_MATCH_ID = '__channel__'; // evergreen 24/7 keys survive pruneEnded

class StreamResolveCache {
  constructor(opts = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.minTtlMs = opts.minTtlMs ?? MIN_TTL_MS;
    this.maxTtlMs = opts.maxTtlMs ?? MAX_TTL_MS;
    this.negativeTtlMs = opts.negativeTtlMs ?? NEGATIVE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;

    this.entries = new Map();   // key -> { streams, matchId, status, resolvedAt, expiresAt, lastAccess }
    this.inFlight = new Map();  // key -> Promise (mint in progress)
    this.ttl = new Map();       // sourceName -> learned TTL ms
    this.statsCounters = { hits: 0, misses: 0, negativeHits: 0, evictions: 0 };
  }

  _ttlFor(sourceName) {
    return this.ttl.get(sourceName) || this.defaultTtlMs;
  }

  /** Fresh positive entry? Returns a shallow clone of the streams, else null. */
  get(key) {
    const e = this.entries.get(key);
    if (!e) return null;
    const now = Date.now();
    if (now > e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    e.lastAccess = now;
    if (e.status !== 'ok') return null;
    return e.streams.map((s) => ({ ...s }));
  }

  /**
   * Returns cached streams if fresh; otherwise mints via mintFn exactly once
   * (single-flight). Never rejects: failures/empty results are negative-cached
   * and resolve to [] until the negative window passes.
   */
  async getOrCreate(key, mintFn) {
    const now = Date.now();
    const existing = this.entries.get(key);

    if (existing && existing.expiresAt > now) {
      existing.lastAccess = now;
      if (existing.status !== 'ok') {
        this.statsCounters.negativeHits++;
        return [];
      }
      this.statsCounters.hits++;
      return existing.streams.map((s) => ({ ...s }));
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      await pending.catch(() => {});
      return this.get(key) || [];
    }

    this.statsCounters.misses++;
    const parts = key.split(':');
    const sourceName = parts[0];
    const matchId = parts[1];
    const p = (async () => {
      try {
        const streams = await mintFn();
        if (Array.isArray(streams) && streams.length > 0) {
          this._set(key, sourceName, matchId, streams, 'ok', this._ttlFor(sourceName));
        } else {
          this._set(key, sourceName, matchId, [], 'failed', this.negativeTtlMs);
        }
      } catch (_) {
        this._set(key, sourceName, matchId, [], 'failed', this.negativeTtlMs);
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, p);
    await p.catch(() => {});
    return this.get(key) || [];
  }

  _set(key, sourceName, matchId, streams, status, ttlMs) {
    const now = Date.now();
    this.entries.set(key, {
      streams: streams.map((s) => ({ ...s })), // store our own copy
      matchId, status,
      resolvedAt: now,
      expiresAt: now + ttlMs,
      lastAccess: now
    });
    this._evictIfNeeded();
  }

  /** Pre-flight passed: double the source TTL (capped) and extend the entry. */
  noteSuccess(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const next = Math.min(this._ttlFor(sourceName) * 2, this.maxTtlMs);
    this.ttl.set(sourceName, next);
    const e = this.entries.get(key);
    if (e && e.status === 'ok') {
      e.expiresAt = Math.max(e.expiresAt, Date.now() + next);
    }
  }

  /** Pre-flight failed: halve the source TTL (floored) and evict the entry. */
  noteFailure(key) {
    if (!key) return;
    const sourceName = key.split(':')[0];
    const next = Math.max(Math.floor(this._ttlFor(sourceName) / 2), this.minTtlMs);
    this.ttl.set(sourceName, next);
    this.entries.delete(key);
  }

  /** Drop entries whose match is no longer in the active match set. */
  pruneEnded(activeMatchIds) {
    const ids = activeMatchIds instanceof Set ? activeMatchIds : new Set(activeMatchIds || []);
    for (const [key, e] of this.entries) {
      if (e.matchId === CHANNEL_MATCH_ID) continue;
      if (e.matchId && !ids.has(e.matchId)) this.entries.delete(key);
    }
  }

  _evictIfNeeded() {
    if (this.entries.size <= this.maxEntries) return;
    const byAccess = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = this.entries.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      this.entries.delete(byAccess[i][0]);
      this.statsCounters.evictions++;
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      inFlight: this.inFlight.size,
      hits: this.statsCounters.hits,
      misses: this.statsCounters.misses,
      negativeHits: this.statsCounters.negativeHits,
      evictions: this.statsCounters.evictions,
      learnedTtls: Object.fromEntries(this.ttl)
    };
  }
}

module.exports = StreamResolveCache;
