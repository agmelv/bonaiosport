// What a stream row says it is, and which row the viewer is handed first.
//
// The list is the only thing telling a dozen rows apart. A name on a row has to
// be the name of the provider that row came from -- the viewer's whole strategy
// is "that site worked last night, try it again" and a borrowed name defeats
// it. The order has to follow what was measured rather than what was claimed.
// And two rows that end up at the same edge server must not be the first two
// choices, because they fail together.
//
//   node tests/stream-ranking.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-ranking-'));
const streams = require('../src/streams');
const StreamScoringService = require('../src/services/StreamScoringService');
const scorer = new StreamScoringService();

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

console.log('--- a row never borrows another provider\'s name');
t('WatchFooty', streams._sourceLabel('watchfooty'), 'a known source reads as itself');
t('Streamed.pk', streams._sourceLabel('admin'), 'a streamed.pk feed reads as the site it belongs to');
t('MyScraper', streams._sourceLabel('yaml_MyScraper'), 'a configured scraper reads as its configured name');
t('Live stream', streams._sourceLabel('some-site-nobody-has-named'), 'a source with no name of its own gets a neutral one');
t(false, Object.values(streams._PROVIDER_NAMES).includes(streams._sourceLabel('some-site-nobody-has-named')),
  'and that neutral name belongs to no provider');
t('', streams._sourceLabel(''), 'no source at all is not a name either');
t([], Object.keys(streams._SOURCE_PRIORITY).filter(k => streams._sourceLabel(k) === 'Live stream'),
  'every source the list ranks has a name of its own');

console.log('--- what was measured beats what was claimed');
const measured = { url: 'https://a.example/x.m3u8', title: 'Stream 1', resolution: '1920x1080', quality: '1080p60', bitrate: '3.5 Mbps' };
const claimed = { url: 'https://b.example/y.m3u8', title: 'HD 1080p Stream' };
t(true, scorer.calculateScore(measured, 'watchfooty') > scorer.calculateScore(claimed, 'watchfooty'),
  'a verified 1080p outranks a title that says 1080p');
t(true, scorer.calculateScore(measured, 'watchfooty') > scorer.calculateScore({ ...measured, resolution: '1280x720', quality: '720p' }, 'watchfooty'),
  'and a verified 1080p outranks a verified 720p');
t(true, scorer.calculateScore({ url: 'https://c.example/z.m3u8', title: 'Stream', resolution: '1280x720' }, 'watchfooty')
      > scorer.calculateScore({ externalUrl: 'https://c.example/watch', title: 'Stream 1080p' }, 'watchfooty'),
  'a stream the app can play still beats one that opens a browser');

console.log('--- a provider\'s recent record breaks ties, and no more');
const row = { url: 'https://d.example/z.m3u8', title: 'Stream 2', resolution: '1280x720' };
const evenScore = scorer.calculateScore(row, 'watchfooty');
const failing = scorer.calculateScore(row, 'watchfooty', { successes: 0, failures: 3, lastFailAt: Date.now() });
const answering = scorer.calculateScore(row, 'watchfooty', { successes: 6, failures: 0, lastFailAt: 0 });
t(true, failing < evenScore, 'a run of failures sinks the row');
t(true, evenScore - failing <= 15, `by at most fifteen points (${evenScore - failing})`);
t(true, answering > evenScore, 'a run of successes lifts it');
t(true, answering - evenScore <= 15, `by at most fifteen points (${answering - evenScore})`);
t(evenScore, scorer.calculateScore(row, 'watchfooty', { successes: 0, failures: 1, lastFailAt: 0 }),
  'one old failure is an anecdote, not a verdict');
t(true, scorer.calculateScore({ url: 'x', resolution: '3840x2160', bitrate: '9.0 Mbps', title: '1080p' }, 'admin', { successes: 9, failures: 0 }) <= 100,
  'the best a stream can be is a hundred');
t(true, scorer.calculateScore({ externalUrl: 'x', title: 'SD' }, 'nobody', { successes: 0, failures: 9, lastFailAt: Date.now() }) >= 0,
  'and the worst is nothing, never less');

console.log('--- the tally is what the verifier already saw');
t(undefined, streams._sourceHealth('a-provider-nothing-has-tried'), 'no evidence is no verdict');
for (let i = 0; i < 3; i++) streams._noteOutcome('demo-good', true);
for (let i = 0; i < 3; i++) streams._noteOutcome('demo-bad', false);
t(true, streams._sourceHealth('demo-bad').failures >= 2.9, 'three failures are counted');
t(true, streams._sourceHealth('demo-bad').lastFailAt > 0, 'and when the last one was');
t(0, streams._sourceHealth('demo-good').failures, 'a provider that keeps answering has none');
t(true, scorer.calculateScore(row, 'demo-bad', streams._sourceHealth('demo-bad'))
      < scorer.calculateScore(row, 'demo-good', streams._sourceHealth('demo-good')),
  'so the same row from the failing provider ranks lower');

console.log('--- two rows to one CDN are not the first two choices');
const link = (host) => '/api/manifest?url=' + encodeURIComponent(`https://${host}/live/x.m3u8`) + '&sig=x';
t('cdn7.strmd.st', streams._upstreamHost({ url: link('cdn7.strmd.st') }), 'a proxied row is read as the host it really plays from');
t('v.example.net', streams._upstreamHost({ url: 'https://v.example.net/live/y.m3u8' }), 'a direct row is its own host');
t('', streams._upstreamHost({ externalUrl: 'https://site.example/watch' }), 'a web player row has no host of its own');
const rows = [
  { id: 'a1', url: link('one.cdn.example') },
  { id: 'a2', url: link('one.cdn.example') },
  { id: 'b1', url: link('two.cdn.example') },
  { id: 'c1', url: 'https://three.cdn.example/live.m3u8' }
];
t(['a1', 'b1', 'c1', 'a2'], streams._spreadHosts(rows).map(r => r.id), 'the second CDN comes before the first one\'s second row');
t(['a1', 'a2', 'b1', 'c1'], streams._spreadHosts(rows).map(r => r.id).sort(), 'and every row is still there, exactly once');
t(['b1', 'c1'], streams._spreadHosts(rows.slice(2)).map(r => r.id), 'rows on hosts of their own are left where they were');
const webRows = [{ id: 'w1', externalUrl: 'https://s.example/1' }, { id: 'w2', externalUrl: 'https://s.example/2' }];
t(['w1', 'w2'], streams._spreadHosts(webRows).map(r => r.id), 'so are web player rows, which share nothing');
const deepRows = [
  { id: 'a1', url: link('one.cdn.example') },
  { id: 'a2', url: link('one.cdn.example') },
  { id: 'a3', url: link('one.cdn.example') },
  { id: 'b1', url: link('two.cdn.example') },
  { id: 'b2', url: link('two.cdn.example') }
];
t(['a1', 'b1', 'a2', 'a3', 'b2'], streams._spreadHosts(deepRows).map(r => r.id),
  'once every host has been offered, the rest keep the order they were scored into');
const mixedRows = [
  { id: 'd1', url: link('one.cdn.example') },
  { id: 'd2', url: link('one.cdn.example') },
  { id: 'd3', url: link('one.cdn.example') },
  { id: 'w1', externalUrl: 'https://s.example/1' },
  { id: 'w2', externalUrl: 'https://s.example/2' }
];
t(['d1', 'd2', 'd3', 'w1', 'w2'], streams._spreadHosts(mixedRows).map(r => r.id),
  'and a browser hand-off never takes a place from a stream the app can play itself');
t(['d1', 'd2', 'd3', 'w1', 'w2'], streams._spreadHosts(mixedRows).map(r => r.id).sort(),
  'with every row still there, exactly once');

console.log('--- the viewer\'s own source order is what they are handed');
// This setting reached only selectSources() before, where it chose which
// provider was asked first and nothing about what came back -- so dragging the
// list rearranged the work and never the answer.
t('rating', streams._sortMode({}), 'nothing said and nothing ordered: the rating decides');
t('source', streams._sortMode({ sourceOrder: 'timstreams,cdnlive' }),
  'ordering the sources is itself the request to be given that order');
t('rating', streams._sortMode({ sourceOrder: 'timstreams,cdnlive', sortBy: 'rating' }),
  'and saying otherwise outright still wins');
t('source', streams._sortMode({ sortBy: 'source' }), 'as does asking for it with nothing ordered');
t(null, streams._sourceRank({}), 'no order, no ranking');
const rank = streams._sourceRank({ sourceOrder: 'timstreams,cdnlive' });
t(0, rank({ _source: 'timstreams' }), 'the first named is first');
t(1, rank({ _source: 'cdnlive' }), 'the second is second');
t(2, rank({ _source: 'watchfooty' }), 'one they never placed sits behind every one they did');
t(2, rank({}), 'and so does a row that names no source at all');

const srcRows = [
  { id: 't1', _source: 'timstreams', url: link('one.cdn.example') },
  { id: 't2', _source: 'timstreams', url: link('one.cdn.example') },
  { id: 'c1', _source: 'cdnlive', url: link('two.cdn.example') }
];
t(['t1', 't2', 'c1'], streams._spreadRows(srcRows, true).map(r => r.id),
  'rotating hosts never lifts a second source over the whole of the first');
t(['t1', 'c1', 't2'], streams._spreadRows(srcRows, false).map(r => r.id),
  'where the rating decides, that rotation is free to reach across sources');
t(['c1', 't1', 't2'], streams._spreadRows([srcRows[2], srcRows[0], srcRows[1]], true).map(r => r.id),
  'and the sources come back in the order they were sorted into, not a fixed one');

(async () => {
  console.log('--- the fan-out is capped');
  t(4, streams._SOURCE_CONCURRENCY, 'four sources are resolved at a time');
  let inFlight = 0, most = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await streams._mapLimit(items, streams._SOURCE_CONCURRENCY, async (n) => {
    most = Math.max(most, ++inFlight);
    await new Promise(r => setTimeout(r, 5 + (n % 3) * 5));
    inFlight--;
    return n * 2;
  });
  t(true, most <= 4, `at most four ran together (${most})`);
  t(true, most > 1, 'and more than one did, so the cap is not a queue of one');
  t(items.map(n => n * 2), out, 'the answers come back in the order they were asked for');

  console.log('--- the channel sweep is not evidence about a provider');
  // The sweep probes every channel on a timer, the dead ones included, because
  // telling the dead from the live is what it is for. A provider carrying
  // hundreds of channels would otherwise be marked down for answering it.
  const row = { url: 'https://cdn.example/x.m3u8', title: 'x', _source: 'iptv-org' };
  t('', streams._tallySource(row, 'iptv-org:m:1', { strict: true }),
    'a sweep names no provider to count against');
  t('iptv-org', streams._tallySource(row, 'iptv-org:m:1', {}),
    'but a viewer opening the same stream does');
  t('iptv-org', streams._tallySource({ url: 'https://cdn.example/x.m3u8' }, 'iptv-org:m:1', {}),
    'and a row minted before it carried its own source is named by the cache key');
  t('', streams._tallySource({ url: 'https://cdn.example/x.m3u8' }, null, {}),
    'while a row with neither is counted against nobody');
  // The guard has to hold all the way through: an unnamed source must leave the
  // tally untouched however many outcomes are reported against it.
  const beforeSweep = streams._sourceHealth('iptv-org');
  for (let i = 0; i < 5; i++) streams._noteOutcome(streams._tallySource(row, null, { strict: true }), false);
  t(JSON.stringify(beforeSweep), JSON.stringify(streams._sourceHealth('iptv-org')),
    'five swept failures move nothing');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
