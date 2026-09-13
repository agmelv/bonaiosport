const dns = require('dns').promises;
const { normalizeGenre, moreSpecific } = require('../channelGenres');
const { regionFromCode } = require('../channelRegions');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

/**
 * iptv-org — https://iptv-org.github.io/api/
 *
 * Two public JSON files: every channel it knows, and every stream anyone has
 * contributed for them. No key, no server.
 *
 * It is here to carry the channels the other sources cannot. USA TV Next lists
 * ESPN, Fox, NBC, the ACC and SEC networks and dozens more, but the only URLs
 * it has for a great many of them point at a host that no longer exists, so
 * those channels are listed and unplayable. iptv-org has working streams for a
 * good share of them, and 79 US sports channels besides.
 *
 * Everything is a 24/7 channel, so entries are filed as `networks` with no
 * kickoff, which is what puts them in the Channels tab. The aggregator merges
 * them with whatever another provider already listed under the same name, so a
 * channel that both sources carry ends up as one entry holding both sets of
 * streams rather than two rows.
 */
class IptvOrgProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'IptvOrg';

    this.channelsUrl = 'https://iptv-org.github.io/api/channels.json';
    this.streamsUrl = 'https://iptv-org.github.io/api/streams.json';
    // Logos left the channel record and live in their own file now, several
    // per channel with dimensions and an in-use flag.
    this.logosUrl = 'https://iptv-org.github.io/api/logos.json';

    // Which of iptv-org's categories are worth carrying. Sports is the point,
    // and news is what people turn to between games. "general" was carried for
    // the broadcast networks, but those come from TimStreams and USA TV Next;
    // what it actually added was 155 city public-access, government and
    // community channels -- Akaku 53, CAN TV27, SF Commons 76 -- which nobody
    // installs a sports addon to find. The rest of its catalogue (religious,
    // shopping and so on) was never carried. Set IPTV_CATEGORIES to change it
    // without a rebuild.
    this.categories = new Set(
      (process.env.IPTV_CATEGORIES || 'sports,news')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    );
    this.country = (process.env.IPTV_COUNTRY || 'US').toUpperCase();

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const [channels, streams, logos] = await Promise.all([
        this.proxyFetch(this.channelsUrl, { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
        this.proxyFetch(this.streamsUrl, { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
        this.proxyFetch(this.logosUrl, { signal: AbortSignal.timeout(45000) }).then(r => r.json())
          .catch(() => [])
      ]);
      return { channels, streams, logos };
    });
  }

  async getMatches() {
    try {
      const data = await this.fetchData.fire();
      if (!data || !Array.isArray(data.channels) || !Array.isArray(data.streams)) return [];

      // The best logo per channel. A card draws the mark into a square tile, so
      // a squarish one is worth more than a wide wordmark, and a bigger one
      // rasterises better than a favicon. Retired logos lose to current ones
      // whatever their shape.
      const logoFor = new Map();
      const logoScore = (l) => {
        const w = Number(l.width) || 0, h = Number(l.height) || 0;
        if (!w || !h) return 0;
        const squareness = Math.min(w, h) / Math.max(w, h);
        return (l.in_use ? 2 : 1) * squareness * Math.min(Math.min(w, h), 512);
      };
      for (const l of (Array.isArray(data.logos) ? data.logos : [])) {
        if (!l || !l.channel || typeof l.url !== 'string') continue;
        // SVG is left to clients; the card rasteriser is fed bitmaps.
        if (String(l.format || '').toUpperCase() === 'SVG') continue;
        const best = logoFor.get(l.channel);
        if (!best || logoScore(l) > logoScore(best)) logoFor.set(l.channel, l);
      }

      // A name index over every channel it has a logo for, in any country, kept
      // for channels other sources list. Primary names only: an alternate name
      // is how "US Open" came to match a local TV station's call sign. Each
      // entry remembers its country so the caller can insist on the right one.
      const byName = new Map();
      const nameKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/\+/g, 'plus').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
      for (const c of data.channels) {
        if (!c || !c.name || !logoFor.has(c.id)) continue;
        const k = nameKey(c.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push({ country: c.country, url: logoFor.get(c.id).url });
      }
      this._logoByName = byName;
      this._nameKey = nameKey;

      const streamsFor = new Map();
      for (const s of data.streams) {
        if (!s || !s.channel || typeof s.url !== 'string') continue;
        if (!streamsFor.has(s.channel)) streamsFor.set(s.channel, []);
        streamsFor.get(s.channel).push(s);
      }

      const wanted = data.channels.filter(c => {
        if (!c || c.closed || !c.name) return false;
        if (c.country !== this.country) return false;
        if (!streamsFor.has(c.id)) return false;
        const cats = Array.isArray(c.categories) ? c.categories : [];
        return cats.some(k => this.categories.has(String(k).toLowerCase()));
      });
      if (!wanted.length) return [];

      // A listed stream is not a reachable one. Contributions are not pruned
      // when a host goes away, so a channel can carry several URLs and no way
      // to play. Checking by host rather than by fetching keeps this to one
      // lookup per host no matter how many channels share it -- 338 hosts for
      // 336 channels here, answered in about a second -- and a host coming back
      // brings its channels with it without anybody editing a list.
      const hosts = new Set();
      for (const c of wanted) {
        for (const s of streamsFor.get(c.id)) {
          try { hosts.add(new URL(s.url).hostname); } catch (e) { /* not a url */ }
        }
      }
      const alive = new Set();
      await Promise.all([...hosts].map(async h => {
        try { await dns.lookup(h); alive.add(h); } catch (e) { /* gone */ }
      }));

      const reachable = (s) => {
        try { return alive.has(new URL(s.url).hostname); } catch (e) { return false; }
      };

      const matches = [];
      for (const c of wanted) {
        const usable = streamsFor.get(c.id).filter(reachable);
        if (!usable.length) continue;

        const bestLogo = logoFor.get(c.id);
        let logo = bestLogo && typeof bestLogo.url === 'string' ? bestLogo.url : '';
        if (logo.startsWith('//')) logo = `https:${logo}`;

        matches.push(new MatchEntity({
          id: `iptv_${c.id}`,
          title: String(c.name).trim(),
          region: regionFromCode(c.country),
          baseTitle: String(c.name).trim(),
          category: 'networks',
          date: '0',
          popular: '0',
          league: 'Live TV',
          // iptv-org gives several categories; the most specific one names the group.
          genre: (Array.isArray(c.categories) ? c.categories : [])
            .map(normalizeGenre).filter(Boolean).reduce(moreSpecific, null) || '',
          thumbnail_url: logo,
          logo,
          sources: usable.map(s => ({
            source: 'iptv-org',
            id: s.url,
            url: s.url,
            quality: s.quality || 'Auto',
            user_agent: s.user_agent,
            referrer: s.referrer
          }))
        }));
      }

      console.log(`[${this.name}] ${matches.length} channels from ${wanted.length} listed `
        + `(${hosts.size - alive.size} of ${hosts.size} stream hosts are gone, `
        + `${matches.filter(m => m.logo).length} with a logo)`);
      return matches;
    } catch (error) {
      console.error(`[${this.name}] Error fetching channels:`, error.message);
      return [];
    }
  }

  /**
   * A logo for a channel another source listed, or null. Only a channel in the
   * wanted country (the US when the name does not say) is accepted, so a name
   * shared across countries cannot borrow a foreign channel's mark.
   */
  logoForName(name, country) {
    if (!this._logoByName || !name) return null;
    const hits = this._logoByName.get(this._nameKey(name));
    if (!hits) return null;
    const want = String(country || 'US').toUpperCase();
    // The wanted country first. Failing that, a name only one country uses is
    // not ambiguous -- Fox Cricket and Fox League exist only in Australia -- so
    // its logo is accepted; a name several countries share is not.
    const countries = new Set(hits.map(h => h.country));
    const hit = hits.find(h => h.country === want) || (countries.size === 1 ? hits[0] : null);
    if (!hit) return null;
    return hit.url.startsWith('//') ? `https:${hit.url}` : hit.url;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    // Direct m3u8 links. streams.js builds the entity for this source so it can
    // attach the per-stream User-Agent and Referer some hosts insist on; this
    // is the path for anything that reaches here without them.
    return [new StreamEntity({
      name: 'Direct Stream',
      title: matchTitle,
      url: sourceId
    })];
  }
}

module.exports = IptvOrgProvider;
