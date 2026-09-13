<p align="center">
  <img src="public/logo-v2.png" width="120" height="120" alt="AIOSports logo">
</p>

# AIOSports

[![Version](https://img.shields.io/badge/version-v1.0.3-brightgreen.svg)](https://github.com/mlp2069/aiosports/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Forked from](https://img.shields.io/badge/forked_from-rajhodedara%2Flive--sport--plugin-6e7681?logo=github&logoColor=white)](https://github.com/rajhodedara/live-sport-plugin)
[![Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/mlp20)

A self-hosted addon for [Stremio](https://www.stremio.com/) and [Nuvio](https://nuvio.tv) that gathers live sports fixtures and 24/7 channels from several public sources into one catalog.

- **One tile per event.** When several sources carry the same fixture or channel, their streams are merged onto a single tile.
- **Covers for everything.** Fixtures are drawn from both teams' crests, and channels get a cover with their logo. The server renders them, so every player shows the same thing.
- **A tidy Channels tab.** It's sorted A to Z, and channels with nothing playing are hidden until they come back.
- **Your settings, one install link.** Save sports, sources, teams and timezone as a profile, and the install link stays the same when you change them.

This is a fork of [rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin). Credit for the original project goes there.

> **Streams come from third-party websites.** AIOSports hosts no video. Sources change and go offline often, so a fixture with no working stream is normal and usually not a problem with your setup.

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Install it in Stremio or Nuvio](#install-it-in-stremio-or-nuvio)
- [Updating](#updating)
- [Other ways to run it](#other-ways-to-run-it)
- [Settings](#settings)
- [Passwords, profiles and the dashboard](#passwords-profiles-and-the-dashboard)
- [Catalog tabs](#catalog-tabs)
- [Sources](#sources)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Development](#development)
- [Getting help](#getting-help)
- [License and disclaimer](#license-and-disclaimer)

## Quick start with Docker

You need Docker with Compose v2.24 or newer.

```bash
git clone https://github.com/mlp2069/aiosports.git
cd aiosports
cp .env.example .env
docker compose up -d --build
```

The first build takes a few minutes. Then open `http://<your computer's IP address>:7000/configure` in a browser on the same network. On Windows, `ipconfig` shows the address; on macOS or Linux, use `ipconfig getifaddr en0` or `ip a`.

The server only needs to reach the internet, not be reachable from it. Anything that can open the address can use the addon, though, so read [Passwords, profiles and the dashboard](#passwords-profiles-and-the-dashboard) before you expose it.

## Install it in Stremio or Nuvio

1. Open `/configure` on your server and pick your sports, sources and teams.
2. Press **Save** to get an install link that ends in `/manifest.json`. You can also copy the link from the install button.
3. Add that link in your player:
   - **Stremio:** paste it into the search box on the Addons page, then press Install.
   - **Nuvio:** go to Settings → Addons and add the link.

### Stremio needs https

Stremio only loads addons over `https://`. The one exception is an addon at `http://127.0.0.1` on the same computer. A home address like `http://192.168.1.50:7000` works in Nuvio but not in Stremio. Two common ways to get https:

- **Cloudflare Tunnel.** Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run `cloudflared tunnel --url http://127.0.0.1:7000`. That gives you a temporary `https://….trycloudflare.com` address. A named tunnel on your own domain gives you a permanent one.
- **A reverse proxy with a certificate**, such as Caddy, nginx or Traefik, on a domain you control.

Once you have an https address, put it in `.env` as `ADDON_URL=https://your.address` and run `docker compose up -d` again. Reinstall the addon from the https address.

## Updating

```bash
cd aiosports
git pull
docker compose up -d --build --remove-orphans
```

`--build` matters: without it, Compose keeps running the old image. Saved profiles live in the `aiosports-data` volume and survive updates. `--remove-orphans` clears out the container from older versions, which used a different service name.

If the manifest id or the tabs changed in a release, the release notes say so. In that case, reinstall the addon in your player.

## Other ways to run it

### Prebuilt image

Every push to `main` publishes `ghcr.io/mlp2069/aiosports:latest`. It is **linux/amd64 only**. On a Raspberry Pi or another ARM machine, build from source with the Quick start steps instead.

```bash
docker run -d --name aiosports -p 7000:7000 \
  --env-file .env -e DATA_DIR=/data -v aiosports-data:/data \
  --restart unless-stopped ghcr.io/mlp2069/aiosports:latest
```

### Node.js

Node.js 22 or newer is required.

```bash
git clone https://github.com/mlp2069/aiosports.git
cd aiosports
cp .env.example .env
npm install
npm start
```

`npm start` builds before it starts, so a separate build step isn't needed. To keep it running in the background with PM2, start it from the `aiosports` folder, because the internal resolver is found relative to that folder:

```bash
npm install -g pm2
pm2 start npm --name aiosports -- start
pm2 save
```

## Settings

Settings live in `.env`. Copy `.env.example` and edit it, and restart after a change. These are the ones most people set:

| Variable | What it does |
|---|---|
| `ADDON_URL` | Your public address, e.g. `https://sports.example.com`. Needed for Stremio (see [https](#stremio-needs-https)). |
| `AUTH_KEY` | Password for the catalog and `/configure` pages. |
| `ADMIN_TOKEN` | Password for `/dashboard`. The dashboard stays closed until this is set. |
| `TZ` | Timezone for kickoff times, for viewers who haven't picked one. |
| `HIDE_EMPTY_CHANNELS` | `0` lists every channel, even ones with no streams right now. |
| `TRUST_PROXY` | Only for a reverse proxy on a public address. See `.env.example`. |
| `RATE_LIMIT` | `off` disables the per-address request limits. |

`.env.example` explains the rest, including `DATA_DIR`, `LINK_SECRET` and the source-specific options.

## Passwords, profiles and the dashboard

| | Without it | With it |
|---|---|---|
| `AUTH_KEY` | Anyone who can open the address can browse the catalog and `/configure`. | Visitors sign in at `/login` first. |
| `ADMIN_TOKEN` | `/dashboard` is closed to everyone. | Open `/dashboard` and sign in with the token. |

**Use long random values**, for example the output of `openssl rand -base64 24`. After eight wrong guesses from one address, sign-in pauses for five minutes.

**Saved profiles.** Every profile has its own install link, so two people can keep different settings on one server.

- With `AUTH_KEY` set, anyone who has signed in can see and change every profile.
- Without it, a profile can only be changed from the browser that saved it. To change it from another device, use that profile's **edit link**, shown under the install link on `/configure`. Keep the edit link private.

**What stays open.** The manifest, catalogs, streams and artwork are never behind a password, because Stremio and Nuvio have no way to sign in. Someone who has your install link can therefore use the addon. To keep the addon itself private, put an IP allowlist or a VPN in front of it.

**Behind a reverse proxy.** Caddy, nginx and Traefik on the same machine or network work without extra setup. If your proxy sits on a public address, set `TRUST_PROXY` as `.env.example` describes, and never set it to `true`.

## Catalog tabs

| Tab | Holds |
|---|---|
| 🔴 Live Now | Fixtures in progress. Channels are not mixed in. |
| ⚽ Soccer | Association football |
| 🏈 NFL | The NFL |
| 🏈 Other Football | The CFL, the AFL, and gridiron whose league can't be named |
| 🎓 College | College fixtures in any sport |
| 🏉 Rugby | NRL, Premiership, URC, Top 14, Super Rugby and test rugby |
| 🏎️ Racing | Motorsport |
| 📺 Channels | Every 24/7 channel, A to Z, with a genre filter |
| 🏏 🏀 🏒 ⚾ 🥊 ⛳ 🎾 🎯 | Cricket, basketball, hockey, baseball, MMA, golf, tennis, darts |
| 🏅 Other Sports | Anything that fits no tab above |
| ⏱️ Upcoming · ⭐ Your Teams | Everything ahead, and the teams you follow in `/configure` |
| 📍 Local | The channels of the cities you name in `/configure` (see below) |

In `/configure` you can hide, rename and reorder the tabs.

### Local channels

The ABC, CBS, NBC and FOX tiles carry streams from local stations all over the country, each labelled with its city and call sign. Name your own cities under **Local Channels** in `/configure` -- `Chicago, Knoxville TN, Phoenix` -- and:

- each of those cities' stations that iptv-org has a stream for becomes a tile of its own ("FOX 32 Chicago News", "ABC 15 Phoenix News"), in the Channels tab under the Local genre and in the 📍 Local tab, together with channels whose names say the city (CBS News Chicago, Chicago Sports Network);
- your cities' stations are listed first on the network tiles.

What a network station streams free is its 24/7 **news** channel (FOX LOCAL, NBC Chicago News), not its broadcast signal: nobody may stream that, so the network's schedule and the games are never on these tiles. A game is on its own tile in its sport's tab, where the FOX or CBS stream is that game's broadcast. A city shared by several states goes to the one with the TV market; add the state to say otherwise. Only stations somebody has contributed a stream for can be listed, so a small market may have none. `LOCAL_MARKETS` in `.env` adds cities whose stations are listed as tiles for everyone on the server; the 📍 Local tab and the first-place ordering follow each profile's own cities.

## Sources

StreamFree, TimStreams, Streamed.pk, SportyHunter, WatchFooty, CDNLive, StreamSports99, Streamic, USA TV and iptv-org. You can turn each one on or off and set the order its streams are listed in, all in `/configure`.

## FAQ and troubleshooting

**A fixture has no streams.** The source sites haven't posted one yet, or took it down. Streams often appear shortly before kickoff. Try again closer to the start, or pick another source's tile.

**Stremio won't install the addon.** It needs an https address; see [Stremio needs https](#stremio-needs-https).

**Covers show only a name for a moment.** The first time a tab opens, the server fetches logos and draws covers. They're cached afterwards -- on the data volume too, so a restart does not draw them again; only an update that changes how cards look draws them once more -- and the server warms them in the background after it starts.

**The server is busy for a few minutes after an update.** Only when the data volume is missing: without it, every restart re-reads every source, refetches every logo and redraws every cover. With `DATA_DIR` on a volume, the catalog, the cards, the logos and the channel checks are all kept, and a restart serves them at once.

**A channel disappeared.** Channels with no streams across two checks at least 15 minutes apart are hidden, and they come back once they play again. `HIDE_EMPTY_CHANNELS=0` shows them all.

**Streamed's streams buffer in Nuvio but play in a browser.** Streamed's CDN only answers clients that look like a browser, so the server fetches its video chunks for the player and relays them. Any host that behaves that way is found out by trying one chunk and relayed from then on; every other host's chunks go straight to the player. Relaying costs the server the stream's bandwidth, a few hundred kilobytes every few seconds per viewer (`PROXY_SEGMENT_HOSTS` in `.env.example`).

**My saved settings were lost after an update.** Profiles are stored in `DATA_DIR`. Compose keeps them on the `aiosports-data` volume. With `docker run`, add `-v aiosports-data:/data -e DATA_DIR=/data`.

**Port 7000 is already in use.** Change the left side of `"7000:7000"` in `docker-compose.yml`, for example to `"7100:7000"`.

**Can I host it on Render, Vercel or Railway?** It's not recommended. Free app hosts tend to suspend apps that scrape websites or relay media. A spare computer, a Raspberry Pi or a small VPS works better.

**Does it work on a Raspberry Pi?** Yes. Build from source with the Quick start steps, because the prebuilt image is amd64 only.

## Development

```bash
npm install
npm run dev      # restarts on changes to src/
npm test         # channel-merge tests
npm run build    # bundles to dist/
```

Built with Node.js, Express and [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk). HTTP goes through [impit](https://github.com/apify/impit) with an [undici](https://undici.nodejs.org/) fallback. Artwork is rendered with [sharp](https://sharp.pixelplumbing.com/).

## Getting help

- **Bugs and questions:** open an [issue](https://github.com/mlp2069/aiosports/issues). The template asks for what's needed.
- **Security problems:** report them privately; see [SECURITY.md](SECURITY.md).
- **Support the project:** [this fork on Ko-fi](https://ko-fi.com/mlp20), or [the upstream project](https://ko-fi.com/rajodedara) it's built on.

## License and disclaimer

AIOSports is released under the [MIT License](LICENSE). It is free, with no paid tiers, and anyone selling access to it is not connected to this project.

- **No hosted media.** The addon doesn't host, store or broadcast video. It lists links that third-party websites already publish and passes them to your player.
- **Not affiliated.** It isn't affiliated with or endorsed by any league, team, broadcaster or streaming service. Their names and logos belong to their owners and appear only to identify content.
- **Your responsibility.** You're responsible for following the laws where you live and the terms of any service you use.
- **Removal requests.** Rights holders can open an issue asking for a source or listing to be removed.
