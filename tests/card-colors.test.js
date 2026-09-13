// What colours a matchup card is painted in.
//
// A team's half should be in that team's colours. The owner's report was a
// Dolphins-Raiders card in teal and darker teal: the Raiders' shield has no
// colour in it, so their half borrowed the Dolphins' aqua, and the Dolphins'
// orange was never used.
//
//   node tests/card-colors.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-colors-'));
const img = require('../src/services/ImageService');
const cc = require('../src/services/CrestColorService');

let pass = 0, fail = 0;
const t = (ok, label, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${detail !== '' ? '  (' + detail + ')' : ''}`);
};
const spread = (x, y) => [0, 1, 2].reduce((acc, i) =>
  acc + Math.abs(parseInt(x.slice(i * 2, i * 2 + 2), 16) - parseInt(y.slice(i * 2, i * 2 + 2), 16)), 0);

console.log('--- official colours come from the bundled table');
const mia = cc.brandForCrest('https://a.espncdn.com/i/teamlogos/nfl/500/mia.png');
const lv = cc.brandForCrest('https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/lv.png');
t(Array.isArray(mia) && mia.length === 2, 'the Dolphins have two colours', JSON.stringify(mia));
t(Array.isArray(lv) && lv.length >= 1, 'the Raiders have theirs, found through the /scoreboard/ URL too', JSON.stringify(lv));
t(cc.brandForCrest('https://example.com/some-club.png') === null, 'a crest the table does not know has none');

const table = require('../src/services/data/espn-team-colors.json');
const rugbyKey = Object.keys(table).find(k => k.startsWith('rugby/'));
if (rugbyKey) {
  const url = `https://a.espncdn.com/i/teamlogos/rugby/teams/500/${rugbyKey.split('/')[1]}.png`;
  t(Array.isArray(cc.brandForCrest(url)), 'rugby crests (…/rugby/teams/500/…) reach the table too', url);
}
t(!Object.values(table).some(v => v.length === 2 && v[0] === '000000' && v[1] === 'c60000'), 'ESPN\'s black-and-red stand-in is not in the table');

console.log('--- Dolphins at Raiders');
const dol = { colors: ['018f99', 'ff4f06'], light: 0.3, crest: true, brand: ['008e97', 'fc4c02'] };
const rai = { colors: [], light: 0.4, crest: true, brand: ['000000', 'a5acaf'] };
let c = img.cardColors(dol, rai, '0369a1');
t(c.a === '008e97', 'the Dolphins half is their aqua', c.a);
t(c.b === img.NEUTRAL_HALF, 'the Raiders half is charcoal, not a shade of Dolphins aqua', c.b);

console.log('--- the same with the real table, when it is present');
if (mia && lv) {
  c = img.cardColors({ ...dol, brand: mia }, { ...rai, brand: lv }, '0369a1');
  t(cc.isChromatic(c.a) && c.b === img.NEUTRAL_HALF, 'aqua half, charcoal half', JSON.stringify(c));
}

console.log('--- the official colour the crest actually wears comes first');
c = img.cardColors({ colors: ['f76900', '000e54'], light: 0.2, crest: true, brand: ['000e54', 'f76900'] },
  { colors: ['003594', 'ffb81c'], light: 0.3, crest: true, brand: ['003594', 'ffb81c'] }, '0369a1');
t(c.a === 'f76900', 'Syracuse is orange, not the navy ESPN lists first', c.a);
c = img.cardColors({ colors: ['0057b8'], light: 0.4, crest: true, brand: ['0000ff'] },
  { colors: ['6cabdd'], light: 0.3, crest: true, brand: [] }, '0369a1');
t(c.a !== '0000ff' && spread(c.a, '0057b8') < 60, 'an official colour the crest never shows loses to the crest\'s own', c.a);
c = img.cardColors({ colors: [], light: 0, crest: false, brand: ['000e54', 'f76900'] },
  { colors: ['003594'], light: 0.3, crest: true, brand: [] }, '0369a1');
t(c.a === '000e54' || spread(c.a, '000e54') < 60, 'with no crest to judge by, ESPN\'s order stands', c.a);

console.log('--- two teams in the same colour still read as two halves');
c = img.cardColors({ colors: [], light: 0.3, crest: true, brand: ['c8102e', 'ffb612'] },
  { colors: [], light: 0.3, crest: true, brand: ['c60c30', '002244'] }, '0369a1');
t(spread(c.a, c.b) >= 90, 'an alternate colour separates them', JSON.stringify(c));

console.log('--- without official colours, cards are what they were');
c = img.cardColors({ colors: ['ef0107'], light: 0.3, crest: true, brand: [] },
  { colors: ['034694'], light: 0.3, crest: true, brand: [] }, '0369a1');
t(spread(c.a, 'ef0107') < 60 && spread(c.b, '034694') < 60, 'each half stays near its crest colour', JSON.stringify(c));
c = img.cardColors({ colors: [], light: 0.5, crest: true, brand: [] }, { colors: [], light: 0.5, crest: true, brand: [] }, '0369a1');
t(c.a !== img.NEUTRAL_HALF && spread(c.a, '0369a1') < 120, 'two colourless crests keep the category colour', JSON.stringify(c));
c = img.cardColors({ colors: ['ef0107'], light: 0.3, crest: true, brand: [] }, { colors: [], light: 0.6, crest: true, brand: [] }, '0369a1');
t(c.b === img.NEUTRAL_HALF, 'a colourless side is charcoal, not the opponent\'s colour', c.b);
c = img.cardColors({ colors: ['ef0107'], light: 0.3, crest: true, brand: [] }, { colors: [], light: 0.02, crest: true, brand: [] }, '0369a1');
t(c.b !== img.NEUTRAL_HALF, 'a dark colourless crest gets a lighter grey to show against', c.b);
c = img.cardColors({ colors: ['ef0107'], light: 0.3, crest: true, brand: [] }, { colors: [], light: null, crest: true, brand: [] }, '0369a1');
t(c.b === img.NEUTRAL_HALF, 'a crest that could not be read is not taken for a dark one', c.b);

console.log('--- a dark crest on its own dark official colour is lifted');
c = img.cardColors({ colors: ['132448'], light: 0.02, crest: true, brand: ['132448', 'c4ced4'] },
  { colors: ['ce1141'], light: 0.3, crest: true, brand: [] }, '0369a1');
t(c.a !== '132448' && spread(c.a, '132448') > 40, 'the Yankees\' navy NY does not vanish into navy', c.a);

console.log('--- cards are two halves, nothing more');
t(!/fill-opacity="0\.95"/.test(img.svgMatchup('Miami Dolphins', 'Las Vegas Raiders', null, null, '0369a1')), 'no colour stripes along the bottom');

console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
