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

console.log('--- 24/7 channels: one crest is shared by several of them')
// The logo is resolved by name and is forgiving on purpose, so these answer to
// the same crest. Nine of the USA TV channels would have collapsed into three.
const ch = t => ({ id: 't' + t.replace(/\W/g, ''), title: t, category: 'networks', date: 0, sources: [] })
t(true,  same(ch('NFL RedZone'), ch('NFL vs RedZone')), 'one channel spelled two ways still merges')
t(false, same(ch('ESPN'), ch('ESPN Deportes')), 'ESPN is not ESPN Deportes')
t(false, same(ch('NBC Sports Boston'), ch('NBC Sports California')), 'NBC Sports regionals stay apart')
t(false, same(ch('SportsNet New York'), ch('SportsNet Pittsburgh')), 'SportsNet regionals stay apart')
// Two letters, and the only thing separating a national feed from a regional
// one. The tokeniser drops words shorter than three characters, so both the
// channel rule and the similarity rule below it compare `words` instead.
t(false, same(ch('Spectrum SportsNet'), ch('Spectrum SportsNet LA')), 'a two-letter regional suffix still counts')

console.log('--- regions: one channel name, several countries')
// ESPN is a US network and separate feeds elsewhere, with different commentary.
const rch = (t, region) => ({ id: 'r' + t + region, title: t, category: 'networks', date: 0, sources: [], region })
t(false, same(rch('ESPN', 'US'), rch('ESPN', 'NZ')), 'ESPN US is not ESPN NZ')
t(true,  same(rch('ESPN', 'US'), rch('ESPN', 'US')), 'the same channel in one region still merges')
t(true,  same(rch('ESPN', ''),   rch('ESPN', 'US')), 'a listing that names no region still merges')

console.log('--- short channel names, and region words in a name')
t(true,  same(ch('CW'), ch('CW')), 'two listings of CW merge')
t(false, same(ch('CW'), ch('FX')), 'CW is not FX')
t(false, same(ch('FX'), ev('sf_fx', 'Arsenal vs Chelsea', 'football', D, [])), 'a short channel name does not join a fixture')
t(true,  same({ ...rch('DAZN 1 Germany', 'DE'), baseTitle: 'DAZN 1' }, { ...rch('DAZN 1', 'DE'), baseTitle: 'DAZN 1' }), 'DAZN 1 Germany is DAZN 1 in DE')
t(false, same({ ...rch('DAZN 1 Germany', 'DE'), baseTitle: 'DAZN 1' }, { ...rch('DAZN 1', 'ES'), baseTitle: 'DAZN 1' }), 'DAZN 1 DE is not DAZN 1 ES')

console.log('--- one channel under its on-air short name')
// USA TV Next lists FS1 and FS2; TimStreams lists Fox Sports 1 and 2. They were
// two tiles each, and the USA TV ones had no streams.
t(true,  same(rch('FS1', 'US'), rch('Fox Sports 1', 'US')), 'FS1 is Fox Sports 1')
t(true,  same({ ...rch('FS2', 'US'), baseTitle: 'FS2' }, { ...rch('Fox Sports 2 US', 'US'), baseTitle: 'Fox Sports 2' }), 'FS2 is Fox Sports 2 US')
t(false, same(rch('FS1', 'US'), rch('FS2', 'US')), 'FS1 is not FS2')
t(false, same({ ...rch('FS2', 'US'), baseTitle: 'FS2' }, { ...rch('Fox Sports 2 AR', 'AR'), baseTitle: 'Fox Sports 2' }), 'FS2 US is not Fox Sports 2 AR')
t(false, same(ch('Fox Sports 1'), ch('Fox Sports 501 Cricket')), 'Fox Sports 1 is not Fox Sports 501')
t(false, same(ch('FS1'), ev('ts_fs1_game', 'Arsenal vs Chelsea', 'football', D, [])), 'a channel short name does not join a fixture')

console.log('--- one Streamed.pk feed split into the channels its streams name')
// admin-espn carries ESPN, ESPN2, ESPN Deportes and ABC. The split channels all
// share the feed's source id, which must not fuse them back into one tile.
const spkSrc = (channel) => [{ source: 'streamedpk', id: 'admin-espn', streamSource: 'admin', streamId: 'admin-espn', channel }]
const spk = (title, channel) => ({ id: 'spk_ch_admin-espn' + (channel === 'ESPN' ? '' : '__' + channel.toLowerCase().replace(/[^a-z0-9]/g, '')), title, category: 'networks', date: 0, sources: spkSrc(channel) })
t(false, same(spk('ESPN', 'ESPN'), spk('ESPN2', 'ESPN2')), 'split ESPN is not split ESPN2')
t(false, same(spk('ESPN', 'ESPN'), spk('ESPN Deportes', 'ESPN Deportes')), 'split ESPN is not split ESPN Deportes')
t(false, same(spk('ESPN2', 'ESPN2'), spk('ABC', 'ABC')), 'split ESPN2 is not split ABC')
t(true,  same(spk('ESPN2', 'ESPN2'), { ...rch('ESPN2 US', 'US'), baseTitle: 'ESPN2' }), 'split ESPN2 joins the ESPN2 US tile')
t(true,  same(spk('ESPN', 'ESPN'), { ...rch('ESPN US', 'US'), baseTitle: 'ESPN' }), 'split ESPN joins the ESPN US tile')
const { channelFromLanguage } = require('../src/providers/StreamedPkProvider')
t('ESPN Deportes', channelFromLanguage('Spanish - ESPN Deportes'), 'language label names the channel')
t(null, channelFromLanguage('English'), 'a plain language names no channel')
t(null, channelFromLanguage('English - Stream 2'), 'a stream number is not a channel')

console.log('--- one channel spelled with and without a space')
t(true,  same({ ...rch('ESPN 2 US', 'US'), baseTitle: 'ESPN 2' }, { ...rch('ESPN2 US', 'US'), baseTitle: 'ESPN2' }), 'ESPN 2 US is ESPN2 US')
t(true,  same({ ...rch('ESPN U', 'US') }, { ...rch('ESPNU', 'US') }), 'ESPN U is ESPNU')
t(true,  same({ ...rch('ESPN News', 'US') }, { ...rch('ESPNEWS', 'US') }), 'ESPN News is ESPNEWS')
t(true,  same(ch('TSN 1'), ch('TSN1')), 'TSN 1 is TSN1')
t(false, same(ch('TSN 1'), ch('TSN 2')), 'TSN 1 is not TSN 2')
t(true,  same(ch('Sport TV 1'), ch('Sport TV1')), 'Sport TV 1 is Sport TV1')
t(false, same(ch('Sport TV 1'), ch('Sport TV 2')), 'Sport TV 1 is not Sport TV 2')
t(true,  same(ch('FX Movie Channel'), ch('FXM')), 'FX Movie Channel is FXM')
t(false, same(ch('FXM'), ch('FX')), 'FXM is not FX')
t(true,  same(ch('Hallmark Channel'), ch('Hallmark')), 'Hallmark Channel is Hallmark')
t(false, same(ch('Hallmark'), ch('Hallmark Family')), 'Hallmark is not Hallmark Family')
t(false, same(ch('Hallmark Channel'), ch('Hallmark Mystery')), 'Hallmark Channel is not Hallmark Mystery')
t(true,  same(ch('Fox News Channel'), ch('FOX News')), 'Fox News Channel is FOX News')
t(false, same(ch('FOX News'), ch('Fox Business')), 'FOX News is not Fox Business')
t(false, same(ch('ESPN 2 US'), ch('ESPN Deportes')), 'ESPN 2 is not ESPN Deportes')
t(false, same(ch('ESPNU'), ch('ESPN')), 'ESPNU is not ESPN')

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
