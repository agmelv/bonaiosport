#!/usr/bin/env node
/**
 * Regenerates src/services/data/us-stations.json: where each US network
 * affiliate that iptv-org files under ABC, CBS, NBC, Fox, CW and MNT is.
 *
 *   node scripts/build-us-stations.js
 *
 * A network tile carries dozens of local stations' streams, and a Los Angeles
 * FOX is not a New York FOX. iptv-org knows each station's city, but only in
 * feeds.json and cities.json -- 14 MB between them -- which the provider does
 * not download and should not parse on every sync. This keeps the few hundred
 * entries that matter, keyed "<channel>/<feed>": ["City, ST", "CALL"].
 *
 * A build step, like scripts/build-espn-teams.js: run it now and then to pick
 * up stations iptv-org adds. Stations missing from it fall back to the city or
 * call sign in the stream's own title.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://iptv-org.github.io/api';
const CHANNELS = new Set(['ABC.us', 'CBS.us', 'NBC.us', 'Fox.us', 'CW.us', 'MNT.us', 'Galavision.us', 'Telemundo.us']);

const getJson = async (file) => {
  const res = await fetch(`${API}/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
};

async function main() {
  const [feeds, cities] = await Promise.all([getJson('feeds.json'), getJson('cities.json')]);
  const cityByCode = new Map(cities.map(c => [c.code, c]));
  const out = {};
  let withCity = 0;
  for (const f of feeds) {
    if (!CHANNELS.has(f.channel)) continue;
    const area = (f.broadcast_area || []).find(a => String(a).startsWith('ct/'));
    let city = '';
    const c = area ? cityByCode.get(String(area).slice(3)) : null;
    if (c) {
      const state = String(c.subdivision || '').split('-')[1] || '';
      const name = c.name === 'New York City' ? 'New York' : c.name;
      city = state ? `${name}, ${state}` : name;
    }
    const call = String(f.name || '').toUpperCase().replace(/-(TV|DT|CD|LD|LP)\d*$/, '');
    const callSign = /^[KW][A-Z]{2,3}$/.test(call) ? call : '';
    if (!city && !callSign) continue;
    if (city) withCity++;
    out[`${f.channel}/${f.id}`] = callSign ? [city, callSign] : [city];
  }
  const dest = path.join(__dirname, '..', 'src', 'services', 'data', 'us-stations.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`wrote ${path.relative(process.cwd(), dest)} — ${Object.keys(out).length} stations, ${withCity} with a city, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
