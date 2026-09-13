// How a channel's cover is laid out.
//
// The owner's call: the logo centred at the size it already had, the channel's
// name in a quiet line along the top, nothing under the logo, and no "24/7".
//
//   node tests/channel-covers.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-covers-'));
const img = require('../src/services/ImageService');

let pass = 0, fail = 0;
const t = (ok, label, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${detail !== '' ? '  (' + detail + ')' : ''}`);
};
const texts = svg => [...svg.matchAll(/<text[^>]*y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(m => ({ y: Number(m[1]), text: m[2] }));
const image = svg => {
  const m = svg.match(/<image x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="(\d+)"/);
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
};
const logo = { buffer: Buffer.from('not decoded here'), contentType: 'image/png' };

console.log('--- a cover with a logo');
let svg = img.svgEvent('ESPN 2 BR', logo, '64748b', { cover: true, markW: 500, markH: 120 });
let words = texts(svg);
t(words.length === 1, 'exactly one line of text', JSON.stringify(words));
t(words[0] && words[0].text === 'ESPN 2 BR' && words[0].y < 60, 'the name sits along the top', JSON.stringify(words[0]));
t(!svg.includes('24/7'), 'no 24/7 anywhere');
const box = image(svg);
t(box && box.w === 500 && box.h === 120, 'the logo keeps its size', JSON.stringify(box));
t(box && Math.abs(box.y + box.h / 2 - 225) <= 1 && Math.abs(box.x + box.w / 2 - 400) <= 1, 'and is centred in the card', JSON.stringify(box));

svg = img.svgEvent('ESPN 2 BR', logo, '64748b', { cover: true, markW: 500, markH: 120, kicker: '24/7' });
t(!svg.includes('24/7'), 'a kicker in an old URL is not drawn on a cover');

svg = img.svgEvent('beIN SPORTS XTRA en Espanol and a very long channel name', logo, '64748b', { cover: true, markW: 400, markH: 200 });
words = texts(svg);
t(words.length === 1 && words[0].text.length <= 40, 'a long name stays one line at the top', words[0] && words[0].text);

console.log('--- a cover with no logo');
svg = img.svgEvent('NCTV79', null, '64748b', { cover: true });
words = texts(svg);
t(words.length === 1 && words[0].text === 'NCTV79' && words[0].y > 180, 'the name is the card, in the middle', JSON.stringify(words));

console.log('--- other event cards keep their kicker');
svg = img.svgEvent('UFC 300', logo, '64748b', { kicker: 'UFC', plate: true });
t(svg.includes('>UFC<'), 'a non-cover card still draws its kicker');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
