// Which two listings are the same event.
//
// Every case here was a real listing in the live catalog. The merge rules are
// two-sided -- too strict and one fixture is listed once per provider with its
// streams split between the copies; too loose and unrelated games fuse and the
// streams of one show up under the other. Both halves are asserted, because
// every fix for one has so far been a temptation to break the other.
//
//   node tests/merge-identity.test.js
const MatchAggregator = require('../src/services/MatchAggregator');
const agg = new MatchAggregator({});
const hex = s => Buffer.from(s).toString('hex');
const D = Date.parse('2026-09-12T18:00:00Z');

const ev = (id, title, category, date, srcUrls) => ({
  id, title, category, date,
  sources: (srcUrls || []).map(u => ({ id: hex(u), url: u }))
});

function same(a, b) {
  return agg._sameEventPre(agg._precompute(a), agg._precompute(b));
}
let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = want === got;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${want}, got ${got})`);
};

console.log('--- the bug: different college games sharing a US channel embed');
const usa1 = ev('ts_howard-bison-v-indiana-hoosiers-401858439', 'Howard Bison @ Indiana Hoosiers',
                'american_football', D, ['https://epiembeds.online/embed/big10-usa']);
const usa2 = ev('ts_oregon-ducks-v-oklahoma-state-cowboys-401856782', 'Oregon Ducks @ Oklahoma State Cowboys',
                'american_football', D, ['https://epiembeds.online/embed/espn-usa']);
const usa3 = ev('ts_penn-state-nittany-lions-v-temple-owls-401858442', 'Penn State Nittany Lions @ Temple Owls',
                'american_football', D, ['https://epiembeds.online/embed/abc-usa']);
t(false, same(usa1, usa2), 'Howard/Indiana vs Oregon/Okla St must NOT merge');
t(false, same(usa1, usa3), 'Howard/Indiana vs Penn St/Temple must NOT merge');
t(false, same(usa2, usa3), 'Oregon/Okla St vs Penn St/Temple must NOT merge');

console.log('--- no regression: a real shared upstream id still merges');
const up1 = ev('ss99_2475376', 'Some Team vs Other Team', 'college', D, []);
const up2 = ev('spk_some-team-vs-other-team-2475376', 'Some Team vs Other Team', 'american_football', D, []);
t(true, same(up1, up2), 'shared real upstream number still merges');

console.log('--- the alias table');
t(true,  same(ev('sf_a','Werder Bremen vs FC Cologne','football',D,[]),
              ev('spk_b','Köln vs Werder Bremen','football',D,[])), 'FC Cologne == Köln (reversed order)');
t(true,  same(ev('sf_c','Elche vs Athletic Club','football',D,[]),
              ev('spk_d','Athletic Bilbao vs Elche','football',D,[])), 'Athletic Club == Athletic Bilbao');
t(true,  same(ev('sf_e','Bayern München vs Borussia Mönchengladbach','football',D,[]),
              ev('spk_f','Bayern Munich vs Gladbach','football',D,[])), 'accents fold, Gladbach alias');

console.log('--- still must not merge');
t(false, same(ev('sf_g','Arsenal vs Chelsea','football',D,[]),
              ev('spk_h','Arsenal vs Tottenham','football',D,[])), 'different opponents');
t(false, same(ev('sf_i','Real Madrid vs Barcelona','football',D,[]),
              ev('spk_j','Real Betis vs Barcelona','football',D,[])), 'Real Madrid != Real Betis');
t(false, same(ev('sf_k','Köln vs Werder Bremen','football',D,[]),
              ev('spk_l','Köln vs Werder Bremen','football',D + 26*3600*1000,[])), 'same fixture, next day');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
