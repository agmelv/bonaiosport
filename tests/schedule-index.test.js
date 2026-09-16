// What a refresh asks ESPN for, and what it keeps about a fixture once the
// answers are in.
//
// ESPN retired the dates=A-B range form and answers 400 for it on every board,
// which is why the plan is asserted down to the shape of each `dates` value: a
// range that creeps back in fails silently in production, costing every card on
// that board its orientation and its league crest.
//
// No network. The events below are shaped like ESPN's, and everything from
// parsing down is exercised for real.
//
//   node tests/schedule-index.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-schedule-'));
const homeAway = require('../src/services/HomeAwayService');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

const INDEX_FILE = path.join(process.env.DATA_DIR, 'homeaway.json');

console.log('--- the requests a refresh makes');
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const jobs = homeAway._plan(NOW);
const forBoard = b => jobs.filter(j => j.board === b);
const days = js => js.filter(j => j.dates.length === 8).map(j => j.dates);
const months = js => js.filter(j => j.dates.length === 6).map(j => j.dates);

t(true, jobs.every(j => !j.dates.includes('-')), 'no job asks for a date range, the form ESPN now refuses');
t(true, jobs.every(j => /^\d{6}$|^\d{8}$/.test(j.dates)), 'every job asks for one month or one day');
t(11, days(forBoard('soccer/all')).length, 'soccer is fetched a day at a time, being past the response cap in a month');
t(11, days(forBoard('football/college-football')).length, 'so is college football, whose month comes back short');
t(0, days(forBoard('football/nfl')).length, 'a board the month answers for is asked for no days at all');
t('20260914', days(forBoard('soccer/all'))[0], 'the days start with yesterday');
t('20260924', days(forBoard('soccer/all'))[10], 'and run nine days out');
t(['202609', '202610', '202611'], months(forBoard('football/nfl')), 'the months the 70-day horizon touches');
t(months(forBoard('football/nfl')), months(forBoard('soccer/all')), 'and every board is asked for them, per-day boards included');
t(55, jobs.length, 'fifty-five requests, where the ranges were eighty-four');
t(['202612', '202701', '202702', '202703'],
  months(homeAway._plan(Date.UTC(2026, 11, 31, 12, 0, 0)).filter(j => j.board === 'football/nfl')),
  'a horizon that crosses a new year keeps counting months');

console.log('--- one event, many keys, one record');
const CREST = 'https://a.espncdn.com/i/teamlogos/nfl/500';
const RAMS_49ERS = {
  date: '2026-09-20T17:00:00Z',
  uid: 's:20~l:28~e:401671789',
  __boardLogo: 'https://a.espncdn.com/i/leaguelogos/nfl.png',
  competitions: [{
    venue: { fullName: 'SoFi Stadium' },
    status: { type: { state: 'pre' } },
    // ESPN states the same network twice, in two different lists.
    broadcasts: [{ names: ['FOX', 'FOX'] }],
    geoBroadcasts: [{ media: { shortName: 'FOX' } }, { media: { shortName: 'KTTV' } }],
    competitors: [
      { homeAway: 'home', team: { displayName: 'Los Angeles Rams', shortDisplayName: 'Rams', location: 'Los Angeles', abbreviation: 'LAR', logo: `${CREST}/scoreboard/lar.png` } },
      { homeAway: 'away', team: { displayName: 'San Francisco 49ers', shortDisplayName: '49ers', location: 'San Francisco', abbreviation: 'SF', logo: `${CREST}/scoreboard/sf.png` } }
    ]
  }]
};
const MANY_NETWORKS = {
  date: '2026-09-20T20:00:00Z',
  uid: 's:20~l:28~e:401671790',
  competitions: [{
    venue: { fullName: 'Lambeau Field' },
    status: { type: { state: 'in' } },
    broadcasts: [{ names: ['ESPN', 'ESPN2', 'ABC', 'ESPN+'] }],
    geoBroadcasts: [{ media: { shortName: 'TSN' } }],
    competitors: [
      { homeAway: 'home', team: { displayName: 'Green Bay Packers', shortDisplayName: 'Packers', location: 'Green Bay', abbreviation: 'GB' } },
      { homeAway: 'away', team: { displayName: 'Chicago Bears', shortDisplayName: 'Bears', location: 'Chicago', abbreviation: 'CHI' } }
    ]
  }]
};

const seeded = homeAway._seed([RAMS_49ERS, MANY_NETWORKS], 'football/nfl');
t(2, seeded.events, 'two events are two records');
t(true, seeded.keys > 20, `every name variant against every other is many keys (${seeded.keys})`);

homeAway._persist();
const saved = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
t(2, saved.v, 'the file says which shape it holds');
t(2, saved.events.length, 'the crest key and every name key of an event share one record');
t(seeded.keys, saved.keys.length, 'and each key is an offset into it');
t(true, saved.keys.every(([, at]) => at === 0 || at === 1), 'no key points anywhere else');

console.log('--- which side is at home');
const KICK = Date.parse(RAMS_49ERS.date);
const LAR = `${CREST}/lar.png`;   // the bundled table's spelling, not the scoreboard's
const SF = `${CREST}/sf.png`;
const sides = o => o && { away: o.away, home: o.home };
t({ away: 'SF', home: 'LA' }, sides(homeAway.orient('SF', 'LA', SF, LAR, 'american_football', KICK)), 'a crest pair, visitor named first');
t({ away: 'SF', home: 'LA' }, sides(homeAway.orient('LA', 'SF', LAR, SF, 'american_football', KICK)), 'the same however the caller ordered it');
t({ away: '49ers', home: 'Rams' }, sides(homeAway.orient('49ers', 'Rams', null, null, 'american_football', KICK)), 'a name pair with no crests to go on');
t({ away: 'Chicago', home: 'Green Bay' }, sides(homeAway.orient('Green Bay', 'Chicago', null, null, 'american_football', KICK)), 'a short name variant, in the other order');
t(true, typeof homeAway.orient('49ers', 'Rams', null, null, 'american_football', KICK).leagueLogo === 'string', 'the league crest comes back with it');
t(null, homeAway.orient('49ers', 'Rams', null, null, 'american_football', null), 'an undated fixture is refused rather than guessed at');
t(null, homeAway.orient('49ers', 'Rams', null, null, 'hockey', KICK), 'and so is a category whose boards never listed it');

console.log('--- what else ESPN said about the fixture');
const d = homeAway.details('49ers', 'Rams', null, null, 'american_football', KICK);
t(['FOX', 'KTTV'], d.net, 'each network once, in the order ESPN lists them');
t('SoFi Stadium', d.venue, 'the venue');
t('pre', d.status, 'and whether it has started');
t(KICK, d.start, 'the kickoff ESPN has, in ms');
t(true, typeof d.leagueLogo === 'string', 'the league crest, as orient gives it');
t(['ESPN', 'ESPN2', 'ABC'], homeAway.details('Bears', 'Packers', null, null, 'american_football', KICK).net, 'at most three, the rest dropped');
t(null, homeAway.details('Jets', 'Giants', null, null, 'american_football', KICK), 'nothing at all for a fixture ESPN does not list');
d.net.push('CBS');
t(['FOX', 'KTTV'], homeAway.details('49ers', 'Rams', null, null, 'american_football', KICK).net, 'a caller editing what it got does not edit the index');

console.log('--- a file from before the records existed');
fs.writeFileSync(INDEX_FILE, JSON.stringify({
  fetchedAt: Date.now(),
  stats: null,
  index: [['L:football/nfl:20260920:nfl/lar|nfl/sf', { home: 'nfl/lar', league: null }]]
}));
homeAway._seed([], 'football/nfl');
homeAway._restore();
t(0, homeAway.stats().size, 'the old shape is rebuilt from ESPN, never half-read');

console.log('--- and one this build wrote');
homeAway._seed([RAMS_49ERS], 'football/nfl');
homeAway._persist();
homeAway._seed([], 'football/nfl');
homeAway._restore();
t({ away: 'SF', home: 'LA' }, sides(homeAway.orient('SF', 'LA', SF, LAR, 'american_football', KICK)), 'comes back able to orient');
t(['FOX', 'KTTV'], homeAway.details('49ers', 'Rams', null, null, 'american_football', KICK).net, 'with the details still on it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
