/**
 * ChannelLogoService.js
 *
 * Single source of truth for channel -> logo mapping. Merges the tv-logos
 * GitHub CDN entries with the Wikimedia URLs that used to live in a shadowed
 * local function inside catalog.js (that shadowing made this service dead code).
 *
 * Matching: exact key first, then longest substring wins, so "sky sports cricket"
 * resolves to the cricket logo even though a generic "sky sports" key exists.
 */

const CHANNEL_LOGOS = {
  // Cricket
  "willow": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/willow-us.png",
  "willow cricket": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/willow-us.png",
  "fox cricket": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/australia/fox-sports-cricket-501-au.png",
  "sky sports cricket": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-cricket-uk.png",

  // Tennis
  "tennis channel": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/tennis-channel-us.png",

  // F1 & Motorsport
  "sky sports f1": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-f1-uk.png",

  // Football / Soccer & Multi-Sport (specific keys first — matching is longest-substring)
  "sky sports main event": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-main-event-uk.png",
  "sky sports premier league": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-premier-league-uk.png",
  "sky sports football": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-football-uk.png",
  "sky sports action": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-action-uk.png",
  "sky sports arena": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-arena-uk.png",
  "sky sports golf": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-golf-uk.png",
  "sky sports cricket": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-cricket-uk.png",
  "tnt sports 1": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/tnt-sports-1-uk.png",
  "tnt sports 2": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/tnt-sports-2-uk.png",
  "eurosport 1": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/eurosport-1-uk.png",
  "eurosport 2": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/eurosport-2-uk.png",
  "bein sports usa": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/bein-sports-us.png",
  "bein sports xtra": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/bein-sports-xtra-us.png",
  "cbs sports network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/cbs-sports-network-us.png",
  "cbs sports golazo network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/cbs-sports-golazo-network-us.png",

  // US Major Networks (ESPN, Fox, NBC, Major Leagues)
  "espn": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/argentina/espn-ar.png",
  "espn 2": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/espn-2-us.png",
  "espn 3": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/espn-3-us.png",
  "espnu": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/espn-u-us.png",
  "espnews": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/espnews-us.png",
  "espn8": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/espn-us.png",
  "fox sports 1": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/fox-sports-1-us.png",
  "fox sports 2": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/fox-sports-2-us.png",
  "fox deportes": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/fox-sports-deportes-us.png",
  "fox league": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/australia/fox-sports-league-502-au.png",
  "nbc sports now": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nbc-sports-us.png",
  "nbc sports bay area": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nbcsn-bay-area-us.png",
  "nba tv": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nba-tv-us.png",
  "nfl network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nfl-network-us.png",
  "nfl redzone": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nfl-red-zone-us.png",
  // The feed lists this channel as "NFL vs RedZone", which contains neither
  // "nfl redzone" nor "nfl red zone". Matching is longest-substring, so the
  // bare nickname catches it without disturbing the more specific keys.
  "redzone": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nfl-red-zone-us.png",
  "nfl red zone": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nfl-red-zone-us.png",
  "mlb network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/mlb-network-us.png",
  "mlb strike zone": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/mlb-network-strike-zone-us.png",
  "nhl network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nhl-network-us.png",
  "fight network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/canada/fight-network-ca.png",

  // Generic / regional catch-alls (Wikimedia) — keep AFTER the specific keys
  "sky sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-kingdom/sky-sports-hz-uk.png",
  "astro cricket": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/malaysia/astro-cricket-my.png",
  "astro supersport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/malaysia/screen-bug/astro-supersport-bug-my.png",
  "tsn": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/canada/tsn-ca.png",
  "sportsnet": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/canada/sportsnet-ca.png",
  "bein sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/france/bein-sports-fr.png",
  "espn": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/argentina/espn-ar.png",
  "fox sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/argentina/fox-sports-ar.png",
  "tnt sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/argentina/tnt-sports-ar.png",
  "bt sport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/misc/media/bt-sport.png",
  "eurosport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/india/eurosport-in.png",
  "star sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/india/star-sports-3-in.png",
  "super sport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/south-africa/supersport-za.png",
  "supersport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/south-africa/supersport-za.png",
  "ten sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/argentina/tnt-sports-ar.png",
  "optus": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/australia/optus-sport-1-au.png",
  "nbc sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nbc-sports-us.png",
  "cbs sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/cbs-sports-us.png",
  "arena sport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/serbia/arena-esport-rs.png",
  "digi sport": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/romania/digi-sport-4-ro.png",
  "eleven sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/portugal/eleven-sports-pt.png",
  "bally sports": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/bally-sports-us.png",
  "mlb network": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/mlb-network-us.png",
  "nba tv": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/nba-tv-us.png",
  "nfl network": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/NFL_Network_logo.svg/512px-NFL_Network_logo.svg.png"
};

// Longest keys first so "sky sports cricket" beats the generic "sky sports".
const SORTED_KEYS = Object.entries(CHANNEL_LOGOS).sort((a, b) => b[0].length - a[0].length);

function getChannelLogo(title) {
  if (!title) return null;
  const lower = String(title).toLowerCase().trim();

  // Exact match
  if (CHANNEL_LOGOS[lower]) return CHANNEL_LOGOS[lower];

  // Longest substring match
  for (const [key, logoUrl] of SORTED_KEYS) {
    if (lower.includes(key)) return logoUrl;
  }
  return null;
}

module.exports = {
  getChannelLogo,
  CHANNEL_LOGOS
};
