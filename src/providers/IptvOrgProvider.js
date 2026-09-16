const dns = require('dns').promises;
const { normalizeGenre, moreSpecific } = require('../channelGenres');
const { regionFromCode } = require('../channelRegions');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { stationLabel, callSign } = require('../services/StationLabel');
const {
  allMarkets, stationName, isNewsStream, networkOfTitles, networkHome, NETWORK_CHANNEL, NETWORK_NAME
} = require('../services/LocalMarkets');

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
// The national broadcast networks iptv-org files under "general". The category
// as a whole is city public-access and community channels, but these are the
// same ABC, CBS, NBC and Fox tiles other sources list, and iptv-org carries dozens
// of working streams for them: dropping the category took NBC from 32 streams to
// 3 and Fox from 27 to 3.
const GENERAL_NETWORKS = /^(ABC|CBS|NBC|Fox|CW|MNT|Galavision|Telemundo(?: Internacional| Al Dia)?)$/i;
const NETWORK_IDS = new Set(Object.values(NETWORK_CHANNEL));
// The name each network's own tile carries, which is the name its logo is
// looked up by.
const LOGO_NAME = {
  'Fox.us': 'Fox', 'ABC.us': 'ABC', 'CBS.us': 'CBS', 'NBC.us': 'NBC', 'CW.us': 'CW', 'MNT.us': 'MNT',
  'PBS.us': 'PBS', 'Telemundo.us': 'Telemundo', 'Univision.us': 'Univision'
};

// How long the feed and city lists are kept. Stations move house rarely.
const PLACES_TTL_MS = 24 * 60 * 60 * 1000;

// A channel name as the logo index is keyed: "Fox Sports 1" and "FOX SPORTS1" meet.
const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\+/g, 'plus').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

const LOGO_INDEX_FILE = require('path').join(require('../config').DATA_DIR, 'iptv-logos.json');
const LOGO_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The call sign a set of stream titles mention, or ''. */
function callFromTitles(titles) {
  for (const t of titles || []) {
    for (const m of String(t || '').matchAll(/\b([KW][A-Z]{2,3}(?:-(?:TV|DT|CD|LD)\d*)?)\b/g)) {
      const call = callSign(m[1]);
      if (call) return call;
    }
  }
  return '';
}

class IptvOrgProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'IptvOrg';

    this.channelsUrl = 'https://iptv-org.github.io/api/channels.json';
    this.streamsUrl = 'https://iptv-org.github.io/api/streams.json';
    // Logos left the channel record and live in their own file now, several
    // per channel with dimensions and an in-use flag.
    this.logosUrl = 'https://iptv-org.github.io/api/logos.json';
    // Where each feed broadcasts (a station is a feed of its network's channel)
    // and what each city code means. Together 1.5 MB, fetched once a day.
    this.feedsUrl = 'https://iptv-org.github.io/api/feeds.json';
    this.citiesUrl = 'https://iptv-org.github.io/api/cities.json';
    this._places = null;
    // The name index the covers borrow logos from (logoForName), kept between
    // runs: a restart that serves its saved catalog does not run a sync for
    // minutes, and the covers drawn in between would otherwise go without.
    this._nameKey = nameKey;
    this._logoByName = this._loadLogoIndex();

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

  /**
   * The feed and city lists, indexed: which feeds broadcast to each city, and
   * the record behind each "channel/feed" key. Kept a day. When the fetch
   * fails the last copy stays in use, or, on a cold start, an empty one: the
   * station labels fall back to their bundled table and no local tiles are
   * listed until the next sync gets through.
   */
  async _loadPlaces() {
    if (this._places && Date.now() - this._places.at < PLACES_TTL_MS) return this._places;
    try {
      const [feeds, cities] = await Promise.all([
        this.proxyFetch(this.feedsUrl, { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
        this.proxyFetch(this.citiesUrl, { signal: AbortSignal.timeout(30000) }).then(r => r.json())
      ]);
      if (!Array.isArray(feeds) || !Array.isArray(cities)) throw new Error('unexpected shape');
      const cityByCode = new Map();
      for (const c of cities) if (c && c.country === this.country && c.code) cityByCode.set(c.code, c);
      const feedByKey = new Map();
      const feedsByCity = new Map();
      const feedCount = new Map();
      for (const f of feeds) {
        if (!f || !f.channel || !f.id) continue;
        feedByKey.set(`${f.channel}/${f.id}`, f);
        for (const a of Array.isArray(f.broadcast_area) ? f.broadcast_area : []) {
          if (!String(a).startsWith('ct/')) continue;
          const code = String(a).slice(3);
          if (!cityByCode.has(code)) continue;
          if (!feedsByCity.has(code)) feedsByCity.set(code, []);
          feedsByCity.get(code).push(f);
          feedCount.set(code, (feedCount.get(code) || 0) + 1);
        }
      }
      this._places = { at: Date.now(), cityByCode, feedByKey, feedsByCity, feedCount, cities: [...cityByCode.values()] };
    } catch (err) {
      console.warn(`[${this.name}] feed and city lists unavailable: ${err.message}`);
      if (!this._places) {
        this._places = { at: 0, cityByCode: new Map(), feedByKey: new Map(), feedsByCity: new Map(), feedCount: new Map(), cities: [] };
      } else {
        // Keep the old copy and try again in an hour rather than at once.
        this._places.at = Date.now() - PLACES_TTL_MS + 60 * 60 * 1000;
      }
    }
    return this._places;
  }

  async getMatches() {
    try {
      const data = await this.fetchData.fire();
      if (!data || !Array.isArray(data.channels) || !Array.isArray(data.streams)) return [];
      const places = await this._loadPlaces();

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
      const logoUrl = (channelId) => {
        const best = logoFor.get(channelId);
        const url = best && typeof best.url === 'string' ? best.url : '';
        return url.startsWith('//') ? `https:${url}` : url;
      };

      // A name index over every channel it has a logo for, in any country, kept
      // for channels other sources list. Primary names only: an alternate name
      // is how "US Open" came to match a local TV station's call sign. Each
      // entry remembers its country so the caller can insist on the right one.
      const byName = new Map();
      const chanById = new Map();
      for (const c of data.channels) {
        if (!c || !c.id) continue;
        chanById.set(c.id, c);
        if (!c.name || !logoFor.has(c.id)) continue;
        const k = nameKey(c.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push({ country: c.country, url: logoFor.get(c.id).url });
      }
      this._logoByName = byName;
      this._saveLogoIndex();

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
        const cats = Array.isArray(c.categories) ? c.categories.map(k => String(k).toLowerCase()) : [];
        if (cats.some(k => this.categories.has(k))) return true;
        return cats.includes('general') && GENERAL_NETWORKS.test(String(c.name).trim());
      });
      const wantedIds = new Set(wanted.map(c => c.id));

      // iptv-org files a few stations' streams under the wrong network --
      // "FOX 32 Chicago IL (WFLD)" sits under MNT. A feed whose stream titles
      // name another network is listed on that network's tile instead. Only
      // onto a tile that exists: a feed sent to a network not listed here
      // (PBS) would otherwise vanish from both.
      const homeOf = new Map();   // "channel/feed" -> the network channel its streams belong under
      for (const [id, list] of streamsFor) {
        if (!NETWORK_IDS.has(id)) continue;
        const byFeed = new Map();
        for (const s of list) {
          const k = String(s.feed || '');
          if (!byFeed.has(k)) byFeed.set(k, []);
          byFeed.get(k).push(s);
        }
        for (const [feed, ss] of byFeed) {
          // Streams with no feed are not one station: unrelated stations
          // share the '' key, so one title cannot speak for all of them.
          if (!feed) continue;
          const home = networkHome(ss.map(s => s.title), id);
          if (home && wantedIds.has(home)) homeOf.set(`${id}/${feed}`, home);
        }
      }
      const streamsOf = (id) => {
        const own = (streamsFor.get(id) || []).filter(s => !homeOf.has(`${id}/${String(s.feed || '')}`));
        if (!NETWORK_IDS.has(id)) return own;
        const adopted = [];
        for (const [key, home] of homeOf) {
          if (home !== id) continue;
          const slash = key.indexOf('/');
          const from = key.slice(0, slash), feed = key.slice(slash + 1);
          for (const s of streamsFor.get(from) || []) if (String(s.feed || '') === feed) adopted.push(s);
        }
        return own.concat(adopted);
      };

      // The stations of the cities anyone here has asked for, each to be a tile
      // of its own. A feed is one station; its streams are the ones filed on
      // that feed, not the channel's national ones.
      // Every city iptv-org has a feed for, not only the ones a profile named.
      // A station is its own tile wherever it is -- "FOX 32 Chicago", "NBC 5
      // Chicago News" -- so the network tiles stop being a bag of forty
      // stations. The cities a profile *did* name still decide the 📍 Local tab
      // and which stations sort first; that reads the setting, not this list.
      const markets = allMarkets(places.cities, places.feedsByCity);
      const localCandidates = [];
      const candidateKeys = new Set();   // a feed broadcast to two wanted cities is one station
      for (const market of markets) {
        for (const f of places.feedsByCity.get(market.code) || []) {
          if (candidateKeys.has(`${f.channel}/${f.id}`)) continue;
          const ch = chanById.get(f.channel);
          if (!ch || ch.closed || ch.country !== this.country) continue;
          const cats = (Array.isArray(ch.categories) ? ch.categories : []).map(k => String(k).toLowerCase());
          // Shopping and religious subchannels are not what "my local channels" means.
          if (cats.includes('shop') || cats.includes('religious')) continue;
          // A channel that is a tile already (CBS News Chicago) is not listed
          // twice. A network's feed is a different station from the network.
          if (wantedIds.has(f.channel) && !NETWORK_IDS.has(f.channel)) continue;
          const streams = (streamsFor.get(f.channel) || []).filter(s => String(s.feed || '') === String(f.id));
          if (!streams.length) continue;
          candidateKeys.add(`${f.channel}/${f.id}`);
          localCandidates.push({ market, feed: f, channel: ch, streams });
        }
      }

      if (!wanted.length && !localCandidates.length) return [];

      // A listed stream is not a reachable one. Contributions are not pruned
      // when a host goes away, so a channel can carry several URLs and no way
      // to play. Checking by host rather than by fetching keeps this to one
      // lookup per host no matter how many channels share it -- 338 hosts for
      // 336 channels here, answered in about a second -- and a host coming back
      // brings its channels with it without anybody editing a list.
      const hosts = new Set();
      const noteHost = (s) => { try { hosts.add(new URL(s.url).hostname); } catch (e) { /* not a url */ } };
      for (const c of wanted) for (const s of streamsOf(c.id)) noteHost(s);
      for (const cand of localCandidates) for (const s of cand.streams) noteHost(s);
      const alive = new Set();
      await Promise.all([...hosts].map(async h => {
        try { await dns.lookup(h); alive.add(h); } catch (e) { /* gone */ }
      }));

      const reachable = (s) => {
        try { return alive.has(new URL(s.url).hostname); } catch (e) { return false; }
      };

      // The stations that will get a tile of their own below. Keyed on the feed
      // the stream is *filed* under, which for a misfiled station is not the
      // tile it ends up on: WFLD is filed under MNT and adopted onto FOX.
      //
      // Computed with `some(reachable)` -- the same test the loop below uses to
      // decide whether to build the tile at all. Keying on the candidate list
      // instead would trim a stream off the network tile whose station then
      // never appeared, and it would be gone from both.
      const promoted = new Set();
      for (const cand of localCandidates) {
        if (cand.streams.some(reachable)) promoted.add(`${cand.feed.channel}/${cand.feed.id}`);
      }
      const promotedAway = (s) => promoted.has(`${s.channel}/${String(s.feed || '')}`);

      // What this actually takes off a network tile, which is *not*
      // promoted.size: most promoted stations -- a city's own channel, a school
      // district's -- were never on a network tile to be taken off one.
      let trimmed = 0;
      for (const c of wanted) for (const s of streamsOf(c.id)) if (reachable(s) && promotedAway(s)) trimmed++;

      // What iptv-org's feed list says about a stream's station, for its label.
      const filedFor = (channel, feedId) => {
        const f = places.feedByKey.get(`${channel}/${feedId}`);
        if (!f) return undefined;
        const area = (Array.isArray(f.broadcast_area) ? f.broadcast_area : []).find(a => String(a).startsWith('ct/'));
        const c = area ? places.cityByCode.get(String(area).slice(3)) : null;
        const state = c ? (String(c.subdivision || '').split('-')[1] || '') : '';
        const city = c ? `${c.name === 'New York City' ? 'New York' : c.name}${state ? ', ' + state : ''}` : '';
        const call = callSign(f.name);
        return city || call ? [city, call] : undefined;
      };
      // A source, labelled with its station when `station` says whose it is.
      const sourceOf = (s, station) => {
        const st = station ? stationLabel({ ...station, streamTitle: s.title }) : null;
        return {
          source: 'iptv-org',
          id: s.url,
          url: s.url,
          quality: s.quality || 'Auto',
          user_agent: s.user_agent,
          referrer: s.referrer,
          ...(st ? { station: st.label, stationSort: st.sort } : {})
        };
      };

      const matches = [];
      for (const c of wanted) {
        // What is left once its stations have their own tiles: the national
        // feed and its coastal variants ("Fox", "Fox West"). A network whose
        // every stream was a local station has nothing left and is skipped,
        // which is right -- CW and MNT are only ever local stations.
        const usable = streamsOf(c.id).filter(s => reachable(s) && !promotedAway(s));
        if (!usable.length) continue;

        const logo = logoUrl(c.id);
        // A national network's iptv-org entry is dozens of local stations.
        const isNetwork = GENERAL_NETWORKS.test(String(c.name).trim());

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
          // On a network tile each stream is a different local station, so it
          // says which one -- "Los Angeles, CA · KTTV" -- for the stream list.
          // A stream adopted from another network's entry keeps its own feed's
          // record, which is where its city is filed.
          sources: usable.map(s => sourceOf(s, isNetwork ? {
            channelId: s.channel || c.id, channelName: String(c.name).trim(), feed: s.feed,
            filed: filedFor(s.channel || c.id, s.feed)
          } : null))
        }));
      }

      // One tile per local station: "FOX 32 Chicago", "PHXTV", "CAN TV19".
      const perMarket = new Map();
      for (const { market, feed, channel, streams } of localCandidates) {
        const usable = streams.filter(reachable);
        if (!usable.length) continue;
        const titles = usable.map(s => s.title);
        const net = networkOfTitles(titles);
        const networkId = net ? net.channelId : (NETWORK_NAME[feed.channel] ? feed.channel : '');
        // A network affiliate wears its network's mark, found by name the way
        // the network's own tile finds it. iptv-org's logos for the networks
        // are not used: the "best" of Fox's is some affiliate's, and the same
        // one is filed under NBC and MNT too.
        const logo = networkId ? '' : logoUrl(feed.channel);
        const title = stationName({ channelName: channel.name, channelId: feed.channel, titles, city: market.name });
        // The feed is usually named for the station (KSAZTV); when it is not
        // (KNXV's is "HD") the stream titles name it: "ABC 15 Phoenix AZ (KNXV)".
        const call = callSign(feed.name) || callFromTitles(titles);
        const filed = [market.label, call];
        // The label's network is the tile's, so "FOX 32 Chicago" is not told
        // its own stream is "(FOX)".
        const asNetwork = net ? NETWORK_NAME[net.channelId] : (NETWORK_NAME[feed.channel] || channel.name);

        matches.push(new MatchEntity({
          id: `iptv_local_${feed.channel}_${feed.id}`,
          title,
          region: regionFromCode(channel.country),
          baseTitle: title,
          category: 'networks',
          date: '0',
          popular: '0',
          league: 'Local TV',
          genre: 'Local',
          market: market.label,
          station: call,
          // A network station's free stream is its news channel, and the
          // tile's description says so (catalog.js).
          newsStream: isNewsStream({ channelId: feed.channel, titles }),
          logoName: networkId ? LOGO_NAME[networkId] : '',
          thumbnail_url: logo,
          logo,
          sources: usable.map(s => sourceOf(s, { channelId: feed.channel, channelName: asNetwork, feed: feed.id, filed }))
        }));
        perMarket.set(market.label, (perMarket.get(market.label) || 0) + 1);
      }

      console.log(`[${this.name}] ${matches.length - [...perMarket.values()].reduce((a, b) => a + b, 0)} channels from ${wanted.length} listed `
        + `(${hosts.size - alive.size} of ${hosts.size} stream hosts are gone, `
        + `${matches.filter(m => m.logo).length} with a logo`
        + (homeOf.size ? `, ${homeOf.size} station feeds moved to their own network` : '') + ')');
      if (perMarket.size) {
        const stations = [...perMarket.values()].reduce((a, b) => a + b, 0);
        console.log(`[${this.name}] local stations: ${stations} in ${perMarket.size} cities`
          + `, ${trimmed} streams taken off a network's tile`);
      }
      return matches;
    } catch (error) {
      console.error(`[${this.name}] Error fetching channels:`, error.message);
      return [];
    }
  }

  _loadLogoIndex() {
    try {
      const fs = require('fs');
      const saved = JSON.parse(fs.readFileSync(LOGO_INDEX_FILE, 'utf8'));
      if (!saved || !Array.isArray(saved.index) || Date.now() - Number(saved.at) > LOGO_INDEX_MAX_AGE_MS) return null;
      return new Map(saved.index);
    } catch (e) {
      return null;   // first run, or unreadable
    }
  }

  _saveLogoIndex() {
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').dirname(LOGO_INDEX_FILE), { recursive: true });
      const tmp = LOGO_INDEX_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), index: [...this._logoByName] }));
      fs.renameSync(tmp, LOGO_INDEX_FILE);
    } catch (e) { /* memory only, as before */ }
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
