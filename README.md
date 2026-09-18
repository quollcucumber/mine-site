---
title: Mine Site
emoji: "⛏"
colorFrom: gray
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

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

## Deploying to Hugging Face Spaces (free, no card)

The README front matter and `Dockerfile` make this repo a Docker Space.

1. Create a Space at https://huggingface.co/new-space (SDK: **Docker**, blank template).
2. In the Space **Settings → Variables and secrets**, add the secret `XMR_WALLET`.
3. Push this repo to the Space, either manually
   (`git push https://huggingface.co/spaces/<user>/<space> main`, using a write
   token as the password) or automatically via `.github/workflows/sync-to-hf.yml`:
   in the GitHub repo add the secret `HF_TOKEN` (a Hugging Face write token) and
   the variable `HF_SPACE` (`<user>/<space>`).

The Space builds the image and serves the site on its public URL.

## Deploying to Render

`render.yaml` defines a free-tier Node web service (Render requires a card for
identity verification). Choose **New → Blueprint**, pick this repo, and set
`XMR_WALLET` when prompted.

## Verifying RandomX

Verify the known RandomX test vector with:

```sh
npm test
```

## License

MIT; see [LICENSE](LICENSE).
