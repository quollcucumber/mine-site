# Mine Site

Mine Site is a small, transparent site template with an **opt-in** Monero
RandomX miner. Mining is off by default, never starts automatically, and the
on/off choice is not persisted across page loads. The UI explains what is
happening and exposes thread and CPU-throttle controls.

When enabled, the browser mines Monero for the site owner using the visitor's
CPU. Mining runs only while the tab is open and the toggle is on. RandomX
workers use roughly 256 MB of memory per thread.

Hashing is provided by the
[`randomx.js`](https://www.npmjs.com/package/randomx.js) package, a
BSD-3-Clause-licensed JavaScript/WebAssembly implementation.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars
# Set XMR_WALLET in .dev.vars
npm run dev
```

The local Cloudflare Worker listens on `http://localhost:8787`. Mining is
anonymous by default, while signed-in users receive leaderboard credit for
pool-verified shares and a capped live score from reported browser work.

Environment variables:

* `POOL_HOST` — Stratum host (default `pool.hashvault.pro`; SupportXMR remains a configurable alternative)
* `POOL_PORT` — Stratum TCP port (default `3333`)
* `XMR_WALLET` — wallet address; required to enable mining
* `POOL_FIXED_DIFF` — optional fixed pool difficulty login suffix (default `20000`; HashVault honours this with a minimum of 20000)

## Accounts and leaderboard

Create an account or sign in from the header. Anonymous mining remains
available, but only signed-in miners are credited. The server is the source of
truth: points equal reported hashes while signed in plus 20,000 points for
each pool-verified share. Reported progress remains capped and unverified
until a share is accepted; pool verification adds the share bonus without
replacing the live score. Passwords are hashed with
PBKDF2-SHA256 in a SQLite-backed Durable Object, and session cookies are
HttpOnly, Secure, and expire after 30 days.

Mining payouts use the configured HashVault wallet. Check your payout and
statistics on your wallet page on `monero.hashvault.pro`.

## Deploying to Cloudflare Workers (free, no card)

Create an account at https://dash.cloudflare.com and create an API token using
the **Edit Cloudflare Workers** template. Find the Account ID on the Workers &
Pages overview page. Add these GitHub Actions secrets to the repository:

* `CLOUDFLARE_API_TOKEN`
* `CLOUDFLARE_ACCOUNT_ID`
* `XMR_WALLET` (optional until you have a wallet; the site deploys with mining disabled)

The `Deploy to Cloudflare` workflow builds the site and deploys it on every
push to `main`, or from the Actions tab with **Run workflow**. The first
deploy makes the site available at
`https://mine-site.<subdomain>.workers.dev`.

For a local deployment, authenticate with Wrangler and deploy with:

```sh
npx wrangler login
wrangler secret put XMR_WALLET
wrangler secret put POOL_FIXED_DIFF
npm run cf:deploy
```

`npm run dev` builds the frontend and starts Wrangler on port 8787. For local
secrets, create `.dev.vars` with `XMR_WALLET` and optionally
`POOL_FIXED_DIFF`; this file is ignored by git.

The account API is available at `POST /api/register`, `POST /api/login`,
`POST /api/logout`, `GET /api/me`, and `GET /api/leaderboard`.

## Verifying RandomX

Verify the known RandomX test vector with:

```sh
npm test
```

## License

MIT; see [LICENSE](LICENSE).
