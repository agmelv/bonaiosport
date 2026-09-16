/**
 * StreamScoringService.js — the number the stream list is sorted on.
 *
 * A fixture opens to a dozen rows that all claim to play the same game, and the
 * viewer takes the first one. This decides which row that is: whether the app
 * can play it itself, how big the picture turned out to be once something
 * looked, and whether the provider behind it has been answering lately.
 *
 * The weights below are chosen so the best a stream can reach is exactly the
 * hundred the score claims. A scale that ran past its own ceiling and was then
 * cut off at it merged every good row into one indistinguishable block, which
 * is the opposite of what a ranking is for.
 */

'use strict';

// A picture size the manifest or the provider stated in a field of its own,
// rather than in the sentence it wrote for the viewer. Both forms appear:
// "1920x1080" from a parsed master playlist, "720p" from a channel listing.
function statedHeight(streamEntity) {
  for (const field of [streamEntity.resolution, streamEntity.quality]) {
    if (typeof field !== 'string') continue;
    const pair = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(field);
    if (pair) return Number(pair[2]);
    const lines = /^\s*(\d{3,4})p/i.exec(field);
    if (lines) return Number(lines[1]);
  }
  return 0;
}

// The megabits a parsed manifest reported, from tags like "3.5 Mbps" and
// "850 kbps". Only ever a tie-break: a high bitrate is a hint that a stream is
// worth watching, never a promise that it will keep up.
function statedMbps(streamEntity) {
  const tag = streamEntity.bitrate;
  if (typeof tag !== 'string') return 0;
  const m = /([\d.]+)\s*(m|k)bps/i.exec(tag);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!isFinite(n)) return 0;
  return m[2].toLowerCase() === 'k' ? n / 1000 : n;
}

// How far a provider's recent record may move a row. Small on purpose: a
// provider having a bad minute should lose a tie, not be buried under every
// other row on the card while its streams are still playing.
const HEALTH_LIMIT = 15;

// A failure this recent is the strongest evidence anything here has, because it
// is the only one that describes the tokens being handed out right now.
const FRESH_FAILURE_MS = 5 * 60 * 1000;

function healthAdjustment(health) {
  if (!health) return 0;
  const successes = Number(health.successes) || 0;
  const failures = Number(health.failures) || 0;
  const seen = successes + failures;
  // One outcome is an anecdote. The ratio only starts counting once the
  // provider has been asked enough times for a run to mean something.
  let adj = seen >= 2 ? Math.round(((successes - failures) / seen) * 10) : 0;
  if (health.lastFailAt && Date.now() - health.lastFailAt < FRESH_FAILURE_MS) adj -= 5;
  return Math.max(-HEALTH_LIMIT, Math.min(HEALTH_LIMIT, adj));
}

class StreamScoringService {
  constructor() {}

  /**
   * A score out of 100 for one stream, higher being the better row to open.
   *
   * `health` is the provider's recent record — `{ successes, failures,
   * lastFailAt }` — and is optional: a caller that has not measured anything
   * simply leaves it out and the stream is judged on its own merits.
   */
  calculateScore(streamEntity, sourceName, health) {
    let score = 30;

    // Direct streaming is always preferred; having to open a web browser is a
    // worse experience whatever is on the other end of it.
    if (streamEntity.url) {
      score += 25;
    } else if (streamEntity.externalUrl) {
      score -= 20;
    }

    // What the stream is, before what it says it is. Verification parses the
    // master playlist and writes the real numbers onto the stream, so a row
    // whose size has been looked at outranks one that only claims the same size
    // in the sentence its provider wrote.
    const height = statedHeight(streamEntity);
    if (height) {
      score += height >= 1080 ? 18 : height >= 720 ? 10 : height >= 540 ? 0 : -5;
    } else {
      const title = String(streamEntity.title || '');
      if (title.includes('1080p')) {
        score += 12;
      } else if (title.includes('720p')) {
        score += 6;
      } else if (title.includes('540p') || title.includes('SD')) {
        score -= 5;
      }
    }

    const mbps = statedMbps(streamEntity);
    if (mbps >= 4) {
      score += 2;
    } else if (mbps >= 2) {
      score += 1;
    }

    // Some sources are known to buffer less.
    const reliableSources = ['admin', 'echo', 'delta', 'golf'];
    if (reliableSources.includes(sourceName)) {
      score += 10;
    } else if (sourceName === 'streamfree') {
      score += 7;
    } else if (sourceName === 'timstreams') {
      score += 4;
    }

    score += healthAdjustment(health);

    return Math.max(0, Math.min(100, Math.round(score)));
  }
}

module.exports = StreamScoringService;
