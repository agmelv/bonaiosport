const container = require('./container');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// How long the stream list waits on its sources. Past this, whatever answered
// is what the viewer gets and the rest keep resolving into the cache behind
// them. The second figure applies only when nothing has answered at all, where
// waiting beats handing back an empty list.
const SOURCE_DEADLINE_MS = Number(process.env.STREAM_DEADLINE_MS) || 3500;
const SOURCE_HARD_DEADLINE_MS = Number(process.env.STREAM_HARD_DEADLINE_MS) || 9000;
// SOURCE_DEADLINE_MS no longer ends the wait on its own -- see the wait in
// handleStream -- and is kept as the point past which a partial list would be
// served, should that ever be wanted again.

// Source selection (shared by handleStream and prewarmMatch)
function selectSources(matchSources, config) {
  const SOURCE_PRIORITY = { admin: 1, echo: 1, golf: 1, delta: 1, 'watchfooty': 2, 'cdnlive': 3, 'streamsports99': 4, 'streamic': 5, 'streamfree': 8, 'timstreams': 9, 'usatv': 10, 'sportyhunter': 12, 'streamsports': 13, 'iptv-org': 14, 'embedindia': 15 };

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

  // Every source turned off means no streams, not every stream. The page writes
  // 'none' for an empty selection, and skipping the filter on it turned the one
  // setting that should disable everything into the one that enabled everything.
  if (config && config.sources === 'none') return [];

  if (config && typeof config.sources === 'string') {
    const enabled = config.sources.split(',');
    const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedindia', 'embedst', 'streamedpk', 'usatv'];
    return sortedSources.filter(src => {
      if (src.source.startsWith('yaml_')) return true;
      const isFallback = KNOWN_FALLBACKS.includes(src.source);
      if (isFallback) {
        return enabled.includes(src.source);
      }
      return false;
    });
  }

  const KNOWN_FALLBACKS = ['watchfooty', 'cdnlive', 'streamsports99', 'streamic', 'streamfree', 'timstreams', 'sportyhunter', 'streamsports', 'iptv-org', 'embedst', 'streamedpk', 'usatv'];
  return sortedSources.filter(src => {
    if (src.source.startsWith('yaml_')) return true;
    return KNOWN_FALLBACKS.includes(src.source);
  });
}

// Resolve a single source (extracted from handleStream, logic unchanged)
// `opts.strict` rethrows a provider's error instead of returning no streams;
// only the channel health check asks for it (see countChannelStreams).
async function resolveSource(src, match, config, opts = {}) {
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
      resStreams = await provider.resolveStream(src.id, match.category, match.title, { strict: !!opts.strict });
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
    } else if (sourceName === 'usatv') {
      const provider = container.resolve('usaTvProvider');
      resStreams = await provider.resolveStream(src.id, match.category, match.title, { strict: !!opts.strict });
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
    if (opts.strict) throw e;
  }

  return resStreams;
}

// Safe impit+undici helper — works on all platforms (Windows, Linux x64/ARM64, musl).
// impit is tried first for browser TLS fingerprinting; undici is the automatic fallback.
const { safeFetch: _safeFetch } = require('./impitClient');


const { redactUrl } = require('./redact');
// --- Stream Health Verification ---
// Pings each direct stream once and drops dead ones (404/403/5xx, or 200 bodies
// that are not M3U8). Web player links (no url or '/watch?') pass through
// untouched. Runs once per mint (see mintVerifiedSources), not per request, so
// cached results are served without re-verification.
// How many playlists are checked at once. Unbounded, one fixture opened a dozen
// simultaneous requests to the same handful of edge hosts, and prewarm ran eight
// fixtures beside it -- so the addon congested the CDN it was asking about and
// then dropped, as dead, streams it had extracted successfully a second earlier.
// The logs showed exactly that: "Successfully extracted" followed by "Dropped
// timeout/error stream ... impit timeout 5000ms" for the same URL.
const VERIFY_CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY) || 6;

/** Run `job` over `items`, at most `limit` at a time, preserving order. */
async function mapLimit(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await job(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// `opts.report`, when given, counts streams dropped because the check itself
// failed -- a timeout, a network error, a 5xx -- apart from streams that are
// plainly dead (404, 403, not a playlist).
async function verifyStreams(streams, cacheKey, m3u8Parser, resolveCache, opts = {}) {

  const checkedStreams = await mapLimit(streams, VERIFY_CONCURRENCY, (async (s) => {
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
        // Only the head of the playlist is needed: a valid one starts #EXTM3U on
        // its first line. A server that ignores Range sends the whole body, which
        // is what happened before, so this can only help.
        const result = await _safeFetch(targetUrl, {
          method: 'GET',
          headers: { ...reqHeaders, Range: 'bytes=0-2047' },
          signal: abortController.signal,
          timeoutMs: 5000,
        });
        res = { status: result.status };
        bodySample = await result.text();
      } catch (fetchErr) {
        clearTimeout(timeout);
        if (opts.report) opts.report.errors++;
        console.log(`[Filter] Dropped timeout/error stream: ${redactUrl(targetUrl)} - ${fetchErr.message}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      clearTimeout(timeout);

      // Edge servers return 404 for dead streams, 403 for IP-locked/expired tokens, 502 for upstream failures
      if (res.status === 404 || res.status === 403 || res.status >= 500) {
        if (opts.report && res.status >= 500) opts.report.errors++;
        console.log(`[Filter] Dropped dead stream (${res.status}): ${redactUrl(targetUrl)}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // A host that is throttling or timing out has said nothing about the stream
      // itself: dropped for now, but counted as a failed check, not a dead one.
      if (res.status === 429 || res.status === 408) {
        if (opts.report) opts.report.errors++;
        console.log(`[Filter] Dropped throttled stream (${res.status}): ${redactUrl(targetUrl)}`);
        if (cacheKey) resolveCache.noteFailure(cacheKey);
        return null;
      }

      // Some CDNs (like lb8.strmd.st) return 200 OK with "Not found" when token is expired.
      // If it doesn't contain #EXT, it's not a valid m3u8 playlist.
      if (!bodySample.includes('#EXT')) {
        console.log(`[Filter] Dropped fake 200 stream (Invalid M3U8 body): ${redactUrl(targetUrl)}`);
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
      if (opts.report) opts.report.errors++;
      console.log(`[Filter] Dropped timeout/error stream: ${redactUrl(targetUrl)} - ${err.message}`);
      return null;
    }
  }));

  return checkedStreams.filter(Boolean);
}

// Mint streams for a single source and health-verify them before they enter the
// cache, so verification runs once per mint instead of on every request.
async function mintVerifiedSources(src, match, config, cacheKey, opts = {}) {
  const resolveCache = container.resolve('streamResolveCache');
  const m3u8Parser = container.resolve('m3u8Parser');
  const minted = await resolveSource(src, match, config, opts);
  return verifyStreams(minted, cacheKey, m3u8Parser, resolveCache, opts);
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
  const startedAt = Date.now();
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

  // Wait for every source, capped by the hard deadline.
  //
  // Returning at the 3.5s deadline is what made the list change between looks:
  // the first open showed whatever had landed by then, the rest arrived in the
  // cache a moment later, and the same match that had just shown 8 streams
  // showed 12 on a reload. The way to see the full list was to ask twice.
  //
  // Two cheaper rules were tried on the live server and both failed the same
  // way. A fixed 2.5s extension cut the slowest sources off at exactly the cap.
  // Waiting only while answers kept arriving did no better: when the quick
  // sources all answer inside a second and one slow source is still working,
  // "nothing has answered lately" and "something is still working" look
  // identical from here, so the wait ended around 3.7s with the slow one still
  // in flight. Four of thirteen cold matches grew on a refresh under each.
  //
  // Nothing observable separates a slow source from a stuck one, so the choice
  // is which mistake to make. A list that changes when you look again is the
  // worse one: it reads as broken, and the only remedy available to the viewer
  // is to keep refreshing until it settles. Waiting costs seconds, and only on
  // a cold open -- a warmed match answers in well under a second, which is what
  // the prewarming in catalog.js is for.
  if (finished < resolvePromises.length) {
    const remaining = SOURCE_HARD_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining > 0) await Promise.race([allDone, sleep(remaining)]);
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
    'embedindia': 'EmbedIndia', 'embedst': 'Embed.st', 'streamedpk': 'Streamed.pk',
    'usatv': 'USA TV'
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

      // "WatchFooty Stream 3": the provider numbers its own mirrors, and that
      // number is the only thing telling six otherwise identical rows apart.
      // Both rules below treat a title carrying the word "Stream" as
      // boilerplate, which threw the number away and left the viewer choosing
      // between six rows that read the same and behave differently.
      const numbered = originalTitle.match(/\bstream\s*#?\s*(\d+)\s*$/i);
      const match = originalTitle.match(/\(([^)]+)\)/);
      if (numbered) {
        channelName = 'Stream ' + numbered[1];
      } else if (match && match[1]) {
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
      s.title = `📺 ${channelName || 'Live channel'}\n⚙️ Quality: ${quality}`;
    }
  });

  // No two rows may read identically. Six lines saying "WatchFooty / Quality:
  // HD" are six coin flips: they play different mirrors, one of them works, and
  // nothing on screen says which one has already been tried. Providers that
  // number their own mirrors are handled above; this is the backstop for the
  // ones that do not, and for any that stop.
  const byLabel = new Map();
  for (const s of streams) {
    const key = s.title || '';
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(s);
  }
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    group.forEach((s, i) => {
      // Appended to the first line, beside the provider, so the quality line
      // underneath keeps reading the way it does on every other row.
      const nl = String(s.title).indexOf('\n');
      s.title = nl === -1
        ? `${s.title} · ${i + 1}`
        : `${s.title.slice(0, nl)} · ${i + 1}${s.title.slice(nl)}`;
    });
  }

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

/**
 * How many directly playable streams a 24/7 channel opens to, for the
 * background check in ChannelHealth.
 *
 * Throws whenever the honest answer is "unknown" rather than "none", so a
 * channel is only ever hidden on evidence:
 *   - it is not listed right now (a provider blinked between refreshes);
 *   - its only sources are CDNLive and CDNLive was not probed this time -- it is
 *     probed a little at a time (see takeCdnHealthBudget) and never while it
 *     has this server paused -- or nothing it has besides CDNLive played;
 *   - the check ran past its cap;
 *   - it came back with web-player rows and nothing direct, which a working
 *     web-only channel does too.
 * Every source is waited for, with no stream deadline, so a slow channel is
 * counted in full and the sweep does not start the next channel early.
 */
const HEALTH_CHECK_CAP_MS = 60 * 1000;

// CDNLive is checked a little at a time. Decoding its player pages in bulk is
// what got this server rate-limited for an hour, but never checking them left
// every dead CDNLive channel listed for good: its playlists answered 503 a
// hundred and forty times in one hour. Forty an hour covers the lot over a few
// sweeps without a burst.
const CDNLIVE_HEALTH_PER_HOUR = Number(process.env.CDNLIVE_HEALTH_PER_HOUR) || 40;
const cdnHealthTimes = [];
function takeCdnHealthBudget() {
  const now = Date.now();
  while (cdnHealthTimes.length && now - cdnHealthTimes[0] > 60 * 60 * 1000) cdnHealthTimes.shift();
  if (cdnHealthTimes.length >= CDNLIVE_HEALTH_PER_HOUR) return false;
  cdnHealthTimes.push(now);
  return true;
}

async function countChannelStreams(matchId) {
  const match = container.resolve('cacheService').getMatches().find(m => m.id === matchId);
  if (!match || !Array.isArray(match.sources) || !match.sources.length) throw new Error('not listed now');

  const hasCdn = match.sources.some(src => src.source === 'cdnlive');
  let probeCdn = false;
  if (hasCdn) {
    let benched = false;
    try { benched = container.resolve('cdnLiveProvider').isBenched(); } catch (e) { benched = true; }
    probeCdn = !benched && takeCdnHealthBudget();
  }
  const unprobed = hasCdn && !probeCdn;
  const sources = selectSources(match.sources, {}).filter(src => probeCdn || src.source !== 'cdnlive');
  if (!sources.length) throw new Error('no sources this check probes');

  const resolveCache = container.resolve('streamResolveCache');
  const isWeb = s => !!s.externalUrl || s.name === 'Nuvio Web Player';
  const directIn = rows => (Array.isArray(rows) ? rows : []).filter(s => s && s.url && !isWeb(s)).length;

  // Sources whose empty answer is an answer. Streamed.pk and StreamFree fetch
  // through a circuit breaker whose fallback turns an outage or a throttle into
  // an empty list, so from them "nothing" says nothing. CDNLive under strict
  // throws for everything that is not a real answer.
  const EMPTY_MEANS_NONE = new Set(['iptv-org', 'usatv', 'cdnlive']);

  // Each source's outcome. A source someone opened recently counts from the
  // cache when it holds playable streams. Anything else is resolved here,
  // outside the cache and strictly, so that a provider error, a throttle or a
  // playlist that failed to answer comes back as a failure rather than as an
  // empty list -- the resolver and the cache both turn failures into "none".
  const settled = Promise.allSettled(sources.map(async (src) => {
    const key = `${src.source}:${matchId}:${src.id}`;
    const cached = resolveCache.get(key);
    const cachedRows = Array.isArray(cached) ? cached : (cached && cached.streams);
    if (directIn(cachedRows) > 0) return { direct: directIn(cachedRows), errors: 0, web: false, trusted: true };
    const report = { errors: 0 };
    const rows = await mintVerifiedSources(src, match, {}, null, { strict: true, report });
    return {
      direct: directIn(rows),
      errors: report.errors,
      web: rows.some(s => s && isWeb(s)),
      trusted: EMPTY_MEANS_NONE.has(src.source)
    };
  }));

  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('check ran past its cap')), HEALTH_CHECK_CAP_MS);
  });
  // Past the cap the answer is unknown, but the scrapes this check started are
  // let finish (up to another cap) before the sweep moves on, so a slow
  // channel's work does not pile up under the next channel's.
  const results = await Promise.race([settled, cap])
    .catch(async (e) => { await Promise.race([settled, sleep(HEALTH_CHECK_CAP_MS)]); throw e; })
    .finally(() => clearTimeout(timer));

  const outcomes = results.map(r => (r.status === 'fulfilled' ? r.value : null));
  const failed = o => !o || o.errors > 0;
  const direct = outcomes.reduce((n, o) => n + (o ? o.direct : 0), 0);
  if (direct > 0) return direct;
  if (unprobed) throw new Error('only unprobed sources left');
  if (outcomes.some(o => o && o.web)) throw new Error('web-player rows only');
  if (outcomes.every(failed)) {
    // Every source failed outright or had every playlist fail to answer.
    // Tagged, so a channel whose hosts stay down check after check can still
    // be hidden (see ChannelHealth), while one bad minute cannot.
    const err = new Error('every source failed');
    err.allFailed = true;
    throw err;
  }
  if (outcomes.some(failed)) throw new Error('a source failed or timed out');
  if (outcomes.some(o => !o.trusted)) throw new Error('empty from a source that hides its failures');
  return 0;
}

module.exports = {
  handleStream,
  prewarmMatch,
  countChannelStreams
};
