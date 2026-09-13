const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

// A sync's result is written a moment after it lands, once, not per caller.
const SAVE_AFTER_MS = 2000;

/**
 * The catalog: what the last sync merged, served to every request.
 *
 * Kept on disk as well. It lived in memory alone, so a restart served an
 * empty catalog until every provider had been read again -- a spinner on
 * every device for the first minute after a deploy -- and then redid the
 * warming that follows a sync. Now the saved list is served the moment the
 * process is up, and while it is fresh the boot sync is not run at all
 * (CronService): the ordinary revalidation takes over from there.
 */
class CacheService {
  constructor() {
    this.cachedMatches = [];
    this.lastFetchTime = 0;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    this.file = path.join(DATA_DIR, 'catalog.json');
    // Whether what is being served came from the last run's file.
    this.loadedFromDisk = false;
    this._saveTimer = null;
    this._load();
  }

  getMatches() {
    return this.cachedMatches.map((m) => ({ ...m, sources: [...(m.sources || [])] }));
  }

  setMatches(matches) {
    this.cachedMatches = (matches || []).map((m) => ({ ...m, sources: [...(m.sources || [])] }));
    this.lastFetchTime = Date.now();
    this.loadedFromDisk = false;
    this._save();
  }

  isStale(ttlMs = this.CACHE_TTL) {
    return (Date.now() - this.lastFetchTime) > ttlMs;
  }

  _load() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return; }   // first run
    if (!saved || !Array.isArray(saved.matches) || !(Number(saved.at) > 0)) return;
    // A list from a server that was off for a day is fixtures that have been
    // played: better an empty tab for the seconds the sync takes than that.
    if (Date.now() - Number(saved.at) > 12 * 60 * 60 * 1000) return;
    this.cachedMatches = saved.matches
      .filter(m => m && typeof m === 'object' && m.id)
      .map((m) => ({ ...m, sources: [...(m.sources || [])] }));
    // A clock that went backwards must not make a saved list look fresh for years.
    this.lastFetchTime = Math.min(Number(saved.at), Date.now());
    this.loadedFromDisk = true;
    console.log(`[CacheService] serving the catalog saved ${Math.round((Date.now() - this.lastFetchTime) / 60000)} min ago: ${this.cachedMatches.length} events`);
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), SAVE_AFTER_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  /** Write the catalog now. */
  flush() {
    clearTimeout(this._saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ at: this.lastFetchTime, matches: this.cachedMatches }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // A data directory that cannot be written costs the catalog across restarts, as before.
    }
  }
}

module.exports = CacheService;
