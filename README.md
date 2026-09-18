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

## Verifying RandomX

Verify the known RandomX test vector with:

```sh
npm test
```

## License

MIT; see [LICENSE](LICENSE).
