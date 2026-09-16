// What a card is able to say about a fixture once ESPN's scoreboard is read for
// more than orientation: which network is carrying it, whose clock its kickoff
// is read from, and — in ⭐ Your Teams — the games nobody streams yet.
//
// No network. The schedule here is the real index, seeded from events shaped
// like ESPN's and written to the file the catalog reads it back out of, so the
// keys, the sharing and the versioning are the ones production uses.
//
//   node tests/fixture-details.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-fixtures-'));
const { asValue } = require('awilix');
const homeAway = require('../src/services/HomeAwayService');
const container = require('../src/container');
const catalog = require('../src/catalog');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const DAY = 86400000;
const NOW = Date.now();
const KICK = NOW + 3 * DAY;
const CREST = 'https://a.espncdn.com/i/teamlogos/nfl/500';
const iso = ms => new Date(ms).toISOString();

let uid = 0;
const event = (start, home, away, opts = {}) => ({
  date: iso(start),
  uid: `s:20~l:28~e:${++uid}`,
  competitions: [{
    venue: { fullName: opts.venue || 'A Stadium' },
    status: { type: { state: 'pre' } },
    broadcasts: opts.net ? [{ names: opts.net }] : [],
    competitors: [
      { homeAway: 'home', team: { displayName: home, shortDisplayName: opts.homeShort, logo: opts.homeLogo } },
      { homeAway: 'away', team: { displayName: away, shortDisplayName: opts.awayShort, logo: opts.awayLogo } }
    ]
  }]
});

const RAMS = event(KICK, 'Los Angeles Rams', 'San Francisco 49ers', {
  net: ['FOX'], venue: 'SoFi Stadium',
  homeLogo: `${CREST}/scoreboard/lar.png`, awayLogo: `${CREST}/scoreboard/sf.png`
});
const PACKERS = event(NOW + 4 * DAY, 'Green Bay Packers', 'Chicago Bears');
// One club playing far more often than any club does, to fill the tab past the
// cap. No crests on these, so they are named from the index's own keys.
const BILLS = Array.from({ length: 60 }, (_, i) =>
  event(NOW + ((i % 6) + 1) * DAY + i * 60000, 'Buffalo Bills', `Test Club ${i}`));

// A fixture ESPN publishes no crest for, listed under both the name it leads
// with and the short one a feed is likelier to write. Nothing but those names
// can say whether somebody is already streaming it.
const HAWKS = event(NOW + 2 * DAY, 'Saint Anselm Hawks', 'Bentley Falcons', {
  homeShort: 'Saint Anselm', awayShort: 'Bentley'
});

homeAway._seed([RAMS, PACKERS, HAWKS, ...BILLS], 'football/nfl');
homeAway._persist();

const preview = (m, conf) => catalog._mapMatchToMetaPreview(m, conf || {});
const lineFrom = (desc, mark) => (String(desc).split('\n').find(l => l.startsWith(mark)) || '');
const fixture = (date, title) => ({
  id: 'p' + (++uid), title: title || 'San Francisco 49ers vs Los Angeles Rams',
  category: 'american_football', date: String(date)
});

console.log('--- what is carrying the game');
t('📡 On FOX', lineFrom(preview(fixture(KICK)).description, '📡'),
  'the network ESPN names, on the fixture\'s own tile');
t('', lineFrom(preview({ id: 'c1', title: 'ESPN', category: 'networks', date: '' }).description, '📡'),
  'never on a channel, which is carrying itself');
t('', lineFrom(preview(fixture(NOW + 4 * DAY, 'Chicago Bears vs Green Bay Packers')).description, '📡'),
  'and nothing at all for a fixture ESPN names no network for');

console.log('--- whose clock the kickoff is read from');
const shown = (date, title) => preview(fixture(date, title)).released;
t(iso(KICK), shown(KICK + 40 * 60000), 'a provider forty minutes out is overruled by ESPN');
t(iso(KICK), shown(KICK - 40 * 60000), 'in either direction');
t(iso(KICK + 5 * 60000), shown(KICK + 5 * 60000), 'five minutes out is left as the provider wrote it');
t(iso(KICK + 40 * 60000), shown(KICK + 40 * 60000, 'Dallas Cowboys vs New York Giants'),
  'as is a fixture ESPN does not list, where there is nothing to prefer');
const kept = fixture(KICK + 40 * 60000);
preview(kept);
t(String(KICK + 40 * 60000), kept.date,
  'and the fixture\'s own date is never moved: the merge, the sort and the cache key on it');

console.log('--- ⭐ Your Teams knows about games nobody streams yet');
const serve = list => container.register({
  cacheService: asValue({ getMatches: () => (list || []).map(m => ({ ...m })) }),
  cronService: asValue({ ensureFresh() {} })
});
const tab = async (name, conf, list) => {
  serve(list);
  const res = await catalog.handleCatalog('tv', `nuvio_sports_${name}`, {}, conf, { revalidate: false });
  return res.metas;
};
const pending = metas => metas.filter(m => m.description.includes('⏳ No streams listed yet'));

// A provider event for the same fixture, spelled as the feeds spell it: nothing
// of the two names survives, and only the crests say it is the same game.
const PROVIDER_RAMS = {
  id: 'prov1', title: '49ers vs Rams', category: 'american_football',
  date: String(KICK + 40 * 60000), sources: [{ source: 'x' }]
};

// The same game as HAWKS, written the way a feed writes it: no crest resolves
// on either side, so the only thing that can recognise it is one of the shorter
// spellings ESPN itself keyed the fixture under.
const PROVIDER_HAWKS = {
  id: 'prov2', title: 'Bentley vs Saint Anselm', category: 'american_football',
  date: String(NOW + 2 * DAY), sources: [{ source: 'x' }]
};

(async () => {
  const mine = await tab('teams', { teams: 'Rams' });
  t(1, pending(mine).length, 'the fixture ESPN lists for a team the viewer named');
  t(true, /49ers @ Los Angeles Rams$/.test((pending(mine)[0] || {}).name || ''),
    'named the way every other card is, visitor first');
  t('📡 On FOX', lineFrom((pending(mine)[0] || {}).description, '📡'), 'carrying the network line too');
  t(iso(KICK), (pending(mine)[0] || {}).released, 'and ESPN\'s own kickoff');

  t(0, pending(await tab('live', { teams: 'Rams' })).length, 'never in Live');
  t(0, pending(await tab('upcoming', { teams: 'Rams' })).length, 'nor in Upcoming');
  t(0, pending(await tab('american_football', { teams: 'Rams' })).length, 'nor in a sport\'s own tab');
  t(0, pending(await tab('teams', {})).length, 'and none at all until a profile names a team');

  t(40, pending(await tab('teams', { teams: 'Bills' })).length,
    'at most forty in one request, nearest kickoff first');

  const covered = await tab('teams', { teams: 'Rams' }, [PROVIDER_RAMS]);
  t(0, pending(covered).length, 'none where a provider already lists the fixture');
  t(1, covered.length, 'which leaves that provider\'s own tile, once');

  const short = await tab('teams', { teams: 'saint anselm' }, [PROVIDER_HAWKS]);
  t(0, pending(short).length,
    'nor where the provider spells a side shorter than the scoreboard does and no crest resolves');
  t(1, short.length, 'that one too is the provider\'s tile alone');

  // ESPN indexes one event per board, per day, per pair of sides, so the two
  // halves of a doubleheader are a single entry naming the first of them, and
  // the second game must not be handed the first game's hour or the first
  // game's channel. Seeded last: a seed replaces the whole index.
  console.log('--- two games between the same two sides on one day');
  const when = new Date(NOW + 5 * DAY);
  const GAME1 = Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate(), 13, 5);
  const GAME2 = GAME1 + 6 * 60 * 60000;
  homeAway._seed([
    event(GAME1, 'Boston Red Sox', 'New York Yankees', { net: ['NESN'] }),
    event(GAME2, 'Boston Red Sox', 'New York Yankees', { net: ['MLB Network'] })
  ], 'baseball/mlb');
  const leg = date => preview({
    id: `dh${date}`, title: 'New York Yankees vs Boston Red Sox',
    category: 'baseball', date: String(date)
  });

  const afternoon = leg(GAME1 + 40 * 60000);
  t(iso(GAME1), afternoon.released, 'the game ESPN indexed still reads its kickoff from ESPN');
  t('📡 On NESN', lineFrom(afternoon.description, '📡'), 'and still says what is carrying it');

  const evening = leg(GAME2);
  t(iso(GAME2), evening.released, 'the second game keeps its own kickoff, six hours after the first');
  t('', lineFrom(evening.description, '📡'), 'and is offered no channel belonging to the first');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
