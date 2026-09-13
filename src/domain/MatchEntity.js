const { parseTimezone } = require('../timezone');

/**
 * Converts a provider kickoff value into a millisecond epoch string.
 * Uses the robust timezone parser.
 */
function toMillis(value) {
  const parsed = parseTimezone(value, 'UTC'); // fallback if providers didn't already parse it
  return parsed ? parsed.toString() : '';
}

class MatchEntity {
  constructor({ id, title, category, date, timestamp, status, popular, sources, league, team1, team2, thumbnail_url, poster, logo, background, genre, region, baseTitle, market, station, logoName, newsStream }) {
    this.id = id || '';
    this.title = title || 'Unknown Match';
    this.category = category || 'other';
    this.date = toMillis(timestamp !== null && timestamp !== undefined ? timestamp : date);
    this.status = status || '';
    this.popular = popular === '1' || popular === true ? '1' : '0';
    this.sources = Array.isArray(sources) ? sources : [];
    
    if (league && typeof league === 'object' && !Array.isArray(league)) {
      this.league = league.name || league.title || '';
    } else {
      this.league = league ? String(league) : '';
    }
    
    this.team1 = team1 || null;
    this.team2 = team2 || null;
    this.thumbnail_url = thumbnail_url || '';
    this.poster = poster || '';
    this.logo = logo || '';
    this.background = background || '';
    // A 24/7 channel's group in the Channels tab: one of channelGenres.GENRES.
    this.genre = genre || '';
    // A 24/7 channel's country (channelRegions), and its name without one.
    this.region = region || '';
    this.baseTitle = baseTitle || '';
    // A local station's city ("Chicago, IL") and call sign, for the 📍 Local
    // tab and the tile's description. Empty for everything else.
    this.market = market || '';
    this.station = station || '';
    // The name to find this channel's logo under when its own is not it:
    // "FOX 32 Chicago News" wears the FOX mark.
    this.logoName = logoName || '';
    // A local station's stream that is its news channel, not its broadcast.
    this.newsStream = !!newsStream;
  }
}

module.exports = MatchEntity;
