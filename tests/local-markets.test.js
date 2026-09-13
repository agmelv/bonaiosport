// A viewer's own cities: how they are read, which iptv-org city each is, what a
// local station's tile is called, and which channels the 📍 Local tab lists.
//
// The owner's ask: "all the Chicago, Knoxville and Phoenix channels". The
// records here are iptv-org's real ones for those markets.
//
//   node tests/local-markets.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-markets-'));
const {
  parseMarkets, marketsSetting, resolveMarkets, stationName, isNewsStream, networkHome, isLocalTo, wantedMarkets, stateCode, MAX_MARKETS
} = require('../src/services/LocalMarkets');
const { stationOrder } = require('../src/services/StationLabel');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

console.log('--- reading the setting');
t([{ name: 'Chicago', state: '' }, { name: 'Knoxville', state: 'TN' }, { name: 'Phoenix', state: '' }],
  parseMarkets('Chicago, Knoxville TN, Phoenix'), 'a state after a city belongs to it');
t([{ name: 'Knoxville', state: 'TN' }, { name: 'Phoenix', state: 'AZ' }],
  parseMarkets('Knoxville, TN, Phoenix, AZ'), 'a state after a comma belongs to the city before it');
t([{ name: 'Knoxville', state: 'TN' }], parseMarkets('knoxville tennessee'), 'a state written out');
t([{ name: 'New York', state: '' }], parseMarkets('New York'), '"New York" is a city, not a state');
t([{ name: 'Albany', state: 'NY' }], parseMarkets('Albany New York'), '"Albany New York" is a city and a state');
t([{ name: 'Chicago', state: '' }], parseMarkets('chicago,  Chicago ,'), 'repeats and blanks fall away');
t([], parseMarkets(''), 'nothing named is nothing');
t('', stateCode('constructor'), 'a word that is a property of every object is not a state');
t([{ name: 'Chicago', state: '' }, { name: 'Constructor', state: '' }], parseMarkets('Chicago, constructor'), 'nor does it attach itself to the city before it');

console.log('--- a setting from a URL is bounded');
t(300, marketsSetting({ markets: 'x'.repeat(5000) }).length, 'cut at the length the configure page allows');
t('', marketsSetting({}), 'and empty when there is none');
const flood = Array.from({ length: 3000 }, (_, i) => `c${i}`).join(',');
const t0 = Date.now();
const parsed = parseMarkets(flood);
t(MAX_MARKETS, parsed.length, `three thousand cities become at most ${MAX_MARKETS}`);
t(true, Date.now() - t0 < 1000, `and are read in well under a second (${Date.now() - t0} ms)`);

console.log('--- which iptv-org city');
const cities = [
  { country: 'US', code: 'USPHX', name: 'Phoenix', subdivision: 'US-AZ' },
  { country: 'US', code: 'USONX', name: 'Phoenix', subdivision: 'US-OR' },
  { country: 'US', code: 'USTYS', name: 'Knoxville', subdivision: 'US-TN' },
  { country: 'US', code: 'USKZX', name: 'Knoxville', subdivision: 'US-AL' },
  { country: 'US', code: 'USCHI', name: 'Chicago', subdivision: 'US-IL' },
  { country: 'US', code: 'USNYC', name: 'New York City', subdivision: 'US-NY' },
  { country: 'CA', code: 'CATOR', name: 'Toronto', subdivision: 'CA-ON' }
];
const feeds = { USPHX: 100, USONX: 0, USTYS: 35, USKZX: 0, USCHI: 60, USNYC: 200 };
const count = code => feeds[code] || 0;
const R = s => resolveMarkets(parseMarkets(s), cities, count).map(m => `${m.code}=${m.label}`);
t(['USCHI=Chicago, IL', 'USTYS=Knoxville, TN', 'USPHX=Phoenix, AZ'], R('Chicago, Knoxville, Phoenix'), 'a shared name goes to the market with the stations');
t(['USKZX=Knoxville, AL'], R('Knoxville AL'), 'a state in the setting overrides that');
t(['USNYC=New York, NY'], R('New York'), '"New York" finds New York City and reads "New York"');
t([], R('Springfield, Toronto'), 'an unknown city, or one outside the US, is left out');

console.log('--- what a station\'s tile is called');
// A network station's free stream is its news channel (FOX LOCAL, "NBC 5
// Chicago Live News"), never the broadcast with the games on it. The name
// says so: the owner opened "FOX 32 Chicago" during the game and got the news.
t('FOX 32 Chicago News', stationName({ channelName: 'MNT', channelId: 'MNT.us', titles: ['WFLD-DT1', 'FOX 32 Chicago IL (WFLD)'], city: 'Chicago' }), 'the streams say which network and channel number');
t('ABC 15 Phoenix News', stationName({ channelName: 'KNXV-TV 61.1', channelId: 'KNXVTV611.us', titles: ['ABC 15 Phoenix AZ (KNXV)'], city: 'Phoenix' }), 'a station filed as its own channel');
t('NBC 5 Chicago News', stationName({ channelName: 'NBC', channelId: 'NBC.us', titles: ['NBC 5 Chicago Live News'], city: 'Chicago' }), 'the number and city, not the stream\'s own wording');
t('FOX Phoenix News', stationName({ channelName: 'Fox', channelId: 'Fox.us', titles: ['KSAZ-DT1'], city: 'Phoenix' }), 'a network feed whose streams say nothing more');
t('PBS Phoenix', stationName({ channelName: 'PBS', channelId: 'PBS.us', titles: ['KAET-DT1'], city: 'Phoenix' }), 'a public station streams its broadcast, so no "News"');
t('PHXTV', stationName({ channelName: 'PHXTV', channelId: 'PHXTV.us', titles: ['PHXTV'], city: 'Phoenix' }), 'anything else keeps its own name');
t(true, isNewsStream({ channelId: 'MNT.us', titles: ['FOX 32 Chicago IL (WFLD)'] }), 'a network station\'s stream is its news stream');
t(false, isNewsStream({ channelId: 'PHXTV.us', titles: ['PHXTV'] }), 'a city channel is what it says');

console.log('--- a feed filed under the wrong network');
t('Fox.us', networkHome(['WFLD-DT1', 'FOX 32 Chicago IL (WFLD)'], 'MNT.us'), 'FOX 32 under MNT belongs on the FOX tile');
t(null, networkHome(['FOX 10 Phoenix AZ (KSAZ)'], 'Fox.us'), 'a feed where it belongs stays');
t(null, networkHome(['KSAZ-DT1'], 'Fox.us'), 'a feed that says nothing stays');
t(null, networkHome(['ABC 2 Portland OR (KATU)'], 'ESPN.us'), 'only the network channels are re-homed');

console.log('--- the 📍 Local tab');
const markets = parseMarkets('Chicago, Knoxville TN, Phoenix');
t(true, isLocalTo({ title: 'FOX 32 Chicago News', market: 'Chicago, IL', region: 'US' }, markets), 'a station of one of the cities');
t(false, isLocalTo({ title: 'FOX 11 Los Angeles', market: 'Los Angeles, CA', region: 'US' }, markets), 'a station of another city');
t(true, isLocalTo({ title: 'CBS News Chicago', region: 'US' }, markets), 'a channel whose name says the city');
t(true, isLocalTo({ title: 'Chicago Sports Network', region: 'US' }, markets), 'so does a regional sports network');
t(true, isLocalTo({ title: 'Marquee Sports Network', region: 'US' }, markets), 'Marquee is the Cubs\' channel, so Chicago');
t(false, isLocalTo({ title: 'Phoenix', region: 'DE' }, markets), 'a foreign channel that happens to share the name');
t(false, isLocalTo({ title: 'ESPN', region: 'US' }, markets), 'anything else');
t(false, isLocalTo({ title: 'CBS News Chicago', region: 'US' }, []), 'nothing until a city is named');
t(true, isLocalTo({ title: 'FOX 5 New York', market: 'New York, NY' }, parseMarkets('New York City')), '"New York City" typed finds the New York tiles');
t(false, isLocalTo({ title: 'FOX 12 Portland', market: 'Portland, OR' }, parseMarkets('Portland ME')), 'a state in the setting keeps the other Portland out');
t(true, isLocalTo({ title: 'FOX 12 Portland', market: 'Portland, OR' }, parseMarkets('Portland')), 'no state, either Portland');
t(true, isLocalTo({ title: 'Chicago Sports Network', region: 'US' }, parseMarkets('Chicago, ' + Array.from({ length: 30 }, (_, i) => `c${i}`).join(', '))), 'a long list still finds it');

console.log('--- the viewer\'s cities first on a network tile');
const rows = [
  { stationSort: '0|albany, ny|WNYT' }, { stationSort: '0|chicago, il|WMAQ' }, { title: 'TimStreams' },
  { stationSort: '2|east' }, { stationSort: '0|phoenix, az|KSAZ' }, { stationSort: '1||KATC' }
];
const order = (cmp) => [...rows].sort(cmp).map(r => r.stationSort || r.title);
t(['0|chicago, il|WMAQ', '0|phoenix, az|KSAZ', '0|albany, ny|WNYT', '1||KATC', '2|east', 'TimStreams'],
  order(stationOrder(markets)), 'own cities, then A to Z, call signs, national, then the rest');
t(['0|albany, ny|WNYT', '0|chicago, il|WMAQ', '0|phoenix, az|KSAZ', '1||KATC', '2|east', 'TimStreams'],
  order(stationOrder([])), 'with no cities named, A to Z');
t(['0|new york, ny|WNYW', '0|albany, ny|WNYT'],
  [{ stationSort: '0|albany, ny|WNYT' }, { stationSort: '0|new york, ny|WNYW' }].sort(stationOrder(parseMarkets('New York City'))).map(r => r.stationSort),
  '"New York City" pins New York');

console.log('--- every saved profile\'s cities, and the server\'s');
fs.writeFileSync(path.join(process.env.DATA_DIR, 'config.json'), JSON.stringify({ teams: 'Bears', markets: 'Chicago, Knoxville TN' }));
fs.mkdirSync(path.join(process.env.DATA_DIR, 'profiles'));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'profiles', 'a.json'), JSON.stringify({ markets: 'Phoenix' }));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'profiles', 'b.json'), '{not json');
// A viewer who typed only their state: it must not attach itself to the last
// city of whichever profile was read before theirs.
fs.writeFileSync(path.join(process.env.DATA_DIR, 'profiles', 'c.json'), JSON.stringify({ markets: 'AZ' }));
process.env.LOCAL_MARKETS = 'Chicago, Denver';
t(['Chicago', 'Denver', 'Knoxville', 'Phoenix'], wantedMarkets().map(m => m.name), 'the union, once each, an unreadable profile skipped');
t('', wantedMarkets().find(m => m.name === 'Chicago').state, 'a stray state in one profile leaves another\'s city alone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
