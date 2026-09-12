<p align="center">
  <img src="public/logo.png" width="120" height="120" alt="AIOSports Logo">
</p>

# 🔴 AIOSports

[![Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/mlp20)
[![GitHub](https://img.shields.io/badge/GitHub-AIOSports-181717?logo=github&logoColor=white)](https://github.com/mlp2069/aiosports)
[![Upstream](https://img.shields.io/badge/forked_from-rajhodedara%2Flive--sport--plugin-6e7681?logo=github&logoColor=white)](https://github.com/rajhodedara/live-sport-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-brightgreen.svg)](https://github.com/mlp2069/aiosports/releases/latest)

> 🍴 **THIS IS A FORK.**
> The upstream project is [rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin) and all credit for it belongs there. This fork is [mlp2069/aiosports](https://github.com/mlp2069/aiosports), self-hosted, and differs in ways the instructions below assume:
> - **Sign-in.** The catalog and configure pages can sit behind `AUTH_KEY`, and a dashboard behind a separate `ADMIN_TOKEN`. See [Sign-in and the dashboard](#-sign-in-and-the-dashboard).
> - **Artwork built from crests.** Cards are drawn from team crests and rendered server-side, with a competition badge worked out from the crests rather than from whatever a provider called the league.
> - **Different tabs.** Soccer, NFL, Other Football, College, Racing and Channels, among others — see [Catalog tabs](#-catalog-tabs).
> - **Poster cache warming**, so opening a tab does not render hundreds of cards at once.
>
> Clone this fork rather than upstream if you want the above; the commands below already point at it.

> ⚠️ **IMPORTANT HOSTING NOTICE:**
> **Do NOT deploy this addon to free/shared PaaS clouds like Render.com, Vercel, or Railway.** Their automated Acceptable Use Policy (AUP) scanners detect web scrapers and media proxying, which will result in **immediate and permanent suspension of your account**.
> 
> **Recommended setup:** Self-host on a spare PC / laptop / Raspberry Pi, or use a cheap unmanaged Linux VPS (e.g., Hetzner, DigitalOcean, Oracle Cloud Free Tier) using Docker or Cloudflare Tunnels (`cloudflared`).

> 🛡️ **OFFICIAL NOTICE ON THIRD-PARTY FORKS & PAID SERVICES:**
> - **100% Free & Open-Source:** This project is, and will always remain, completely free and open-source under the MIT license. **There are NO paid subscriptions, NO device limits, and NO license keys.**
> - **Unauthorized Monetization:** If any third-party fork, website, or instance claims to be this addon while selling "premium access", "license keys", or monthly subscriptions (e.g., via PayPal or crypto), **they are NOT affiliated with, supported by, or endorsed by this project**.
> - **Content Scope:** This addon exclusively indexes public live sports fixtures. The official repository does not distribute or endorse adult content, shock media, or paid pirated IPTV bundles.
> - **Official Support:** The only official repository is [github.com/rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin). Voluntary community support is solely via [Ko-fi](https://ko-fi.com/rajodedara).

> ☕ **Enjoying AIOSports?** Consider [supporting this fork on Ko-fi](https://ko-fi.com/mlp20), or [the upstream project](https://ko-fi.com/rajodedara) it is built on to help cover maintenance, dedicated scrapers, and infrastructure!

A production-grade live sports streaming add-on for [Nuvio](https://nuvio.tv) and [Stremio](https://www.stremio.com/). It serves as a powerful multi-source aggregator that provides native live sports streams (Football, Basketball, Motorsport, Cricket, and more) inside your client, utilizing an advanced internal stream resolver to bypass CORS restrictions.

---

## 📱 App Preview & Screenshots

<p align="center">
  <img src="docs/screenshots/nuvio-live-soccer.jpg" alt="Live Sports & Soccer Catalog" width="100%">
</p>

| 🏎️ F1 & Baseball Catalogs | ⚡ 1080p Direct Stream Picker | ⚙️ Addon Details & Luffy Logo |
|:---:|:---:|:---:|
| <img src="docs/screenshots/nuvio-sports-catalog.jpg" width="100%" alt="F1 & Baseball Catalogs"> | <img src="docs/screenshots/nuvio-stream-selector.jpg" width="100%" alt="Direct Stream Selector"> | <img src="docs/screenshots/nuvio-addon-details.jpg" width="100%" alt="Addon Details"> |

---

## 🚀 Self-Hosting Guides (Recommended)

### Option 1: Docker / Docker Compose (Easiest for Servers & Raspberry Pi)

Run the addon container in seconds:

```bash
# Clone the repository
git clone https://github.com/mlp2069/aiosports.git
cd live-sport-plugin

# Start the container in background
docker compose up -d
```

The addon is now available at `http://localhost:7000` (or `http://YOUR_SERVER_IP:7000`).

---

### Option 2: Local Node.js (Same Wi-Fi / Local Network or Cloudflare Tunnel)

1. **Install and run the addon:**
   ```bash
   git clone https://github.com/mlp2069/aiosports.git
   cd live-sport-plugin
   npm install
   npm run build
   npm start
   ```

2. **Access from other Devices on the Same Wi-Fi (Phone, TV, another Laptop):**
   - Find your host computer's local IPv4 address:
     - **Windows:** Open Command Prompt (`cmd`) and type `ipconfig` (look for `IPv4 Address`, e.g., `192.168.1.50`).
     - **Mac / Linux:** Open Terminal and type `ifconfig` or `ip a` (e.g., `192.168.1.50`).
   - On any phone/tablet/laptop connected to the same Wi-Fi, open your browser:
     ```
     http://<YOUR_IPV4_ADDRESS>:7000/configure
     ```
     *(Example: `http://192.168.1.50:7000/configure`)*
   - Configure your settings, copy the link, and paste into Nuvio / Stremio!

3. **(Optional) Expose Outside Home via Cloudflare Tunnel (`cloudflared`):**
   - Download [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
   - Run a quick tunnel:
     ```bash
     cloudflared tunnel --url http://127.0.0.1:7000
     ```
   - Open `https://your-tunnel-url.trycloudflare.com/configure` and install anywhere outside your home network!

*(Alternative: You can also use [Ngrok](https://ngrok.com) by running `ngrok http 127.0.0.1:7000`).*

---

### Option 3: Linux VPS with PM2 (Production 24/7)

```bash
# Clone and build
git clone https://github.com/mlp2069/aiosports.git
cd live-sport-plugin
npm install
npm run build

# Install PM2 and start the service
npm install -g pm2
pm2 start dist/index.js --name "nuvio-sports"
pm2 save
pm2 startup
```

---

## 🔐 Sign-in and the Dashboard

`AUTH_KEY` is optional: leave it unset and the pages stay open. `ADMIN_TOKEN` is
not optional for the dashboard -- leave it unset and the dashboard is closed to
everyone, including you.

| Variable | Guards | Leave empty and… |
|---|---|---|
| `AUTH_KEY` | the catalog at `/` and `/configure` | anyone with the link can browse |
| `ADMIN_TOKEN` | `/dashboard` and anything that changes state | the dashboard stays closed — there is no address-based fallback |

Put them in a `.env` file beside `docker-compose.yml`:

```bash
cp .env.example .env
# then edit .env and set:
#   AUTH_KEY=something-long
#   ADMIN_TOKEN=something-else-long
```

Both the app and Docker Compose read that file, so the same `.env` works whether
you run `docker compose up -d` or `npm start`.

**Check it took.** The startup log prints which gates are on:

```
Sign-in   : AUTH_KEY set
Dashboard : ADMIN_TOKEN set
Proxies   : trust proxy = loopback/private only (default)
```

If either says `NOT SET` and the port is reachable from the internet, it is open.
That line exists because an unset key fails *open*, and your own browser is shown
a login page either way — so the only way to notice used to be from another
machine.

> **`ADMIN_TOKEN` is required to reach the dashboard.** With no token it is simply
> shut. There is deliberately no "but you look like you're on my network"
> exception: under Docker every request arrives from the bridge gateway, which is
> itself a private address, so that exception let the whole internet in.

Visiting the site then lands on `/login`, and signing in takes you to the
catalog. The gear icon in the header opens the dashboard, which asks for
`ADMIN_TOKEN` separately — being allowed to browse does not mean being allowed
to clear a cache. `ADMIN_TOKEN` works for both, so you never type two passwords.

Sign-in leaves an `HttpOnly` cookie holding a signature over its own expiry,
keyed by the password. The password itself is never in the cookie, so a stolen
one cannot be turned back into it. Eight failed attempts from an address buys a
five-minute pause — which applies to the correct password too, since refusing to
check it is the point.

### What is deliberately *not* behind a password

The addon's own endpoints — `manifest.json`, catalogs, metadata, streams and
`/img` artwork. Nuvio and Stremio have no way to sign in, so gating those would
simply stop the addon working. What stays reachable to somebody holding your URL
is fixtures and pictures of crests: no settings, no state, nothing personal.

If you need the addon itself private, that is a job for the layer in front of
it — an IP allowlist or a VPN — not for this application.

### Behind a reverse proxy

If you put a proxy (Caddy, nginx, Traefik) in front, the addon must be told, or
every visitor arrives wearing the proxy's address. It trusts `X-Forwarded-For`
only from proxies on loopback or a private range, which is the usual arrangement
and needs no configuration.

A proxy on a public address needs `TRUST_PROXY` set — a hop count (`TRUST_PROXY=1`)
or a comma-separated list of proxy addresses/CIDRs. Set the narrowest value that
works, and be sure the addon's own port is not reachable directly first.

Do not set it to `true`. That makes `req.ip` whatever the caller writes in a
header, which defeats the per-address throttle on failed sign-ins.

---

## 🗂️ Catalog Tabs

| Tab | Holds |
|---|---|
| 🔴 Live Now | fixtures in progress — channels are not mixed in |
| ⚽ Soccer | association football |
| 🏈 NFL | the NFL alone |
| 🏈 Other Football | the CFL, the AFL, and gridiron whose league cannot be named |
| 🎓 College | college fixtures of any sport, badged with the ball it is played with |
| 🏉 Rugby | badged per competition: NRL, Premiership, URC, Top 14, Super Rugby, test rugby |
| 🏎️ Racing | motorsport |
| 📺 Channels | every always-on channel in one place, including scheduled ones like NFL RedZone |
| 🏏 🏀 🏒 ⚾ 🥊 ⛳ 🎾 🎯 | cricket, basketball, hockey, baseball, MMA, golf, tennis, darts |
| 🏅 Other Sports | anything that fits no tab above |
| ⏱️ Upcoming · ⭐ Your Teams | everything ahead; clubs you follow in `/configure` |

A fixture's competition is derived from the crests of the two sides, so a game
lands in the right tab even when the provider sends no league — which is the
normal case for rugby, and common for the smaller college divisions.

---

## ✨ Key Features

- **🏟️ Multi-Source Live Aggregator:** Concurrently scrapes and unifies live fixtures from 8+ scrapers (Streamed.pk, StreamFree, WatchFooty, SportyHunter, TimStreams, StreamSports99, Streamic, CDNLiveTV) into a deduplicated catalog with merged stream choices.
- **⚡ Coalescing Zero-Lag HLS Manifest Proxy (`/api/manifest`):** High-speed HLS proxy powered by `impit` with persistent keep-alive connections. Coalesces concurrent in-flight upstream requests (`manifestInFlight`) to eliminate duplicate fetches during live player segment polls and prevent ISP/upstream throttling.
- **🔐 Native WebAssembly (WASM) Decryption:** Executes native WebAssembly binaries (`stream-lock.wasm`, `gasm.wasm`, `gasm_india.wasm`) directly in Node.js to decrypt obfuscated tokens and unlock protected third-party stream endpoints.
- **🌐 Universal Dynamic Host Routing:** Zero hardcoded local IPs. Automatically inspects incoming `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `cf-visitor` headers to dynamically rewrite all manifests, streams, and asset URLs to match the client's gateway (local LAN, Cloudflare Tunnels, Ngrok, or custom domains).
- **🛡️ Opossum Circuit Breakers & Negative Caching:** Every provider scraper is isolated via an Opossum circuit breaker to instantly trip on timeouts or failures. Dead upstreams are negatively cached for 15s so video players seamlessly fail over to alternate sources without freezing.
- **🖼️ Resilient 100% 200 OK Image Pipeline (`/img`):** High-performance image proxy with LRU caching (`stale-while-revalidate`), protocol-relative normalization (`//`), and dynamic inline SVG fallback cards to ensure clients never encounter broken posters or missing team crests.
- **🧠 Algorithmic Stream Scoring & Ranking:** Evaluates and sorts stream links in real time based on resolution (1080p > 720p > SD), latency, direct M3U8 vs. webview embeds, audio commentary language, and live viewer counts.
- **🧱 Clean Architecture & Awilix IoC:** Built with Domain-Driven Design (DDD) entities (`MatchEntity`, `StreamEntity`), modular service layers, and an Awilix Inversion of Control (IoC) dependency injection container.
- **📄 Declarative YAML Provider Engine:** Includes a dynamic `YamlProviderBuilder` allowing developers to configure and plug in new stream scrapers via declarative YAML definitions without writing boilerplate.
- **⚙️ Responsive Glassmorphic Web UI:** A browser catalog (`/`) and a configuration interface (`/configure`) to filter sports categories, toggle active providers, order stream sources, localize match kickoffs to your timezone, and track favorite clubs.
- **📊 Operations Dashboard (`/dashboard`):** Cache sizes and hit rates, warming progress, event count, memory and uptime, with controls to warm or clear the caches. Behind its own password.
- **🖼️ Crest-Built Match Cards:** Posters are drawn from both teams' crests and rasterised to JPEG server-side, because clients do not render SVG posters. The corner badge is the competition, worked out from the crests themselves rather than from whatever a provider called the league — which is how rugby, the CFL and college fixtures get the right mark when the feed names no league at all.
- **🔥 Poster Cache Warming:** Cards are rendered ahead of time, one at a time with a pause, at startup and every six hours. A tab is hundreds of cards; rendering them on demand pegged a two-core host, and rendering them slowly in advance does not.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Runtime & Core** | [Node.js](https://nodejs.org/) (v22+ LTS), [Express.js](https://expressjs.com/) |
| **Addon Protocol** | [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk) (Stremio v1 Protocol) |
| **Architecture & IoC** | [Awilix](https://github.com/jeffijoe/awilix) (Dependency Injection / IoC Container), Domain-Driven Design (DDD) |
| **High-Performance HTTP & TLS** | [Impit](https://github.com/impit-dev/impit) (Native HTTP client with TLS/browser fingerprint impersonation), [Undici](https://undici.nodejs.org/) |
| **WASM Decryption Engines** | Native WebAssembly execution (`stream-lock.wasm`, `gasm.wasm`, `gasm_india.wasm`) |
| **Scraping & DOM Extraction** | [Cheerio](https://cheerio.js.org/), [Happy DOM](https://github.com/capricorn86/happy-dom), [jsdom](https://github.com/jsdom/jsdom), [got-scraping](https://github.com/apify/got-scraping) |
| **Resilience & Fault Tolerance** | [Opossum](https://nodeshift.dev/opossum/) (Circuit Breakers), In-Flight Request Coalescing, Negative Cache Maps |
| **Streaming & Playlists** | [m3u8-parser](https://github.com/videojs/m3u8-parser), Dynamic M3U8 segment rewriter |
| **Background Scheduling** | [node-cron](https://github.com/node-cron/node-cron) (Periodic match aggregator sync) |
| **Encoding & Compression** | [lz-string](https://github.com/pieroxy/lz-string) (URL-safe base64url configuration compression) |
| **Production Bundler** | [@vercel/ncc](https://github.com/vercel/ncc) (Single CJS distribution with native WASM asset copying) |

---

## 📋 Prerequisites

Before setting up the project locally:
- **Node.js**: Version `22.0.0` or higher (LTS recommended)
- **npm**: Version `10.0.0` or higher (bundled with Node.js)
- **Git**: Installed and accessible from your terminal

---

## 🚀 Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Start development mode with native watch reload
npm run dev

# 3. Build for production (bundles with @vercel/ncc and copies WASM runtimes)
npm run build

# 4. Launch the compiled production server
npm start

# 5. Scaffold a new scraper from template
npm run generate:provider
```

---

## 🎛️ Configuration Options

Through the interactive `/configure` UI (or via URL-safe base64 config segments), you can customize:
- **Sports Filtering:** Select from 14+ sports categories (Soccer, Basketball, Cricket, F1 & Racing, NFL, Hockey, Baseball, MMA, Golf, Tennis, Rugby, College Sports, Darts, Other).
- **Streaming Sources Selection:** Individually enable or disable scrapers (StreamFree, TimStreams, Streamed.pk, SportyHunter, WatchFooty, CDNLiveTV, StreamSports99, Streamic).
- **Localization & Timezones:** Auto-detects or manually configures your local IANA timezone to render match kick-off schedules in your local time.
- **Priority Tracking ("⭐ Your Teams"):** Enter comma-separated favorite clubs or athletes (e.g. `Arsenal, Lakers, Ferrari`) to dynamically generate a dedicated priority catalog.

---

## 🧪 Testing & Verification Suites

The project features a multi-tiered test suite including unit tests, adversarial stress tests, and automated Stremio client simulations:

```bash
# Run unit & service test suites with Jest
npm test

# Run simulated Stremio client E2E test (verifies manifest, catalogs, and streams)
npm run test:e2e-client

# Run live upstream scraper health check across all providers
npm run check-sources

# Validate 24/7 channel and live TV endpoints
npm run test:247
```

---

## 📄 License & Disclaimer

This project is licensed under the [MIT License](LICENSE).

- **Personal & Educational Use:** This software is an experimental media aggregator and protocol scraper developed solely for personal, non-commercial, and educational purposes.
- **No Hosting of Media:** This addon does not host, broadcast, or store any video content or media streams on its own servers. It merely parses publicly reachable web manifests.
- **Third-Party Integrity:** The authors assume no liability for unofficial third-party forks, paid reseller bundles, or modified distributions operating under independent domains.

