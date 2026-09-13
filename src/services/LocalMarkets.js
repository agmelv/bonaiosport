/**
 * LocalMarkets.js — a viewer's own cities, and which channels are theirs.
 *
 * The ABC, CBS, NBC and FOX tiles carry dozens of stations from all over the
 * country, and a viewer in Chicago wants WLS and WFLD, not thirty affiliates
 * they will never watch. The cities named in a profile's "markets" setting (or
 * in LOCAL_MARKETS on the server) get each of their stations that iptv-org has
 * a stream for as a tile of its own -- "FOX 32 Chicago" -- and the 📍 Local tab
 * lists those beside the channels whose names already say the city.
 *
 * Pure functions, except wantedMarkets(), which reads the saved profiles.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { STATES, cityKey } = require('./StationLabel');

// The setting arrives from a URL anyone can edit, so it is bounded before it
// is parsed: this many characters is twenty-odd cities, and the configure page
// stops at the same figure. Each saved profile's string is bounded the same
// way, and the union of them at MAX_MARKETS cities.
const MAX_MARKETS_CHARS = 300;
const MAX_MARKETS = 40;

const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR'
};
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** "TN", "tn" or "Tennessee" as a state code, else ''. */
function stateCode(s) {
  const u = String(s || '').trim();
  if (/^[A-Za-z]{2}$/.test(u)) return STATES.has(u.toUpperCase()) ? u.toUpperCase() : '';
  const k = u.toLowerCase().replace(/\s+/g, ' ');
  return hasOwn(STATE_CODES, k) ? STATE_CODES[k] : '';
}

// A city name as a key. Shared with the station labels, so a typed "New York
// City" and a label's "New York" meet on the same key.
const norm = cityKey;

/** The "markets" setting of a viewer's config, bounded. */
function marketsSetting(config) {
  return String((config && config.markets) || '').slice(0, MAX_MARKETS_CHARS);
}

// States that are cities too. Written out on their own they are the city.
const CITY_FIRST = new Set(['new york', 'washington']);

/**
 * The cities a setting names: "Chicago, Knoxville TN, Phoenix" and
 * "Knoxville, Tennessee" both work. A state on its own belongs to the city
 * before it, so the comma in "Knoxville, TN" does not make Tennessee a city.
 */
function parseMarkets(input, limit = MAX_MARKETS) {
  const tokens = String(input || '').split(/[,;\n]/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const tok of tokens) {
    if (out.length >= limit) break;
    const alone = stateCode(tok);
    const isCode = /^[A-Za-z]{2}$/.test(tok);
    if (alone && (isCode || (out.length && !out[out.length - 1].state && !CITY_FIRST.has(tok.toLowerCase())))) {
      if (out.length && !out[out.length - 1].state) out[out.length - 1].state = alone;
      continue;
    }
    const words = tok.split(' ');
    let state = '';
    if (words.length > 1 && stateCode(words[words.length - 1])) {
      state = stateCode(words.pop());
    } else if (words.length > 2 && stateCode(words.slice(-2).join(' '))) {
      // "Albany New York" -- but "New York" alone stays a city.
      state = stateCode(words.splice(-2).join(' '));
    }
    // "knoxville" reads "Knoxville" on a tile; a name typed with its own
    // capitals (McAllen) keeps them.
    const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const key = `${norm(name)}|${state}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, state });
  }
  return out;
}

/**
 * Each named city as iptv-org files it. A name several states share --
 * Phoenix, AZ and Phoenix, OR -- goes to the one with the most stations filed
 * against it, which is the TV market; a state in the setting overrides that.
 * A city iptv-org does not know is left out.
 */
function resolveMarkets(markets, cities, feedCount = () => 0) {
  const byKey = new Map();
  for (const c of cities || []) {
    if (!c || c.country !== 'US' || !c.name || !c.code) continue;
    const k = norm(c.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const out = [];
  for (const m of markets || []) {
    let cands = byKey.get(norm(m.name)) || [];
    if (m.state) cands = cands.filter(c => String(c.subdivision || '').toUpperCase() === `US-${m.state}`);
    if (!cands.length) continue;
    cands = cands.slice().sort((a, b) => feedCount(b.code) - feedCount(a.code));
    const c = cands[0];
    const state = String(c.subdivision || '').split('-')[1] || m.state || '';
    const name = c.name === 'New York City' ? 'New York' : c.name;
    if (out.some(o => o.code === c.code)) continue;
    out.push({ name, state, code: c.code, label: state ? `${name}, ${state}` : name });
  }
  return out;
}

// The broadcast networks, by the word a stream title starts with and by the
// iptv-org channel each is filed under.
const NETWORK_CHANNEL = {
  FOX: 'Fox.us', ABC: 'ABC.us', CBS: 'CBS.us', NBC: 'NBC.us', CW: 'CW.us', MNT: 'MNT.us',
  MYNETWORKTV: 'MNT.us', PBS: 'PBS.us', TELEMUNDO: 'Telemundo.us', UNIVISION: 'Univision.us'
};
const NETWORK_NAME = {
  'Fox.us': 'FOX', 'ABC.us': 'ABC', 'CBS.us': 'CBS', 'NBC.us': 'NBC', 'CW.us': 'CW', 'MNT.us': 'MNT',
  'PBS.us': 'PBS', 'Telemundo.us': 'Telemundo', 'Univision.us': 'Univision'
};
const TITLE_RE = /^(FOX|ABC|CBS|NBC|CW|MNT|MyNetworkTV|PBS|Telemundo|Univision)\s+(\d+(?:\.\d+)?)\b/i;

/** The network and channel number a feed's stream titles spell out: "FOX 32 Chicago IL (WFLD)". */
function networkOfTitles(titles) {
  for (const t of titles || []) {
    const m = String(t || '').match(TITLE_RE);
    if (m) return { channelId: NETWORK_CHANNEL[m[1].toUpperCase()], number: m[2] };
  }
  return null;
}

/**
 * The network tile a feed's streams belong on when iptv-org filed them under
 * another one -- FOX 32 Chicago sits under MNT. Null when they are where they
 * belong, or when nothing says.
 */
function networkHome(titles, channelId) {
  if (!NETWORK_NAME[channelId]) return null;
  const net = networkOfTitles(titles);
  return net && net.channelId !== channelId ? net.channelId : null;
}

/**
 * What a local station's tile is called. "FOX 32 Chicago" when the streams say
 * so, "NBC Chicago" for a network feed that does not, and the channel's own
 * name for everything else -- PHXTV, CAN TV19.
 */
function stationName({ channelName, channelId, titles, city }) {
  const net = networkOfTitles(titles);
  if (net) return `${NETWORK_NAME[net.channelId]} ${net.number} ${city}`;
  if (NETWORK_NAME[channelId]) return `${NETWORK_NAME[channelId]} ${city}`;
  return String(channelName || '').trim();
}

// Regional sports networks whose names do not say where they are.
const RSN_HOME = { marqueesportsnetwork: 'chicago' };

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What each market is matched by, worked out once per list of markets rather
// than once per channel: the Local tab asks about several hundred channels.
const matchersFor = new WeakMap();
function matchers(markets) {
  let d = matchersFor.get(markets);
  if (!d) {
    d = markets.map(m => ({
      key: norm(m.name),
      state: String(m.state || '').toUpperCase(),
      re: new RegExp(`(^|[^a-z])${escapeRe(String(m.name).toLowerCase()).replace(/\s+/g, '\\s+')}([^a-z]|$)`)
    }));
    matchersFor.set(markets, d);
  }
  return d;
}

/**
 * Whether a channel belongs in the viewer's 📍 Local tab. A station's tile
 * says its market; other channels are known by name -- CBS News Chicago -- or
 * by the short list of sports networks whose names say nothing.
 */
function isLocalTo(match, markets) {
  if (!match || !Array.isArray(markets) || !markets.length) return false;
  const ms = matchers(markets);
  if (match.market) {
    const [city, st = ''] = String(match.market).split(',').map(s => s.trim());
    const key = norm(city);
    // A state in the setting is a choice between two cities of one name:
    // Portland, ME is not Portland, OR.
    return ms.some(m => m.key === key && (!m.state || !st || m.state === st.toUpperCase()));
  }
  if (match.region && match.region !== 'US') return false;
  const title = String(match.baseTitle || match.title || '');
  const home = RSN_HOME[norm(title)];
  if (home && ms.some(m => m.key === home)) return true;
  const lower = title.toLowerCase();
  return ms.some(m => m.re.test(lower));
}

/**
 * Every city anyone on this server has asked for: LOCAL_MARKETS, plus the
 * "markets" setting of each saved profile, each read on its own so one
 * profile's stray state cannot attach itself to another's city. Read at each
 * sync, so a city typed into /configure is picked up by the next one.
 */
function wantedMarkets() {
  const strings = [];
  if (process.env.LOCAL_MARKETS) strings.push(process.env.LOCAL_MARKETS);
  const files = [path.join(DATA_DIR, 'config.json')];
  try {
    for (const f of fs.readdirSync(path.join(DATA_DIR, 'profiles'))) {
      if (f.endsWith('.json')) files.push(path.join(DATA_DIR, 'profiles', f));
    }
  } catch (e) { /* no profiles yet */ }
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c && typeof c.markets === 'string') strings.push(c.markets);
    } catch (e) { /* absent or unreadable */ }
  }
  const out = [];
  const seen = new Set();
  for (const s of strings) {
    for (const m of parseMarkets(String(s).slice(0, MAX_MARKETS_CHARS))) {
      const key = `${norm(m.name)}|${m.state}`;
      if (seen.has(key) || out.length >= MAX_MARKETS) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

module.exports = {
  parseMarkets, marketsSetting, resolveMarkets, stationName, networkOfTitles, networkHome, isLocalTo, wantedMarkets,
  NETWORK_CHANNEL, NETWORK_NAME, stateCode, norm, MAX_MARKETS_CHARS, MAX_MARKETS
};
