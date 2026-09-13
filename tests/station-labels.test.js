// Which local station a network stream is.
//
// The owner's ask: FOX, ABC, CBS and NBC tiles carry streams from different
// cities' stations, and every one read "Live channel · N". Each real record
// here came from iptv-org's data for streams on the live tiles.
//
//   node tests/station-labels.test.js
const { stationLabel, cbsNewsLabel } = require('../src/services/StationLabel');
const table = require('../src/services/data/us-stations.json');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = want === got;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const L = (channelId, channelName, streamTitle, feed) => {
  const r = stationLabel({ channelId, channelName, streamTitle, feed });
  return r ? r.label : null;
};

console.log('--- city and call sign');
t('Dallas, TX · KDFW', L('Fox.us', 'Fox', 'KDFW-DT1', 'KDFW'), 'a bare call sign gets its city from the table');
t('New York, NY · WNYW', L('Fox.us', 'Fox', 'WNYW-DT1', 'WNYW'), '"New York City" reads "New York"');
t('Seattle, WA · KCPQ', L('Fox.us', 'Fox', 'FOX 13 Seattle WA (KCPQ)', 'KCPQ'), 'the market in the title beats the city of licence');
t('Biloxi, MS · WXXV', L('Fox.us', 'Fox', 'WXXV-TV News (Biloxi MS)', 'NOT-IN-TABLE'), 'a "(City ST)" title names the city, the call sign comes from the title');

// Live on the ABC and CBS tiles: the title's state was wrong, the filed one right.
const feedOf = (channel, call) => (Object.keys(table).find(k => k.startsWith(`${channel}/`) && table[k][1] === call) || '').split('/')[1];
t('Austin, MN · KAAL', L('ABC.us', 'ABC', 'ABC 6 Austin TX (KAAL)', feedOf('ABC.us', 'KAAL')), 'a wrong state in the title gives way to the filed one');
t('Myrtle Beach, SC · WPDE', L('ABC.us', 'ABC', 'WPDE News (Myrtle Beach FL)', feedOf('ABC.us', 'WPDE')), 'the title keeps its market, the state comes from the file');

console.log('--- the other shapes');
t('National · East', L('NBC.us', 'NBC', 'NBC', 'East'), 'a national feed');
t('Portland, OR · KATU (ABC)', L('CW.us', 'CW', 'ABC 2 Portland OR (KATU)', 'NOT-IN-TABLE'), 'another network\'s station on this tile says so');
t('KATC', L('ABC.us', 'ABC', 'KATC 3.1', 'NOT-IN-TABLE'), 'a call sign alone when nothing gives a city');
t(null, L('CBS.us', 'CBS', 'CBS News 24/7', 'SD'), 'nothing to go on is no label, never "24/7"');
t(null, L('Fox.us', 'Fox', 'Something Else', ''), 'a title with no station is no label');

console.log('--- sort order');
const a = stationLabel({ channelId: 'Fox.us', channelName: 'Fox', streamTitle: 'KDFW-DT1', feed: 'KDFW' });
const b = stationLabel({ channelId: 'Fox.us', channelName: 'Fox', streamTitle: 'WNYW-DT1', feed: 'WNYW' });
const n = stationLabel({ channelId: 'NBC.us', channelName: 'NBC', streamTitle: 'NBC', feed: 'East' });
t(true, a.sort < b.sort && b.sort < n.sort, 'cities A to Z, national feeds after them');

console.log('--- USA TV CBS News locals');
t('CBS News Texas', cbsNewsLabel('HV:CBSN-DAL'), 'a CBS News host tag names its city');
t('CBS News Boston', cbsNewsLabel('HV:CBSN-BOS'), 'Boston');
t(null, cbsNewsLabel('HV:DAI'), 'any other tag is no label');

console.log('--- the bundled table');
t(true, Object.keys(table).length > 500, `it covers the network affiliates (${Object.keys(table).length} entries)`);
t(false, Object.values(table).some(v => v.some(x => String(x).includes('24/7'))), 'no entry says 24/7');
t(true, Math.max(...Object.values(table).map(v => `${v[0]} · ${v[1] || ''}`.length)) <= 40, 'every label fits a TV row');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
