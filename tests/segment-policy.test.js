// Which hosts' media the server relays, decided by trying one chunk.
//
//   node tests/segment-policy.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosports-policy-'));
delete process.env.PROXY_SEGMENT_HOSTS;
const policy = require('../src/segmentPolicy');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
// Stand-ins for the two clients -- what each answers, and how often it was
// asked -- and for the private-address check, which would otherwise look up
// these made-up hosts in DNS and refuse them all.
const clients = (plainStatus, browserStatus) => {
  const calls = { plain: 0, browser: 0 };
  return {
    calls,
    plain: async () => { calls.plain++; return plainStatus; },
    browser: async () => { calls.browser++; return browserStatus; },
    assertPublic: async (url) => { if (/^https?:\/\/(127\.|10\.|192\.168\.|localhost)/.test(url)) throw new Error('private address'); }
  };
};

(async () => {
  console.log('--- a host that refuses a player but not a browser');
  policy._reset();
  let c = clients(403, 200);
  t(true, await policy.shouldRelay('cdn.example-a.net', 'https://cdn.example-a.net/seg1.ts', 'https://embed.st/', 'https://embed.st', c), 'is relayed');
  t({ plain: 1, browser: 1 }, c.calls, 'after one try with each client');
  t(true, await policy.shouldRelay('cdn.example-a.net', 'https://cdn.example-a.net/seg2.ts', '', '', c), 'and the answer is remembered');
  t({ plain: 1, browser: 1 }, c.calls, 'without asking again');

  console.log('--- a host a player can fetch from');
  policy._reset();
  c = clients(200, 200);
  t(false, await policy.shouldRelay('v.example-b.com', 'https://v.example-b.com/x.ts', '', '', c), 'stays direct');
  t({ plain: 1, browser: 0 }, c.calls, 'the browser client is not even asked');

  console.log('--- a refusal that is not a fingerprint refusal');
  policy._reset();
  c = clients(404, 200);
  t(false, await policy.shouldRelay('gone.example-c.com', 'https://gone.example-c.com/x.ts', '', '', c), 'a 404 is the chunk, not the client: direct');
  policy._reset();
  c = clients(403, 403);
  t(false, await policy.shouldRelay('both.example-d.com', 'https://both.example-d.com/x.ts', '', '', c), 'refused either way: direct, a relay would get the same');

  console.log('--- the known hosts, and off');
  policy._reset();
  c = clients(200, 200);
  t(true, await policy.shouldRelay('cdn7.strmd.st', 'https://cdn7.strmd.st/m/x.ts', '', '', c), 'strmd.st is relayed without asking');
  t({ plain: 0, browser: 0 }, c.calls, 'no probe');
  process.env.PROXY_SEGMENT_HOSTS = 'off';
  policy._reset();
  c = clients(403, 200);
  t(false, await policy.shouldRelay('cdn.example-a.net', 'https://cdn.example-a.net/seg1.ts', '', '', c), 'PROXY_SEGMENT_HOSTS=off relays nothing');
  t({ plain: 0, browser: 0 }, c.calls, 'and probes nothing');
  delete process.env.PROXY_SEGMENT_HOSTS;

  console.log('--- what the relay route asks, without probing');
  policy._reset();
  c = clients(403, 200);
  t(true, policy.isRelayedHost('cdn7.strmd.st'), 'a known host');
  t(false, policy.isRelayedHost('cdn.example-a.net'), 'an unknown host, until a playlist has had it probed');
  await policy.shouldRelay('cdn.example-a.net', 'https://cdn.example-a.net/seg1.ts', '', '', c);
  t(true, policy.isRelayedHost('cdn.example-a.net'), 'then what the probe found');
  t({ plain: 1, browser: 1 }, c.calls, 'asked once, by the probe alone');
  process.env.PROXY_SEGMENT_HOSTS = 'off';
  t(false, policy.isRelayedHost('cdn7.strmd.st'), 'off means off, links in the wild or not');
  delete process.env.PROXY_SEGMENT_HOSTS;

  console.log('--- a slow browser answer when the player is certain to be refused');
  policy._reset();
  c = clients(403, 200);
  c.browser = async (url, headers, signal) => { c.calls.browser++; await new Promise((r, j) => signal.addEventListener('abort', () => j(new Error('aborted')))); };
  t(true, await policy.shouldRelay('slow.example-h.net', 'https://slow.example-h.net/x.ts', '', '', c), 'relayed rather than left to fail');

  console.log('--- an answer due for renewal');
  policy._reset();
  policy._remember('old.example-i.net', true, Date.now() - 1000);
  t(true, policy.isRelayedHost('old.example-i.net'), 'still counts at the relay route: links out there were minted on it');
  let release;
  c = clients(403, 200);
  c.plain = () => { c.calls.plain++; return new Promise(r => { release = () => r(403); }); };
  const during = await policy.shouldRelay('old.example-i.net', 'https://old.example-i.net/n.ts', '', '', c);
  t(true, during, 'served while the renewal is still running');
  t({ plain: 1, browser: 0 }, c.calls, 'and the renewal is running');
  release();
  await new Promise(r => setTimeout(r, 10));
  t(true, policy.isRelayedHost('old.example-i.net'), 'renewed');
  policy._reset();
  policy._remember('blip.example-j.net', true, Date.now() - 1000);
  c = clients(403, 200);
  c.plain = async () => { c.calls.plain++; throw new Error('reset'); };
  await policy.shouldRelay('blip.example-j.net', 'https://blip.example-j.net/n.ts', '', '', c);
  await new Promise(r => setTimeout(r, 10));
  t(true, policy.isRelayedHost('blip.example-j.net'), 'a try that learned nothing keeps a proven host relayed');
  policy._reset();
  policy._remember('gone.example-k.net', true, Date.now() - 1000);
  c = clients(404, 200);
  await policy.shouldRelay('gone.example-k.net', 'https://gone.example-k.net/n.ts', '', '', c);
  await new Promise(r => setTimeout(r, 10));
  t(true, policy.isRelayedHost('gone.example-k.net'), 'so does a chunk that has gone');
  policy._reset();
  policy._remember('open.example-l.net', true, Date.now() - 1000);
  c = clients(200, 200);
  await policy.shouldRelay('open.example-l.net', 'https://open.example-l.net/n.ts', '', '', c);
  await new Promise(r => setTimeout(r, 10));
  t(false, policy.isRelayedHost('open.example-l.net'), 'but a host that now serves a player goes direct');

  console.log('--- answers survive a restart');
  policy._reset();
  policy._remember('kept.example-m.net', true, Date.now() + 1000);
  policy._flush();
  policy._reset();
  t(false, policy.isRelayedHost('kept.example-m.net'), 'forgotten in memory');
  policy._load();
  t(true, policy.isRelayedHost('kept.example-m.net'), 'read back from the data directory');

  console.log('--- the sample is the address the player would fetch');
  const tokened = policy.mediaHosts('#EXTM3U\n#EXTINF:4,\n/m/a.ts', 'https://cdn7.strmd.st/secure/T/playlist.m3u8?e=123', 'https://cdn7.strmd.st/secure/T/playlist.m3u8?e=123');
  t('https://cdn7.strmd.st/m/a.ts?e=123', tokened.get('cdn7.strmd.st'), 'the playlist\'s token rides along, as it does on the served link');
  t([], [...policy.mediaHosts('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,QUJD"', 'https://a/x.m3u8', 'https://a/x.m3u8').keys()], 'an inline key is not a host');

  console.log('--- a private address is never tried');
  policy._reset();
  c = clients(403, 200);
  t(false, await policy.shouldRelay('127.0.0.1', 'http://127.0.0.1:7000/health', '', '', c), 'refused before any client is asked');
  t({ plain: 0, browser: 0 }, c.calls, 'no request made');

  console.log('--- two playlists at once ask once');
  policy._reset();
  c = clients(403, 200);
  const both = await Promise.all([
    policy.shouldRelay('cdn.example-e.net', 'https://cdn.example-e.net/1.ts', '', '', c),
    policy.shouldRelay('cdn.example-e.net', 'https://cdn.example-e.net/2.ts', '', '', c)
  ]);
  t([true, true], both, 'both get the answer');
  t({ plain: 1, browser: 1 }, c.calls, 'from one probe');

  console.log('--- the hosts a playlist names');
  const body = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example-f.com/k.bin"', '#EXTINF:4,', '/m/a.ts',
    '#EXTINF:4,', 'https://content.example-g.com/x/y.unknown', 'low/index.m3u8'].join('\n');
  const hosts = policy.mediaHosts(body, 'https://cdn7.strmd.st/secure/T/playlist.m3u8', 'https://cdn7.strmd.st/secure/T/playlist.m3u8');
  t(['keys.example-f.com', 'cdn7.strmd.st', 'content.example-g.com'], [...hosts.keys()], 'keys and segments, sub-playlists left out');
  t('https://cdn7.strmd.st/m/a.ts', hosts.get('cdn7.strmd.st'), 'one resolved address each');
  policy._reset();
  c = clients(403, 200);
  t(['keys.example-f.com', 'cdn7.strmd.st', 'content.example-g.com'].sort(),
    (await policy.relayHostsFor(body, 'https://cdn7.strmd.st/secure/T/playlist.m3u8', 'https://cdn7.strmd.st/secure/T/playlist.m3u8', '', '', c)).sort(),
    'relayHostsFor lists every host that needs it');
  t({ plain: 2, browser: 2 }, c.calls, 'strmd.st not probed, the other two once each');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
