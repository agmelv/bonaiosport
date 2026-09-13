// Which artwork players may keep, and under which address.
//
// Players cache images by URL. These rules decide whether a card drawn around a
// missing logo sticks on somebody's TV, and whether clearing the cache ever
// reaches a player at all -- both of which it failed to do before.
//
//   node tests/art-cache.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-art-'));
process.env.DATA_DIR = tmp;
const art = require('../src/services/ArtGeneration');
art._setDirForTest(tmp);
const img = require('../src/services/ImageService');
const warmer = require('../src/services/CardWarmer');
const { resolveMatchup } = require('../src/services/TeamLogoService');

let pass = 0, fail = 0;
const t = (ok, label, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
};

console.log('--- every generated URL carries the render version and the generation');
const gen = art.get();
const v = `v=5.${gen}`;
t(img.matchupUrl('http://h', { a: 'A', b: 'B', aLogo: 'http://x/a.png', bLogo: 'http://x/b.png' }).endsWith(v), 'matchupUrl', v);
t(img.eventUrl('http://h', { text: 'T', mark: 'http://x/m.png' }).endsWith(v), 'eventUrl');
t(img.proxyUrl('http://h', 'http://x/p.png').endsWith(v), 'proxyUrl');
t(img.placeholderUrl('http://h', 'T', '333333').endsWith(v), 'placeholderUrl');
t(fs.existsSync(path.join(tmp, 'art-generation.json')), 'the generation is written to DATA_DIR');
t(img.isCurrentArt({ query: { v: img.artVersion() } }) && !img.isCurrentArt({ query: { v: '4' } }), 'isCurrentArt tells today\'s URL from an old one');

console.log('--- clearing mints a new generation, at most once in 30 s');
const first = art.bump('test');
t(first.bumped && first.generation !== gen, 'a bump changes the token', `${gen} -> ${first.generation}`);
const second = art.bump('test');
t(!second.bumped && second.generation === first.generation, 'the same clear again inside 30 s is refused');
t(JSON.parse(fs.readFileSync(path.join(tmp, 'art-generation.json'), 'utf8')).generation === first.generation, 'the new token is persisted');
art._setDirForTest(tmp);
t(art.get() === first.generation, 'a restart reads the same token back');
t(img.matchupUrl('http://h', { a: 'A', b: 'B', aLogo: 'http://x/a.png' }).endsWith(`v=5.${first.generation}`), 'URLs follow the new token');
const third = art.bump('clear:all');
t(third.bumped && third.generation !== first.generation, 'a different, wider clear inside 30 s still mints');

console.log('--- what players are told they may keep');
const al = 'http://x/a.png', bl = 'http://x/b.png';
const A1 = { url: al }, B1 = { url: bl };
const D = o => img.matchupDecision({ al, bl, askedA: true, askedB: true, current: true, posterUsed: false, ...o });
let d = D({ A: A1, B: B1 });
t(d.kind === 'full' && d.cacheControl === img.CACHE_CONTROL.FULL && d.remember, 'both first-choice crests: a day, remembered');
d = D({ A: { url: 'http://x/a2.png' }, B: B1 });
t(d.kind === 'second-choice' && d.cacheControl === 'public, max-age=900' && !d.remember, 'a second-choice crest: briefly, not remembered');
d = D({ A: null, B: B1 });
t(d.kind === 'one-sided' && d.cacheControl === 'no-store' && !d.remember, 'a crest that missed: no-store');
d = D({ A: null, B: B1, posterUsed: true });
t(d.kind === 'poster' && d.cacheControl === 'no-store', 'the provider poster standing in: no-store');
d = D({ A: null, B: null });
t(d.kind === 'name' && d.cacheControl === 'no-store', 'the name card: no-store');
d = D({ A: A1, B: B1, current: false });
t(d.kind === 'full' && d.cacheControl === 'public, max-age=3600' && !d.remember, 'an old URL a player kept: an hour, not remembered');
d = D({ A: A1, B: null, askedB: false, bl: undefined });
t(d.kind === 'full' && d.remember, 'a side that never had a crest is not a fallback');
d = D({ A: A1, B: B1, stale: true });
t(d.kind === 'stale' && d.cacheControl === 'public, max-age=900' && !d.remember, 'drawn from a crest being replaced: briefly, not remembered');
t(img.isStaleEntry({ expiresAt: 0 }) && !img.isStaleEntry({ expiresAt: Date.now() + 60000 }) && !img.isStaleEntry({}), 'stale means past its freshness, and a bundled mark never is');

console.log('--- the warmer covers what players load');
const part = warmer.urlsFrom([{
  poster: 'https://pub.example/img/matchup?a=1',
  background: 'https://pub.example/img/matchup?a=1&w=1280&h=720',
  logo: 'https://pub.example/img?url=x'
}]);
t(part.cards.length === 1 && part.cards[0].length === 2 && part.cards[0][1].includes('w=1280'), 'poster and wide background both');
t(part.cards[0].every(u => u.startsWith('http://127.0.0.1:')), 'over loopback');
t(part.logos.length === 1, 'corner logos kept');

console.log('--- one crest is one candidate');
const m = resolveMatchup({
  title: 'Miami Dolphins vs Las Vegas Raiders',
  category: 'american_football',
  team1: { name: 'Miami Dolphins', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/mia.png' },
  team2: { name: 'Las Vegas Raiders', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/lv.png' }
});
t(!!m && m.aLogos.length === 1 && m.bLogos.length === 1,
  'the /scoreboard/ copy of a crest is not a second candidate', m ? JSON.stringify([m.aLogos, m.bLogos]) : 'no matchup');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
