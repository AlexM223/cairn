# Cairn

**Your bitcoin. Your rules.**

Cairn is a self-hosted Bitcoin command center — a block explorer, watch-only
wallet navigator, and multi-user instance you run yourself. A cairn is a
waymarker: a stack of stones marking the path.

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
