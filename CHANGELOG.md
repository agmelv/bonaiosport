# Changelog

## 1.0.0

First release under the AIOSports name. The project began as a fork of
[rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin),
and the version resets to 1.0.0 to start its own line.

### Catalogs

- **A tab can be off the home board and still searchable.** Taking a tab off the
  board means marking its genre required, and a search request carries no genre
  — so the same mark that took it off the board also took it out of the search
  box. Such a tab is now published twice: one copy in Discover, one that answers
  search. They are never offered in the same place, so nothing is listed twice.
- **Per-tab controls** for hiding, home-board placement, search-only, disabling
  search, shuffle and reverse, with bulk actions and drag-to-reorder.
- **My Teams** appears only once teams are entered.

### Matching

- **Mixed Martial Arts is MMA.** One feed spells out what the others abbreviate,
  and the string contained none of the words the normaliser looked for — not
  even "mma". Those fights were filed under Other, and, because a category
  mismatch is rejected before titles are ever compared, the same fight from two
  providers never merged and its streams stayed split across two listings.
- **A hex-encoded URL is not an event number.** One provider keys each source by
  the hex of its stream URL; hex is all `[0-9a-f]`, so the tail of one reads as a
  long number. Every embed whose URL ended `-usa` encoded to a string ending
  `757361`, so every listing carrying a US channel claimed the same upstream
  event and merged with all the others — ahead of every guard, because that rule
  is identity rather than similarity. Fifteen college games collapsed into one,
  and the rest of that provider's football left the catalog entirely.
- **Accents are letters, not word breaks.** The tokeniser kept only `[a-z0-9]`,
  so "Köln" became "k ln" and then nothing at all — no token survived to be
  compared. Folding comes first now, and a team-alias table follows it for the
  genuine dual names (Köln/Cologne, Athletic Club/Athletic Bilbao,
  Mönchengladbach/Gladbach, and more).
- `tests/merge-identity.test.js` asserts both directions: that these merge, and
  that different opponents, similarly-named clubs and the two legs of a series
  on consecutive days still do not.

### Streams

- **The whole list on the first open.** Requests used to return whatever had
  resolved by a 3.5s deadline and let the rest land in the cache for next time,
  so the same match showed 8 streams and then 12 on a reload. All sources are
  waited for now, capped by the hard deadline; 40 live matches are warmed ahead
  of the click so that wait is rarely felt.
- **No two rows read the same.** One provider numbers its own mirrors, but any
  title carrying the word "Stream" was treated as boilerplate and the number
  dropped — six rows that played different mirrors rendered identically. The
  number is surfaced, and any group of rows that would still collide is numbered.
- Multi-host failover for TimStreams, so a moved domain is found at runtime
  rather than pinned in source.
- Stream health checks read a small byte range instead of pulling the stream.

### Configuration

- **Server-side profiles.** Settings can be saved on the server and installed
  once, instead of living inside the install URL. Each profile has its own UUID
  and its own install URL, so several people can share one instance.
- **Export and import config** as a JSON file — a backup, a way to move an
  instance, or a setup to hand to someone else. Imports are validated key by key
  against an allow-list, previewed before they apply, and never carry an install
  URL, a profile id or a hostname.
- **A save no longer points the address bar at the config it replaced.** The
  configure URL is a snapshot taken when the page loads, and saving did not move
  it, so a reload rebuilt the form from the settings as they were *before* the
  save — and saving again from that page wrote the stale copy back over what had
  just been stored.
- Editable addon name, logo and description; timezone and 12/24-hour clock;
  source order and stream-type preference.

### Security

- **The admin dashboard is no longer open by default.** With no `ADMIN_TOKEN`
  set it fell back to trusting private IPs — and on Docker every request arrives
  from the bridge gateway, which is itself a private address, so no forgery was
  needed. It is now closed unless a token is set.
- `trust proxy` is configured explicitly rather than trusting every hop.
- Signed stream URLs are redacted in logs; they are credentials, and they were
  being written out in full.
- `.env` is read at startup, which it previously was not.

### Housekeeping

- Dead one-off debug scripts, a committed build directory and a 53 MB vendored
  Windows binary removed from the repository.
