const container = require('./container');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// How long the stream list waits on its sources. Past this, whatever answered
// is what the viewer gets and the rest keep resolving into the cache behind
// them. The second figure applies only when nothing has answered at all, where
// waiting beats handing back an empty list.
const SOURCE_DEADLINE_MS = Number(process.env.STREAM_DEADLINE_MS) || 3500;
const SOURCE_HARD_DEADLINE_MS = Number(process.env.STREAM_HARD_DEADLINE_MS) || 9000;

// Source selection (shared by handleStream and prewarmMatch)
function selectSources(matchSources, config) {
  const SOURCE_PRIORITY = { admin: 1, echo: 1, golf: 1, delta: 1, 'watchfooty': 2, 'cdnlive': 3, 'streamsports99': 4, 'streamic': 5, 'streamfree': 8, 'timstreams': 9, 'sportyhunter': 12, 'streamsports': 13, 'iptv-org': 14, 'embedindia': 15 };

  // A user-defined order, set in the configure page, outranks the built-in
  // priorities entirely — it is an explicit preference, where SOURCE_PRIORITY
  // is only a guess at which providers behave. Sources the user never ordered
  // keep their built-in ranking behind the ones they did.
  const userOrder = config && typeof config.sourceOrder === 'string' && config.sourceOrder
    ? config.sourceOrder.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const userRank = (src) => {
    if (!userOrder) return null;
    const i = userOrder.indexOf(src);
    return i === -1 ? null : i;
  };

  const sortedSources = [...matchSources].sort((a, b) => {
    if (userOrder) {
      const ra = userRank(a.source);
      const rb = userRank(b.source);
      if (ra !== null || rb !== null) {
        if (ra === null) return 1;         // unordered sources sit behind ordered ones
        if (rb === null) return -1;
        if (ra !== rb) return ra - rb;
      }
    }
    // Unknown sources that are not known fallback providers are likely new
    // Streamed.pk sources - priority 1.5 keeps them near the top.
    const getPriority = (src) => SOURCE_PRIORITY[src] ?? (['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org'].includes(src) ? 99 : 1.5);
    const pa = getPriority(a.source);
    const pb = getPriority(b.source);
    if (pa !== pb) return pa - pb;
    return 0;
  });

  if (config && typeof config.sources === 'string' && config.sources !== 'none') {
    const enabled = config.sources.split(',');
    const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedindia', 'embedst', 'streamedpk'];
    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source);
      if (isFallback) {
        return enabled.includes(src.source);
      }
      return false;
    });
  }

  const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedst', 'streamedpk'];
  return sortedSources.filter(src => {
    if (src.source.startsWith('yaml_')) return true;
    return KNOWN_FALLBACKS.includes(src.source);
  });
}

// Resolve a single source (extracted from handleStream, logic unchanged)
async function resolveSource(src, match, config) {
  const streamScorer = container.resolve('streamScorer');
  const sourceName = src.source;
  let resStreams = [];

  try {
    if (sourceName === 'streamfree') {
      const provider = container.resolve('streamFreeProvider');
      const sfCategory = src.original_category || match.category;
      resStreams = await provider.resolveStream(src.id, sfCategory, match.title);
    } else if (sourceName === 'timstreams') {
      const provider = container.resolve('timStreamsProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'sportyhunter') {
      const provider = container.resolve('sportyHunterProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);

    } else if (sourceName === 'watchfooty') {
      const provider = container.resolve('watchFootyProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'cdnlive') {
      const provider = container.resolve('cdnLiveProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'streamsports99') {
      const provider = container.resolve('streamSports99Provider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title);
    } else if (sourceName === 'streamic') {
      const provider = container.resolve('streamicProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'iptv-org') {
      const proxyHeaders = {};
      if (src.user_agent) proxyHeaders['User-Agent'] = src.user_agent;
      if (src.referrer) proxyHeaders['Referer'] = src.referrer;

      resStreams = [{
        name: 'Nuvio Direct',
        title: `24/7 TV (${src.quality || 'Auto'})`,
        url: src.url,
        resolution: src.quality,
        behaviorHints: {
          proxyHeaders: {
            request: proxyHeaders
          }
        }
      }];
    } else if (sourceName === 'embedindia') {
      const provider = container.resolve('embedIndiaProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'embedst') {
      const provider = container.resolve('embedStProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName === 'streamedpk') {
      const provider = container.resolve('streamedPkProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
    } else if (sourceName.startsWith('yaml_')) {
      const yamlProviders = container.resolve('yamlProviders');
      const pName = sourceName.replace('yaml_', '');
      const provider = yamlProviders.find(p => p.name === pName);
      if (provider) {
        resStreams = await provider.resolveStream(src.id, match.category, match.title);
      }
    } else {
      // Unknown or unsupported source, ignore
      resStreams = [];
    }

    for (const s of resStreams) {
      s.score = streamScorer.calculateScore(s, sourceName);
      s._source = sourceName;
    }
  } catch (e) {
    console.warn(`[streams.js] Error resolving ${sourceName} for ${src.id}:`, e.message);
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const { safeFetch: _safeFetch } = require('./impitClient');


// --- Stream Health Verification ---
// Pings each direct stream once and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links (no url or '/watch?') pass through
// untouched. Runs once per mint (see mintVerifiedSources), not per request, so
// cached results are served without re-verification.
async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache) {

  const checkedStreams = await Promise.all(streams.map(async (s) => {
    // We only pre-flight check direct streams (m3u8 urls). Web player links are kept blindly.
    if (!s.url || s.url.includes('/watch?')) return s;

    let targetUrl = s.url;
    let referer = '';
    let origin = '';
    // If the stream is routed through our manifest proxy, we extract the true upstream URL to ping
    if (targetUrl.includes('/api/manifest')) {
      try {
        const urlObj = new URL('http://localhost' + targetUrl);
        if (urlObj.searchParams.has('url')) {
          targetUrl = urlObj.searchParams.get('url');
        }
        if (urlObj.searchParams.has('referer')) {
          referer = urlObj.searchParams.get('referer');
        }
        if (urlObj.searchParams.has('origin')) {
          origin = urlObj.searchParams.get('origin');
        }
      } catch (e) {}
    }

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 5000); // 5 second timeout to allow slow edge CDNs (wfty/strmd) to respond

      if (!referer && s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) {
        referer = s.behaviorHints.proxyHeaders.request.Referer || '';
      }
      if (!origin && referer) {
        try { origin = new URL(referer).origin; } catch (_) {}
      }

      let res;
      let bodySample = '';

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': referer
      };
      if (origin) reqHeaders['Origin'] = origin;

      try {
        // _safeFetch handles impit -> undici fallback automatically on all platforms
        const result = await _safeFetch(targetUrl, {
          method: 'GET',
          headers: reqHeaders,
          signal: abortController.signal,
          timeoutMs: 5000,
        });
        res = { status: result.status };
        bodySample = await result.text();
      } catch (fetchErr) {
        clearTimeout(timeout);
        console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${fetchErr.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      clearTimeout(timeout);

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        console.log(`[Filter] Dropped dead stream (${res.status}): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT, it's not a valid m3u8 playlist.
      if (!bodySample.includes('#EXT')) {
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${targetUrl}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Parse Master Playlist quality, framerate (FPS), and bitrate in real-time
      const parsedQuality = m3u8Parser.parseManifestText(bodySample);
      if (parsedQuality) {
        if (parsedQuality.qualityTag) s.quality = parsedQuality.qualityTag;
        if (parsedQuality.resolution) s.resolution = parsedQuality.resolution;
        if (parsedQuality.bitrateTag) s.bitrate = parsedQuality.bitrateTag;
      }

      if (cacheKey) resolveCache.noteSuccess(cacheKey);
      return s;
    } catch (err) {
      console.log(`[Filter] Dropped timeout/error stream: ${targetUrl} - ${err.message}`);
      return null;
    }
  }));

  return checkedStreams.filter(Boolean);
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
async function mintVerifiedSources(src, match, config, cacheKey) {
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const minted = await resolveSource(src, match, config);
  return verifyStreams(minted, cacheKey, m3u8Parser, resolveCache);
}

// Prewarm: mint tokens for a match's top sources before the user clicks
// Warm every source a match has, not the first three. The click resolves all of
// them, so warming three left the warm ones returning instantly and then waiting
// on the cold tail -- which is the wait the deadline above now truncates. Warm
// the lot and, in the normal case, the deadline is never reached at all.
async function prewarmMatch(match, config, topN = 12) {
  try {
    if (!match || !match.sources || !match.sources.length) return;
    const resolveCache = container.resolve('streamResolveCache');
    const activeSources = selectSources(match.sources, config || null);
    const targets = activeSources.slice(0, topN);
    if (targets.length === 0) return;
    console.log(`[Prewarm] minting ${targets.length} sources for ${match.id}`);
    await Promise.allSettled(targets.map(src => {
      const key = `${src.source}:${match.id}:${src.id}`;
      if (resolveCache.get(key)) return Promise.resolve(null);
      return resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config || null, key));
    }));
  } catch (err) {
    console.warn('[Prewarm] failed:', err.message);
  }
}


async function handleStream(type, id, config) {
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { streams: [] };
  }

  const matchId = id.replace('nuvio_sport_', '');
  
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match || !match.sources || match.sources.length === 0) {
    return { streams: [] };
  }

  const streams = [];

  const activeSources = selectSources(match.sources, config);
  const streamScorer = container.resolve('streamScorer');

  const resolveCache = container.resolve('streamResolveCache');

  const resolvePromises = activeSources.map(async (src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    const minted = await resolveCache.getOrCreate(key, () => mintVerifiedSources(src, match, config, key));
    return minted.map((s) => ({ ...s, _cacheKey: key }));
  });

  // Wait for the sources, but not for the worst of them.
  //
  // Every source was awaited to completion, so the spinner after Play lasted as
  // long as the slowest one even when a good source had answered in 300 ms --
  // measured at nearly eleven seconds on a match with several sources.
  //
  // Nothing is discarded by giving up on the wait. Each promise is a
  // resolveCache.getOrCreate, which stores its result whenever it finishes, so a
  // straggler keeps going and lands in the cache regardless. It simply arrives
  // for the next request instead of holding up this one.
  const collected = [];
  let finished = 0;
  let markAllDone;
  const allDone = new Promise(resolve => { markAllDone = resolve; });

  for (const p of resolvePromises) {
    p.then(
      value => { if (Array.isArray(value)) collected.push(...value); },
      () => { /* a failed source is one fewer option, not an error */ }
    ).finally(() => {
      if (++finished === resolvePromises.length) markAllDone();
    });
  }

  await Promise.race([allDone, sleep(SOURCE_DEADLINE_MS)]);

  // Only when nothing at all has landed. Waiting for a fuller list was tried and
  // measured worse: on matches whose sources are simply empty, holding on for
  // six streams spent the whole extra budget to gain nothing -- a mean of 8.5 s
  // to return one stream, where stopping early returned the same one stream in
  // three. Sources that are slow rather than empty are handled by warming them
  // before the click, not by waiting longer after it.
  if (collected.length === 0 && finished < resolvePromises.length) {
    await Promise.race([allDone, sleep(SOURCE_HARD_DEADLINE_MS - SOURCE_DEADLINE_MS)]);
  }

  streams.push(...collected);

  // --- Inject relevant 24/7 channels based on category ---
  const isStreamFreeEnabled = !config || !config.sources || config.sources === 'none' || config.sources.split(',').includes('streamfree');
  if (match.category === 'cricket' && isStreamFreeEnabled) {
    try {
      const extraChannels = [
        { id: 'willow', title: 'Willow TV' },
        { id: 'skycricket', title: 'Sky Sports Cricket' }
      ];
      
      const warmed = await Promise.all(extraChannels.map(async (channel) => {
        const key = `streamfree:__channel__:${channel.id}`;
        const resolved = await resolveCache.getOrCreate(key, () => mintVerifiedSources(
          { source: 'streamfree', id: channel.id, original_category: 'cricket' },
          { category: 'cricket', title: channel.title },
          config,
          key
        ));
        return resolved.map((s) => ({ ...s, _cacheKey: key }));
      }));
      warmed.flat().forEach((s) => {
        s.score = streamScorer.calculateScore(s, 'streamfree');
        s._source = 'streamfree';
        streams.push(s);
      });
    } catch (e) {
      console.warn('[streams.js] Error injecting 24/7 cricket channels:', e.message);
    }
  }

  // Standardize Stream Labels
  const sportIcons = {
    football: '⚽', cricket: '🏏', motorsport: '🏎️',
    basketball: '🏀', american_football: '🏈', rugby: '🏉', networks: '📺'
  };
  const icon = sportIcons[match.category] || '📡';
  
  const niceNames = {
    streamfree: 'StreamFree', timstreams: 'TimStreams',
    sportyhunter: 'SportyHunter', streamsports: 'StreamSports',
    'iptv-org': 'Direct IPTV', 'streamsports99': 'StreamSports99',
    'streamic': 'Streamic',
    'embedindia': 'EmbedIndia', 'embedst': 'Embed.st', 'streamedpk': 'Streamed.pk'
  };

  streams.forEach(s => {
    let quality = s.resolution || s.quality || 'Auto';
    if (String(quality).includes('x')) {
       const h = String(quality).split('x')[1];
       quality = h + 'p';
    }
    
    const isWeb = !!s.externalUrl || s.name === 'Nuvio Web Player';
    // The scorer attached the sourceName as _source in calculateScore? No, we didn't attach it.
    // Wait, streamScorer doesn't attach sourceName to s.
    // I can determine providerName from the string it already had.
    let providerName = niceNames[s._source] || niceNames[Object.keys(niceNames).find(k => s.title && s.title.toLowerCase().includes(k))] || 'Streamed.pk';
    
    if (s.title && s.title.toLowerCase().includes('timstreams')) providerName = 'TimStreams';
    else if (s.title && s.title.toLowerCase().includes('sporty')) providerName = 'SportyHunter';
    else if (s.title && s.title.toLowerCase().includes('streamfree')) providerName = 'StreamFree';
    else if (s.title && s.title.toLowerCase().includes('watchfooty')) providerName = 'WatchFooty';
    else if (s.title && s.title.toLowerCase().includes('cdnlive')) providerName = 'CDNLiveTV';
    else if (s.title && s.title.toLowerCase().includes('streamsports99')) providerName = 'StreamSports99';
    else if (s.title && s.title.toLowerCase().includes('streamic')) providerName = 'Streamic';
    else if (s.title && s.title.toLowerCase().includes('24/7')) providerName = 'Direct IPTV';

    let originalTitle = s.title || '';
    let channelName = '';
    let viewersText = '';
    if (originalTitle) {
      const vMatch = originalTitle.match(/👥\s*\d+\s*Viewers/);
      if (vMatch) viewersText = `\n${vMatch[0]}`;

      const match = originalTitle.match(/\(([^)]+)\)/);
      if (match && match[1]) {
        const inner = match[1];
        if (!inner.match(/^[0-9]{3,4}p$/i) && inner !== 'Auto' && !inner.toLowerCase().startsWith('stream')) {
          channelName = inner;
        }
      } else if (!originalTitle.includes('Stream') && !originalTitle.includes('Auto')) {
        channelName = originalTitle;
      }
    }
    // Determine Group
    s.name = isWeb ? '🌐 Web Stream' : '⚡ Direct Stream';
    
    if (channelName) {
      // Don't format title case if it breaks our channel name. Actually, just clean it up slightly.
      channelName = channelName.trim();
    }
    
    const channelDisplay = channelName ? ` | 📺 ${channelName}` : '';
    s.title = `${icon} ${providerName}${channelDisplay}\n📺 Quality: ${quality}${viewersText}`;
    
    // Add behaviorHints to group streams and handle CORS for direct streams
    s.behaviorHints = s.behaviorHints || {};
    s.behaviorHints.bingeGroup = `nuvio_sport_${matchId}`;
    
    // If it's a direct m3u8 stream and not routed through our proxy, mark it notWebReady
    if (s.url && s.url.includes('.m3u8') && !s.url.includes('/api/manifest')) {
      if (providerName !== 'Direct IPTV') {
        s.behaviorHints.notWebReady = true;
      }
      
      let referer = '';
      if (providerName === 'Streamed.pk') referer = 'https://embed.st/';
      else if (providerName === 'WatchFooty') referer = 'https://watchfooty.st/';
      else if (providerName === 'CDNLiveTV') referer = 'https://cdnlivetv.tv/';
      else if (providerName === 'Streamic') referer = 'https://streamic.st/';
      else if (providerName === 'StreamSports99' || providerName === 'StreamSports') referer = 'https://streamsports99.fun/';
      else if (providerName === 'SportyHunter') referer = 'https://sportyhunter.xyz/';
      
      if (referer) {
        if (!s.behaviorHints.proxyHeaders) {
          s.behaviorHints.proxyHeaders = {
            request: {
              "Referer": referer,
              "Origin": referer
            }
          };
        }
      }
    }
    
    // Add extra info if present
    if (providerName === 'Direct IPTV' && s.url) {
      s.title = `📺 ${channelName || '24/7 Live Network'}\n⚙️ Quality: ${quality}`;
    }
  });

  // Sort streams by kind first, then by score descending.
  //
  // "Direct" means the app can play it itself; "web" means it hands off to a
  // browser. Direct first is the default because it is the better experience,
  // but a user whose direct streams buffer on their setup can invert it from
  // the configure page. Kind is read off the stream itself — a direct stream
  // has a url, a web one has an externalUrl — rather than off its display
  // name, which is cosmetic and has already changed once.
  // A third setting, 'none', turns the grouping off entirely: the viewer does
  // not want either kind promoted, so the list falls back to pure quality
  // order. Only the grouping goes -- score still decides, because unranked is
  // not what "no preference between direct and web" asks for.
  const order = config && config.streamOrder;
  const webFirst = order === 'web';
  const groupByKind = order !== 'none';
  streams.sort((a, b) => {
    if (groupByKind) {
      const aDirect = a.url ? 1 : 0;
      const bDirect = b.url ? 1 : 0;
      if (aDirect !== bDirect) return webFirst ? aDirect - bDirect : bDirect - aDirect;
    }
    return b.score - a.score;
  });

  // Verification now happens once per mint (mintVerifiedSources), not per request.
  // Adaptive per-source TTLs keep tokens fresh, so clients may hold the list 30s.
  return {
    streams,
    // Deliberately not cached by the client.
    //
    // The protocol has no way to deliver streams progressively -- one request,
    // one array -- so a source that resolves after the response cannot be sent.
    // It does land in the cache, though, which makes the client's own reload
    // button the way to see it: pressing it re-asks and gets the fuller list,
    // in milliseconds, because the work is already done. A thirty-second cache
    // defeated exactly that, handing back the same thin list it had just shown.
    cacheMaxAge: 0,
    staleRevalidate: 0,
    staleError: 60
  };
}

module.exports = {
  handleStream,
  prewarmMatch
};
