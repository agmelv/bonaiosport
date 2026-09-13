const dns = require('dns').promises;
const { normalizeGenre } = require('../channelGenres');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

/**
 * USA TV Next — https://github.com/yowmamasita/usa-tv-next
 *
 * A static Stremio addon: its catalog, meta and stream responses are plain JSON
 * files served from raw.githubusercontent.com, with no server and no key. That
 * makes it the cheapest provider here by a distance — a fetch of one file lists
 * every channel, and a second names that channel's streams.
 *
 * Consumed the way any Stremio client consumes it, at runtime and over its
 * published endpoints. Nothing from it is copied into this repository: the
 * project carries no LICENSE, so its files are its author's to license, and
 * vendoring them would be taking a position that is not ours to take. Reading a
 * public addon is not.
 *
 * Everything here is a 24/7 channel rather than a fixture, so every entry is
 * filed as `networks` with no kickoff, which is what puts it in the Channels
 * tab. The upstream genres (Sports, News, Kids, Latino ...) are deliberately
 * not mapped onto sport tabs: a sport tab is a schedule, and a channel that is
 * always on has no place in one.
 */
class UsaTvProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'UsaTv';

    this.base = process.env.USATV_BASE
      || 'https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main';

    // Which channels have at least one stream on a host that still exists.
    // Null until the first sweep finishes; everything is listed until then.
    this._playable = null;
    this._sweptAt = 0;
    this._sweeping = false;

    this.fetchCatalog = this.circuitBreaker.wrap(`${this.name}_catalog`, async () => {
      const res = await this.proxyFetch(`${this.base}/catalog/tv/all.json`, {
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`catalog responded ${res.status}`);
      return await res.json();
    });
  }

  /**
   * Find the channels that can actually play.
   *
   * Half of this catalog cannot. 73 of its 169 channels list streams only on
   * tvpass.org, which no longer resolves anywhere -- NXDOMAIN from Cloudflare,
   * Google and Quad9 alike, with no nameservers left -- and another 11 list no
   * streams at all. Listing them means a viewer opens a channel and is shown
   * nothing, which reads as this addon being broken rather than as a link that
   * rotted upstream.
   *
   * The stream files are small and static, so the sweep is cheap and its answer
   * keeps for hours. Hosts are checked by name rather than by fetching: one
   * lookup covers every channel that shares a host, and a host coming back
   * brings its channels back with it without anybody editing a list.
   *
   * Never awaited by getMatches. The first refresh after a restart lists
   * everything, the sweep lands behind it, and the next refresh is filtered --
   * better than making every restart wait on 169 requests.
   */
  async _sweep() {
    if (this._sweeping) return;
    this._sweeping = true;
    try {
      const data = await this.fetchCatalog.fire();
      const metas = (data && data.metas) || [];
      const ids = metas.map(m => m && m.id).filter(Boolean);

      const hostsFor = new Map();
      const queue = ids.slice();
      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          try {
            const res = await this.proxyFetch(
              `${this.base}/stream/tv/${encodeURIComponent(id)}.json`,
              { signal: AbortSignal.timeout(10000) }
            );
            if (!res.ok) { hostsFor.set(id, []); continue; }
            const body = await res.json();
            const hosts = [];
            for (const st of (body && body.streams) || []) {
              if (!st || typeof st.url !== 'string') continue;
              try { hosts.push(new URL(st.url).hostname); } catch (e) { /* not a url */ }
            }
            hostsFor.set(id, hosts);
          } catch (e) {
            // Unknown rather than dead: left out of the map so it stays listed.
          }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));

      const distinct = new Set();
      for (const hosts of hostsFor.values()) for (const h of hosts) distinct.add(h);
      const alive = new Set();
      await Promise.all([...distinct].map(async h => {
        try { await dns.lookup(h); alive.add(h); } catch (e) { /* gone */ }
      }));

      const playable = new Set();
      for (const [id, hosts] of hostsFor) {
        if (hosts.some(h => alive.has(h))) playable.add(id);
      }
      // Never let a bad sweep empty the tab.
      if (playable.size) {
        this._playable = playable;
        this._sweptAt = Date.now();
        console.log(`[${this.name}] ${playable.size} of ${hostsFor.size} channels reachable `
          + `(${distinct.size - alive.size} of ${distinct.size} stream hosts are gone)`);
      }
    } catch (err) {
      console.warn(`[${this.name}] reachability sweep failed:`, err.message);
    } finally {
      this._sweeping = false;
    }
  }

  async getMatches() {
    try {
      const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
      if (Date.now() - this._sweptAt > SWEEP_EVERY_MS) this._sweep().catch(() => {});

      const data = await this.fetchCatalog.fire();
      const metas = (data && data.metas) || [];
      if (!Array.isArray(metas) || !metas.length) return [];

      const out = [];
      for (const m of metas) {
        // The id is what the stream endpoint is keyed by, so an entry without
        // one is an entry whose streams could never be fetched.
        if (!m || typeof m.id !== 'string' || !m.id) continue;
        // Once the sweep has an answer, a channel with nowhere left to stream
        // from is not worth a row.
        if (this._playable && !this._playable.has(m.id)) continue;

        // Trailing space on "CW " upstream, and a name is what the channel is
        // matched and displayed by.
        const title = String(m.name || '').trim();
        if (!title) continue;

        // The catalog hands out only the poster, which is a composed 300x450
        // portrait: the logo centred on a grey panel. The bare logo is a square
        // PNG with transparency, and it sits at the same filename one directory
        // across -- the meta endpoint proves the pairing, and deriving it costs
        // nothing where asking for 169 meta files would not.
        const poster = typeof m.poster === 'string' ? m.poster : '';
        const logo = poster.includes('/public/posters/')
          ? poster.replace('/public/posters/', '/public/logos/')
          : '';

        out.push(new MatchEntity({
          id: `ustv_${m.id}`,
          title,
          region: 'US',
          baseTitle: title,
          category: 'networks',
          // No kickoff: that is what marks it a channel rather than a fixture.
          date: '0',
          popular: '0',
          league: Array.isArray(m.genres) && m.genres.length ? String(m.genres[0]) : 'Live TV',
          genre: normalizeGenre(Array.isArray(m.genres) ? m.genres[0] : null) || '',
          thumbnail_url: poster,
          // The card's corner badge, and what the wide card below is drawn from.
          logo,
          // One source per channel. Its streams are a second fetch, made only
          // when somebody opens the channel, so listing 169 of them costs the
          // single catalog request above.
          sources: [{ source: 'usatv', id: m.id, name: title }]
        }));
      }
      return out;
    } catch (error) {
      console.error(`[${this.name}] Error fetching channels:`, error.message);
      return [];
    }
  }

  // `opts.strict` (the channel health check) throws when the upstream is busy or
  // failing, so that is not mistaken for a channel with no streams.
  async resolveStream(sourceId, matchCategory, matchTitle, opts = {}) {
    const streams = [];
    try {
      const res = await this.proxyFetch(
        `${this.base}/stream/tv/${encodeURIComponent(sourceId)}.json`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) {
        // A 404 is an answer: this channel has nothing. A 429 or a 5xx is not.
        if (opts.strict && (res.status === 429 || res.status >= 500)) throw new Error(`HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();

      for (const s of (data && data.streams) || []) {
        if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) continue;

        // Upstream puts the quality in `name` ("HD", "SD") and a short tag for
        // which backend it came from in `description` ("TP", "HV:CONTENT").
        // The tag is what separates two otherwise identical rows, so it is kept
        // as the label and the quality is passed through as the resolution.
        const quality = String(s.name || '').trim() || 'Auto';
        const tag = String(s.description || '').trim();

        streams.push(new StreamEntity({
          name: 'USA TV',
          title: tag ? `USA TV (${tag})` : 'USA TV',
          url: s.url,
          resolution: quality,
          behaviorHints: { notWebReady: true }
        }));
      }
    } catch (err) {
      console.warn(`[${this.name}] stream lookup failed for ${sourceId}:`, err.message);
      if (opts.strict) throw err;
    }
    return streams;
  }
}

module.exports = UsaTvProvider;
