# Changelog

## 1.0.1 (2026-09-12)

A channels release. New channel sources, a cover for every channel with its real logo, and a Channels tab that lists one tile per channel and hides the ones that do not play.

### Features

* **artwork:** draw every 24/7 channel as a wide cover: its logo on flat grey with the channel's name underneath ([e90de33](https://github.com/mlp2069/aiosports/commit/e90de33), [0028a99](https://github.com/mlp2069/aiosports/commit/0028a99), [c830587](https://github.com/mlp2069/aiosports/commit/c830587))
* **artwork:** find each channel's logo in a curated logo set for its own country, add 70 hand-checked logos, and give channels with no usable logo a clean name-only cover ([0028a99](https://github.com/mlp2069/aiosports/commit/0028a99), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **artwork:** lighten dark and navy logos so they read on the grey, without changing brand colours ([fff631c](https://github.com/mlp2069/aiosports/commit/fff631c), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **cache:** show in the cache stats how many channels the health check has hidden and how many are waiting on a second check ([94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **channels:** add sec network, which plays but is missing from timstreams' own channel list ([0028a99](https://github.com/mlp2069/aiosports/commit/0028a99))
* **channels:** add usa tv next, cdnlive and timstreams' 24/7 channels as channel sources, and bring back iptv-org for us sports and news channels ([cf8dcad](https://github.com/mlp2069/aiosports/commit/cf8dcad), [ef4f6c6](https://github.com/mlp2069/aiosports/commit/ef4f6c6), [1e03f2a](https://github.com/mlp2069/aiosports/commit/1e03f2a), [598ffc8](https://github.com/mlp2069/aiosports/commit/598ffc8))
* **channels:** hide channels that open to nothing, after two empty checks at least 15 minutes apart or three failed checks over half an hour, and bring them back once they play (hide_empty_channels=0 turns it off) ([94dc563](https://github.com/mlp2069/aiosports/commit/94dc563), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))
* **channels:** label a channel that exists in several countries with its region, such as espn us and espn nz, and never merge two countries' feeds ([491edb9](https://github.com/mlp2069/aiosports/commit/491edb9))
* **channels:** list a channel once when several sources carry it, with all of their streams on the one tile ([598ffc8](https://github.com/mlp2069/aiosports/commit/598ffc8), [c830587](https://github.com/mlp2069/aiosports/commit/c830587), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))
* **channels:** sort the channels tab a to z with numbers in order, and add a genre picker ([0028a99](https://github.com/mlp2069/aiosports/commit/0028a99), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **configure:** list usa tv and iptv-org among the sources so they can be switched off or reordered ([cf8dcad](https://github.com/mlp2069/aiosports/commit/cf8dcad), [598ffc8](https://github.com/mlp2069/aiosports/commit/598ffc8))
* **providers:** add usatv_base, iptv_categories, iptv_country, cdnlive_countries and cdnlive_health_per_hour for self-hosters ([cf8dcad](https://github.com/mlp2069/aiosports/commit/cf8dcad), [598ffc8](https://github.com/mlp2069/aiosports/commit/598ffc8), [491edb9](https://github.com/mlp2069/aiosports/commit/491edb9), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))

### Bug Fixes

* **aggregator:** merge one channel listed under different names, such as fs1 and fox sports 1, espn 2 and espn2, tsn 1 and tsn1, fox news channel and fox news, and dazn 1 germany and dazn 1 ([c830587](https://github.com/mlp2069/aiosports/commit/c830587), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))
* **aggregator:** stop different channels that share a logo from merging, such as espn and espn deportes, two nbc sports regionals, or spectrum sportsnet and spectrum sportsnet la ([cf8dcad](https://github.com/mlp2069/aiosports/commit/cf8dcad), [aa6dcc1](https://github.com/mlp2069/aiosports/commit/aa6dcc1))
* **artwork:** fetch logos a few at a time per host and back off a host that rate-limits, so covers still load when a whole tab opens at once ([94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **artwork:** give channels their cover instead of promo art, and keep logos sharp with their frames and lettering intact ([c830587](https://github.com/mlp2069/aiosports/commit/c830587), [d58d277](https://github.com/mlp2069/aiosports/commit/d58d277), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **artwork:** show each channel's own logo instead of a sibling's or another country's, as on fox sports 503, tsn, sportsnet, tnt sports and espn 4 ([491edb9](https://github.com/mlp2069/aiosports/commit/491edb9), [d58d277](https://github.com/mlp2069/aiosports/commit/d58d277), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **cache:** stop players keeping a placeholder for good when a channel's logo is slow while a whole tab loads ([c830587](https://github.com/mlp2069/aiosports/commit/c830587), [94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **channels:** keep iptv-org's abc, cbs, nbc, fox, cw, mnt, galavision and telemundo streams on those networks' tiles while its public-access channels stay out ([b1977fa](https://github.com/mlp2069/aiosports/commit/b1977fa))
* **channels:** leave out listings that are not channels: mlb club channels, city public-access and government channels, a radio studio webcam, abc news overflow feeds, qvc and streamed.pk's nfl schedule page ([94dc563](https://github.com/mlp2069/aiosports/commit/94dc563), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))
* **providers:** leave out usa tv next channels whose stream hosts are gone, rechecking every six hours ([e2c137e](https://github.com/mlp2069/aiosports/commit/e2c137e))
* **providers:** list espn from streamed.pk as its own channel, and split that feed so espn2, espn deportes and abc get their own streams instead of piling onto espn us ([1e03f2a](https://github.com/mlp2069/aiosports/commit/1e03f2a), [de61838](https://github.com/mlp2069/aiosports/commit/de61838))
* **providers:** pause cdnlive player lookups for ten minutes after a rate limit, read its channel list from its second domain when the first fails, and stop fetching its channel images that never load ([1e03f2a](https://github.com/mlp2069/aiosports/commit/1e03f2a), [d58d277](https://github.com/mlp2069/aiosports/commit/d58d277))
* **streams:** label cdnlive streams as cdnlive and play them with its own referer ([1e03f2a](https://github.com/mlp2069/aiosports/commit/1e03f2a))

### Performance Improvements

* **cache:** keep finished covers and enough logos for the whole channels tab, and warm up to 2500 cards, so opening it does not refetch every logo ([94dc563](https://github.com/mlp2069/aiosports/commit/94dc563))
* **cache:** warm popular channels alongside live fixtures so busy channels like espn return every stream on the first open ([17a1653](https://github.com/mlp2069/aiosports/commit/17a1653))
* **providers:** reuse a cdnlive stream link until shortly before it expires instead of reloading its player page on every open ([1e03f2a](https://github.com/mlp2069/aiosports/commit/1e03f2a))

## 1.0.0 (2026-09-12)

First release under the AIOSports name. The project is a fork of [rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin), and the version resets to 1.0.0 to start its own line.

### Features

* **artwork:** back a fixture detail page with its own crest card rather than the provider's artwork ([6c0450b](https://github.com/mlp2069/aiosports/commit/6c0450b))
* **artwork:** fall back to thesportsdb for crests espn has no table for, covering 53 more sides ([3013c9b](https://github.com/mlp2069/aiosports/commit/3013c9b))
* **artwork:** paint generated matchup cards in the two teams' own colours ([37e91b6](https://github.com/mlp2069/aiosports/commit/37e91b6))
* **artwork:** read all 25 espn rugby competitions and wire up the urc, super rugby and six nations badges ([2aa13ce](https://github.com/mlp2069/aiosports/commit/2aa13ce))
* **artwork:** show real team crests on catalog cards instead of category placeholders ([f80d25e](https://github.com/mlp2069/aiosports/commit/f80d25e))
* **artwork:** work out a fixture's competition badge from the crests when no feed names a league ([1b14af7](https://github.com/mlp2069/aiosports/commit/1b14af7))
* **cache:** render match cards in the background before a tab is opened, with a dashboard to watch it ([4e548cf](https://github.com/mlp2069/aiosports/commit/4e548cf))
* **catalogs:** collect always-on channels into their own tab instead of scattering them across sports ([f94f01b](https://github.com/mlp2069/aiosports/commit/f94f01b))
* **catalogs:** give each tab its own settings: hide, search-only, no search, seeded shuffle and reverse ([f6fa239](https://github.com/mlp2069/aiosports/commit/f6fa239))
* **catalogs:** give the nfl its own tab and move the cfl and afl to other football ([091c54b](https://github.com/mlp2069/aiosports/commit/091c54b))
* **catalogs:** offer a 12- or 24-hour clock for kickoff times alongside the timezone ([9a6c898](https://github.com/mlp2069/aiosports/commit/9a6c898))
* **catalogs:** orient fixtures from espn scoreboards so cards and titles read away @ home ([dc0da32](https://github.com/mlp2069/aiosports/commit/dc0da32))
* **catalogs:** show kickoff times as 1:00 pm (et) instead of 13:00 (america/new_york) ([388c005](https://github.com/mlp2069/aiosports/commit/388c005))
* **configure:** add a no-preference stream order, and show my teams once a team is tracked ([b578bf6](https://github.com/mlp2069/aiosports/commit/b578bf6))
* **configure:** apply any tab option to every selected tab at once from the bulk bar or the row menu ([908bb30](https://github.com/mlp2069/aiosports/commit/908bb30))
* **configure:** edit name, description and logo in a dialog, and add favicons and a version line ([607af6d](https://github.com/mlp2069/aiosports/commit/607af6d))
* **configure:** export and import settings as a json file ([20f202c](https://github.com/mlp2069/aiosports/commit/20f202c))
* **configure:** give each saved setup its own uuid and install url so one server can hold several ([c0826d7](https://github.com/mlp2069/aiosports/commit/c0826d7))
* **configure:** manage catalog tabs from a row list, and ship the new logo and blue accent across the pages ([85de183](https://github.com/mlp2069/aiosports/commit/85de183))
* **configure:** order sources and pick whether direct or web streams come first ([0c439a7](https://github.com/mlp2069/aiosports/commit/0c439a7))
* **configure:** put each catalog row's five options on the row as buttons that light up when set ([4432960](https://github.com/mlp2069/aiosports/commit/4432960))
* **configure:** reorder catalog tabs by dragging a handle, and rename any of them ([3a8f8f1](https://github.com/mlp2069/aiosports/commit/3a8f8f1))
* **configure:** serve settings from a fixed /saved url so edits apply without reinstalling, and rename to aiosports ([8038763](https://github.com/mlp2069/aiosports/commit/8038763))
* **configure:** show the install url in a copyable field with a copy button instead of inside a sentence ([657e418](https://github.com/mlp2069/aiosports/commit/657e418))
* **docker:** publish prebuilt images to ghcr on every push to main ([c062968](https://github.com/mlp2069/aiosports/commit/c062968))
* **manifest:** let each install rename the addon so two of them can be told apart in a player ([3044430](https://github.com/mlp2069/aiosports/commit/3044430))
* **manifest:** show the project's own addon logo in stremio and nuvio ([8037493](https://github.com/mlp2069/aiosports/commit/8037493))
* **providers:** let timstreams fall back to its other hosts when one goes dark, with no rebuild ([46a2598](https://github.com/mlp2069/aiosports/commit/46a2598))
* **security:** gate every page behind a sign-in and keep admin_token for actions that change state ([5fdb80a](https://github.com/mlp2069/aiosports/commit/5fdb80a))
* **security:** offer a sign-out on the catalog page when the server asks for a password ([fe3b6a5](https://github.com/mlp2069/aiosports/commit/fe3b6a5))

### Bug Fixes

* **aggregator:** keep always-on channels in the catalog instead of expiring them against a merged kickoff ([fb9c278](https://github.com/mlp2069/aiosports/commit/fb9c278))
* **aggregator:** merge duplicate fixtures by the crests both sides resolve to, not by how a provider spelled them ([88f5945](https://github.com/mlp2069/aiosports/commit/88f5945))
* **aggregator:** merge duplicate fixtures whose titles say "at" rather than "vs" ([91f727e](https://github.com/mlp2069/aiosports/commit/91f727e))
* **aggregator:** resolve afl and cfl crests, merge duplicate events, and correct kickoff times that ran 7h late ([6b4d213](https://github.com/mlp2069/aiosports/commit/6b4d213))
* **aggregator:** stop unrelated football listings from collapsing into one match and dropping out of the catalog ([4280413](https://github.com/mlp2069/aiosports/commit/4280413))
* **artwork:** badge cards with the governing body's mark and file dateless channels by their name ([e304765](https://github.com/mlp2069/aiosports/commit/e304765))
* **artwork:** look up channel logos for channel-like titles and replace the dead logo urls ([cbbd29b](https://github.com/mlp2069/aiosports/commit/cbbd29b))
* **artwork:** pick crests from urls that actually fetch so the same game looks alike from every provider ([5150f4c](https://github.com/mlp2069/aiosports/commit/5150f4c))
* **artwork:** restore card image quality to 90 now that it costs no measurable cpu ([e04dcfc](https://github.com/mlp2069/aiosports/commit/e04dcfc))
* **artwork:** serve catalog cards as jpeg so clients that cannot draw svg posters show them sharp ([073763e](https://github.com/mlp2069/aiosports/commit/073763e))
* **artwork:** show a crest for a club that plays in several competitions, such as exeter chiefs ([302be29](https://github.com/mlp2069/aiosports/commit/302be29))
* **artwork:** show the competition crest in the card's logo slot instead of an unreadable title card ([2ea343c](https://github.com/mlp2069/aiosports/commit/2ea343c))
* **artwork:** stop bare nicknames resolving to the wrong club's crest and repaint the fallback name cards ([57b3f29](https://github.com/mlp2069/aiosports/commit/57b3f29))
* **cache:** version generated card urls so restyled artwork is not hidden behind a day-old cache ([c3c25ee](https://github.com/mlp2069/aiosports/commit/c3c25ee))
* **catalogs:** badge a college fixture with its own sport's mark, and shorten the college and racing tab names ([5345530](https://github.com/mlp2069/aiosports/commit/5345530))
* **catalogs:** file college fixtures under college when their crests say so and no league is named ([4b63b0b](https://github.com/mlp2069/aiosports/commit/4b63b0b))
* **catalogs:** show rugby crests and file events by their league so nfl games leave the soccer tab ([3479dcb](https://github.com/mlp2069/aiosports/commit/3479dcb))
* **catalogs:** stop any sports selection from silently dropping the college, other football and channels tabs ([4eae68a](https://github.com/mlp2069/aiosports/commit/4eae68a))
* **catalogs:** stop college fixtures landing beside the nfl or in hockey when a name shortens saint to st ([b01fa32](https://github.com/mlp2069/aiosports/commit/b01fa32))
* **catalogs:** stop the sport filter showing two football boxes, and label soccer cards soccer ([8487fcb](https://github.com/mlp2069/aiosports/commit/8487fcb))
* **configure:** drop a tab from catalog management when its sport is switched off ([3b7eaf3](https://github.com/mlp2069/aiosports/commit/3b7eaf3))
* **configure:** give the paired stream-order and support buttons equal size with centred labels ([fcdcf99](https://github.com/mlp2069/aiosports/commit/fcdcf99))
* **configure:** keep a saved config after a reload instead of restoring the one it replaced ([3785f28](https://github.com/mlp2069/aiosports/commit/3785f28))
* **configure:** make unticking sources and sports actually filter, and reset all clear the tab options ([3eacb57](https://github.com/mlp2069/aiosports/commit/3eacb57))
* **configure:** point the tip and support buttons and the readme badge at this fork's ko-fi ([689a7e7](https://github.com/mlp2069/aiosports/commit/689a7e7))
* **configure:** say which settings need a reinstall to take effect instead of promising save is enough ([d1a5d3e](https://github.com/mlp2069/aiosports/commit/d1a5d3e))
* **configure:** send a browser to the setup page when nothing is saved instead of answering with json ([85ab6d0](https://github.com/mlp2069/aiosports/commit/85ab6d0))
* **configure:** show disabled buttons as disabled, including save while it is saving ([ec8af42](https://github.com/mlp2069/aiosports/commit/ec8af42))
* **configure:** stop the footer buttons overlapping and the install button forcing a sideways scroll on phones ([fdd92f5](https://github.com/mlp2069/aiosports/commit/fdd92f5))
* **configure:** widen the form so long tab names and the install url are no longer clipped ([5690026](https://github.com/mlp2069/aiosports/commit/5690026))
* **providers:** file mixed martial arts under mma so both providers' streams land on the same fight ([fa9525f](https://github.com/mlp2069/aiosports/commit/fa9525f))
* **providers:** follow timstreams to its new domain so its streams load again ([3fd7a83](https://github.com/mlp2069/aiosports/commit/3fd7a83))
* **providers:** route the remaining providers through impit so stricter hosts stop blocking them ([d9cf994](https://github.com/mlp2069/aiosports/commit/d9cf994))
* **security:** keep signed stream urls and their tokens out of the logs ([8b47b87](https://github.com/mlp2069/aiosports/commit/8b47b87))
* **security:** require admin_token for the dashboard instead of trusting any caller on a private address ([2d063f0](https://github.com/mlp2069/aiosports/commit/2d063f0))
* **security:** stop a forged x-forwarded-for granting admin, and load .env so auth_key actually applies ([145177a](https://github.com/mlp2069/aiosports/commit/145177a))
* **streams:** keep streams playing when the impit binary is missing instead of dropping to the webplayer ([772775c](https://github.com/mlp2069/aiosports/commit/772775c))
* **streams:** return the complete stream list on the first open instead of letting it grow on a reload ([80c65eb](https://github.com/mlp2069/aiosports/commit/80c65eb))
* **streams:** serve the last good playlist on an upstream blip instead of refusing every viewer for 15s ([ce32f9e](https://github.com/mlp2069/aiosports/commit/ce32f9e))
* **streams:** stop six mirrors of one stream from rendering as identical rows ([d529bf1](https://github.com/mlp2069/aiosports/commit/d529bf1))
* **streams:** stop the liveness check from overloading sources and discarding streams that work ([1a903d9](https://github.com/mlp2069/aiosports/commit/1a903d9))

### Performance Improvements

* **artwork:** halve the cpu a card costs to draw and keep 1200 rendered cards instead of 160 ([f0c8a4a](https://github.com/mlp2069/aiosports/commit/f0c8a4a))
* **cache:** warm top live fixtures while a catalog is browsed so the first click answers in milliseconds ([407a22c](https://github.com/mlp2069/aiosports/commit/407a22c))
* **catalogs:** cut catalog render time roughly sixteenfold by reusing date formatters ([f758d0a](https://github.com/mlp2069/aiosports/commit/f758d0a))
* **streams:** answer on a deadline instead of waiting for the slowest source, cutting 11s waits to 2-4s ([d5e0134](https://github.com/mlp2069/aiosports/commit/d5e0134))
