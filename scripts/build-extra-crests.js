#!/usr/bin/env node
/**
 * Crests for the clubs ESPN does not carry.
 *
 * ESPN's tables stop somewhere around each country's second tier and miss whole
 * competitions -- Portugal's LigaPro, Germany's 3. Liga, the Ekstraklasa, the
 * women's leagues, rugby's Super League. It also spells a good few clubs
 * differently from the feeds ("Dijon FCO" against "Dijon"). Both leave a card
 * with a name plate where a crest belongs.
 *
 * TheSportsDB covers those, and already supplies this project's CFL badges. So
 * this asks it for the sides that failed to resolve, and writes what comes back
 * to src/services/data/extra-crests.json for TeamLogoService to consult after
 * ESPN has had its turn.
 *
 * The guards are the point. Asked for "Leeds Rhinos" it offers a netball team
 * of that name; asked for "Hamburger SV W" it offers the men's Hamburg. Either
 * would put a confidently wrong crest on a card, which is worse than the name
 * plate it replaced. So a candidate must agree on the sport, must not cross
 * between a women's team and a men's one or a reserve side and a first team,
 * and must actually resemble the name asked for.
 *
 *   node scripts/build-extra-crests.js            # resolve what is missing now
 *   node scripts/build-extra-crests.js --dry      # report, write nothing
 */

const fs = require('fs');
const path = require('path');

const API = 'https://www.thesportsdb.com/api/v1/json/3';
const DEST = path.join(__dirname, '..', 'src', 'services', 'data', 'extra-crests.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; live-sports-plugin)' };

// Gentle: this is a free endpoint that rate-limits, and there is no hurry.
// 700 ms was not gentle enough -- it answered 28 names and then returned 429 for
// every one after. Backing off and retrying matters more than the gap, since the
// limit is a budget over time rather than a rate.
const GAP_MS = Number(process.env.CREST_GAP_MS) || 1500;
const RETRIES = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Our category names against theirs. A category not listed is not looked up. */
const SPORT_FOR = {
  football: 'Soccer',
  rugby: 'Rugby',
  american_football: 'American Football',
  college: 'American Football',
  basketball: 'Basketball',
  hockey: 'Ice Hockey',
  baseball: 'Baseball',
  cricket: 'Cricket'
};

// Letters that are not a base letter plus an accent, so NFD leaves them alone
// and stripping diacritics never reaches them. Without these, "Grossaspach"
// never matches "Großaspach" and "Slask Wroclaw" never matches "Śląsk Wrocław"
// -- both rejected on a first run for looking like different clubs.
const LETTERS = { 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'þ': 'th', 'ı': 'i', 'ŋ': 'n' };

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[ßłđðøæœþıŋ]/g, c => LETTERS[c] || c)
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Words that mark a side as distinct from the club of the same name. A women's
// team and the men's first team share a name and share nothing else.
const WOMEN = /\b(w|women|womens|ladies|fem|femenino|feminino|feminine|frauen)\b/;
const RESERVE = /\b(b|ii|2|reserves|u\d{2})\b/;

/** Strip the club-type noise both sides add in different amounts. */
const AFFIX = /\b(fc|afc|cf|sc|ac|as|ss|ssc|cd|ud|rc|sv|tsv|vfb|vfl|fsv|bsc|if|ik|fk|nk|sk|bk|gks|ks|mks|rks|calcio|club|clube|deportivo|atletico|athletic|united|city|town|rugby|league)\b/g;
const bare = s => norm(s).replace(AFFIX, ' ').replace(/\s+/g, ' ').trim();

/**
 * Is this candidate plausibly the side we asked for?
 *
 * Deliberately strict. A wrong crest asserted confidently is worse than no
 * crest, because nothing downstream can tell it is wrong.
 */
function acceptable(query, cand, wantSport) {
  if (!cand || !cand.strBadge) return false;
  if (String(cand.strSport || '') !== wantSport) return false;

  const q = norm(query);
  const names = [cand.strTeam, cand.strTeamAlternate, cand.strTeamShort]
    .filter(Boolean)
    .flatMap(n => String(n).split(',').map(x => x.trim()))
    .filter(Boolean);

  // A women's side must match a women's side, a reserve team a reserve team.
  const qWomen = WOMEN.test(q);
  const qReserve = RESERVE.test(q.replace(WOMEN, ' '));
  const anyWomen = names.some(n => WOMEN.test(norm(n))) || /women/i.test(cand.strLeague || '') || /women/i.test(cand.strGender || '');
  const anyReserve = names.some(n => RESERVE.test(norm(n).replace(WOMEN, ' ')));
  if (qWomen !== anyWomen) return false;
  if (qReserve !== anyReserve) return false;

  // And it must actually look like the name asked for.
  //
  // Compared as sets of words rather than as strings, because the two sides
  // disagree about which words to include, not about their order: "SG Sonnenhof
  // Grossaspach" against "Sonnenhof Großaspach", "Academico Viseu" against
  // "Académico de Viseu". A prefix test rejects both; a subset test does not.
  // One set must contain the other, and the smaller must carry at least one
  // word substantial enough to identify a club.
  const qt = new Set(bare(q).split(' ').filter(Boolean));
  if (!qt.size) return false;
  return names.some(n => {
    const nt = new Set(bare(n).split(' ').filter(Boolean));
    if (!nt.size) return false;
    const [small, large] = qt.size <= nt.size ? [qt, nt] : [nt, qt];
    for (const w of small) if (!large.has(w)) return false;
    return [...small].some(w => w.length >= 4);
  });
}

async function lookup(name) {
  let wait = 4000;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await fetch(`${API}/searchteams.php?t=${encodeURIComponent(name)}`, { headers: UA });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      return (json && json.teams) || [];
    }
    // 429 is the free tier saying "slower", not "no". Waiting is the whole fix.
    if (res.status !== 429 || attempt === RETRIES) throw new Error(`HTTP ${res.status}`);
    process.stdout.write(`  … rate limited, waiting ${wait / 1000}s\n`);
    await sleep(wait);
    wait *= 2;
  }
  return [];
}

async function main() {
  const dry = process.argv.includes('--dry');

  // The sides that need one. Written by tools/collect-missing-crests.js, or
  // hand-edited: [{ name, category }, ...]
  const inputPath = path.join(__dirname, 'missing-crests.json');
  if (!fs.existsSync(inputPath)) {
    console.error(`No ${path.relative(process.cwd(), inputPath)}. Generate it first.`);
    process.exit(1);
  }
  const wanted = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const out = fs.existsSync(DEST) ? JSON.parse(fs.readFileSync(DEST, 'utf8')) : {};
  let added = 0, refused = 0, missing = 0;

  for (const { name, category } of wanted) {
    const sport = SPORT_FOR[category];
    if (!sport) continue;
    out[category] = out[category] || {};
    if (out[category][norm(name)]) continue;           // already answered

    let cands = [];
    try {
      cands = await lookup(name);
    } catch (err) {
      // Left unanswered rather than recorded as absent, so a later run retries.
      console.log(`  ! ${name}: ${err.message}`);
      await sleep(GAP_MS * 3);
      continue;
    }

    const ok = cands.filter(c => acceptable(name, c, sport));
    if (ok.length === 1) {
      out[category][norm(name)] = ok[0].strBadge;
      added++;
      console.log(`  + ${name.padEnd(30)} ${ok[0].strTeam} (${ok[0].strLeague || '?'})`);
    } else if (ok.length > 1) {
      refused++;
      console.log(`  ? ${name.padEnd(30)} ${ok.length} equally good matches, declining`);
    } else if (cands.length) {
      refused++;
      const why = cands.slice(0, 2).map(c => `${c.strTeam} [${c.strSport}]`).join(', ');
      console.log(`  - ${name.padEnd(30)} rejected: ${why}`);
    } else {
      missing++;
      console.log(`  · ${name.padEnd(30)} not found`);
    }
    await sleep(GAP_MS);
  }

  console.log(`\n${added} crests added, ${refused} candidates refused, ${missing} not found`);
  if (dry) return console.log('(--dry: nothing written)');

  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, JSON.stringify(out));
  const total = Object.values(out).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`wrote ${path.relative(process.cwd(), DEST)} — ${total} crests`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
