// What a TotalSportek listing says, and what its player chain hands back.
//
// Two of these are regressions rather than features, and both cost time before
// they were understood. The listing's kickoff carries no zone marker and is
// nevertheless UTC, so a reader that trusts the host's own clock puts every
// fixture an hour or more out of place. And the player config escapes its
// ampersands, so a URL read up to the first one arrives without the signature
// that follows it and is refused with a 403 that looks exactly like a block.
//
// No network: the fixtures are trimmed copies of the real pages.
//
//   node tests/totalsportek.test.js
const fs = require('fs');
const path = require('path');

const tsk = require('../src/providers/TotalSportekProvider');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const LISTING = fixture('totalsportek-listing.html');
const GAME = fixture('totalsportek-game.html');
const BESTROPES = fixture('totalsportek-player-bestropes.html');
const ESPORTSURGE = fixture('totalsportek-player-esportsurge.html');
const CLAPPR = fixture('totalsportek-clappr.html');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

// Twenty past seven on the evening the fixtures were captured: the first game
// has kicked off, the second has not, and the basketball ended overnight. Not
// the second game's own kickoff instant, which is a live game by the same rule
// the rest of the addon uses and would say nothing about an upcoming one.
const NOW = Date.UTC(2026, 8, 15, 19, 20);

console.log('--- the listing, read as the site means it');
const cards = tsk._parseListing(LISTING, NOW);
t(2, cards.length, 'two of the three cards are still worth listing');
t('ipswich-town-vs-arsenal-4654633803', cards[0].slug, 'the whole slug is the source id, numeric tail and all');
t(['Ipswich Town', 'Arsenal'], cards[0].teams, 'both teams come off the card');
t('Ipswich Town vs Arsenal', cards[0].title, 'and read as one fixture');
t('fifatotalsportek.com', cards[0].host, 'the card says which host serves its game page');

console.log('--- the kickoff has no Z on it and is UTC anyway');
t(Date.UTC(2026, 8, 15, 19, 0), cards[0].kickoff, '19:00 on the listing is 19:00 UTC, as ESPN times the same fixture');
t(Date.UTC(2026, 8, 15, 19, 30), cards[1].kickoff, 'and 19:30 is 19:30 UTC');
t(Date.UTC(2026, 8, 15, 19, 0), tsk._kickoff('2026-09-15T19:00'), 'a bare wall clock is read as UTC');
t(Date.UTC(2026, 8, 15, 19, 0), tsk._kickoff('2026-09-15T19:00Z'), 'and one that says so already is unchanged');
t(null, tsk._kickoff(''), 'nothing at all is no kickoff');

console.log('--- a game that has finished is gone, a live one stays');
t([], cards.filter(c => c.slug.includes('nuggets')), 'the game that ended overnight is not listed');
t(true, cards[0].live, 'a card the site still flags as live is live');
t(false, cards[1].live, 'one that has not kicked off yet is not');
t(1, tsk._parseListing(LISTING, Date.UTC(2026, 8, 16, 12, 0)).length,
  'a day later only the card the site still flags as live survives');
t([], tsk._parseListing('', NOW), 'an empty listing is no fixtures, not an error');
t([], tsk._parseListing('<html><body><p>nothing here</p></body></html>', NOW), 'and neither is a page with no cards');

// Two hours after the basketball finished, which is the one moment the other
// readings step over: seventeen and thirty-four hours later the card is too old
// to list whatever it says, so its own "Ended" is never what rules it out. Here
// it is well inside the live window, and a card that is only aged out would be
// published as live and promoted for the couple of hours after every full time.
const AFTER_FULL_TIME = tsk._parseListing(LISTING, Date.UTC(2026, 8, 15, 4, 0));
t([], AFTER_FULL_TIME.filter(c => c.slug.includes('nuggets')),
  'a card the site marks Ended is gone two hours after kickoff, not live');
t(2, AFTER_FULL_TIME.length, 'and the two that have not been played are untouched by that');

// The other half of reading the status: only "Ended" is conclusive. A card that
// says merely "Upcoming" still has to become live off the clock, or a game the
// site has not got round to re-labelling never shows as being played.
const KICKED_OFF = tsk._parseListing(LISTING, Date.UTC(2026, 8, 15, 19, 45));
t(true, KICKED_OFF.find(c => c.slug.startsWith('elche')).live,
  'a card still labelled Upcoming is live once its kickoff has passed');

console.log('--- both mirrors come off the game page');
const players = tsk._playerUrls(GAME);
t(2, players.length, 'two mirrors, however many times the page repeats them');
t('https://bestropes.st/player.php/ipswich-town-vs-arsenal-england-league-cup-football', players[0], 'the first is whole');
t(['bestropes.st', 'esportsurge.st'], players.map(u => new URL(u).host), 'and they are two different hosts');
t([], tsk._playerUrls('<html><body>no player here</body></html>'), 'a page with no mirror on it yields none');

console.log('--- the two mirrors are not the same stream');
const best = tsk._serverData(BESTROPES);
const surge = tsk._serverData(ESPORTSURGE);
t('78', best.channelId, 'bestropes names its own channel');
t('4', surge.channelId, 'esportsurge names a different one');
t(true, best.channelId !== surge.channelId, 'so resolving only one of them would lose a genuinely separate stream');
t('England League Cup', best.league, 'the league the listing never said');
t('Football', best.sport, 'and the sport');
t('https://s2.kora.st', best.origin, 'the channel host is read from the page, not assumed');
t(null, tsk._serverData('const SERVER_DATA = {"u":"https://s2.kora.st/channel.php?id=78"'), 'a truncated blob is null, not a throw');
t(null, tsk._serverData('<html><body>no data</body></html>'), 'and so is a page without one');

console.log('--- the signed URL survives its own escaping');
const src = tsk._playerSrc(CLAPPR);
t(true, src.includes('sig='), 'the signature is still on it');
t(true, src.includes('e='), 'and the expiry');
t(false, src.includes('\\u0026'), 'no escape survives into the URL');
t(false, src.includes('&amp;'), 'and nothing is double-escaped on the way');
t('https://hls.hockey.do/secure_hls.php?path=6f2b9a1c4d7e%2Findex.m3u8&e=1789527689&sig=ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz&v=3',
  src, 'the whole URL, exactly as the player would have played it');
t(4, new URL(src).searchParams.size, 'four parameters, not the one a truncated read leaves');
t(1789527689000, tsk._expiresAt(src), 'and the row goes stale when the signature does');
t(null, tsk._playerSrc('<html><body>no config</body></html>'), 'a body with no config is null, not a throw');
t(null, tsk._playerSrc(''), 'and neither is an empty one an error');

(async () => {
  console.log('--- the fixtures, as the catalog receives them');
  const provider = new tsk({ circuitBreaker: { wrap: (name, fn) => ({ fire: fn }) } });

  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    provider.fetchListing = { fire: async () => LISTING };
    const matches = await provider.getMatches();
    t(2, matches.length, 'the finished game is left out of the catalog too');
    t('tsk_ipswich-town-vs-arsenal-4654633803', matches[0].id, 'the id is the slug, prefixed');
    t(String(Date.UTC(2026, 8, 15, 19, 0)), matches[0].date, 'carrying the UTC kickoff');
    t('live', matches[0].status, 'and the status the card gave');
    t([{ source: 'totalsportek', id: 'ipswich-town-vs-arsenal-4654633803' }], matches[0].sources,
      'with one source, named so the row stays identifiable after a merge');

    // Named sides, not bare strings. Everything that reads a fixture's teams
    // reads team1.name -- the crest resolver at TeamLogoService, the card, the
    // cast list, the aggregator's own crest identity -- so a string here is a
    // side with no name, and the pair of crests two providers are merged on
    // never forms. A provider whose fixtures will not merge is a second tile
    // for a game that already had one, which is the opposite of the point.
    t('object', typeof matches[0].team1, 'a side is an object the rest of the addon can read');
    t('Ipswich Town', matches[0].team1.name, 'with the name where the crest resolver looks for it');
    t('Arsenal', matches[0].team2.name, 'both of them');
    t(true, 'logo' in matches[0].team1, 'and a logo field, left for the crest table to answer by name');
    t('fifatotalsportek.com', provider.gameHost, 'the game host is learned from the listing rather than pinned');

    provider.fetchListing = { fire: async () => null };
    t([], await provider.getMatches(), 'a listing the breaker never got is no fixtures, not a throw');
  } finally {
    Date.now = realNow;
  }

  console.log('--- a sport is only claimed when the slug actually names one');
  t('basketball', provider._categoryFor('denver nuggets vs miami heat nba basketball'), 'a slug that names its league is filed under it');
  t('other', provider._categoryFor('elche vs real oviedo'), 'two club names name no sport, and must not invent one');
  t('other', provider._categoryFor(''), 'nothing at all is other');

  // Only the slug's trailing words are league; the rest is two club names, and
  // the category match is on substrings. A club read as a sport is worse than
  // no sport at all, because the aggregator will not merge two rows that
  // disagree about the category and the same fixture from another provider
  // stays beside this one with the streams divided between them.
  t('basketball', provider._categoryForSlug('denver-nuggets-vs-miami-heat-nba-basketball-4654630011'),
    'the league on the end of a slug is read, numeric id and all');
  t('other', provider._categoryForSlug('racing-club-vs-boca-juniors-4654633803'),
    'a club called Racing is not motor racing');
  t('other', provider._categoryForSlug('hammarby-vs-malmo-ff-4654633804'),
    'and the middle of Hammarby is not MMA');
  t('other', provider._categoryForSlug('elche-vs-real-oviedo-4654633812'), 'two club names still name no sport');
  t('other', provider._categoryForSlug(''), 'and no slug at all is other');

  // The case the rule above was written for and still got wrong: Racing at the
  // START of a slug was tested and passed, because the tail never reached it.
  // At the END it is the tail, and the fixture went out as motorsport -- which
  // is how one game ended up as two tiles on the live catalog, a motorsport one
  // and a football one, with the streams divided between them. A club's name is
  // not a sport wherever in the slug it happens to sit.
  t('other', provider._categoryForSlug('barcelona-vs-racing-de-santander-1575168414'),
    'a club called Racing is not motor racing at the end of a slug either');
  t('other', provider._categoryForSlug('real-madrid-vs-racing-club-9911'), 'nor in the middle of one');
  t('other', provider._categoryForSlug('sporting-lisbon-vs-athletic-bilbao-4321'),
    'and Sporting and Athletic name no sport between them');
  // The tails that really are competitions still answer, which is the half of
  // this that has to keep working.
  t('football', provider._categoryForSlug('ipswich-town-vs-arsenal-england-league-cup-football-4654633803'),
    'a tail that names the sport outright is still read');
  t('basketball', provider._categoryForSlug('lakers-vs-celtics-nba-4654630012'),
    'and a league acronym is enough on its own');

  console.log('--- one mirror going down does not take the other with it');
  // A breaker registry that memoizes by name the way the real service does,
  // with bestropes' breaker already open. An open breaker answers null through
  // its fallback instead of throwing, which is what a viewer meets while that
  // host is out. Were the breaker named once for the provider rather than once
  // per host, the two mirrors would share one failure record and that same null
  // would come back for esportsurge as well: a fixture with no streams on it at
  // all, for as long as the breaker stayed open, while the healthy mirror was
  // never asked.
  const asked = [];
  const breakers = new Map();
  const registry = {
    wrap(name, fn) {
      asked.push(name);
      if (!breakers.has(name)) {
        breakers.set(name, { fire: name.endsWith('bestropes.st') ? async () => null : fn });
      }
      return breakers.get(name);
    }
  };

  const mirrored = new tsk({ circuitBreaker: registry });
  mirrored.fetchGame = { fire: async () => GAME };
  mirrored.proxyFetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ url: 'https://play.matchli.st/player-model.php?code=3ebdb7752cdc281e' }),
    text: async () => (url.includes('esportsurge.st') ? ESPORTSURGE
      : url.includes('player-model') ? CLAPPR : '')
  });

  const rows = await mirrored.resolveStream('ipswich-town-vs-arsenal-4654633803');
  t(1, rows.length, 'the mirror that is up answers while the dead one is benched');
  t('TotalSportek Stream 2', rows[0].title, 'and it is the second mirror, resolved on a breaker of its own');
  t(['TotalSportek_player_bestropes.st', 'TotalSportek_player_esportsurge.st'],
    asked.filter(n => n.includes('_player_')).sort(),
    'each mirror host keeps its own failure record, so one outage benches one host');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
