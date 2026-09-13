/**
 * Listings that are not channels anyone opens a sports addon to watch.
 *
 * Each came out of a review of the whole Channels tab, and each was checked a
 * second time by someone arguing to keep it. Only listings that are clearly not
 * a channel for this tab are here: a radio studio webcam, official meeting
 * feeds, community-access stations, single-show web loops, an overflow feed
 * that shows a slate most of the day, a shopping channel. A channel that is
 * merely not playing right now does not belong here -- ChannelHealth hides
 * those, and brings them back when they play again.
 *
 * Keyed by the listing's id, which is stable per source. A listing merged into
 * another source's tile keeps that tile's id, so excluding one source's copy of
 * a real channel can never hide the channel itself.
 */

const EXCLUDED_IDS = new Map([
  // A radio simulcast: the stream is a camera in the Fox News Radio studio.
  ['iptv_FoxNewsRadio.us', 'radio'],
  // The United Nations' webcast of meetings and briefings.
  ['iptv_UNWebTV.us', 'government'],
  // Community and public-access stations.
  ['iptv_BXInform.us', 'public access'],
  ['iptv_SCCurrents.us', 'public access'],
  ['iptv_DerryTV23.us', 'public access'],
  // Small diaspora political outlets with no sports.
  ['iptv_NationalIranianCongressTV.us', 'diaspora political outlet'],
  ['iptv_ChannelOne.us', 'diaspora political outlet'],
  ['iptv_DidgahTV.us', 'diaspora outlet'],
  ['iptv_PayvandTV.us', 'diaspora outlet'],
  // 24/7 loops of a single web show, from a small regional web outfit.
  ['iptv_30ALionelNation.us', 'single-show web loop'],
  ['iptv_30ALoomeredTV.us', 'single-show web loop'],
  ['iptv_30AGeorgiaHollywoodReview.us', 'single-show web loop'],
  // A low-power station's call sign and subchannel.
  ['iptv_W14DKD142.us', 'low-power local station'],
  // Home shopping.
  ['ustv_ustv-a333fdc1-1e6c-44e0-ab7c-7a7d7d982a7a', 'shopping (QVC)']
]);

// ABC News' numbered overflow feeds, ABC News Live 1 to 10: a slate most of the
// day and an occasional press conference. The main ABC News Live stays.
const EXCLUDED_PATTERNS = [
  [/^iptv_ABCNewsLive\d+\.us$/, 'ABC News overflow feed']
];

/** Why a listing is excluded from the Channels tab, or null when it is not. */
function exclusionReason(match) {
  if (!match || !match.id) return null;
  const id = String(match.id);
  if (EXCLUDED_IDS.has(id)) return EXCLUDED_IDS.get(id);
  for (const [re, reason] of EXCLUDED_PATTERNS) if (re.test(id)) return reason;
  return null;
}

module.exports = { exclusionReason };
