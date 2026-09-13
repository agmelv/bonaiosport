# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately
instead: open the **Security** tab of this repository and choose
**Report a vulnerability**, or go straight to
<https://github.com/mlp2069/aiosports/security/advisories/new>.

Include what you found, how to reproduce it, and the version or commit you ran
(`/api/version` on a running server shows it). Expect a first reply within a
week.

## Supported versions

Fixes go into `main` and the next release. Older releases are not patched, so
update before reporting if you can.

## Scope

In scope: the addon server in this repository, including the internal resolver,
the configure page, the dashboard and the Docker setup.

Out of scope: the third-party websites that streams come from, and servers run
by other people.

## Keeping your own server safe

- Set `AUTH_KEY` and `ADMIN_TOKEN` to long random values, for example the output
  of `openssl rand -base64 24`. Eight wrong guesses from one address pause
  sign-in for five minutes.
- Serve it over https, through a reverse proxy or a Cloudflare Tunnel, and don't
  leave the plain port open to the internet if a proxy is in front.
- Update regularly: `git pull && docker compose up -d --build`.
- Don't post your server's address publicly. The addon fetches playlists and
  artwork on its viewers' behalf, so every viewer's traffic goes through your
  connection.
