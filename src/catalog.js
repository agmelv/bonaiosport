const container = require('./container');
const { getChannelLogo } = require('./services/ChannelLogoService');
const { prewarmMatch } = require('./streams');
const { BASE_URL } = require('./config');
const imageService = require('./services/ImageService');
const teamLogoService = require('./services/TeamLogoService');
const homeAway = require('./services/HomeAwayService');
const eventMarks = require('./services/EventMarkService');
const leagueBadges = require('./services/LeagueBadgeService');

// Titles that already name the visiting side first: "Rockies @ Yankees",
// "Missouri at Kansas". Anything else ("A vs B", "A - B") conventionally names
// the host first and needs swapping to put the visitor on the left.
const VISITOR_FIRST = /\s(?:@|at)\s/i;

/**
 * What a category is called on the card. The internal name is the key every
 * provider, merge guard and filter agrees on and does not change; this is only
 * what the reader sees, and it should match the tab the card sits in.
 */
const CATEGORY_LABEL = {
  american_football: 'PRO FOOTBALL'
};

function categoryLabel(category) {
  const key = String(category || '');
  return CATEGORY_LABEL[key] || key.toUpperCase();
}

/**
 * An always-on channel rather than a fixture. Most carry no kickoff at all,
 * which is the one thing every fixture has and no channel does. A few are
 * scheduled anyway -- the feed gives NFL RedZone a Sunday start -- and those
 * are still channels: their names resolve to a channel logo, and no fixture's
 * name does.
 */
function isChannel(m) {
  if (!m) return false;
  if (m.category === 'networks' || !m.date) return true;
  return !!getChannelLogo(m.title);
}

/**
 * Tidy a team name for display.
 *
 * The feeds disagree with each other on the same club: one writes "Florida A&M",
 * another "Florida A and M", and both end up on cards. They resolve to the same
 * crest either way — normalize() folds "&" to " and " — but the two spellings
 * sit side by side in the catalog and read as a mistake. Only initials are
 * rejoined, so "Bristol and Gloucester" is left alone.
 */
function prettifyName(name) {
  return String(name || '')
    .replace(/\b([A-Z]) and ([A-Z])\b/g, '$1&$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Accurately determines if an event is currently live right now.
 * 24/7 networks are always live.
 * Fixtures with a kickoff time are live starting 15 minutes before kickoff
 * up to the sport-specific max game duration.
 */
function isMatchLive(match) {
  if (!match) return false;
  if (match.category === 'networks' || !match.date) return true;

  // 1. Explicit finished / postponed / cancelled statuses are never live
  if (match.status === 'finished' || match.status === 'ended' || match.status === 'postponed' || match.status === 'cancelled') {
    return false;
  }

  // 2. Explicit live status from provider
  if (match.status === 'live' || match.status === 'in' || match.status === 'in_progress') {
    return true;
  }

  // 3. Explicit upcoming / pre-match status from provider
  if (match.status === 'upcoming' || match.status === 'pre') {
    return false;
  }

  // 4. Time-based evaluation when status is not explicitly set
  const now = Date.now();
  const kickoff = match.date ? parseInt(match.date, 10) : 0;

  if (kickoff > 0) {
    // If kickoff is more than 15 minutes in the future, it's definitely UPCOMING, not live
    if (kickoff > now + 15 * 60 * 1000) {
      return false;
    }

    const durations = {
      cricket: 8 * 60 * 60 * 1000,
      mma: 6 * 60 * 60 * 1000,
      fighting: 6 * 60 * 60 * 1000,
      boxing: 5 * 60 * 60 * 1000,
      motorsport: 4 * 60 * 60 * 1000,
      american_football: 4 * 60 * 60 * 1000,
      baseball: 3.5 * 60 * 60 * 1000,
      basketball: 3 * 60 * 60 * 1000,
      tennis: 4 * 60 * 60 * 1000,
      golf: 6 * 60 * 60 * 1000,
      football: 2.5 * 60 * 60 * 1000,
      rugby: 2.5 * 60 * 60 * 1000,
      hockey: 3 * 60 * 60 * 1000,
      darts: 4 * 60 * 60 * 1000
    };
    const maxDuration = durations[match.category] || (3 * 60 * 60 * 1000);

    return now >= (kickoff - 15 * 60 * 1000) && now <= (kickoff + maxDuration);
  }

  return false;
}

function normalizeImageUrl(url, defaultHost = 'https://streamfree.top') {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  if (u.startsWith('/')) return `${defaultHost}${u}`;
  return `${defaultHost}/${u}`;
}

function mapMatchToMetaPreview(match, config = {}) {
  const isLive = isMatchLive(match);
  const titleStr = match.title || (isLive ? 'Live Match' : 'Upcoming Match');
  const safeTitle = encodeURIComponent(Array.from(titleStr).slice(0, 30).join(''));
  
  // Dynamic Sport-Specific Posters
  const categoryColors = {
    football: '10b981', // green
    basketball: 'f97316', // orange
    motorsport: 'ef4444', // red
    cricket: '0ea5e9', // light blue
    tennis: 'a3e635', // lime
    rugby: '8b5cf6', // purple
    american_football: '0369a1', // dark blue
    baseball: 'f43f5e', // rose
    hockey: '06b6d4', // cyan
    golf: '22c55e', // emerald
    darts: 'eab308', // yellow
    mma: 'dc2626', // crimson red
    networks: '64748b', // slate
    college: 'd946ef' // fuchsia
  };
  const color = categoryColors[match.category] || '333333';
  
  // Channel logos come from the unified ChannelLogoService (tv-logos CDN + Wikimedia).

  // Resolve both sides of the fixture to ESPN crests where we confidently can.
  // Returns null for a non-fixture title (a 24/7 channel), and either logo may
  // be null on its own — TeamLogoService declines rather than guessing.
  let matchup = teamLogoService.resolveMatchup(match);

  // Put the visiting side on the left and name it first, the way a scoreboard
  // reads. ESPN's scoreboards are the source; when they don't list a fixture,
  // the title's own separator is the fallback — "A at B" and "A @ B" name the
  // visitor first, while "A vs B" and "A - B" conventionally name the host
  // first. That fallback is a convention, not a fact, which is exactly why the
  // scoreboard is consulted first: the feeds write "Florida A&M Rattlers vs
  // Miami Hurricanes" for a game Miami host.
  // Whether this is a two-team fixture at all — and only evidence counts.
  // resolveMatchup() splits on any separator, so "UFC 319: Du Plessis vs
  // Chimaev" and "Spain GP - Formula 1 2026" come back looking like fixtures.
  // Rewriting those produced "Conor Benn @ Ryan Garcia" for a neutral-site
  // fight and "Spain GP @ Formula 1 2026" for a race. ESPN listing the fixture,
  // or both sides resolving to a real crest, is evidence. A separator is not.
  let orientedByEspn = false;
  let isFixture = false;
  let leagueLogo = null;
  if (matchup) {
    const known = homeAway.orient(matchup.a, matchup.b, matchup.aLogo, matchup.bLogo, match.category, match.date);
    orientedByEspn = !!known;
    if (known && known.leagueLogo) leagueLogo = known.leagueLogo;
    isFixture = orientedByEspn || (matchup.aLogos.length > 0 && matchup.bLogos.length > 0);

    if (isFixture) {
      // Visitor on the left, the way a scoreboard reads. ESPN is the source;
      // without it the title's own separator is the fallback — "A at B" and
      // "A @ B" name the visitor first, "A vs B" and "A - B" the host.
      const flip = known ? known.away !== matchup.a : !VISITOR_FIRST.test(match.title || '');
      if (flip) {
        matchup = {
          ...matchup,
          a: matchup.b, b: matchup.a,
          aLogos: matchup.bLogos, bLogos: matchup.aLogos,
          aLogo: matchup.bLogo, bLogo: matchup.aLogo
        };
      }
    }
  }

  // Generate a clean, readable fallback poster using the match title.
  // NOTE: never substitute match.category here. Replacing the teams with
  // "AMERICAN_FOOTBALL" on long titles is what produced the blank-looking
  // category cards; svgPlaceholder word-wraps, so long names are fine.
  let posterText = match.title;
  if (matchup && isFixture) {
      posterText = `${prettifyName(teamLogoService.canonicalName(matchup.aLogo) || matchup.a)}\n@\n${prettifyName(teamLogoService.canonicalName(matchup.bLogo) || matchup.b)}`;
  } else if (matchup) {
      posterText = `${prettifyName(matchup.a)}\nvs\n${prettifyName(matchup.b)}`;
  } else if (match.team1 && match.team2 && match.team1.name && match.team2.name) {
      posterText = `${match.team1.name}\nvs\n${match.team2.name}`;
  } else {
      posterText = posterText.replace(/ vs /i, '\nvs\n').replace(/ - /i, '\n-\n');
  }

  // Self-hosted fallback poster (replaces the external placehold.co dependency)
  const fallbackPoster = imageService.placeholderUrl(BASE_URL, posterText, color);

  // Self-hosted image proxy: serves the upstream image from cache and falls
  // back to a generated placeholder when the source is dead, so the client
  // never sees a broken image.
  const buildImg = (sourceUrl, fbText, c) =>
    imageService.proxyUrl(BASE_URL, sourceUrl, { text: fbText, color: c });

  let poster = fallbackPoster;

  // Channel logos are keyed by naive substring, so "<Team> vs <Team> | ESPN"
  // used to take ESPN's wordmark as its poster. Only consult the channel table
  // for titles that are actually channels, i.e. not a two-sided fixture.
  // Consulted for anything that isn't a real fixture — not merely anything
  // whose title lacks a separator. "NFL vs RedZone" splits like a fixture and
  // isn't one, which is why the channel with the best-looking artwork in the
  // catalog was the one showing none.
  const channelLogo = isFixture ? null : getChannelLogo(match.title);
  const team1Logo = match.team1 && match.team1.logo ? normalizeImageUrl(match.team1.logo) : null;
  const matchPoster = match.poster ? normalizeImageUrl(match.poster) : null;
  const matchThumb = match.thumbnail_url ? normalizeImageUrl(match.thumbnail_url) : null;
  const matchLogo = match.logo ? normalizeImageUrl(match.logo) : null;

  // The competition's crest is what belongs in the card's logo slot. Before
  // this it was the home side's own crest or, far more often, a dead URL whose
  // failure produced a generated card of the match title rendered at badge size
  // — an unreadable box of words in the corner of every poster.
  // The badge in the card's corner. A competition crest when ESPN named one;
  // otherwise the governing mark for the sport, which is more use than the home
  // side's crest repeated at badge size.
  //
  // The NCAA marks are served from this addon rather than hot-linked: Wikimedia
  // rate-limits a browser user-agent, and ESPN's "ncaa_football" is a generic
  // silhouette, not the NCAA's own mark.
  const SPORT_BADGE = {
    college: `${BASE_URL}/marks/ncaa.png`,
    rugby: 'https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-rugby.png'
  };
  const COLLEGE_BADGE = {
    football: `${BASE_URL}/marks/ncaa-football.png`,
    basketball: `${BASE_URL}/marks/ncaa-basketball.png`
  };
  // Which NCAA mark the corner gets. The league names the sport when the feed
  // sends one; failing that ESPN's own crest for the competition does
  // (ESPN-icon-football-college, ncaa_basketball). The plain NCAA mark stands in
  // when nothing says which sport this is.
  const collegeSport = match._collegeSport
    || eventMarks.collegeSport(match.league)
    || (/football/i.test(leagueLogo || '') ? 'football'
      : /basketball/i.test(leagueLogo || '') ? 'basketball'
      : null);
  const sportBadge = match.category === 'college'
    ? (COLLEGE_BADGE[collegeSport] || SPORT_BADGE.college)
    : (SPORT_BADGE[match.category] || leagueBadges.sportMark(match.category) || null);

  // The competition worked out from the two crests, for the fixtures no feed
  // names a league for. Every rugby fixture arrives with an empty league field,
  // and ESPN's scoreboard reaches only part of the soccer calendar.
  const competition = matchup ? leagueBadges.competitionFor(matchup.aLogo, matchup.bLogo) : null;
  const competitionBadge = leagueBadges.badgeForCompetition(competition);

  // A competition this addon carries its own mark for. Those exist precisely
  // where ESPN's crest is useless -- one generic ball for all four rugby
  // competitions, and nothing at all for the CFL -- so the mark outranks it.
  const bundledBadge = competition && leagueBadges.BUNDLED[competition] ? competitionBadge : null;

  // For a college game the governing body outranks the conference: every
  // college fixture carries an NCAA mark, so the corner reads the same whether
  // the feed named a conference or nothing at all. Everywhere else the league
  // is the more specific answer and wins.
  const collegeBadge = match.category === 'college' ? sportBadge : null;

  // A channel's own logo outranks its sport's mark: NFL Network is more use in
  // the corner than a generic football. It sat last while the sport mark only
  // existed for a couple of categories, and giving every sport one put a
  // pictogram in front of all nine channels' branding.
  let logo = collegeBadge || bundledBadge || leagueLogo || competitionBadge || channelLogo
    || sportBadge || matchLogo || team1Logo || null;

  // Matchup card from the resolved crest candidates. The provider's poster
  // rides along as the fallback, so /img/matchup can degrade to it when a
  // candidate turns out not to exist — that decision belongs at fetch time.
  const matchupPoster = matchup
    ? imageService.matchupUrl(BASE_URL, { ...matchup, color, fallback: matchPoster })
    : null;

  // A generated card whenever both sides have a candidate. Provider artwork is
  // inconsistent — a handful of fixtures ship a designed poster and most ship
  // nothing — so one house style across the catalog reads better than a mix.
  // A side with no candidate at all still loses to real provider art.
  const bothSides = matchup && matchup.aLogos.length > 0 && matchup.bLogos.length > 0;

  if (bothSides && matchupPoster) {
    poster = matchupPoster;
  } else if (matchPoster) {
    poster = buildImg(matchPoster, posterText, color) || fallbackPoster;
  } else if (matchupPoster) {
    poster = matchupPoster;
  } else if (channelLogo) {
    poster = buildImg(channelLogo, match.title, '161616') || fallbackPoster;
    logo = channelLogo;
  } else if (matchThumb) {
    const isLogo = match.category === 'networks' || matchThumb.toLowerCase().includes('logo') || matchThumb.toLowerCase().includes('icon');
    poster = buildImg(matchThumb, posterText, color) || fallbackPoster;
    if (isLogo && !logo) {
      logo = matchThumb;
    }
  } else if (team1Logo) {
    poster = buildImg(team1Logo, posterText, color) || fallbackPoster;
    if (!logo) logo = team1Logo;
  } else if (!isFixture) {
    // Not a fixture and no provider artwork: a badge card beats the title alone
    // on a blank panel. Falls back to exactly that panel when no mark loads.
    const mark = eventMarks.markFor(match.title, match.category, match.league);
    if (mark) {
      poster = imageService.eventUrl(BASE_URL, { text: posterText, color, ...mark }) || poster;
    }
  }

  if (logo) {
    logo = buildImg(logo, match.title || 'TV', '161616') || logo;
  }
  
  const matchBackground = match.background ? normalizeImageUrl(match.background) : null;
  let background = matchBackground ? (buildImg(matchBackground, posterText, color) || poster) : poster;

  let timeString = match.category === 'networks' ? '24/7 Stream' : 'Live Now';
  let relativeTimeStr = '';
  let releasedIso = null;
  
  if (match.date && !isNaN(parseInt(match.date)) && parseInt(match.date) > 0) {
     const dateObj = new Date(parseInt(match.date));
     releasedIso = dateObj.toISOString();
     const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }; // 24-hour format (00-23), never AM/PM
     
     if (config && config.timezone) {
       options.timeZone = config.timezone;
     }
     
     timeString = dateObj.toLocaleTimeString('en-US', options) + (options.timeZone ? ` (${options.timeZone})` : '');
     
     const now = Date.now();
     const diff = dateObj.getTime() - now;
     if (diff > 0 && !isLive) {
       const hours = Math.floor(diff / (1000 * 60 * 60));
       const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
       if (hours > 24) {
         relativeTimeStr = ` (in ${Math.floor(hours / 24)} days)`;
       } else if (hours > 0) {
         relativeTimeStr = ` (in ${hours}h ${minutes}m)`;
       } else {
         relativeTimeStr = ` (in ${minutes} mins)`;
       }
     }
  }

  // The card title follows the same orientation as the artwork: visitor first,
  // "@" between. Only a real two-sided fixture is rewritten — a 24/7 channel or
  // a title we couldn't split keeps whatever the provider called it.
  // Show ESPN's name for a side we resolved, so the same club is spelled the
  // same way on every card — the providers variously write "Florida A and M",
  // "Florida A&M" and "Miami (FL)" for teams we have already identified.
  const sideName = (raw, logo) => prettifyName(teamLogoService.canonicalName(logo) || raw);
  const displayA = isFixture ? sideName(matchup.a, matchup.aLogo) : null;
  const displayB = isFixture ? sideName(matchup.b, matchup.bLogo) : null;
  const displayTitle = isFixture ? `${displayA} @ ${displayB}` : prettifyName(match.title);

  const is247 = match.category === 'networks' || !match.date;
  const prefix = isLive ? (is247 ? '📺 ' : '🔴 LIVE: ') : '⏱️ ';
  const cast = [];
  if (matchup && isFixture) {
    cast.push(displayA, displayB);
  } else {
    if (match.team1 && match.team1.name) cast.push(match.team1.name);
    if (match.team2 && match.team2.name) cast.push(match.team2.name);
  }

  const leagueStr = match.league ? `🏆 League: ${match.league}\n` : '';
  const statusStr = is247 
    ? '24/7 Live Network' 
    : (isLive ? '🔴 LIVE NOW' : `Kickoff at ${timeString}${relativeTimeStr}`);
  const desc = `${leagueStr}📅 Category: ${categoryLabel(match.category)}\n⏰ Status: ${statusStr}`;

  const metaPreview = {
    id: `nuvio_sport_${match.id}`,
    type: 'tv',
    name: `${prefix}${displayTitle}`,
    genres: [match.category.toUpperCase()],
    poster: poster,
    posterShape: 'landscape',
    background: background,
    logo: logo,
    releaseInfo: isLive ? (is247 ? '24/7' : 'LIVE') : timeString,
    // Kept for the catalog's repeat-fixture pass below; not part of the
    // Stremio meta contract, and stripped before the response.
    _relative: relativeTimeStr.trim(),
    description: desc,
    cast: cast,
    behaviorHints: {
      defaultVideoId: `nuvio_sport_${match.id}`
    }
  };

  if (releasedIso) {
    metaPreview.released = releasedIso;
  }

  return metaPreview;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, config) {
  // Warm the home/away index before mapping. Blocks only on a cold start; once
  // an index exists a stale one is served while the refresh runs behind it, so
  // a slow or dead ESPN costs orientation rather than the catalog.
  await homeAway.ensureFresh().catch(() => {});
  if (type !== 'tv' || !id.startsWith('nuvio_sports_')) {
    return { metas: [] };
  }

  // Fire-and-forget stale-while-revalidate: return the cached list now and let
  // CronService refresh it in the background once it passes the revalidate window.
  container.resolve('cronService').ensureFresh();
  
  const conf = config || (extra && extra.config) || {};

  const categoryMatch = id.replace('nuvio_sports_', '');
  
  // Use CacheService instead of hitting APIs on demand
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  
  let filteredMatches = matches;

  if (categoryMatch === 'live') {
    // A channel with no kickoff counts as live by definition, which put all
    // nine of them at the top of Live above the games actually being played.
    // Channels have their own tab; Live is for what is on right now.
    filteredMatches = matches.filter(m => isMatchLive(m) && !isChannel(m));
  } else if (categoryMatch === 'upcoming') {
    const now = Date.now();
    filteredMatches = matches.filter(m => !isChannel(m) && !isMatchLive(m) && (parseInt(m.date) || 0) > now);
  } else if (categoryMatch === 'teams') {
    if (typeof conf.teams === 'string' && conf.teams.trim()) {
      const favoriteTeams = conf.teams.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      filteredMatches = matches.filter(m => {
        const titleWords = m.title.toLowerCase();
        return favoriteTeams.some(team => titleWords.includes(team));
      });
    } else {
      filteredMatches = []; // If no config, return empty
    }
  } else if (categoryMatch === 'channels') {
    // Always-on channels, gathered in one place. A channel has no kickoff, which
    // is what separates it from a fixture.
    filteredMatches = matches.filter(m => isChannel(m));
  } else if (categoryMatch === 'other') {
    const topLevelCats = ['football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball', 'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'networks', 'college'];
    filteredMatches = matches.filter(m => !topLevelCats.includes(m.category) && !isChannel(m));
  } else if (categoryMatch !== 'catalog') {
    // Fixtures only. The always-on channels that used to be mixed in here now
    // live in the Channels tab, so a sport tab is a schedule rather than a
    // schedule with a few permanent entries pinned among it.
    filteredMatches = matches.filter(m => m.category === categoryMatch && !isChannel(m));
  }

  if (typeof conf.sports === 'string' && conf.sports !== 'all') {
    const allowedSports = conf.sports.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    // Don't filter out networks (24/7 TV) since they aren't tied to a specific sport
    filteredMatches = filteredMatches.filter(m => m.category === 'networks' || allowedSports.includes(m.category));
  }

  filteredMatches = [...filteredMatches].sort((a, b) => {
    const aIsLive = isMatchLive(a) ? 1 : 0;
    const bIsLive = isMatchLive(b) ? 1 : 0;
    if (aIsLive !== bIsLive) return bIsLive - aIsLive; // Live matches first
    
    // Within live matches: Actual live event fixtures (UFC, F1, Football, etc.) take priority over 24/7 TV channels
    const aIsEvent = a.category !== 'networks' ? 1 : 0;
    const bIsEvent = b.category !== 'networks' ? 1 : 0;
    if (aIsEvent !== bIsEvent) return bIsEvent - aIsEvent;

    // Featured / Popular matches first
    const aPop = a.popular === '1' ? 1 : 0;
    const bPop = b.popular === '1' ? 1 : 0;
    if (aPop !== bPop) return bPop - aPop;
    
    const dateA = a.date ? parseInt(a.date) : 0;
    const dateB = b.date ? parseInt(b.date) : 0;
    
    // Sort upcoming by closest kickoff first
    if (dateA > 0 && dateB > 0) return dateA - dateB;
    return 0;
  });

  let metas = filteredMatches.map(m => mapMatchToMetaPreview(m, conf));

  // Two legs of a series carry the same name — "Pittsburgh Pirates @ Chicago
  // Cubs" today and again tomorrow. They are different games and must not be
  // merged, but side by side they read as a mistake, so when a name repeats in
  // a tab each copy says when it is.
  const nameCounts = new Map();
  for (const m of metas) nameCounts.set(m.name, (nameCounts.get(m.name) || 0) + 1);
  for (const m of metas) {
    if (nameCounts.get(m.name) > 1 && m._relative) m.name = `${m.name} ${m._relative}`;
    delete m._relative;
  }

  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    metas = metas.filter(m => 
      m.name.toLowerCase().includes(q) || 
      (m.description && m.description.toLowerCase().includes(q)) ||
      (m.cast && m.cast.some(c => c.toLowerCase().includes(q)))
    );
  }

  return { metas };
}

async function handleMeta(type, id, config) {
  await homeAway.ensureFresh().catch(() => {});
  if (type !== 'tv' || !id.startsWith('nuvio_sport_')) {
    return { meta: null };
  }

  // Fire-and-forget stale-while-revalidate, same as handleCatalog.
  container.resolve('cronService').ensureFresh();

  const matchId = id.replace('nuvio_sport_', '');
  const cacheService = container.resolve('cacheService');
  const matches = cacheService.getMatches();
  const match = matches.find(m => m.id === matchId);

  if (!match) {
    return { meta: null };
  }

  // Prewarm: mint tokens for this match's top sources while the user is still
  // on the detail page, so the eventual click is near-instant. Fire-and-forget.
  try { prewarmMatch(match, config || {}).catch(() => {}); } catch (_) {}

  return { meta: mapMatchToMetaPreview(match, config || {}) };
}

module.exports = {
  handleCatalog,
  handleMeta,
  isMatchLive
};
