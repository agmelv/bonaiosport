/**
 * StationLabel.js — which local station a network stream is.
 *
 * The ABC, CBS, NBC and FOX tiles each carry dozens of streams, and they are
 * not copies of one feed: each is a local affiliate, with its own news, its own
 * ads and, for sport, sometimes its own game. They all used to read "Live
 * channel · 7". This names each one by where it is and its call sign --
 * "Los Angeles, CA · KTTV" -- from what iptv-org already says about the stream:
 * its title, and the city filed for its feed (src/services/data/us-stations.json,
 * built by scripts/build-us-stations.js). No I/O here.
 */

'use strict';

let STATIONS = {};
try {
  STATIONS = require('./data/us-stations.json');
} catch {
  STATIONS = {};   // no table: titles alone, which name about half the cities
}

const STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ ' +
  'NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR VI GU').split(' '));

// How a title names its network, and the name that network's tile uses.
const NETWORK = { FOX: 'FOX', ABC: 'ABC', CBS: 'CBS', NBC: 'NBC', CW: 'CW', MNT: 'MNT', MYNETWORKTV: 'MNT', PBS: 'PBS' };

const callSign = raw => {
  const c = String(raw || '').toUpperCase().replace(/-(TV|DT|CD|LD|LP)\d*$/, '');
  return /^[KW][A-Z]{2,3}$/.test(c) ? c : '';
};

/** City and call sign a title spells out: "FOX 11 Los Angeles CA (KTTV)", "WXXV-TV News (Biloxi MS)". */
function fromTitle(title) {
  let m = title.match(/^(FOX|ABC|CBS|NBC|CW|MNT|PBS)\s+\d+(?:\.\d+)?\s+(.+?)\s+([A-Z]{2})\s+\(([A-Za-z0-9-]+)\)$/i);
  if (m && STATES.has(m[3].toUpperCase())) return { city: `${m[2]}, ${m[3].toUpperCase()}`, call: callSign(m[4]) };
  m = title.match(/\(([A-Za-z][A-Za-z .'-]+?)\s+([A-Z]{2})\)$/);
  if (m && STATES.has(m[2])) return { city: `${m[1]}, ${m[2]}`, call: '' };
  // The bare "City ST" at the end of a title is not trusted: iptv-org has
  // "NBC 10 Providence MA" and "KSBY News San Louis Obispo CA".
  return { city: '', call: '' };
}

/**
 * A stream's station label, or null when nothing says where it is.
 * Returns { label, sort } -- sort puts named cities A to Z, then call signs
 * alone, then national feeds.
 */
function stationLabel({ channelId, channelName, streamTitle, feed }) {
  const title = String(streamTitle || '').trim();
  const feedId = String(feed || '');

  if (/^(East|West|Central|Pacific|Mountain)$/i.test(feedId)) {
    const zone = feedId[0].toUpperCase() + feedId.slice(1).toLowerCase();
    return { label: `National · ${zone}`, sort: `2|${zone.toLowerCase()}` };
  }

  const parsed = fromTitle(title);
  const filed = STATIONS[`${channelId}/${feedId}`] || [];
  // A market in the title ("FOX 13 Seattle WA") beats the city of licence on
  // file ("Tacoma, WA"): it is the name a viewer knows the station by.
  const city = (parsed.city || filed[0] || '').replace(/^New York City,/, 'New York,');
  let call = parsed.call || filed[1] || '';
  if (!call) {
    const m = title.match(/\b([KW][A-Z]{2,3})(?:-(?:TV|DT|CD|LD)\d*)?\b/);
    if (m) call = m[1];
  }

  let label = city && call ? `${city} · ${call}` : (call || city);
  if (!label) return null;

  // iptv-org files a few other networks' stations under one tile (ABC's KATU
  // on CW). Say so rather than pass it off as the tile's network.
  const word = (title.match(/^(FOX|ABC|CBS|NBC|CW|MNT|MyNetworkTV|PBS)\b/i) || [])[1];
  const theirs = word && NETWORK[word.toUpperCase()];
  const ours = NETWORK[String(channelName || '').trim().toUpperCase()];
  if (theirs && ours && theirs !== ours) label += ` (${theirs})`;

  const rank = city ? 0 : 1;
  return { label, sort: `${rank}|${city.toLowerCase()}|${call}` };
}

// USA TV's CBS News local streams carry the station in a host tag.
const CBS_NEWS = {
  BOS: 'Boston', CHI: 'Chicago', DAL: 'Texas', DEN: 'Colorado', DET: 'Detroit', LA: 'Los Angeles',
  MIA: 'Miami', MIN: 'Minnesota', NY: 'New York', PHI: 'Philadelphia', PIT: 'Pittsburgh', SF: 'Bay Area', US: 'National'
};

/** "HV:CBSN-BOS" -> "CBS News Boston", or null. */
function cbsNewsLabel(tag) {
  const m = String(tag || '').match(/^HV:CBSN-([A-Z]+)$/);
  return m && CBS_NEWS[m[1]] ? `CBS News ${CBS_NEWS[m[1]]}` : null;
}

module.exports = { stationLabel, cbsNewsLabel };
