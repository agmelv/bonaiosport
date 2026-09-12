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

    this.fetchCatalog = this.circuitBreaker.wrap(`${this.name}_catalog`, async () => {
      const res = await this.proxyFetch(`${this.base}/catalog/tv/all.json`, {
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`catalog responded ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    try {
      const data = await this.fetchCatalog.fire();
      const metas = (data && data.metas) || [];
      if (!Array.isArray(metas) || !metas.length) return [];

      const out = [];
      for (const m of metas) {
        // The id is what the stream endpoint is keyed by, so an entry without
        // one is an entry whose streams could never be fetched.
        if (!m || typeof m.id !== 'string' || !m.id) continue;

        // Trailing space on "CW " upstream, and a name is what the channel is
        // matched and displayed by.
        const title = String(m.name || '').trim();
        if (!title) continue;

        out.push(new MatchEntity({
          id: `ustv_${m.id}`,
          title,
          category: 'networks',
          // No kickoff: that is what marks it a channel rather than a fixture.
          date: '0',
          popular: '0',
          league: Array.isArray(m.genres) && m.genres.length ? String(m.genres[0]) : 'Live TV',
          thumbnail_url: typeof m.poster === 'string' ? m.poster : '',
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

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const res = await this.proxyFetch(
        `${this.base}/stream/tv/${encodeURIComponent(sourceId)}.json`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return [];
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
    }
    return streams;
  }
}

module.exports = UsaTvProvider;
