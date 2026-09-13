// What outlives a restart: the disk store, the finished cards and logos kept
// in it, and the catalog.
//
//   node tests/disk-cache.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-disk-'));
const DiskCache = require('../src/services/DiskCache');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('--- the store');
  const store = new DiskCache('things', { maxBytes: 10 * 1024, ttlMs: 60 * 60 * 1000 });
  t(false, store.has('a'), 'empty at first');
  store.put('a', { kind: 'test', n: 1 }, Buffer.from('hello'));
  await store.flush();
  t(true, store.has('a'), 'there once written');
  const got = store.get('a');
  t({ kind: 'test', n: 1 }, got.meta, 'the metadata comes back');
  t('hello', got.buffer.toString(), 'and the bytes');
  t(1, store.stats().entries, 'counted');
  store.put('a', { n: 2 }, Buffer.from('hello again'));
  await store.flush();
  t(1, store.stats().entries, 'a rewrite replaces, not adds');
  t('hello again', store.get('a').buffer.toString(), 'with the new bytes');
  store.delete('a');
  t(false, store.has('a'), 'gone when deleted');
  t(null, store.get('missing'), 'nothing for a key never written');

  console.log('--- what is past its time, or broken');
  store.put('old', {}, Buffer.from('x'));
  await store.flush();
  const file = store._file('old');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(file, past, past);
  t(false, store.has('old'), 'an entry past its time is not there');
  t(null, store.get('old'), 'and reading it removes it');
  t(false, fs.existsSync(file), 'from the disk too');
  fs.writeFileSync(store._file('bad'), Buffer.from('not a header at all'));
  t(null, store.get('bad'), 'a file with no header reads as nothing');
  fs.writeFileSync(store._file('junk'), Buffer.from('{not json\nbytes'));
  t(null, store.get('junk'), 'so does one whose header is not JSON');

  console.log('--- the cap');
  for (let i = 0; i < 20; i++) { store.put(`big${i}`, {}, Buffer.alloc(1024, 65)); await sleep(2); await store.flush(); }
  store.prune();
  t(true, store.stats().bytes <= 10 * 1024, `held under the cap (${store.stats().bytes} bytes)`);
  t(true, store.has('big19') && !store.has('big0'), 'the oldest went first');

  console.log('--- clearing, wholly or by header');
  store.put('keep', { v: 'now' }, Buffer.from('k'));
  store.put('drop', { v: 'then' }, Buffer.from('d'));
  await store.flush();
  store.clear(meta => meta.v === 'now');
  t([true, false], [store.has('keep'), store.has('drop')], 'only the files the header vouches for stay');
  store.clear();
  t(0, store.stats().entries, 'nothing after a full clear');

  console.log('--- a start with files already there');
  store.put('again', { v: 1 }, Buffer.from('persisted'));
  await store.flush();
  const second = new DiskCache('things', { maxBytes: 10 * 1024, ttlMs: 60 * 60 * 1000 });
  t(1, second.stats().entries, 'a new instance counts what is there');
  t('persisted', second.get('again').buffer.toString(), 'and reads it');

  console.log('--- a directory that cannot be made');
  // A file where the directory would have to go: mkdir fails for every user,
  // root included, which a mode bit would not (the container runs as root).
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'nope'), '');
  const ro = new DiskCache('ro', { dir: path.join(process.env.DATA_DIR, 'nope', 'ro') });
  ro.put('x', {}, Buffer.from('x'));
  await ro.flush();
  t(false, ro.has('x'), 'costs the memory across restarts and nothing else');
  t(false, ro.stats().enabled, 'and says so');

  console.log('--- a clear during a write');
  const racy = new DiskCache('racy', { maxBytes: 10 * 1024 });
  racy.put('w', {}, Buffer.alloc(4096, 66));
  racy.clear();
  await racy.flush();
  t(true, racy.stats().enabled, 'the store stays in use');
  racy.put('after', {}, Buffer.from('after'));
  await racy.flush();
  t('after', racy.get('after').buffer.toString(), 'and still takes writes');

  console.log('--- the finished cards, across a restart');
  const img = require('../src/services/ImageService');
  const key = `/img/event?text=Test%20Channel&color=64748b&v=${img.artVersion()}`;
  const req = { query: { text: 'Test Channel', color: '64748b', v: img.artVersion() }, originalUrl: key };
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; } });
  const drawn = res();
  await img.sendCard(req, drawn, img.svgEvent('Test Channel', null, '64748b', { cover: true }), img.CACHE_CONTROL.FULL, { remember: true });
  t('image/jpeg', drawn.headers['Content-Type'], 'a card was drawn');
  await img._disk.cards.flush();
  t(true, img.hasFreshCard(key), 'and kept');
  img._forgetMemory();
  t(true, img.hasFreshCard(key), 'still there after a restart forgets memory');
  const again = res();
  t(true, img.sendCachedCard(req, again), 'served from the disk');
  t(true, Buffer.isBuffer(again.body) && again.body.equals(drawn.body), 'byte for byte the card that was drawn');
  t(img.CACHE_CONTROL.FULL, again.headers['Cache-Control'], 'with the cache-control it was kept under');
  img._disk.cards.put('/img/event?text=Old&v=0.old', { cacheControl: img.CACHE_CONTROL.FULL, v: '0.old' }, Buffer.from('old'));
  await img._disk.cards.flush();
  img.pruneOldCards();
  t([true, false], [img.hasFreshCard(key), img._disk.cards.has('/img/event?text=Old&v=0.old')], 'a card of an earlier generation goes, the current one stays');

  console.log('--- the catalog, across a restart');
  const CacheService = require('../src/services/CacheService');
  const first = new CacheService();
  t(false, first.loadedFromDisk, 'nothing saved on a first run');
  first.setMatches([{ id: 'a', title: 'A', sources: [{ source: 'x', id: '1' }] }, { id: 'b', title: 'B', sources: [] }]);
  first.flush();
  const second2 = new CacheService();
  t(true, second2.loadedFromDisk, 'the next run reads it');
  t(['a', 'b'], second2.getMatches().map(m => m.id), 'the same events');
  t(false, second2.isStale(10 * 60 * 1000), 'and it is fresh');
  t(first.lastFetchTime, second2.lastFetchTime, 'stamped with the time it was saved, not the time it was read');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'catalog.json'), '{broken');
  const third = new CacheService();
  t(false, third.loadedFromDisk, 'a broken file is ignored');
  t([], third.getMatches(), 'and the catalog starts empty');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
