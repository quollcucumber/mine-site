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
cp .env.example .env
# Set XMR_WALLET in .env
npm run build
npm start
```

The server listens on `http://localhost:8080` by default. `npm run dev` runs
the server and Vite development server together.

Environment variables:

* `POOL_HOST` — Stratum host (default `pool.supportxmr.com`)
* `POOL_PORT` — Stratum TCP port (default `3333`)
* `XMR_WALLET` — wallet address; required to enable mining
* `PORT` — HTTP port (default `8080`)

## Deploying to Render

`render.yaml` defines a free-tier Node web service (Render requires a card for
identity verification). Choose **New → Blueprint**, pick this repo, and set
`XMR_WALLET` when prompted.

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
XMR_WALLET=44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A npm run cf:deploy
```

## Verifying RandomX

Verify the known RandomX test vector with:

```sh
npm test
```

## License

MIT; see [LICENSE](LICENSE).
