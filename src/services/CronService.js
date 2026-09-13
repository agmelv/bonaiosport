const cron = require('node-cron');

// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.syncing = false;
    // Called after every sync that produced a match list; index.js warms the
    // new fixtures' artwork from it.
    this.onSynced = null;
  }

  async runSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const activeMatches = await this.matchAggregator.syncMatches();
      if (activeMatches !== null) {
        this.pruneStreamCache(activeMatches);
        try {
          if (typeof this.onSynced === 'function') this.onSynced(activeMatches);
        } catch (_) { /* warming is a nicety; a sync never fails because of it */ }
      }
    } finally {
      this.syncing = false;
    }
  }

  // Catalog stale-while-revalidate: serve the cached list immediately and
  // refresh in the background once the cache passes REVALIDATE_AFTER_MS.
  // Traffic-driven, so idle instances stay quiet; the 4-hour cron is the floor.
  ensureFresh() {
    try {
      if (this.syncing) return;
      if (!this.cacheService || !this.cacheService.isStale(REVALIDATE_AFTER_MS)) return;
      console.log('[CronService] Catalog stale, triggering background re-sync (SWR)...');
      this.runSync().catch((err) => console.error('[CronService] SWR sync failed:', err.message));
    } catch (err) {
      console.error('[CronService] ensureFresh error:', err.message);
    }
  }

  start() {
    console.log('[CronService] Starting background jobs...');
    
    // Fetch and cache matches every 4 hours
    cron.schedule('0 */4 * * *', async () => {
      console.log('[CronService] Running match sync job...');
      try {
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Match sync failed:', err.message);
      }
    });

    // Prewarm popular live matches - disabled for local home/tunnel hosting
    // to prevent hammering upstream streaming sites and keep network silent.
    // cron.schedule('*/3 * * * *', async () => {
    //   try {
    //     await this.prewarmPopular();
    //   } catch (err) {
    //     console.error('[CronService] Prewarm job failed:', err.message);
    //   }
    // });

    // Run first sync immediately on boot
    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (externalUrl) {
      console.log(`[CronService] Keep-alive enabled for ${externalUrl}`);
      cron.schedule('*/14 * * * *', async () => {
        try {
          console.log(`[CronService] Pinging external URL to prevent sleep...`);
          const { request } = require('undici');
          await request(`${externalUrl}/health`);
        } catch (err) {
          console.error('[CronService] Keep-alive ping failed:', err.message);
        }
      });
    }

    // Run first sync immediately on boot
    setTimeout(async () => {
      try {
        console.log('[CronService] Running initial match sync...');
        await this.runSync();
      } catch(e) {
        console.error('[CronService] Match sync failed:', e.message);
      }
    }, 1000);
  }

  /** Drop stream-cache entries for matches that are no longer active. */
  pruneStreamCache(activeMatches) {
    try {
      if (!this.streamResolveCache) return;
      const ids = new Set((activeMatches || []).map(m => m && m.id).filter(Boolean));
      this.streamResolveCache.pruneEnded(ids);
    } catch (_) {}
  }

  /** Prewarm popular live matches so hot streams are "already running" when clicked. */
  async prewarmPopular() {
    try {
      // Lazy requires avoid a require cycle (catalog -> streams -> container -> this).
      const { isMatchLive } = require('../catalog');
      const { prewarmMatch } = require('../streams');
      const matches = this.cacheService ? this.cacheService.getMatches() : [];
      const hot = matches.filter(m => m.popular === '1' && isMatchLive(m));
      if (hot.length === 0) return;
      console.log(`[CronService] Prewarming ${Math.min(hot.length, 10)} popular live matches...`);
      await Promise.allSettled(hot.slice(0, 10).map(m => prewarmMatch(m, null)));
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    }
  }

}

module.exports = CronService;
