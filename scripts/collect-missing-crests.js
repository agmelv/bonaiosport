#!/usr/bin/env node
/**
 * Which sides currently show a name plate instead of a crest.
 *
 * Runs the real resolver over the live catalog and records every side whose
 * candidates all fail to fetch -- which is the honest test, since a candidate
 * URL that 404s looks identical to no candidate at all on the card.
 *
 * Writes scripts/missing-crests.json for build-extra-crests.js to work through.
 */

const fs = require('fs');
const path = require('path');
const container = require('../src/container');
const teamLogos = require('../src/services/TeamLogoService');
const imageService = require('../src/services/ImageService');

const LIMIT = 16;
async function pool(items, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: LIMIT }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function main() {
  await container.resolve('matchAggregator').syncMatches();
  const all = container.resolve('cacheService').getMatches();

  const sides = [];
  for (const m of all) {
    if (!m.date) continue;
    const r = teamLogos.resolveMatchup(m);
    if (!r) continue;
    sides.push({ name: r.a, cands: r.aLogos || [], category: m.category });
    sides.push({ name: r.b, cands: r.bLogos || [], category: m.category });
  }

  const checked = await pool(sides, async s => {
    for (const u of s.cands) {
      try { if (await imageService.getImage(u)) return null; } catch { /* next */ }
    }
    return s;
  });

  // Events rather than clubs -- a grand prix or a fight has no crest to find.
  const SKIP = new Set(['motorsport', 'mma', 'darts', 'golf', 'other']);
  const seen = new Map();
  for (const s of checked) {
    if (!s || SKIP.has(s.category)) continue;
    const key = `${s.category}|${s.name}`;
    if (!seen.has(key)) seen.set(key, { name: s.name, category: s.category });
  }

  const list = [...seen.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const dest = path.join(__dirname, 'missing-crests.json');
  fs.writeFileSync(dest, JSON.stringify(list, null, 2));

  const byCat = {};
  for (const x of list) byCat[x.category] = (byCat[x.category] || 0) + 1;
  console.log(`${sides.length} sides checked, ${list.length} without a crest`);
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`   ${c.padEnd(20)} ${n}`);
  console.log(`wrote ${path.relative(process.cwd(), dest)}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
