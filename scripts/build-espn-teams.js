#!/usr/bin/env node
/**
 * Regenerates src/services/data/espn-teams.json from ESPN's public team lists.
 *
 *   node scripts/build-espn-teams.js
 *
 * Run this when schools rebrand, teams relocate, or a league is added. It is a
 * build step rather than a boot-time fetch on purpose: site.api.espn.com 403s
 * from some egress IPs, and catalog artwork must not depend on that.
 *
 * Output shape:  { "<league>": { "<normalized key>": "<logo url>" } }
 * Keys prefixed with "~" are de-spaced variants ("~ottawaredblacks"), which
 * absorb spelling splits between the scrape providers and ESPN.
 *
 * Keys that would resolve to more than one team inside the same league are
 * dropped — an ambiguous key is exactly the kind that produces a confidently
 * wrong crest.
 */

const fs = require('fs');
const path = require('path');

// site.web.api is used rather than site.api: the latter is Akamai-gated and
// returns 403 to non-browser clients from many networks.
const HOST = 'https://site.web.api.espn.com/apis/site/v2/sports';

// league id (as event uids carry it) -> that league's crest
const LEAGUE_LOGOS = {};

// crest key ("ncaa/50") -> the name ESPN calls that team. Cards display this
// instead of whatever a provider wrote, so one club is spelled one way across
// the whole catalog.
const TEAM_NAMES = {};

// Which competitions each crest turns up in, keyed by crest rather than by name.
// A card already knows the crest it resolved for each side, so a crest is the
// one identifier that needs no disambiguation to look a competition up by.
const CREST_COMPS = {};

// Where each competition sits in the order it was listed. The lists are written
// most-prominent first, so this doubles as a priority: when two clubs answer to
// one name, the one from the more prominent competition is the one a viewer
// almost certainly means.
const COMP_RANK = new Map();
function rankOfComp(comp) {
  if (!COMP_RANK.has(comp)) COMP_RANK.set(comp, COMP_RANK.size);
  return COMP_RANK.get(comp);
}

// Each competition's own badge, keyed by the slug above rather than by the
// numeric id an event uid carries. LEAGUE_LOGOS keys by that id for the
// per-game path; this is for the path that works the league out from the crests.
const COMP_CRESTS = {};

function crestKey(url) {
  const s = String(url || '');
  // ESPN files most crests as teamlogos/<league>/500/<id>.png, but rugby adds a
  // "teams" segment and the CFL's badges come from TheSportsDB entirely. A key
  // that only matched the first shape left rugby and the CFL out of every index
  // built from it.
  const m = /\/teamlogos\/([^/]+)\/(?:teams\/)?\d+(?:\/scoreboard)?\/([^/?#]+?)\.(?:png|svg|jpg)/i.exec(s);
  if (m) return `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  const other = /\/([^/?#]+)\.(?:png|svg|jpg)(?:[?#]|$)/i.exec(s);
  return other ? other[1].toLowerCase() : '';
}

const LEAGUES = {
  'nfl': 'football/nfl',
  'cfl': 'football/cfl',
  'college-football': 'football/college-football',
  'nba': 'basketball/nba',
  'wnba': 'basketball/wnba',
  'mens-college-basketball': 'basketball/mens-college-basketball',
  'mlb': 'baseball/mlb',
  'nhl': 'hockey/nhl',
  'mens-college-hockey': 'hockey/mens-college-hockey',
  'womens-college-hockey': 'hockey/womens-college-hockey',
  'afl': 'australian-football/afl',
  // Rugby is split across league ids rather than named slugs. Every competition
  // ESPN publishes is fetched: the five we started with covered the English
  // top flight, France, the European cup, World Cup nations and the NRL, which
  // left Bristol, Canada and the USA with no crest anywhere.
  'rugby-prem': 'rugby/267979',
  'rugby-top14': 'rugby/270559',
  'rugby-champions': 'rugby/271937',
  'rugby-challenge': 'rugby/272073',
  'rugby-urc': 'rugby/270557',
  'rugby-super': 'rugby/242041',
  'rugby-super-aotearoa': 'rugby/289271',
  'rugby-super-au': 'rugby/289272',
  'rugby-super-tt': 'rugby/289277',
  'rugby-six-nations': 'rugby/180659',
  'rugby-championship': 'rugby/244293',
  'rugby-international': 'rugby/164205',
  'rugby-test': 'rugby/289234',
  'rugby-nations': 'rugby/17567',
  'rugby-lions': 'rugby/268565',
  'rugby-tri-nations': 'rugby/289274',
  'rugby-mlr': 'rugby/289262',
  'rugby-currie': 'rugby/270555',
  'rugby-npc': 'rugby/270563',
  'rugby-urba': 'rugby/2009',
  'rugby-urba-14': 'rugby/289279',
  'rugby-anglo-welsh': 'rugby/236461',
  'rugby-wwc': 'rugby/289237',
  'rugby-league': 'rugby/3'
};

// Soccer is fetched per competition but collapsed into ONE bucket. A club that
// plays in both its domestic league and a continental cup returns the same logo
// URL from each, so the ambiguity check does not drop it - and a single map
// keeps lookups O(1) instead of scanning 70 league tables.
const SOCCER = [
  'eng.1','eng.2','eng.3','eng.4','esp.1','esp.2','ita.1','ita.2','ger.1','ger.2',
  'fra.1','fra.2','ned.1','por.1','sco.1','bel.1','tur.1','gre.1','rus.1','ukr.1',
  'aut.1','sui.1','den.1','swe.1','nor.1','pol.1','cze.1','rou.1','cro.1','srb.1',
  'usa.1','usa.2','mex.1','bra.1','bra.2','arg.1','chi.1','col.1','uru.1','per.1',
  'ecu.1','par.1','ven.1','bol.1','crc.1','jpn.1','kor.1','chn.1','aus.1','ksa.1',
  'uae.1','qat.1','ind.1','rsa.1','egy.1','mar.1',
  'uefa.champions','uefa.europa','uefa.europa.conf','uefa.super_cup',
  'conmebol.libertadores','conmebol.sudamericana','concacaf.champions',
  'afc.champions','caf.champions','club.friendly',
  'fifa.world','fifa.friendly','fifa.worldq.uefa','fifa.worldq.conmebol',
  'fifa.worldq.afc','fifa.worldq.concacaf','fifa.worldq.caf',
  'uefa.euro','uefa.euroq','uefa.nations','conmebol.america','concacaf.gold',
  'afc.asian','caf.nations','uefa.euro_u21','fifa.world.u20','fifa.world.u17'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/'
};

function normalize(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}


/**
 * CFL crests, which ESPN simply does not have — every team in its CFL feed
 * reports an empty logos array, and .../teamlogos/cfl/500/<id>.png 404s for all
 * of them. Without these the league's nine clubs resolve nothing at all.
 *
 * Badges come from TheSportsDB, verified as 500-512px RGBA PNGs. They are
 * written into the table like any other crest so nothing downstream has to know
 * they came from somewhere else.
 */
const CFL_BADGES = {
  'BC Lions': 'https://r2.thesportsdb.com/images/media/team/badge/ysxssy1424732039.png',
  'Calgary Stampeders': 'https://r2.thesportsdb.com/images/media/team/badge/lksemj1565196917.png',
  'Edmonton Elks': 'https://r2.thesportsdb.com/images/media/team/badge/ehy8wx1770834697.png',
  'Hamilton Tiger-Cats': 'https://r2.thesportsdb.com/images/media/team/badge/qtwsuq1424727420.png',
  'Montreal Alouettes': 'https://r2.thesportsdb.com/images/media/team/badge/8m9v4n1770835125.png',
  'Ottawa Redblacks': 'https://r2.thesportsdb.com/images/media/team/badge/k8wjz71546002654.png',
  'Saskatchewan Roughriders': 'https://r2.thesportsdb.com/images/media/team/badge/xrdull1630952245.png',
  'Toronto Argonauts': 'https://r2.thesportsdb.com/images/media/team/badge/5a57ou1628555372.png',
  'Winnipeg Blue Bombers': 'https://r2.thesportsdb.com/images/media/team/badge/4bo4wj1561667273.png'
};

async function fetchLeague(slug, apiPath) {
  const url = `${HOST}/${apiPath}/teams?limit=1000`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const json = await res.json();
  const league = json?.sports?.[0]?.leagues?.[0];
  const teams = league?.teams;
  if (!Array.isArray(teams)) throw new Error(`${slug}: unexpected response shape`);
  return teams.map(t => t.team).filter(Boolean);
}

function logoFor(team, slug) {
  if (Array.isArray(team.logos) && team.logos.length) {
    const light = team.logos.find(l => !(l.rel || []).includes('dark')) || team.logos[0];
    if (light && light.href) return light.href.replace(/^http:/, 'https:');
  }
  // No published logo means no logo. Constructing one from the team id
  // produced 707 URLs that 404 (every CFL side, 527 college-football, 132
  // college-hockey): ESPN keeps crests under per-league paths that don't
  // exist for these teams, and a dead URL costs a fetch on every card before
  // falling back to a name plate anyway.
  return null;
}

// Club-type affixes carry no identity: "Seattle Sounders FC" and "Seattle
// Sounders" are the same club, as are "FC Cincinnati" and "Cincinnati".
// Kept in sync with stripAffix() in src/services/TeamLogoService.js.
const AFFIX = /^(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if)\s+|\s+(fc|sc|cf|afc|ac|as|sv|cd|ud|fk|sk|nk|bk|if|ii)$|\s+rugby$/;

function stripAffix(k) {
  let prev;
  let cur = k;
  while (cur !== prev) { prev = cur; cur = cur.replace(AFFIX, '').trim(); }
  return cur;
}

/** The key shapes keysFor() would produce for a plain "City Nickname" string. */
function keysForName(name) {
  const keys = new Set();
  const k = normalize(name);
  if (k.length >= 2) keys.add(k);
  const parts = k.split(' ');
  if (parts.length > 1) {
    keys.add(parts[parts.length - 1]);            // bare nickname, e.g. "argonauts"
    keys.add(parts.slice(0, -1).join(' '));       // bare city, e.g. "toronto"
  }
  for (const key of [...keys]) {
    const squashed = key.replace(/ /g, '');
    if (squashed !== key && squashed.length >= 6) keys.add('~' + squashed);
  }
  return keys;
}

function keysFor(team) {
  const keys = new Set();
  for (const field of [team.displayName, team.shortDisplayName, team.name, team.nickname, team.location, team.abbreviation]) {
    const k = normalize(field);
    if (k.length >= 2) keys.add(k);
  }
  // "Location Nickname" recombination covers "penn state nittany lions" when
  // ESPN only stores the halves separately.
  const loc = normalize(team.location);
  const nick = normalize(team.name);
  if (loc && nick && loc !== nick) keys.add(`${loc} ${nick}`);

  // The same recombination from the other pair of fields. ESPN's AFL records
  // carry location: null and split the club from its nickname across `name`
  // ("Fremantle") and `nickname` ("Dockers"), so the "Fremantle Dockers" every
  // provider writes had no key at all — 11 of 18 clubs resolved nothing.
  const short = normalize(team.name);
  const tag = normalize(team.nickname);
  if (short && tag && short !== tag) keys.add(`${short} ${tag}`);

  for (const k of [...keys]) {
    const stripped = stripAffix(k);
    if (stripped && stripped !== k && stripped.length >= 4) keys.add(stripped);
  }
  for (const k of [...keys]) {
    const squashed = k.replace(/ /g, '');
    if (squashed !== k && squashed.length >= 6) keys.add('~' + squashed);
  }
  return keys;
}

/**
 * Accumulate teams into `candidates` (key -> { ids, logo }).
 *
 * Ambiguity is judged by ESPN team id, NOT by logo URL. The same club listed
 * under its domestic league and a continental cup can return its logos array in
 * a different order, and comparing URLs would call that a name collision and
 * drop a perfectly good key.
 */
function addTeams(candidates, teams, slug, comp) {
  // `slug` picks the crest-naming rules and the output bucket; `comp` names the
  // actual competition when one bucket holds many, as soccer's does.
  const competition = comp || slug;
  for (const team of teams) {
    const logo = logoFor(team, slug);
    const ck = crestKey(logo);
    // First league to name a crest wins; the same club reached through a
    // continental cup carries the same name anyway.
    if (ck && team.displayName && !TEAM_NAMES[ck]) TEAM_NAMES[ck] = String(team.displayName).trim();
    // A team with no published logo still takes part in the ambiguity check
    // below, it just can't be the answer. Skipping it outright would let a key
    // two clubs answer to resolve to whichever of them happens to have a crest
    // — silently un-dropping keys the builder had always refused ("hurricanes",
    // "jayhawks", "raiders"), which is exactly the confident-wrong-crest
    // outcome the matcher exists to avoid.
    const id = String(team.id);
    const canonical = normalize(team.displayName);
    if (ck) {
      const comps = CREST_COMPS[ck] || (CREST_COMPS[ck] = []);
      if (!comps.includes(competition)) comps.push(competition);
    }
    for (const k of keysFor(team)) {
      if (!candidates.has(k)) {
        candidates.set(k, { ids: new Set(), logos: new Set(), logo: null, primaries: new Set(), primaryLogo: null, ranked: [] });
      }
      const entry = candidates.get(k);
      entry.ids.add(id);
      if (logo) entry.ranked.push({ logo, rank: rankOfComp(competition) });
      // Logo-less teams get a unique sentinel so they count as a distinct
      // crest for ambiguity, never as a usable one.
      entry.logos.add(logo || `none:${id}`);
      if (logo && !entry.logo) entry.logo = logo;
      // A key that IS this team's canonical display name outranks the same key
      // reached via someone else's location. Without this, "South Korea U17"
      // (location "South Korea") makes the senior side's key ambiguous.
      if (k === canonical) {
        entry.primaries.add(id);
        if (logo && !entry.primaryLogo) entry.primaryLogo = logo;
      }
    }
  }
}

/** Collapse to key -> url, dropping any key that two different teams answer to. */
function finish(candidates) {
  const map = {};
  let dropped = 0;
  for (const k of [...candidates.keys()].sort()) {
    const entry = candidates.get(k);
    // Keep the key when every candidate is the same team, or when they all
    // render the same crest anyway (ESPN duplicates some clubs across
    // competitions under different ids). Either way the outcome is unambiguous.
    // `logo` is null when every candidate for this key lacked a published
    // crest: unambiguous, but nothing to show, so it isn't an entry.
    if (entry.ids.size === 1 || entry.logos.size === 1) {
      if (entry.logo) map[k] = entry.logo; else dropped++;
    } else if (entry.primaries.size === 1 && entry.primaryLogo) {
      map[k] = entry.primaryLogo;
    } else {
      // Two clubs really do answer to this name. Rather than leave the name
      // with no crest at all, give it the one from the most prominent
      // competition that claims it -- "arsenal" is the Premier League club, not
      // Arsenal Sarandi. Only a tie at the top is still undecidable.
      const best = entry.ranked.reduce((r, c) => (!r || c.rank < r.rank ? c : r), null);
      const tied = best ? new Set(entry.ranked.filter(c => c.rank === best.rank).map(c => c.logo)) : null;
      if (tied && tied.size === 1) map[k] = best.logo; else dropped++;
    }
  }
  return { map, dropped };
}

/**
 * League crests, keyed by the league id that event uids carry.
 *
 * Only the scoreboard response states a league's crest — the teams response
 * carries the id but no logos — and the crest URL itself uses a different id
 * again (the Premier League is 700 in a uid and 23 in its logo path), so the
 * pairing can only be read off a response that states both. One extra request
 * per competition, at build time, which is where this belongs.
 */
async function fetchLeagueCrest(apiPath) {
  const res = await fetch(`${HOST}/${apiPath}/scoreboard`, { headers: HEADERS });
  if (!res.ok) return null;
  const json = await res.json();
  const league = (json?.leagues || [])[0];
  if (!league || !league.id) return null;
  const logo = (league.logos || []).map(l => l.href).find(Boolean);
  return logo ? { id: String(league.id), logo: logo.replace(/^http:/, 'https:') } : null;
}

async function buildLeagueCrests(paths) {
  let ok = 0;
  for (const [slug, apiPath] of paths) {
    try {
      const crest = await fetchLeagueCrest(apiPath);
      if (crest) { LEAGUE_LOGOS[crest.id] = crest.logo; COMP_CRESTS[slug] = crest.logo; ok++; }
    } catch {
      // A competition without a crest costs that league's badge, nothing else.
    }
  }
  return ok;
}

async function main() {
  const out = {};
  let grandTotal = 0;

  for (const [slug, apiPath] of Object.entries(LEAGUES)) {
    process.stdout.write(`fetching ${slug} ... `);
    const teams = await fetchLeague(slug, apiPath);
    const candidates = new Map();
    addTeams(candidates, teams, slug);
    const { map, dropped } = finish(candidates);
    if (slug === 'cfl') {
      // ESPN publishes no CFL crests, so these come from TheSportsDB and are
      // grafted on after the fact -- which means they also have to be recorded
      // as belonging to the CFL by hand, since addTeams never saw them.
      for (const [name, logo] of Object.entries(CFL_BADGES)) {
        for (const k of keysForName(name)) if (!map[k]) map[k] = logo;
        const ck = crestKey(logo);
        if (ck && !(CREST_COMPS[ck] || []).includes('cfl')) (CREST_COMPS[ck] = CREST_COMPS[ck] || []).push('cfl');
      }
    }
    out[slug] = map;
    grandTotal += Object.keys(map).length;
    console.log(`${teams.length} teams, ${Object.keys(map).length} keys, ${dropped} ambiguous dropped`);
  }

  console.log(`\nfetching soccer (${SOCCER.length} competitions)...`);
  const soccer = new Map();
  const skipped = [];
  let ok = 0;
  for (const comp of SOCCER) {
    try {
      const teams = await fetchLeague(comp, `soccer/${comp}`);
      if (!teams.length) { skipped.push(comp); continue; }
      addTeams(soccer, teams, 'soccer', comp);
      ok++;
      console.log(`  ${comp.padEnd(26)} ${teams.length}`);
    } catch {
      // Competitions come and go (and some slugs are seasonal). A missing one
      // costs coverage, never correctness, so keep going.
      skipped.push(comp);
    }
  }
  const s = finish(soccer);
  out.soccer = s.map;
  grandTotal += Object.keys(s.map).length;
  console.log(`\n  soccer: ${ok} competitions ok, ${Object.keys(s.map).length} keys, ${s.dropped} ambiguous dropped`);
  if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`);

  const dest = path.join(__dirname, '..', 'src', 'services', 'data', 'espn-teams.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`\nwrote ${path.relative(process.cwd(), dest)} — ${grandTotal} keys, ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);

  // League crests, collected from the same responses the teams came from.
  process.stdout.write('\nfetching league crests ... ');
  const crestPaths = [
    ...Object.entries(LEAGUES),
    ...SOCCER.map(comp => [comp, `soccer/${comp}`])
  ];
  const crestCount = await buildLeagueCrests(crestPaths);
  console.log(`${crestCount}/${crestPaths.length} leagues`);

  const namesDest = path.join(path.dirname(dest), 'espn-team-names.json');
  fs.writeFileSync(namesDest, JSON.stringify(TEAM_NAMES));
  console.log(`wrote ${path.relative(process.cwd(), namesDest)} — ${Object.keys(TEAM_NAMES).length} canonical names`);

  const leagueDest = path.join(path.dirname(dest), 'espn-leagues.json');
  fs.writeFileSync(leagueDest, JSON.stringify(LEAGUE_LOGOS));
  console.log(`wrote ${path.relative(process.cwd(), leagueDest)} — ${Object.keys(LEAGUE_LOGOS).length} league crests`);

  const compDest = path.join(path.dirname(dest), 'espn-crest-competitions.json');
  fs.writeFileSync(compDest, JSON.stringify({ crests: CREST_COMPS, competitions: COMP_CRESTS }));
  console.log(`wrote ${path.relative(process.cwd(), compDest)} — ${Object.keys(CREST_COMPS).length} crests across ${Object.keys(COMP_CRESTS).length} competitions`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
