# Cairn

**Your bitcoin. Your rules.**

Cairn is a self-hosted Bitcoin command center — a block explorer, watch-only
wallet navigator, and multi-user instance you run yourself. A cairn is a
waymarker: a stack of stones marking the path.

|                                                                       |                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ![Dashboard — block height, fees, recent blocks](docs/screenshots/dashboard.png) | ![Block detail — header fields and transaction list](docs/screenshots/block-detail.png) |
| ![Mempool visualizer — projected next blocks](docs/screenshots/mempool-blocks.png) | ![Watch-only wallet — balance, receive address, history](docs/screenshots/wallets.png) |

## Features (v1)

- **Block explorer** — blocks, transactions, addresses, mempool, and fee
  estimates, with universal search.
- **Wallet navigator** — import an xpub/ypub/zpub watch-only wallet, see
  balances, address usage, transaction history, and generate receive
  addresses with QR codes. Private keys never touch the server.
- **Multi-user** — email/password accounts with invite codes. The first
  account becomes the administrator.
- **Admin panel** — user management, invite creation, registration modes
  (open / invite-only / closed), and node configuration.
- **Works without your own node** — public Electrum + Esplora servers by
  default; point it at your own Fulcrum/electrs and mempool instance from
  the admin panel, applied live without a restart.

## Stack

- [SvelteKit](https://svelte.dev/docs/kit) + TypeScript (UI and API in one app)
- `node:sqlite` — no external database, no native addons
- Electrum protocol client (TCP/TLS) + Esplora-compatible HTTP for rich
  explorer data
- [@scure/bip32](https://github.com/paulmillr/scure-bip32) for key derivation

## Running

Requires Node.js 22.5+ (uses the built-in `node:sqlite`).

```sh
npm install
npm run dev        # development, http://localhost:5173
```

```sh
npm run build      # production build (adapter-node)
node build         # serve it
```

The SQLite database lives in `./data/cairn.db` (override with the
`CAIRN_DB` environment variable). Back that file up and you've backed up
the instance.

## Deployment

The recommended way to run Cairn in production is Docker:

```sh
docker compose up -d --build
```

That builds the image, starts the app on <http://localhost:3000>, and
mounts `./data` into the container at `/data` for the SQLite database.
Prefer a named volume? Swap the mount in `docker-compose.yml` — the
comments show how.

> **Mount something at `/data`.** Without a volume the database lives in
> the container's writable layer and is gone the moment the container is
> replaced — along with every account, wallet, and invite.

Environment variables (defaults baked into the image):

| Variable         | Default          | Meaning                                                          |
| ---------------- | ---------------- | ---------------------------------------------------------------- |
| `CAIRN_DB`       | `/data/cairn.db` | Path to the SQLite database file.                                 |
| `PORT`           | `3000`           | Port the Node server listens on.                                  |
| `ADDRESS_HEADER` | `x-forwarded-for` | Header the server trusts for the client IP (see below).          |

`ADDRESS_HEADER=x-forwarded-for` makes the login rate limiter see real
client IPs instead of the proxy's. Only run the container behind a
reverse proxy that **sets or overwrites** `X-Forwarded-For` — if clients
can reach the port directly, they can spoof the header; unset the
variable in that case.

Reverse-proxy note: live updates use Server-Sent Events, so response
buffering must be off for `/api/events`. Cairn already sends
`X-Accel-Buffering: no` (nginx honors it out of the box); for other
proxies, disable buffering for that route.

Liveness: `GET /api/health` is unauthenticated and returns
`{"status":"ok"}` (or 503 when the database is unhappy). The image ships
a `HEALTHCHECK` that probes it.

Locked out? See [docs/RECOVERY.md](docs/RECOVERY.md).

## First run

1. Open the app — you'll land on **Create account**. The first account is
   automatically the administrator; no invite needed.
2. By default the instance uses public servers
   (`electrum.blockstream.info:50002` + `mempool.space`). Change this under
   **Admin → Settings → Node connection**.
3. Create invite codes under **Admin → Invites** to let others in.

## Configuration notes

- **Electrum server** — serves wallet balances and history. Fulcrum,
  electrs, and ElectrumX all work (TCP or TLS).
- **Esplora API** — serves block/mempool detail the Electrum protocol
  can't provide (block transaction lists, fee ranges, mempool totals). A
  self-hosted [mempool](https://mempool.space/docs) instance works, as does
  `https://blockstream.info/api` (with some fields gracefully degraded).
- **Bitcoin Core RPC** — optional, stored for upcoming features.
