/**
 * DiskCache.js — a store of finished things that outlives a restart.
 *
 * The finished cards, the logos they were drawn from, the catalog: every one
 * of them lived in memory, and a deploy threw the lot away. The container came
 * back, drew two and a half thousand covers again, refetched six hundred
 * logos and re-read every provider, and for three minutes the two-core host
 * ran near ninety per cent -- for cards it had already made.
 *
 * This keeps binary entries in DATA_DIR, one file each: a line of JSON, then
 * the bytes. A lookup is a stat; a read is small and local; writes happen
 * behind the caller, one at a time. Nothing here is needed for correctness: a
 * data directory that cannot be written costs the memory across restarts, as
 * before, and nothing else.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');

// How much of a file's head a header may take. The metadata is a few fields.
const HEADER_MAX = 1024;

class DiskCache {
  /**
   * `name` is the directory under DATA_DIR. `maxBytes` bounds the store, the
   * oldest files going first; `ttlMs`, when set, is how long a file counts.
   */
  constructor(name, { maxBytes = 256 * 1024 * 1024, ttlMs = 0, dir } = {}) {
    this.name = name;
    this.dir = dir || path.join(DATA_DIR, name);
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.enabled = true;
    this.bytes = 0;
    this.count = 0;
    this.writes = 0;
    this.queue = Promise.resolve();
    this._scan(true);
  }

  _file(key) {
    return path.join(this.dir, crypto.createHash('sha1').update(String(key)).digest('hex') + '.bin');
  }

  _expired(st) {
    return !!this.ttlMs && Date.now() - st.mtimeMs > this.ttlMs;
  }

  /**
   * What is there, counted. Files past their time go, and at the start so do
   * .tmp files a previous run left mid-write -- only at the start: later on a
   * .tmp is a write in progress.
   */
  _scan(sweepTmp = false) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let bytes = 0, count = 0;
      for (const name of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, name);
        if (name.endsWith('.tmp')) { if (sweepTmp) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } continue; }
        if (!name.endsWith('.bin')) continue;
        try {
          const st = fs.statSync(p);
          if (this._expired(st)) { fs.unlinkSync(p); continue; }
          bytes += st.size;
          count++;
        } catch (e) { /* vanished between the listing and the stat */ }
      }
      this.bytes = bytes;
      this.count = count;
      if (bytes > this.maxBytes) this.prune();
    } catch (err) {
      this.enabled = false;
      console.warn(`[DiskCache] ${this.name}: not kept on disk (${err.message})`);
    }
  }

  /** Whether an entry is there and within its time. Touches nothing. */
  has(key) {
    if (!this.enabled) return false;
    try {
      return !this._expired(fs.statSync(this._file(key)));
    } catch (e) {
      return false;
    }
  }

  /** { meta, buffer, mtimeMs }, or null. A file past its time, or unreadable, is removed. */
  get(key) {
    if (!this.enabled) return null;
    const p = this._file(key);
    let st = null;
    try {
      st = fs.statSync(p);
      if (this._expired(st)) { this._unlink(p, st.size); return null; }
      const raw = fs.readFileSync(p);
      const nl = raw.indexOf(10);
      if (nl < 1 || nl > HEADER_MAX) throw new Error('no header');
      const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
      return { meta, buffer: raw.subarray(nl + 1), mtimeMs: st.mtimeMs };
    } catch (e) {
      if (st) this._unlink(p, st.size);
      return null;
    }
  }

  /** Written behind the caller, one file at a time. The caller never waits. */
  put(key, meta, buffer) {
    if (!this.enabled || !Buffer.isBuffer(buffer)) return;
    const p = this._file(key);
    const header = Buffer.from(JSON.stringify(meta || {}) + '\n', 'utf8');
    if (header.length > HEADER_MAX) return;
    this.queue = this.queue.then(async () => {
      if (!this.enabled) return;
      let old = 0;
      try { old = fs.statSync(p).size; } catch (e) { old = 0; }
      const tmp = p + '.tmp';
      await fs.promises.writeFile(tmp, Buffer.concat([header, buffer]));
      try {
        await fs.promises.rename(tmp, p);
      } catch (e) {
        // The file went while it was being written: a clear() ran under
        // this write. Not kept, and not a fault in the store.
        if (e && e.code === 'ENOENT') return;
        throw e;
      }
      if (!old) this.count++;
      this.bytes += header.length + buffer.length - old;
      // Checked now and then, not on every write: pruning lists the directory.
      if (++this.writes % 50 === 0 && this.bytes > this.maxBytes) this.prune();
    }).catch(err => {
      if (this.enabled) console.warn(`[DiskCache] ${this.name}: not kept on disk (${err.message})`);
      this.enabled = false;
    });
  }

  delete(key) {
    if (!this.enabled) return;
    const p = this._file(key);
    try { this._unlink(p, fs.statSync(p).size); } catch (e) { /* not there */ }
  }

  _unlink(p, size) {
    try {
      fs.unlinkSync(p);
      this.bytes -= size;
      this.count--;
    } catch (e) { /* already gone */ }
  }

  /** Oldest first, until comfortably under the cap. */
  prune() {
    if (!this.enabled) return;
    try {
      const files = [];
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.bin')) continue;
        const p = path.join(this.dir, name);
        try { const st = fs.statSync(p); files.push({ p, size: st.size, mtimeMs: st.mtimeMs }); } catch (e) { /* gone */ }
      }
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let bytes = files.reduce((n, f) => n + f.size, 0);
      let count = files.length;
      for (const f of files) {
        if (bytes <= this.maxBytes * 0.9) break;
        try { fs.unlinkSync(f.p); bytes -= f.size; count--; } catch (e) { /* gone */ }
      }
      this.bytes = bytes;
      this.count = count;
    } catch (e) { /* next time */ }
  }

  /**
   * Everything -- or, given `keep`, only the files whose header it refuses.
   * The header is read from each file's head, not the whole file.
   */
  clear(keep) {
    if (!this.enabled) return;
    try {
      // Finished files only: a .tmp is a write in progress, which lands as a
      // file this clear did not see -- one card kept, which is no harm.
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.bin')) continue;
        const p = path.join(this.dir, name);
        if (keep) {
          let stays = false;
          try {
            const fd = fs.openSync(p, 'r');
            const head = Buffer.alloc(HEADER_MAX);
            const got = fs.readSync(fd, head, 0, HEADER_MAX, 0);
            fs.closeSync(fd);
            const nl = head.subarray(0, got).indexOf(10);
            if (nl > 0) stays = !!keep(JSON.parse(head.subarray(0, nl).toString('utf8')));
          } catch (e) { stays = false; }   // unreadable: goes
          if (stays) continue;
        }
        try { fs.unlinkSync(p); } catch (e) { /* gone */ }
      }
      this._scan();
    } catch (e) { /* nothing to clear */ }
  }

  stats() {
    return { enabled: this.enabled, entries: this.count, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  /** For tests: wait for the writes queued so far. */
  flush() {
    return this.queue;
  }
}

module.exports = DiskCache;
