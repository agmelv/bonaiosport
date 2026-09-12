/**
 * Which country's feed a 24/7 channel is.
 *
 * The same name is several channels: ESPN is a US network and also separate
 * feeds in New Zealand, Latin America and elsewhere, with different programmes
 * and different commentary. Filed under one name they would merge into one row
 * and put a foreign feed behind the US one, so every channel carries a region,
 * channels in different regions never merge, and a name that exists in more
 * than one region is labelled with it: "ESPN US", "ESPN NZ".
 */

// Words and codes a channel name or a source uses for a country, as the short
// label shown on the card.
const REGION = {
  usa: 'US', us: 'US',
  uk: 'UK', gb: 'UK',
  nz: 'NZ',
  au: 'AU', australia: 'AU',
  ca: 'CA', canada: 'CA',
  ie: 'IE', ireland: 'IE',
  de: 'DE', germany: 'DE', deutschland: 'DE',
  it: 'IT', italia: 'IT', italy: 'IT',
  es: 'ES', spain: 'ES', espana: 'ES',
  pt: 'PT', portugal: 'PT',
  fr: 'FR', france: 'FR',
  pl: 'PL', poland: 'PL',
  mx: 'MX', mexico: 'MX',
  br: 'BR', brasil: 'BR', brazil: 'BR',
  ar: 'AR', argentina: 'AR',
  nl: 'NL', netherlands: 'NL',
  be: 'BE', belgium: 'BE'
};

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** A source's country code or word as a region label, or '' when unknown. */
function regionFromCode(code) {
  if (!code) return '';
  const k = fold(code).trim();
  if (REGION[k]) return REGION[k];
  return /^[a-z]{2}$/.test(k) ? k.toUpperCase() : '';
}

/**
 * A title split into the channel and the region its last word names:
 * "Sky Sport 1 NZ" is Sky Sport 1 in NZ, "DAZN 1 Germany" is DAZN 1 in DE.
 * Only a trailing word counts, and never the only word, so "Canal+ Sport 5 PL"
 * splits and "beIN Sports Francais 1" does not.
 */
function splitRegion(title) {
  const words = String(title || '').trim().split(/\s+/);
  if (words.length > 1) {
    const region = REGION[fold(words[words.length - 1])];
    if (region) return { base: words.slice(0, -1).join(' '), region };
  }
  return { base: String(title || '').trim(), region: '' };
}

/** The comparison key for "same channel name, whatever the region". */
function baseKey(name) {
  return fold(name).replace(/\+/g, 'plus').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

module.exports = { regionFromCode, splitRegion, baseKey };
