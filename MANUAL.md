# Cairn / Heartwood — Developer Manual

## How to use this manual

This manual documents the working tree of `C:\dev\cairn` on branch
`single-sig-full-wallet`, as of **2026-07-12** (re-verified through commit
`96cd16a`, the QR-scanner extraction — see §9/§15 gotcha #13 — with the
nav/back-button fix series `4b98a1e`/`7fbbdd4`/`d22888c`/`a19dfa2` and the
BIP21 parser `41545b9` folded in). It was written by reading the source
directly (chain layer, wallet/PSBT logic, database/auth/API, client routes
and design system, and the ops/packaging surface) and cross-checking claims
against actual files and `git log`.

Two things to know before you rely on it:

1. **This doubles as a QA baseline.** Where this manual describes a behavior
   and the running app disagrees, that is a lead worth filing a bead for —
   one of the two is wrong, and it's usually worth finding out which. Section
   15 ("Gotchas, Contradictions & Stale Docs") is a running list of exactly
   this kind of drift already found in the docs, the codebase, and between
   the two.
2. **One specific piece of drift happened during the writing of this
   manual.** At the start of this research pass, `src/lib/server/bitcoin/psbt.ts`
   had an uncommitted working-tree change (a `threshold` parameter added to
   `summarizePsbt` so multisig `complete` status is quorum-aware — see
   §5 and §15). Partway through, that exact change landed as commit
   `a93dd27 fix(psbt): make summarizePsbt complete flag threshold-aware`,
   sitting directly on top of `9fde0a4`. The behavior described below is
   accurate either way (the diff was self-consistent and finished); what's
   no longer accurate is calling it "uncommitted." Treat this as a live
   demonstration of rule #1 above — check `git log -- <path>` before trusting
   any claim in this document about what's committed vs. in-flight.

This document is **Part I** — architecture, code, and behavior as they exist
in the tree today — followed by **Part II: QA Test Runbook** (§16–22), a set
of executable test scenarios built on top of this baseline for a human
tester or an agent driving the GUI. Part II lives immediately after §15
("Gotchas, Contradictions & Stale Docs") below, and several of its scenarios
point back at specific §15 entries for known drift to verify rather than
assume is fixed.

Repo root for every path below: `C:\dev\cairn`. All paths are repo-relative
unless stated otherwise.

---

## 1. What Cairn Is & The Non-Negotiable Invariants

Cairn (product-facing rebrand: **Heartwood**) is a self-hosted Bitcoin
"command center": a single-process SvelteKit application that lets an
operator watch balances, build transactions, and manage single-sig and
multisig wallets from xpubs, while **never holding a private key** anywhere
on the server. Every signature comes from outside the process — a hardware
wallet over WebUSB/WebHID/WebSerial, or an air-gapped file/QR round-trip.
Chain data comes from an operator-controlled Electrum server as the primary
source, with optional Bitcoin Core RPC for explorer-grade detail. There is no
third-party HTTP explorer API anywhere in the path. All durable state lives in
one synchronous `node:sqlite` database.

The name split is deliberate, and the internals half of it is permanent
regardless of how the product-facing half resolves: package metadata, UI
copy, and the Umbrel package directory now say "Heartwood," but the
database file (`cairn.db`), every `CAIRN_*` environment variable, and the
container image (`ghcr.io/alexm223/cairn`) stay `cairn` — renaming them in
place would orphan every existing install's data. New `HEARTWOOD_DB` /
`HEARTWOOD_LOG_FILE` env-var aliases were added *alongside* the `CAIRN_*`
ones, not instead of them. Don't "fix" the internals-vs-branding
inconsistency; it's load-bearing. What is **not** yet settled: the
Umbrel/App-Store operational identity (app ID, listing, whether this is a
rename of the existing `cairn` listing or a new one) is an open decision,
not a closed one — tracked in `cairn-koy4.13`, blocked on Alex. Don't treat
the app-store identity as final until that bead closes. (See §12, §15.)

### The five invariants

These are the rules that keep Cairn from being a wallet that lies to you or
loses money. If a change you're making would violate one of these, stop and
reconsider — these aren't style preferences.

1. **The server never holds private keys.** PSBTs are built and serialized
   from Electrum-derived UTXO data using `@scure/btc-signer`; signing always
   happens externally. Cairn deliberately never uses Bitcoin Core's *wallet*
   RPCs for coin selection or fee math — everything is computed independently,
   even when Core is configured as a data backend (`src/lib/server/bitcoin/psbt.ts`
   file header).
2. **PSBTs are commitment-checked before broadcast.**
   `assertSameTransaction(draftPsbt, signedPsbt)` refuses to broadcast a
   returned "signed" PSBT whose inputs or outputs don't match, byte-for-byte,
   what the user reviewed in the draft. After broadcast, the *reported* txid
   from Electrum is checked against the locally, deterministically computed
   txid — a lying or buggy Electrum server claiming a fake success txid is
   refused, not trusted (`cairn-ziwm`).
3. **Electrum data is SPV-verified before any payment notification ever
   fires.** The Electrum *pool* is many sockets to **one** server, not
   independent sources — so before the address watcher tells a user "you got
   paid" or "your payment confirmed," it independently proves the transaction
   sits in a proof-of-work-valid block (merkle proof + a self-calibrating
   difficulty floor), never trusting Electrum's own claim of confirmation.
   This SPV check **fails closed**: no proof means no notification, ever.
   Chain *reachability* problems, by contrast, fail **open** — a stale
   snapshot is served rather than an error page (§4, §9).
4. **Sync SQLite blocks the event loop — treat every DB call as a blocking
   call.** `node:sqlite`'s `DatabaseSync` is fully synchronous; every query
   blocks Node's single thread for its duration. The concrete rule that
   follows: **never `await` inside an open `BEGIN`/`COMMIT`** (a concurrent
   `BEGIN` from another request could interleave and corrupt the
   transaction — see the comment on `registerUserWithHash` in
   `src/lib/server/auth.ts:454-474`), and precompute any async values (like
   password hashing via `scryptAsync`, which runs on the libuv threadpool
   rather than the main thread) *before* opening a transaction.
5. **`initReady` gates every request.** `src/hooks.server.ts`'s `handle()`
   awaits a module-scope `initReady` promise as its literal first line. That
   promise resolves only once the entire boot sequence — migrations, admin
   bootstrap, chain-config seeding, watchers, first-sync, retention sweeps —
   has completed. A cold-cache Electrum retry storm at process start delays
   *every* request, not just chain-dependent ones; this was a real, measured
   cold-start symptom (see §4, §15).

---

## 2. High-Level Architecture

Cairn runs as one Node process under a **custom `server.mjs`** — not
adapter-node's own server — because it needs a second, self-signed-TLS
listener alongside plain HTTP (hardware-wallet USB access and camera-based
QR scanning both require a secure browser context, and Umbrel serves apps
over plain HTTP by default). Requests flow from the browser through
SvelteKit's `handle()` hook, into route loaders/actions or JSON API
endpoints, down through domain service modules, and finally through one
chain-data facade that talks to the Bitcoin backends.

### Layers, top to bottom

```
Browser (Svelte 5 runes, Heartwood evergreen CSS — dark default + light mode, HW drivers in src/lib/hw/*)
   │  fetch / form actions (?/action via safeAction) / SSE (single multiplexed /api/live stream)
   ▼
SvelteKit edge: src/hooks.server.ts  handle()
   │  await initReady (gate) → locals.user + locals.flags → access gates → CSP/headers → request log
   ▼
Routes:  src/routes/(app)/**  (+page.server.ts loaders & form actions)
         src/routes/api/**/+server.ts  (~100 JSON endpoints; guards from src/lib/server/api.ts)
   ▼
Domain services: src/lib/server/**
   wallets.ts / wallets/multisig.ts, transactions.ts / multisigTransactions.ts,
   spendLifecycle.ts (shared lifecycle engine), feeBump.ts,
   bitcoin/{psbt,multisigPsbt,xpub,multisig}.ts, auth.ts, notifications.ts,
   featureFlags/*, walletSync.ts / chainSync.ts (SWR), addressWatcher.ts
   ▼
Chain facade: src/lib/server/chain/index.ts  (ChainService singleton, getChain())
   ├─ Electrum pool (electrum/pool.ts → N × electrum/client.ts sockets)   [PRIMARY]
   └─ Bitcoin Core RPC (bitcoinCore/client.ts)                            [optional, explorer detail]
   ▼
Bitcoin network:  operator's Electrum/electrs + bitcoind (Umbrel), or public Electrum
```

### Where state lives — three tiers, don't confuse them

**1. SQLite (`cairn.db`, durable).** The single source of truth, roughly 40
tables (full inventory in §6): auth/identity, single-sig `wallets` /
`transactions`, multisig (`multisigs` / `multisig_keys` / `multisig_transactions`),
collaborative-custody tables (`contacts` / `multisig_shares` /
`multisig_transaction_signers`), `settings` plus encrypted `instance_secrets`,
`feature_flags`, the `events` table (activity feed and in-app notifications
share it), notification-delivery plumbing, and a family of pure
**cache/snapshot** tables (`wallet_snapshots`, `chain_snapshot`,
`portfolio_snapshot`, `balance_snapshots`, `mempool_samples`, `tx_snapshots`,
`wallet_scan_cache`) whose defining property is that a missing row always
just falls back to a live scan — they can be safely wiped. The
secret-encryption key (`instance.key`) intentionally lives *beside* the DB
file, never inside it.

**2. In-memory (per-process, lost on restart).** The Electrum pool's sockets
and subscriptions; `src/lib/server/chain/cache.ts`'s TTL caches (tip cached
10 minutes but invalidated instantly on every `header` event; fee estimates
30 seconds; a 200-entry raw-tx LRU); `chainHealth.ts`'s health signal; the
address watcher's rolling tip/difficulty-floor cache; the single-flight and
throttle maps in `chainSync.ts` / `walletSync.ts`; the client's toast queue.

**3. `sessionStorage` / `localStorage` (per browser tab).** Wizard resume
snapshots (public key material only — never a secret), `HowItWorks`
collapse state, the secure-redirect opt-out flag, backup-banner dismissal.
Wizards keep their authoritative state in local Svelte runes and mirror it
to `sessionStorage` purely as a resume aid, never as the source of truth.

### The request lifecycle through `hooks.server.ts`

Every request passes through `handle()` in this order:

1. `await initReady` (see §1 invariant 5, and the boot sequence in §4).
2. Static-asset fast path — skips session/flag lookups entirely for assets.
3. Admin-mutation backstop: any non-GET/HEAD request under `/admin*` is
   blocked unless `locals.user.isAdmin`, as defense-in-depth (SvelteKit's own
   form `actions` skip the parent layout's `load()`, so a route-level
   `requireAdmin()` alone had a real gap once — three admin actions shipped
   reachable-unauthenticated before this backstop existed).
4. Legacy `/vaults` → `/wallets` (or `/multisig`) 301 redirect (post-rebrand
   from the old "vault" terminology).
5. `(app)` route-group access gates via `appGateRedirect` — forced password
   reset, disclosure/agreement acceptance, recovery setup.
6. Security headers (CSP, widened per `httpsExternalPort()` to allow the
   self-signed-HTTPS probe fetch), then structured request logging.

---

## 3. Directory Structure Walkthrough

A quick map so you know where to look before grepping blind.

| Path | What lives there |
|---|---|
| `src/routes/(app)/**` | Authenticated app shell: dashboard, wallets, multisig, explorer, settings, admin. Page loaders (`+page.server.ts`) and form actions. |
| `src/routes/(auth)/**` | Login, signup, account recovery — unauthenticated flows. |
| `src/routes/api/**/+server.ts` | ~100 JSON API endpoints, guarded by `src/lib/server/api.ts` helpers. |
| `src/routes/agreement/`, `terms/`, `disclosure/`, `setup-admin/`, `sync/`, `logout/` | Standalone top-level routes outside the two route groups. |
| `src/lib/server/**` | All server-only domain logic: DB, auth, wallets, transactions, chain facade, notifications, feature flags, secrets. Never imported client-side. |
| `src/lib/server/chain/` | `index.ts` (`ChainService` facade), `cache.ts`, `pools.ts`. |
| `src/lib/server/electrum/` | `client.ts` (single-socket protocol client), `pool.ts` (N-socket pool with lanes). |
| `src/lib/server/bitcoinCore/` | `client.ts` — Bitcoin Core JSON-RPC client. |
| `src/lib/server/bitcoin/` | `psbt.ts` (single-sig PSBT construction + shared spend rules), `multisigPsbt.ts`, `xpub.ts`, `multisig.ts`, `signingMass.ts`, plus `vaultRegtestE2E.test.ts` (the gated live-regtest test). |
| `src/lib/hw/` | Browser-side hardware-wallet drivers (`trezor.ts`, `ledger.ts`, `bitbox02.ts`, `jade.ts`, `jadeUr.ts`, `bbqr.ts`, `keyOrigin.ts`, `qrScan.ts`, `common.ts`). Deliberately free of server imports — this is the client/server boundary for signing logic. |
| `src/lib/components/` | Shared Svelte components: banners, toasts, `DevicePicker`, `NotificationPanel`, etc. |
| `src/lib/components/heartwood/` | The bespoke design-system components (`GroveField`, `HWRail`, `QuorumArc`, `ChainStrip`, `EpochDial`, …). |
| `src/lib/components/signing/` | Shared per-hardware-device signer UI (`TrezorSigner.svelte`, `LedgerSigner.svelte`, `BitboxSigner.svelte`, `JadeUsbSigner.svelte`, `SecureContextHelp.svelte`). |
| `src/lib/shared/` | Small shared pure-logic modules used by more than one route (e.g. `signingMass.ts` — see §15 for the route-local duplicate to watch out for). |
| `packaging/umbrel/heartwood/` | Current staging copy of the Umbrel store package (`umbrel-app.yml`, `docker-compose.yml`). |
| `scripts/` | `tls-cert.mjs` (self-signed cert generation, loaded standalone by `server.mjs`), `vault-e2e/` (gated regtest+HW-emulator E2E stack). |
| `docs/` | Mix of two publicly-shippable files (`API.md`, `RECOVERY.md`) and many internal plan/audit documents explicitly excluded from any future public repo (see §15 for which ones are stale). |
| `.beads/` | Local-first `br` (beads_rust) issue tracker: `issues.jsonl`, `beads.db*`, `config.yaml`. Every fix in this codebase is expected to have a bead, per project convention. |

---

## 4. Server: The Chain Layer

Every route and service that needs Bitcoin data imports exactly one thing:
`getChain()` from `src/lib/server/chain/index.ts`. That facade hides two
backends behind one API and picks between them by a documented split of
responsibilities, so nothing above it needs to know or care whether the
operator has Bitcoin Core configured.

### Backend responsibilities (deliberate, documented in the facade's file header)

1. **Electrum** (the operator's own server) — tip height, recent block
   headers (no `tx_count`/size/weight — a raw Electrum header doesn't carry
   that), fee estimates, difficulty/hashrate (derived from header `bits`),
   arbitrary address lookups via the scripthash protocol, wallet
   balances/history, raw tx hex, mempool fee histogram and projected blocks.
   This is the **primary** backend and the only one required for the app to
   function at all.
2. **Bitcoin Core RPC** (the operator's own node, optional) — the
   "explorer-rich" views Electrum can't provide: full block/tx detail,
   per-output spent-ness (`gettxout`), mempool summary, CPFP ancestor/
   descendant context. A local-only Umbrel deploy (Core + electrs, no internet
   route) is fully self-sufficient. When Core isn't configured these methods
   throw a clear "needs Core RPC" error (or return `null`) — never a
   third-party fallback.
3. **Public `mempool.space` price endpoint** — the ONE remaining external
   call, and only for the opt-in BTC/USD spot price (neither Electrum nor Core
   exposes a price). TTL-cached, short-timeout, and only fired when a caller
   actually asks for a fiat value. Tracked for a future opt-in/removal decision
   as its own bead (cairn-zoz8.18).

There is no third-party HTTP explorer API (Esplora) anywhere in the path — it
was removed entirely in **cairn-zoz8.16**. `ChainService.core` is `null` when
Core RPC isn't configured; every Core-backed method then throws a clear "needs
Core RPC" error the UI renders as `CoreRpcRequiredNotice`
(`src/lib/components/CoreRpcRequiredNotice.svelte`), or returns `null` where a
null result already degrades cleanly. **A stock Umbrel deploy has `core !==
null`** and a public-Electrum-only install has `core === null` (those Explorer
sections show the honest notice).

### Electrum client — `src/lib/server/electrum/client.ts`

`ElectrumClient` (extends `EventEmitter`) is a single-socket JSON-RPC 2.0,
newline-delimited protocol client over `net`/`tls`, optionally tunneled
through SOCKS5 (the `socks` package) for Tor.

Key constants: `DEFAULT_TIMEOUT_MS = 15_000` (per-request timeout, also the
initial dial/handshake deadline), `KEEPALIVE_INTERVAL_MS = 45_000` (idle-ping
cadence — public Electrum servers cut idle sockets after roughly 90-120s,
this stays comfortably under that), `RECONNECT_MIN_MS = 1_000` /
`RECONNECT_MAX_MS = 30_000` (exponential backoff bounds).

**Connection lifecycle (`ensureConnected`)**: lazily connects on first
`request()`/`batchRequest()`; concurrent callers share one `this.connecting`
promise. Direct TCP, TLS (cert validation on by default; `tlsInsecure` is an
explicit, off-by-default opt-out for self-signed setups — MITM risk is real
without it, `cairn-azei`), or SOCKS5 (`SocksClient.createConnection`, with
TLS negotiated end-to-end over the tunnel so the proxy only ever sees
ciphertext). Critically, **`s.setTimeout(0)` deliberately disables the
socket's own idle timeout** so the app-level keepalive can hold a connection
open indefinitely — which means a **separate `armConnectTimeout()` /
`disarmConnectTimeout()`** timer is the *only* thing bounding the initial
dial. Without it, a backend that black-holes the SYN or the first TLS byte
(no RST) would hang every caller up the stack forever. This was a real,
shipped bug (**cairn-vn48**, "Electrum-freeze"), and the SOCKS5 CONNECT phase
needed its own separate timeout arm too, because `SocksClient`'s own timeout
option doesn't cover the TLS handshake that happens *after* the tunnel is
established (**cairn-ocs9**). On successful dial: sends the `server.version`
handshake, resets backoff, calls `recordChainOk()` (feeds `chainHealth.ts`),
re-subscribes any active header/scripthash subscriptions, starts the
keepalive timer. **Resubscription fans every watched scripthash out
concurrently** over the pipelined socket (`Promise.allSettled`, `cairn-afdy`)
rather than one serial round-trip at a time — a multi-wallet instance no
longer pays reconnect latency proportional to the number of watched
scripthashes (the ARM/Umbrel reconnect-storm pain point). One failed
resubscribe no longer abandons the rest.

**Keepalive**: every 45s, if connected and idle (`pending.size === 0`), sends
`server.ping` via `rawRequest` (not `request` — so a failed ping never
itself triggers a reconnect loop). A failed/missed ping destroys the socket
as a "zombie" (TCP looked established but the peer stopped answering — a
dead NAT mapping), letting the existing disconnect → backoff-reconnect path
take over.

**Disconnect/reconnect**: tears down the socket, rejects all pending
requests. Reconnects **eagerly only if there are active subscriptions**
(headers or scripthash); otherwise the next `request()` call reconnects
lazily. Backoff doubles each attempt, 1s → 30s ceiling. Every reconnect
failure is logged at `warn` (previously invisible at `debug` in prod logs).
The backoff timer is armed **before** `onDisconnect` emits `'disconnect'`, so
by the time any listener (or ambient request) runs, the reconnect state is
already established. **`ensureConnected()` respects that backoff
(`cairn-sp74`, fixed):** if a reconnect timer is already scheduled it
**fails fast** (`"…is backing off; try again shortly"`) instead of dialing a
fresh connection. Before this, any ordinary `request()`/`batchRequest()`
during an outage triggered its own connect attempt regardless of backoff
state, so ambient request traffic (not just the subscription-driven reconnect
loop) hammered a dead server far faster than the 1s→30s schedule implied. The
scheduled attempt now solely owns reconnection; requests flow again the moment
it succeeds.

**Message framing**: buffers by newline, JSON-parses each line, and
defensively rejects non-object payloads (null/array/primitive) rather than
crashing on a `TypeError` from a hostile or buggy server. The unparsed
receive buffer is **capped at `MAX_BUFFER_SIZE = 32 MiB`** (`cairn-32kh`):
after draining complete lines, if the still-incomplete residual exceeds the
cap the peer is streaming an unterminated payload (a memory-exhaustion DoS,
and the eventual `JSON.parse` on a giant line would stall the event loop) —
the socket is destroyed and the normal disconnect/backoff-reconnect path
runs. `maxBufferBytes` overrides the cap (mainly for tests). Dispatch: numeric
`id` resolves/rejects the matching pending-request map entry; no `id` plus a
known method name (`blockchain.headers.subscribe` /
`blockchain.scripthash.subscribe`) is emitted as a `'header'`/`'scripthash'`
event instead.

**Public API surface**: `request`, `batchRequest`, `getBalance`, `getHistory`,
`listUnspent`, `broadcast`, `broadcastPackage` (BIP-331/`submitpackage`
passthrough, degrades silently if unsupported — §4.5), `getTransaction`,
`getMerkleProof` (SPV), `getBlockHeader`, `estimateFee`, `getFeeHistogram`
(mempool fee-rate histogram, sourced locally rather than from a third-party
API), `headersSubscribe`, `subscribeScripthash`, `banner`, `serverFeatures`,
`ping`, `close`. `pendingCount` is read by the pool's lane picker.

### Electrum pool — `src/lib/server/electrum/pool.ts`

`ElectrumPool` wraps N `ElectrumClient` instances (`DEFAULT_POOL_SIZE = 3`,
`MAX_POOL_SIZE = 4`) behind one `ElectrumClient`-shaped facade, so stateless
lookups fan out across sockets instead of queueing on a single pipelined
connection.

- **Primary connection** (`clients[0]`) owns *all* subscriptions and their
  notification events — subscriptions are inherently per-socket, and the
  address watcher / SSE endpoint attach listeners to one `EventEmitter`. The
  pool forwards `connect`/`disconnect`/`header`/`scripthash` from the
  primary as its own events.
- **Lanes** (`'interactive' | 'background'`) solve head-of-line blocking: a
  background gap-limit scan can pipeline ~200 calls and fill every socket,
  starving an interactive request (opening a send page, a tx detail view).
  `background`-lane requests are restricted to `eligibleClients()` = the
  pool minus the last (reserved) socket, whenever pool size > 1;
  `interactive` may use any socket. `backgroundLaneWidth(poolSize) = max(1,
  poolSize - 1)`. `walletSync.ts`'s `SCAN_CONCURRENCY` pegs to
  `DEFAULT_BACKGROUND_LANE_SIZE` — deliberately not `DEFAULT_POOL_SIZE`
  directly, so a future pool-size bump doesn't silently raise scan pressure.
- **Picker** (`pick(lane)`): within the eligible set, picks the client with
  fewest in-flight requests (`pendingCount`), ties broken round-robin so a
  cold pool still fans out evenly.
- All stateless methods accept an optional `lane` param, defaulting to
  `'interactive'` (backward compatible — untouched call sites keep old
  behavior). `broadcast`/`broadcastPackage`/`estimateFee`/`getFeeHistogram`/
  `serverFeatures`/`ping` always use `pick()`'s default lane. Subscription-
  only methods (`headersSubscribe`, `subscribeScripthash`, `banner`) always
  go to `this.primary`.

**Lane tagging is opt-in per call site** — a new bulk/scan code path that
forgets to pass `'background'` will silently compete with interactive
traffic for every socket. Check this whenever adding a new bulk scan.

### Bitcoin Core RPC client — `src/lib/server/bitcoinCore/client.ts`

`CoreRpcClient` — HTTP POST JSON-RPC 1.0-envelope client against `bitcoind`.
The sole source of the explorer-rich detail Electrum can't provide, so a
Core+electrs-only deploy is fully self-sufficient with no third-party API.
`REQUEST_TIMEOUT_MS = 12_000`. Auth: user/password Basic auth, or cookie-file
auth (reads `user:pass` from Core's `.cookie` file, memoized, **re-read from
disk on a 401** since Core rewrites the cookie on every restart — retries once
after refresh). SOCKS5/Tor proxy support via `SocksProxyAgent` using the
`socks5h://` scheme so DNS resolution stays proxy-side (no leak, `.onion` hosts
resolve — `cairn-oh7a`), plus cause-chain unwrapping (`cairn-s17j`) and
`AggregateError.errors` unwrapping for Node's happy-eyeballs multi-address dial
failures. `CoreRpcError` carries Core's numeric error code (`-5`/`-8` =
not found, `-28` = still warming up/IBD) so `ChainService` can branch cleanly
on "not found" vs. a real transport failure. Deliberately **no TTL caching**
in this module ("thin, honest transport" — callers cache where appropriate).
Wrapped RPCs: `getBlockchainInfo`, `getBlockCount`,
`getBlockHash`, `getBlockHeader`, `getBlock` (verbosity 0-3),
`getBlockStats`, `getRawTransaction` (needs `txindex` for arbitrary confirmed
non-wallet txids — errors propagate, not swallowed), `getTxOut`,
`getMempoolInfo`, `getMempoolEntry`, `estimateSmartFee`, `getNetworkHashPs`.
`ping()` never throws (used for the admin "test connection" button).

### `ChainService` facade — `src/lib/server/chain/index.ts` (~1700 lines)

Constructed from `getChainConfig()` (`settings.ts`). Notable methods:

- `getTip()` — TTL-cached (10min ceiling, invalidated instantly on every
  `'header'` event) via `electrum.headersSubscribe()`. **When Electrum is
  unreachable and Core RPC is configured, falls back to `getblockcount` +
  `getblockhash` (cairn-i4pa)** — so the explorer landing page's tip (and
  everything derived from it) doesn't dead-end on a Core-up/Electrum-down
  deployment. The `'header'`-event invalidation is Electrum-only, so in this
  fallback the tip only refreshes on the 10min TTL ceiling — an accepted
  degrade. With no Core RPC configured either, the Electrum error propagates
  unchanged (no fallback available).
- `getRecentBlocks(limit, fromHeight)` — baseline is Electrum headers; txCount/
  size/weight/fees are null unless later enriched by Core (see
  `getBlockStats` below). **Each height's baseline (hash, time) now degrades
  independently via the same `neighborHeader()` Electrum→Core fallback the tx
  block-context uses (cairn-i4pa)** — before this, a single Electrum
  `getBlockHeader` failure rejected the whole batch (`Promise.all`), so a
  Core-up/Electrum-down deployment got an EMPTY landing-page block list even
  though block/tx detail pages already worked Core-only. A height neither
  backend can answer is omitted from the list (never a fabricated row) rather
  than failing the whole page.
- `getBlock` — Core first (`getblockhash` + `getblock` verbosity 1 +
  `getblockstats`); catches `CoreRpcError` codes -5/-8 as "not found". **When
  Core is _not_ configured and the lookup is by HEIGHT, it now falls back to
  `getBlockViaElectrum` (cairn-kcxy)** — a bare `blockchain.block.header`
  decode, the same null-baseline `getRecentBlocks()` already uses: hash/time/
  prevHash/merkleRoot/nonce/bits/difficulty render, but txCount/size/weight/
  fee stats stay `null` (no Electrum-protocol equivalent). A lookup by HASH
  still throws the "needs Core RPC" error — Electrum exposes no hash→height
  index, so there is nothing to fall back to for that shape of query.
- `getBlockTxs` — Core only; no fallback. Electrum's protocol has no "list
  this block's txids" method (unlike a single tx or a bare header), so a
  Core-less instance shows the block hero from the Electrum baseline above
  with a "couldn't load transactions" Banner in the tx-list section instead
  of gating the whole page.
- `getTx` — Core first (`getrawtransaction` verbosity 2, exact fee + prevout);
  on a -5/-8 it surfaces as not-found. **When Core is _not_ configured it now
  falls back to `getTxViaElectrum` (docs/TX-BLOCK-CONTEXT-DESIGN.md §2)** — a
  full-indexing Electrum server (electrs/Fulcrum) decodes any confirmed/mempool
  tx via `blockchain.transaction.get(txid, verbose=true)`, whose result is
  Core's `getrawtransaction verbose` shape exactly and maps through the same
  `toTxDetailFromCore`. No prevout at that verbosity ⇒ `fee`/`feeRate` and input
  addresses/values degrade to `null`, but the tx renders. So the tx-detail page
  **no longer requires Core RPC** — an Electrum-only Umbrel gets the page at the
  block-context "basic" tier. An unknown txid ("No such … transaction") maps to
  the same not-found signal Core uses.
- `getTxBlockContext(txid)` — assembles the tx-detail block-context section
  (BlueWallet-style; docs/TX-BLOCK-CONTEXT-DESIGN.md). **Never throws** — resolves
  to `richness:'none'` on total failure so the UI shows an honest "connecting"
  state. Tiers: tip-unreachable → `none`; Electrum decodes the tx → `basic`
  (neighbour dates + exact merkle position + summary); Core also answers
  `getblockstats` → `full` (+ per-block tx-count/size/fullness, exact position
  denominator). Position always comes from Electrum's merkle proof (cheap, exact)
  in every tier — Core is used only for the immutable-cached `getblockstats`
  aggregate; no `getblock` v1 whole-block fan-out. Neighbour headers are cached by
  height with a reorg-windowed TTL and the merkle `pos` by (txid, height), both in
  `chain/cache.ts`.
- `getTxHex()` — Electrum `blockchain.transaction.get(verbose=false)`, LRU-
  cached cross-build by txid (`RAW_TX_CACHE_MAX = 200`) since confirmed tx
  bytes never change.
- `getTxRbfInfo()` — always `null` for now. Core keeps no historical-
  replacement index and there is no external index to read one from; a real
  chain needs a forward-looking, Core-based watcher, deferred as cairn-zoz8.13.
  The tx page's RBF section is already gated on a null result.
- `getCpfpInfo()` — Core (`getmempoolentry` + ancestors/descendants); `null`
  when Core isn't configured or the tx isn't in the mempool.
- `getAddressInfo` / `getAddressTxs()` — Electrum scripthash protocol only
  (no lifetime totalReceived/Sent field — Electrum has no equivalent without
  walking full history; the UI shows "unknown" rather than a misleading 0).
  **Per-row graceful degrade (`cairn-om05x`):** `getAddressTxs()` used to let
  a single verbose-lookup failure reject the whole page — fatal against a
  public Electrum server that flatly rejects verbose transaction calls (a
  capability/transport error, distinct from a genuine "no such transaction").
  A definitive not-found (matching `getTxViaElectrum`'s own check) still drops
  just that row; any other error instead degrades the row to what the history
  index already knows — `{txid, height, time: null, fee: item.fee ?? null,
  delta: null}` — rather than sinking the page. The same tolerance applies to
  prevout resolution when computing a tx's fee/delta (a failed prevout fetch
  degrades that tx's fee/delta precision instead of rejecting the row). See
  §20.4 for the QA scenario.
- `getMempoolSummary()` — Core `getmempoolinfo`; throws the "needs Core RPC"
  error when Core isn't configured.
- `getFeeHistogram()` / `getMempoolBlocks()` — Electrum
  `mempool.get_fee_histogram`, projected locally into blocks via
  `projectBlocksFromHistogram()` (a greedy 1MvB-bucket packer, approximate by
  design); `null` when the histogram is empty.
- `getMempoolTrend()` — reads the **locally persisted** rolling sample
  window (`mempoolSamples.ts`, §4.7), not a live call.
- `getFeeEstimates()` — 30s TTL-cached; 4 Electrum `estimatefee` targets
  (1/3/6/144 blocks) converted BTC/kvB → sat/vB, with a "carry forward from
  the next-longer target" repair pass for targets the server can't estimate
  (`-1`), floored at `getRelayFeeFloor()` rather than a hardcoded 1 sat/vB —
  the connected node's own effective minimum relay rate (Core
  `max(mempoolminfee, minrelaytxfee)`, or Electrum `blockchain.relayfee` when
  no Core RPC is configured; falls back to 1 sat/vB when neither answers).
  A genuine sub-1 sat/vB estimate now displays honestly when the node will
  actually relay it (`cairn-eacw.4`); estimates above the floor pass through
  untouched — nothing is rounded up to the floor when the floor is lower. The
  response also carries the floor itself as `minFeeRate` (`cairn-eacw.5`) — the
  same value `getMinFeeRate()` returns — so the send page's **FeeSpeedPicker**
  can allow custom decimals down to it and gate `canBuild` on it. On a node that
  relays sub-1 the picker honors a typed 0.x fee; when the floor is 1
  (unknown/incapable node) a sub-1 entry is clamped to 1 with plain-language copy
  ("Your Bitcoin node doesn't relay fees below 1 sat/vB"). The clamp + copy live
  in the pure `feeChoice.ts` helpers (`resolveFeeRate` / `belowFloorMessage`),
  unit-tested in `feeChoice.test.ts`.
- `getDifficultyInfo()` / `getDifficultyHistory()` / `getHashrate()` — all
  derived from Electrum block headers, no Core dependency at all.
- `getBtcUsdPrice()` — the one remaining external call (public mempool.space
  `/v1/prices`, opt-in fiat only); see the backend-responsibilities list above.

`reconfigureChain()` is called after an admin saves connection settings —
tears down the old `ChainService` (no restart needed) and resets **every**
piece of per-backend in-memory state: connection dedup state
(`chainEvents.ts`), chain-health failure counters, package-relay support
cache, and the tip/fee TTL caches. **This is the one place that must reset
all per-backend caches/state** — a new module that adds backend-specific
in-memory state needs a reset hook wired in here too, or it will leak stale
data across an admin-triggered server switch. `testElectrum`/`testCoreRpc`
are standalone connectivity probes for the admin settings "Test
connection" buttons; `testCoreRpc` wraps raw errors in
`friendlyCoreRpcTestError()` rather than surfacing a bare exception string (a
real prior bug).

### Package relay — `src/lib/server/packageRelay.ts`

Opportunistic BIP-331 package broadcast (`blockchain.transaction.
broadcast_package`) for the one case sequential parent→child broadcast can't
cover: a parent below min-relay/mempool-floor fee gets rejected outright
before a fee-paying child can attach. Support is probed once and cached
(reset on backend change via `resetPackageRelaySupport()`, called from
`reconfigureChain`). `isUnknownMethod()` detects an "unsupported method"
rejection (most servers don't implement this) versus a genuine package
rejection. Never throws — returns `{status: 'sent'|'unsupported'|'failed', ...}`;
pure enhancement, safe to no-op.

### Chain events / health — `src/lib/server/chainEvents.ts` + `chainHealth.ts`

`chainEvents.ts` bridges Electrum pool connection/header events into the
activity feed and server log, wired once per `ChainService` construction.
Dedups so only a genuine state *change* is recorded (not every reconnect
re-emit). `'connect'` → `network_up` activity, cancels any pending outage
alert. `'disconnect'` → arms a **60s debounced** outage timer; only fires one
`admin_server_health` error notification if still down after the grace
window (a flapping connection never spams), latching so it only re-fires
after a recovery. `'header'` → dedups by height, invalidates the tip TTL
cache immediately, records a `new_block` activity row.
`resetConnectionState()` is called from `reconfigureChain()` since tearing
down the old client doesn't itself emit `'disconnect'`.

`chainHealth.ts` is a cheap, pure in-memory signal **derived** (not probed)
from `ElectrumClient.ensureConnected()` calling `recordChainOk()`/
`recordChainError()` on every connection attempt's outcome.
`UNHEALTHY_AFTER = 2` consecutive failures before flipping unhealthy (so one
transient idle-socket drop doesn't trip the banner). `getChainHealth()` is a
pure read with no network call, feeding the admin settings proxy indicator.
`noteProxyConfigured()` lets the banner distinguish "misconfigured Tor/SOCKS
proxy" from "node down."

**Only the primary reports (cairn-d8aa).** `ElectrumClientOptions.reportsHealth`
(default `true`) gates whether a given client's `recordChainOk`/`recordChainError`
calls are allowed through at all — `ElectrumPool` passes `reportsHealth: false`
to every socket but its primary (`pool.ts`'s constructor), and the admin
"Test connection" probe (`testElectrum()` in `chain/index.ts`) and the
Umbrel zero-config candidate probe (`umbrelProbe.ts`'s `probeOne()`) both pass
it too. Before this flag existed, EVERY pooled connection — plus any
throwaway test/candidate probe against a possibly-different server — fed the
same global signal, so a transient blip on a secondary socket (e.g. one of a
background scan's parallel connections dropping under load) or a failed admin
test of a *candidate* server could flip the instance-wide "can't reach the
Bitcoin network" banner even while the operator's real connection was fine.

**Per-backend health + honest union (cairn-7qmw).** Post-Esplora, Bitcoin
Core RPC is a first-class chain backend, so it carries its OWN reachability
signal in the same module: `recordCoreOk()`/`recordCoreError()`/
`getCoreHealth()`, fed by the `CoreRpcClient`'s per-call `onResult` sink
(wired only for the long-lived `ChainService` client — the admin "Test
connection" probe leaves it unset so a probe never pollutes the global
signal). A JSON-RPC error still counts as *reachable* (the node answered);
only a transport/auth/timeout failure counts against Core. `reconfigureChain()`
resets both signals. This is what lets **NodeTrust** (`nodeTrust.ts`) read the
reachability of whichever backend actually SERVES the explorer —
`gatherNodeTrust()` reads `getCoreHealth()` when Core RPC is configured, else
`getChainHealth()` — so a working Core node with a dead Electrum honestly earns
"Verified by your Bitcoin Core node" instead of being falsely reported
unreachable. The instance-wide "can't reach the Bitcoin network" banner reads
`getNetworkHealth()` (the union): an Electrum-only outage does **not** raise it
when Core RPC is configured and reachable, since the operator's own node is
still serving the explorer. (The wallet-sync `SyncBanner` remains
Electrum-scoped — address watching genuinely needs Electrum — so a Core-up/
Electrum-down instance can honestly show a working explorer alongside a stalled
wallet sync.)

### Address watcher / tx watch — `src/lib/server/addressWatcher.ts`

The single largest piece of notification plumbing. First and only consumer
of `ElectrumClient.subscribeScripthash()`. Started once from
`hooks.server.ts`, logger channel `notify:txwatch`.

- Derives the first `WATCH_WINDOW = 30` addresses per chain (receive +
  change = 60 subscriptions per wallet) for every single-sig wallet and
  multisig, across **all** users, and subscribes each to its Electrum
  scripthash for **live** push notifications. **This is a fixed window from
  index 0, not tied to the wallet's actual gap-limit scan cursor**
  (`cairn-43dx`, open) — a wallet whose last-used receive index sits past 30
  (a heavy long-lived wallet, or one restored from software using a larger
  gap limit) has a live-notification **blind spot** beyond index 30: a
  deposit to address 31+ fires no `tx_received`/`tx_confirmed` push. This is
  a notification-*timeliness* gap only, not a funds/balance bug — the full
  `gapLimitScanner` pass (`GAP_LIMIT = 20`, tied to the real last-used
  cursor) still picks the deposit up correctly on the next portfolio load,
  it just doesn't push a live notification for it.
- On a `'scripthash'` change event → `handleScripthashChange()`: fetches
  history, diffs new txids against the `notified_txids` table, fires
  `tx_received` (+ `tx_large` above a per-user threshold) for genuinely new
  inbound txids. **The claim and the notification writes commit as one
  SQLite transaction** (`withTransaction`, `cairn-fzqpe`): a process crash
  between "mark txid notified" and "enqueue the notification" rolls the
  claim back, so the next scripthash event retries instead of leaving a
  claimed-but-never-sent alert suppressed forever.
- On each new block (`'header'`) → `handleNewBlock()`: re-checks every
  pending (`confirmed=0`) `notified_txids` row's confirmation count against
  `CONFIRM_THRESHOLD = 1`, firing `tx_confirmed` once crossed and stamping
  `confirmed_height` with the tip at that moment. **Recently-confirmed rows
  stay in the scan for a `REORG_RECHECK_DEPTH = 6`-block window**
  (`cairn-ieilg`): a payment reorged out *after* firing `tx_confirmed` is
  still reconciled through `reconcileDisappeared` — status `'replaced'`,
  forced balance refresh, and a correcting `tx_replaced` titled "Confirmed
  payment reversed" (distinct from the pre-confirmation "Incoming payment
  cancelled"). Rows deeper than the window, and legacy/baselined rows
  (`confirmed_height` NULL), are never re-checked. Regression:
  `addressWatcherReorg.test.ts`, `dbTransaction.test.ts`.
- Refreshed every `REFRESH_INTERVAL_MS = 5min` (`refreshWatches()`) as the
  periodic backstop. **As of `cairn-0tvez` (`343c9f5`), `createWallet`/
  `createMultisig` also call `refreshWatches()` immediately after insert**
  (guarded by `getWatcherScanProgress().started` so unit tests and the
  pre-boot window never open real Electrum sockets) — a brand-new wallet is
  subscribed at creation time, not left waiting for the next 5-minute sweep.
  The periodic pass still exists as a safety net (e.g. a watcher restart).
  Companion fix in the same bead: `doWalletScan`/`doMultisigScan`
  (`walletSync.ts`) no longer persist an **empty** snapshot for a wallet the
  watcher isn't yet subscribed to, and both `/refresh` routes now pass
  `{force:true}`, so a freshly funded wallet can't get stuck showing a
  stale/never-updated "0.00 BTC" on its own detail page (§20.7).

**`notified_txids` lifecycle (`cairn-a2p1`)**: each tracked row carries a
`status` and an `amount_sats`. States: `'pending'` — an unconfirmed inbound
the watcher has seen and is tracking, but has **not yet** surfaced as
"payment received" (the SPV gate still defers that until the tx confirms —
see below); `'notified'` — the tx has cleared the SPV gate and `tx_received`
has fired; `'replaced'` — a previously `'pending'` or `'notified'` tx
disappeared from the mempool/block-tip history on a later rescan (detected
by reconciling against observed chain history, not merely by absence —
a genuine double-spend/RBF-replacement, not just a slow relay), firing the
correcting `tx_replaced` notification; `'dropped'` — the same disappearance
case but silent (no correcting notification), used when nothing was ever
surfaced to correct (a `'pending'` row that never reached `'notified'`
doesn't need a user-facing "cancelled" message, since the user was never
told they'd been paid). A `'replaced'` row with `amount_sats > 0` is what
feeds the wallet-detail page's amber "Cancelled" row and the `/activity`
correcting event (§20 QA below). **Unconfirmed inbound handling**: an
unconfirmed (mempool) inbound is now recorded as `'pending'` immediately —
tracked so a later disappearance can be detected and reconciled — but the
existing SPV gate is **preserved**: `tx_received` still only fires once the
transaction is independently proven confirmed in a PoW-valid block (never
for a bare mempool sighting), so this change adds disappearance-tracking
without weakening invariant 3 from §1.

**SPV verification gate** (see invariant 3 in §1). Before firing *any*
payment notification, `spvVerifyConfirmed(txid, height)` fetches the merkle
proof, block header, and tip height, then:
- If the height is one the watcher has **directly observed** off the live
  header stream (`state.tipCache`), the proof's header must match that exact
  cached hash byte-for-byte, or the notification is deferred (fails closed).
- Otherwise, the header's own claimed difficulty must clear a
  **self-calibrating difficulty floor** — `DIFFICULTY_FLOOR_FACTOR = 4n` ×
  the hardest target recently observed (`maxCachedTarget()`) — because a bare
  "header's hash matches its own bits" check only proves internal
  self-consistency, not real network difficulty, and this watcher has only
  ONE Electrum server as its source of truth.
- A cold cache (no tips observed yet, e.g. right at startup) defers rather
  than guessing.
- `acceptHeaderIntoCache()` re-validates every streamed tip header (own-bits
  PoW check, not implausibly weaker than the floor) before folding it into
  the rolling `TIP_CACHE_SIZE = 144` (~1 day) height→{hash,target} cache.

**Baseline/quarantine logic**: a global `state.baselined` flag gates all
handlers until the startup baseline pass completes (otherwise the initial
subscribe's status callbacks would notify for pre-existing transactions).
The *real* gate is per-scripthash: `state.baselinedScripthashes` — an address
whose baseline history fetch failed mid-pass (an Electrum drop) stays
quarantined until a retry succeeds, rather than leaking its whole real
history out as "new" (this exact bug, `cairn-3bt1`, caused false floods of
"payment received"/"confirmed" alerts). Retry sweep runs on every
`refreshWatches()` call once the startup pass is done.

**Deletion / TOCTOU safety**: `unwatchWallet()`/`unwatchMultisig()` are
called synchronously from the delete paths to drop local watch state
immediately. `walletStillExists()` is a belt-and-braces re-check inside
`handleScripthashChange` (some delete paths, like account-deletion FK
cascade, bypass the module entirely) — fails closed, treating a query error
as "gone." A second re-check right before `recordTxid`/`notify` (after the
last `await`) closes a TOCTOU window where a delete lands in one of the
handler's earlier awaits.

**Event-loop yielding**: `enumerateAll()` yields (`setImmediate`) once per
wallet/multisig batch during enumeration — each wallet does ~60 synchronous
EC derivations, and without yielding, a large portfolio's full enumeration
pass would hog the single-threaded event loop and stall in-flight HTTP
requests (found via load testing).

**Attribution correctness**: inbound value is attributed by **scriptPubKey
membership, not address string** — regtest/testnet backends report
addresses in their own encoding (`bcrt1…`/`tb1…`), which never equals
Cairn's mainnet-derived strings, and comparing by string had silently zeroed
every deposit in that environment (same class of bug independently fixed in
`walletScan`/`multisigScan`).

### Chain sync / snapshot caching (the SWR layer)

Four cooperating modules implement stale-while-revalidate for global "chain
data" (dashboard/explorer), per-wallet balances, and per-tx decoded data.

- **`src/lib/server/chainSnapshot.ts`** — pure persistence: single-row
  `chain_snapshot` SQLite table (blocks, tip, hashrate, mempool summary,
  fees, difficulty info/history, mempool blocks, fee histogram, mempool
  trend). `readChainSnapshot()`/`writeChainSnapshot()` are synchronous,
  best-effort, and never throw (a parse/write failure returns null or is
  swallowed).
- **`src/lib/server/chainSync.ts`** — `refreshChainSnapshot({force})` is the
  background "revalidate" half. **Single-flight**: concurrent callers (
  multiple tabs, a nav plus a new-block event) share one in-flight promise,
  since this is global data. **Throttle**: `THROTTLE_MS = 20_000` — a
  non-forced call on a fresh-enough snapshot skips the fetch entirely; a
  new-block event passes `force: true`. `doRefresh()` fetches recent blocks,
  mempool summary/fees/tip/mempool-blocks/fee-histogram/mempool-trend — **every
  field is independently `.catch(() => null)`**, so a partial-capability or
  partially-down backend degrades field-by-field instead of failing the whole
  refresh (cairn-zm7o). This matters post-Esplora: recent blocks are
  Electrum-sourced but the mempool summary is Core-sourced, so an Electrum
  outage on a Core-RPC-up instance must still persist the Core mempool summary
  (it used to abort the entire snapshot because recent-blocks was the one
  un-caught "required" fetch, leaving the explorer home + mempool broken).
  Recent blocks are carried forward from the last good snapshot when a pass
  can't fetch them (like hashrate/difficulty below), rather than blanking a
  populated list. Epoch-scale data (hashrate/difficulty info/history) is only
  refetched when the tip height actually changed since the last successful
  refresh — otherwise carried forward from the persisted snapshot, since
  refetching every 20s would waste 3 Electrum round-trips for data that's
  identical within a block. **Never overwrites a good snapshot with a failure**
  — a pass in which *no* backend was reachable does not persist (nor bump the
  snapshot's freshness): it returns the last-good snapshot (stale) if one
  exists and only throws when there's nothing cached at all. A pass in which
  *anything* resolved persists whatever succeeded, null for the rest.
- **`src/lib/server/walletSync.ts`** — same SWR pattern, per-wallet/per-
  multisig (`wallet_snapshots` table), `THROTTLE_MS = 20_000`.
  `singleFlightThrottled()` is a generic, deliberately non-`async` reusable
  engine (throttle check + `Map<key, Promise>` single-flight — synchronous
  so no two concurrent callers can both start a scan). **Global scan
  concurrency limiter**: `SCAN_CONCURRENCY = DEFAULT_BACKGROUND_LANE_SIZE`
  via a hand-rolled FIFO limiter — every real scan (list refresh, detail
  refresh, new-block nudge, startup warm) funnels through this ONE limiter,
  capped to exactly the number of sockets the background lane can use. This
  is what stops opening `/wallets` with N wallets from firing N concurrent
  full gap-limit scans that starve interactive traffic (previously "leading
  cause of app unresponsive"). `runPortfolioRefreshPass()` coalesces a whole
  user's wallets+multisigs into one pass: most-stale-first ordering,
  per-item throttle skip, bounded concurrency, and **abort-on-connect-
  failure** (`isConnectClassError()`) so a dead backend doesn't get hammered
  N times. `buildPortfolioAggregate()` rebuilds the dashboard aggregate
  purely from just-refreshed per-wallet snapshots (zero extra chain calls),
  so `GET /api/portfolio` is a synchronous cache read. The aggregate now
  also threads each snapshot's `maturingTotal`/`unverifiedTotal` and coinbase
  txids into `PortfolioDetail` (`cairn-25ges`/`cairn-8lwa6`/`cairn-i0d0q`):
  the Home hero renders `confirmed − maturingTotal − unverifiedTotal` with
  the same "· N maturing" / "· N still being verified" sub-lines as the
  wallet detail pages — Home must never read higher than the pages it links
  to — and `PortfolioActivity.isMiningReward` tags inbound coinbase rows
  ("Mining reward", from wallet coinbase UTXOs ∪ the user's
  `mining_blocks.coinbase_txid` records). `confirmed` itself is unchanged
  (full net worth). `warmAllSnapshots()`
  is the startup warm across every user, aborting the whole pass on a
  connect-class failure. **The send/PSBT flow deliberately bypasses
  snapshots entirely** — it always re-scans live for fresh UTXOs
  (correctness beats freshness there).

  **Electrum status-hash dirty-tracking (cairn-wcxw, sync engine Phase 1).**
  Layered on top of the throttle above. The app already holds a live Electrum
  scripthash subscription for every watched address (`addressWatcher.ts`), and
  each subscription carries a STATUS HASH that changes iff that address's
  history changes (new tx, confirmation, reorg, RBF). Phase 1 stops throwing
  that signal away:
  - **`scripthash_status` table** persists the last-seen status per
    `(wallet_kind, wallet_id, scripthash)`; **`wallet_snapshots.dirty_since`**
    (NULL = clean, ms-epoch = marked-dirty-at) is the per-wallet dirty flag.
    Both additive/PRAGMA-guarded; both swept by the `trg_*_delete_children`
    triggers (the delete-cascade test enforces it).
  - **`addressWatcher.reconcileStatus()`** runs on the live `'scripthash'`
    event AND on the subscribe/resubscribe return value (initial subscribe,
    client swap, and — critically — the reconnect-after-outage replay, making
    reconnect a free reconciliation checkpoint). A status that DIFFERS from, or
    is ABSENT versus, the stored baseline updates the baseline and marks the
    owning wallet dirty; an UNCHANGED status is a no-op (so an idle reconnect
    doesn't re-dirty everything). Conservative by construction: absent baseline
    ⇒ dirty; the first scan of a wallet always runs (never-synced wallets scan
    by absence regardless of the flag).
  - **The refresh gate** (`shouldSkipScan()`, used by both
    `singleFlightThrottled` and `runPortfolioRefreshPass`): a CLEAN wallet is
    served from cache without scanning for up to **`MAX_CLEAN_TTL_MS` (30 min)**
    instead of the 20 s `THROTTLE_MS`; a DIRTY wallet still only coalesces
    within `THROTTLE_MS` and then rescans. On a successful scan the flag is
    **compare-and-swap-cleared** (`clearDirtyIfUnchanged`) only if it is
    byte-for-byte what the scan saw at its start, so a deposit that races a scan
    keeps the wallet dirty for a follow-up rather than being swallowed into a
    "clean" snapshot. A failed scan never clears, so it retries (preserves the
    existing "a failed scan never clobbers the last good snapshot" contract).
    The 30-min TTL is the self-healing net that bounds the worst-case stale
    window if any signal is ever missed.
  - **WATCH_WINDOW blind-spot fix (prerequisite).** `watchDepthFor()` now sizes
    the per-chain subscription depth from the persisted snapshot's highest used
    index + `GAP_LIMIT` (floored at `WATCH_WINDOW = 30`), so the watch set
    always covers the scanned set. Before this, a wallet with >30 used
    addresses on a chain had live addresses that were never subscribed — a
    deposit there fired no event and would never mark the wallet dirty (a
    false-clean). The dirty signal is only sound because the watch set is now a
    strict function of the scan set.
  - **Kill-switch.** Set `CAIRN_SYNC_DISABLE_DIRTY_SKIP=1` (or
    `HEARTWOOD_SYNC_DISABLE_DIRTY_SKIP`) to collapse the clean ceiling back to
    `THROTTLE_MS` — instant revert to "always re-scan past 20 s" without a
    redeploy, the escape hatch for the medium false-clean risk. The
    dirty-MARKING path always runs regardless, so toggling it never leaves stale
    baselines behind. Cold-start scans everyone once (empty baselines ⇒ all
    dirty), matching the pre-existing `warmAllSnapshots` behavior.
- **`src/lib/server/chain/cache.ts`** — in-process (not persisted) TTL
  caches used directly by `ChainService`: `cachedTip` (10min ceiling,
  normally invalidated instantly by the `'header'` event), `cachedFeeEstimates`
  (flat 30s TTL), a raw-tx LRU (`RAW_TX_CACHE_MAX = 200`, cross-build,
  distinct from `psbt.ts`'s own within-one-build dedup cache).
  `resetChainCaches()` is called from `reconfigureChain()`.
- **`src/lib/server/txSnapshot.ts`** — the fourth SWR module, easy to miss
  since it isn't named alongside the other three: same `THROTTLE_MS =
  20_000` SWR pattern, but per-transaction, populating the `tx_snapshots`
  table (§6) with decoded-tx data so repeat lookups of the same txid (e.g.
  from the explorer tx page or a notification) don't re-hit Electrum/Core.
- **Snapshot-honesty render rule (cairn-6efi.11).** `BlockSummary` (`$lib/
  types.ts`) types `txCount`/`size`/`weight`/`fullness`/`total_out` as
  `number | null` — `null` means "the configured backend doesn't provide
  this field," never a real zero (a real block always has ≥1 tx and >0
  bytes). Every renderer of these fields must treat **both** `null`/
  `undefined` (an absent key on an imperfect or synthetic snapshot) **and**
  a literal `0` as "unknown, show `—`" — a strict `=== null` check alone
  lets `undefined` and false-zero slip through as `NaN` or a bogus 0%/0-tx
  row. See `$lib/format.ts` `formatMovedBtc()` and
  `src/lib/components/heartwood/ringBarGuard.ts` (`ringBarVisible`/
  `ringBarPct`) for the canonical hardened-guard pattern; reuse it (or the
  `value == null || !Number.isFinite(value) || value <= 0` shape) for any
  new chain-snapshot-derived render.

### Supporting modules

- **`src/lib/server/chainEpochs.ts`** — one-time historical build of
  difficulty-epoch boundary timestamps (genesis → tip, every 2016 blocks)
  for the Heartwood "ChainStrip" visualization and first-sync progress.
  Reads the block at each boundary height directly from the operator's own
  Electrum server (`getBlockTimeAtHeight` → block header → decode). Cached
  forever in the `settings` table — immutable chain history, only a new
  boundary crossing (~every 2 weeks) adds one entry.
- **`src/lib/server/chainDepth.ts`** — unconfirmed-chain-depth warnings (not
  blocking) for chained unconfirmed spends, via `getCpfpInfo()`. Defaults to
  the conservative **legacy** mempool policy limits (25 ancestors/
  descendants) since Cairn can't reliably detect whether a node runs
  cluster-mempool (Core 31+) or legacy policy — warning early on a looser
  cluster-mempool node is a harmless false positive; warning late on legacy
  would be an unexplained broadcast rejection.
- **`src/lib/server/mempoolSamples.ts`** — a local rolling time-series
  (`mempool_samples` table, `RETENTION_SECONDS = 3h`) replacing the old
  mempool.space `/v1/statistics/2h` dependency, populated once per
  `chainSync.ts` refresh pass (~20s cadence). Forward-looking only — starts
  empty after every deploy, no backfill.

### Server startup gating — `src/hooks.server.ts`

A process-level crash guard installs real `uncaughtException`/
`unhandledRejection` handlers (replacing any temporary fallback `server.mjs`
installed pre-import). `uncaughtException` logs, then
`setImmediate(() => process.exit(1))` (deferred one tick so the async stdout
pipe write can flush before the process dies). `unhandledRejection` is
logged only and does **not** exit (a stray benign rejection shouldn't
crash-loop the app). Guarded by `globalThis.__cairnProcessGuardInstalled`
against double-install under Vite SSR module invalidation.

`init()` — one async function invoked once into module-scope `initReady` —
runs, in this exact **load-bearing order**, each step independently
try/caught (none throw into the sequence):

1. `migrateExplorerDefault()` — must precede any user existing.
2. `bootstrapAdminFromEnv()` — Umbrel/Docker non-interactive admin creation.
3. **`seedChainConfigFromEnv()`** (`chainEnvSeed.ts`) — **must run before
   anything that constructs `ChainService`** (the address watcher,
   first-sync, portfolio-warm all call `getChain()`). Seeds Electrum host/
   port/TLS from `CAIRN_ELECTRUM_*` env vars, seed-once-if-unset,
   non-destructive: only writes a setting if it has never been stored, so an
   admin's later manual edit in Admin → Settings is never clobbered on
   restart. Setting `electrum_host` also flips `connection_mode` to
   `'custom'` if unset (a stored host is otherwise inert in `'public'`
   mode). Only when the adopted host actually got written does this also
   stamp `chain_provisioned_by = 'umbrel-env'` (never on a no-op skip, so a
   manually-entered connection is never mislabeled as auto-connected).
   **Bitcoin Core RPC is handled differently (v0.2.47, zero-config Core RPC
   wave, `cairn-2ldr` reversal — the store now declares
   `dependencies: [bitcoin]`, shipping separately from this app-side
   change).** `CAIRN_CORE_RPC_URL/USER/PASS/NETWORK` are **reconciled on
   every boot**, not seed-once — `core_rpc_url`/`user`/`pass` (encrypted via
   `setSecretSetting()`, never plaintext) and `chain_network` (the pre-flight
   hint for the mining engine's network-mismatch guard, see "Mining engine"
   below) are OVERWRITTEN from env whenever `core_rpc_provisioned_by` is
   unset or already `'umbrel-env'`; any other value (`'manual'` — stamped by
   `/settings`'s admin Node-connection save action on a hand-entered Core RPC
   config, or by the JSON `/api/admin/settings` endpoint; or `'umbrel-detect'` — the Wave B
   assisted-connect flow below) blocks the overwrite forever, no matter what
   env says (manual > auto-env > detect > none). This is what makes a
   rotated Umbrel-Bitcoin-app RPC password (e.g. after reinstalling the app)
   self-heal on the next restart instead of leaving Cairn 401ing forever. Two
   guards protect the reconcile: an **empty-interpolation guard**
   (`new URL()` parse + non-empty hostname/port check) — Umbrel's
   always-present compose block interpolates the missing app's vars to
   `http://:` when the Bitcoin app isn't installed, which is truthy but
   useless, so it must seed NOTHING rather than a guaranteed-401 endpoint —
   and an **all-or-nothing present-check** on user/pass: a partial env (e.g.
   URL+user with no password yet) seeds nothing at all, not even the URL.
4. **`probeAndSeedUmbrelElectrum()`** (`umbrelProbe.ts`, Wave A, see
   `docs/UMBREL-AUTOCONNECT-DESIGN.md`) — runs immediately after step 3, same
   before-`ChainService`-construction constraint applies. Strictly gated on
   `CAIRN_PLATFORM === 'umbrel'` **and** `connection_mode` still unset (so
   step 3's env seed, if it fired, already blocks this — env always wins over
   probe). Tries a real credential-free `ElectrumClient.headersSubscribe()`
   handshake (2s timeout) against Umbrel's fixed Docker-network IPs, in
   order: `10.21.21.10:50001` (electrs) then `10.21.21.200:50002` (fulcrum).
   On the first reachable candidate, seeds `electrum_host`/`electrum_port`/
   `electrum_tls`, flips `connection_mode` to `'custom'`, and stamps
   `chain_provisioned_by = 'umbrel-probe'` — same seed-once-if-unset,
   non-destructive contract as step 3's Electrum half. Covers Umbrel installs
   where electrs/Fulcrum is running but Cairn's manifest doesn't declare a
   hard `dependencies:` entry on it (so step 3's env vars never arrive).
   Never throws; every candidate unreachable (or non-Umbrel platform, or
   already configured) is a silent no-op — the existing public-server
   default / manual Admin → Settings entry is unaffected.
4.5. **`probeAndDetectUmbrelCore()`** (`umbrelCoreProbe.ts`, Wave B Unit B1,
   see `docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md`) — runs right after step 4,
   same ordering constraint. Gated on `CAIRN_PLATFORM === 'umbrel'`,
   `coreRpcConfigured()` false (so step 3's env reconcile, if it fired,
   already blocks this), and `core_rpc_detected` unset. Sends a
   credential-free JSON-RPC POST to the well-known Umbrel bitcoind address
   (`http://10.21.21.8:8332`); a `401`/`403`/`200`/IBD-`503` response means a
   listener answered, and seeds ONLY the advisory `core_rpc_detected='umbrel'`
   marker — never `core_rpc_url`/`user`/`pass`, never touches
   `connection_mode`. This is what drives the Admin → Settings
   assisted-connect banner (one-paste: URL/user pre-filled from hardcoded
   constants, admin pastes the password copied from the Umbrel Bitcoin app's
   own Connect screen) for installs where the manifest dependency isn't wired
   yet, or where the Bitcoin Node app was installed to an already-running
   Heartwood without a restart (env-based reconcile only re-runs on
   `hooks.server.ts` boot — see "installed Bitcoin Core after Heartwood" in
   §1 below). Never throws.
5. `migrateInstanceMode()`, `migratePlaintextSecretsAtRest()`,
   `ensureDefaultAgreementVersion()`.
6. `startNotificationQueueWorker()`.
7. `startAddressWatcher()`, `startKeyHealthWatcher()`.
8. `startFirstSync()` (`syncStatus.ts`) — begins the epoch-history walk right
   after boot, racing the user's signup flow rather than waiting for first
   page view.
9. `startRetentionSweep()`, `startBackupHealthWatcher()`,
   `startPortfolioWarm()`, `startScheduledBackupWatcher()`.
10. One structured "startup config honored" summary line (secret-free by
    construction), including the chain config actually in effect and whether
    anything was seeded this boot.

`export const handle: Handle` — **`await initReady` is the very first
line** — so every single request blocks on the entire sequence above
completing. This was the root cause of a previously investigated
slow-cold-start symptom: if the `notify:txwatch` + portfolio-warm Electrum
retry storm at process start takes 2-3s on a cold cache, every request —
not just chain-dependent ones — waits for it.

`handleError` only logs a full stack + random `errorId` for 5xx errors; the
client sees only "Something went wrong" plus the ID.

### Cross-cutting chain-layer gotchas

1. **Electrum's idle timeout is deliberately OFF** in favor of the app-level
   keepalive — the connect-timeout timer is the only thing bounding a hung
   initial dial; don't touch one without checking the other.
2. **The pool is many sockets to ONE Electrum server, not independent
   sources** — this is why the address watcher needs its own SPV/difficulty-
   floor logic rather than trusting Electrum's header claims outright.
3. **There is no third-party HTTP explorer API** — Esplora was removed
   entirely (cairn-zoz8.16). The rich block/tx/mempool detail comes only from
   the operator's own Bitcoin Core RPC; when it isn't configured those methods
   throw the "needs Core RPC" error (or return `null`) — never a fallback.
4. **`reconfigureChain()` must reset ALL per-backend caches/state** — a new
   module adding backend-specific in-memory state needs a reset hook wired
   in here too.
5. **`seedChainConfigFromEnv()` / `probeAndSeedUmbrelElectrum()` ordering in
   `hooks.server.ts` is load-bearing** — both must run before the first
   `getChain()` call anywhere in the init sequence, since `ChainService`'s
   constructor reads `getChainConfig()` once and there's no live-reload
   outside `reconfigureChain()`. The probe must also run strictly *after*
   the env seed (not just before `getChain()`) so an env-provided host always
   wins — see `docs/UMBREL-AUTOCONNECT-DESIGN.md` §2.
6. **The address watcher and chain-sync/wallet-sync layers are deliberately
   fail-open/fail-closed asymmetric**: chain-reachability failures degrade to
   "stale but served" (snapshots) or "quarantined until retry" (SPV
   baseline), never to a thrown error that would take the process down — but
   SPV verification itself fails *closed* (no proof → no notification,
   ever).
7. **Installed the Umbrel Bitcoin Node app AFTER Heartwood was already
   running? Restart Heartwood once (v0.2.47).** `seedChainConfigFromEnv()`'s
   Core RPC reconcile and `probeAndDetectUmbrelCore()`'s detection probe both
   run only inside `hooks.server.ts`'s `init()` — once, at process boot, not
   on a poll/watch. Umbrel injects `CAIRN_CORE_RPC_*` (once the store
   declares `dependencies: [bitcoin]`) into the container's environment at
   container START, so a Bitcoin Node app installed after Heartwood was
   already running won't be picked up until Heartwood's own container
   restarts. On a bare Umbrel install without the manifest dependency yet,
   the Wave B assisted-connect banner (Admin → Settings) has the same
   restart-free path from the app's side (it needs its own probe to fire,
   which also only runs at boot) — either way, a restart of the Heartwood app
   from the Umbrel dashboard (or `docker restart`) is the fix, not a wait.

---

## 5. Server: Wallet Operations & Transactions

This section covers how Cairn turns "send N sats to address X" into a
broadcast transaction, for both single-sig and multisig wallets, and what's
actually shared between the two versus deliberately kept separate.

### PSBT construction — single-sig (`src/lib/server/bitcoin/psbt.ts`)

Core export: `constructPsbt(params: ConstructParams): Promise<ConstructedPsbt>`.
Pure with respect to chain state — all UTXOs and previous transactions come
in via `params`, so the function is deterministic and unit-testable
(`psbt.test.ts`).

**Coin selection.** Uses `@scure/btc-signer`'s `selectUTXO(..., 'default',
{bip69: true})` — not a hand-rolled selector — giving deterministic BIP-69
input/output ordering. A two-pass "prefer confirmed" strategy tries
confirmed-only inputs first, only falling back to the wallet's own
unconfirmed change if confirmed coins can't cover amount + fee. Coin
eligibility is centralized in `selectSpendCandidates()` (shared with
multisig — see below): normal auto-selection is confirmed coins plus
own-unconfirmed-change only, **never a stranger's unconfirmed coin**
(`unconfirmedTrust` field on `SpendableUtxo`, `'own-change'` vs `'received'`,
computed by `classifyUnconfirmedTrust()` in `transactions.ts` from the
wallet's own broadcast-txid history). Coin control (`onlyUtxos`) can
override this. `exactInputs` (used for RBF) bypasses eligibility entirely —
it spends exactly what it's given. Coinbase (mining-reward) UTXOs need 100
confirmations; `selectSpendCandidates` drops immature ones from
auto-selection and rejects an explicitly coin-controlled immature one with a
clear error. A coin whose coinbase-ness is `'unknown'` (a failed chain
fetch) is treated conservatively as possibly-immature. **The guard also
fails CLOSED when the chain TIP itself can't be resolved** (`tipHeight`
undefined — a transient `getTip()` failure, `cairn-oae1.1`): every
coinbase-flagged coin (definite or unverified) is treated as unverifiable
maturity — excluded from automatic selection, and an explicit coin-control
pick of one is rejected with *"Can't verify this mining reward is ready to
spend right now — try again in a moment."* Ordinary (non-coinbase) coins are
completely unaffected, so a transient tip-fetch failure never blocks a
normal send; both `transactions.ts` and `multisigTransactions.ts` only fetch
the tip at all when a coinbase coin is present, and leave `tipHeight`
undefined (rather than throwing) on failure so this fail-closed path runs.
`preferLowMassOrder()`
(`signingMass.ts`) re-sorts equal-value candidates toward lighter-parent-tx
coins before selection — this never changes fees or amounts, it's a
tiebreak only. Candidate UTXOs already referenced by another in-flight draft
of the same wallet are excluded from auto-selection (reservation — see
below).

**Fee estimation.** Flat per-script-type vsize tables:
`INPUT_VSIZE = { p2pkh: 148, 'p2sh-p2wpkh': 91, p2wpkh: 68 }` +
`TX_OVERHEAD_VSIZE = 11` + `outputVsize(address)` (exact per-output size by
address type: p2wpkh 31, p2sh/p2pkh ~32/34, p2wsh/p2tr 43). **p2tr has no
`INPUT_VSIZE` entry** — spending from a taproot wallet throws `'Spending
from p2tr wallets is not supported yet.'` (see §11 for the full p2tr
story). `estimateTxVsize()` is exported and reused by the CPFP builder so its
fee estimate and the real constructed tx agree. `MAX_FEE_RATE = 1000` sat/vB
is a hard ceiling — a backstop against a fat-fingered sats-total pasted into
a rate field. `RBF_SEQUENCE = 0xfffffffd` is set on every input Cairn ever
builds — every Cairn transaction signals BIP-125 replaceability by default.

**Worked example.** 2 p2wpkh inputs + 1 p2wpkh recipient output + 1 p2wpkh
change output, at a chosen fee rate of 10 sat/vB:
`vsize = TX_OVERHEAD_VSIZE (11) + 2×INPUT_VSIZE.p2wpkh (2×68=136) +
2×outputVsize('p2wpkh') (2×31=62) = 209 vbytes` →
`fee = ceil(209 × 10) = 2090 sats`. This is also the concrete anchor for
`MAX_FEE_RATE`'s 1000 sat/vB ceiling: the same 209-vbyte tx at a
fat-fingered "2090" sat/vB rate (someone typing the total fee into the
rate field) would compute a ~437,000 sat fee and get refused outright
instead of silently built.

**Change handling.** Change goes to the wallet's own change chain
(`chain=1`) at `findNextUnusedIndex` (`walletScan.ts`), embedding
`bip32Derivation` on the change output when the wallet's key origin
(fingerprint + path) is known — this lets hardware signers verify change
pays back to the wallet instead of listing it as a second recipient, and
lets `summarizePsbt` identify change on reload. There's an explicit
in-source warning **not** to pass 546 as btc-signer's `dust` option — that
field means something else and would silently burn any change under ~18k
sats into fee.

**Send-max ("sweep")** is only valid as the sole recipient
(`amount: 'max'`): spends every candidate (or the coin-controlled subset),
fee = vsize × feeRate, `amount = totalIn - fee`.

**RBF replacement** (`exactInputs: true`) spends every provided coin
verbatim (guaranteeing conflict with the original), keeps the same
recipients/amounts, and takes the entire fee increase from change; it
rejects if change would drop below `dustThreshold(changeAddress)` (the
per-script-type floor below) rather than pulling in new inputs to cover a
bigger fee — the code deliberately refuses rather than silently changing
what the user reviewed.

**Dust threshold is per-script-type and consistent everywhere (`cairn-7ld60`,
fixed `2be1902`, v0.2.40).** `dustThreshold(address)` (P2WPKH 294, P2WSH/
P2TR 330, P2PKH 546, P2SH 540) is the single source of truth: the
user-facing pre-flight check (`validateRecipientsAndFeeRate`, "This amount
is too small to send.") and all three downstream coin-selection sites —
send-max sweep, RBF-replacement change floor, and normal-selection change —
now call it against the actual destination/change address. Previously the
three downstream sites compared against a flat legacy `DUST_SATS = 546`
constant (now removed), which wrongly held e.g. a 300-sat P2WPKH change
output to the higher P2PKH ceiling. Standard P2PKH behavior is unchanged;
P2WPKH/P2WSH/P2TR sends now correctly use their own lower dust floor.

**`nonWitnessUtxo` deferral (perf).** For segwit inputs (not p2pkh/p2tr),
fetching each candidate's full previous transaction is deferred until
*after* coin selection (`fetchChosenPrevTxs`) and fetched concurrently only
for the chosen coins — avoiding one serial Electrum round-trip per untouched
candidate. p2pkh must still fetch eagerly (no `witnessUtxo` to size from).
Every fetched raw tx is hash-verified against the requested txid before use.

**Address types supported for spending**: p2pkh, p2sh-p2wpkh (BIP49), p2wpkh
(BIP84). Address derivation lives in `src/lib/server/bitcoin/xpub.ts`:
`parseXpub()` accepts xpub/ypub/zpub (SLIP-132), normalizes to standard
xpub bytes, rejects private keys and non-mainnet prefixes. `deriveAddress()`
implements only p2pkh/p2sh-p2wpkh/p2wpkh (throws on anything else).
`addressToScriptPubKey()`/`isValidAddress()` *do* understand bech32m/p2tr
encoding generically, so a p2tr address is a valid **recipient** — it just
can't be a wallet's own derived address (§11 has the full detail).

**Derivation is memoized (cairn-8ubd)** — a CPU profile of the mixed-load
harness put ~70% of non-idle server CPU inside secp256k1 point math, re-run
on every gap-limit scan and watcher pass. `xpub.ts` now holds three caches,
all keyed to one exact key so nothing leaks across wallets and no derived
value changes (derivation is a deterministic pure function): a bounded
`parseXpub` LRU (input string → `ParsedXpub`; also stabilizes the `HDKey`
identity), a change-node `WeakMap<HDKey,[receive,change]>` (the `m/<change>`
node is derived once per chain, not once per index), and a bounded address
LRU keyed on `<scriptType>|<xpub>|<change>|<index>` (scriptType is in the key
so a ypub and zpub over the same bytes can't collide). Multisig has the
parallel `createMultisigDeriver(config)` factory in `multisig.ts` — resolve +
validate once, hoist each cosigner's per-chain node — used only by the two
hot loops (`multisigScan` gap scan, `addressWatcher` subscriptions); one-off
callers keep the per-call-validating `deriveMultisigAddress` (a bad config
costs real money). Warm scans then do zero EC work.

**PSBT utilities** (bottom of `psbt.ts`):
- `summarizePsbt(psbtBase64, threshold = 1)` — review-friendly summary
  (inputs/outputs/change/signedInputs/`complete`). The `threshold` param
  (committed as `a93dd27`, see the preamble at the top of this manual) makes
  `complete` quorum-aware for multisig — a 1-of-2-signed multisig PSBT no
  longer reports `complete: true`. Single-sig callers omit it (default 1,
  unchanged behavior). The two multisig call sites that pass a real
  threshold are `src/routes/(app)/wallets/multisig/[id]/send/+page.server.ts`
  and `src/routes/api/wallets/multisig/[id]/transactions/[txId]/+server.ts`.
  This closed a real bug where `summary.complete` could say `true` at a
  1-of-2 moment while the separate `multisigPsbtProgress` authority
  correctly said `false` in the same API response.
- `assertSameTransaction(draftPsbt, signedPsbt)` — the commitment check from
  §1 invariant 2, wired into both the file-upload and broadcast paths.
- `finalizePsbt()` — finalizes remaining unsigned inputs, passes through
  already-finalized ones (Core's `descriptorprocesspsbt`/`walletprocesspsbt`
  default `finalize=true`), throws a typed `PsbtNotFullySignedError` with
  exact counts rather than surfacing btc-signer's raw exception text.

### Shared spend rules (dedup between single-sig and multisig)

`psbt.ts` explicitly hosts logic used by **both** `constructPsbt`
(single-sig) and `constructMultisigPsbt` (multisig, in `multisigPsbt.ts`) —
see the "shared spend rules" section header at `psbt.ts:229`:
- `validateRecipientsAndFeeRate(recipients, feeRate, minFeeRate = 1)` —
  recipient/fee-rate validation, identical user-facing messages for both wallet
  types. The fee-rate floor is **node-derived, not a hardcoded 1 sat/vB**
  (`cairn-eacw.2`): the service layer resolves `ChainService.getMinFeeRate()`
  (`round2(getRelayFeeFloor())`) and passes it as `minFeeRate`, so a node that
  relays below 1 sat/vB accepts a genuinely sub-1 fee, while an
  unknown/incapable node keeps the historical 1 sat/vB minimum. A rate **below
  the floor** is refused with a floor-quoting message ("This fee is below what
  your node will relay right now — the minimum is _N_ sat/vB"); a **zero,
  negative, or NaN** rate is always refused independently, with "Enter a fee
  rate greater than zero." The `MAX_FEE_RATE = 1000` sat/vB fat-finger ceiling
  is unchanged. Both `constructPsbt`/`constructMultisigPsbt` take an optional
  `minFeeRate` param (default 1) that flows straight into this validator; the
  RBF/CPFP paths thread the same floor through `feeBump.ts`.
- `selectSpendCandidates()` — coin eligibility + coinbase-maturity
  filtering.

`multisigPsbt.ts` imports both directly from `./psbt`. This was a deliberate
refactor — the file headers of `multisig.ts`/`psbt.ts` note that
`multisigPsbt.ts` "used to carry a verbatim copy of each block."

### buildDraft / broadcast — one shared lifecycle engine (`spendLifecycle.ts`)

Since cairn-rg99 (Move 4 consolidation) the spend-record lifecycle is ONE
implementation: `src/lib/server/spendLifecycle.ts` — "a spend record has one
lifecycle (draft → awaiting_signature → completed/superseded), parameterized
by storage location". Both services call it with their `TxTableSpec`
(`{table: 'transactions', ownerColumn: 'wallet_id'}` vs
`{table: 'multisig_transactions', ownerColumn: 'multisig_id'}` — the same
closed-union pattern `feeBump.ts` established), injecting only what genuinely
differs as callbacks. The DB schemas stay deliberately parallel (see db.ts);
single-sig is NOT modeled as "M=1 multisig" (script types, finalization, and
signer coordination genuinely differ and stay per-side).

What lives once in `spendLifecycle.ts`:
- `executeBuildDraft` — per-owner lock, unconfirmed-trust classification,
  coinbase-maturity tip fetch, reservation exclusion + shortfall reframe,
  the draft INSERT, the post-save hook (multisig roster freeze), and the
  chain-depth/reservation warnings. Callers supply access resolution
  (`prepare`, inside the lock), the UTXO source, change derivation, and
  `constructPsbt` vs `constructMultisigPsbt`.
- `executeBroadcast` — the ENTIRE broadcast pipeline (details below).
  Callers supply `preparePsbt` (single-sig: normalize + substitution guard;
  multisig: ride-along signature merge via the normal attach path) and
  `finalize` (single-sig: `finalizePsbt` + friendly missing-signature/sighash
  mapping; multisig: quorum gate + `finalizeMultisigPsbt`).
- The spec-parameterized helpers behind both sides' public functions:
  `claimBroadcast`/`releaseBroadcastClaim` (the atomic double-broadcast
  guard — previously duplicated, "the most dangerous line in the codebase to
  have two of", now defined exactly once), `findCompletedDuplicate`,
  `deleteSpendDraft`, `updateSpendRow`, `insertDraftRow`,
  `ownBroadcastedTxids`, `reservedSpendCoins`, plus `BroadcastError`,
  `tryPackageRescue`, `classifyUnconfirmedTrust`, `coinsReservedByDrafts` and
  the reservation-message helpers (moved from `transactions.ts`, which
  re-exports them — `BroadcastError` by class identity — so existing
  importers are unchanged).
`spendLifecycle.test.ts` is the parity regression suite: the same
claim/dedup/supersede/forgery scenario matrix runs against BOTH specs, so a
future edit that forks the two wallet types' broadcast-claim behavior again
fails immediately.

Two pre-consolidation one-line divergences were deliberately unified (both
directions verified safe against the pinned suites, recorded on cairn-rg99):
the supersede-the-replaced-original UPDATE now uses the tighter single-sig
predicate (`status = 'completed'`) wrapped in the safer multisig `try/catch`
(bookkeeping after money moved must never fail a succeeded broadcast), and
completion now persists the authoritative PSBT on both sides (for multisig a
value-level no-op — the attach path already stored those bytes).

**`buildDraft` lifecycle** (`executeBuildDraft` in `spendLifecycle.ts`, called
by both `buildDraft()` and `buildMultisigDraft()`):

1. `withLock` (`keyedLock.ts`) — serializes concurrent draft builds *per
   owner* (commit `ff2d16f`). The reservation-exclusion read is racy on its
   own (multiple awaits between the read and the INSERT), so two truly
   concurrent builds could each see "nothing reserved" and pick the
   identical coin; the lock closes that window. Builds against *different*
   wallets are unaffected. Lock keys stay per-caller: `wallet:<id>` vs
   `multisig-draft:<id>` (the latter deliberately distinct from
   `nextMultisigChangeIndex`'s inner `multisig:<id>` lock — same key would
   deadlock).
2. Fetches live UTXOs (`getWalletUtxos`/`getMultisigUtxos` → Electrum
   `scripthash.listunspent`, batched, lane-routed), classifies unconfirmed
   trust (`ownBroadcastedTxids` + `classifyUnconfirmedTrust`), optionally
   fetches tip height (only if a coinbase coin is present).
3. **Coin reservation**: `reservedSpendCoins(spec, ownerId)` returns a map
   of `"txid:vout" -> draft ids` for every coin referenced by this owner's
   other in-flight (`draft`/`awaiting_signature`) drafts, computed by
   re-parsing each draft's stored PSBT via `summarizePsbt().inputs`
   (`coinsReservedByDrafts` — **there is no reservation table**).
   Auto-selection excludes these coins; coin control can still deliberately
   target a reserved coin (RBF/respend), surfaced as a non-blocking
   `reservationWarning` naming the colliding draft id(s).
4. Calls the injected builder (which derives the change address and runs
   `constructPsbt()`/`constructMultisigPsbt()`), inserts a `'draft'` row,
   runs the post-save hook (multisig: roster freeze + notify), returns
   `{draft, details, chainDepthWarning, reservationWarning}`.

**Broadcast dedup** (`broadcastTransaction()`, commit `8b591c2`): several
drafts built from identical inputs/recipient/amount/feeRate — exactly what
the coin-reservation race used to allow — sign to the byte-identical
transaction (deterministic ECDSA/RFC6979). Previously every one of them
would broadcast "successfully" and each get marked `'completed'` with the
same real txid — N phantom "sends" on record for one transfer. The fix:
- `findCompletedDuplicate()` (`spendLifecycle.ts`) checks whether a
  *different* `'completed'` row already exists for this owner with this
  exact txid.
- Checked **twice**: an "early" check right after `finalizePsbt()` computes
  the deterministic txid (before ever touching the network — skips the
  network call entirely for a known duplicate), and a "late" re-check after
  the Electrum broadcast call returns (closes the window where two
  concurrent byte-identical broadcasts race each other; SQLite is
  synchronous / Node is single-threaded so nothing can interleave between
  the late check and the status write).
- A duplicate is recorded via `markDuplicateBroadcast()` — reuses the
  existing `'superseded'` status (no schema migration needed) rather than
  adding a new status value.
- Broadcast is additionally protected by an atomic UPDATE-based claim
  (`broadcast_started_at`, `claimBroadcast()` in `spendLifecycle.ts`) so two
  concurrent calls for the *same* row can't both reach the network — the
  loser sees `'already_sent'`. A stale claim (crash mid-broadcast) expires
  after 60s so **retry** isn't wedged forever. The same 60s staleness window
  is mirrored on the delete path (`deleteSpendDraft`, cairn-ytnc): a claim
  younger than 60s blocks deletion (an in-flight or just-failed broadcast
  must not be erased), a stale one no longer does.
- After a real Electrum broadcast, the *reported* txid is checked against
  the locally recomputed deterministic txid (`finalized.txid`) — this closes
  invariant 2 from §1 (`cairn-ziwm`).
- A successful RBF replacement's broadcast also flips the ORIGINAL row (by
  `replacesTxid`) from `'completed'` to `'superseded'`.
- Opportunistic **package-relay rescue** (`tryPackageRescue`): if the node
  rejects a broadcast for a reason a parent+child package fee bump could fix
  (regex `PACKAGE_RESCUABLE_REJECTION` — min-relay-fee, missing-inputs,
  too-long-mempool-chain, etc.), Cairn fetches the tx's unconfirmed parent(s)
  and resubmits parent+child together via `broadcastPackage`
  (`packageRelay.ts`). Falls back silently to the original rejection on any
  failure — pure enhancement, never makes a failure worse.

### Shared fee-bump engine (`src/lib/server/feeBump.ts`)

One engine for RBF replacement AND CPFP, parameterized so both
`transactions.ts` and `multisigTransactions.ts` call the same skeleton with
wallet-type-specific callbacks (`buildReplacement`/`buildChild`,
`reloadDraft`, `draftSaveError`, and an optional `onDraftSaved` — multisig
uses this hook to freeze the signing roster and notify cosigners). The file
header states this money-moving logic was carried over **verbatim** from
two prior parallel implementations during the dedup refactor.

- `executeRbfBump()` — BIP-125 rule checks: every input must still signal
  RBF (sequence < `RBF_SIGNAL_MAX_SEQUENCE = 0xfffffffe`); rule 4 minimum fee
  (`minFee = originalFee + replacementVsize`, i.e. original fee plus 1
  sat/vB of the replacement's own size); rejects a changeless original (no
  fee headroom source). **"One live replacement per original"** is enforced
  by an authoritative partial UNIQUE index on `(owner, replaces_txid)` in
  `db.ts` — the pre-INSERT SELECT check is only a friendly fast path; the
  UNIQUE-violation catch (`isUniqueViolation()`) is what actually prevents
  two concurrent bumps from both succeeding.
- `executeCpfpDraft()` — `cpfpChildFee(targetRate, parentVsize, parentFee,
  childVsize, floorRate) = ceil(targetRate*(parentVsize+childVsize)) -
  parentFee`, floored to the child's own relay minimum — `floorRate` sat/vB
  over its own size. `executeCpfpDraft` threads in the connected node's own
  relay floor (`getRelayFeeFloor()`, `cairn-eacw.3`) here instead of a
  hardcoded 1 sat/vB, and rejects a `targetFeeRate` below that same floor
  (`cairn-eacw.7`) — so a sub-1 CPFP target builds a genuinely sub-1 child on
  a node that will actually relay it, while still refusing an unrelayable
  target on a node whose capability is unknown (fallback floor of 1).
  `cpfpChildFee`'s `floorRate` parameter defaults to 1 for any other caller.
  Qualifying inputs are the wallet's own unconfirmed outputs ON the stuck
  parent txid, coin-controlled and swept (send-max) to a fresh change
  address. Caps the target rate at the same `MAX_FEE_RATE` the PSBT builder
  enforces (a caller of it, not a bypass). Errors are typed (`CpfpError`)
  with specific codes: `no_unconfirmed_output`, `already_confirmed`,
  `parent_fee_unknown`, `not_needed` (parent already meets target or target
  below the node's relay floor), `coin_too_small`.
- `BumpError`/`CpfpError` are typed error classes with closed `code` unions
  the UI branches on.

**Offering the Speed up control (`src/lib/shared/speedUp.ts`, `canOfferSpeedUp()`,
cairn-iare):** when a CPFP target's `parent_fee_unknown` case (above — some
prevout wasn't decorated, so the parent's own fee genuinely can't be
computed) is deterministic rather than transient, a retry at submit time
hits the exact same lookup and fails the exact same way. Both wallet-detail
pages and the explorer tx-detail "Speed this up" CTA now call this one
pure predicate before rendering the button/rate input at all, so the
control simply isn't offered for an unconfirmed inflow it can never
service — no more broken affordance sitting next to its own
"can't be computed" apology after a failed submit. RBF replacement never
reads the parent's fee, so `canOfferSpeedUp` always returns true for it;
RBF eligibility is unaffected by this gate.

`transactions.ts` re-exports `BumpError`, `CpfpError`, `cpfpChildFee` from
`feeBump.ts` "so existing importers... keep working unchanged" — a shim
comment documenting the refactor's compatibility surface.

`recoverPsbtInputs()` (`transactions.ts`) rebuilds a `bumpTransaction`'s
spend set purely from the STORED psbt (txid/vout from input, value/script
from `witnessUtxo` or `nonWitnessUtxo`, chain/index from the embedded
`bip32Derivation` path's last two segments) — if derivation can't be
recovered for ANY input, `p2sh-p2wpkh` bumps are refused outright
(`redeemScript` needs the exact child key); other script types proceed
without embedding derivation metadata.

### Multisig: descriptors, quorum, BIP-48 (`src/lib/server/bitcoin/multisig.ts`)

Always `sortedmulti` (BIP-67 — address is a function of the key SET, not
order; cosigner order never matters anywhere). Three script forms: `p2wsh`
(default, `wsh(sortedmulti(...))`, BIP-48 suffix `2'`), `p2sh-p2wsh`
(`sh(wsh(sortedmulti(...)))`, suffix `1'`), and legacy `p2sh`
(`sh(sortedmulti(...))`, no BIP-48 suffix defined — ecosystem convention is
BIP-45 `m/45'`; Trezor's own `m/48'/0'/account'/0'` extension is also
tolerated). **Taproot multisig (`tr()`) is explicitly rejected** — no mature
interoperable MuSig2 (key-path) or FROST (script-path) tooling.

`deriveMultisigAddress(config, chain, index)` derives each cosigner's child
pubkey, BIP-67-sorts them, and wraps per script form, returning
`witnessScript` for wsh forms and `redeemScript` for sh forms (both for
`p2sh-p2wsh`). `multisigKeyDerivations()` produces per-key `bip32Derivation`
material for PSBT construction, sorted to match witness-script pubkey order.

**Cosigner path validation** (`validateCosignerKeyPath`, `CosignerPathMode =
'create' | 'import'`) is a meaningful but **not exhaustive** acceptance
gate: rejects single-sig purposes (44/49/84/86) on a multisig key outright;
for BIP-48 paths, enforces coin type 0 (mainnet) and the BIP-48 script
suffix matching the multisig's script form; for bare p2sh, accepts `m/45'`
and Trezor's `0'` extension, and (import-mode **only**) tolerates a
historical `1'` suffix mislabel with a warning — an old Cairn HW driver bug
that really produced legacy-P2SH keys at that path; on CREATE that same
`1'` is a hard rejection (it's the nested-segwit slot — accepting it on
create would mask a wrong-key paste). Bare-P2SH **creation** itself was
additionally removed from the multisig wizard (`cairn-acft`, closed
4d447fe) — the wizard's script-type radio disables `p2sh`, and
`hw/common.ts` throws rather than derive at the wrong `…1'` slot; see §18.1
row G. This create-vs-import asymmetry is deliberate, not an
inconsistency. For BIP-48 paths the gate now also confirms every level is
actually **hardened** — the coin/account/script-type levels are no longer
checked by numeric value alone, so `m/48'/0/0'/2'` (unhardened coin type) or
`m/48'/0'/0'/2` (unhardened script-type) are rejected, not waved through
(**`cairn-ryjc`, fixed** — was a value-only `unhardened()` check that every
fully-hardened acceptance test happened to miss). A former gap in the gate,
**`cairn-e8de`** — `stateless.ts`'s descriptor-import escape hatch never
called `validateMultisigKeyPaths` at all, so a malformed or wrong-script-type
cosigner path pasted through that path wasn't caught at ingestion the way the
wizard and Caravan-JSON import paths were — is now **fixed**:
`parseStatelessSource`'s bare-descriptor branch runs
`validateMultisigKeyPaths(desc, { mode: 'import' })` right after
`parseDescriptor`, same import-mode rules as `parseCaravanImport` (a
historical legacy-P2SH `1'`-suffix label warns instead of hard-stopping).

Beyond the path gate, `createMultisig` (`wallets/multisig.ts`) applies two
more create-time guards and one persistence guarantee: it rejects a
**depth-0 master** xpub pasted as a cosigner (`cosignerXpubDepth === 0`,
**`cairn-b9iv`**) — a master's watch surface is the whole seed, not one
account, and no path label reveals it, so the check is on the key's own
BIP-32 depth (parseXpub now surfaces `depth`); it rejects an embedded **NUL
byte** in the wallet name or any key name rather than let node:sqlite
silently truncate at it (**`cairn-y73r`**, shared guard `textGuard.ts`); and
the `multisigs` row plus all N `multisig_keys` rows are written inside one
`BEGIN`/`COMMIT` transaction (**`cairn-vzvw`**), so a mid-loop failure rolls
back rather than leaving a row whose stored key count disagrees with reality.
All three are **create-only** (import round-trips an existing on-chain wallet
untouched), mirroring the path gate's create-vs-import split.

**Broken-config resilience after a chain-network change (`cairn-zltwz`,
fixed `add8679`+`2323ab2`, v0.2.40).** An operator flipping the instance's
configured Bitcoin network (e.g. mainnet→regtest, or vice versa) used to
leave any already-created multisig wallet whose keys were encoded for the
OLD network in a hard-broken state, two ways: (a) `addressWatcher.ts`'s
multisig enumeration called `createMultisigDeriver(config)` **outside** its
own try/catch, so one network-mismatched multisig's throw aborted watch
registration for **every** multisig after it in iteration order, not just
the bad one — now wrapped in a per-wallet try/catch that logs and skips
just the offending wallet. (b) the wallet-detail page's `load()`
(`wallets/multisig/[id]/+page.server.ts`) called
`multisigToDescriptor(toMultisigConfig(multisig))` unconditionally, so a
`MultisigError` (thrown by `resolveKey`, which already correctly detects
the network mismatch) escaped uncaught as a raw 500 instead of a friendly
message — now caught, returning `descriptor: null` + a plain-language
`descriptorError` that `+page.svelte` renders as a warning banner near the
top of the page instead of crashing. `resolveKey` itself needed no network
threading — it already defaulted to the current
`getDefaultNetwork()`/`setDefaultNetwork()` value, which is exactly why it
correctly detected the mismatch in the first place.

**Descriptor import/export**: `multisigToDescriptor()` / `parseDescriptor()`.
Byte-compatible with Bastion's format (`[fp/48h/0h/0h/2h]xpub/0/*`, lowercase
fingerprint, `h`-hardened). BIP-380 checksum is a hand-ported
`descriptorChecksum()` (Bitcoin Core's `DescriptorChecksum`, verified against
published vectors). Rejects `multi()` (unsorted — re-export as sortedmulti)
and `tr()` by name with actionable messages. SLIP-132 handling: `Ypub`/
`Zpub` (multisig-specific prefixes) are rewritten to standard xpub bytes
before parsing (`toStandardXpub`) — a superset of what `xpub.ts`'s
`parseXpub` alone handles.

**Caravan round-trip** (`src/lib/server/multisigExport.ts`):
- `caravanExport(multisig)` — emits Caravan/Unchained-compatible wallet-
  config JSON: `uuid` = the receive descriptor's own BIP-380 checksum
  (Caravan sets this on descriptor import; omitting it triggers Caravan's
  "undefined" re-export bug), both quorum fields, canonical xpubs,
  apostrophe-hardened paths, Caravan's masked `"m/0/0/.../0"` depth-
  preserving path for unknown-origin keys (`maskedPath`, depth read via
  `HDKey.fromExtendedKey`), deliberately no `client` field (Caravan's own
  unknown-client shape fails its own re-import) and no per-key `method`
  field. Also carries `startingAddressIndex` = the multisig's live receive
  cursor, so a backup→restore round-trip resumes issuing fresh addresses
  instead of reusing index 0.
- `parseCaravanImport(text)` — the reverse; rejects blobs over 1MB and
  anything containing `xprv`/`yprv`/`zprv`/`tprv`
  (`containsPrivateKeyMaterial`) up front with a load-bearing "never paste a
  private key" refusal, bounds key count to `MAX_MULTISIG_KEYS` (15) before
  doing per-key work, rejects non-mainnet network fields, per-key-attributes
  every validation error/warning.
- `coldcardRegistration(multisig)` — the ColdCard multisig setup-file format
  (also read by Passport/Keystone/SeedSigner); ASCII-only 20-char names.
- `descriptorBackup(multisig)` — plain-text receive+change descriptor dump
  with human-readable prose explaining what it can/can't do.

### Hardware wallet signing

Drivers live under `src/lib/hw/`: `trezor.ts`, `ledger.ts`, `bitbox02.ts`,
`jade.ts` (Blockstream Jade — USB and QR/air-gapped variants); ColdCard and
generic "Animated QR" (SeedSigner/Passport/Jade) are file/QR round-trips
with no live-device driver. Corresponding Svelte components:
`src/lib/components/signing/{TrezorSigner,LedgerSigner,BitboxSigner,
JadeUsbSigner}.svelte`, plus
`src/routes/(app)/wallets/[id]/send/_components/{QrSigner,ColdCardSigner,
DeviceCard}.svelte`.

`src/routes/(app)/wallets/[id]/send/_components/signMethods.ts` —
`deviceSignMethods(walletScriptType, caps)` builds the Sign step's tile
grid, gated by injectable capability probes (`isTrezorConnectAvailable`,
`isWebHidAvailable`, `isBitbox02Available` + `bitbox02SupportsScriptType`,
`isWebSerialAvailable`). A method whose capability check fails stays in the
list with `available: false` and an `unavailableReason` string (never
silently disappears) — e.g. BitBox02 is explicitly disabled for p2pkh
wallets ("The BitBox02 doesn't support legacy (P2PKH) single-sig wallets").

**Common per-device shape**: read an account xpub + master fingerprint at
connect time (stored as the wallet's `master_fingerprint`/`derivation_path`,
used to embed `bip32Derivation` in constructed PSBTs); later, sign a PSBT
and merge signatures/finalize. Trezor/Ledger return per-input signatures
Cairn merges back itself; **BitBox02 is the outlier** —
`btcSignPSBT` returns the fully-signed PSBT directly, no merge-back needed.

**BitBox02 multisig registration quirk** (fixed and committed at `93f6ff4`):
the BitBox02 firmware refuses to sign for a multisig script config it
hasn't seen registered on-device first — the "verify on device" contract
(device shows quorum + every cosigner key, user approves once).
`signPsbtWithBitbox02()` originally signed straight through without ever
registering. Fix in `bitbox02.ts`: `maybeRegisterMultisig()` checks
`btcIsScriptConfigRegistered()` and only runs the on-device registration
ceremony (`btcRegisterScriptConfig`) if not already registered — idempotent,
so re-signing never re-prompts. Called from `signPsbtWithBitbox02()` before
every multisig sign, right after `assertBitboxIsExpectedKey()` (a "wrong
device" guard verifying the connected BitBox02's xpub/fingerprint actually
matches the expected cosigner key for this signing slot). Unlike Ledger, the
BitBox02's registration lives only ON the device (nothing persisted
server-side) — a browser-data wipe just re-triggers the one-time on-device
approval next time.

**Ledger multisig registration** IS persisted server-side, by contrast:
`src/lib/server/multisigRegistrations.ts` stores one row per (multisig,
device-master-fingerprint) in a Ledger-specific table — the BIP-388 wallet
policy HMAC the Ledger returns after its own one-time on-device policy
review (`registerMultisigPolicy` in `ledger.ts`). The HMAC is not secret
(only lets the device skip re-approving a known policy) but rows are still
access-gated per multisig. `UNIQUE(multisig_id, master_fp)` — re-registering
upserts.

**Master fingerprint handling**: single-sig wallets store
`master_fingerprint`/`derivation_path` on the `wallets` row; multisig
cosigner keys store their own fingerprint/path per key
(`MultisigKeyDescriptor`). Both flow into embedded PSBT `bip32Derivation`
fields so hardware signers can locate the right key. `keyOrigin.ts`
(`src/lib/hw/keyOrigin.ts`) has the shared `parseKeyOriginInput`/
`normalizeFingerprint`/`normalizeOriginPath` helpers used when a user
hand-enters an origin rather than reading it live from a device.
`cosignerDetection.ts` (server) does related identity-matching for multisig
setup flows.

**Device timeouts**: every real device round-trip in `bitbox02.ts` is raced
against a 45s timeout (`withDeviceTimeout`) so a frozen/locked/disconnected
device can't hang the signer UI forever (no cancellation hook exists once a
call is in flight — this only bounds how long the caller waits).

### Single-sig vs multisig duality — what's shared vs forked

**Shared** (post wallet-dedup-refactor + cairn-rg99 consolidation):
- `psbt.ts`'s `validateRecipientsAndFeeRate` / `selectSpendCandidates`.
- `feeBump.ts`'s entire RBF+CPFP engine; both services call the same
  `executeRbfBump`/`executeCpfpDraft` skeletons.
- `spendLifecycle.ts` — the whole spend-record lifecycle (cairn-rg99):
  `executeBuildDraft` (lock, trust classification, reservation, draft
  persistence) and `executeBroadcast` (atomic claim, duplicate dedup,
  package rescue, txid verification, supersede bookkeeping), plus the
  spec-parameterized row helpers and the moved shared utilities
  (`BroadcastError`, `tryPackageRescue`, `classifyUnconfirmedTrust`,
  `coinsReservedByDrafts`, reservation messages). Both service files are now
  siblings of this third shared module; `transactions.ts` re-exports the
  moved symbols so historical import paths keep working. Parity is pinned by
  `spendLifecycle.test.ts` (same scenario matrix over both tables).
- `detectUnconfirmedInflows` / `normalizePsbt` / `InvalidPsbtError` — defined
  in `transactions.ts` and imported by `multisigTransactions.ts`.
- All 4 USB hardware-signer drivers (Trezor/Ledger/BitBox02/Jade) already
  handle both single-sig and multisig signing within one file each.
- Descriptor/BIP-48/Caravan logic in `multisig.ts`/`multisigExport.ts` has no
  single-sig equivalent to fork from — it's inherently multisig-only.

**Still forked** (deliberate, per the cairn-rg99 design rule "don't model
single-sig as M=1 multisig"):
- `constructPsbt` (`psbt.ts`) vs `constructMultisigPsbt` (`multisigPsbt.ts`)
  — two separate PSBT-building functions sharing only the two validation/
  eligibility helpers above. Multisig construction additionally handles
  N-of-M `bip32Derivation` sets, witnessScript/redeemScript attachment, and
  incremental-signature accumulation (`combineMultisigPsbts`,
  `multisigPsbtProgress`) that single-sig has no analog for.
- The two DB tables (`transactions` vs `multisig_transactions`) stay
  parallel (see db.ts), and each service keeps its genuinely-different
  surface: access tiers (owner/cosigner/viewer vs plain ownership), the
  attach/quorum signature flow, roster freeze/notification hooks, and
  finalization.
- Two device-timeout/capability-probe patterns per driver file, not unified
  (each of `trezor.ts`/`ledger.ts`/`bitbox02.ts`/`jade.ts` independently
  implements single-sig AND multisig account-path/read/sign functions, but
  the 4 files are siblings of each other, not sharing a common driver base).

### Data flow: user submits a send → PSBT → signed → broadcast

1. **Send form** (`+page.server.ts` / route action) collects recipients +
   fee rate (+ optional coin control) → calls `buildDraft()`
   (`transactions.ts`) or the multisig equivalent.
2. `buildDraft` takes the per-wallet lock, pulls live UTXOs via
   `getWalletUtxos()` (batched, lane-routed so background scans don't steal
   the interactive Electrum socket), classifies unconfirmed trust, excludes
   coins reserved by other in-flight drafts, calls `constructPsbt()`, INSERTs
   a `'draft'` row, returns the draft plus `ConstructedPsbt` details (plus
   any chain-depth/reservation warnings).
3. User reviews the draft (recipients, fee, change) client-side.
4. **Signing**: depending on the wallet's configured/chosen device type, the
   unsigned PSBT is handed to a hardware driver (USB WebHID/WebSerial, or a
   file/QR round-trip for air-gapped signers) which returns a signed PSBT
   (or, for QR/file, the user uploads/pastes one back).
5. **Broadcast** (`broadcastTransaction()`): if a signed PSBT is supplied,
   it's normalized (`normalizePsbt` — accepts base64/hex/text-wrapped
   variants), commitment-checked against the stored draft
   (`assertSameTransaction`), then `finalizePsbt()`'d to raw hex plus the
   locally-computed txid. Duplicate-broadcast and atomic-claim checks run
   before the actual `chain.electrum.broadcast(rawHex)` call. On success the
   reported txid is verified against the locally-computed one, the row flips
   to `'completed'`, and if this was an RBF replacement the original row it
   replaces flips to `'superseded'`.
6. A rejected broadcast may trigger the opportunistic package-relay rescue
   before surfacing a friendly rejection message
   (`friendlyBroadcastRejection`, `broadcastRejection.ts`).

---

## 6. Server: Database & Migrations

Cairn has no ORM, no query builder, and no formal migration framework. This
section explains the actual convention so you don't go looking for Drizzle/
Knex config that doesn't exist.

### Connection

`src/lib/server/db.ts` is the **one** place the DB connection lives:
`export const db = new DatabaseSync(DB_PATH)`, using Node's built-in
`node:sqlite` — no `better-sqlite3` or other driver dependency.
`DB_PATH = env.HEARTWOOD_DB ?? env.CAIRN_DB ?? path.join(process.cwd(),
'data', 'cairn.db')` (`db.ts:16-17`). `HEARTWOOD_DB` is the post-rebrand
alias; `CAIRN_DB` stays supported indefinitely for existing installs. On
load: `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA
busy_timeout = 5000;`, then the schema is defined. Everywhere else in the
server tree just does `import { db } from './db'` and calls
`db.prepare(...).get/.all/.run(...)` directly — synchronous, no query
builder.

### The sync-SQLite-blocks-event-loop caveat (see also §1 invariant 4)

`node:sqlite`'s `DatabaseSync` is fully synchronous — every query blocks
Node's single event-loop thread for its duration. This was previously
root-caused as the actual cause of rapid-navigation stutter (abandoned/
uncancelled nav requests each blocking the loop). Because of this, the
codebase is careful to keep write-heavy transactional code **fully
synchronous with no `await` in between `BEGIN`/`COMMIT`** — see the comment
on `registerUserWithHash` in `auth.ts:454-474`: the function is deliberately
non-async, since any real await inside an open transaction would let a
concurrent request's own `BEGIN` interleave and corrupt/rollback the
in-flight transaction. Any async step (password hashing) must happen
*before* opening the transaction. Password hashing itself was moved off the
sync path for the same class of reason: `scryptSync` used to run on the main
thread and froze the event loop 150-300ms per call on a Pi 4; `scryptAsync()`
now wraps callback-style `scrypt()` to run on the libuv threadpool instead.
The retention sweep, feature-flag resolution, and most helpers are plain
synchronous `db.prepare().all()` calls per request — a deliberate, repo-wide
convention (see `resolve.ts`'s header comment: "Deliberately synchronous...
an async signature here would be the one inconsistent call site").

### Schema / migrations system

There's no numbered-migration mechanism. Instead `db.ts` is one long,
append-only sequence:

1. An initial `CREATE TABLE IF NOT EXISTS ...` block (~lines 23-104) for the
   founding tables.
2. Many subsequent **guarded, additive blocks** appended below it, each
   following the same idiom:
   ```ts
   const cols = (db.prepare('PRAGMA table_info(x)').all() as {name:string}[]).map(c=>c.name);
   if (!cols.includes('new_col')) db.exec('ALTER TABLE x ADD COLUMN new_col ...');
   ```
   This makes every migration idempotent and safe to run on every process
   start. There is no migration-runner or versioning table — `db.ts` itself,
   executed top-to-bottom at import time, *is* the migration log. **When you
   add a column, this is the pattern to copy — do not reach for a separate
   migration file for a simple additive `ALTER TABLE`.**
3. A few heavier one-off migrations get their own file instead, invoked from
   `hooks.server.ts`'s `init()`: `explorerDefaultMigration.ts`
   (`migrateExplorerDefault()`), `instanceModeMigration.ts`
   (`migrateInstanceMode()`), `secretsMigration.ts`
   (`migratePlaintextSecretsAtRest()`), `disclosures.ts`
   (`ensureDefaultAgreementVersion()`).
4. A genuine table-rename migration in `db.ts` (~lines 178-270): the historic
   "vault → multisig wallet" rename (`vaults`→`multisigs`,
   `vault_keys`→`multisig_keys`, etc.), including an "empty-shell recovery"
   branch that detects and repairs a partial-migration state from two dev
   servers racing on one DB.
5. A rebuild-in-place migration for `notified_txids` (`db.ts:775-809`) when
   the old `UNIQUE` constraint shape is detected (SQLite can't `ALTER` a
   constraint, so it renames-old/creates-new/copies/drops).

**Cross-table cleanup via triggers, not app code.** Eight "polymorphic child"
tables (`balance_snapshots`, `wallet_backups`, `address_labels`,
`backup_missing_notified`, `notified_txids`, `wallet_snapshots`,
`scripthash_status`, `backup_nudges`) key off a `(wallet_kind, wallet_id)` pair
rather than a real FK (SQLite has no polymorphic FK). Two triggers,
`trg_wallets_delete_children` and `trg_multisigs_delete_children`, sweep all
eight whenever a `wallets`/`multisigs` row is deleted — covering both direct
`DELETE`s and cascaded user deletion. `backup_nudges` joined this scheme late
(`cairn-o0dhu`) — it shipped in v0.2.41 without being wired into either
trigger, so its rows were silently orphaned (never swept on wallet/multisig
deletion) until the fix. They're defined with `DROP TRIGGER IF EXISTS` +
`CREATE TRIGGER` (not `IF NOT EXISTS`) specifically so edits to the trigger
body actually redeploy to existing DBs. `deleteCascade.test.ts` introspects
the DB and fails loudly if a new `(wallet_kind, wallet_id)` table is ever
added without wiring it into both triggers — **if you add such a table, wire
the trigger first or this test will catch you.** One exception:
`multisig_shares` also has a `wallet_kind` column but is deliberately
excluded — its parent link is a real `multisig_id` FK with `ON DELETE
CASCADE`. There's also a plain "sweep now, unconditionally, every boot"
orphan purge (`db.ts:864-877`) for rows left behind before the triggers
existed.

**Collision safety (`wallets.id`/`multisigs.id` are disjoint AUTOINCREMENT
spaces that both start at 1, so `wallet_id=N` existing in both tables is the
steady state, not an edge case — cairn-n4az).** Every read/write against the
six tables above pairs `wallet_kind` with `wallet_id` in its `WHERE`/`INSERT`
— audited by grepping every call site (`addressLabels.ts`, `backups.ts`,
`backupHealth.ts`, `portfolio.ts`, `addressWatcher.ts`, `walletSync.ts`,
`dataRetention.ts`); none found scoping by `wallet_id` alone. `transactions`/
`tx_labels` look similar but are **not** part of this pattern — they carry a
real `wallet_id INTEGER REFERENCES wallets(id)` FK and are single-sig-only
(multisig transactions live in the separate `multisig_transactions` table
with its own `multisig_id` FK), so an un-paired `wallet_id = ?` there is
correct, not a gap. `walletMultisigIdCollision.test.ts` proves this two ways:
service-layer reads (address labels, backup status, balance snapshots) stay
scoped to their own kind when a wallet and a multisig share the same numeric
id, and a generic introspective sweep (same discovery idiom as
`deleteCascade.test.ts`) seeds every discovered polymorphic table at a
colliding id and asserts deleting one kind's parent never touches the other
kind's row. The bead's larger structural ask — a `wallet_entities(kind,
ref_id)` mapping table with a real composite FK from every child, replacing
the trigger-sweep pattern entirely, plus adopting `PRAGMA user_version` for
ordered migrations instead of the probe-`table_info`-and-patch style used
throughout this file — remains open and deliberately deferred (per the
bead's own note: bundle it with the next schema-touching change, not as a
standalone migration on a live funds DB).

### Main tables (~40, grouped by purpose)

**Auth/identity**

| Table | Purpose |
|---|---|
| `users` | id, email (UNIQUE, NOCASE), `password_hash` (nullable), display_name, `is_admin`, `disabled`, `must_reset_password` |
| `sessions` | token_hash (SHA-256), user_id, expires_at, user_agent/ip_address |
| `user_credentials` | WebAuthn/passkey credentials (credential_id, public_key, counter, transports, device_type, backed_up) |
| `account_recovery_phrases` / `account_recovery_codes` | login-recovery secrets (scrypt-hashed like passwords) — **not** Bitcoin recovery |
| `recovery_grants` | short-TTL token authorizing only "register a new passkey" after a successful recovery verify |
| `known_devices` | per-user device fingerprint (sha256 of UA) for new-device login alerts |
| `invites` | invite codes (code, max_uses, used_count, revoked, expires_at, welcome_message) |
| `admin_disclosure_acceptances` / `user_agreement_acceptances` | legal clickwrap records |

**Wallets (single-sig)**

| Table | Purpose |
|---|---|
| `wallets` | user_id, name, type, xpub, script_type, receive_cursor, master_fingerprint/derivation_path/device_type |
| `transactions` | wallet drafts/broadcasts: status (`draft\|awaiting_signature\|completed\|superseded`), psbt, txid, recipient, amount, fee, fee_rate, change_index, broadcast_started_at, replaces_txid, recipients (JSON, batch sends) |
| `tx_labels`, `address_labels`, `saved_addresses` | labels / address book |

**Multisig**

| Table | Purpose |
|---|---|
| `multisigs` | user_id, name, threshold, script_type, receive_cursor, source ('created'\|'imported' — gates mandatory backup UX), collaborative |
| `multisig_keys` | position, name, category, device_type, xpub, fingerprint, path, last_verified_at/last_notified_at, assigned_user_id |
| `ledger_multisig_registrations` | BIP-388 wallet-policy HMAC per device per multisig |
| `multisig_transactions` | parallel to `transactions` (deliberately not merged) |

**Collaborative custody** (single-instance only, no federation)

| Table | Purpose |
|---|---|
| `contacts` | friends-only social graph, status pending/accepted |
| `multisig_shares` | share a multisig with a contact, role viewer\|cosigner |
| `multisig_transaction_signers` | frozen per-transaction signer roster + assigned_key_ids (JSON) + has_signed (advisory only) |

**Caches / snapshots** (all "pure cache, missing row = fallback to live scan")

| Table | Purpose |
|---|---|
| `wallet_scan_cache` | keyed by xpub/descriptor, seeds in-memory 60s scan cache on cold start |
| `wallet_snapshots` | per-wallet SWR render source, read synchronously by page loaders |
| `balance_snapshots` | one row per (user, wallet, sample tick) for portfolio charts |
| `chain_snapshot` | singleton row (id=1), global chain-tip data |
| `mempool_samples` | rolling per-second mempool size samples |
| `portfolio_snapshot` | one row per user, dashboard aggregate |
| `tx_snapshots` | per-txid decoded-tx cache, global |

**Notifications**

| Table | Purpose |
|---|---|
| `notification_preferences` | per-user per-event-type per-channel routing |
| `notification_channel_config` | per-user per-channel connection config (JSON), verified_at |
| `user_pgp_keys` | optional PGP pubkey for email encryption |
| `notification_queue` | outbound delivery queue for non-inapp channels, status pending/sent/failed/dead |
| `user_notification_settings` | quiet hours (start/end/tz/urgent_override) |
| `backup_missing_notified` | throttle memory for the daily backup-missing scan |
| `events` | in-app activity feed AND the "in-app channel" of the notification system, in one table |

**Admin / instance config**

| Table | Purpose |
|---|---|
| `settings` | plain key/value store (registration_mode, instance_mode, electrum_*, socks5_*, core_rpc_url/user, auth_mode, ...) |
| `instance_secrets` | key/value_enc — encrypted-at-rest counterpart to `settings` |
| `feature_flags` / `user_feature_flags` | global + per-user overrides |
| `announcements` / `announcement_dismissals` | admin banner system |
| `multisig_service_referrals` | admin-managed "buy a device / managed multisig service" links |
| `device_keys` | cache of xpub last read off a HW device per (user, master fingerprint, purpose) |
| `backup_reminders` | per-user dismissal timestamp for the periodic (90-day-stale-backup) reminder |
| `wallet_backups` | one row per wallet once its config file has been downloaded |
| `backup_nudges` | one row per still-unbacked wallet: `first_seen_at`/`last_shown_at`/`shown_count`/`stakes_bucket` — decaying-cadence state for the never-backed-up nudge (`cairn-gt05.5`, distinct from `backup_reminders` above); see § "Backup & restore" |

**Mining (multi-user solo pool, epic `cairn-vn43`)**

| Table | Purpose |
|---|---|
| `mining_prefs` | one row per user: `mining_id` (`hw_` + 8 lowercase hex, UNIQUE — the Stratum username token), `enabled`, `payout_wallet_id` (nullable FK, `ON DELETE SET NULL`) |
| `mining_workers` | durable per-`(user_id, worker_name)` mirror (UNIQUE pair) of cumulative counters: `shares_accepted`/`shares_stale`/`shares_rejected`, `sum_weight` (TEXT, arbitrary-precision accumulation), `best_share_diff`, `hashrate_est`, `current_diff`, `last_share_at` — the engine's in-memory state is authoritative for "now" figures; this table is the 15s-flushed backing store, the source of the all-time-best baseline, and what survives a restart |
| `mining_stats` | one row per closed 1-minute bucket, per worker, plus one pool-wide row per bucket (`user_id`/`worker_name` both NULL) feeding the admin hashrate chart; `round_id` is reserved-NULL, an unused future split-mode seam; pruned past 7 days on an hourly sweep |
| `mining_blocks` | one row per submitted block, accepted or rejected (`submit_result` — `'accepted'` or `'rejected:<reason>'`); `block_hash` is UNIQUE, so a rejected solve gets a synthetic `rejected:<height>:<nonceHex>:<epochMs>` key rather than colliding; `payout_address`/`coinbase_value_sats`/`wallet_id` record exactly what that block paid and to whom |

Only the in-process mining engine bridge (`src/lib/server/mining/aggregates.ts`) writes `mining_workers`/`mining_stats`, and only inside one batched transaction on a 15s timer — **never per-share** — per the `cairn-xlrm` sync-SQLite-blocks-the-event-loop hazard (§ above; see § "Mining engine" below for the full lifecycle). `mining_blocks` is written once, synchronously, from the block-accepted/rejected callback — a rare enough event (once per found/rejected block) that it doesn't need batching.

### Secret encryption (`secretKey.ts` / `instance_secrets`)

A 32-byte **instance key** is generated on first use and written to
`<dirname(DB_PATH)>/instance.key` (mode 0600) — colocated with the DB
file's directory but **outside the DB itself**, so a leaked/exported
`cairn.db` copy (backup, screenshare) can't be decrypted without the
separate key file. Under Docker/Umbrel this lands on the same mounted
`/data` volume as the DB. Cipher: AES-256-GCM, with the actual cipher key
derived from the instance key via `hkdfSync('sha256', instanceKey, '',
HKDF_INFO, 32)` — domain-separated via a fixed info label so future reuse
of the same instance key for another purpose won't collide. Note:
`HKDF_INFO = 'cairn:notification-smtp-pass'` reads as SMTP-specific but is
actually the shared domain-separation label for **all four** secret kinds
below — not a bug, just a literal string that predates the other three.
`encryptSecret(plaintext)` returns a versioned JSON envelope `{v, iv, tag,
data}` (all base64); `decryptSecret()` is the inverse and throws
`SecretKeyError` on version mismatch or a failed GCM auth-tag check (tamper
detection) rather than silently returning garbage. `isSecretEnvelope(text)`
distinguishes an already-encrypted envelope from legacy plaintext. Example
envelope, `instance_secrets.value_enc` for key `core_rpc_pass` after
`encryptSecret()`:
```json
{"v":1,"iv":"7Jc3F2m9mF3Q8s0m","tag":"k1s0X9m...==","data":"aG93ZHk...=="}
```
(`iv`/`tag`/`data` are base64; `v` is the envelope-version integer checked
by `decryptSecret()` for forward compatibility.)
`settings.ts` exposes `setSecretSetting(key, value)` /
`readSecretSetting(key)` / `hasSecretSetting(key)`: these write to the
dedicated `instance_secrets` table (not `settings`) and delete any legacy
plaintext row in `settings` for the same key on write. An explicit-clear is
stored as `''` (falsy, not absent). Current secret keys: `smtp_pass`,
`core_rpc_pass`, `telegram_bot_token`, `nostr_sender_privkey`,
`scheduled_backup_pass` (backup.ts).

### Factory reset (`resetInstance()`, `admin.ts`)

`resetInstance()` (called from the admin settings "Danger Zone" action)
deletes every user, session, wallet, invite, `settings` row, `events` row,
`notified_txids` row, announcement and multisig-service-referral in one
transaction, then the next visit to `/signup` is the first-run flow again.

It ALSO deletes every row of `instance_secrets` (every encrypted SMTP/
Core-RPC/Telegram/Nostr credential and the scheduled-backup passphrase) and
every row of `feature_flags` outright — fixed cairn-rksw, previously both
tables survived a reset (the `feature_flags` NO-ACTION FK fix for cairn-hl87
only nulled `updated_by`, it didn't clear the rows), which meant a "reset"
instance silently handed the next operator the prior operator's SMTP
password, Core RPC password, Telegram bot token, and Nostr identity key —
a confidentiality leak on device handover/resale, made worse by the
settings UI copy inviting reuse of an orphaned stored password. Per-user
secrets (e.g. the personal SMTP password embedded in
`notification_channel_config.config`, see §6/§9) are not a separate case:
they cascade away as an ordinary side effect of `DELETE FROM users` via
that table's `ON DELETE CASCADE` FK, same as every other per-user row.
`feature_flags` must be deleted BEFORE `DELETE FROM users` in the same
transaction (its `updated_by` FK is NO ACTION, not CASCADE) — deleting
`instance_secrets` has no such ordering constraint since it carries no
user FK at all.

Regression coverage: `destructiveOps.test.ts`'s factory-reset group has a
table-driven test enumerating every known `instance_secrets` key plus the
per-user encrypted-SMTP case, so a future secret store added without wiring
into the reset (or into this table) fails loudly instead of silently
repeating cairn-rksw.

### Data retention (`dataRetention.ts`)

Registered steps run by `runRetentionSweep()`, started once from
`hooks.server.ts` (30s after boot, then every 24h, both timers `.unref()`d
so they never hold the process open; a step throwing is logged and doesn't
block the rest):

| Step | Behavior |
|---|---|
| `purgeBalanceSnapshots` | drops rows >13 months old; downsamples 30-day-to-13-month rows to one-per-day; drops orphaned rows for deleted wallets/multisigs |
| `purgeNotificationQueue` | drops terminal (sent/dead) rows older than 30 days; never touches in-flight pending/failed |
| `purgeExpiredAuthRows` | sweeps `sessions` and `recovery_grants` past expires_at |
| `purgeStaleKnownDevices` | drops device fingerprints not seen in 365 days |

This module exists because a prior data audit found nothing in the codebase
ever purged aged rows.

### Key gotchas for a new contributor (database layer)

1. Never `await` inside an open `db.exec('BEGIN')` transaction.
2. Schema changes are additive `ALTER TABLE` blocks guarded by a `PRAGMA
   table_info` check, appended to the bottom of `db.ts` — there is no
   separate numbered-migration mechanism to reach for.
3. Adding a new `(wallet_kind, wallet_id)`-keyed child table requires wiring
   it into BOTH `trg_wallets_delete_children` and
   `trg_multisigs_delete_children` in `db.ts`, or `deleteCascade.test.ts`
   will fail.
4. A leaked `cairn.db` file alone does NOT compromise `instance_secrets` —
   the decryption key lives in a sibling `instance.key` file. Don't
   "simplify" by moving the key into the DB.

---

## 7. Server: Auth, Sessions & Access Gates

Cairn supports two independent-but-composable authentication mechanisms and
a three-tier access model layered on top of the multisig tables for
collaborative custody. This section is the map of who can do what, and where
that's enforced.

### Dual auth model (`src/lib/server/auth.ts`, `webauthn.ts`)

**Email + password** (scrypt) is the default and is **required** for
Umbrel/Docker deployments (no browser passkey ceremony there).
`password_hash` is nullable — NULL means passkey-only. **Passkeys
(WebAuthn)** are optional/additive, added via settings; credentials live in
`user_credentials`. An account can have a password, one or more passkeys, or
both. `getAuthMode()` resolves the primary sign-up method
(`'password'|'passkey'`) via `env.CAIRN_AUTH_MODE` (wins, Umbrel/Docker pin
`'password'`) → `settings.auth_mode` → default `'password'`. This governs
which flow the registration UI leads with; passkeys remain usable as an
additive login method regardless. Passwords use scrypt with `N=16384, r=8,
p=1`, stored as `scrypt:N:r:p:saltB64:hashB64`, hashed via `scryptAsync`
(libuv threadpool, not `scryptSync`) to avoid blocking the event loop.
`loginWithPassword(email, password)` uses the **same** error message for
"unknown email," "no password set," and "wrong password" — it never reveals
account existence.

### Sessions

`SESSION_COOKIE = 'cairn_session'`. `createSession(userId, context?)` mints
a `randomBytes(32)` base64url token, stores only `hashToken()` (SHA-256 hex)
in `sessions`, sets `expires_at = now + 30 days`. Also updates
`users.last_login` and (if `context` given) calls
`recordDeviceAndMaybeNotify` for new-device detection (`deviceTracking.ts`).
`getSessionUser(token)` joins `sessions`+`users`, returns `null` for
missing/disabled/expired (deleting the expired row on the way out).
`setSessionCookie()` sets httpOnly, `sameSite: 'lax'`, and `secure` per
`cookieSecure(url)` — which follows the request protocol **except** it's
forced non-secure when `CAIRN_ORIGIN` explicitly declares `http:`. This
exists because adapter-node assumes https by default behind a plain-HTTP
reverse proxy (e.g. Umbrel's `app_proxy`), which would otherwise silently
drop the `Secure` cookie and break login with no visible error.

`cookieSecure(url)`'s `url` comes from SvelteKit's own request URL, which
adapter-node derives from `PROTOCOL_HEADER` (or defaults to `https` if
neither `ORIGIN` nor `PROTOCOL_HEADER` is set) — so the CAIRN_ORIGIN escape
hatch above only ever helped single-listener, fixed-origin deployments.
**`server.mjs`'s bare-node (no reverse proxy) deployments hit the same
default-to-https trap on their plain-HTTP listener too** (`cairn-wrph`,
`cairn-9njl`, fixed `0ff9557`): with no `ORIGIN` and no operator-set
`PROTOCOL_HEADER`, adapter-node's `get_origin()` reported every request as
`https` regardless of which of the two listeners (HTTP port / self-signed
HTTPS port, §9.7) actually received it, so `cookieSecure()` stamped `Secure`
on the session cookie even over plain HTTP — the browser silently drops a
`Secure` cookie set over an insecure response, so login looked like a
successful 200 but the cookie never stuck. The fix, entirely in
`server.mjs`/`scripts/serverProto.mjs` (no `auth.ts` changes): for
unconfigured deployments (`!ORIGIN && !PROTOCOL_HEADER`), `server.mjs` now
defaults `PROTOCOL_HEADER=x-forwarded-proto` and each listener's request
handler calls `fillForwardedProto(req.headers, 'http' | 'https')` — a
**fill-when-absent** helper that stamps that listener's own protocol onto
the header only if it isn't already present. The "only if absent" rule is
load-bearing: a TLS-terminating reverse proxy sitting in front of the plain
HTTP port (or Umbrel's `app_proxy`, which sets its own forwarded headers)
must set its own `X-Forwarded-Proto` — that value is honored as-is, never
overwritten by this fill. A proxy that terminates TLS but doesn't set
`X-Forwarded-Proto` gets a loud regression (browser drops the wrongly-Secure
cookie) rather than the old silent one; the alternative is setting
`ORIGIN`/`CAIRN_ORIGIN` to the externally-visible `https://` URL instead,
which bypasses header-based detection entirely. See the env var table
(`PROTOCOL_HEADER`) and the Umbrel compose vars below — Umbrel's `app_proxy`
already sets `PROTOCOL_HEADER=x-forwarded-proto` explicitly, so it was never
affected by this bug; this fix is specifically for direct/unproxied
deployments. Personal API
tokens (`apiTokens.ts`) share the exact same `hashToken()` scheme so both
stores are hash-only-at-rest. **See also §8** for the full bearer-token
auth path (`Authorization: Bearer cairn_...`, rate-limited, resolved via
`apiTokens.ts`'s `getApiTokenUser()`) — it's a third way in alongside
password and passkey, described there rather than here since it's wired
through `requireUser()` in `api.ts`.

### Registration / bootstrap

`registerUser()` (async, hashes password) → `registerUserWithHash()` (pure
sync core, safe to call inside an open `BEGIN` transaction — see the
sync-SQLite caveat in §6). First registered user becomes admin. Registration
mode (`open`/`invite`/`closed`) is enforced via `assertCanRegister()`.

**Umbrel/Docker admin auto-bootstrap**: `bootstrapAdminFromEnv()`
(`auth.ts:296-335`), run once at server start from `hooks.server.ts`. If
`CAIRN_ADMIN_PASSWORD` (or `APP_PASSWORD`) is set, it either creates the
first admin with that password (email defaults to the placeholder
`admin@cairn.local` unless `CAIRN_ADMIN_EMAIL` is set) or backfills the
password onto an existing passwordless first admin. **This IS the "Umbrel
auto-admin" mechanism** — there is no separate `autoAdmin` module; it's this
function plus the forced-reset flow below. Never clobbers an operator-chosen
password. Because the bootstrap password came from an env var visible in the
deployment platform's install UI/logs, the account is flagged
`must_reset_password = 1`. `mustResetPassword(userId)` is checked by the
`(app)` layout gate to force a one-time `/setup-admin` step
(`completeForcedCredentialReset`) requiring **both** a new password and a
real (non-placeholder) email before any other route is reachable — and it
refuses reuse of the bootstrap password itself.

### Come aboard — invite landing, branded signup, welcome tour

The invite experience (epic beads cairn-s8g9a/n1ovc/95yic/sr5ry, from the
HEARTWOOD-VISION-REVIEW.md Addendum's "come aboard" move) turns an invite
link into a captain-branded flow instead of a generic signup form:

- **`/invite/[code]`** (top-level, public — outside the `(app)` gate, like
  `/terms`): the landing page an invitee opens. Leads with the node's
  identity ("You've been invited aboard [name]"), the captain's optional
  welcome message, a node-status teaser, and a "Come aboard" CTA to
  `/signup?invite=CODE`. Signed-in visitors get "Open Heartwood" instead.
- **Preview contract** (`src/lib/server/invitePreview.ts` — its header is
  the audited security contract; `invitePreview.test.ts` pins it): a code
  that is not currently redeemable (unknown / revoked / expired /
  exhausted, indistinguishably) returns `null` and the page renders a calm
  dead-end with ZERO instance information. A redeemable code exposes
  exactly: `instanceName`, `captainName` (the invite creator's display
  name), `welcomeMessage`, `watching` (chain-transport health boolean),
  `synced` (first-sync boolean), `tipHeight` (persisted-snapshot read, no
  live chain call), and `sharedSurfaces.{explorer,mining}` (instance-level
  flag booleans). Never balances, addresses, wallet/user counts, emails, or
  invite bookkeeping. Lookups (landing AND the signup load's branding
  check) count misses against the SAME per-IP `invitesIp` rate-limit
  buckets as signup, so no new enumeration budget exists.
- **Identity fields**: `instance_name` settings key
  (`admin.ts getInstanceName()/setInstanceName()`, 60-char cap, NUL-guarded,
  empty clears; editable at the top of `/admin/invites`) and
  `invites.welcome_message` (per-invite, 500-char cap, set in the
  create-invite form; `createInvites()`/`listInvites()` carry it). Landing
  headline fallback: `instance_name` → "[captain]'s node" → "a Heartwood
  node" (`inviteNodeTitle()`).
- **Branded signup**: `/signup?invite=CODE` with a currently-valid code
  shows "Joining [node] — invited by [captain]" above the form. On success
  the client goes to **`/welcome-aboard`** instead of `/` (keyed on the
  server-validated preview, not mere code presence).
- **`/welcome-aboard`** (`(app)` group): a 4-step guided tour for invited
  crew — welcome/keys-stay-yours, what you can see (rows for shared
  wallets already waiting, explorer, mining — each flag/state-gated), how
  notifications reach you, and a final "add your first wallet / look
  around" choice. Step progress snapshots to sessionStorage
  (`cairn.welcome-aboard.v1`, 1h max age, `_components/welcomeProgress.ts`
  mirrors the multisig wizard pattern) so an Umbrel app_proxy reload
  resumes mid-tour. Harmless for any signed-in user to open by hand.
- **Agreement gate threading**: every fresh non-admin signup passes the
  `/agreement` gate before any `(app)` page, which would swallow the
  welcome-aboard hand-off. `appGateRedirect()` therefore maps exactly
  `/welcome-aboard` → `/agreement?next=welcome-aboard`; the agreement page
  carries the token through the `?/accept` POST as a hidden field and the
  action redirects to `/welcome-aboard` ONLY for that exact token (strict
  allowlist, never a raw pathname — no open redirect; pinned in
  `src/routes/agreement/server.test.ts` and `appGate.test.ts`).
- **Admin affordances** on `/admin/invites`: node-name form (`?/saveName`),
  per-invite welcome message, per-invite "Copy link" (copies
  `{origin}/invite/CODE`) and "Preview" (opens the landing in a new tab).

QA seed: `scripts/qa/seed-move2-come-aboard.mjs` (admin + session + team
mode + all four invite states + synced/watching chain state).

### Access-gate model (`appGate.ts`, `hooks.server.ts`)

`handle()` populates `event.locals.user` and `event.locals.flags` once per
request (before any route-level `load()`), then applies, in order:

1. Static-asset fast path (skips session/flags lookups entirely).
2. **Admin-mutation backstop** (`isAdminMutationRequest`): blocks any
   non-GET/HEAD request under `/admin*` unless `locals.user.isAdmin` — pure
   defense-in-depth for the real per-action `requireAdmin()` checks (a real
   gap was found: SvelteKit form `actions` don't run the parent layout's
   `load()`, so 3 admin actions once shipped unauthenticated-exploitable).
3. Legacy `/vaults` → `/wallets`(`/multisig`) 301 redirect (post-rebrand).
4. `(app)` route-group gates via `appGateRedirect(user, pathname)` —
   forced-password-reset, disclosure/agreement acceptance, recovery-setup.
   GETs redirect (302); non-GET actions get an `error(401/403)` instead
   (redirects don't work through `use:enhance`).

### Collaborative custody — 3-tier access model

Docs: `docs/COLLABORATIVE-CUSTODY-PLAN.md` (internal, not a public doc —
see §15). Single-instance only (no cross-instance/federation). Built on top
of the *existing* multisig tables, not a parallel system.

| Tier | Grant | Gate function | Notes |
|---|---|---|---|
| Owner | `multisigs.user_id` | any query includes `OR m.user_id = ?` | full access |
| Viewer | `multisig_shares.role = 'viewer'` | `getViewableMultisig(userId, id)` (`wallets/multisig.ts:176-188`) | read-only: balance, addresses, history, labels; returns `null` (not 403) for a non-participant so callers uniformly 404 rather than leaking wallet existence |
| Cosigner | `multisig_shares.role = 'cosigner'` | `getSignableMultisig(userId, id)` (`multisig.ts:196-209`) | adds signing ability at the wallet level |

Being a wallet-level cosigner is necessary but not sufficient to sign a
*specific* transaction — the frozen per-transaction roster in
`multisig_transaction_signers` (`assigned_key_ids`, `has_signed`) is the
actual per-transaction gate; **authoritative signature state is always
re-derived from the live PSBT** via `multisigPsbtProgress()`, never trusted
from `has_signed` alone. Role resolution/management lives in
`src/lib/server/multisigShares.ts`: `shareMultisig()`,
`updateMultisigShare()`, `revokeMultisigShare()`, `multisigAccessRole()`
(returns the caller's role or null), `redactMultisigKeysForViewer()`
(viewers never see other cosigners' key material they shouldn't). Sharing
requires an **accepted contact** relationship first (`contacts` table) — a
guard against sharing-via-leaked-user-id. `requestContact` in `contacts.ts`
returns the same success shape whether or not the target email exists
(anti-enumeration). Regression coverage: `src/lib/server/
multisigAccess.test.ts` — the bug it guards against was that these gate
functions existed but **nothing called them from routes**, so a cosigner saw
an empty wallet list / 404.

### Admin role & feature-management gating

`users.is_admin` is a plain boolean column; the first registered user gets
it automatically. `requireAdmin(event)` in `api.ts` returns 403 JSON if not
admin. Multi-user **management** surfaces (admin users/invites, contacts,
multisig-share creation) are additionally gated on **instance mode =
'team'** via `assertTeamMode()`/`requireTeamMode()` — a 404 (not 403) when
in solo mode, since nothing is "disabled," the instance is just narrower.
This deliberately never gates the read path a cosigner already has
(`getViewableMultisig`) — toggling back to solo must not silently revoke
access already granted.

`admin/users/[id]`'s `+page.server.ts` (the per-user detail page) still
calls `assertTeamMode()` in both `load()` and its remaining actions
(`cairn-7xlf`, fixed) — it had been missing entirely, so `/admin/users`
404'd in solo mode while `/admin/users/2` kept rendering, contradicting the
"every route under the Users/Invites tabs 404s via `assertTeamMode()`"
invariant.

**The per-user feature-flag override grid is gone (UX Simplification Wave 2,
`cairn-6c91u.2`, `docs/UX-SIMPLIFICATION-SPEC.md` §3.1).** `admin/users/[id]`
no longer renders the tri-state per-flag override table or its "N user
overrides" badge — that was the per-user half of the 25-row flags grid, the
same "creator got lost" surface the global `/admin/feature-flags` page was.
**The engine underneath is untouched**: `user_feature_flags` (table),
`resolve.ts`'s per-user branch, and `isFeatureEnabled()`'s per-user-wins-
either-direction resolution all still run — any override row written before
the grid was removed (or via the API/DB path since) is still honored, it's
just no longer settable or visible from this page. `/admin/feature-flags`
itself is now a `+page.server.ts` 307 redirect stub to `/settings#mining`
(the grid's routes/actions are deleted, not merely hidden) — see §9's route
map and §11's QA-gate notes.

### User & account deletion invariants (`userDeletion.ts`)

Both deletion entry points — `admin.ts`'s `deleteUser(id, { force? })` (an admin
removing someone else) and `accountDeletion.ts`'s `deleteOwnAccount(userId)` (a
user removing themselves) — route through the shared primitives in
`src/lib/server/userDeletion.ts`, so three invariants can't drift apart:

- **FK pre-cleanup** (`purgeUserRow`). A bare `DELETE FROM users` violates the
  only three user FKs with **no** `ON DELETE` action — `invites.created_by`,
  `feature_flags.updated_by`, `user_feature_flags.updated_by` — and throws a raw
  `FOREIGN KEY constraint failed` (cairn-piow). `purgeUserRow` deletes the
  invites and NULLs the two `updated_by` authors inside the same transaction as
  the user delete, then clears the no-FK-at-all `notified_txids` rows. Every
  other user FK is `ON DELETE CASCADE` (or `SET NULL` on
  `multisig_keys.assigned_user_id`); if you add a new user FK **without** a
  cascade action, add it here.
- **Last-admin guard** (`deletionOrphansAdmins`). Refuses to delete an admin when
  it would leave the instance with no usable admin. Counts the last admin **row**
  of any kind — not just active admins — so a *disabled* sole admin can no longer
  self-delete into a zero-admin instance (cairn-sclk). A usable (enabled) admin
  is still blocked when no other *usable* admin remains, even if a disabled admin
  row exists. Throws `AuthError` code `last_admin`.
- **Shared-multisig owner deletion** (cairn-8r0l). `multisigs.user_id` is `ON
  DELETE CASCADE`, so deleting an owner destroys every multisig they own —
  including ones shared OUT to cosigners, plus any in-flight PSBTs — for everyone.
  `deleteUser` **blocks** this by default (`AuthError` code
  `owns_shared_multisigs`, message enumerates the affected wallets + pending
  signature count); the admin re-submits `DELETE /api/admin/users` with
  `force: true` to proceed. `deleteOwnAccount` does **not** block (the danger-zone
  copy already warns, and a user must be able to close their own account). When a
  deletion of a shared-multisig owner proceeds (forced admin delete OR any
  self-delete), every affected participant receives an in-app `multisig_removed`
  notification (`notifyOwnerDeletionCosigners`, best-effort, post-commit).
  `multisig_removed` is registered in `notifyTypes.ts`, `DEFAULT_PREFERENCES`
  (inapp-only), and `USER_FEED_TYPES`, but is intentionally NOT in the curated
  Settings > Notifications toggle list (no per-channel opt-out — it's a
  can't-miss account event).

### Solo mode / instanceMode

`settings.instanceMode`: `'solo' | 'team'`, default `'solo'` for new
installs. `instanceModeMigration.ts`'s `migrateInstanceMode()` runs once at
boot (after `bootstrapAdminFromEnv()`) for installs predating the setting:
counts `users`, `multisig_shares`, `invites`, `contacts` — any evidence of
prior multi-user usage (>1 user, or any shares/invites/contacts) → `'team'`,
else `'solo'`. Idempotent — once an `instance_mode` row exists (whether from
this migration or an explicit admin toggle), it never re-runs, so an admin
who unlocks team mode and later loses their only cosigner isn't silently
narrowed back. `getInstanceMode()` is a cheap single-key read used by the
`(app)` layout on every navigation, distinct from the full
`getInstanceSettings()` (which also does a `core_rpc_pass` decrypt).

### Passkeys (`webauthn.ts`, `auth.ts`)

`user_credentials` rows: `credential_id`, `public_key` (COSE, base64url),
`counter` (replay protection), `transports`, `device_type`
(single/multiDevice), `backed_up`, `name`. `deleteCredential()` refuses to
remove a user's LAST passkey — throws `AuthError('last_passkey')` — since
recovery on a passkey-only account is by re-registering a new account, not
password reset. Uses `@simplewebauthn/server`'s `WebAuthnCredential` type.

**Origin allowlist (`passkeyOrigin.ts`, cairn-ib7w).** `getRp()` derives `rpID`
from the bare host (identical on both the plain-HTTP proxy and the self-signed
HTTPS listener). `expectedOrigin`, however, is NOT a single value: verification
passes the full set from `allowedPasskeyOrigins()` — the configured
`CAIRN_ORIGIN` (or the request origin when unset) **plus** the HTTPS listener
variant of the same host (`https://<host>:CAIRN_HTTPS_EXTERNAL_PORT`). Without
this, Umbrel's `CAIRN_ORIGIN` pins to the plain-HTTP proxy origin
(`http://<device>:3211`, kept non-Secure for the cookie, cairn-wrph/9njl), so a
ceremony run on the secure HTTPS listener — the ONLY surface a browser will do
WebAuthn on — never matched and always failed. The set is derived purely from
server config (no attacker-controllable header when an origin is configured), so
it never widens beyond the same configured host: no wildcard. The same
`allowedPasskeyOrigins()`/`passkeyAvailableOn()` gate drives the login / recover
/ settings UI, which hides the passkey entry point (and names the secure address)
on any origin where a ceremony can't verify.

---

## 8. Server: API Routes & Cross-Cutting Server Concerns

### API route map (`src/routes/api/**/+server.ts`, ~100 endpoint files)

| Area | Endpoints (relative to `src/routes/api/`) |
|---|---|
| Auth | `auth/login/{options,password,verify}`, `auth/me`, `auth/passkeys[/:id][/options]`, `auth/recover/{password,register/options,register/verify,verify}`, `auth/recovery/{codes,phrase,status}`, `auth/register/{options,password,verify}` |
| Wallets (single-sig) | `wallets`, `wallets/[id]`, and under `wallets/[id]/`: `address-labels`, `addresses`, `config`, `descriptor`, `history.csv`, `labels`, `psbt`, `receive`, `refresh`, `transactions[/:txId][/broadcast\|/bump\|/file]`, `transactions/cpfp`, `transactions/saved`, `utxo-mass` |
| Wallets (multisig) | `wallets/multisig`, `wallets/multisig/import`, `wallets/multisig/[id]` and under it: `address-detail`, `address-labels`, `backup-pdf`, `caravan`, `coldcard`, `descriptor`, `history.csv`, `keys/[keyId]/verified`, `ledger-registration`, `psbt`, `receive`, `refresh`, `shares[/:shareId]`, `transactions[/:txId][/broadcast\|/bump\|/file]`, `transactions/cpfp`, `utxo-mass` |
| Chain / market data | `blocks`, `blocks/[id]`, `chain/refresh`, `chain-health`, `mempool/{fees,projected,summary}`, `price`, `search`, `sync`, `tx/[txid]`, `tx/[txid]/block-context`, `address/[address]`, `signing-time-preview` |
| Admin | `admin/activity`, `admin/backup`, `admin/invites`, `admin/logs`, `admin/nostr-identity`, `admin/notifications[/test-smtp]`, `admin/restore`, `admin/settings`, `admin/users` |
| Notifications | `notifications`, `notifications/channels/[channel][/test]`, `notifications/channels/email/test-smtp`, `notifications/pgp`, `notifications/preferences`, `notifications/quiet-hours`, `notifications/stream` (SSE) |
| Collaborative custody | `contacts`, `contacts/[id]` (shares live under `wallets/multisig/[id]/shares`) |
| Address book | `address-book`, `address-book/[id]` (gated `requireFeature(event, 'address_book')`, backed by `src/lib/server/addressBook.ts`'s `listSavedAddresses`/`saveAddress`; distinct from the `saved_addresses`/`address_labels` DB tables in §6) |
| Backups / account lifecycle | `account/export`, `backup-reminder/dismiss` |
| Announcements | `announcements/[id]/dismiss` |
| Misc | `activity`, `events`, `health`, `portfolio`, `portfolio/refresh`, `tokens`, `tokens/[id]`, `stateless/{broadcast,combine,psbt,scan}` (airgapped signer flows) |

### Consistent error+message response shape (Wave 6, commit `9fde0a4`)

Every guard in `src/lib/server/api.ts` (`requireUser`, `requireAdmin`,
`requireFeature`, `assertTeamMode`/`requireTeamMode`, `readJson`,
`readOptionalJson`, `readCappedBody`) throws through a shared
`apiError(status, message)` helper (`api.ts:27-29`):

```ts
function apiError(status: number, message: string): never {
    error(status, { message, error: message });
}
```

**Non-admin `(app)/*` form actions now call `requireUser(event)` explicitly
(`cairn-wqkk`).** Root cause: SvelteKit form actions never run a parent
layout's `load()`, so the `(app)/+layout.server.ts` login redirect never
gated them — only a `locals.user!.id` non-null assertion (a masked 500 for
an anonymous caller) stood between an action and an unauthenticated
request. Every action in `settings/+page.server.ts`,
`settings/devices/+page.server.ts`, `settings/tokens/+page.server.ts`,
`wallets/[id]/+page.server.ts`, `wallets/new/+page.server.ts`, and the
`key`/`preview` actions of `wallets/multisig/new/+page.server.ts` (the two
actions the bead confirmed were anon-reachable — harmless today, pure
computation, no mutation) now calls `requireUser(event)` as its first line,
converting that masked 500 into a clean 401 and hardening against a future
refactor flipping a `!` to `?.`. Admin `(app)/admin/*` actions were
out of scope — they already gate via `requireAdmin` (which calls
`requireUser`) or an equivalent explicit `isAdmin` check.
`wallets/multisig/[id]/+page.server.ts`'s `receive`/`delete` actions have
the identical gap and are the one confirmed exception, deliberately
deferred to avoid colliding with concurrent work on that file — tracked as
`cairn-v27o`.

SvelteKit's own `error()` serializes to `{ message }` only, but ~100
existing client call sites read `body?.error` — so before this fix,
guard-specific reasons (most notably `requireFeature`'s admin-set "disabled
by your administrator" message) silently never reached the UI, which fell
back to a generic string. `apiError()` populates **both** fields additively
so no client read-site needed to change. `src/app.d.ts`'s `App.Error` type
was widened to allow the extra `error` field. The same commit also
normalized two raw-technical-error paths to house-standard "what happened +
what to do" copy: `walletApi.ts`'s `psbtBuildErrorResponse` (Electrum-
unreachable during PSBT build) and `chain/index.ts`'s `testCoreRpc`.

**Core RPC "Test connection" error copy (`chain/index.ts`).** `testCoreRpc()`
validates the URL with `coreRpcUrlError()` **before** any fetch — a relative or
non-`http(s)` value (e.g. `not-a-url`, `ftp://…`) returns "That doesn't look
like a valid URL — enter something like http://192.168.1.10:8332" instead of
letting SvelteKit's global fetch leak a framework-internal "use `event.fetch`"
error (cairn-mf9i). The same guard runs on the admin-settings save path, so an
invalid URL is never persisted. `friendlyCoreRpcTestError()` then maps the
remaining transport failures to plain copy: an abort/timeout (the 8s
`AbortController` firing, Node's "This operation was aborted (20)") → "No
response from the node after 8 seconds — check the address and that the node is
reachable from this server." (cairn-i9u6); an **HTTP 403** → "The node refused
this connection (HTTP 403) — your server's IP address is probably not in the
node's `rpcallowip` allowlist." (cairn-ymcg), the accurate cause rather than a
misleading "check username/password." The `CoreRpcClient` HTTP-status error also
omits the body when it's empty, so no dangling "HTTP 403: ." ever renders.

Concrete before/after: `requireFeature()` throwing for a disabled `send`
flag now serializes as
```json
{ "message": "Sending is disabled by your administrator.",
  "error":   "Sending is disabled by your administrator." }
```
— both fields carry the same admin-set copy, so any of the ~100 call sites
reading either `body?.message` or `body?.error` gets the real reason instead
of a generic fallback.

**Body-size guard**: `readJson`/`readOptionalJson` cap at
`MAX_JSON_BODY_BYTES = 1_000_000` (1 MB), checking `Content-Length` first,
then actual body length — protects every JSON endpoint from a memory/CPU
self-DoS via an arbitrarily large payload. `readOptionalJson` treats an
empty body as `{}` but still 400s on a non-empty malformed body (so an
action like broadcast can't silently swallow a bad payload).

**Bearer-token auth**: `requireUser()` first checks `event.locals.user`
(cookie session), then falls back to `Authorization: Bearer cairn_...` via
`bearerUser()` — resolved through `apiTokens.ts`'s `getApiTokenUser()`, with
its own IP-based rate limiting (`bearerRetryAfter`/`noteBearerFailure`/
`noteBearerSuccess` from `rateLimit.ts`) returning 429 with a
`tooManyAttemptsMessage`. A successful bearer auth populates
`locals.user`/`locals.flags` identically to the cookie path, so per-user
feature overrides apply to token requests too.

### `safeAction` client helper contract (`src/lib/safeAction.ts`)

Standardizes the app's hand-rolled `fetch()`-based form-action callers
(places that can't use static `use:enhance` because they submit
programmatically mid-wizard) so every possible outcome becomes a
renderable, honest result. Fixes two real regressions: a cross-site 403
(SvelteKit's own CSRF/origin check) previously misreported as "Network
hiccup," and a session-expiry `redirect` result previously swallowed
entirely.

```ts
type SafeActionResult<T> = { ok: true; data: T } | { ok: false; error: string };
safeAction<T>(env: {deserialize, applyAction}, action: string, body: FormData, fallback: string): Promise<SafeActionResult<T>>
```

POSTs to `?/${action}` with `headers: {accept: 'application/json',
'x-sveltekit-action': 'true'}` (mirrors `use:enhance`'s own request shape —
the `accept` header is what makes SvelteKit's CSRF/origin check return
parseable JSON instead of a plain-text body). Outcome classification:

| Outcome | Result |
|---|---|
| Real `fetch()` throw (offline/DNS/TLS/abort) | `{ok:false, error: NETWORK_ERROR_MESSAGE}` ("Network hiccup — check your connection and try again.") |
| Not a deserializable `ActionResult` (framework 403 CSRF page, or a reverse-proxy's own error/login page) | 403 → `REJECTED_MESSAGE` ("blocked before it reached Heartwood..."); else caller's `fallback` |
| `type: 'success'` | `{ok:true, data}` |
| `type: 'failure'` | `{ok:false, error: data.error ?? fallback}` |
| `type: 'redirect'` | followed via `env.applyAction(result)`; returns `{ok:false, error:''}` |
| `type: 'error'` | `{ok:false, error: result.error.message ?? fallback}` |
| Valid JSON, no recognized `type` (SvelteKit's own CSRF/origin check) | same 403-vs-fallback classification as the non-JSON case |

`env` (the `deserialize`/`applyAction` functions from `$app/forms`) is
injected rather than imported directly, because this repo's Vitest config
doesn't load the SvelteKit Vite plugin — a top-level `$app/forms` import
would break the module's own unit test. **Only 2 call sites today** (both
wizards) — see §15; this is a targeted fix, not yet a blanket replacement
for `use:enhance`.

### Feature flags system (`src/lib/server/featureFlags/`)

**Registry** (`registry.ts`): `FEATURE_FLAGS: FeatureFlagDef[]` is the
canonical, in-code list — the DB only stores *deviations* from a flag's
default. Each entry has `key`, `label`, `description`, `category`
('wallet'|'hardware'|'notifications'|'marketing'|'upcoming'), `userMessage`
(shown to the end user when resolved false), and `defaultEnabled: true`
typed as the **literal** `true`, not `boolean` — a flag that tried to
default off would fail to type-check, making "no flag ships pre-disabled" a
compiler guarantee. 25 flags today: `send`, `multisig_create`,
`coin_control`, `csv_export`, `address_book`, `qr_scan`, `stateless_signer`,
`wallet_config_export/import`, `explorer` (defaults on; **fresh installs now
also default it on** via `explorerDefaultMigration.ts`, flipped from the
original off-by-default in UX Simplification Wave 3 (`cairn-6c91u.3`,
`docs/UX-SIMPLIFICATION-SPEC.md` §6, decision recorded pending Alex
confirmation, reversible any time via Settings → Explorer) — the own-node
explorer is a zero-config sovereignty payoff, so the newcomer-declutter
rationale flipped in its favor; a pre-existing install's own stored row
(ON or OFF, from an earlier boot of this migration or an admin's own
toggle) is never touched, only a genuinely user-less DB gets the new
default. `explorer`'s `userMessage` still reads as an operator choice, not
an error, hence its differently-worded copy; every `/explorer/**` link
app-wide —
multisig detail, send-sent pages, activity feed, wallet detail — degrades to
plain non-interactive text via `svelte:element` when the flag is off rather
than a dead link; `cairn-o90e` closed the last two pages (activity, wallet
detail) that still skipped this). **Exception (`cairn-5yz3.3`):**
`/explorer/tx/[txid]` itself is exempt from this flag — the server gate in
`src/routes/(app)/explorer/+layout.server.ts` special-cases that one
route id (`requireUser` only, no `requireFeature`), because it's the app's
**only** tx-detail surface: every txid link app-wide (dashboard
`RecentActivity`, `/activity`, wallet-detail rows, post-broadcast "Watch it
get buried", notifications) points there, and with the flag off there would
otherwise be no way to open a transaction at all. Every one of those
call-sites now renders a plain, unconditional `<a href="/explorer/tx/…">` —
the old `explorerEnabled ? 'a' : 'div'`/`'span'` conditional is gone for
tx links specifically. Non-tx explorer links (block/address/mempool/search)
are UNCHANGED and still degrade to plain text when the flag is off — the
exemption is narrowly for tx detail, not a general explorer-flag bypass, and
does not reopen any chain-*browsing* surface. Covered by
`src/routes/(app)/explorer/layout.server.test.ts`.
`hw_trezor/ledger/coldcard/bitbox02/jade`;
`notify_email/telegram/ntfy/nostr/webhook`; `announcement_banners`,
`referral_links`; `batch_transactions`, `fee_bumping`, `tx_review`
(upcoming/unbuilt features shipped flagged from day one).

**Resolution** (`resolve.ts`, fully synchronous): `isFeatureEnabled(key,
userId | null)` — per-user row (`user_feature_flags`) wins in EITHER
direction over the global row (`feature_flags`), which wins over the
registry default. An unknown key **throws** (not silently true/false) so a
typo fails loudly in dev/CI. `resolveAllFlags(userId | null)` resolves every
registered flag in one pass (2 queries + in-memory overlay) — this is what
`hooks.server.ts` attaches to `event.locals.flags` once per request.

**Enforcement** (`api.ts`'s `requireFeature(event, key)`): the actual
boundary — the UI hiding a button is only a courtesy. Prefers
`event.locals.flags[key]`, falls back to a fresh `isFeatureEnabled()` read.
On a disabled flag: logs a `warn` to `/admin/logs` (userId, flag, method,
path — no secrets) and throws 403 with the flag's `userMessage` via
`apiError()`. **Any new gated action must call this server-side** — client
hiding alone is not enforcement.

**Flag disposition — UI vs code-only (UX Simplification Wave 2,
`cairn-6c91u.2`, `docs/UX-SIMPLIFICATION-SPEC.md` §3.2).** Only two of the 25
flags have an admin-facing toggle at all: `mining` and `explorer` — plain
ON/OFF switches in `/settings`'s admin-only Mining and Explorer groups
(`#mining`/`#explorer` anchors), because they change what the product *is*
for every user on the instance, a decision an operator legitimately makes.
Both toggles write through the same `setGlobalFlag(key, enabled, adminId)`
(`src/lib/server/featureFlags/admin.ts`) the old grid used, so
`requireFeature`, nav visibility (`primaryNav()`, §9), and the mining
Stratum listener all read the identical resolved value — flipping the
Settings switch is byte-for-byte the same write the deleted grid page made.
The other 23 flags (`send`, `multisig_create`, `coin_control`,
`csv_export`, `address_book`, `qr_scan`, `stateless_signer`,
`wallet_config_export/import`, `hw_trezor/ledger/coldcard/bitbox02/jade`,
`notify_email/telegram/ntfy/nostr/webhook`, `announcement_banners`,
`referral_links`, `batch_transactions`, `fee_bumping`, `tx_review`) are
**code-only**: default ON, no admin UI anywhere, but still fully
settable via the DB or an admin API token against the flag endpoints — no
capability was removed, only the 25-row toggle-grid screen. `/admin/feature-
flags` (the old grid) and the per-user override grid on `/admin/users/[id]`
are both gone; see the note in §7 above and §9's route map.

### Notifications system (`notifications.ts`, `notifyTypes.ts`, `channels/`)

**Event types** (`NOTIFICATION_EVENT_TYPES` — the source of truth, since
SQLite has no enum): `tx_received`, `tx_confirmed`, `tx_large`,
`tx_replaced` ("Incoming payment cancelled" — a tracked inbound tx
disappeared before confirming, double-spent or RBF'd-away; level `warn`,
`inapp` by default channel, `cairn-a2p1`),
`key_health_due`, `backup_missing`, `backup_stale`, `sign_session_waiting`,
`sign_session_complete`, `admin_new_signup`, `admin_invite_used`,
`admin_restore`, `admin_server_health`, `admin_user_disabled`,
`admin_settings_changed`, `admin_recovery_code_minted`,
`security_failed_login`, `security_new_passkey`,
`security_password_changed`, `security_new_device`, `multisig_removed`,
`cosigner_left`, `mining_block_found`, `mining_worker_offline`,
`mining_best_share` — 25 types total.

**Registry/settings-UI coverage gap closed (`cairn-di3qn`, fixed `8355a3f`,
v0.2.40).** The three `mining_*` types were emitted (`src/lib/server/
mining/index.ts`) but had no `DEFAULT_PREFERENCES` entry, so
`enabledExternalChannels()` always resolved an empty default set and no UI
path existed to ever save an override — mining notifications were
permanently in-app-only. `multisig_removed`/`cosigner_left` were fully
wired server-side but had no row in Settings → Notifications' `GROUPS`
catalogue, so users couldn't see or manage them. All 5 now have
`DEFAULT_PREFERENCES` entries and Settings UI rows (`mining_*` in a new
"Mining" group, the multisig pair filled into the existing "Wallet
activity" group) — all 25 canonical types are now covered in both
`DEFAULT_PREFERENCES` and the Settings UI, enforced by a regression test
asserting `NOTIFICATION_EVENT_TYPES == Object.keys(DEFAULT_PREFERENCES)`.

**Channels**: `inapp` (baseline, never flagged — an in-app notification IS
an `events` row with `read_at`), `email`, `telegram`, `ntfy`, `nostr`,
`webhook`. Channel plugins live in `src/lib/server/channels/{email,nostr,
webhook}.ts` (+ `emailTemplate.ts`, `ssrf.ts` guarding webhook/nostr relay
URLs against SSRF).

**Routing**: `notification_preferences` (per-user, per-event-type,
per-channel, absence = `DEFAULT_PREFERENCES[eventType]`),
`notification_channel_config` (per-user per-channel connection config JSON,
never returned to the client verbatim), `user_pgp_keys` (optional email
encryption), `user_notification_settings` (quiet hours).

**Channel visibility in Settings > Notifications** (`cairn-lv2t`, fixed):
before `39bf477` the `settings/notifications` page rendered every channel
row (email/telegram/ntfy/nostr/webhook) regardless of the viewer's resolved
`notify_*` feature flags — only the save endpoint enforced them (403 on
submit), so a user with e.g. `notify_telegram` disabled by an admin could
still see and fill in a Telegram row that would then silently reject on
save. `notifyChannelVisibility.ts`'s `isChannelVisible`/`visibleChannelIds`
(unit tested) now gate both the channel rows and the per-event-type channel
toggles, mirroring `DevicePicker.svelte`'s `hw_*` hide convention. If every
channel is flagged off, the page shows an explanatory line instead of an
empty list. Server-side enforcement is unchanged — this is a UI-parity fix,
not a new security boundary.

**More flag/UI parity fixes (`cairn-de7e`, `cairn-puyb`, both fixed):** the
send flow's `+page.server.ts` `load()` now withholds `savedAddresses`
entirely (returns `[]` without calling `listSavedAddresses`) when
`locals.flags.address_book === false`, instead of always handing the full
list to the client while only the `/api/address-book` endpoint enforced the
flag — the `RecipientCombobox` autocomplete and the post-broadcast
"save this address" offer (`+page.svelte`'s `addressBookEnabled`) both
follow from that. (Multisig send has no address book at all —
`saved={[]}` unconditionally — so it was never affected.) Separately, the
single-sig and multisig wallet-detail pages' "Wallet config (JSON)" /
"Descriptor (.txt)" / "ColdCard file" / "Printable backup (PDF)" export
links are now wrapped in `{#if data.flags?.wallet_config_export !== false}`
(else a `FeatureDisabled` message), mirroring the `csv_export` gate already
on the same pages — those endpoints (`caravan`/`coldcard`/`descriptor`/
`backup-pdf`) all `requireFeature(event, 'wallet_config_export')`
server-side already; the links previously stayed live and 403'd on click
when the flag was off.

**SMTP — global + per-user creds**: `channels/email.ts`'s
`readSmtpConfig(userId)` resolves SMTP host/port/user/`smtp_pass`/from/tls
per-user from `notification_channel_config`; `resolveSmtp(userId)` wraps
that with error handling. A **global** SMTP config also exists via
`readSecretSetting('smtp_pass')` in `instance_secrets` for the admin-level
fallback/test-smtp route (`admin/notifications/test-smtp`,
`notifications/channels/email/test-smtp`).

**Deep links (`cairn-ay45q` P1, `cairn-fochc` follow-up):** `notify()` merges
an explicit `payload.link` into the persisted `events.detail` JSON under the
`link` key. `NotificationPanel`'s `linkFor()` is the canonical reader: an
explicit `detail.link` wins when present (same-origin relative paths only),
with a `txid` → `/explorer/tx/{txid}` fallback for older rows that predate
the merge, and a non-tx `/explorer/*` link is suppressed when the explorer
flag is off (tx detail itself stays exempt, `cairn-5yz3.3`). `activity/
+page.svelte` mirrors this exact `linkFor()` logic rather than reimplementing
it, so the activity feed and the bell dropdown never disagree on where a
given event actually links — before `cairn-fochc` the activity feed only
ever linked via `txid`, so a `link`-only event (e.g. `sign_session_waiting`,
which has no txid) rendered as plain unlinked text there even after the
`detail.link` persistence fix landed.

**Live-refresh confirmed working (`cairn-tiguv`, cannot-reproduce, v0.2.41):**
a QA finding that the bell badge doesn't update without reload traced to a
raw SQL `INSERT` into `events` that bypasses `notifyBus` entirely (by
design — direct DB writes were never expected to live-push). A real trigger
(`notify()` → `notifyBus.emit` → `liveHub` → SSE `event: notification`) was
verified on the wire updating the badge within ~1.5s, no reload, on both the
desktop-sidebar and (post-`cairn-vjjc4`) `MobileTopBar` mounts independently.
No code change; closed as working-as-designed.

**Dispatch**: `notify(payload: NotificationPayload)` is called from deep
inside domain code (e.g. `auth.ts`'s `registerUserWithHash` fires
`admin_new_signup`) — always best-effort/non-throwing, so a notification
failure can never abort the triggering action. Non-inapp sends go through
`notification_queue`, drained by `startNotificationQueueWorker()`.
Triggering sites: `addressWatcher.ts`
(tx_received/tx_confirmed/tx_large/tx_replaced — see the watcher
lifecycle note below), `keyHealth.ts` (key_health_due, daily scan),
`backupHealth.ts` (backup_missing/backup_stale), `deviceTracking.ts`
(security_new_device),
`auth.ts`/`recovery.ts` (security_* events, admin_new_signup,
admin_invite_used) — all started/wired from `hooks.server.ts`'s `init()`.

### Mining engine (`src/lib/server/mining/`, epic `cairn-vn43`)

**Doctrine: multi-user solo, not a sidecar.** `docs/MINING-POOL-SCOPE.md`
originally scoped this as a single-user "Tessera-solo sidecar" (one instance
= one operator = one payout address, engine as a separate process/
container). A 2026-07-17 doctrine pivot (see the epic's pivot comment)
changed this to **multi-user solo, in-process**: any user on the instance
can point a miner at the one Stratum listener under their own opaque mining
ID; the engine builds each authenticated connection's job with a coinbase
paying **that miner's own wallet**; the finder keeps the full reward. No
splitting, no pooled payout, no custody of anyone else's funds — shares are
tracked for stats only. This stays entirely inside the hard legal gate
`cairn-vn43.14` (any future reward-splitting/pooled/raffle mode needs legal
review first); it is explicitly not that mode.

**Lifecycle.** `hooks.server.ts`'s `init()` calls `startMiningEngine()`
(`src/lib/server/mining/index.ts`) — best-effort, never throws. It's a
no-op unless **all three** gates hold: the `mining` feature flag is on
instance-wide, the operator has turned mining on in settings
(`mining_enabled`), and a Bitcoin Core RPC backend is configured
(`getblocktemplate`/`submitblock` are Core-only — no Electrum path exists
for mining). A fourth check runs right after: a **network-mismatch guard**
(v0.2.47, zero-config Core RPC wave) calls `getblockchaininfo()` and compares
its authoritative `chain` field (`coreChainMatchesNetwork()`, mapping Core's
`'main'/'test'/'testnet4'/'signet'/'regtest'` onto Cairn's own
`'mainnet'/'testnet'/'regtest'`) against the instance's configured network —
on a mismatch the engine REFUSES to start (a fatal, not a silent skip),
because building block templates or paying block rewards against the wrong
chain is a correctness/safety failure, not a connectivity hiccup. Cairn has
no Signet support, so a Signet node never matches any configured network.
`CAIRN_CORE_RPC_NETWORK` (seeded into the same `chain_network` setting by
`chainEnvSeed.ts`, see below) is only the pre-flight HINT this check exists
independently of — a wrong/absent hint doesn't skip the check, it's just one
less nudge toward the right value. There is **no separate child process or
second container** —
`cairn-vn43.12`'s dev-mode child-process supervisor is obsolete; the engine
(`MiningPool` in `miningPool.ts`, wrapping a `TipPoller` + `StratumServer` +
serialized tip/solve event queue) runs inside the same Node process as the
rest of Heartwood. `/admin/mining`'s settings-save action calls
`reconfigureMiningEngine()` (full stop, re-read settings, start) so a
config change takes effect without a process restart; its quick
start/stop action flips only `mining_enabled` and drives the engine
directly.

**Honest start/stop verdicts (`cairn-52i0r`).** Because `doStart()` never
throws, every gate above (feature flag off, `mining_enabled` off, Core RPC
unconfigured/unreachable) or listen failure either no-ops silently or lands
in `fatalErrors` — the `startMiningEngine()`/`reconfigureMiningEngine()`
promise resolving is **never** proof the pool actually came up. All three
`/admin/mining` actions (`save`, `startStop`, `restart`) call a shared
`engineFailedToStart()` helper afterward that re-checks `miningEngineStatus()`
and returns a plain-language `fail()` message (naming the specific cause —
Core not configured, feature flag off, or the newest fatal error) instead of
a false success. This was a live bug found on Alex's Umbrel 2026-07-20:
`startStop` was the one action that skipped this check, so clicking "Start
mining engine" without a working Core RPC connection flashed success and
silently did nothing.

**Umbrel-specific honest errors (v0.2.47, zero-config Core RPC wave).**
`TipPoller` (`mining/tipPoller.ts`) deliberately swallows every RPC connect
failure and retries forever (correct for riding out a brief node restart),
which means `miningEngineStatus().running` can be `true` moments after
`engine.start()` even against completely wrong credentials or a node still in
IBD — the generic fatal-errors message above has nothing to say about that,
because nothing ever landed in `fatalErrors`. On `CAIRN_PLATFORM === 'umbrel'`
only (never on a bare-metal/non-Umbrel deploy — `engineFailedToStart()`'s
Umbrel branch is skipped entirely there), `engineFailedToStart()` now runs one
extra live `getblockchaininfo()` probe (`probeCoreRpcHealth()`,
`mining/index.ts`) whenever `miningEngineStatus().coreRpc !== 'ok'` (skipped
once a real template round trip has already proven the connection healthy),
and reports one of four honest, specific messages: (1) Core RPC unconfigured
**and** `core_rpc_detected` unset — "install/start the Bitcoin Node app" (Wave
B never even found a listener); (2) unconfigured but `core_rpc_detected` IS
set — falls back to the generic "connect Bitcoin Core under Admin → Settings"
message, since the assisted-connect banner already covers that state; (3) the
probe reports `initialblockdownload: true` — "still syncing (block N)"; (4)
the probe's `getblockchaininfo()` call itself fails (401, connection refused,
timeout) — "couldn't reach your Bitcoin node's RPC, it may be restarting." A
401 while `core_rpc_provisioned_by === 'umbrel-env'` also logs a warning
(not shown to the admin) flagging that the reconcile-on-boot self-heal below
should have already fixed it. A durable shutdown flush is registered once, directly on
`process.once('SIGTERM'/'SIGINT')`, separately from `server.mjs`'s own
signal handling — `server.mjs` runs in a different module graph (it only
imports the built `handler.js`) and has no live handle to the engine
singleton, so it can't `await` a clean stop itself.

**`authTable.ts` — the hot-path authorization snapshot.** The Stratum
socket data handler calls `AuthProvider.resolve(miningId)` synchronously,
with **zero I/O** — it's a plain `Map` lookup. All the real work (reading
`mining_prefs`, resolving each user's payout wallet, peeking a receive
address, which can touch the chain backend) happens off that path in
`refreshAuthTable()`, which builds a fresh `Map` and atomically swaps it in
— a `resolve()` racing a rebuild always sees either the complete old or
complete new snapshot, never a half-built one. One user's failure (missing
wallet, unencodable address, a chain hiccup) is logged and that user is
skipped; it never aborts the rebuild or drops every other miner. Triggers:
engine start (built **before** the Stratum listener opens, so the first
connecting miner already resolves), a 60s timer, and the `onPrefsChanged()`
hook fired by every `mining_prefs` mutation (enable/disable, payout-wallet
change, ID regeneration) — so a disabled or re-pointed miner stops/starts
being authorized within one refresh cycle, never inline on the hot path.

**Dual Stratum listeners (`cairn-pz8v5`).** `MiningPool` binds a SECOND
high-floor Stratum listener for ASIC-class hardware whenever
`mining_asic_port_enabled` (default `true`) is on — same engine, same job
pipeline, same per-connection coinbase/auth/vardiff mechanism as the
standard listener; the only differences are the bind port
(`mining_asic_stratum_port`, default `3334`, one above the standard `3333`)
and the difficulty floor (`mining_asic_share_difficulty`, default `65536`,
vs the standard port's `0.5`). Rationale: an S19/S21-class ASIC pointed at
the low-floor standard port would flood the share tracker with trivially
easy shares, so big machines get their own high-floor lane. Both listeners
are wired identically in `makeServerOpts` and a solve from either lands on
the same serialized event queue against the same `jobsById` map, so which
port found the block is irrelevant to assembly. `status()`'s `EngineStatus`
now carries `listeners: [{role: 'standard'|'asic', port, connections}]` for
per-listener detail; `connections`/`minerCount` stay **combined** across
both listeners (readModels counts distinct users from the combined array).
`start()` fails cleanly if the ASIC port can't bind (busy, or same as the
standard port): it closes the standard listener it already opened and
re-throws, so `doStart()` records a fatal rather than leaving a half-open
engine with only one listener live. The admin settings form rejects an
ASIC port equal to the main Stratum port at save time (`+page.server.ts`).
Post-reconfigure honesty: `doStart()` never throws (fatals are recorded,
engine stays stopped), so the admin `?/save` and `?/restart` actions verify
`miningEngineStatus().running` afterwards and fail with the newest fatal
error when settings say the engine should be running but it isn't — a
resolved `reconfigureMiningEngine()` alone is NOT proof of life (v0.2.42).

**Native Stratum V2 listener + admin UI (`cairn-qfez8.8`/`.9`).** A THIRD,
optional listener — `Sv2Server` (`sv2/sv2Server.ts`) — binds alongside the
standard and ASIC V1 listeners whenever `mining_sv2_enabled` is on (default
`false`). Same job pipeline, `AuthProvider`, and share/solve/reject sinks as
the V1 listeners (`MiningPool.status()`'s `listeners` array grows a third
`{role: 'sv2', port, connections}` entry, and `connections` stays combined
across all three — `readModels.ts`'s `getAdminMiningView()` cross-references
that combined array against `agg.liveAllMiners()` by `(userId, worker)` to
badge each miner row V1/V2, since the share-aggregate projection itself
carries no protocol field). Protocol split lives in
`ConnectionInfo.protocol` (`types.ts`) — `undefined`/absent means V1 (every
existing `StratumServer` connection), `'sv2'` is the only value
`Sv2Server.connections()` ever produces.

Noise-protocol trust anchor: a durable **authority keypair**
(`sv2/authority.ts`, `loadOrCreateAuthorityKey()`) is generated once on
first SV2 enable and persisted **encrypted** via `secretKey.ts`'s per-domain
envelope under `instance_secrets` key `mining_sv2_authority_secret` — never
rotated automatically (rotation invalidates every pinned client; an
explicit future admin action, out of scope for v1). Its base58check-encoded
x-only pubkey (`authorityPubBase58`) is the trust anchor a V2 client pins,
published as the path component of the connection string:
`stratum2+tcp://<host>:<port>/<base58-authority-pubkey>`. A fresh
**static (session) key** is generated per `Sv2Server` boot and certified by
the authority key (`issueCert`); the cert is re-issued on a background
cadence (half its validity window) so a long-uptime instance's cert is
always refreshed well before it actually expires.

**Admin settings form (`AdminPoolSettingsForm.svelte`).** A third subgroup,
"Next-generation miner connections (Stratum V2)," mirrors the ASIC
subgroup's toggle + fade-in fields shape: enable switch, port (default
`3335`), starting/fixed share difficulty (default `65536` — ASIC-oriented,
same rationale as the ASIC listener's floor, since SV2's first real clients
are expected to be ASIC firmware/proxies rather than low-power USB miners),
and a version-rolling switch (off by default; server-wide, but actually
negotiated per-channel as of `cairn-qfez8.29`/v0.2.46 — see below).
`+page.server.ts`'s `?/save` action validates the
port range and rejects a collision against **both** other ports (the main
Stratum port and the ASIC port, since all three listeners can run at once)
before persisting `mining_sv2_enabled`/`mining_sv2_port`/
`mining_sv2_share_difficulty`/`mining_sv2_version_rolling` and calling
`reconfigureMiningEngine()` — same pattern as every other settings field on
this form.

**Connection info (`MiningConnectionCard.svelte`, `/mining`).** When the
admin has SV2 on, the per-user connection card grows a third address row —
"Next-generation miners (Stratum V2)" — showing the full
`stratum2+tcp://host:port/<authorityPubkey>` string via the same `CopyText`
affordance as the V1 rows, gated behind the same loopback-honesty check
(`isOpen`, i.e. `bind !== 'loopback'`) so a raw TCP endpoint is never shown
as copyable when it can't actually be reached off-box. The authority pubkey
flows server → client through `getUserMiningView()`'s `engine.sv2` field
(`{port, authorityPubkey} | null`) — `null` whenever `mining_sv2_enabled` is
off, so an instance that never turns SV2 on never even mints/persists an
authority key (`loadOrCreateAuthorityKey()` is create-on-first-call, called
lazily only when `settings.sv2Enabled` is true).

**Vardiff on the SV2 listener (`cairn-qfez8.28`, v0.2.46).** SV2 channels now
retarget with the SAME settings V1 uses (`mining_vardiff_enabled` /
`mining_vardiff_target_rate`, plus the shared `maxDifficulty` overflow-DoS
ceiling) — `MiningPool` passes an identical `vardiff` block to `Sv2Server` as
it does to both V1 `StratumServer`s. The retarget MATH is a deliberate
standalone port of V1's formula (`src/lib/server/mining/vardiff.ts`) — rate
vs `targetSharesPerMin` → ×2/÷2, power-of-two snap, clamp to
`[shareDifficulty, maxDifficulty]` — NOT a shared import from `stratum.ts`:
V1 is a frozen money path, so this is a careful duplicate rather than a
refactor of it. Where V1 pushes `mining.set_difficulty`, SV2 sends `SetTarget`
per channel; the change applies to jobs installed AFTER the retarget only —
an already-announced job keeps grading against its own `FrozenJob.target`
snapshotted at announce time (`sv2/channels.ts`), so this never retroactively
moves work already in flight (wire ref §4). `UpdateChannel` (client-declared
nominal hashrate + a self-imposed `maximum_target` ceiling) is honored:
declaring a SMALLER `maximum_target` than the current channel target gets an
immediate `SetTarget` (spec MUST); a larger one is a silent no-op; an unknown
channel or a zero/malformed `maximum_target` gets `UpdateChannel.Error`.

**Version rolling on the SV2 listener (`cairn-qfez8.29`, v0.2.46).** When
`mining_sv2_version_rolling` is on, `NewExtendedMiningJob.version_rolling_allowed`
reflects it and `sv2/channels.ts`'s `validateSubmit` accepts a submitted
header version that differs from the job's base version as long as every
changed bit is inside the BIP320 mask `0x1fffe000` — bits outside the mask
(or ANY version change when the setting is off) reject
`version-rolling-not-allowed`. The submitted version is what actually gets
hashed: `job.ts`'s `headerFor`/`assemble` gained an ADDITIVE-OPTIONAL
`versionHex` param (absent = the template version, byte-identical to every
V1 call site and to every SV2 call before this param existed — `parity.test.ts`
guards this), and `SolveEvent` gained an additive-optional `versionHex` so
`MiningPool.handleSolve` re-`assemble`s a solved block at the exact rolled
version the miner ground, not the template's. `SetupConnection`: a client
that declares `REQUIRES_VERSION_ROLLING` while the setting is off gets
`SetupConnection.Error` (wire ref §5's "client REQUIRES_VERSION_ROLLING ⇒
never disallow rolling" — silently accepting and failing every later submit
would violate that MUST); with the setting on, such a connection is accepted
normally.

**Known limitation (ASIC port, v0.2.42):** the Stratum server answers
`mining.configure` (BIP-320 version-rolling negotiation) with error 20
"unknown method". Real ASIC firmware — exactly the hardware the 3334 port
targets — commonly sends `mining.configure` on connect; most firmware
degrades gracefully and mines without version-rolling, but a tolerant
response + a hardware-compat pass is tracked as a P2 (filed by the
2026-07-19 QA session). Mention this in support threads before blaming a
miner's config.

**Aggregates cadence (`aggregates.ts`) — and why it's 15s-batched, not
per-share.** Every accepted/rejected share updates **only in-memory** state
(per-worker counters, a rolling hashrate window, open 1-minute buckets).
Exactly one batched SQLite transaction every 15s (an unref'd timer) flushes
the deltas into `mining_workers` and appends every now-closed 1-minute
bucket into `mining_stats`. This mirrors the `cairn-xlrm` rationale
documented in §6 (Database) and §4: `node:sqlite`'s `DatabaseSync` is fully
synchronous and blocks Node's one event-loop thread for the query's
duration — a share can arrive many times a second from a real ASIC, so a
per-share DB write would reintroduce the exact contention hazard that was
already root-caused as rapid-navigation stutter elsewhere in the app. The
live "now" values the UI shows (current hashrate, share counts) always come
straight from this module's in-memory state, fresh to the last share; the
DB mirror exists purely for durability, the admin hashrate series, and the
all-time best-share baseline. A final synchronous flush runs on
`stopMiningEngine()` and again from the SIGTERM/SIGINT handler above, so a
clean shutdown never loses the last <15s of shares.

**Block-accepted payout wiring (`handleBlockAccepted`, `index.ts`).** On an
ACCEPTED `submitblock` result: (a) `nextReceiveAddress(userId, walletId)`
advances the finder's receive cursor **exactly once** — the address that
block just paid must never be handed out again; the job's payout address
came from `peekReceiveAddress()` (peek-hold, doesn't advance the cursor) so
every rebuilt job between blocks reused the same stable address without
burning the gap limit. (b) A `mining_blocks` row is inserted
(`submit_result = 'accepted'`); the `block_hash UNIQUE` constraint makes a
duplicate callback (should never happen) a swallowed no-op rather than a
throw. (c) Two `mining_block_found` notifications fire: one to the finder
(`level: 'success'`, deep-links to `/mining`, "the full reward pays your
wallet — spendable after 100 confirmations"), one to every admin
(`level: 'info'`, `userId: null`, deep-links to `/admin/mining`). (d) An
activity-feed row is recorded. A REJECTED result instead logs loudly and
inserts a `mining_blocks` row with a synthetic unique `block_hash` (§6) and
`submit_result = 'rejected:<reason>'` — a stale solve racing a fresh tip is
an expected, non-fatal condition, not an invariant violation.

**Settings keys (`mining_*`, plain `settings` kv, read fresh every call —
see `settings.ts`'s module note, same never-cache-at-module-scope
convention as the chain config):**

| Key | Default | Meaning |
|---|---|---|
| `mining_enabled` | `false` | operator on/off switch, independent of the `mining` feature flag |
| `mining_bind` | `loopback` everywhere except a `CAIRN_PLATFORM=umbrel` boot, where it's `all` | tri-state `loopback`\|`lan`\|`all` — resolves to bind host `127.0.0.1` (loopback) or `0.0.0.0` (lan/all); the tri-state exists purely to drive honest UI copy about LAN exposure, no actual interface detection is attempted. `CAIRN_PLATFORM=umbrel` is set ONLY by the store package's compose (never a bare-metal install) — a container's loopback bind is unreachable from any miner outside the container (`cairn-bm7c2`), so `defaultBind()` (`settings.ts`) keys the *default* off it. An explicit admin-saved value always wins over this platform default. The store compose must also publish the `3333`/`3334` host ports for either default to actually reach a miner — tracked `cairn-kgj7a`, not yet shipped in the store repo. |
| `mining_stratum_port` | `3333` | Stratum V1 TCP listen port (standard/low-floor listener) |
| `mining_share_difficulty` | `0.5` | starting/floor share difficulty — deliberately low so a sub-TH/s Bitaxe-class miner submits its first share promptly; vardiff (when enabled) ratchets a connection up from here within about a minute |
| `mining_vardiff_enabled` | `true` | whether per-connection variable difficulty is active |
| `mining_vardiff_target_rate` | `6` | vardiff target, shares per minute per connection |
| `mining_pool_tag` | `Heartwood` | ASCII tag embedded in the coinbase scriptSig after the BIP34 height push; capped at 24 printable-ASCII characters, validated server-side on save |
| `mining_asic_port_enabled` | `true` | whether the second, high-floor Stratum listener for ASIC-class hardware runs (`cairn-pz8v5`) |
| `mining_asic_stratum_port` | `3334` | Stratum V1 TCP listen port for the ASIC listener; admin save rejects a value equal to `mining_stratum_port` |
| `mining_asic_share_difficulty` | `65536` | starting/floor share difficulty for the ASIC listener — high enough that an S19/S21-class machine doesn't swamp the share tracker |
| `mining_sv2_enabled` | `false` | whether the native Stratum V2 listener runs (`cairn-qfez8.8`/`.9`) — off by default, purely additive on top of the two V1 listeners |
| `mining_sv2_port` | `3335` | Stratum V2 TCP listen port; admin save rejects a value equal to `mining_stratum_port` OR `mining_asic_stratum_port` |
| `mining_sv2_share_difficulty` | `65536` | starting/floor share difficulty for the SV2 listener — same `mining_vardiff_enabled`/`mining_vardiff_target_rate` vardiff as V1 retargets every SV2 channel from here (`cairn-qfez8.28`, v0.2.46) |
| `mining_sv2_version_rolling` | `false` | server-wide version-rolling advertisement for every SV2 channel — negotiated per-channel via `NewExtendedMiningJob.version_rolling_allowed` + BIP320-mask submit validation (`cairn-qfez8.29`, v0.2.46); a client that REQUIRES version rolling while this is off is refused at `SetupConnection` |

**Notification types + quiet-hours behavior.** Three `mining_*` entries in
`NOTIFICATION_EVENT_TYPES` (`notifyTypes.ts`):

| Type | Level | Trigger |
|---|---|---|
| `mining_block_found` | `success` (finder) / `info` (admin broadcast) | a submitted block was ACCEPTED by bitcoind |
| `mining_worker_offline` | `warn` | a worker that had ≥10 min of established share history goes >5 min silent; one notification per offline episode (resuming clears the episode so a later silence notifies again); multiple newly-offline workers for one user in the same 60s scan collapse into a single notification |
| `mining_best_share` | `info` | a new all-time-best share difficulty that is at least **double** the previous stored best (a genuine milestone, not every incremental new max); throttled to at most one per user per day; the very first-ever best just seeds the baseline silently, no notification |

Quiet hours (`quietHours.ts`, §8 above) apply **by level**, not per-call: a
`success`/`info` send (`mining_block_found`'s admin copy, `mining_best_share`)
is deferred to the window's end when the recipient has quiet hours enabled;
`warn` (`mining_worker_offline`) and `error` still deliver through the
window if the recipient's `urgentOverride` is on (the default). This is a
deliberate consequence of the existing level-based quiet-hours rule, not a
mining-specific special case — documented here rather than adding a
per-notification urgency override. **In-app delivery is never affected** by
quiet hours regardless of level — it's a browsable `events`-table list, not
a push; only external channels (email/telegram/ntfy/nostr/webhook) defer.

**Identity contract.** `ensureMiningPrefs(userId)` mints a `mining_id` of
the form `hw_` + 8 lowercase hex characters (4 random bytes) on first
touch, retried on the astronomically-unlikely `UNIQUE` collision. The
Stratum `mining.authorize` username is `<miningId>` or
`<miningId>.<workerName>` (default worker name applied when the suffix is
absent); the password parameter is **completely ignored** — the read
models report it back to the UI as the literal string `'x'`, matching the
zero-password convention most solo/Stratum tooling already expects.
`regenerateMiningId(userId)` rotates the token (e.g. the user believes it
leaked); the **old** token keeps resolving until the next `authTable`
refresh (≤60s, or instantly via the `onPrefsChanged()` hook this action
itself fires) and then stops — any miner firmware still authorizing with
the stale id is rejected `UNAUTHORIZED` and must be reconfigured with the
new one. There is no way to "undo" a regenerate; the old id is gone.

### Backup & restore (`src/lib/server/backup.ts`)

An encrypted, passphrase-protected export/import of the whole instance
(all users, wallets, multisigs, settings) via `admin/backup` (export) and
`admin/restore` (import). Two hardening fixes landed together in the
2026-07-12 hardening wave, both on the restore path — a backup file is
**untrusted input** (an admin can be social-engineered into restoring an
attacker-crafted file), and restore used to trust it more than it should
have:

- **Schema-version rejection (`cairn-lka5`, closed).** The backup envelope
  and inner payload both stamp `version: VERSION` on export; `decryptBackup`
  now rejects if either `env.version` or `data.version` is not a number or
  exceeds the current `VERSION` constant (`backup.ts:172-184`), throwing
  "This backup was made by a newer version of Heartwood and cannot be
  restored here." Before this fix the version field was written but never
  checked — a future-schema backup would proceed straight into
  `restoreBackup`'s upserts instead of being refused up front.
- **Settings restore allowlist (`cairn-0dg4`, closed).** `restoreBackup`
  used to blindly upsert every row in `data.settings`, including
  security-posture keys that control the instance's auth/security surface.
  Restore now goes through `RESTORABLE_SETTING_KEYS`, a **default-deny
  allowlist** (not a denylist of known-bad keys, so a new security-relevant
  setting added later is safe by construction rather than depending on
  someone remembering to blocklist it). Five keys are deliberately **never**
  adopted from an imported backup, no matter what the file contains:
  `registration_mode` (could reopen self-registration on an
  invite-only/closed instance), `webhook_allow_private_targets` (could
  silently disable the SSRF/LAN guard on outbound webhook/ntfy targets),
  `instance_mode` (could silently unlock collaborative-custody nav the
  admin never opted into), `auth_mode` (could silently change the primary
  sign-up method), and `electrum_tls_insecure` (could silently disable
  certificate validation on a custom Electrum server). Anything skipped is
  collected into `RestoreSummary.settingsSkipped` and surfaced in three
  places so the admin can see exactly what was withheld and set it
  deliberately if intended: the `api/admin/restore` response body, an
  `admin_restore` notification whose level bumps to `warn` when anything
  was skipped, and the `admin/backup` page's restore-summary panel.
- **Collaborative-custody sharing captured (`cairn-s6x3`, closed).**
  `buildBackup` now also snapshots the `multisig_shares` table, and
  `restoreBackup` recreates each share row — remapping all three of its
  references (`multisig_id`, `owner_id`, `shared_with_id`) — plus the
  per-key collaborator assignment on `multisig_keys.assigned_user_id`.
  Before this fix both were silently omitted, so a restore severed every
  shared-wallet relationship with no warning. A share is only recreated
  when its multisig **and** both endpoint accounts were themselves
  restored (the fresh-instance disaster-recovery case); a share pointing
  at an account that already existed (and so was skipped) or a dropped
  multisig has no valid endpoint and is not recreated. The count is
  surfaced on `RestoreSummary.shares`, in the `admin/backup` restore-summary
  panel, and in the `admin_restore` notification detail (`sharesRestored`).

### Wallet-config backup tracking & the decaying nudge (`src/lib/server/backups.ts`)

Not to be confused with the instance-wide export/import above (`backup.ts`)
— this module tracks, per wallet, whether the user has downloaded that
wallet's own config backup (its public keys — needed to reconstruct the
wallet, or for multisig, to find its coins at all). Scope is deliberately
narrow: only multisigs with `source = 'created'` are ever nagged
(`listUnbackedWallets`) — single-sig wallets reconstruct from the hardware
device, and an imported multisig's config file already exists wherever it
was imported from.

Two independent nudge mechanisms live here:

- **90-day stale-backup reminder** (pre-existing). `shouldShowBackupReminder`
  is true only when the user HAS at least one backed-up wallet whose latest
  download is >90 days old and they haven't dismissed within the last 90
  days (`backup_reminders`, `dismissBackupReminder`). A user with zero
  backups at all is out of scope here — the nudge below owns that case.
- **Decaying, escalating nudge for still-unbacked wallets** (`cairn-gt05.5`,
  v0.2.39, `docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md` Spec A). Replaces
  the old "show every session, dismiss is `sessionStorage`-only" logic, which
  habituated into wallpaper and then alarm fatigue (F16,
  `docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md`). State lives in
  `backup_nudges` (one row per unbacked wallet: `first_seen_at`,
  `last_shown_at`, `shown_count`, `stakes_bucket`). `getDueBackupNudge(userId)`
  — called from the `(app)` layout load — returns at most one due nudge
  (oldest unbacked wallet wins ties):
  - **Decay ladder**: each time a wallet's nudge actually shows, its next
    eligible time widens along `nextEligibleAt()`'s rung schedule — +3d, then
    +10d, +30d, then +90d and flat from there (`DECAY_MS`, indexed by
    `shownCount - 1`, clamped to the last rung). "Cadence widens, never
    shortens."
  - **72h hard cap** (`HARD_CAP_MS`): no wallet's nudge ever re-shows sooner
    than 72h after its last real showing, regardless of decay position or an
    escalation below — the floor that keeps this from ever becoming a
    per-session ritual.
  - **Stakes buckets, monotonic** (`BACKUP_NUDGE_BUCKET`: `NEW` < `MULTI` <
    `FUNDED`, only ever raised via `raiseBucket()`): a second concurrently
    unbacked wallet raises every unbacked row to at least `MULTI` for free at
    load time (a fact about the whole set, no new data needed);
    `escalateBackupNudge(userId, walletId, FUNDED)` is called from
    `addressWatcher.ts`'s inbound-payment handler the moment a still-unbacked
    wallet receives real funds — the highest-value moment to re-nudge, rather
    than waiting out a decay window that can run to 90 days. Both are
    best-effort/silent (never throw, never block the triggering action).
    Raising a bucket bypasses the decay ladder but never the 72h cap: if the
    cap already elapsed since the last real showing the nudge re-earns
    immediately, otherwise the raise is recorded but stays deferred until the
    cap clears.
  - **Polymorphic copy**: `BackupNudge.variantId` is `'V1'..'V5'` (a calm
    rotation, keyed off `shownCount % 5`, so the same wording doesn't repeat
    every showing) for a normal due showing, or `'E-FUNDED'`/`'E-MULTI'` for a
    showing that's specifically surfacing a just-applied escalation (detected
    via a deliberate `shownCount === 0` / `last_shown_at === null` mismatch —
    see `nextEligibleAt`'s doc comment for why that sentinel is safe). Copy
    strings themselves live client-side in `(app)/+layout.svelte`, keyed by
    `variantId`, so wording stays next to styling rather than baked into the
    server module.

### Observability

**Server logging** (`src/lib/server/logger.ts`): a single pino-based module.
Dev → pretty colorized stdout; prod → NDJSON stdout (for `docker
logs`/journald); optionally *also* a local rotating JSON file
(hand-rolled `RotatingFileStream`, size-rotated in-process, synchronous
`fs.writeSync` — durable across an immediate crash) at
`CAIRN_LOG_FILE`/`HEARTWOOD_LOG_FILE` (default `data/logs/cairn.log`), read
by the admin log viewer. `childLogger(tag)` tags every line (`'db'`,
`'security'`, `'http'`, `'admin-guard'`, etc.). Defense-in-depth redaction
blanks a broad list of secret-shaped keys (passwords, tokens, xprv,
mnemonic, psbt, challenge, and — per a dedicated fix — `email`/`ip` for PII
reasons) at pino's own redact layer, one level of nesting deep. **There is
NO third-party telemetry** — logs never leave the operator's machine.

**`/admin/logs`**: `src/routes/api/admin/logs/+server.ts` —
`requireAdmin` then `readLogEntries({level, q, limit})` from
`src/lib/server/logStore.ts`.

**`/activity` user feed**: `src/lib/server/activity.ts`'s `events` table
doubles as both the operator-facing activity feed and the in-app
notification channel. `recordActivity()` inserts a row (`user_id NULL` =
instance-wide, e.g. new block/network up-down); each insert is followed by
a trim back to `EVENTS_PER_BUCKET = 500` rows per user (or per the NULL
bucket). Read APIs: `listActivity(userId, limit)`, `listUserFeed`/
`unreadUserFeedCount`/`markUserFeedRead` (the in-app-notification subset),
`listAllActivity(filters)`/`distinctActivityTypes()` (admin-wide view).
`detail` is a small non-secret JSON blob (never PSBTs/keys/tokens) — enforced
by convention/comment.

**Request logging**: `hooks.server.ts`'s `handle()` logs one line per
non-asset request (`method path status ms user=N`), leveled by status
(`>=500` error, `>=400` warn, else info), with bitcoin-sensitive path
segments (txids, addresses) truncated by `redactSegment()`/`redactPath()`
before logging. `handleError` logs full stack plus a random 8-hex `errorId`
for any 5xx, returning only `{message: "Something went wrong", errorId}` to
the client. A process-level crash guard ensures a stray synchronous throw
exits the process (container supervisor restarts it) rather than leaving
the wallet app serving from undefined state; a rejected promise is logged
but does not exit.

### Cross-cutting server-side gotchas

1. `requireFeature`'s 403 is the real enforcement boundary; UI-level flag
   checks are cosmetic only, and any new gated action must call it
   server-side.
2. The `/admin/*` mutation backstop in `hooks.server.ts` is explicitly NOT a
   substitute for each admin action's own `requireAdmin()` call — both
   layers are required.
3. Client fetches against `?/actionName` should go through `safeAction()`
   rather than hand-rolling fetch+deserialize, to avoid re-introducing the
   "network hiccup" misdiagnosis or a swallowed session-expiry redirect.

---

## 9. Client: Routes, Components, Stores & Wizards

The client is Svelte 5 with runes (`$state`, not classic `writable` stores),
organized around two SvelteKit route groups plus a handful of standalone
routes.

### Route map (`src/routes`)

**`(app)` — main authenticated shell.** Layout: `src/routes/(app)/+layout.svelte`.

> **UX Simplification nav rewrite (epic `cairn-6c91u`, `docs/UX-SIMPLIFICATION-
> SPEC.md` §2) — read this first; where the shell narrative below disagrees,
> this wins, and it supersedes the older UX Phase 4 three-destination model
> (`cairn-gt05.4`) described in `docs/UX-REDESIGN-SPEC.md` §2.7.** Primary
> navigation is now a **dynamic 2–4-item builder**, identical on the desktop
> rail/sidebar and the mobile tab row: `primaryNav({ flags })` in
> `src/lib/nav.ts` always returns Home (`/`) and Wallets (`/wallets`), then
> appends Mining (`/mining`) iff `flags.mining !== false` and Explorer
> (`/explorer`) iff `flags.explorer !== false` — the exact predicate
> `requireFeature()` resolves to, so a visible tab is always a reachable route
> and vice versa (nav-visible ⇔ route-reachable is a load-bearing invariant,
> spec R2/R5). Fresh installs (mining OFF, explorer ON) land on **Home /
> Wallets / Explorer**; both instance flags off collapses to **Home /
> Wallets** — calm, not broken, since Settings always carries both toggles
> regardless of state (see below). Activity lost its nav slot to Mining/
> Explorer but the route is not deleted: Home's dashboard carries an inline
> "Recent activity" block with a "See all →" link to the full `/activity`
> page, and the account menu keeps a Activity entry too — two reachability
> paths cover the one freed slot.
>
> A gear icon — always present, `HWSidebar`'s rail bottom on desktop,
> `MobileTopBar`'s top-right on mobile — links to `/settings` from every page.
> The avatar/account menu (`accountMenuLinks()`, unit tested in
> `nav.test.ts`) is now just **Activity, Health (admin-only, → `/admin`),
> Settings** (Notifications/Terms/Sign out are rendered by the shell around
> this list) — Explorer and Mining left the menu entirely since they're
> primary nav items now, and Feature flags never had a menu entry to remove.
> A feature the user has no access to is simply absent from the menu (not
> shown disabled) — the server-side gate is the real boundary, hiding the
> link is the courtesy. The duplicate `<nav>`-landmark a11y bug from the
> Phase 4 era is unaffected by this rewrite: only the active breakpoint's nav
> is exposed (inactive tiers are `display:none`). The active nav item is the
> only accent-colored nav element.
>
> **Where everything else went (spec §4/§5).** There is no more persistent
> admin tab strip and no more standalone `/admin/feature-flags` or
> `/admin/settings` pages. `/settings` is now the **one** settings page:
> personal groups (Account, Display, Security, Advanced, Danger zone) render
> for every signed-in user; four admin-only groups append after them for
> `user.isAdmin` — **Node connection** (moved verbatim from the old
> `/admin/settings`, incl. the Umbrel assisted-connect card), **Mining**
> (the instance ON/OFF toggle + a "Pool operator settings ›" link to
> `/admin/mining`), **Explorer** (the instance ON/OFF toggle), and
> **Instance** (registration mode, team-mode toggle, user agreement, and
> link rows into the surviving `/admin/*` subpages, with **Factory reset** as
> its last, red, typed-confirm row). Every migrated admin form action calls
> `requireAdmin(event)` first since `/settings` sits outside any admin
> layout guard. `/admin` itself stays as the **Health** hub — monitoring
> only (status headline + Node/Backups/Storage/Users duty rows), no config
> footer, no tab strip; the surviving admin subpages (`activity`, `users`,
> `invites`, `mining`, `backup`, `notifications`, `announcements`,
> `referral-settings`, `logs`) are reached contextually from Health's own
> body rows and from Settings' Instance group, not from a permanent nav row.
> `/admin/settings` and `/admin/feature-flags` are now tiny `+page.server.ts`
> redirect stubs (307 → `/settings#node-connection` and `/settings#mining`
> respectively) so old bookmarks and notification deep links still resolve.

Wraps every authenticated page with:
- Three shell tiers (`docs/DESKTOP-LAYOUT-DESIGN.md` is canonical; where this
  section and that doc disagree, the doc wins): `MobileTopBar` + `MobileTabRow`
  below 900px (frozen, byte-identical to the pre-widening app — not a target
  for revision); the compact 92px icon-only `HWRail` from 901–1159px (icons +
  tiny always-on labels, unchanged markup); the full labeled `HWSidebar`
  (`src/lib/components/heartwood/HWSidebar.svelte`) at 1160px and up — 236px
  wide, widening to 248px at ≥1600px. `HWSidebar` stacks mark+wordmark, one
  40px nav row per destination (left-aligned icon+label, active state = accent
  pill + accent icon/label + 2px left-edge marker, hover = quiet
  `--text-secondary` wash, no accent), then a bottom cluster pinned via
  `margin-top: auto` (epoch dial + sync readout, notifications bell as a
  right-anchored popover, account row as a popover). It is user-collapsible
  (chevron toggle collapses it to the icon-only rail look) with state
  persisted to `localStorage('hw.sidebar.collapsed')`, read post-hydration
  only per the Svelte 5 effect/onMount ordering hazard. Breakpoints are
  exclusive min-widths (901/1160/1600px) so no viewport satisfies two tiers
  at once. Route tiering still
  switches on `isTabRoute()` — tab pages are `/`, `/wallets`, `/vaults`,
  `/activity`, `/explorer/**`; everything else is a "flow" page and gets a
  `BackCircle` header instead (wallet/vault detail, send/sign wizards,
  `/settings/**`, `/admin/**`, `/recovery-setup`). `/vaults` is classified as
  a tab route for consistency, but **has no real pages** — see the route
  table note below before "helpfully" building one. **`/mining` is a third
  case (`cairn-5e2k`):** below 900px it gets the same `MobileTopBar` as the
  tab pages (Home link + account menu, with a flag-gated "Mining" item added
  to the avatar dropdown via `showMining`) but does **not** join
  `MobileTabRow` — it's a primary sidebar-nav section, not a 5th tab slot,
  so without its own top bar it fell through to the flow-page's
  back-circle-only header and became a dead end when opened directly
  (bookmark, notification, reload).
- **Mobile notification reachability (`cairn-vjjc4`, v0.2.41):** the bell
  used to live only inside `HWSidebar`'s `<aside class="rail">`, which is
  `display:none` below 900px — mobile had zero notification entry point
  (only the full `/activity` page). `NotificationPanel` is now also mounted
  inside `MobileTopBar` (right cluster, before the avatar menu); safe to
  dual-mount because `liveClient.ts`'s `EventSource` is a refcounted
  singleton (one real SSE connection regardless of mount count) and the two
  mounts are CSS-complementary — never both visible at once. The panel also
  now opens **downward** (not upward off-screen) when the bell is
  top-anchored (≤900px), and its tap target is widened to ~44px via `::after`
  to match `MobileTopBar`'s other icon buttons.
- `ChainHealthBanner` — always mounted, silent unless Electrum/SOCKS5 is
  unhealthy. Two distinct unhealthy states, both from `getChainHealth()`
  (`chainHealth.ts`): **never-configured** (`health.neverConfigured` true —
  `isChainNeverConfigured()` in `settings.ts` sees `connection_mode` still on
  its `'public'` default AND `chain_provisioned_by` unset, i.e. a fresh
  install nobody has touched) renders a calm neutral `.neutral`-variant
  banner ("Heartwood isn't connected to the Bitcoin network yet", admin-only
  "Connect a node" link to `/settings#node-connection`, operator-facing copy
  for non-admins) instead of red warning styling; any other unhealthy state
  (admin configured it, or Umbrel auto-connected, and it's now actually
  unreachable) keeps the original red "can't reach it" copy/styling. Fixed
  `cairn-7zjo` (`c90481f`/`85a24da`) — previously every unhealthy state used
  the same red error treatment, which read as "broken" rather than
  "not connected yet, please configure a node" on a healthy fresh install.
- `SyncBanner` — shown until first chain-history sync completes (polls
  `/api/sync` via `startBackoffPoll`, `src/lib/backoffPoll.ts`). Polling is
  **capped-exponential-backoff, not a fixed interval** (`cairn-1f0a`): base
  2.5s while progressing, backing off toward a 30s cap whenever `/api/sync`
  reports the sustained `'unreachable'` phase (it still answers HTTP 200, so a
  fixed loop would hammer it forever) or the fetch throws, and resetting to
  base the moment progress resumes; it stops entirely once `'synced'`. The
  `/sync` details page uses the same helper (base 1.2s). This keeps an
  unreachable backend from producing a continuous request storm and lets the
  page reach network-idle. It self-suppresses (`{#if !hidden && !suppressed}`)
  when `syncStatus.ts`'s `deriveSyncStatus` reports phase `'unreachable'`, since
  that phase is only reached when `chainHealthy` is already false — i.e. the
  identical root cause `ChainHealthBanner` is already showing. Also fixed in
  `cairn-7zjo`: before this, a never-configured or unreachable instance
  could show BOTH banners stacked, which read as doubly broken; distinct
  causes (connecting/history-scan progress while the chain IS reachable)
  still show `SyncBanner` normally.
- `AnnouncementBanner` — admin announcements, server-filtered by flag/
  expiry/dismissal.
- Backup nudge banners: two distinct mechanisms. The still-unbacked-wallet
  nudge (**rewritten `cairn-gt05.5`, v0.2.39** — see § "Backup & restore"
  below for the full decay/escalation contract) is now a server-persisted
  **decaying cadence**, not a per-session dismiss — it replaced the old
  "shows every session until resolved, `sessionStorage`-dismissed" banner,
  which habituated into wallpaper (F16). A gentler, separate 90-day
  "reminder" banner still covers wallets that already HAVE a backup but it's
  gone stale (dismiss is a server POST to `/api/backup-reminder/dismiss`,
  since it must persist across browsers/devices) — unchanged by the rewrite.
- `maybeRedirectToSecure()` fires in `onMount` to auto-hop returning users to
  the HTTPS listener (§9.7 below).
- The old single global `max-width: 940px` cap (with per-page caps narrowing
  further to 760/660/640/680px on settings/activity/admin/mining/wallet/send)
  is gone. Only two content measures exist anywhere in the app now:
  `--measure-reading` (780px, hard cap at every tier — Home, Send, Receive,
  Settings, admin config forms, wizards) and `--measure-data` (1180px,
  1320px at ≥1600px — Explorer, block/tx/address detail, mempool, activity,
  admin tables, wallet-detail tx list, mining dashboard), applied via the
  `.lane-reading` / `.lane-data` utility classes. Dense pages generally pair
  their lane with a `.page-grid` + `.quiet-rail` secondary column (280px,
  cool-toned metadata typography) rather than widening the hero content
  itself — see `docs/DESKTOP-LAYOUT-DESIGN.md` for the full per-page lane
  mapping and the quiet-rail pattern.

Pages under `(app)`:

| Route | Purpose |
|---|---|
| `+page.svelte` | Home/portfolio dashboard — the next-block footer's tip row shows the **confirmed** chain tip (`chain.tipHeight`/`tipTime`) and is labelled "Latest block" (not "Next block" — that name implied the not-yet-mined block; fixed `cairn-dtmi`); the adjacent fee line is a genuine next-block estimate — since UX Phase 4 (`cairn-gt05.4`) it renders through the shared `FeeRate` component inside `FormingRing.svelte` (Term-glossed sat/vB, "ring" no longer in the user copy) |
| `activity/+page.svelte` | user activity feed — event rows render via `linkFor()`, mirroring `NotificationPanel`'s deep-link resolution (see § Notifications system above, `cairn-fochc`) |
| `wallets/+page.svelte` | wallet list |
| `wallets/new/+page.svelte` | single-sig add-wallet wizard (§9.4) |
| `wallets/[id]/+page.svelte` | single-sig wallet detail — **available-vs-maturing split** (`cairn-oae1.3`): Electrum's `confirmed` balance counts an immature coinbase (mining reward) output as spendable, but the send engine's `selectSpendCandidates` refuses to spend it (§ above) — showing the raw Electrum figure as "available" was misleading. `walletSync.ts`'s snapshot now carries a `maturingTotal` field (sum of coinbase-UTXO value not yet mature at the snapshot's `tipHeight`, computed by `sumImmatureCoinbase()`); the hero balance renders `scan.confirmed - maturingTotal` as the honest available figure, with a secondary "· N maturing — mining rewards not yet spendable" line (only shown when `maturingTotal > 0`) linking to the `#mining-rewards` anchor on the `MiningRewards` card below. `scan.confirmed` itself is UNCHANGED in the snapshot (still the full net-worth total the portfolio aggregate / list-view summaries rely on) — the split is a display-layer computation, not a data-model change. Same split applied to `wallets/multisig/[id]/+page.svelte` below. **Fail-closed display classification (`cairn-8lwa6`)**: the shared `classifyCoinMaturity()` (`$lib/shared/coinbase.ts`) is the single display-side answer to "may this coin be presented as spendable?" — `'spendable'` / `'maturing'` (definite immature coinbase) / `'unverified'` (coinbase-ness unresolvable AND young enough to be immature coinbase, or tip unknown). The snapshot carries the `'unverified'` sum as `unverifiedTotal`; both detail heroes subtract it alongside `maturingTotal` and render an honest "· N still being verified — not counted as spendable yet" line. This mirrors the send path's `selectSpendCandidates` guard — the display path previously failed OPEN here (a 1-conf 50 BTC reward with a failed coinbase check rendered as plain spendable). An `'unknown'` coin older than `COINBASE_MATURITY` confs is provably spendable either way and never flagged. **Mining-reward feed identity (`cairn-i0d0q`)**: inbound tx rows whose txid matches the wallet's coinbase UTXOs or (single-sig) the durable `mining_blocks.coinbase_txid` record for this wallet render **"Mining reward"** instead of "Received" — same on the multisig feed (coinbase UTXOs only; pool payouts never target multisigs), Home's `RecentActivity` (`PortfolioActivity.isMiningReward`), and `/activity` mining events get the flame glyph. **Tx row coherence (`src/lib/shared/txRow.ts`, `cairn-jcwb`, v0.2.33):** `shouldShowNetworkFee()` only breaks out the row's "network fee" meta line when `delta < 0` — on a received (`delta >= 0`) row the fee is the *sender's* cost, not this wallet's, and showing it right next to "Received" read as a second, competing figure on the same row (DESIGN-MANIFESTO's "one hero number, never a competing figure" rule at row scope); an outgoing row still shows it since the fee genuinely came out of this wallet alongside the recipient amount. **Speed up control gating (`src/lib/shared/speedUp.ts`, `canOfferSpeedUp()`, `cairn-iare`, v0.2.33):** the inline Speed up button/rate input on an unconfirmed inflow is only rendered when `canOfferSpeedUp()` returns true — false only for the deterministic CPFP `parent_fee_unknown` case (§ shared fee-bump engine above), where a retry can never succeed because the same prevout-decoration lookup runs again at submit time; RBF replacement never reads the parent's fee so it's never gated off by this. Same predicate reused by the explorer tx-detail "Speed this up" CTA (`ownership.server.ts`) so all three surfaces can't drift apart on when to offer a control that's guaranteed to fail. Same tx-row helpers apply to `wallets/multisig/[id]/+page.svelte` below. **First-deposit confidence (`cairn-gt05.6`, F17):** two mechanism-fact states, never reassurance-theater, both mirrored on the multisig detail page below — `neverFunded` (balance, tx count, and unconfirmed all zero) adds a line under the receive-address disclosure ("This address belongs to your wallet... nobody else can move it") answering "is this really mine" without a wait; `hasIncomingPending` (`scan.unconfirmed > 0`) renders a self-updating `.hw-pending-note` under the hero ("Your payment is on its way in... this is your own node telling you") that clears itself the moment the re-scan confirms it — both exist so a first-time depositor never has a reason to leave for a third-party block explorer. The tx-row confirmation meta also now reads "confirming now" instead of `burialRingsLabel(0)`'s usual unconfirmed copy specifically for an incoming (`delta >= 0`) 0-conf row. |
| `wallets/[id]/send/+page.svelte` | single-sig send flow (§9.4) — the eyebrow's "available" figure and the max-amount client validation both come from `+page.server.ts`'s streamed `live.confirmed`, which now has immature-coinbase value folded out (`live.maturingTotal` carries the excluded sum) so client-side validation agrees with what the build engine will actually accept (`cairn-oae1.3`); a "Plus N from a mining reward still maturing" hint appears under the amount field when `maturingTotal > 0`. **UX Phase 2 (`cairn-gt05.2/.7/.11`, move3/ux-polish):** the create step is two decisions — amount + recipient + one "Review payment" primary; "Max" is now a quiet "Send everything ›" link; `CoinControl` lives inside a collapsed `Advanced ›` expander (`createGate.ts` renders a real empty state — "This wallet is empty." + Receive CTA — instead of a bare 0, with a distinct maturing-coinbase variant); the fee picker (`FeeSpeedPicker`) no longer appears on create — the draft builds at live Standard and the **review card owns the fee** as one collapsed tappable line that expands to three plain speeds (Priority ~10 min / Standard default / Economy "a few hours", each priced via `Amount`, raw sat/vB demoted to muted micro-text; picking a speed rebuilds the draft, user-gated, never silent). `AtTipPill` and the create-step PSBT `HowItWorks` are gone (sign step carries "Why do I sign on my device?" with PSBT Term-glossed as "unsigned transaction (a proposal)"). The review step is a first-person verification act (`SendReviewCard`): heading "Confirm this payment is going to the right place", grouped address, muted own-node mechanism line at the broadcast moment (gt05.11). Broadcast/sign/build failures render structured `sendFailure.ts` copy stating fund-state + retry-safety ("Nothing left your wallet — you can safely try again") and always preserve the draft (gt05.7). |
| `wallets/[id]/receive/+page.svelte` | **canonical Receive subpage (UX Phase 2)** — Tier-2 surface both Home's and wallet-detail's Receive buttons route to; embeds the shared `_components/ReceivePanel.svelte` (QR hero, "A fresh address, every time.", Copy, Rotate + Advanced › derivation) verbatim; rotate action delegates to `src/lib/server/receiveRotate.ts`, the single rotate implementation shared with the detail page so the two can't drift. Snapshot-backed (no Electrum call on nav). |
| `wallets/[id]/settings/+page.svelte` | **wallet settings subpage (UX Phase 2, new)** — rename (new `renameWallet` in `wallets.ts`), "Download backup file" (renamed from "Export config"; JSON/descriptor/CSV), full address list with label editing (replaces the old "Addresses · N" tab), and the **red Danger remove-wallet block at the bottom**: two-step confirm UI backed by a server-side gate (`?/delete` fails 400 without `confirmed=yes`) with the "only stops Heartwood tracking it; your funds are safe if you keep your backup" line. The old in-flow delete on the detail page and its `?/delete` action are gone — any QA step that POSTed `/wallets/[id]?/delete` must target `settings?/delete` with `confirmed=yes`. |
| `wallets/multisig/new/+page.svelte` | multisig creation wizard (§9.4) |
| `wallets/multisig/[id]/+page.svelte` | multisig vault detail — same available-vs-maturing split as the single-sig detail page above (`MultisigSnapshot.maturingTotal`, `cairn-oae1.3`); same first-deposit `neverFunded`/`hasIncomingPending` mechanism-fact states and "confirming now" 0-conf label as the single-sig page above (`cairn-gt05.6`). **Pending-signature drafts (`cairn-0pxk5`):** an unfinished `multisig_transactions` row (`status` `draft` or `awaiting_signature`) has no on-chain footprint, so it never surfaced in the Electrum-scan "Transactions" tab, which counts `detail.history.length` — a saved draft was otherwise undiscoverable short of the exact `?tx=` URL. A calm-amber "Awaiting signatures (N)" card now lists every such `scan.savedTxs` row with a "Review draft #N →" link to `/wallets/multisig/{id}/send?tx={id}` (the same deep-link shape `freezeRosterAndNotify` already emits), gated to `data.role !== 'viewer'` since the Send page 404s a pure viewer. Independent of the on-chain scan — a local DB read, so it still shows when `scanError` is set. Separately, `wallets/multisig/[id]/send/+page.server.ts`'s fresh-wizard load (no `?tx=`) now checks `listMultisigTransactionSummaries` for any other unfinished draft on the wallet and, if found, the Create step shows a dismissible `Banner(variant=warning)` — "A transaction draft is awaiting signatures — starting a new one won't affect it." with a "Resume draft" link — never an auto-redirect, agency stays with the user. |
| `wallets/multisig/[id]/send/+page.svelte` | multisig send/co-sign flow |
| `wallets/multisig/stateless/+page.svelte` | stateless (no-account) multisig PSBT signer |
| `explorer/+page.svelte` | block explorer home — includes an "Up next" strip (up to 4 projected-block chips, fed by the same server-loaded `mempoolBlocks` snapshot, linking through to the full mempool treemap viz; hidden gracefully rather than erroring when the chain backend has no projection data). The tip-view block list (`data.before === null`) renders the dashed pending/mempool row **before** the `{#each blocks}` loop, so the next-block-to-be-mined always sorts **above** every confirmed block — it used to render after the loop, so pending sorted below confirmed blocks instead (`cairn-lynf`, fixed v0.2.26). `pending` stays gated to the tip view only, so paged/older history is unaffected. |
| `explorer/address/[address]`, `explorer/block/[id]`, `explorer/tx/[txid]` | detail pages — `explorer/block/[id]` shows a block-level "Yours in this ring" callout AND (cairn-6efi.12) a per-row sage "Yours" pip on any transaction in the paginated tx list that touches the viewer's own wallets, via `ownership.server.ts`'s memoized, viewer-scoped `ownedTxids()`/`ownedTxsInBlock()` — zero extra chain calls, same privacy boundary (viewer's own wallets only) as the index's `ownedBlockHeights()` pip. **`explorer/tx/[txid]` also renders a BlueWallet-style block-context section** (`BlockContext.svelte` under the status row): a confirmation badge ("6+ confirmations" green at ≥6, paired with the burial-rings glyph), a tappable 1–3 block row (prev/confirmed/next with dates, the tx's position marker inside the confirmed block, each block linking to `explorer/block/[height]`), and a plain-language confirmation summary. Streamed via `loadTxDetails` as `blockContext` (never blocks first paint) from `ChainService.getTxBlockContext` and progressive-enhancement aware — `none` (connecting), `basic` (Electrum-only: dates + position + summary, no Core nag; a quiet admin-only hint offers Core for block sizes), `full` (Core adds block tx-count/size/fullness). Pure copy/badge logic in `blockContext.ts` (`summaryLine`/`confirmationBadge`); one block glyph is `MiniBlock.svelte`. Also exposed standalone at `GET /api/tx/[txid]/block-context`. Because `getTx` now falls back to Electrum (above), this page works on a pure-Electrum Umbrel with no Core RPC. See docs/TX-BLOCK-CONTEXT-DESIGN.md. **"Total in" degrades honestly**: an unconfirmed (mempool) tx has no resolved prevout values, so each input shows "—" and the `txTotalIn()` helper (`txTotals.ts`) reports `known:false` when *any* input value is unknown — the total then renders "—" too, never a misleading "0.00 BTC" summing of unknowns (cairn-zmym), matching how the fee already degrades. |
| `explorer/mempool/+page.svelte`, `explorer/mempool/blocks/+page.svelte` | mempool visualizer |
| `explorer/difficulty` | difficulty chart |
| `mining/+page.svelte` | this user's own solo-mining dashboard (§ "Mining engine" above, § "Mining dashboard client" below) — flag-gated (`mining`), scoped entirely to the viewing user by `getUserMiningView` |
| `recovery-setup/+page.svelte` | post-signup recovery/backup setup flow |
| `welcome-aboard/+page.svelte` | 4-step guided first-run tour for invited crew (see §7 "Come aboard") — reached from the signup page's post-invite redirect through the agreement gate's `next=welcome-aboard` threading; sessionStorage-resumable (`_components/welcomeProgress.ts`) |
| `settings/+page.svelte` | **the one settings page (UX Simplification Wave 2, `cairn-6c91u.2`, spec §4)** — personal groups render for every signed-in user, in order: Account (`#set-account`: profile, password, notifications link), Display (`#set-display`: units/fiat/theme, unchanged from UX Phase 3), Security (`#set-security`: recovery, passkeys, devices, tokens, contacts when team mode), Advanced (`#set-advanced`, collapsed), Danger zone (`#set-danger`, collapsed, red, typed-DELETE). Four admin-only groups append after them, visible only for `user.isAdmin` and loaded only inside that guard in `+page.server.ts` (a non-admin's payload carries none of this): Node connection (`#node-connection` — moved verbatim from the deleted `/admin/settings`, incl. chain source, Electrum/Core RPC fields + Test connection, the Umbrel assisted-connect card, Tor/performance advanced fields), Mining (`#mining` — the instance ON/OFF toggle, writes the `mining` flag via `setGlobalFlag`; a "Pool operator settings ›" link to `/admin/mining` appears when on), Explorer (`#explorer` — the instance ON/OFF toggle, same `setGlobalFlag` path), Instance (`#instance`, collapsed — registration mode, team-mode toggle, user agreement editor, link rows to the surviving `/admin/*` subpages, and Factory reset as its last, red, typed-RESET-confirm row, `#factory-reset`). Every admin-group form action calls `requireAdmin(event)` first (personal actions keep `requireUser`) since this page has no admin-layout wrapper to lean on. |
| `settings/contacts` | address book |
| `settings/devices` | linked/trusted devices |
| `settings/notifications` | per-user notification prefs incl. SMTP |
| `settings/tokens` | API tokens |
| `admin/+layout.svelte` + `admin/+page.svelte` | **the Health hub (renamed "Node"→"Health" in UX Phase 3; **the persistent tab strip is now gone entirely**, UX Simplification Wave 3, `cairn-6c91u.3`, spec §5.2)**: one status headline ("● All systems healthy" / "⚠ N things need your attention"), then monitored duty rows — Node, Backups (promoted, amber + inline "Back up now" when unbacked), Storage, Users (`/admin/users` link, team mode only) — then a quiet "rare admin destinations" footer link row (`.instance .foot-links`): "Instance settings →" (`/settings#node-connection`), Registration (`/settings#instance`), Activity log, Invites (team), Backup schedule, Notification delivery, Announcements, Referrals, Logs, Mining, Agreement. **No Feature flags link** — that page is gone. The duty verdicts come from the shared `src/lib/health.ts` `deriveHealth()` object, the same derivation Home's Health line reads (one truth, multiple altitudes). `admin/+layout.svelte`'s `sections` array is now a breadcrumb lookup only (so a directly-opened subpage can still name itself in the eyebrow "HEALTH · <SECTION>"), not a rendered tab row — there is no `.admin-nav` element in the DOM anymore. |
| `admin/mining/+page.svelte` | operator's cross-user solo-mining dashboard: engine health/start-stop-restart, pool-wide hashrate hero + chart, per-miner + per-user breakdowns, blocks-found ledger, engine settings form (§ "Mining engine" above, § "Mining dashboard client" below); reached from Settings → Mining → "Pool operator settings ›" |
| `admin/activity`, `admin/announcements`, `admin/backup`, `admin/invites`, `admin/logs`, `admin/notifications`, `admin/referral-settings`, `admin/users[/[id]]` | admin-only surfaces that **stay** as real pages; reached from Health's footer link row and/or Settings' Instance group, not from a permanent nav strip. `admin/users/[id]` no longer renders the per-user feature-flag override grid (§7). |
| `admin/settings`, `admin/feature-flags` | **deleted as pages** — both are now bare `+page.server.ts` `load` functions that `redirect(307, …)` to `/settings#node-connection` and `/settings#mining` respectively (spec §5.3/§9), keeping old bookmarks and notification/health deep links alive. Their content lives in `/settings`'s admin groups now (see the `settings/+page.svelte` row above); nothing under either old route renders UI anymore. |
| `vaults/{new,[id],[id]/send,stateless}` + `_components` | **empty scaffolding only** — `git ls-files` returns zero tracked files under any of these dirs. Mirrors the `wallets` tree in shape (list → `[id]` → send) but nothing is implemented. Any hit on `/vaults*` (bare or with a path) is 301-redirected to the equivalent `/wallets` (or `/wallets/multisig`) route by `hooks.server.ts:505-516` before it would ever reach these directories — see §7 and the Part II route note. Don't start building real `/vaults` pages without checking scope first. |

**`(auth)` — unauthenticated.** `+layout.server.ts`/`+layout.svelte`,
`login/+page.svelte` (+ `nextUrl.ts`/test — safe post-login redirect target
parsing), `signup/+page.svelte`, `recover/+page.svelte`.

**Top-level standalone routes**: `agreement/`, `terms/`, `disclosure/` (each
has a `+page.server.ts`; `agreement` has a `server.test.ts`); `setup-admin/`
(first-run admin bootstrap); `sync/+page.svelte` (dedicated first-sync
progress page, distinct from the in-layout `SyncBanner`); `logout/+page.server.ts`
(logout action only, no UI); `invite/[code]/` (public captain-branded invite
landing — see §7 "Come aboard" for the preview contract and rate limiting).

**`api/`** — the ~100-endpoint JSON tree covered in §8, consumed by client
polling/fetch/live-stream (e.g. `ChainHealthBanner` is payload-driven off the
`health` topic on `/api/live` — poll removed, see `docs/LIVE-UPDATES-DESIGN.md`
— while `SyncBanner` still polls `/api/sync` via its own backoff poll, since
first-sync progress isn't part of the live-updates design).

### Svelte components (`src/lib/components`)

Flat top-level components: `Amount` (renders a BTC/sats value as the
**primary** line, with its live fiat equivalent from `$lib/price` — when a
price is available — as a muted **secondary** line beneath, sats-first by
default per `docs/DESIGN-MANIFESTO.md` §3's MUST rule; a user can flip the
default via Settings → Display's fiat-primary toggle, persisted to
`localStorage` as `cairn.fiatPrimary` and read through the shared
`fiatPrimaryPref` store in `$lib/price` — `isFiatPrimary()` in `$lib/format`
makes the actual primary/secondary decision. By default an `Amount` instance
subscribes to the shared `$btcUsd` store, which re-fetches `/api/price` on a
60s interval for as long as any subscriber is mounted (`$lib/price.ts`). Home's
hero balance and both wallet-detail heroes (`wallets/[id]`,
`wallets/multisig/[id]`) instead pass an explicit `price` prop — a
privacy-gated snapshot fetched once per page load, not the live-ticking
store — so the fiat secondary line there updates only on navigation, never
mid-view (F1: a live-repainting number is a fresh loss-aversion evaluation
event every tick; `cairn-d326`, v0.2.27). Every other `Amount` call site
(explorer, send review, activity, etc.) is unaffected and still live-ticks.

**Fiat display: Hidden, centrally enforced (`cairn-r494`, v0.2.33):**
Settings → Display also has a "Fiat display: Hidden / USD shown" toggle,
persisted as `cairn.fiat` and read through a new shared `fiatVisible` store
in `$lib/price` (companion to `fiatPrimaryPref` above — separate concerns:
one picks which line leads, the other decides whether a fiat line renders
at all). Before this fix only the 3 page heroes (Home, both wallet-detail
pages) computed their own gated price and passed it explicitly; every other
`Amount` call site — tx rows, fee lines, address balances, maturing/
unconfirmed inline amounts, the two bare `formatFiat` calls in
`SendReviewCard` — fell through to the raw live `$btcUsd` store with no
awareness of the setting and leaked fiat on wallet-detail pages regardless.
`Amount.svelte` now resolves its price through `resolveAmountPrice()`
(`$lib/format`) as the single enforcement point: `fiatVisible` false always
wins, even overriding an explicit `price` prop passed by a hero. Every
setter of the `cairn.fiat` key must go through `setFiatVisible()` rather
than writing `localStorage` directly (Settings does), so the store — and
every mounted `Amount` — updates live across client-side navigation within
the same session, no reload required. The send flow's CTA button label
(`sendCtaLabel`/`moneyOrBtc`, `$lib/components/send/sendMoney.ts` — a plain
string, not a rendered `Amount`, so it can't subscribe to the store itself)
takes the same `fiatVisible` boolean as an explicit 4th argument from its
two call sites (`cairn-9y49`) so "Send $x.xx" / "Broadcast — $x.xx" also
falls back to a BTC/sats-only label when hidden. **Follow-up (`cairn-8pl9w`,
v0.2.39): `AmountEntry` is no longer exempt.** It used to gate fiat
eligibility on `fiatPrimaryPref` alone, so a Hidden setting still let its
rate-anchor line ("1 BTC = $x"), fiat secondary line, and BTC→sats→USD
entry-cycle stay reachable — a real leak, not the deliberate exemption the
old comment claimed. `fiatEligible` now requires `fiatVisible` too; a
Hidden setting keeps the rate-anchor line unrendered, forces the secondary
line to the other Bitcoin-denominated unit, and — if the field happened to
be mid-cycle in fiat entry mode when the setting flips to Hidden — resets
`entryUnit` back to the BTC/sats `unitPref`, same enforcement doctrine as
`Amount.svelte`.

Used app-wide including the
stateless multisig flow, single-sig send, explorer address history, and the
wallet unconfirmed-incoming line — PSBT "verify against your device" panels,
fee/change/input breakdown line items, and `BalanceChart` axis labels stay
BTC/sats-only by design),
`AnnouncementBanner`, `Banner` (persistent inline
error/status banner — contrast with toasts below), `CopyText`,
`CoreRpcRequiredNotice`, `DevicePicker` (grid of signing-device tiles, gated
per-tile by feature flag, `file` is the ungated universal fallback — §9.7),
`FeatureDisabled` (flag-gated placeholder), `HowItWorks` (collapsible
per-page explainer, open/closed state persisted in `localStorage` keyed
`cairn.explain.{id}`), `Icon`, `MiningRewards` (per-coin coinbase maturity
card, `id="mining-rewards"` anchor for the wallet-detail hero's "maturing"
link — §above; each immature row reads "`N` of 100 confirmations —
spendable in ~`B` blocks (~`eta`)" per `cairn-oae1.4`, e.g. "42 of 100
confirmations — spendable in ~58 blocks (~9.7 hours)"; `eta` is
`formatMaturityEta()` from `$lib/shared/coinbase.ts` — 1-decimal hours once
the wait crosses an hour, whole minutes below that, at a flat ~10 min/block —
distinct from `coinbaseMaturity()`'s own `etaHours` field, which stays a
rounded-up integer for its other caller, `CoinControl.svelte`), `NotificationPanel`,
`QrScanner` (shared camera-scan/paste-fallback UI, committed as `96cd16a
refactor(qr): shared QrScanner component behind existing signer flows` —
extracted from the near-identical scan loops `QrSigner.svelte` and
`JadeQrSigner.svelte` each used to implement independently; see the send-flow
description below for how the two signers use it), `Stepper` (generic step
indicator), `Term` (inline dotted-underline glossary tooltip — hover AND
keyboard-focus reveal, a real `<button>` so it's honestly focusable),
`Toasts` (renders the toast queue), `TxStatusBadge`.

`qrScannerLogic.ts` (`src/lib/components/qrScannerLogic.ts`) is `QrScanner`'s
pure decision module (frame-join/paste-fallback logic), split out because
this repo's Vitest config has no Svelte plugin — `.test.ts` files can't
import `.svelte` components, so the testable logic has to live in a plain
`.ts` module (`qrScannerLogic.test.ts` exercises it against real bbqr/jadeUr
fixtures).

`toast.svelte.ts` is the runes-based toast store — see below.

**`heartwood/`** — the visual design system's bespoke components:
`AtTipPill`, `BackCircle` (mobile flow-page back button), `BurialRings`,
`CairnChart`, `ChainHealthBanner`, `ChainStrip`, `EpochDial`,
`EyebrowBreadcrumb` (the "current segment vs path segments" breadcrumb using
`--eyebrow`/`--eyebrow-path`), `FirstSyncGrowth`, `GroveField` (the ambient
background texture), `HWRail`, `HeartwoodMark` (logo mark), `MobileTabRow`,
`MobileTopBar`, `Modal`, `NavProgress`, `NodeTrustChip` (the "Verified by
your node" trust pill on Explorer heroes — pure presenter over the server's
`nodeTrust.ts` honesty matrix; its popover renders in normal document flow
(`position: relative`, not `absolute`), so opening it pushes the rest of the
page down instead of floating over Status/Last-block-seen/Node-info content
beneath it — it used to overlap that content, unreadable on mobile
(`cairn-klxj`, fixed v0.2.26)), `QuorumArc` (multisig m-of-n
visual), `RingStub`, `SyncBanner`, `SyncIndicator`.

**`portfolio/`**: `AllocationBar`, `BalanceChart`, `BalanceHorizons`,
`RecentActivity`, `Sparkline` — home-dashboard widgets. `BalanceHorizons`
renders the multi-horizon growth row (1d/30d/1yr/all-time together, per
`docs/DESIGN-MANIFESTO.md`'s delta-display MUST: never a naked single-point
delta) on Home (`portfolio.change`, server-aggregated across wallets) and
both wallet-detail pages (client-derived from that one wallet's own confirmed-
tx history, via `$lib/horizonDelta`'s `buildHorizonRows`/`historyFromTxDeltas`
— no `balance_snapshots` wired to that loader). Percent leads ("+8%"); the
absolute-sats figure sits one layer down in a title tooltip, never a second
visible line. Only growth gets `--sage`; flat/down/unknown horizons all share
the same neutral `--text-secondary` — "down is neutral, never red" applies
literally, not just to color choice. Gated off entirely while the balance is
hidden (a delta leaks wealth-change magnitude even with the total masked).
Added v0.2.27 (`cairn-d326`); `getPortfolioAggregate`'s d365/all fields were
hardened in v0.2.29 (`cairn-ht11`, `src/lib/server/portfolio.ts`'s
`changeWithTxFallback`) to recompute live from each wallet's tx history
instead of trusting the persisted `balance_snapshots`-derived value once
`dataRetention.purgeBalanceSnapshots`'s ~13-month sweep ages out the
one-time backfill's carry-in anchor point — before the fix, `all` in
particular could silently report a change since whatever row happened to
survive the purge (even flipping sign) rather than degrading honestly; d1/d30
were never affected since retention always keeps the last 30 days at full
resolution. Falls back to the persisted d365/all only when the live tx
history itself can't be trusted (missing timestamps, deltas that don't
reconcile with the scanned balance).

**`signing/`** — shared hardware-wallet signer UI (used by both single-sig
send and elsewhere): `BitboxSigner.svelte`, `JadeUsbSigner.svelte`,
`LedgerSigner.svelte`, `TrezorSigner.svelte`, `DeviceHelpLink.svelte`,
`SecureContextHelp.svelte` (§9.7). Route-local signer variants that aren't
shared live under `wallets/[id]/send/_components/` (`ColdCardSigner`,
`QrSigner`, `JadeQrSigner`, `DeviceCard`, `CoinControl`,
`RecipientCombobox`) and `wallets/multisig/[id]/send/_components/
MultisigFileSigner.svelte`.

**`mining/`** (epic `cairn-vn43`) — split into the user-facing dashboard and
the admin-facing operator view:
- User dashboard (`/mining`): `MiningHero` (hashrate now/24h),
  `MiningConnectionCard` (host/port/username/password setup card),
  `MiningPayoutWallet` (payout-wallet picker, eligible wallets only),
  `MiningWorkersList`, `MiningEarnings` (blocks found + matured/pending
  sats), `MiningOddsPanel` (honest measured-hashrate solo odds),
  `MiningOnboarding` (the flag-off/no-wallet/engine-stopped/not-enabled
  empty states, one component with a `kind` prop rather than four separate
  ones).
- Admin dashboard (`/admin/mining`): `AdminEngineHealth`, `AdminPoolHero`
  (pool-wide hashrate), `AdminHashrateChart` (24h series from `mining_stats`
  pool rows), `AdminMinersTable` (every live connection), `AdminUserBreakdown`
  (per-user share of pool hashrate), `AdminBlocksLedger`,
  `AdminPoolSettingsForm`. `adminMiningView.ts` holds the shared
  `AdminMiningView` type + `DEGRADED_ADMIN_MINING_VIEW` fallback constant
  used when the read model throws.

### Mining dashboard client (`/mining`, `/admin/mining`, `/mining/pool`)

**Live refresh model (`docs/LIVE-UPDATES-DESIGN.md` §4.2/§5) — the old 10s
poll is gone.** Pages server-load a full view once, then subscribe to
the multiplexed `/api/live` stream via `$lib/live/liveClient`'s `subscribe()`
— `/mining` on the user-scoped `mining` topic; `/admin/mining` and the new
`/mining/pool` both subscribe to the same `mining:pool` topic. `mining:pool`
is **no longer admin-only** (`cairn-et38g`) — it's broadcast to every
connected client (`liveHub.ts`'s `{broadcast: true}` publish option), since
the pool stats it nudges are now genuinely public (any signed-in user, not
just admins). `/admin/mining` still refetches the admin-gated
`GET /api/admin/mining`; `/mining/pool` refetches the new, separately
feature-gated `GET /api/mining/pool`. Both topics carry an empty-payload **nudge**
(fired on each `~15s` aggregates flush, plus immediately on a block-found),
debounced client-side (`$lib/live/walletEvents`'s `debounced()`), and the
nudge triggers a refetch of the same JSON endpoint each page used to poll
(`GET /api/mining/me`, `GET /api/admin/mining`) rather than trusting an
inline payload. `/mining` replaces its whole local `view` object with the
refetch response; `/admin/mining` merges only the **volatile** fields
(`engine`, `pool`, `hashrateSeries`, `miners`, `userBreakdown`, `blocks`)
into local state and deliberately excludes `settings` from the merge, so a
refetch landing mid-edit never clobbers what the admin is typing into the
settings form below — that form seeds its own local state once from the
initial load and manages its own save independently. Both pages also
refetch immediately on `visibilitychange` becoming visible again, so a
backgrounded tab catches up on return even if it missed a nudge. A failed
refetch is silently swallowed on both pages (best-effort — keep showing the
last good view rather than flashing an error over a routine transient fetch
failure); the next nudge catches up.

**Empty-state precedence (`/mining`, `cairn-vn43.24`)** — checked in this
exact order, first match wins:
1. `loadError` — `getUserMiningView` threw server-side; degrades to an
   inert dashboard with an honest "Mining data is temporarily unavailable"
   banner, never a blank page or a misreported "pool isn't running" state.
2. `engine.status === 'core_missing'` — Bitcoin Core RPC isn't configured
   at all; reuses `CoreRpcRequiredNotice.svelte` as-is (the same component
   every other Core-only feature uses).
3. `engine.status === 'stopped'` — the flag is on and Core is configured,
   but the operator hasn't turned mining on in `/admin/mining` (or it
   crashed) — "Mining isn't running yet — your operator hasn't started the
   pool yet."
4. No eligible payout wallet (`view.wallets.filter(w => w.eligible)` is
   empty — a wallet needs an `xpub` to be payout-eligible) — a blocking
   "you need a wallet first" card linking to `/wallets`; the wallet
   selector itself is suppressed rather than shown empty.
5. `!view.connection` — the user currently has mining turned off, whether
   they've never enabled it (no `mining_id` minted yet) or they enabled it
   once and later disabled it (`prefs.enabled === false`) — the "Enable
   mining" onboarding card. `getUserMiningView` requires **both**
   `prefs.miningId` and `prefs.enabled` to build `connection` (`cairn-p10q`,
   v0.2.34): a `mining_id`, once minted, is permanent (`ensureMiningPrefs`
   never clears it on disable), so gating on its mere existence made this
   state unreachable again after a user's first-ever enable — the page kept
   rendering a live-looking connection card and "Turn off mining" button
   with dead credentials. Past `earnings.blocksFound` still render below the
   onboarding card in this state (blocks are historical fact, independent of
   whether mining is currently on); the live worker list stays gated behind
   `connection` since a disabled user's miner can't authorize against the
   Stratum auth table anyway. Re-enabling reuses the same `mining_id`.
6. Otherwise: the full dashboard (hero, connection card, payout wallet,
   worker list, earnings, odds). A connected-but-workerless state (mining
   enabled, `mining_id` exists, no miner has ever connected) is **not** a
   separate empty state — `MiningConnectionCard` itself carries a
   "waiting for your first share…" hint alongside the setup fields, since
   the connection card already is the primary thing to show there.

**Admin runbook (`/admin/mining`).** Enabling the pool for the first time
requires the `mining` feature flag on instance-wide (the Mining toggle in
`/settings`'s admin groups, `#mining` — it ships `defaultEnabled: true` but
soft-launch-defaults to off on fresh installs via `miningDefaultMigration.ts`)
**and** the admin turning it on here: either the quick start/stop toggle
on `AdminEngineHealth` (flips only `mining_enabled`, fast — doesn't touch
the rest of the settings form) or a full `AdminPoolSettingsForm` save
(validates port 1-65535, share difficulty > 0, vardiff target 1-60/min,
pool tag ≤24 printable-ASCII chars, then calls `reconfigureMiningEngine()`
— a full stop/re-read-settings/start). **Bind/LAN exposure**: the `bind`
selector is tri-state (`loopback`/`lan`/`all`) and defaults to
loopback-only — copy on this field should make plain that `lan`/`all`
opens the raw Stratum TCP port to every device on the local network with
no additional authentication beyond the per-user mining ID (there's no
password check), so it should only be widened deliberately, e.g. to reach
a Bitaxe on the same LAN. **Reading the dashboard**: `AdminEngineHealth`
shows listening state, bind/port, last-template-age (a stale
`getblocktemplate` for more than a tip interval usually means Core RPC
trouble — `coreRpc: 'down'`), and any accumulated `fatalErrors` (invariant
violations from the engine's serialized event queue — these should be
empty in normal operation; a non-empty list is worth investigating, not
routine noise). `AdminPoolHero`/`AdminHashrateChart` show pool-wide
hashrate now/24h from live aggregates plus a 24h series built from
`mining_stats`' pool rows (`user_id IS NULL`). `AdminMinersTable` lists
every currently-live Stratum connection by user/worker/hashrate/difficulty/
last-share-age; `AdminUserBreakdown` collapses that to one row per user with
their share of pool hashrate; `AdminBlocksLedger` lists every block this
instance's engine has ever submitted (accepted or rejected) across all
users, newest first, with live confirmation counts and maturity status.

**Public pool stats page (`/mining/pool`, `cairn-et38g`).** Feature-gated on
`mining` like `/mining` itself (`requireFeature`, any signed-in user — not
admin-only), and reads `GET /api/mining/pool` → `getPublicPoolView()`
(`readModels.ts`). Shows: pool hashrate now/24h plus a 24h chart (same
pool-scoped `mining_stats` rows the admin chart reads); miners online; a
best-share "High scores" leaderboard (`cairn-192dr`, no pot, bragging rights
only) — per-user best share difficulty, durable DB best
(`mining_workers.best_share_diff`) overlaid with live session bests, top
10, ranked; and a blocks-found trophy wall (newest first, all finders, name
+ reward + found-at + maturity status) with finder display names — the
same names the admin view already shows, since a Heartwood instance is a
private multi-user install and the trophy wall is the point. Genuinely
sensitive admin-only material (settings, per-connection difficulty, fatal
errors, per-user share percentages) stays on `/admin/mining` behind
`requireAdmin` and is never exposed here.

**Best-share-ever card (`/mining`, "Your closest call so far",
`cairn-20k25`).** Rendered when `view.totals.bestShareEver > 0`: shows the
user's own all-time-best share difficulty plus a "N% of the way to a block"
context line, derived by comparing that share difficulty against
`UserMiningView.networkDifficulty` — an approximate network difficulty
computed from the node's network hashrate estimate (`D ≈ H · 600 / 2^32`,
same formula `getPublicPoolView()` uses), so no second chain call is needed
beyond the one already fetching hashrate. Null/absent when the node can't
report a network hashrate — degrades to showing nothing rather than a
misleading percentage.

**User guide (`/mining`).** Connecting a Bitaxe or small ASIC: point its
Stratum configuration at this instance's address, the port shown on
`MiningConnectionCard` (the admin-configured `mining_stratum_port`, `3333`
by default), and a username of `<miningId>.<workerName>` — the
`workerName` suffix is optional (a default is applied if omitted) but
naming each physical device distinctly (e.g. `hw_a1b2c3d4.bitaxe1`) is what
makes the worker list and offline notifications useful once more than one
device is connected; the password field is ignored by the engine entirely
and the UI shows the literal placeholder `x`.

**Connection-card address display.** **Honest loopback state
(`cairn-bm7c2`):** when `mining_bind` resolves to loopback, the card no
longer prints a copyable address at all (a copy-paste address that only
ever works from the host machine is a dishonest affordance) — it states
the pool is only reachable from this computer, with an admin-only link to
`/admin/mining` to open it to the LAN. **Dual-port display
(`cairn-pz8v5`):** when the ASIC listener is on, the card prints TWO
addresses side by side with plain-language labels — "Small miners (Bitaxe,
USB sticks)" → the standard port, "Big machines (Antminer-class)" → the
ASIC port — plus a line explaining big machines get a separate lane so
their flood of work doesn't drown out the small ones; with the ASIC
listener off it falls back to the single "Pool address" field as before.
Neither address block renders while loopback-only, regardless of ASIC-port
state. **SV2 row (`cairn-qfez8.9`):** when the admin has SV2 on, a third
field appears — "Next-generation miners (Stratum V2)" — showing
`stratum2+tcp://host:port/<authorityPubkey>`, same `CopyText` affordance,
same loopback gating as the two V1 rows above.

**Honest odds framing**: the odds panel computes solo probability from the user's own **measured**
current hashrate against the network's current `getnetworkhashps` — not a
theoretical device spec — so it degrades gracefully (shows nothing) rather
than a misleading number when no miner has connected yet or the network
hashrate call fails. **Payout wallet**: any of the user's own wallets with
an `xpub` is eligible; the payout address itself comes from
`peekReceiveAddress()` and is held stable across job rebuilds — it only
advances (via `nextReceiveAddress()`) the moment a block is actually found,
so nothing is "reserved" or burned by mining alone. **Maturity**: a found
block's reward is a coinbase output and needs the standard 100 confirmations
before it's spendable — `MiningEarnings` and the wallet-detail
`MiningRewards` card both show the maturing countdown; `/mining`'s own
`earnings.totalPendingSats`/`totalMaturedSats` split mirrors the same
`coinbaseMaturity()` logic used everywhere else immature coinbase value is
displayed (§ above). **Labels are lifetime figures, not wallet truth
(`cairn-e176o`)**: `totalMaturedSats` sums `mining_blocks` rewards with no
join against the live UTXO set, so after a matured reward is spent the sum
still includes it — the UI therefore says **"Total earned"** (and per-block
chips say **"Matured"**, in `MiningEarnings` and `PoolTrophyWall`), never
"Spendable"; the wallet pages are the only spendability authority.

**Explorer pool-found attribution (`cairn-r1hca`).** This instance's own
pool finding a block is celebrated on the explorer, distinct from the
generic third-party "Likely {pool}" identification `src/lib/server/
chain/pools.ts`'s `identifyPool()` does from a coinbase scriptSig/payout-
address match against the vendored `known-pools.json` table (that path
only ever renders a POSITIVE id — an unknown coinbase shows nothing, never
a guess). Block detail (`/explorer/block/[id]`) calls
`getPoolBlockAttribution(blockHash, viewerUserId)` (`readModels.ts`) — a
chain-free local `mining_blocks` lookup, accepted submits only (a rejected/
reorged-out submit is not "our block" on the active chain) — and renders
`PoolFoundBanner.svelte`, a growth-green (`--sage`/`--sage-muted`) one-shot
celebration: **"You found this block"** for the finder themself (with a
link to their payout wallet — `walletId` is only ever exposed to the
finder, null for everyone else), or **"Found by this pool — {name}"**
otherwise. The explorer index (`/explorer`) instead does this per-row for
its whole visible block list via `listPoolFoundBlockHashes()` — a single
membership-set query, no per-row DB hit — and renders a "Found here" chip
that **overrides** the generic "Likely {pool}" meta-line label for that
row (the code comment is explicit: never both, the pip beats the guess).

### Stores / client state

Cairn uses **Svelte 5 runes**, not classic `writable`/`readable` stores, for
shared client state. The pattern is: a `.svelte.ts` module holds `$state` at
module scope and exports plain functions/getters — not a store object with
`.subscribe`.

- **`src/lib/components/toast.svelte.ts`** — the one global mutable client
  store. `items = $state<ToastItem[]>([])` at module scope; exported `toast`
  object with `success/error/info/warning/dismiss/clear` and a `get items()`
  accessor. Timing: success 4s, info 5s, warning 7s, error 8s auto-dismiss;
  `duration: 0` = sticky. Rendered once anywhere via `<Toasts />`. Explicitly
  contrasted with `<Banner>` in the doc comment: toasts are for transient
  action feedback; persistent/recoverable conditions use an inline
  `<Banner>` instead.
- **`src/lib/portfolioViewState.ts`** — not stateful itself, but the shared
  stale-while-revalidate decision function every wallet list/detail page
  uses: `portfolioViewState({lastSyncedAt, refreshFailed}) => 'first-sync' |
  'unreachable' | 'ready'`. Pure and unit-tested
  (`portfolioViewState.test.ts`) specifically so a real cached balance is
  never silently replaced by a fake zero — `lastSyncedAt` wins over
  `refreshFailed` ("that's the whole point of stale-while-revalidate").
- **`src/lib/chainRefresh.ts`**, **`src/lib/liveBlocks.ts`** — client
  chain-tip refresh helpers (`onNewBlock` is imported by the send page to
  refresh fee estimates on a new block); transport is the single
  multiplexed `/api/live` stream via `src/lib/live/liveClient.ts`, not a
  dedicated `/api/events` `EventSource` — see `docs/LIVE-UPDATES-DESIGN.md`.
- **`src/lib/live/liveClient.ts`** — owns the one `EventSource` per tab
  (reusing the same reconnect/visibility/stale-watchdog logic the old
  per-endpoint helpers had), dispatches named SSE events (`block`,
  `mempool`, `health`, `wallet`, `notification`, `mining`, `mining:pool`)
  into per-topic Svelte 5 rune stores under `src/lib/live/`
  (`tipHeight.svelte.ts`, `mempoolStats.svelte.ts`, `chainHealth.svelte.ts`).
  Components call its `subscribe(topic, handler)` rather than constructing
  or holding an `EventSource` themselves. `/api/events` and
  `/api/notifications/stream` are retired — every consumer now goes through
  `/api/live`.
- **`src/lib/mempoolViz.ts`** — pure layout/geometry helpers for the mempool
  visualizer (unit-tested separately from the `explorer/mempool` page).
- **`src/lib/secureRedirect.ts`** — manages a `sessionStorage` flag
  `cairn.secure-redirect.off` (§9.7).
- Wizards deliberately do **not** use a shared store: each wizard keeps its
  state as local component `$state`, mirrored into `sessionStorage` only for
  resume (§9.4). The in-memory state is authoritative; the snapshot is a
  resume aid only.

There is no Redux/Zustand-style central store; per-page server `load` data
(`$props().data`) plus local runes plus the two small global singletons
above (toast queue, and `page.data.flags`/`page.data.httpsPort` from
`$app/state`) is the whole client state surface.

### Wizards

**Single-sig "add wallet" wizard** — `src/routes/(app)/wallets/new/+page.svelte`.
Three steps: **Key → Verify → Finish** (collapsed from six). Key step: pick
a source (Trezor/Ledger/ColdCard/BitBox02/Jade/Jade-QR/QR/paste) or restore
from a backup file; both "Add a wallet" and "Restore from a backup" entry
points land here. On viewports ≤900px the **Paste public key** method-cell
is reordered first (CSS `order: -1`, scoped to the app's existing mobile
breakpoint) since a keyless beginner on a phone can't plug in USB hardware;
desktop keeps the original device-first card order unchanged (a deliberate
decision, not revisited by the fix below). At common desktop sizes
(1280×800) the seven-card grid still runs past the fold — **Paste public
key**, the one no-hardware-required option and the one the page's own copy
recommends, sits below the viewport with no scroll affordance
(`cairn-coza`). Rather than reorder desktop (against the above decision) or
reflow the grid, the fix is a quiet `.scroll-cue` line ("7 ways to add a key
below, including **Paste public key** — no hardware device needed for that
one.") placed above the method grid, always rendered (not gated behind the
referral `buyUrls` flag the way the old below-grid hint was) — so every
first-time user sees, without scrolling, that a no-hardware path exists
further down. The Key step
renders its own method cards from `./deviceMethods.ts` (`METHOD_CARDS` +
`visibleMethodCards`), which gate each hardware tile on its `hw_*` flag (QR on
`qr_scan`, paste never gated) exactly like `DevicePicker` — turning off e.g.
`hw_trezor` (code-only flag, no admin UI since UX Simplification Wave 2 —
settable via DB/API token only, see §8's flag-disposition note) hides
Trezor here too (cairn-cl13); the
`create` action also `requireFeature`-guards the submitted `deviceType` so a
hand-crafted POST can't bypass a disabled flag. `DevicePicker` itself is used on
the Finish step's "change signing device" sub-flow. Also uses
`_components/deviceRead.ts` for the actual WebUSB/WebHID reads,
`_components/coldcardImport.ts` for ColdCard file parsing,
`_components/multisigDetect.ts` to catch a multisig config — uploaded *or
pasted* (paste path added `cairn-kqjck`, mirrors the file-upload detection,
with a server-side fallback in the `preview` action's catch branch) — and
hand off to the multisig wizard instead. Verify step: shows derived
addresses for the validated xpub (server round-trip via `safeAction`, action
`preview`). Finish step: name the wallet, confirm device, create. Key origin
(`keyFingerprint`/`keyPath`) is captured alongside the xpub — required for
`bip32Derivation` in PSBTs; origin precedence is device-reported >
parsed-from-descriptor.

Resume seam: `_components/wizardProgress.ts`, storage key
`cairn.add-wallet-wizard.v2` (v1→v2 bump when the wizard collapsed to 3
steps). Snapshot: `step (0|1|2)`, `method`, `readMethod`, `deviceType`,
`xpubInput`, `validatedXpub`, `preview[]`, `scriptType`, `name`,
`keyFingerprint`, `keyPath`, `savedAt`. Only ever stores PUBLIC key material
(xpub + derived addresses — same data already in the DOM).
`parseSavedProgress(raw, now)` returns `null` for anything
malformed/stale/unknown-enum (max age 1 hour), clamping `step` back to 0 if
the data required for steps 1/2 is missing. `hasMeaningfulProgress()` gates
whether to even offer a resume prompt.

**Multisig wizard** — `src/routes/(app)/wallets/multisig/new/+page.svelte`.
Four resumable steps: **why → keys → review → confirm** (+ terminal `done`,
never saved). Presets `2of3`/`3of5`/`custom`; vault mode
`collaborative`/`personal`. The keys step's derivation-path caption (e.g.
`m/45'` / personal path) is editable in place via an inline
**Personal/Shared** toggle rather than the old "Change" link, which reset
`vaultMode` to null and dropped the user all the way back to the
personal-vs-collaborative onboarding question — reading as a wizard restart
for what should be a one-field edit (`cairn-8nmr`). Resume seam mirrors the single-sig one:
`_components/wizardProgress.ts`, storage key `cairn.multisig-wizard.v1`,
same 1-hour max age and null-on-malformed contract — **but this is a
genuinely different file with the same exported names** (see §15). Higher
stakes here: each cosigner key can cost a physical hardware ceremony, so
losing 4-of-5 collected keys to a reload is much worse than losing a
single-sig paste. Deliberately does NOT snapshot the in-progress "add one
key" form (picked method, pasted text, typed fingerprint/path) — a device
connection can't survive a reload anyway, so restoring half-entered text
would look like resumable progress that isn't. Phase 1 (sessionStorage,
`cairn.multisig-wizard.v1`) is tab-scoped and covers only a same-tab reload
within the hour; Phase 2 (`cairn-jy3g`) adds a genuinely server-side draft —
`src/lib/server/multisigWizardDrafts.ts` — one `multisig_wizard_drafts` row
per in-progress wizard (plus a `multisig_wizard_draft_keys` child table),
owner-scoped by `user_id` on every read, committed after **every** key
add/remove via the `draftSync` action (not just on exit) so a ceremony that
spans hours/days or hands off to a different device doesn't lose collected
keys. The page's `load()` in `+page.server.ts` resumes via a `?draft=N` query
param — mirroring the send flow's `?tx=N` resume — 404ing if the draft
doesn't exist or belongs to another user (same null-on-mismatch shape as
`getTransaction`); the URL is kept in sync with the live `draftId` so
reloading or reopening the link (email, notes app, another device) picks the
wizard back up. `createMultisig` deletes the draft row on success
(`draftAbandon` on an explicit Start-over). Only PUBLIC key material is ever
stored — same fields the sessionStorage snapshot and page DOM already hold;
no private-key material passes through this flow at all. The quorum-only
opening step (before any key is added) deliberately has no draft row yet and
stays sessionStorage-only by design — there's nothing worth a server
round-trip until the first key lands. `vaultIntent.server.ts`
handles server-side intent/state for the wizard. Also uses its own
`_components/coldcardImport.ts`, `_components/deviceRead.ts` (device read
reused per-wizard, not shared with single-sig's copy). A `custom` quorum
where "keys required" is set above "total keys" (e.g. 3-of-2) is invalid —
the risk panel hides and Continue disables — and a derived `quorumHint`
explains why instead of leaving a silent dead-end: the M>N case gets its own
line, "Keys required can't be more than the total number of keys — lower it,
or add more keys.", while every other invalid range keeps the generic "The
required number must be between 1 and the total, and the total at most 15."
(`cairn-t3za`). `classifyQuorum` itself is untouched — this is messaging
only.

**Discoverability (`cairn-hla1`):** the top-level step bar's "keys" item now carries a
secondary sub-progress fraction (e.g. "2/5", `keysStepSubLabel()` in `wizardProgress.ts`,
null until quorum is chosen) so the Add-keys sub-wizard's real per-cosigner effort is
legible from any step, not only once you're on it — folded into `stepAriaLabel` for
screen readers too. The config-import disclosure on the keys step also now links the
previously-orphaned stateless signer (`/wallets/multisig/stateless` — work from a
config/descriptor directly with nothing saved), as the ephemeral complement to reading a
config into a saved wallet.

**Send flow** — `src/routes/(app)/wallets/[id]/send/+page.svelte`
(single-sig). Five steps: **Create → Review → Sign → Confirm → Sent**
(`StepKey` union). Resumable via a saved `SavedTransaction` row (not
sessionStorage) — `?tx=` query param round-trips the draft id
(`syncTxParam`), and `initialStep()` derives which step to land on from the
saved row's lifecycle (`completed`→Sent, `awaiting_signature`→Confirm if
fully signed else Sign, else Review/`draft`). The Confirm step's primary
button no longer opens a follow-up `Modal` ("Broadcast this transaction?
Once it's broadcast, there is no undo.") on top of the step's own full
`SendReviewCard` summary (amount/recipients/fee already visible) — that was
a genuine double-confirm with no new information in the second dialog. The
`Modal` import and `confirmOpen` state are gone from this page (`cairn-5yz3.1`).
In its place, the primary button now arms a **~5s broadcast grace window**
("Sending in 5s — Cancel / Send now", `BroadcastGraceControl.svelte` +
`broadcastGrace.ts`, `cairn-avzs`, v0.2.28) instead of calling `broadcast()`
immediately: undo beats a warning dialog (manifesto's confirmation-friction
ladder) at the one moment an irreversible action can still genuinely be
undone. Cancel (or navigating away mid-window — the control's `$effect`
cleanup calls `grace.destroy()` on unmount) returns to the idle Confirm
button with the draft, signatures, and step completely untouched — nothing
is broadcast. "Send now" skips the remaining wait and fires immediately. The
underlying state machine (`idle → counting → firing`, or `counting → idle`
on cancel/destroy) guarantees `onFire`/the caller's `broadcast()` runs **at
most once** and never after cancel/destroy — a hard reload or tab close
during the window needs no special handling either, since JS execution
simply stops and the pending `setTimeout` never fires. (Same control is used
on the multisig send page below — the stateless multisig send flow never had
the old double-confirm Modal pattern, just a single inline warning + direct
broadcast, and does not currently use the grace window.) Composes:
`CoinControl`, `RecipientCombobox`,
`GroveField`/`EyebrowBreadcrumb`/`QuorumArc`/`BurialRings`/`BackCircle`/
`AtTipPill` (Heartwood chrome), `Term`/`HowItWorks` (plain-language
scaffolding), per-device signer components
(`ColdCardSigner`, `LedgerSigner`, `TrezorSigner`, `BitboxSigner`,
`JadeUsbSigner`, `QrSigner`, `JadeQrSigner`) selected via
`_components/signMethods.ts` (`deviceSignMethods`). `QrSigner` (generic
BBQr-codec devices: SeedSigner, Foundation, etc.) and `JadeQrSigner` (BC-UR
codec) both now delegate their camera-scan/paste-fallback UI to the shared
`<QrScanner mode="animated">` component instead of each independently
implementing it (~230 duplicated lines apiece before); this also added a
progressive-enhancement torch/flashlight toggle (hidden when
`track.getCapabilities().torch` is unsupported) that neither signer had
before. `QrScanner`'s `mode="single"` (one-shot value scan) is implemented
but **not wired to any page yet** — a future destination-address scan
feeding `parseBip21()` (see §15 gotcha #11) or a wallet-import scan would be
the natural place to use it.
`SecureContextHelp` for the HTTPS-required capability gate. Signing-mass
estimate/UI comes from a `signingMass` module — **verify which one before
touching it** (see §15; there are actually three files named `signingMass`
in the tree: `src/lib/server/bitcoin/signingMass.ts` (server-side),
`src/lib/shared/signingMass.ts`, and
`src/routes/(app)/wallets/[id]/_components/signingMass.ts` — the send page's
import path resolves to the route-local one). Multisig send flow
(`wallets/multisig/[id]/send/+page.svelte`) is the structural counterpart,
using `MultisigFileSigner` instead of the per-hardware-device components
since multisig co-signing here is file/PSBT-based.

**Rendering model (`cairn-97gt`).** The whole step chain is client-mounted, not
server-rendered: the wizard is fully JS/WebUSB/QR-dependent (it cannot advance
without JS), so SSR of its ~40-component subtree had no functional value and cost
~30% of the send GET's synchronous CPU per request. Both send pages gate the step
chain behind `{#if mounted}` (a `$state` flag flipped `true` in `onMount`; `false`
during SSR **and** the initial hydration render, so there is no hydration mismatch)
and render a small `.skeleton` shell in the `{:else}`. `load()` (auth + wallet row
+ streamed `live` data) still runs server-side; only the interactive subtree moves
to the client. Net effect measured with the load harness (`scripts/load-test`,
scenario c): tier-200 throughput 46→70 rps, p50 10s→5.4s. The render was only
~1/3 of the send GET's cost; the dominant residual was the streamed
`loadSendLiveData` live wallet re-scan, addressed next.

**Clean-wallet snapshot fast path (`cairn-g1u2`).** `loadSendLiveData`
(`+page.server.ts`) used to re-scan live on *every* send GET — `getWalletDetail`
+ `getWalletUtxos` → `scanWallet` + `listunspent` — the dominant per-request cost.
It now first calls `sendSnapshot('wallet'|'multisig', id)` (`walletSync.ts`): a
wallet that is **provably clean** serves its spendable coins + balance + tip
straight from the persisted snapshot (`spendableUtxos`, now stored by
`doWalletScan`/`doMultisigScan`), with **no** live scan. `sendSnapshot` returns
non-null — and the fast path engages — **only** when ALL hold, else it falls
through to the live scan exactly as before: the kill-switch
`CAIRN_SYNC_DISABLE_DIRTY_SKIP` is off; the wallet is actively *watched*
(`isWalletWatched`, so a scripthash change would flip it dirty); the snapshot is
CLEAN (`dirty_since IS NULL`, `cairn-wcxw`); it is within `MAX_CLEAN_TTL` (30 min);
and it carries a persisted `spendableUtxos` set (a pre-`cairn-g1u2` row lacks it →
live scan). This is display-only: the build/broadcast path (`buildDraft` /
`buildMultisigDraft`) *always* re-scans live, so a PSBT is never built from
snapshot coins. A successful broadcast calls `markWalletDirty` so the very next
send load re-scans live rather than serving pre-spend coins. `_assembleSendLiveData`
is the single builder both paths share (byte-identical output for the same state).
Measured against a real regtest electrs: a clean wallet's send GET is **2–3 ms**
(snapshot-served) vs **~365 ms** for the same wallet marked dirty (live re-scan) —
fees stay a live call (30 s-cached in the chain layer, cheap in production). NOTE
the sync-SQLite / event-loop mixed-load cliff under high concurrency
(`cairn-qyvl`/`cairn-y802`/`cairn-1q4b`) is a *separate* bottleneck this does not
address; the dead-Electrum load harness (`scripts/load-test`) is dominated by that
saturation (its send scan fails fast on the closed port), so it does not isolate
this fix — the real-electrs latency above does.

The recipient field's invalid-address messaging distinguishes a **shape**
that's simply garbage from one that's a real address on the wrong network:
`addressShape.ts`'s `classifyRecipientAddress()` (`'empty' | 'mainnet' |
'testnet' | 'unknown'`) backs both the single- and batch-recipient message
sites, and a `testnet` classification (tb1…/bcrt1… bech32, or a plausible-
length base58 string starting m/n/2) renders "That looks like a test-network
address — this wallet uses regular Bitcoin (mainnet)." instead of the
generic "That doesn't look like a Bitcoin address yet." for `unknown`
(`cairn-a8n7`). `looksLikeAddress` (used for the combobox's invalid styling
and `canBuild` gating) is unchanged — mainnet-only, `true` iff
`classifyRecipientAddress() === 'mainnet'`.

**Stake-triggered recipient verification (R2, `cairn-l7sv`, v0.2.27).**
`SendReviewCard` (`mode === 'review'` only — never re-asked at Confirm, since
that would be a second exposure to the same check) groups the single-
recipient address into 4-character chunks for display and, when
`recipientVerify.ts`'s `shouldVerifyRecipient()` gate passes, shows a
"verify the last 4 characters" micro-step that must be answered correctly
before the caller's primary CTA unlocks (bindable `recipientVerified` prop —
the card stays presentational and never owns navigation itself). The gate
requires **all** of: a single recipient (`isBatch` is false — batch sends
never trigger, there's no one "the recipient" to spot-check), the address is
**not** in `knownAddresses` (prior completed sends + saved contacts — a
repeat/known payee never re-triggers), and the amount clears a stake floor
— either a flat **100,000 sats** (`STAKE_FLAT_THRESHOLD_SATS`, protects a
still-streaming-in balance too) or **10% of the wallet's own spendable
balance** (`STAKE_BALANCE_FRACTION`, deliberately much lower than R1's 50%
"most of the wallet" bar above — R2 is a recognition aid triggered by
stakes, not a balance-drain warning). The check itself
(`matchesAddressTail`) is case/whitespace-insensitive — a recognition aid
against a wrong-paste, not a strict crypto verification — and resets
(cleared input, cleared "wrong" state) whenever the recipient/amount this
card instance is checking changes (e.g. Back-and-edit then Review again).
Deliberately rare by construction (first-send AND high-stake AND
single-recipient must all hold) rather than tuned after the fact — warnings
habituate within two exposures (F4), so any extra check has to stay
genuinely uncommon to keep working.

**Fee-as-%-of-payment context (R7, `cairn-5k9r`).** `SendReviewCard`'s fee
line now appends `sendCopy.ts`'s `feeContextClause()` — "less than 1% of
this payment" or "about N% of this payment" — anchoring the fee against the
send amount instead of a bare sat figure (F6); it renders nothing for an
unknown/zero/non-positive amount or once the unrounded fee exceeds ~5% of
the payment, so the clause never dresses up a genuinely high fee.

The Create step's amount field (`AmountEntry.svelte`, shared by both the
single-sig and multisig send flows) is a labelled pill that cycles
BTC → sats → USD → BTC via a swap-horizontal glyph on `Icon` — deliberately
not the circular refresh-arrow glyph it replaced, which phone testing showed
users read as "reload" rather than "switch currency" (`cairn-id5o`). Sats
display as an integer with thousands separators. Cycling only re-renders the
input text from the existing canonical value; the amount is always stored in
sats, so switching the displayed unit never recomputes it and can't drift.
Every keystroke is sanitized to numeric-only, in every unit: the sats mode
already stripped to digits, and the BTC/fiat modes now do too, via
`amountInput.ts`'s pure `sanitizeDecimal()` (digits + at most one decimal
point — drops letters, commas, extra dots) and `textToSats()` (parse to
canonical sats, `0` on non-numeric/non-positive input) — previously a paste
like `"0.001hello"` left the letters visible in the field (`cairn-wi8a`). See
§ "Fiat display: Hidden" above for `AmountEntry`'s `fiatVisible` gating
(`cairn-8pl9w`).

**Unit-respecting summary rail (`cairn-v5ass` follow-up to `cairn-nb8e`,
v0.2.39).** The single-sig send page's Confirm-step summary rail
(Amount/Remaining) used to hardcode `${formatBtc(...)} BTC` regardless of the
`$lib/units` `unitPref` the hero `AmountEntry` field itself honors — a sats-
preferring user would enter an amount in sats and then see it summarized back
in BTC. `summaryUnitAmount()` now reads `$unitPref` the same way the hero
field does, so the summary rail agrees with whatever unit the user actually
typed in.

**Remaining unit-drift surfaces closed (`cairn-fbgl1`+`cairn-hgg7t`, fixed
`c299fc3`+`a13d2cd`, v0.2.40).** `Amount.svelte` itself never read
`unitPref` at all — it always rendered a hardcoded `formatBtc(...)+' BTC'`
primary line. A shared `formatUnitAmount(sats, unit, opts)` helper
(`$lib/format.ts`) is now the single source of truth for BTC-vs-sats display
text; `Amount.svelte` reads `$unitPref` through it, which fixes every
surface that renders through `<Amount>` for free: Home's "TOTAL BALANCE"
hero + recent-activity rows, both wallet-detail heroes, and the
single-sig/multisig "In progress" draft rows. Two remaining hardcoded call
sites that bypass `<Amount>` entirely were fixed as a direct follow-up: the
send page's "Verify on device" review card (now calls the page's existing
`summaryUnitAmount()` wrapper around the same helper) and the multisig
wallet-detail pending-balance note (now renders `<Amount>` with
`sign`/`direction` props instead of a hand-rolled `+`/`-` prefix, matching
its single-sig sibling verbatim). `send/+page.svelte`'s own
`summaryUnitAmount` above was refactored to delegate to the same shared
helper too, so the two families of call sites can't drift apart again.

**Unit-slip guards (R1, `cairn-9nvo`, v0.2.27).** A live secondary line under
the amount always keeps the OTHER Bitcoin-denominated unit (and fiat, when a
price is known) visible while typing — e.g. typing in sats shows "≈ 0.0031
BTC · $250.00" beneath — so an amount never exists on screen in only one
unit; the sats↔BTC swap is a 100,000,000x slip, and misreading fiat as BTC
(or vice versa) is a further one. Below that, `amountInput.ts`'s
`isHighSpend(sats, spendableSats)` fires a calm, non-blocking amber note
("That's most of this wallet's balance.") strictly when the typed amount is
**>50% and <100%** of the wallet's spendable balance — deliberately below
(and mutually exclusive with) the pre-existing ≥100% "That's more than this
wallet holds." over-balance line, so the two notes never compete for the
same line. `spendableSats == null` (balance still streaming in) or `<= 0`
never triggers it. Applies to both the hero (Create step, single recipient)
and compact (batch-row) amount fields.

### `safeAction` in the client (§8 has the full server-facing contract)

Current call sites (grep `from '$lib/safeAction'`): **both wizard pages** —
`src/routes/(app)/wallets/new/+page.svelte` (the `preview` action, in
`acceptReadKey()`) and `src/routes/(app)/wallets/multisig/new/+page.svelte`.
Not yet adopted broadly — most forms still use `use:enhance`.

### Hardware-wallet browser signing UX

Client-side HW drivers live in `src/lib/hw/` (NOT under `lib/components` —
pure logic, deliberately kept dependency-free of server code): `trezor.ts`,
`ledger.ts`, `bitbox02.ts`, `jade.ts`, `jadeUr.ts` (Jade's UR/QR variant),
`bbqr.ts` (BBQr animated QR format), `keyOrigin.ts`, `qrScan.ts`, and
`common.ts` — the shared base every driver builds on: `HwError<Code>` (a
typed error base class, subclassed per-driver as `LedgerError`,
`TrezorError`, etc., carrying a `code` so the UI can branch on cause without
string-matching), SLIP-132 xpub version handling
(`normalizeXpub`/`xpubWithVersion`/`SINGLE_SIG_VERSIONS`/`SLIP132_VERSIONS`),
BIP32 path parse/format (`parseKeyPath`/`formatKeyPath`), BIP-48 multisig
account-path derivation (`multisigAccountPathIndexes` — explicitly refuses
to derive fresh legacy P2SH, only P2WSH/P2SH-P2WSH), and single-sig
BIP44/49/84/86 (`singleSigAccountPathIndexes`). This file must stay free of
server imports since it's the shared boundary between browser drivers.

`DevicePicker.svelte` is the reusable device-tile grid: Trezor/Ledger/
ColdCard/BitBox02/Jade/Jade-QR/Air-gapped-QR/Other-file. Each tile can be
hidden by an admin feature flag (`hw_trezor`, `hw_ledger`, etc., read from
`page.data.flags`) **except** `file`, which is the universal, never-gated
fallback — "a wallet is never a dead-end viewer."

**Secure-context gating** (`SecureContextHelp.svelte`, `secureRedirect.ts`):
browsers withhold WebHID/WebUSB/WebSerial (USB signing) and camera access
(QR scan-back) on insecure (plain HTTP) origins — which is Umbrel's default
serving mode. Cairn's fix is to run its own self-signed HTTPS listener
alongside the HTTP one. `SecureContextHelp.svelte` appears only when the
current page is an insecure context AND the server reports the HTTPS
listener's port (`page.data.httpsPort`); it takes a `what` prop naming the
gated capability so the copy reads naturally per host card, and renders an
"Open the secure address" link (`https://{hostname}:{httpsPort}{pathname}
{search}`) plus plain-language guidance about the expected self-signed cert
warning and a note that passkeys **do** work on the self-signed address — it is
the only secure-context surface, so it is the one place a browser will run a
passkey ceremony (WebAuthn's `expectedOrigin` accepts that HTTPS listener origin
via the allowlist in `passkeyOrigin.ts`, cairn-ib7w).
`secureRedirect.ts` is the automatic hop for *returning* users who already
clicked through the cert warning once: a `fetch()` to the HTTPS origin with
`mode:'no-cors'` only resolves if the browser has already accepted that
origin's cert; success ⇒ `window.location.replace()` to the same path on
the secure origin (session cookies ignore port, so auth carries over);
failure ⇒ stay put, `SecureContextHelp` keeps guiding the first-time flow.
Escape hatch: `?insecure=1` sets `cairn.secure-redirect.off` in
sessionStorage to suppress the auto-hop for the rest of the tab's session.
Wizard exception: the hop is also skipped whenever the current path is under
`/wallets/new` or `/wallets/multisig/new`, regardless of cert-acceptance
state — those wizards keep their resume state in origin-scoped
`sessionStorage`, and a cross-origin `replace()` mid-wizard silently wiped it
(`cairn-01gq`); their own device-signing steps already surface
`SecureContextHelp` inline, so the auto-hop had nothing to add there.
Called from both the `(app)` and `(auth)` layouts' `onMount`, never during
SSR. The `(auth)` layout wraps the `location` it passes in with a local
interaction veto: the probe can take up to 2.5s, long enough for someone to
have already started filling in login/signup by the time it resolves, so a
window-level capture-phase `pointerdown` listener (registered at mount,
alongside the existing focusin/input tracking on the auth column) marks the
page "interacted" and the wrapped `replace()` becomes a no-op — preventing
the hop from tearing the page down mid-signup and silently orphaning an
in-flight submit, a "dead button" with no visible cause (`cairn-hmi4`).

### UX philosophy in practice

Concrete mechanisms matching the "plain language, no exposed Bitcoin
internals, guided wizards" philosophy:

- **`Term.svelte`** — inline glossary: technical words get a dotted
  underline and a hover/focus tooltip, a real `<button>` so keyboard users
  get the same affordance as mouse hover. Tip copy is centralized in
  `src/lib/termGlosses.ts` (`DESCRIPTOR_TIP_*`, `ELECTRUM_TIP`,
  `CORE_RPC_TIP`, ...) rather than inlined per call site. **v0.2.41 glosses
  (`cairn-b55a5`, `cairn-s7rpg`):** `STRATUM_TIP` added and wired via
  `<Term>` on `/admin/mining`'s engine-health hint and pool-settings
  form/port label (`AdminEngineHealth.svelte`, `AdminPoolSettingsForm.svelte`
  — the end-user `/mining` page was already plain-language and untouched);
  `TIMECHAIN_TIP` added for the explorer breadcrumb's "The timechain"
  segment, which needed a new optional `tip` prop on `EyebrowBreadcrumb`
  (wired at `explorer/+page.svelte`) since that component previously had no
  `<Term>`-capable slot — the reason `cairn-vxbk`'s original v0.2.38 sweep
  couldn't reach it. **Admin surfaces
  (`cairn-3hwc8`, v0.2.39):** a prior pass (`cairn-vxbk`) glossed jargon
  (`cairn-3hwc8`, v0.2.39):** a prior pass (`cairn-vxbk`) glossed jargon
  app-wide but skipped `src/routes/(app)/admin/**` for a since-resolved
  concurrent edit — `admin/settings` now wraps "Electrum" and "RPC" (in
  "Bitcoin Core RPC") in `<Term>` with `ELECTRUM_TIP`/`CORE_RPC_TIP`. The
  same follow-up also fixed a rename gap left behind by `cairn-vxbk`'s
  Node→Health nav relabel: the admin `+layout.svelte` eyebrow
  (`EyebrowBreadcrumb`, `<svelte:head>` title) still read "Node" while the
  sidebar/nav link already said "Health" — both now say "Health", and the
  overview hero's skeleton/loaded ring-progress line was reworded from "ring
  N forming — N of 2,016 laid" to "difficulty period N forming — N of 2,016
  blocks in" (dropping the burial-ring metaphor from admin copy, consistent
  with the plain-language rule — the visual ring components themselves are
  untouched, copy-only). **UX Phase 4a explorer de-jargon (`cairn-gt05.4`,
  move3/ux-polish):** four new shared glosses in `termGlosses.ts` —
  `SAT_VB_TIP`, `VMB_TIP`, `RING_TIP`, `NO_REORG_TIP` — plus the shared
  **`FeeRate.svelte`** component (`src/lib/components/`, pure logic in
  `feeRate.ts`), the single owner of the "raw sat/vB + plain time" pattern
  ("~1 sat/vB · ≈ next block"), rolled out across explorer index, mempool,
  block, tx, and address surfaces. Explorer user copy now defaults to
  "difficulty period"/"block" with `ring` surviving as the glossed identity
  term; "vMB" → "N MB waiting"; "not one removed" → "every block still
  stands". The explorer's contradictory node-unreachable banner is gone:
  with a populated snapshot it renders one quiet "Showing your last saved
  snapshot" line instead (it reads the same shared node-trust signal as the
  rest of the app).
- **`HowItWorks.svelte`** — collapsible "How does this work?" explainer per
  page, state remembered per page id so a user who dismissed it isn't
  nagged again.
- **Status color rule**: form validation and routine nudges use
  `--attention` (warm tan), never red — red (`--error`) is reserved for
  truly irrecoverable failures (broadcast rejected, invalid PSBT, node
  unreachable). A deliberate "no false alarms" signal-strength discipline.
- **`safeAction`'s error copy** is itself a UX-philosophy artifact: messages
  tell the user what's actually true ("that request was blocked... not your
  key or your connection") rather than defaulting to scary or misleading
  generic text.
- **Wizard resume** exists specifically so an Umbrel auth-layer forced
  reload never destroys user progress — especially costly in the multisig
  wizard where progress can represent physical hardware-device ceremonies
  already performed.
- **`DevicePicker`'s universal fallback** — the philosophy that a wallet
  must never become a dead-end viewer with no way to sign, even if none of
  the explicitly-supported hardware applies.
- **Backup nudges** in the `(app)` layout are tiered by urgency and, as of
  `cairn-gt05.5` (v0.2.39), by a server-persisted **decaying cadence** rather
  than a fixed per-session show: a still-unbacked wallet's amber nudge
  widens its own re-show interval (3d → 10d → 30d → 90d) each time it's
  actually shown, capped so it never re-shows sooner than 72h regardless,
  and escalates back to the tight cadence when the stakes genuinely rise
  (a second unbacked wallet, or an unbacked wallet receiving its first
  funds) — see § "Backup & restore" below for the full mechanism. A
  separately-tracked stale (90-day-old) backup still gets its own softer
  periodic reminder, server-dismissible for 90 days. Proportionate friction
  matched to actual risk, not one generic "backup" nag on every visit.

---

## 10. Client: Heartwood Design System

`src/app.css` is the single global stylesheet, self-described in its header
comment: "Cairn — 'Heartwood' design system (evergreen identity,
docs/DESIGN-MANIFESTO.md). Evergreen ink, warm ivory serif numerals, slate
signal-blue accent, growth rendered as concentric rings. Grammar: hairlines
not boxes, pills not cards, depth from luminance stacking — not glow."
Reading that comment (and `docs/DESIGN-MANIFESTO.md` itself — the canonical
visual-doctrine source; where a component disagrees with the manifesto, the
component is wrong) is the fastest way to internalize the visual language
before touching any component. This supersedes the earlier v0.1.9 "copper"
identity (warm-brown base, copper-orange accent, Source Serif 4) — the
**evergreen identity** (epic cairn-sdx5) below is current.

Theming is CSS custom properties on `:root`, **app-wide light mode shipped**
(cairn-sdx5.7): dark is still the default (`color-scheme: dark` on `:root`),
but a `light` block (mirrored under both `@media (prefers-color-scheme:
light)` and an explicit `:root[data-theme='light']` override) supplies a
parchment-toned equivalent for every token below. Settings → Display exposes
a three-way **System / Dark / Light** choice, persisted to `localStorage` as
`hw.theme` (`'dark' | 'light'`, absent/`'system'` = honor the OS via
`prefers-color-scheme`) and applied via `data-theme` on `<html>` with no page
reload. `src/app.html` carries a synchronous pre-paint inline script that
reads `hw.theme` and sets `data-theme` before the stylesheet paints, so there
is no flash of the wrong theme — guarded by
`src/lib/themeBootstrap.test.ts`.

| Group | Variables | Notes |
|---|---|---|
| Surfaces | `--bg` (#0e1312, evergreen-ink), `--bg-deep`, `--bg-input`, `--bg-strip` | legacy tiers `--surface`/`--surface-elevated` kept only for not-yet-reskinned cards — new work uses `--bg-input` fills + hairline rows instead of boxed cards; light-mode equivalents are a warm parchment base, not an inverted dark palette |
| Borders | `--border`, `--border-subtle`, `--hairline`, `--border-control`, `--border-ghost` | `--hairline` = the 1px row separators that give the "hairlines not boxes" grammar its name |
| Text | `--text`, `--text-hero`, `--text-rows`, `--text-secondary`, `--text-muted`, `--text-faint` | `--text-faint` is **explicitly documented as failing AA contrast by design** — decorative/disabled only, never informative copy |
| Breadcrumb | `--eyebrow`/`--eyebrow-path` | used by `EyebrowBreadcrumb` |
| Accent | `--accent` (#6796c9, slate signal-blue family: hover/pressed/bright/glow/glow-strong/core), `--accent-dim`/`--accent-dim-2`, `--accent-muted`, `--accent-border`/`--accent-border-strong`, `--on-accent`/`--on-accent-ghost` | the manifesto's deliberate resolution of the "Heartwood green" ambiguity: **slate-blue is the accent** (the one thing you can act on); **green is reserved for growth/success semantics only** (`--sage`), never used as the interactive accent |
| Status | `--sage` (success/received/connected/valid/growth), `--attention` (warm tan — nudges AND form validation), `--caution`/`--caution-muted`/`--caution-border` (burnt-orange — sits between `--attention` and `--error`; backs the multisig quorum-risk panel's salmon "Loose" tier so it reads as its own tier distinct from the red "Risky" one, not just a bolder border on the same red), `--error`/`--danger` (red) | "never red for routine states"; red is reserved for irrecoverable failures only — an explicitly-called-out "off-spec extension: Heartwood has no red" otherwise |
| Typography | `--font-ui` (Inter), `--font-serif` (Fraunces Variable, optical size ~440 weight for `.hero-number` — deliberately lighter than the spec's locked 56/600, which reads too heavy on a variable display serif for one calm numeral; falls back to Source Serif 4 / Georgia), `--font-mono` | the "serif living balance" branding element — no other finance product sets a live balance in an editorial serif |
| Radii | `--radius-pill` (26px), `--radius-toggle`, `--radius-status-pill`, `--radius-icon-btn`, `--radius-badge`, `--radius-strip` | pill-first; legacy `--radius-card`/`--radius-control`/`--radius-chip` kept as literal fallbacks for unreskinned components |
| Motion | `hwPulse`, `hwBlink`, `hwSweepOnce`, `hwGrow`, `hwShimmer`, `hwSpin`, `hwBreathe` | raw `@keyframes` primitives; components set their own duration/timing at the call site; all neutralized under `@media (prefers-reduced-motion: reduce)`; growth/confirmation motion is deliberately **growth-only** (rings fill, nothing recoils) |

Shared utility classes: `.btn`/`.btn-primary`/`.btn-secondary`/`.btn-ghost`/
`.btn-danger`/`.btn-sm` (decorative button contents like a loading spinner
get `pointer-events: none` specifically so a spinner-swap mid-click can't
eat a click — a documented real bug fix), `.field`/`.label`/`.input`/
`.select`/`.hint`/`.form-error` (form kit), `.badge-*` variants, `.table`/
`.table-wrap` (with scroll-shadow gradients for horizontally-scrolling
tables), `.empty-state`, `.skeleton` (shimmer loading), `.spinner`,
`.card`/`.card-pad`/`.card-title`, `.stack`/`.row`/`.grow` layout helpers,
`.hero-number`/`.mono`/`.overline`/`.page-title`/`.tabular`/`.truncate` text
helpers, `.fade-in` (260ms translateY entrance).

The `heartwood/` component directory (§9) implements the bespoke visual
motifs referenced by name in the header comment — `GroveField` (ambient
background), `BurialRings`/`RingStub`/`QuorumArc`/`EpochDial` (ring/arc
motifs, tied to the "growth rings" branding and multisig quorum
visualization), `HeartwoodMark` (the logo).

**Working rules for anyone touching UI:**
- Prefer hairline rows over boxed cards for new work; only fall back to
  `.card`/`--surface` tiers for a component that hasn't been reskinned yet.
- Never use `--text-faint` for copy that conveys information.
- Never reach for red (`--error`/`--danger`) for a routine validation state
  — that's `--attention`'s job. Red means "this genuinely failed and can't
  be silently retried."
- Green is the growth/success semantic (`--sage`) only — never repurpose it
  as an interactive accent; that's `--accent` (slate-blue)'s job.
- Both dark and light now need to be kept in sync for any new/changed
  token — `color-scheme: dark` is no longer hardcoded, so a token added only
  to `:root` without a `light`-block counterpart will look designed in dark
  and wrong in light.
- Canvas-drawn motifs (`BurialRings`/`RingStub`/`QuorumArc`/`EpochDial` and
  similar `<canvas>`-based components) read their colors at draw time, not
  via live CSS variable inheritance — a known open gap (`cairn-w0ee`) is that
  some of these were not yet audited for redrawing correctly on a live theme
  switch. Check on any new canvas motif; don't assume it Just Works with the
  System/Dark/Light toggle.
- `docs/DESIGN-MANIFESTO.md` is the canonical visual-doctrine source (color,
  type, layout, interaction, the money-behavior MUST rules) — read it before
  any UI work, and treat a component that disagrees with it as the bug.

---

## 11. Bitcoin Concepts You Must Know

This section stays anchored to what Cairn actually implements and where —
it's not a general Bitcoin primer. If you already know BIP-32/44/49/84/174,
skip to the Cairn-specific parts (address-type support matrix, the p2tr dead
end, and the PSBT lifecycle).

### Address types & the p2tr dead end

Cairn's single-sig wallets support three address/script types for both
derivation and spending:

| Script type | BIP | Derivation | Spending |
|---|---|---|---|
| p2pkh (legacy) | BIP-44 | `xpub.ts` `deriveAddress()` | `psbt.ts` `INPUT_VSIZE.p2pkh = 148` |
| p2sh-p2wpkh (nested segwit) | BIP-49 | supported | `INPUT_VSIZE['p2sh-p2wpkh'] = 91` |
| p2wpkh (native segwit) | BIP-84 | supported | `INPUT_VSIZE.p2wpkh = 68` |
| p2tr (taproot) | BIP-86 | **not implemented** | **not implemented** |

**p2tr is a fully-typed dead end today, not a missing feature.** `ScriptType`
(`src/lib/types.ts:22`) lists `p2tr` as a value, UI copy
(`src/lib/bitcoin.ts`) describes it ("Taproot", `bc1p…`), and BitBox02's
driver can even read a taproot account key from the device — but:
- **Wallet creation is hard-rejected**: `src/lib/server/wallets.ts`'s
  `assertDerivationMatchesPrefix()` throws `"Taproot wallets aren't supported
  yet..."` for any BIP-86 derivation path.
- **Spending has no vsize entry**: `psbt.ts`'s `INPUT_VSIZE` table has no
  `p2tr` key, so `constructPsbt` throws `'Spending from p2tr wallets is not
  supported yet.'` if it were ever reached.
- **Derivation has no branch**: `xpub.ts`'s `deriveAddress()` has no p2tr
  case at all (throws `Unsupported script type`).
- `addressToScriptPubKey()`/`isValidAddress()` **do** understand bech32m/p2tr
  encoding generically (segwit v1, 32-byte program) — so a p2tr address is a
  perfectly valid **recipient** address, it just can't be a wallet's own
  derived address.

Multisig taproot (`tr()` descriptors) is **separately** rejected, for a
different reason: no mature, interoperable MuSig2 (key-path) or FROST
(script-path) tooling exists yet. Don't conflate the two rejections when
debugging — they're independent decisions with independent code paths.

### Single-sig derivation

`src/lib/server/bitcoin/xpub.ts`'s `parseXpub()` accepts xpub/ypub/zpub
(SLIP-132 version bytes), normalizes to standard xpub bytes, and always
rejects private keys. Prefix validation is network-aware (`cairn-10ox`):
`parseXpub(input, network)` accepts mainnet OR testnet/regtest SLIP-132
bytes (tpub/upub/vpub) depending on the network argument, defaulting to
whatever `chain_network` is currently configured (`setDefaultNetwork()`,
resynced on every `ChainService` construction/reconfigure) — so a
regtest/testnet operator can import their own signer's exported keys, while
a mainnet-configured instance still rejects testnet/regtest prefixes
symmetrically.

**Address ENCODING is now network-aware too (`cairn-xqnn7`+`cairn-czm9p`,
`eaaf0b2`+`9c43b53`, v0.2.40 headline).** Before this fix, `deriveAddress`/
`addressToScriptPubKey`/`isValidAddress`/`scriptPubKeyHex`/
`addressToScripthash` (and the multisig equivalents in `multisig.ts`)
always encoded/validated against **mainnet** regardless of `chain_network`
— a regtest/testnet instance rendered unusable `bc1…` receive addresses and
rejected legitimate same-network send destinations, and `constructPsbt`/
`constructMultisigPsbt` (`psbt.ts`/`multisigPsbt.ts`) built every output via
`@scure/btc-signer`'s hardcoded mainnet `NETWORK` constant even after
validation had been made network-aware, so a regtest/testnet send could
pass pre-flight and still fail downstream in construction. Both are now
threaded through the same `networkParams(network ?? getDefaultNetwork())`
resolution, matching prefix validation's existing default. A recognized
address for the WRONG network throws a plain-language network-mismatch
error instead of a generic "invalid"/"unknown version byte" message.
`summarizePsbt`/`addressFromScript` are network-aware too, so resuming a
regtest/testnet draft renders `bcrt1…`/`tb1…` addresses instead of silently
re-encoding them as mainnet. Net effect: a regtest/testnet Cairn instance
now has full first-class GUI send/receive/import/scan support — see §16.5
for the (now obsolete) old funding workaround. HW
drivers (`src/lib/hw/common.ts`) implement single-sig BIP-44/49/
84 account-path derivation (`singleSigAccountPathIndexes`) and read the
account xpub + master fingerprint at connect time, both required for
embedding `bip32Derivation` in constructed PSBTs so hardware signers can
find and verify their own key.

### Multisig: descriptors, `sortedmulti`, BIP-48, Caravan

Multisig wallets always use `sortedmulti` (BIP-67 — the address is a
function of the key **set**, not order; cosigner order never matters
anywhere in Cairn). Three script forms are supported:

| Form | Descriptor | BIP-48 suffix |
|---|---|---|
| p2wsh (default) | `wsh(sortedmulti(...))` | `2'` |
| p2sh-p2wsh | `sh(wsh(sortedmulti(...)))` | `1'` |
| p2sh (legacy) | `sh(sortedmulti(...))` | none — ecosystem convention is BIP-45 `m/45'`; Trezor's own `m/48'/0'/account'/0'` extension is also tolerated |

`tr()` (taproot multisig) is rejected by name. Descriptor import/export
(`multisigToDescriptor()`/`parseDescriptor()` in
`src/lib/server/bitcoin/multisig.ts`) is byte-compatible with Bastion's
format (`[fp/48h/0h/0h/2h]xpub/0/*`, lowercase fingerprint, `h`-hardened).
The BIP-380 checksum is a hand-ported `descriptorChecksum()` verified
against published test vectors.

**Caravan/Unchained format** is Cairn's chosen multisig interchange
standard (`src/lib/server/multisigExport.ts`). `caravanExport()` /
`parseCaravanImport()` round-trip Caravan wallet-config JSON byte-for-byte
on the JSON shape itself, including the receive descriptor's own BIP-380
checksum as `uuid` (omitting it triggers Caravan's own "undefined"
re-export bug) and the multisig's live receive cursor as
`startingAddressIndex` (so a backup→restore round-trip resumes issuing
fresh addresses instead of reusing index 0). **Caveat (`cairn-o7zy`,
open):** "lossless" describes the JSON round-trip, not necessarily the key
*paths* it encodes — export masks an unknown-origin key to a fabricated
`m/0/0/0/0` for Caravan compatibility, and import reads that literally with
no recognition of the masking. Round-tripping Cairn's own export of an
unknown-origin key can silently turn it into a concrete (and wrong) path.
A byte-identical re-exported JSON can still hide semantic path corruption
underneath — don't treat JSON-diff-clean as proof the underlying key
provenance survived the round-trip.
`coldcardRegistration()` produces the ColdCard multisig setup-file format
(also read by Passport/Keystone/SeedSigner).

### PSBT lifecycle: construct → review → sign → finalize → broadcast

This is the spine of every send in Cairn, single-sig or multisig (see §5 for
the full data-flow and code references):

1. **Construct** — `constructPsbt()` (single-sig) or
   `constructMultisigPsbt()` (multisig) builds an unsigned PSBT from live
   Electrum UTXO data, BIP-69-ordered, with `RBF_SEQUENCE` set on every
   input and `bip32Derivation` embedded so external signers can find their
   key.
2. **Review** — the client renders a summary (`summarizePsbt`) of
   recipients, fee, and change before the user ever touches a signing
   device.
3. **Sign** — external only. A hardware driver (`src/lib/hw/*`) or an
   air-gapped file/QR round-trip returns a signed (or partially-signed, for
   multisig) PSBT. Cairn never has the private key at any point in this
   step.
4. **Commitment-check** — `assertSameTransaction(draft, signed)` refuses a
   returned PSBT whose inputs or outputs don't match the reviewed draft
   (§1 invariant 2).
5. **Finalize** — `finalizePsbt()` turns the signed PSBT into raw
   transaction hex plus a locally, deterministically computed txid.
6. **Broadcast** — `chain.electrum.broadcast(rawHex)`, with duplicate-
   broadcast and atomic-claim guards (§5), and a post-broadcast check that
   Electrum's reported txid matches the one Cairn itself computed.

### Hardware integration — the practical shape

Every driver in `src/lib/hw/` implements the same rough contract: read an
account xpub + master fingerprint at connect time, later sign a PSBT and
either merge signatures back (Trezor/Ledger/Jade) or receive a fully-signed
PSBT directly (BitBox02 — the outlier). Two different devices solve "the
device must approve a multisig wallet policy once" with **opposite**
persistence models:

| Device | Registration persists | Mechanism |
|---|---|---|
| BitBox02 | On the device only | `maybeRegisterMultisig()` checks `btcIsScriptConfigRegistered()`; a browser-data wipe just re-triggers the one-time on-device approval |
| Ledger | Server-side | `ledger_multisig_registrations` table stores the BIP-388 wallet-policy HMAC per (multisig, device fingerprint); `UNIQUE(multisig_id, master_fp)` |

Capability probes (`isTrezorConnectAvailable`, `isWebHidAvailable`,
`isBitbox02Available` + `bitbox02SupportsScriptType`,
`isWebSerialAvailable`) gate which device tiles are actually clickable —
a failing probe leaves the tile visible with `available: false` and an
explanatory `unavailableReason`, never a silent disappearance. Every real
device round-trip in `bitbox02.ts` is raced against a 45s timeout
(`withDeviceTimeout`) so a frozen device can't hang the UI forever.

---

## 12. Configuration & Environment Variables

No `.env.example` file exists in the repo — the authoritative source for
env vars is the code itself, cross-checked against README.md (current for
adapter-node-standard vars) and `docs/PUBLISH-PLAN.md` §6 (partially stale —
predates the HTTPS listener and `PROTOCOL_HEADER`/`HOST_HEADER`, see §15).
The table below is built from source, not from either doc alone.

### Core server / adapter-node vars

| Var | Default | Notes |
|---|---|---|
| `PORT` | 3000 | HTTP listen port, read in `server.mjs` |
| `HOST` | `0.0.0.0` | listen host |
| `ADDRESS_HEADER` | unset | header trusted for client IP (e.g. `x-forwarded-for`). Deliberately **not** baked into the Dockerfile — adapter-node's `getClientAddress()` throws if the configured header is absent, which 500'd login on unproxied deployments. Only set when a reverse proxy actually sets/overwrites the header (Umbrel's `app_proxy` does) |
| `PROTOCOL_HEADER` | unset, but `server.mjs` defaults it to `x-forwarded-proto` whenever both this and `ORIGIN` are unset | e.g. `x-forwarded-proto` — the **CSRF/cookie fix** for running behind a plain-HTTP reverse proxy (SvelteKit assumes https by default, marking the session cookie `Secure`, which browsers drop over http, and failing form-POST CSRF checks). For direct/unproxied deployments, `server.mjs` (`scripts/serverProto.mjs`) fills this header per-listener with that listener's own protocol whenever a request arrives without one — fill-when-absent, never overwrites a value a reverse proxy already set (`cairn-wrph`/`cairn-9njl`, §7 Sessions) |
| `HOST_HEADER` | unset | e.g. `x-forwarded-host` — paired with `PROTOCOL_HEADER` so SvelteKit derives the right origin |
| `ORIGIN` | unset | fixed public origin (e.g. `http://192.168.1.20:3000`) for no-proxy deployments |
| `BODY_SIZE_LIMIT` | `200K` (Dockerfile) | adapter-node's own default is a silent 512K that 400s oversized requests invisibly; sized against a measured worst-case multisig PSBT (~85KB) with ~2.3x headroom |
| `NODE_ENV` | `production` (Dockerfile) | |

### Cairn-specific vars (all read via `$env/dynamic/private`)

| Var | Default | Notes |
|---|---|---|
| `CAIRN_DB` / `HEARTWOOD_DB` (alias, checked first) | `./data/cairn.db` dev, `/data/cairn.db` Docker | SQLite file path — `db.ts:16-17` |
| `CAIRN_LOG_FILE` / `HEARTWOOD_LOG_FILE` (alias, checked first) | `./data/logs/cairn.log` dev, `/data/logs/cairn.log` Docker | rotating log file path — `logger.ts:48-58`. Without the explicit Docker `ENV`, `process.cwd()` in the container is `/app`, so the log would escape the `/data` volume and get wiped on every container recreate — a real bug this fixes |
| `CAIRN_LOG_TO_FILE` | `true` | set `false` for stdout-only logging |
| `CAIRN_LOG_MAX_SIZE` | 10 MiB | rotation threshold for the custom `RotatingFileStream` |
| `CAIRN_LOG_MAX_FILES` | 5 | rotation retention |
| `LOG_LEVEL` | `debug` dev / `info` prod / `silent` vitest | `error\|warn\|info\|debug` |
| `CAIRN_ORIGIN` | unset (falls back to request origin) | absolute origin used in notification email links, and the base of the WebAuthn `expectedOrigin` allowlist (`passkeyOrigin.ts` also admits the `https://<host>:CAIRN_HTTPS_EXTERNAL_PORT` listener variant, cairn-ib7w); Umbrel sets `http://${DEVICE_DOMAIN_NAME}:3211` |
| `CAIRN_RP_ID` | unset (derives from request) | WebAuthn RP ID override |
| `CAIRN_AUTH_MODE` | `password` | leave unset for Umbrel — password mode is required there |
| `CAIRN_ADMIN_EMAIL` | `admin@cairn.local` | first-boot admin bootstrap email |
| `CAIRN_ADMIN_PASSWORD` (alias: legacy `APP_PASSWORD`) | unset | first-boot admin bootstrap via `bootstrapAdminFromEnv()`; the created account is flagged `must_reset_password`, which is what makes it safe for Umbrel to interpolate its own derived `${APP_PASSWORD}` here |
| `CAIRN_ADMIN_RECOVERY` | `false` | must be `true` to enable the break-glass admin-password login path at all |
| `CAIRN_HTTPS_PORT` | unset (off) | enables the second self-signed-TLS listener in `server.mjs`; baked to `3443` in the Dockerfile. Set to `""` to explicitly disable |
| `CAIRN_TLS_DIR` | `<dirname(CAIRN_DB)>/tls`, else `./data/tls` | where `key.pem`/`cert.pem` persist |
| `CAIRN_HTTPS_EXTERNAL_PORT` | unset | the host-visible port to advertise in the UI when Docker port-maps the HTTPS port to something other than `CAIRN_HTTPS_PORT` (Umbrel maps host `4488` → container `3443`). Read by the app, not `server.mjs` |
| `CAIRN_ELECTRUM_HOST` / `CAIRN_ELECTRUM_PORT` / `CAIRN_ELECTRUM_TLS` | unset | chain-backend zero-config seeding (`chainEnvSeed.ts`), **seed-once-if-unset, non-destructive forever** — see below |
| `CAIRN_CORE_RPC_URL` / `CAIRN_CORE_RPC_USER` / `CAIRN_CORE_RPC_PASS` | unset | same seeding contract; `core_rpc_pass` goes through the encrypted `setSecretSetting()` path, never plaintext |
| `CAIRN_PLATFORM` | unset | set to `umbrel` by the store package compose only; gates `probeAndSeedUmbrelElectrum()` (Wave A auto-connect probe, `umbrelProbe.ts`) so `10.21.21.x` is never dialed on a non-Umbrel deployment — see `docs/UMBREL-AUTOCONNECT-DESIGN.md` |
| `VAULT_E2E` | unset | test-only, gates the live-regtest E2E suite (§13) |

### Settings stored in DB vs env — the boundary that matters

**No env var configures the Electrum/chain backend directly at runtime** —
that's a live-editable setting in the `settings` SQLite table
(`src/lib/server/settings.ts`), changeable from `/settings`'s admin Node-
connection group with no restart. The `CAIRN_ELECTRUM_*`/`CAIRN_CORE_RPC_*` env vars only *seed* that
table on first boot: each one is written into `settings` only if that
setting has never been stored before, so a restart never clobbers an
admin's later manual edit. If none of them are set (and the Wave A probe
below also finds nothing), Cairn boots against public defaults
(`electrum.blockstream.info:50002`) with zero required external config —
satisfying Umbrel's "must come up before user configures anything" rule.
Admin bootstrap email/password follow the same one-time-seed pattern, not
read on every boot.

On Umbrel specifically, even without any `CAIRN_ELECTRUM_*` env var set (no
manifest `dependencies:` declared), `probeAndSeedUmbrelElectrum()` (Wave A,
`umbrelProbe.ts`) still tries a direct credential-free Electrum handshake
against Umbrel's fixed Docker-network IPs — electrs at `10.21.21.10:50001`,
then Fulcrum at `10.21.21.200:50002` — since every Umbrel app shares the
`umbrel_main_network` bridge regardless of declared dependencies. Same
seed-once-if-unset, non-destructive, never-throws contract; see
`docs/UMBREL-AUTOCONNECT-DESIGN.md` for the full design. The `settings` row
`chain_provisioned_by` records which mechanism (if either) auto-connected
this instance (`'umbrel-env'` / `'umbrel-probe'` / `null`) — informational
only, drives the settings-page card, never changes which connection is
active.

**`chain_network` (`cairn-10ox`, admin UI added in `cairn-x6pr`)** is a
`mainnet`/`testnet`/`regtest` setting (`InstanceSettings.chainNetwork`, default `mainnet`)
that records which network the *custom* Electrum/Core RPC backend is actually on —
threaded through `getChainConfig().network` and gating `parseXpub()`'s prefix validation
(see §"Single-sig derivation"). Always forced back to `mainnet` in `'public'` connection
mode, since the public default server is always mainnet. Settable via `PUT
/api/admin/settings` (`chainNetwork` key) or the `/settings` admin form UI: a "Network"
selector (Mainnet/Testnet/Regtest) rendered inside the "Custom" connection-mode fields
only — it's hidden whenever `'Public servers'` is selected, since the setting is ignored
there, and the public radio card's description says as much ("always mainnet"), rendered
inside `/settings`'s admin Node-connection group (`#node-connection`) since the UX
Simplification merge. The
selector carries a one-line caution that changing the network changes which keys and
addresses are valid. Saving it (like every other field on this form) calls
`reconfigureChain()`, which re-reads `getChainConfig()` and re-syncs `parseXpub()`'s
default network via `setDefaultNetwork()` immediately — no restart needed.

**Bitcoin Core RPC settings are saved independently of `connection_mode`.**
`core_rpc_url`/`core_rpc_user`/`core_rpc_pass` have no relationship to the
Electrum `connection_mode` toggle — `getChainConfig()` returns `coreRpc*` in
both `'public'` and `'custom'` modes, since Core is "configured" purely by
whether `core_rpc_url` is set. `/settings`'s admin `save` form action
(`src/routes/(app)/settings/+page.server.ts` — moved from the deleted
`src/routes/(app)/admin/settings/+page.server.ts`, spec §4) and the JSON
endpoint (`src/routes/api/admin/settings/+server.ts`, unchanged) both write these three keys
whenever the submitted payload includes them, regardless of `connection_mode`
— a field **absent** from the payload always means "leave the stored value
unchanged," never "clear it" (a field present-but-empty is a deliberate
clear; a blank-but-present `coreRpcPass` is the existing "keep the stored
secret" convention, since the secret is never echoed back to the form). Prior
to cairn-6uok this was only true of the JSON endpoint — the form action wrote
`core_rpc_*` solely inside the `connectionMode === 'custom'` block, so a
`'public'`-mode submission that included Core RPC fields (e.g. the Umbrel
Wave B assisted-connect flow, `docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md`) was
silently dropped, never persisted.

**The Node-connection UI (now in `/settings`, formerly `/admin/settings`)
matches that backend contract too (`cairn-3p9z`, swept into `03879a0`).**
The Bitcoin Core RPC subgroup used to be nested inside the same `connectionMode === 'custom'`
conditional as the manual Electrum fields, so a `'public'`-mode admin had no
way to even reach the Core RPC inputs without first flipping to custom mode
— cosmetic by then, since the backend already accepted and persisted those
fields mode-independently since cairn-6uok, but confusing, and the reason
`useDetectedCoreNode()` used to force-flip the mode radio (see the
assisted-connect card note below). The subgroup now renders unconditionally
regardless of `connectionMode`, with its hint copy updated to say the Core
connection "works whether you're on public servers or a custom Electrum
server above."

**The assisted-connect card has its own validated, non-mode-mutating save
path (cairn-6uok follow-up cairn-3p9z).** When `!coreRpcConfigured() &&
coreRpcDetected === 'umbrel'`, `+page.svelte` renders a card (design doc §9
state 3) that posts to the same `save` action with a hidden
`coreRpcAssisted=umbrel` marker. That marker sends the action down a
dedicated early-return branch, *before* `registrationMode`/`connectionMode`/
`electrumPoolSize`/etc are even read — so this path can never mutate
`connection_mode` as a side effect of connecting Core, unlike the old
`useDetectedCoreNode()` client workaround it replaces (which force-flipped
the mode radio to `'custom'` purely so the manual Core RPC inputs would
render). It also runs `testCoreRpc()` and persists nothing if the test fails
(`fail(400, { coreRpcTest })`), unlike the general `save` path, which never
pre-validates. On success it stamps the post-connect provenance marker
`core_rpc_provisioned_by = 'umbrel-detect'` (distinct from Electrum's
`chain_provisioned_by`; see the table in the design doc §6) so the card can
render "Connected to your Umbrel's Bitcoin Core" afterward. A **Dismiss**
button on the same card posts to the separate `dismissCoreDetection` action,
which writes `core_rpc_detected = 'dismissed'` — a purely cosmetic marker
(never consulted by `getChainConfig()`) that just stops the card from
rendering, covering the design doc §8 "Core uninstalled later" stale-banner
case.

### Test-only env vars

`src/tests/setup.ts` always points `CAIRN_DB` at a fresh temp-file DB per
test run and defaults `CAIRN_ORIGIN` to `https://cairn.test`.
`src/tests/env-stub.ts` is aliased over `$env/dynamic/private` in
`vitest.config.ts` so server modules can import the SvelteKit env module
under Vitest. `VAULT_E2E=1` gates `src/lib/server/bitcoin/
vaultRegtestE2E.test.ts` — inert otherwise, so normal `npm test`/CI never
touches a live regtest node.

---

## 13. Running Locally, Tests & CI

`package.json` (name `heartwood`, version `0.2.13`,
`"engines": { "node": ">=22.5" }` — required because it uses the built-in
`node:sqlite` module).

### Scripts

| Command | What it runs |
|---|---|
| `npm run dev` | `vite dev` (default port 5173, or `$PORT`) |
| `npm run build` | `vite build` |
| `npm run preview` | `vite preview` |
| `npm start` | `node server.mjs` (production entry — see below) |
| `npm run prepare` | `svelte-kit sync \|\| echo ''` |
| `npm test` | `vitest run` |
| `npm run check` / `check:watch` | `svelte-kit sync && svelte-check` |
| `npm run qa:prod-boot` | `node scripts/qa/prod-boot-smoke.mjs` — build + boot `server.mjs` + liveness gate |
| `npm run qa:route-crawl` | `node scripts/qa/route-crawl.mjs` — see durable QA gates below |
| `npm run qa:notif-deeplink` | `node scripts/qa/notif-deeplink.mjs` — see durable QA gates below |

### `vite.config.ts` gotchas (both explicitly documented in comments — do not "fix" either)

- **`build.target: 'esnext'` must stay.** bitbox-api's WASM glue uses
  top-level await; every browser Cairn runs in already supports native TLA
  (hardware signing needs WebUSB/WebHID, an even higher floor anyway). This
  also sidesteps `vite-plugin-top-level-await`'s esbuild re-transform of
  rolldown output, which **breaks the production build** — the plugin is
  still listed in `devDependencies` but must not be re-added to the plugins
  array.
- **`optimizeDeps.include`** pre-bundles the entire Ledger + Trezor +
  scure/btc-signer dependency graph up front, because it's only reachable
  via dynamic `import()` behind hardware-signer buttons; without this,
  Vite's mid-session re-optimization kills the in-flight dynamic import with
  a 504 "Outdated Optimize Dep"/"Failed to fetch dynamically imported
  module" error. `bitbox-api` is explicitly excluded from prebundling since
  it's WASM and handled by `vite-plugin-wasm` instead.
- **SvelteKit `csp: { mode: 'auto' }`** is required because SvelteKit
  injects a per-response inline hydration bootstrap `<script>` with dynamic
  content, so no fixed hash can allow-list it; `'auto'` mode stamps a
  nonce/hash per-response. The same directive list is duplicated as a
  fallback `CSP` constant in `src/hooks.server.ts` for responses that never
  go through the page-render pipeline (assets, `+server.ts` endpoints) —
  **keep both in sync if changed.**

### `vitest.config.ts`

Two `test.projects` entries (`cairn-et5a0`, see §13 Tests below for the
full rationale): a `node` project (`$lib`/`$env/dynamic/private` aliases,
`include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs']`,
`setupFiles: ['src/tests/setup.ts']`) and a `dom` project
(`include: ['src/**/*.dom.test.ts']`, `environment: 'jsdom'`, real Svelte
compiler + `conditions: ['browser']`) for component-mount tests.

### Custom production server: `server.mjs`

Not `node build` (adapter-node's own server) — Cairn needs a second TLS
listener adapter-node doesn't provide. Responsibilities, top to bottom:

1. Installs a boot-phase `uncaughtException`/`unhandledRejection` guard
   (console.error only, since `$lib` isn't resolvable yet) — superseded once
   `src/hooks.server.ts`'s real logger-backed guard registers later in
   boot. Only fires in `node server.mjs` mode; `vite dev`/`vite preview`
   rely solely on `hooks.server.ts`'s guard.
2. Binds **both** the HTTP and (if `CAIRN_HTTPS_PORT` set) HTTPS listeners
   immediately with a self-refreshing 503 "still starting" placeholder page
   — this exists because Docker starts forwarding the published host port
   the instant the container starts, and every second before something
   binds shows the browser `ERR_EMPTY_RESPONSE`. Importing the SvelteKit
   bundle (DB open, migrations, Electrum pool) is comparatively slow, so it
   happens *after* the ports are already listening.
3. A custom NDJSON access-log wrapper (`withAccessLog`) sits in front of
   both listeners and is the **only** place that sees status codes for
   pre-`resolve()` failures (framework CSRF 403s, adapter-node's body-limit
   400, the boot-phase 503) — these never reach `hooks.server.ts`'s
   `httpLog`. Deliberately narrow logging policy: always logs status ≥400
   and aborted connections; only logs successes slower than 1000ms; never
   logs healthy `/api/health` polls or static assets; redacts txids/
   addresses in paths; never logs client IP.
4. Dynamically imports `./build/handler.js` (adapter-node's own build
   output) and swaps it in for the placeholder once ready; a throw during
   that import is caught, logged as a structured `{tag:'boot'}` line, and
   exits non-zero (rather than an unstructured Node crash or an eternally
   stuck placeholder).
5. Graceful shutdown on SIGINT/SIGTERM, with a 10s hard-exit fallback for
   lingering keep-alive sockets.

### Self-signed TLS: `scripts/tls-cert.mjs`

Standalone module (node builtins + `selfsigned` only, no `src/` imports —
loaded by `server.mjs` before Vite/SvelteKit resolution exists). Exports
`ensureCert(dir, hosts)`: persists `key.pem`/`cert.pem` under `CAIRN_TLS_DIR`
(default `<dirname CAIRN_DB>/tls`, i.e. `/data/tls` under Docker/Umbrel).
Regenerates when missing, unparsable, weakly-signed (rejects legacy SHA-1/
MD5 certs — a real bug in Cairn ≤0.1.6, detected via raw-DER OID scan since
Node's `X509Certificate` doesn't expose the signature algorithm), or within
30 days of expiry. 825-day validity (Apple's OS-trust-store import
ceiling), SHA-256, full extension set (`basicConstraints`, `keyUsage`,
`extKeyUsage`, `subjectAltName` incl. `umbrel.local`/`localhost`/
`*.local`/127.0.0.1). Persistence failures degrade to serving an in-memory
cert (fresh warning every restart) rather than ever killing the HTTPS
listener outright. Why the second port exists at all: Umbrel serves apps
over plain HTTP on the LAN, which is not a browser "secure context," so
WebHID/WebSerial and camera QR scanning don't work there — Cairn serves the
identical app a second time over self-signed TLS to get a secure context
without needing platform TLS.

### Tests

**Framework**: Vitest. Tests live colocated as `*.test.ts` next to the
source they cover, under both `src/lib/server/**` and `src/routes/**` (e.g.
`src/lib/server/auth.test.ts`, `src/routes/(app)/layout.server.test.ts`,
`src/routes/setup-admin/server.test.ts`). One test file also lives at
`src/hooks.server.test.ts`; `src/tests/envAlias.test.ts` /
`src/tests/setup.ts` / `src/tests/env-stub.ts` form a dedicated support
directory. `npm run check` also runs `svelte-check` for type errors
separately from Vitest.

**Two Vitest projects (`cairn-et5a0`).** `vitest.config.ts` defines
`test.projects: [...]` rather than a single flat config: a **`node`**
project (the historical setup, unchanged — `src/**/*.test.ts` +
`scripts/**/*.test.mjs`, `src/tests/env-stub.ts` aliasing
`$env/dynamic/private`, `src/tests/setup.ts`) and a new **`dom`** project
(`src/**/*.dom.test.ts`, `environment: 'jsdom'`, the real
`@sveltejs/vite-plugin-svelte` compiler with `runes: true`, module
resolution forced through `conditions: ['browser']` so `mount()` from
`'svelte'` is the actual client runtime — the server build has no `mount`
export). The `dom` project exists for Svelte component **mount** tests —
node-environment tests can't exercise a real mount at all, which is exactly
what let the duplicate-`each`-key bug (`cairn-et5a0`, `/mining` hydration
blanking silently) go uncaught. `npm test` runs both projects; to run just
the new one, `npx vitest run --project dom`.

**CI**: `.github/workflows/ci.yml` — on every push/PR: checkout, Node 22,
`npm ci`, `npm run check`, `npm test` (the `test` job); a second,
independent `mining-forced-solve` job runs the regtest harness described
below (uses Docker to run a real `bitcoind`, but still no *image build* step
for Cairn's own Docker image — that remains a still-open improvement).

### Standing security regression gate: admin-data leak audit (`cairn-f5gh`)

`src/tests/adminLeakAudit.test.ts` is a standing regression gate asserting
"no admin-only data ever reaches a non-admin session" — a directive that
previously had no test enforcing it. Two independent halves, both run as
part of the normal test suite (no separate invocation needed):

1. **Structural sweep.** Every `+server.ts` under `src/routes/api/admin/**`
   and every `+page.server.ts` action under `src/routes/(app)/admin/**` is
   discovered by **walking the filesystem**, never hand-listed, so a route
   added after this test was written is automatically covered. Each
   discovered handler is called as an anonymous or authenticated-but-
   non-admin caller and must be rejected (401/403), never resolving with
   real data. The `(app)/admin` layout's own `load()` is pinned directly
   (it's the single gate every admin *page* load relies on — children
   deliberately don't re-check admin in their own `load`), but a form
   `action` does **not** run the parent layout's `load()` (the historical
   `cairn-fame`/`jnlx`/`bgv1` bug class), so every discovered admin action
   is swept independently too.
2. **Marker-diff sweep.** Distinctive secret marker strings are seeded into
   every admin-only surface (Core RPC password, SMTP password, a
   draft/inactive announcement, an inactive referral service, a per-admin
   feature-flag override), plus a denylist of exact sensitive field names.
   Every user-reachable `(app)` page load and `/api` endpoint a regular
   signed-in user actually hits — the shared `(app)` layout (rendered on
   every page), every `/settings` page, `/activity`, and their `/api`
   equivalents — is invoked **as the regular (non-admin) user**, and the
   returned JSON is asserted to contain neither any marker nor any
   denylisted key, anywhere in the (deeply-walked) payload. The seeding is
   deliberately mutation-proven (a marker injected into a leak path is
   confirmed to actually fail the test) rather than just trusted to work.

**Extending it:** a new admin API route or admin-only page action needs no
manual wiring — the filesystem walk picks it up automatically. Adding a new
admin-only **secret** (a new credential, draft-content field, or
admin-scoped config value) does need one manual step: add its marker string
to the seed block so the marker-diff half actually looks for it. Known
current scope limit: the marker sweep deliberately skips chain-backed
routes (`/api/wallets`, `/api/portfolio`, explorer) pending chain-service
mocks — filed as a separate P3 follow-up, not a gap in what's covered today.

### Durable QA gates: `qa:route-crawl`, `qa:notif-deeplink` (Wave-5R, v0.2.41)

Two authenticated, throwaway-instance gates plus a shared harness
(`scripts/qa/qa-harness.mjs`: free-port probe, prod-boot launch, and an
**INSERT-only** admin+session DB seeding helper — deliberately not the
DELETE-then-insert pattern some prior QA seed scripts used, which is unsafe
to copy against a shared/long-lived DB).

- **`qa:route-crawl`** (`scripts/qa/route-crawl.mjs`) — spins up a throwaway
  regtest `bitcoind` + this repo's Electrum shim, boots the app for real,
  mines 110 blocks, seeds an admin session, and authenticated-crawls `/`,
  `/wallets`, `/wallets/new`, `/settings`, `/admin`, `/explorer`,
  `/explorer/tx/<nonexistent-txid>` (proves the flag-exempt tx-detail route,
  §9 spec R6, renders a graceful "not found" rather than a 500 even with no
  seeded wallet data), `/api/health`, asserting no 5xx / raw stack trace.
  **Separately** (UX Simplification Wave 5, `cairn-6c91u.5`) it GETs the two
  deleted-page redirect stubs with `redirect: 'manual'` and asserts each is a
  literal `307` whose `Location` starts with its documented `/settings#...`
  anchor: `/admin/settings` → `/settings#node-connection`, `/admin/feature-
  flags` → `/settings#mining` — a stricter check than "not a 5xx," since a
  redirect stub that silently started 200-rendering (or 404ing) would
  otherwise slip through the plain crawl. Then kills the shim and re-crawls a
  route subset to confirm the degraded (chain-down) path also renders
  cleanly instead of 500ing, including a hard assertion that `GET /`
  contains the chain-down copy — this is what `cairn-favlc`'s SSR fix (§20.4)
  made reliable; it was soft-checked (WARN) until that fix landed.
- **`qa:notif-deeplink`** (`scripts/qa/notif-deeplink.mjs`) — verifies a
  seeded notification's deep link resolves via the `txid` → `/explorer/tx/
  {txid}` fallback, mirroring `NotificationPanel`'s `linkFor()` (§8 Deep
  links) so this stays a regression guard for `cairn-ay45q`/`cairn-fochc`,
  not just a one-time manual check.

Both gates are throwaway-instance (own temp DB/port), not part of `npm
test`/CI yet — run manually before a release, same as `qa:prod-boot`.

### Regtest + hardware-emulator stack (NOT part of normal `npm test`/CI)

Two parallel trees hold manual/E2E scaffolding against a real regtest node
plus hardware-wallet emulators — both explicitly listed for exclusion from
any future public repo:

- **`.hw-emu-test/`** — ~128 files: ad-hoc `.mjs` probes, captured PSBTs,
  session tokens, per-signer logs (Trezor/Ledger/ColdCard), a `PROGRESS.md`,
  and `oracle.round-trip.test.ts` (the one actual Vitest file in there).
  This is the first, earlier-port-set emulator session.
- **`scripts/vault-e2e/`** — the second, cleaner, port-shifted re-creation,
  built specifically to back the one real automated regtest test:
  `src/lib/server/bitcoin/vaultRegtestE2E.test.ts`.
  - Gated by `process.env.VAULT_E2E === '1'`; run with:
    `VAULT_E2E=1 npx vitest run src/lib/server/bitcoin/vaultRegtestE2E.test.ts`
  - Drives Cairn's **own** modules end to end (`createMultisig` →
    `toMultisigConfig` → `deriveMultisigAddress` → `constructMultisigPsbt` →
    2-of-3 regtest signing → broadcast → `caravanExport` →
    `parseCaravanImport` round-trip) against a live `bitcoind` regtest node
    on `127.0.0.1:18543`, proving the app's own code — not a parallel
    reimplementation — produces byte-identical scripts to Bitcoin Core.
  - Stack: `docker compose -p vault-e2e up -d` (bitcoind regtest, Trezor
    emulator + bridge via `ghcr.io/trezor/trezor-user-env`, Ledger Speculos
    via `ghcr.io/ledgerhq/speculos` with a real app-bitcoin-new 2.4.6
    binary, ColdCard-style file signer script, Bitcoin-Core-wallet scripted
    cosigners). Has its own `package.json` (root `package.json` is
    untouched) and a `docker-compose.yml` with every port deliberately
    shifted from defaults so it can run alongside any leftover containers
    from the earlier `.hw-emu-test` session.
  - `scripts/vault-e2e/README.md` documents full boot/teardown, the three
    test-only signer seeds (Trezor/Ledger/ColdCard — "NEVER use for real
    funds"), Windows-specific Docker gotchas (`MSYS_NO_PATHCONV=1`, Git Bash
    path mangling, `trezord-go` binding loopback-only requiring a
    `proxy.py` TCP relay), and a fallback Core-wallet cosigner path if an
    emulator misbehaves.

Both trees are currently ignored/untracked in the private working tree too
— verify with `git status --ignored` before any publish cutover.

### Mining forced-solve regtest harness (`cairn-vn43.2`, part of CI)

Required gate for the solo-mining feature — see `docs/MINING-POOL-SCOPE.md`
(epic `cairn-vn43`; the doctrine pivoted 2026-07-17 from a single-user
"Tessera-solo sidecar" to **multi-user solo, in-process** — see § "Mining
engine" above for the built architecture). The one code path that must be
flawless is *template → job → solved share → `submitblock` → the block
actually confirmed on-chain*, since it only fires for real once every
~15,000–35,000 years of home hashrate.

**Note on scope, as of this writing:** the real engine (`src/lib/server/
mining/{miningPool,stratum,job,wire,tipPoller}.ts`) has since landed
(`cairn-vn43.1`) and is what actually runs in the app. This specific
harness, described below, still deliberately exercises its own **standalone**
reference coinbase/block builder (`soloBlockBuilder.mjs`) rather than the
real engine's `job.ts`/`miningPool.ts` — that repoint (point the harness at
the real job builder and, ideally, drive it through an actual Stratum TCP
connection rather than calling `getblocktemplate`/`submitblock` directly)
is tracked as follow-up work on `cairn-vn43.2` (still open, P1), not done
by this bead. See Part II § "Mining pool (multi-user solo) QA matrix" for
QA coverage of the real, in-process engine.

- **`scripts/mining/soloBlockBuilder.mjs`** — pure, no-I/O solo coinbase/
  block construction: BIP34 height push, BIP141 witness commitment, PoW
  grinding via `bitcoinjs-lib`'s own `Block` class (`calculateMerkleRoot`,
  `checkProofOfWork`, `checkTxRoots`). Deliberately a **fresh**
  implementation, not a port of Tessera's `pool/src/job.ts`/`wire.ts`
  (`C:\dev\raffle`): Tessera is GPL-3.0 and whether/how to vendor it into
  this MIT repo is still open (scope doc § Open questions #5, pending Alex).
  `bitcoinjs-lib` is MIT and already resolves via `node_modules` (pulled in
  transitively — see `src/lib/hw/ledger.ts` — not yet a direct
  `package.json` dependency).
  Unit-tested in `scripts/mining/soloBlockBuilder.test.mjs` (19 tests, no
  bitcoind/docker) — picked up by `npm test` via the
  `scripts/**/*.test.mjs` entry added to `vitest.config.ts`'s `test.include`.
- **`scripts/mining/regtestNode.mjs`** — ephemeral regtest `bitcoind`
  lifecycle (own docker-compose project `cairn-mining-forcedsolve`, RPC on
  `127.0.0.1:18546` — distinct from `vault-e2e` on 18543 and `qa-sub1` on
  18544) plus a minimal JSON-RPC client (`fetch` + HTTP basic auth, no new
  dependency). Always `down -v` both before and after, so every run starts
  from a byte-identical empty chain.
- **`scripts/mining/forcedSolveHarness.mjs`** — the harness itself: boots
  the node, mines 101 warm-up blocks, force-solves 3 blocks directly against
  real `getblocktemplate`/`submitblock` (no Stratum/network layer involved —
  that's Tessera's `stratum.ts`, ported verbatim by `cairn-vn43.1` when it
  lands, and out of scope here), matures them 100 blocks, then verifies each
  one on-chain: still the main-chain block at its height (not orphaned),
  coinbase output unspent with ≥100 confirmations, paid sats exactly equal
  to that block's `getblocktemplate.coinbasevalue`, and paid to the expected
  script. Run with:

  ```
  npm run mining:forced-solve-harness
  ```

  Deterministic, self-contained (own Docker container, always torn down in
  a `finally`), and fast — a real run on this box: 3/3 blocks forced-solved,
  PASS, ~14–19s wall-clock (excluding the one-time `bitcoin/bitcoin:28.0`
  image pull). Needs Docker + Docker Compose v2 (`docker compose`, not the
  standalone `docker-compose` binary) available on `PATH`.
- **CI**: wired as its own `mining-forced-solve` job in
  `.github/workflows/ci.yml`, independent of the `test` job (checkout, Node
  22, `npm ci`, `npm run mining:forced-solve-harness`) — ubuntu-latest
  runners ship Docker preinstalled, no extra setup step needed.
- **Follow-up (not this bead):** once `cairn-vn43.1` extracts the real
  engine and the Tessera-licensing question is resolved, point this harness
  at the real job builder / stratum submit path instead of
  `soloBlockBuilder.mjs`'s standalone reference implementation.

---

## 14. Docker & Umbrel Packaging

### The multi-stage `Dockerfile` (repo root)

**Build stage**: `node:22-alpine`. Installs `python3 make g++ linux-headers
eudev-dev` — required only because the `usb` native addon is a hard
transitive dependency of `@trezor/connect-web` (even though Cairn only ever
loads `usb` client-side/browser popup, never server-side); `npm ci` still
compiles it. `npm run build` then `npm prune --omit=dev`.

**Runtime stage**: fresh `node:22-alpine`. Deletes the base image's `node`
user and recreates a `cairn` user/group **pinned to UID/GID 1000**
(`adduser -S -u 1000 -G cairn cairn`) — required because Umbrel bind-mounts
app data owned by 1000:1000 and runs the container as `user: "1000:1000"`.
Copies only `build/`, `node_modules/`, `package.json`, `server.mjs`, and
`scripts/tls-cert.mjs` from the build stage. Bakes:

| ENV | Value |
|---|---|
| `CAIRN_DB` | `/data/cairn.db` |
| `CAIRN_LOG_FILE` | `/data/logs/cairn.log` |
| `PORT` | `3000` |
| `CAIRN_HTTPS_PORT` | `3443` |
| `BODY_SIZE_LIMIT` | `200K` |
| `NODE_ENV` | `production` |

(No `ADDRESS_HEADER` baked in — see §12.) Creates and chowns `/data`,
declares `VOLUME /data`, `EXPOSE 3000 3443`. `HEALTHCHECK` probes
`/api/health` via Node's built-in `fetch` (Alpine ships no curl/wget).
`CMD ["node", "server.mjs"]`.

Root `docker-compose.yml` (plain self-hosted / non-Umbrel use): builds from
`.`, maps `3000:3000`, bind-mounts `./data:/data`, `restart:
unless-stopped`. Healthcheck inherited from the Dockerfile.

**Release image build**: `.github/workflows/release.yml` — on `v*` tags (or
manual dispatch), builds **natively** (no QEMU — matters because `npm ci`
compiles the native `usb` addon) on `ubuntu-24.04` (amd64) and
`ubuntu-24.04-arm` (arm64) in parallel, pushes each platform by digest to
`ghcr.io/alexm223/cairn`, then a `merge` job stitches the two digests into
one multi-arch manifest list tagged with the version (or `dev-<sha>`
off-tag) via `docker buildx imagetools create`, printing the manifest-list
digest to pin in Umbrel's compose.

### Umbrel packaging — two relevant locations

**In this repo: `packaging/umbrel/heartwood/`** — the current staging copy
of the Umbrel store package:
- `umbrel-app.yml` — `id: heartwood`, `name: Heartwood`,
  `version: "0.2.13"`, `category: bitcoin`, `port: 3211`,
  `defaultUsername: "admin@cairn.local"`, `deterministicPassword: true`,
  `backupIgnore: [data/logs, data/tls]`. Description explains the first-run
  flow (Umbrel-shown credentials → forced reset) and that hardware signing
  needs `https://<host>:4488` (self-signed, browser warning expected).
- `docker-compose.yml` — Umbrel-flavored compose:
  - `app_proxy` service: `APP_HOST: heartwood_web_1`, `APP_PORT: 3000`.
  - `web` service: image pinned as
    `ghcr.io/alexm223/cairn:0.2.13@sha256:501a9f9b00adacf30ca19a88003c2a308431
    0187b16263993df6b70485f449fb` (tag **and** digest,
    never `latest`/digest-only — bump both together on every release).
    `user: "1000:1000"`; `ports: ["4488:3443"]` (the one raw host port that
    bypasses `app_proxy`, since `app_proxy` only speaks plain HTTP); bind
    mount `${APP_DATA_DIR}/data:/data`.

| Env var (compose) | Value |
|---|---|
| `PORT` | `3000` |
| `CAIRN_ADMIN_PASSWORD` | `${APP_PASSWORD}` (Umbrel's derived per-install secret, safe because of the forced first-login reset) |
| `CAIRN_ORIGIN` | `http://${DEVICE_DOMAIN_NAME}:3211` |
| `CAIRN_HTTPS_EXTERNAL_PORT` | `4488` (advertises the mapped host port since it differs from the container's 3443) |
| `ADDRESS_HEADER` | `x-forwarded-for` |
| `PROTOCOL_HEADER` | `x-forwarded-proto` |
| `HOST_HEADER` | `x-forwarded-host` |

The last three are **the CSRF/cookie fix** described in §12 — `app_proxy`
sets both forwarded headers by default, and without `PROTOCOL_HEADER`/
`HOST_HEADER` set, form-POST CSRF checks fail behind the plain-HTTP proxy.

- `data/logs/.gitkeep`, `data/tls/.gitkeep` — placeholders for the persisted
  volume subpaths.

**Separate store repo (referenced, not present locally)**:
`github.com/AlexM223/umbrel-community-app-store` is the actual **community**
Umbrel App Store repo, app id `caravan-store-cairn`, port 3211 — distinct
from the official `getumbrel/umbrel-apps` store (future work, not yet
submitted). Updates to it follow the `umbrel-update-app` skill checklist:
bump the pinned image SHA and the manifest `version:` together, verify
`git diff --check`, link release notes, and test the update path.

### Persistence / data

All persistent state — `cairn.db*`, `instance.key` (secret-encryption key —
**never** should be lost, encrypts SMTP creds/session tokens/etc.), and
rotating logs — lives under the single `/data` bind mount. `backupIgnore`
in the manifest excludes `data/logs` and `data/tls` (regenerable) but
deliberately does **not** exclude the DB or `instance.key`.

### `docs/` folder inventory

`docs/API.md`, `docs/RECOVERY.md`, and `docs/screenshots/*.png` are the
files marked safe to ship publicly. Everything else under `docs/` is an
internal plan/audit/retrospective explicitly marked for exclusion from any
future public repo: `ADMIN-COMPARISON-2026-07-06.md`,
`ARCHITECTURE-REVIEW-2026-07-06.md`, `BATCH-TRANSACTIONS-PLAN.md`,
`BUILD-QUEUE.md`, `COLLABORATIVE-CUSTODY-PLAN.md`,
`CPFP-UNCONFIRMED-PLAN.md`, `DATA-AUDIT-2026-07-06.md`,
`FEATURE-FLAGS-PLAN.md`, `HANDOFF-2026-07-08.md`, `HARDWARE-PLAN.md`,
`HEARTWOOD-REDESIGN-PLAN.md`, `LOAD-TEST-RESULTS-2026-07-05.md`,
`MULTISIG-DERIVATION-AUDIT-2026-07-06.md`, `NOTIFICATION-PLAN.md`,
`PER-USER-SMTP-PLAN.md`, `PERF-ARCHITECTURE-PLAN.md`,
`PROCESS-RETROSPECTIVE-2026-07-06.md`, `PUBLISH-PLAN.md`,
`SECURITY-AUDIT-2026-07-05.md`, `START9-PLAN.md`,
`TECH-DEBT-AUDIT-2026-07-05.md`, `SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md`.

`docs/START9-PLAN.md` is scoping-only (nothing built yet) for a *separate*
StartOS/Start9 package targeting the current StartOS 0.4.0.x SDK, building
on top of the already-established Umbrel env-var contract rather than
redesigning config from scratch.

### `.beads/` issue tracker

`.beads/` is the local-first `br` (beads_rust) issue tracker directory:
`issues.jsonl` (the synced issue log), `beads.db*` (SQLite working copy),
`config.yaml`, lock files, and a `.br_history/` directory of timestamped
JSONL snapshots. Per project convention, every fix in this codebase is
expected to have a `br create`/`br close` bead with findings recorded in
bead comments, and `.beads/` is committed alongside the fix.
`docs/PUBLISH-PLAN.md` explicitly excludes all of `.beads/` from any
eventual public repo (private backlog, not open-source issue tracking).

---

## 15. Gotchas, Contradictions & Stale Docs

This is the consolidated list of drift already found while researching this
manual — between docs and code, between two docs, and (in one case) between
this manual's own preamble and the repo's `git log` partway through writing
it. Treat every entry here as a standing QA lead: worth a quick check before
you build on top of the affected area, and worth a bead if you confirm it's
actually biting someone.

1. **Esplora is fully removed (cairn-zoz8.16).** The explorer now runs purely
   on the operator's own Electrum server + Bitcoin Core RPC; there is no
   third-party HTTP explorer API anywhere in the path (see §4). README's
   "Configuration notes" and this manual were updated together with the
   removal — if you find any lingering reference to an "Esplora backend" or an
   `esploraUrl`/`esplora_url` setting outside the one-time DB cleanup migration
   (`esploraUrlMigration.ts`) or its regression tests, it's stale and should be
   removed.
2. **`docs/PUBLISH-PLAN.md` is a living document with inline
   SUPERSEDED/EXECUTED annotations**, not a clean historical record — read
   its status block before trusting any section body. Its §6 env-var table
   predates the HTTPS listener and `PROTOCOL_HEADER`/`HOST_HEADER` entirely.
   Cross-check env vars against README and actual source, never trust the
   plan's body alone (§12 was built that way for exactly this reason).
3. **No `.env.example` exists** in the repo (only one inside an agent
   worktree, not part of the tracked tree). `docs/PUBLISH-PLAN.md` §3 lists
   adding one as still-TODO community-repo work. Section 12 of this manual
   is the from-code table meant to substitute for it in the meantime.
4. **Two `wizardProgress.ts` files share identical exported names**
   (`WIZARD_PROGRESS_KEY`, `parseSavedProgress`) but different shapes/step
   unions — one at
   `src/routes/(app)/wallets/new/_components/wizardProgress.ts`, one at
   `src/routes/(app)/wallets/multisig/new/_components/wizardProgress.ts`.
   Confirmed present as two separate files with matching test siblings
   (`wizardProgress.test.ts` next to each). They are **not** shared or
   deduped — grep by directory when working on either wizard, and don't
   "helpfully" consolidate them without checking both shapes first.
5. **`signingMass` naming is ambiguous across three files, not two.**
   Confirmed on disk: `src/lib/server/bitcoin/signingMass.ts` (server-side,
   its own `.test.ts` sibling), `src/lib/shared/signingMass.ts`, and
   `src/routes/(app)/wallets/[id]/_components/signingMass.ts`
   (route-local). The single-sig send page imports from the route-local
   path. Verify which module you're actually editing before touching
   signing-mass math — the server-side one in particular is easy to
   confuse with the two client-side ones by name alone.
6. **p2tr / taproot is a fully-typed dead end, not a contradiction — but a
   trap** for the same reason: `ScriptType` lists it, UI copy describes it,
   BitBox02's driver can even read a taproot key, but wallet *creation* is
   hard-rejected, `INPUT_VSIZE` has no p2tr entry (spending would throw),
   and `deriveAddress` has no p2tr branch. p2tr is valid only as a
   **recipient** address. Multisig `tr()` is separately rejected (no mature
   MuSig2/FROST). See §11 for the full detail. Don't spend time trying to
   "finish" p2tr support piecemeal without first confirming the full scope
   of what's missing across `wallets.ts`, `psbt.ts`, and `xpub.ts`.
7. **The `psbt.ts` "uncommitted change" documented in this manual's own
   preamble landed as a real commit while this manual was being written.**
   The `threshold` parameter added to `summarizePsbt` (quorum-aware
   `complete` for multisig) was an uncommitted, self-consistent, finished
   working-tree diff at the start of this research pass. It is now commit
   `a93dd27 fix(psbt): make summarizePsbt complete flag threshold-aware`,
   directly on top of `9fde0a4`. The described *behavior* is accurate
   either way; only the "uncommitted" framing went stale mid-document. This
   is the clearest available proof that this manual needs periodic
   re-verification against `git log`, not a one-time write.
8. **Rebrand split-brain is deliberate, not a bug** — "Heartwood" in
   package metadata/UI copy/`packaging/umbrel/heartwood/`, but `cairn.db`,
   every `CAIRN_*` env var, and the `ghcr.io/alexm223/cairn` image stay
   `cairn` on purpose (renaming would orphan every existing install's
   data). New `HEARTWOOD_DB`/`HEARTWOOD_LOG_FILE` aliases were added
   *alongside* the `CAIRN_*` ones, checked first, falling back to the
   `CAIRN_*` names. Do not "fix" this inconsistency by renaming the
   runtime identifiers. This internals-vs-branding split is permanent; the
   separate question of the Umbrel/App-Store **operational identity** (app
   ID, listing) is genuinely undecided, not settled — open decision
   `cairn-koy4.13`, blocked on Alex (§1).
9. **(Historical, fixed `cairn-0tvez`/`343c9f5`, v0.2.40) Watcher
   registration used to be poll-only (5-minute `refreshWatches()`)** — a
   newly created wallet wasn't watched instantly, and (the sharper bug)
   `walletSync.ts` could persist a permanently-empty snapshot for a wallet
   funded before its first subscription ever landed, so the wallet's own
   detail page could show a stale "0.00 BTC" indefinitely with no self-heal.
   `createWallet`/`createMultisig` now call `refreshWatches()` synchronously
   at creation and the sync layer never persists an empty snapshot for an
   unwatched wallet; the 5-minute pass remains as a periodic backstop, not
   the only path to being watched (§4).
10. **`safeAction` is NOT app-wide.** Exactly 2 call sites today (both
    wizards' `preview` action) — "no silent form/action failures" is a
    wizard-specific guarantee, not a blanket one across the app. Most forms
    still use SvelteKit's plain `use:enhance` or hand-rolled fetch. If you're
    debugging a swallowed error or a misreported "Network hiccup" on a form
    that *isn't* one of the two wizards, `safeAction` isn't in play — look
    at the form's own `use:enhance` handling instead.
11. **`parseBip21()` is built and tested but wired into no UI.**
    `src/lib/bip21.ts` (commit `41545b9`) implements a full `bitcoin:` URI
    parser (address/amount/label/message, bare-address degenerate case,
    case-insensitive params, string-arithmetic amount parsing to avoid float
    drift) with its own `bip21.test.ts`. As of current HEAD, no `.svelte`
    file imports it, `src/lib/hw/qrScan.ts` doesn't call into it, and
    `RecipientCombobox.svelte` has no `bitcoin:`-scheme handling. Pasting or
    scanning a payment URI today does **nothing** — it's not a recipient
    auto-fill feature yet, just a tested pure function waiting for a call
    site (Part II §20.10 scenario 2 marks this expected-fail).
12. **Back-button/history "replaceState" loop is a recurring bug class, now
    swept app-wide.** Five commits fixed the same shape of bug — an in-page
    "back" `<a href>`/`goto()` call *without* `{ replaceState: true }` pushes
    a new history entry instead of replacing one, so Back alternates forever
    between two pages instead of leaving to wherever the user actually came
    from: `cairn-y7ac` (Settings, closed 2026-07-08), then this session's
    `4b98a1e` (Admin > Users > `[id]`), `7fbbdd4` (all six Explorer detail
    pages), `d22888c` (`/sync`'s "Back to Heartwood"/"Enter Heartwood"), and
    `a19dfa2` (`/recovery-setup` — suppresses the back control entirely
    during mandatory setup instead of fixing its target, since back
    shouldn't be offered there at all). **Any new in-page back control must
    use `goto(href, { replaceState: true })` (or `history.back()`) from the
    start** — treat a plain `<a href>` "back" link as suspect on sight.
13. **`QrScanner.svelte` and `qrScannerLogic.ts` header comments cite a
    `QR-SCAN-DESIGN.md §1.3/§5/§6 "Wave 2"` design doc that does not exist
    anywhere in this repo** (tracked tree or working copy — confirmed via
    glob, no match). Either it was a planning doc that was never committed
    or it lives outside this repo. Don't burn time hunting for it, and don't
    treat the comment references as broken links to fix — they're pointing
    at something that was lost or external, not a typo.
14. **Open QA leads worth tracking as live drift, not just closed history**
    (per the 2026-07-12 issue-tracker survey): multisig UX beads
    **cairn-hla1** (multisig buried/undiscoverable on `/wallets`, the
    `stateless` signer page has zero inbound links), ~~**cairn-jy3g**
    (multisig wizard needs server-side draft persistence, unlike single-sig's
    sessionStorage resume)~~ — **shipped v0.2.32**, see §9's Multisig
    wizard entry, **cairn-czi0** (`multisigScan.ts` almost entirely
    untested, including the spend-flow data path); the **cairn-6xxa** P1
    epic (sync/dashboard/derivation perf re-architecture, 7 dependent beads);
    and the **cairn-zoz8** epic (Esplora removal): `EsploraApi` removal +
    admin-settings cleanup (cairn-zoz8.16) is now **done** — the explorer runs
    purely on Electrum + Core RPC with zero third-party explorer calls; the
    remaining open children are the Core-RPC-based RBF-lineage watcher
    (cairn-zoz8.13, deferred) and the fiat-price-fetch decision (cairn-zoz8.18).
15. **v0.2.19 was a consolidation wave, not a single feature** — it merges
    the QA test wave, the banner-consolidation branch, the dollar-based
    multisig threshold entry, and the phone-testing UX fixes wave onto
    `single-sig-full-wallet`. 3,085+ tests passing as of this merge (grown
    further since by the explorer render-guard hardening in this same
    entry's neighbor, cairn-6efi.11/.12 — see the snapshot-honesty rule
    above and the explorer routes table). `.beads/.br_recovery/` is
    `.gitignore`d (crash-recovery backups can balloon to hundreds of MB) —
    if a `.beads/` merge ever looks huge, check that guard is still in
    place before assuming the repo itself grew.

**Additional gotchas surfaced per-layer (not contradictions, but load-
bearing surprises worth remembering while working in each area):**

- **Electrum's idle socket timeout is deliberately disabled** (`s.setTimeout(0)`)
  in favor of the app-level keepalive — the connect-timeout timer is the
  only thing bounding a hung initial dial. Don't touch one without checking
  the other (§4; this was a real shipped bug, `cairn-vn48`/`cairn-ocs9`).
- **The Electrum pool is many sockets to ONE server, not independent
  sources** — this is why the address watcher needs its own SPV/
  difficulty-floor logic rather than trusting Electrum's header claims
  outright (§4, §1 invariant 3).
- **Lane tagging (`interactive` vs `background`) is opt-in per call site** —
  a new bulk/scan code path that forgets to pass `'background'` will
  silently compete with interactive traffic for every socket (§4).
- **`reconfigureChain()` must reset every piece of per-backend in-memory
  state** — a new module that adds backend-specific caching needs a reset
  hook wired in there too, or it leaks stale data across an admin-triggered
  server switch (§4).
- **`seedChainConfigFromEnv()` ordering in `hooks.server.ts` is load-
  bearing** — it must run before the first `getChain()` call anywhere in
  the boot sequence (§4).
- **Never `await` inside an open `db.exec('BEGIN')` transaction** —
  node:sqlite is one synchronous connection; a concurrent request's own
  `BEGIN` would interleave (§1 invariant 4, §6).
- **A new `(wallet_kind, wallet_id)`-keyed child table must be wired into
  both `trg_wallets_delete_children` and `trg_multisigs_delete_children`**
  in `db.ts`, or `deleteCascade.test.ts` fails (§6).
- **A leaked `cairn.db` file alone does not compromise `instance_secrets`**
  — the decryption key lives in a sibling `instance.key` file, deliberately
  outside the DB (§6).
- **`requireFeature`'s 403 is the real feature-flag enforcement boundary**
  — UI-level flag checks are cosmetic only; any new gated action must call
  it server-side (§8).
- **The `/admin/*` mutation backstop in `hooks.server.ts` is explicitly not
  a substitute for each admin action's own `requireAdmin()` call** — both
  layers are required, since SvelteKit form actions skip the parent
  layout's `load()` (§7, §8).
- **The RBF-bump "no new inputs" constraint is deliberate**, not a
  limitation to route around: a stuck tx with too-small a change output
  genuinely cannot be RBF-bumped past a certain fee rate, by design, rather
  than silently pulling in new coins the user never reviewed (§5).
- **Coin reservation has no dedicated table** — `coinsReservedByDrafts`
  reasons about "which coins are already claimed" by re-parsing every
  in-flight draft's stored PSBT via `summarizePsbt().inputs`. An unparsable
  stored draft silently reserves nothing (caught and skipped, not surfaced
  as an error) — simple, but worth knowing if a reservation warning seems
  to be missing (§5).
- **BitBox02 and Ledger solve the same "device must approve the wallet
  policy once" problem with opposite persistence models** (device-side
  only vs. server-side HMAC table) — worth knowing if debugging why a
  "forgotten" registration behaves differently between the two (§5, §11).
- **`--text-faint` is documented as intentionally failing WCAG AA** — do
  not use it for any copy that conveys information, only decorative/
  disabled affordances (§10).
- **The Heartwood system ships both dark (default) and light modes**
  (cairn-sdx5.7) — `color-scheme: dark` is no longer hardcoded; a new token
  needs a `light`-block counterpart or it silently keeps its dark value in
  light mode (§10). Canvas-drawn ring/arc motifs are the known gap
  (`cairn-w0ee`, §10).
- **`preview_click`-style bare-selector clicks are unreliable on multi-
  button Cairn pages** — relevant if writing browser-driven tests/
  automation against these pages, not itself a client-code finding.

---

## Part II: QA Test Runbook

This is a test runbook, not a design document: every scenario below is written to be
**executed**, by a human tester or by an agent driving the GUI with browser tools
(`preview_*`-style tools or equivalent), and to leave behind an unambiguous PASS/FAIL
record. Each scenario follows the same shape — **preconditions** that must hold before
step 1, **numbered steps** each naming an exact route and its **expected outcome**
(observable in the GUI, the `/activity` feed, or a notification), a single **PASS/FAIL**
criterion, and a **cleanup** step to return to a known state. Every scenario also carries
an environment tag — `[none]` (no special hardware), `[emulator]` (the
`scripts/vault-e2e/` stack), or `[real-hw]` (a physical device) — so a tester can pick
what's runnable with what's on hand. A few scenarios carry an **expected-fail / verify
current behavior** marker instead of a plain PASS bar: these are QA leads deliberately
tied to the drift catalogued in Part I §15 ("Gotchas, Contradictions & Stale Docs") — a
known bug, a deliberate dead end (p2tr), or a documented timing surprise. Don't record the
broken/surprising behavior as a pass; record what actually happened against the note, and
re-check it against §15 (and `git log`) since, as §15 itself demonstrates, this class of
note goes stale the moment the underlying fix lands.

> **Conventions used in every scenario**
> - **Env tag** — each scenario is marked `[none]` (no special hardware), `[emulator]`
>   (needs the `scripts/vault-e2e/` stack), or `[real-hw]` (needs a physical device).
> - **Preconditions** — state that must already be true before step 1.
> - **Steps** — numbered, each with an **exact route path** (e.g. `/wallets/new`) and the
>   **expected outcome** observable in the GUI, the `/activity` feed, or a notification.
> - **PASS/FAIL** — the single binary criterion for the whole scenario.
> - **Cleanup** — how to return to a known state.
> - **expected-fail / verify current behavior** — scenarios that touch a known bug, a
>   deliberate dead-end (p2tr), or a documented timing surprise are labelled this way, and
>   are tied to specific Part I §15 gotchas. Do **not** assert the broken/surprising
>   behavior is a pass — record what actually happens against the note.
> - Route note: `/vaults*` is empty scaffolding (no tracked files) that
>   301-redirects before it would ever be reached — bare `/vaults`(`/`) →
>   `/wallets`; `/vaults/<rest>` → `/wallets/multisig/<rest>` (`hooks.server.ts:505-516`,
>   post-rebrand). Use `/wallets`/`/wallets/multisig` directly.
> - Selector note: bare `button` selectors mis-target on multi-button Cairn pages — locate
>   controls by exact visible text, not tag (existing memory: preview_click quirk).

---

## 16. Test environment setup

Three run targets exist. Pick per what you are testing.

### 16.1 Local dev instance `[none]`
1. `npm install` (Node ≥ 22.5 required — Cairn uses built-in `node:sqlite`).
2. `npm run dev` → Vite dev server on `http://localhost:5173` (or `$PORT`).
   - **Expected:** boot log ends with one `"startup config honored"` summary line.
   - Chain backend defaults to **public** mode (`electrum.blockstream.info:50002`) when no
     `CAIRN_ELECTRUM_*` env is seeded — i.e. mainnet. See 16.4 for regtest wiring.
3. Data lives at `./data/cairn.db` and the sibling `./data/instance.key`.
- **PASS:** `/` loads the login or signup page without a 500.
- **Cleanup:** `Ctrl-C`; to reset all state see 16.6.

### 16.2 Production-style instance `[none]`
1. `npm run build` then `npm start` (runs `node server.mjs`, not `node build`).
2. HTTP on `$PORT` (default 3000). If `CAIRN_HTTPS_PORT` is set (baked to `3443` in the
   Docker image), a second self-signed-TLS listener comes up too.
   - **Expected:** before the SvelteKit bundle finishes importing, the port already answers
     with a self-refreshing 503 "still starting" page (never `ERR_EMPTY_RESPONSE`).
- **PASS:** after boot the 503 placeholder is replaced by the real app on both listeners.
- Use this target (not dev) to exercise `server.mjs`, the TLS listener, and secure-context
  redirect (§19.6, §21).

### 16.3 Umbrel instance `[none]`
- Installed from the community store package (`packaging/umbrel/heartwood/`, app id
  `heartwood`, host port **3211** for the app, host port **4488 → container 3443** for the
  HTTPS/hardware-signing listener that bypasses `app_proxy`).
- First-run credentials are shown by Umbrel (`admin@cairn.local` + derived
  `${APP_PASSWORD}`), and the account is flagged `must_reset_password` → forced
  `/setup-admin`. This is the journey tested in full in §21.
- Chain backend is seeded once from `CAIRN_ELECTRUM_*` / `CAIRN_CORE_RPC_*` (Umbrel's
  `electrs`/`bitcoin` dependency wiring); a stock deploy has `core !== null`,
  Electrum primary, and no third-party explorer API in the path.
- Even without that manifest dependency wiring, `CAIRN_PLATFORM=umbrel` (set by the store
  compose) enables the Wave A `probeAndSeedUmbrelElectrum()` credential-free Docker-network
  probe (`umbrelProbe.ts`) — see 20.14 for the dedicated QA scenario and
  `docs/UMBREL-AUTOCONNECT-DESIGN.md` for the design.

### 16.4 Regtest stack (`scripts/vault-e2e/`) `[emulator]`
The only supported way to exercise real signing + broadcast without mainnet funds. See
`scripts/vault-e2e/README.md` for the authoritative boot doc; summary:
1. `cd scripts/vault-e2e && npm install` (local deps only; repo `package.json` untouched).
2. `MSYS_NO_PATHCONV=1 docker compose -p vault-e2e up -d` — brings up bitcoind regtest
   (RPC `127.0.0.1:18543`, auth `vaulte2e:vaulte2e`), Trezor emulator + bridge, Ledger
   Speculos (app-bitcoin-new 2.4.6), ColdCard file signer, Core-wallet cosigners.
3. `node setup-trezor.mjs` — **required after every `up`** (re-seeds the Trezor emulator,
   starts bridge, injects the loopback proxy).
4. Recreate the miner wallet and mine coinbase maturity (bitcoind state is ephemeral, no
   volume):
   ```sh
   curl -s -u vaulte2e:vaulte2e -d '{"jsonrpc":"1.0","id":"t","method":"createwallet","params":["miner"]}' http://127.0.0.1:18543/
   ADDR=$(curl -s -u vaulte2e:vaulte2e -d '{"jsonrpc":"1.0","id":"t","method":"getnewaddress","params":[]}' http://127.0.0.1:18543/wallet/miner | python -c "import sys,json;print(json.load(sys.stdin)['result'])")
   curl -s -u vaulte2e:vaulte2e -d "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"generatetoaddress\",\"params\":[101,\"$ADDR\"]}" http://127.0.0.1:18543/
   ```
5. Verify: `node speculos-check.mjs`, `node trezor-xpub.mjs`, `node verify-quorum.mjs`.
6. The one maintained automated regtest test drives Cairn's OWN modules end to end:
   `VAULT_E2E=1 npx vitest run src/lib/server/bitcoin/vaultRegtestE2E.test.ts`
   (createMultisig → deriveMultisigAddress → constructMultisigPsbt → 2-of-3 regtest sign →
   broadcast → caravanExport → parseCaravanImport round-trip, byte-checked against Core).
- **PASS:** `verify-quorum.mjs` reaches "1 sig does NOT finalize → 2nd sig completes →
  broadcast → confirmed"; the gated Vitest passes.
- **Cleanup:** `docker compose -p vault-e2e down`. If default-port leftovers from
  `.hw-emu-test/` collide: `docker rm -f cairn-trezor-emu cairn-speculos hwtest-bitcoind hwtest-electrs`.

### 16.5 Funding a Cairn wallet on regtest — direct GUI path `[emulator]`
**Current behavior (v0.2.40+, `cairn-xqnn7`+`cairn-czm9p`):** a regtest- or
testnet-configured instance now derives and renders addresses in the
**correct** network encoding (`bcrt1…`/`tb1…`, not mainnet `bc1…`), and
`constructPsbt`/`constructMultisigPsbt` build every output against that same
network. So the GUI receive→fund path works exactly like mainnet:
1. In Cairn, open the wallet's receive address (`/wallets/{id}` or
   `/wallets/multisig/{id}`) — it now renders as a real, node-acceptable
   `bcrt1…`/`tb1…` address.
2. `bitcoin-cli -regtest sendtoaddress <that address> <amount>`;
   `generatetoaddress 1 <any address>` to confirm.
3. Cairn's watcher subscribes new wallets' addresses immediately at
   creation (§4/§20.7), so the deposit is picked up promptly rather than
   waiting on the periodic sweep.
- **PASS:** balance appears in `/wallets/{id}` and a `tx_received` then
  `tx_confirmed` fires without needing to leave the GUI.

**Historical workaround (obsolete, pre-v0.2.40):** address encoding used to
be hardcoded mainnet regardless of `chain_network`, so a regtest `bitcoind`
would reject the displayed `bc1…` address outright. The old workaround
(still valid background if you ever need to fund a scriptPubKey Cairn
itself can't yet render, e.g. an unsupported script type) was to import the
wallet's descriptor **watch-only** into a Core regtest wallet
(`importdescriptors`), `deriveaddresses` the `bcrt1…` address sharing the
same scriptPubKey as Cairn's index, and fund that instead — the watcher/
scanner have always attributed inbound value by **scriptPubKey membership,
not address string** (`cairn-v13r`/`j6fv`), which is what made the bridge
work at all. Prefer the direct GUI path above for normal QA now; fall back
to the vault-e2e module-level harness for regtest signing scenarios.

### 16.6 Creating test users
- **First user = admin** automatically (`isFirstUser`). Signup at `/signup`
  (email + password; passkeys are additive, not required. They **are** usable on the
  self-signed HTTPS origin — that secure-context address is the one place a browser will run
  the ceremony — but not on the plain-HTTP origin, cairn-ib7w).
- Additional users: registration mode is `open`/`invite`/`closed` (`/settings`'s admin
  Instance group, `#instance`; `/admin/invites`). Multi-user *management* (invites, contacts,
  shares) is gated on `instance_mode = 'team'`; a fresh install defaults to **solo** — flip
  team mode in `/settings#instance` before testing §17 collaborative scenarios.
- Umbrel/Docker auto-admin: `CAIRN_ADMIN_PASSWORD` (or `APP_PASSWORD`) seeds the first
  admin non-interactively → forced `/setup-admin`.

### 16.7 Resetting state between runs
- **Local/prod:** stop the process, delete `./data/cairn.db*` (db + `-wal`/`-shm`) AND
  `./data/instance.key` (delete both together — a stale `instance.key` against a fresh DB
  is harmless but a fresh key against an old DB fails to decrypt `instance_secrets`).
  Restart → clean first-run.
- **Per-test isolation:** `src/tests/setup.ts` already points `CAIRN_DB` at a fresh temp
  file per Vitest run, so unit tests never share state.
- **Regtest chain:** `docker compose -p vault-e2e down` wipes bitcoind (no volume); re-mine
  on next `up`.
- **Do NOT** reset by editing `settings` rows by hand mid-run — chain backend config is a
  live DB setting; change it through `/settings`'s admin Node-connection group so
  `reconfigureChain()` resets the in-memory caches/health counters too.

### 16.8 QA automation practice — hard-won rules

Lessons from the v0.2.20 QA wave, kept here because they'll otherwise be relearned the
expensive way (one bead was closed NOT-A-BUG, one was nearly false-filed):

- **Authenticated QA without touching real passwords** — two supported paths:
  1. **Session-row seeding** — write a valid session row directly into SQLite, then set
     `document.cookie` to match, rather than driving the login form (`scripts/qa/
     seed-flagmatrix.mjs` is the reference pattern). Fastest, and sidesteps the login
     form's async/guard behavior entirely.
  2. **`scripts/qa/reset-qa-admin-password.mjs`** — if driving the actual login UI is the
     point of the test, run this first so the documented runbook creds
     (`qa-wave-admin@test.local` / `QaWave2026!Admin`) actually match the DB's
     `password_hash` (reproduces `auth.ts`'s exact `scrypt:16384:8:1:salt:hash` format;
     overridable via `QA_DB`/`QA_ADMIN_EMAIL`/`QA_ADMIN_PASSWORD`). Without this, prior
     waves hit login failures against stale/mismatched hashes and mistook it for a product
     bug (`cairn-wymc`).
- **Synthetic clicks/Enter do NOT reliably trigger native form submission in this stack.**
  Browser-automation tools dispatch synthetic click/keyboard events, and in at least one
  observed case (`cairn-m06l`, signup all-empty-submit) the synthetic event never fired the
  browser's default form-submit action, so `onsubmit`/`use:enhance` never ran and the page
  looked like it silently ate the click — while a real click (via `requestSubmit()` in
  devtools, or an actual human) submitted correctly and showed the validation Banner. This
  is an **automation artifact, not a product bug**. Before filing a "silent form" or
  "nothing happens on submit" finding: reproduce with `form.requestSubmit()` or a genuinely
  trusted event in the same session, and only file if that also fails. This one rule
  prevented at least one false P1 this wave and nearly missed a second.
- **`br` labels reject dots.** Use underscores in place of dots for version-style labels
  (`qa-v0_2_20`, not `qa-v0.2.20`) — a label with a literal `.` is rejected at creation time,
  not sanitized.
- **The screenshot pipeline can die environment-wide**, not just for one agent/tab — if
  screenshots start failing, don't retry in a loop. Fall back to `read_page` (accessibility
  tree, catches missing/duplicate/mislabeled elements) plus a JS layout probe for anything
  screenshots would normally catch visually — `document.documentElement.scrollWidth` vs
  `innerWidth` for horizontal-overflow checks, `getBoundingClientRect()` height/width for
  tap-target sizing (this is how `cairn-amyl`'s 44px touch targets were verified at 375px
  without a working screenshot pipeline).

---

## 17. Multi-user collaborative multisig scenarios

Preconditions for all of §17 unless stated: instance in **team** mode (`/settings#instance`);
two test users exist — **A** (owner) and **B** (cosigner-to-be); A and B have an
**accepted contact** relationship (`/settings/contacts` — sharing requires it, guarding
against share-via-leaked-user-id). Multisig create flag on (`multisig_create`, default on).

### 17.1 Owner creates a 2-of-3 multisig via the wizard `[none]`
1. As A, go to `/wallets/multisig/new`. Wizard steps: **why → keys → review → confirm**.
2. why: choose preset `2of3`, vault mode `collaborative`.
3. keys: add three cosigner keys (paste xpubs + key origin, or read from device). Each key
   is validated by `validateCosignerKeyPath` in **create** mode — a BIP-48 path with the
   wrong script suffix, a single-sig purpose (44/49/84/86), or the historical `1'`
   nested-segwit mislabel is **rejected** on create (import mode tolerates the `1'` case
   with a warning — do not confuse the two).
   - **Expected:** a bad path shows an inline `--attention` (warm-tan) validation message,
     never red, and blocks advancing.
4. review: confirm quorum + all three keys (order is irrelevant — `sortedmulti`/BIP-67).
5. confirm: name the vault, create.
   - **Expected:** `multisigs` row created with `source='created'`; `/wallets/multisig/{id}`
     shows the QuorumArc (2-of-3), a receive address, and a mandatory-backup nudge.
- **PASS:** vault detail page renders with correct quorum and a derivable receive address.
- **Cleanup:** delete the vault from its detail page (fires `unwatchMultisig()` + trigger
  child-row sweep).

### 17.2 Owner exports Caravan config; cosigner imports/joins `[none]`
1. As A, from `/wallets/multisig/{id}` export the Caravan wallet-config JSON (the
   `caravan` endpoint / export button) and/or share the vault with B as **cosigner**
   (`/wallets/multisig/{id}` collaborators → share, role `cosigner`; requires accepted
   contact).
   - **Expected (Caravan export):** JSON carries `uuid` = receive descriptor's BIP-380
     checksum, both quorum fields, canonical xpubs, apostrophe-hardened paths,
     `startingAddressIndex` = live receive cursor, and deliberately NO `client`/`method`
     fields (avoids Caravan's own re-import bug).
2. As B, either (a) accept the share — the vault now appears in B's `/wallets` list — or
   (b) import the exported Caravan JSON at `/wallets/multisig/new` (paste/upload; import
   mode validation). `parseCaravanImport` rejects any blob containing `xprv/yprv/zprv/tprv`
   with a load-bearing "never paste a private key" refusal, >1MB blobs, >15 keys, and
   non-mainnet network fields.
   - **Expected (share path):** B sees the same vault, same balance/addresses.
- **PASS:** B can open the vault; a re-export from B round-trips byte-identically (verify
  via the gated `parseCaravanImport(caravanExport(...))` test if driving modules).
  **Caveat (`cairn-o7zy`, open):** a byte-identical re-export JSON diff is not proof the
  underlying key *paths* survived intact — an unknown-origin key is exported as a masked
  `m/0/0/0/0` path and re-imported literally as that concrete (wrong) path, with no JSON-level
  signal that anything was masked. If this scenario includes an unknown-origin cosigner key,
  additionally verify its origin path by hand, not just the JSON diff.
- **Cleanup:** A revokes B's share; delete the imported copy if 2(b) was used.

### 17.3 Draft created, both sign (order A→B), broadcast `[emulator]`
Precondition: vault funded (16.5); `send`/`fee_bumping` flags on.
1. As A (owner), `/wallets/multisig/{id}/send` — enter recipient + fee rate → build draft.
   - **Expected:** a `multisig_transactions` `draft` row; the per-transaction signer roster
     (`multisig_transaction_signers`) is frozen; cosigners get a `sign_session_waiting`
     notification with a **working deep link** to the send page.
   - **Discoverability (`cairn-0pxk5`, v0.2.39):** back out to `/wallets/multisig/{id}`
     without touching the notification — a calm-amber "Awaiting signatures (1)" card should
     be visible with a "Review draft #N →" link to this same draft, independent of the
     notification and independent of the on-chain scan (a draft has no on-chain footprint
     yet). Then navigate straight to `/wallets/multisig/{id}/send` with **no** `?tx=` query —
     the fresh Create-step wizard should show a warning banner ("A transaction draft is
     awaiting signatures...") with a "Resume draft" link, not a silent brand-new wizard with
     no indication the earlier draft exists.
2. A signs first — either the file/PSBT round-trip via `MultisigFileSigner`, or **live-USB
   signing**, which is fully wired into this page at parity with single-sig: the Trezor,
   Ledger, BitBox02, and Jade (USB) tiles all drive real multisig co-signing here, not just
   file fallback (verified by reading the send page and each signer component — see §19.1,
   §19.2, §19.4, §19.5). Upload/attach the signed PSBT back.
   - **Expected:** progress shows **1 of 2** signed. Authoritative signature count comes
     from `multisigPsbtProgress()` re-derived from the live PSBT, never from `has_signed`.
   - **Note (previously an expected-fail, now resolved):** the `summarizePsbt(..., threshold)`
     quorum-aware `complete` flag was an **uncommitted working-tree change** as of an earlier
     research pass; it has since landed as commit `a93dd27 fix(psbt): make summarizePsbt
     complete flag threshold-aware` and shipped in Release v0.2.13 (see Part I §15 gotcha
     #7). On current HEAD, `summary.complete` correctly reads `false` at the 1-of-2 moment,
     matching `multisigPsbtProgress`. Spot-check `git log -- src/lib/server/bitcoin/psbt.ts`
     if testing an older checkout before trusting this note is settled there too.
3. As B (cosigner), open the same draft via the notification deep link, sign, upload.
   - **Expected:** progress shows **2 of 2**; the Broadcast control enables.
4. Broadcast.
   - **Expected:** `assertSameTransaction` passes; broadcast txid == locally-computed
     deterministic txid; row → `completed`; `sign_session_complete` + `tx_confirmed`
     (after 1 block) fire.
- **PASS:** exactly one broadcast, one `completed` row, confirmation in `/activity`.
- **Cleanup:** mine/confirm, then delete or archive the draft chain.

### 17.4 Same draft, reversed sign order (B→A) `[emulator]`
- Identical to 17.3 but B signs first, then A. Because `sortedmulti` makes signatures
  order-independent and progress is re-derived from the PSBT, the outcome must be identical.
- **PASS:** 2-of-2 reached and broadcast succeeds regardless of who signed first. A
  divergence between 17.3 and 17.4 is a FAIL (order should never matter).

### 17.5 Viewer tier — read-only boundary `[none]`
Precondition: A shares the vault with a third user **V** as **viewer** (`multisig_shares.role='viewer'`).
1. As V, open `/wallets/multisig/{id}` — **Expected:** balance, addresses, history, labels
   are visible; other cosigners' sensitive key material is redacted
   (`redactMultisigKeysForViewer`).
2. As V, attempt to reach the send flow `/wallets/multisig/{id}/send` and attempt any
   share/sign/build action.
   - **Expected:** no signing/build affordance is offered; a direct POST to a build/sign/
     broadcast endpoint is denied. Note `getViewableMultisig` returns **null → 404** for a
     non-participant (existence is not leaked as 403).
- **PASS:** V can read everything a viewer should and cannot build, sign, broadcast, share,
  or mutate anything.
- **Cleanup:** revoke V's share.

### 17.6 Cosigner permission-boundary checks — what a cosigner must NOT do `[none]`
As B (cosigner) verify each is **denied** (expected 403/404, or the control is absent):
1. Cannot delete the vault (owner-only).
2. Cannot change quorum/keys or re-import the vault config over the existing one.
3. Cannot share the vault with a fourth party or change V's/own role (share management is
   owner + team-mode gated).
4. Cannot register a Ledger policy or mutate settings on the owner's behalf beyond its own
   signing.
5. Can build a draft + sign + broadcast **only** if role is `cosigner` AND B is on the
   frozen per-transaction roster; being a wallet-level cosigner is necessary but not
   sufficient for a specific transaction.
- **PASS:** every owner-only mutation above is refused for B; B's legitimate sign path in
  §17.3 still works. Any owner-only action succeeding as B is a FAIL (regression guarded by
  `multisigAccess.test.ts`, cairn-xkpd — the historical bug was gate functions existed but
  routes never called them).

### 17.7 Solo-mode vs team-mode difference `[none]`
1. In `/settings#instance` (admin group) set instance mode to **solo**.
   - **Expected:** management surfaces (invites, contacts, multisig-share creation) return
     **404** (`assertTeamMode` — "not disabled, just narrower"), and their nav entries hide.
2. Confirm a previously-granted cosigner (B) can **still read/sign** the vault — solo mode
   must NOT silently revoke access already granted (`getViewableMultisig`/`getSignableMultisig`
   are deliberately not team-gated).
3. Flip back to **team**; management surfaces return.
- **PASS:** solo hides *new* multi-user management (404) but never strips B's existing
  access; the mode is idempotent (once set it doesn't auto-flip on restart).
- **Cleanup:** leave the instance in the mode the next scenario needs.

---

## 18. Send / receive / sign / broadcast matrix per address type

The matrix covers only **actually-supported** spendable types. p2tr and multisig `tr()`
are **expected-clear-error rows**, not pass rows.

**Automated boundary coverage (`cairn-9v9g`, closed):** the classic send edge cases this
matrix doesn't spell out row-by-row — zero balance, dust-threshold outputs, amount ≤ fee,
sweep-all with fee subtraction, exact min-relay-fee boundary — are now covered by 49
table-driven tests across `src/lib/server/bitcoin/sendBoundaryMatrix.test.ts` (unit-level,
`buildDraft`/`buildMultisigDraft`), `src/lib/server/sendBoundaryDraft.test.ts`
(draft-persistence layer), and `src/routes/api/wallets/[id]/psbt/server.test.ts` (the send
API route itself). Treat those as the source of truth for boundary behavior; this manual's
matrix is the happy-path/address-type cross-reference, not a substitute for them.

### 18.1 Address-type matrix
For each **spendable** row: create the wallet (18.2), receive funds (16.5 on regtest / GUI
on mainnet), build a draft, sign, broadcast, and verify `tx_confirmed` appears in
`/activity` + notifications.

| # | Kind | Script type | Std path | Address prefix | Create route | Spendable? | Expected result |
|---|------|-------------|----------|----------------|--------------|------------|-----------------|
| A | single-sig | `p2pkh` (legacy) | BIP44 `m/44'/0'/0'` | `1…` | `/wallets/new` | **yes** | full send→sign→broadcast passes; note BitBox02 is disabled for this type (§19.4) |
| B | single-sig | `p2sh-p2wpkh` (nested segwit) | BIP49 `m/49'/0'/0'` | `3…` | `/wallets/new` | **yes** | full pass; RBF bump needs recoverable derivation (redeemScript) |
| C | single-sig | `p2wpkh` (native segwit) | BIP84 `m/84'/0'/0'` | `bc1q…` | `/wallets/new` | **yes** | full pass (default happy path) |
| D | single-sig | `p2tr` (taproot) | BIP86 `m/86'/0'/0'` | `bc1p…` | `/wallets/new` | **NO** | **expected-error:** creation hard-rejected — `"Taproot wallets aren't supported yet…"`. Even if forced, spend throws `"Spending from p2tr wallets is not supported yet."` (no `INPUT_VSIZE` entry). p2tr is valid only as a **recipient** address. |
| E | multisig | `p2wsh` (default) | BIP48 `…/2'` | `bc1q…`(long) | `/wallets/multisig/new` | **yes** | full N-of-M pass; the vault-e2e 2-of-3 default |
| F | multisig | `p2sh-p2wsh` | BIP48 `…/1'` | `3…` | `/wallets/multisig/new` | **yes** | full pass; returns both witnessScript + redeemScript |
| G | multisig | `p2sh` (legacy) | BIP45 `m/45'` (or Trezor `0'` ext) | `3…` | **import-only** — Caravan JSON / descriptor import at `/wallets/multisig/new`; **NOT** creatable via the wizard | **import-only** | **`cairn-acft`, closed 4d447fe: bare-P2SH creation was removed from the wizard** (the radio option renders `disabled`, and `hw/common.ts`'s account-path derivation now throws for p2sh instead of deriving the wrong `…1'` account key). Importing an existing bare-P2SH wallet (Caravan JSON or descriptor, `m/45'`/Trezor `0'`) still fully works and spends normally; import mode also tolerates a historic `1'` nested-segwit mislabel with a warning. **`cairn-etz9` (open):** the server create action itself has no matching guard yet — a scripted `POST` with `scriptType=p2sh` and valid non-`1'` keys can still mint a bare-P2SH wallet, bypassing the wizard-level removal. |
| H | multisig | `tr()` (taproot) | — | `bc1p…` | `/wallets/multisig/new` | **NO** | **expected-error:** `tr()` descriptor rejected by name (no mature MuSig2/FROST). Caravan/descriptor import also rejects `tr()` and unsorted `multi()`. |

**PASS (matrix):** rows A/B/C/E/F complete the full creation→send→broadcast lifecycle and
confirm; row G is **import-only** (creating a fresh bare-P2SH wallet through the wizard is
not offered — importing an existing one and spending from it is the row to exercise); rows
D and H produce the exact documented refusal messages (clear error, `--error` red is
acceptable here since it is an irrecoverable "not supported" condition) and never a silent
failure or a raw exception.

### 18.2 Per-row wallet creation `[none]` / receive+sign `[emulator or mainnet]`
1. `/wallets/new` (single-sig) or `/wallets/multisig/new` (multisig): **Key → Verify →
   Finish** (single-sig) / **why → keys → review → confirm** (multisig). Pick the script
   type / preset for the row.
2. Verify step round-trips to the server (`preview` action via `safeAction`) and shows
   **derived addresses** — confirm the prefix matches the table (`1…`/`3…`/`bc1q…`).
3. Receive: on regtest use 16.5; on mainnet use the receive address on the wallet detail
   page (`POST /api/wallets/{id}/receive` advances the cursor).
4. Build a draft at `/wallets/{id}/send` (or multisig send), sign, broadcast.
- **PASS/FAIL:** per the matrix result column.

### 18.3 RBF fee-bump `[emulator]`
Precondition: a broadcast, still-unconfirmed tx with a change output.
1. From the wallet's tx detail, choose **bump fee (RBF)**. Uses the shared `feeBump.ts`
   engine for both wallet types.
   - **Assertions to verify:** (a) every input still signals RBF (`sequence <
     0xfffffffe`); (b) new fee ≥ `originalFee + replacementVsize` (BIP-125 rule 4);
     (c) **no new inputs** are added — the whole increase comes from change; if change
     would drop below `dustThreshold(changeAddress)` (per-script-type floor — P2WPKH 294,
     P2WSH/P2TR 330, P2PKH 546, P2SH 540, `cairn-7ld60`) the bump is **refused** with a clear message;
     (d) a **changeless** original cannot be bumped (no fee headroom) — expected refusal.
   - **Custom fee-rate + floor hint (`cairn-vxel8`, v0.2.41):** the bump form's free-text
     sat/vB input (mirrors the CPFP pattern) now shows a proactive floor hint and disables
     submit below `tx.feeRate` — the same `newFeeRate <= tx.feeRate` rule `feeBump.ts`
     already enforced server-side, now surfaced before submit instead of only as a
     post-submit rejection.
2. Sign + broadcast the replacement.
   - **Expected:** replacement → `completed`; the **original row flips
     `completed`→`superseded`**; only **one live replacement per original** is allowed
     (a second concurrent bump hits the partial UNIQUE index on `(owner, replaces_txid)`
     and is rejected). `TxStatusBadge` labels a superseded tx **"Replaced"**.
   - **Resume-link fix (`cairn-vxel8`, v0.2.41):** revisiting a superseded original's
     `?tx=` resume link (both `wallets/[id]/send` and `wallets/multisig/[id]/send`) now
     routes straight to the `sent` step like `completed`, instead of falling through to an
     editable `review` draft of a tx that can no longer be broadcast. (Investigation found
     no literal "Failed" status anywhere in this path — the backend and badge already
     labeled `superseded`/"Replaced" correctly; this resume fallthrough was the actual
     adjacent bug.)
- **PASS:** the replacement confirms, original shows "Replaced", second-bump attempt is
  refused, and reopening the superseded original's resume link lands on Sent, not an
  editable draft.

### 18.4 CPFP (child-pays-for-parent) `[emulator]`
Precondition: a **stuck** tx that paid change back to the wallet (the wallet owns an
unconfirmed output on it).
1. Trigger CPFP on the stuck parent. `executeCpfpDraft` sweeps the wallet's own unconfirmed
   output(s) **on that parent txid** (coin-controlled, send-max) to a fresh change address;
   child fee = `ceil(target*(parentVsize+childVsize)) - parentFee`, floored to the connected
   node's own relay floor (`getRelayFeeFloor()`, `cairn-eacw.3`) rather than a hardcoded 1
   sat/vB — a sub-1 target is accepted and prices a genuinely sub-1 child when the node will
   relay it (`cairn-eacw.7`); on a node whose relay capability is unknown the floor falls back
   to 1, so behavior is unchanged there.
2. Verify typed error codes on the unhappy paths: `no_unconfirmed_output`,
   `already_confirmed`, `parent_fee_unknown`, `not_needed` (parent already meets target, or the
   target is below the node's relay floor), `coin_too_small`.
- **PASS:** a legitimate CPFP builds+broadcasts a child spending only the parent's own
  unconfirmed output; each unhappy path returns its specific code, not a generic error.
- **Defense-in-depth (`cairn-oae1.5`):** CPFP only ever qualifies a coin with `height <= 0`
  (unconfirmed) — a coinbase output is always confirmed, so it's structurally impossible for
  one to qualify. `executeCpfpDraft` (`feeBump.ts`, shared by both wallet types) also asserts
  this explicitly and throws an internal-invariant error if it's ever violated, so a future
  change to the qualifying filter can't silently regress into CPFP-ing an unverified or
  immature mining reward. No behavior change for the normal unconfirmed-CPFP case.

### 18.5 Unconfirmed-spend rules `[emulator]`
1. Receive an unconfirmed deposit from a **stranger** (external send, not yet mined). Build
   an ordinary send.
   - **Expected:** auto-selection **excludes** the stranger's unconfirmed coin
     (`unconfirmedTrust='received'`). It is not spent unless explicitly coin-controlled.
2. Broadcast a send that produces your **own** unconfirmed change, then immediately build a
   second send that needs it.
   - **Expected:** the two-pass "prefer confirmed" selector uses own-unconfirmed-change
     (`unconfirmedTrust='own-change'`) **only** when confirmed coins can't cover
     amount+fee — and it is allowed to.
3. **Coinbase maturity:** a coinbase UTXO with <100 confirmations is dropped from
   auto-selection; explicitly coin-controlling an immature coinbase gives a **clear error**;
   an `'unknown'` coinbase status (failed chain fetch) is treated conservatively as
   possibly-immature.
4. **Coinbase maturity, tip unknown (`cairn-oae1.1`, fail-closed):** with a coinbase coin
   present, simulate a `getTip()` failure (e.g. point at a dead tip source). Build an
   ordinary send.
   - **Expected:** the coinbase coin is **excluded** from auto-selection (not silently
     included just because the tip couldn't be checked); a send using only non-coinbase
     coins is **not blocked**. Coin-controlling the coinbase coin explicitly is **rejected**
     with *"Can't verify this mining reward is ready to spend right now — try again in a
     moment."*
- **PASS:** stranger-unconfirmed never auto-selected; own-change used only as confirmed
  fallback; immature coinbase blocked with a clear message; a tip-fetch failure fails
  CLOSED for coinbase coins specifically, never open, and never blocks an otherwise-ordinary
  send.

### 18.5a Inbound double-spend / RBF'd-away reconciliation `[emulator]` — regression guard (`cairn-a2p1`)
Precondition: an unconfirmed inbound deposit to a watched wallet has already fired
`tx_received` (i.e. its `notified_txids` row is `'notified'`, not `'pending'`).
1. Double-spend or RBF-replace-away that inbound tx (regtest: rebroadcast a conflicting tx
   spending the same input(s) at a higher fee, then mine past it) so the original txid
   disappears from both mempool and the chain.
2. Let the watcher's next rescan run (block-tip / mempool history reconciliation, not a
   bare "not found" check — see §4's `addressWatcher.ts` lifecycle note).
   - **Expected:** the `notified_txids` row transitions `'notified'` → `'replaced'`, and a
     correcting `tx_replaced` notification ("Incoming payment cancelled") fires — in-app by
     default, level `warn`.
3. Open the wallet's detail page.
   - **Expected:** the cancelled tx shows as an amber "Cancelled" row (`cancelled-row` /
     `cancel-badge` in `src/routes/(app)/wallets/[id]/+page.svelte`), distinct from both a
     normal pending and a confirmed row — **not** red/error styling, since this is a
     correction, not a failure of Cairn's.
4. Check `/activity`.
   - **Expected:** the correcting `tx_replaced` event appears in the feed, so a user who saw
     the original "payment received" notification also sees the correction, not just a
     silent balance change.
5. Repeat with a `'pending'` (never-yet-notified) inbound that gets replaced away instead.
   - **Expected:** the row transitions to `'dropped'` (silent) — no correcting notification,
     since nothing was ever surfaced to correct in the first place.
- **PASS:** balance reflects the disappearance either way; a previously-notified payment
  gets a correcting `tx_replaced` notification + amber wallet-detail row + `/activity` entry;
  a never-notified one is dropped silently with no spurious "cancelled" message.

### 18.6 Coin control `[emulator]`
1. At `/wallets/{id}/send`, open Coin Control (`coin_control` flag) and hand-pick UTXOs.
   - **Expected:** only the chosen coins are spent; `onlyUtxos` overrides normal
     eligibility (can include an own-unconfirmed coin) but still refuses an immature
     coinbase with a clear error.
2. Deliberately coin-control a coin already reserved by another in-flight draft.
   - **Expected:** a **non-blocking `reservationWarning`** naming the colliding draft id(s)
     — the send still proceeds (intentional, for RBF/respend).
- **PASS:** exact chosen coins used; reservation collision surfaces as a warning, not a hard
  block.

### 18.7 Draft dedup guarantee (testable assertion) `[emulator]`
1. Build two drafts on the same wallet with identical recipient/amount/fee-rate/coins so
   they finalize to the **byte-identical** transaction (deterministic RFC6979 signing).
2. Broadcast the first (→ `completed`, real txid). Broadcast the second.
   - **Expected:** the second is recognized as a completed-duplicate (`findCompletedDuplicateId`
     checked **twice** — before the network call and after) and recorded via
     `markDuplicateBroadcast()` reusing the **`superseded`** status. Exactly **one**
     `completed` row carries the txid; no N-phantom-sends.
- **PASS:** one `completed`, the rest `superseded`; only one real broadcast hit the network.

### 18.8 Concurrent-draft serialization guarantee (testable assertion) `[emulator]`
1. Fire two `buildDraft` requests for the **same wallet** concurrently (two browser tabs
   submitting the send form at once, or two rapid POSTs to the build endpoint) when only
   enough confirmed coins exist for one.
   - **Expected:** `withLock('wallet:<id>')` serializes them — they do **not** both pick the
     same coin; the second either reserves different coins or reports insufficient funds.
2. Repeat for two **different** wallets concurrently — these must NOT serialize against each
   other (lock is keyed by walletId).
- **PASS:** same-wallet builds never double-reserve one coin; different-wallet builds run in
  parallel.

### 18.9 Broadcast txid verification + commitment check (testable assertion) `[emulator]`
1. After signing, verify the **commitment check**: if a tampered signed PSBT that pays a
   different destination or spends different coins is uploaded, `assertSameTransaction`
   **refuses** it before broadcast.
2. On a successful broadcast, the Electrum-reported txid must equal Cairn's locally-computed
   deterministic txid — a mismatched/fabricated success txid is refused (cairn-ziwm).
- **PASS:** tampered PSBT rejected; only a matching-txid broadcast is recorded `completed`.
  This claim is **currently true** (re-verified post-hardening-wave, `cairn-u2r5`/`cairn-vo6z`,
  both closed) — see §18.9a for the enforcement detail and the specific tamper shapes it
  covers, which go beyond the destination/coin-set commitment check above.

### 18.9a Tampered/non-standard finalization is rejected, not just recomputed-txid mismatch `[emulator]`
Prior to this hardening wave, `assertSameTransaction` only pinned inputs/outputs — it never
inspected the actual signature/finalization bytes a "signed" PSBT carried, so two narrower
tamper shapes could still slip through the commitment check. Both are now closed:
- **Single-sig (`bitcoin/psbt.ts`):** `finalizePsbt` enforces `SIGHASH_ALL` (trailing byte
  `0x01`) on every partial signature before finalizing — a signer returning `SIGHASH_NONE`/
  `SIGHASH_SINGLE`/`ANYONECANPAY` is rejected, not silently finalized into a transaction whose
  signature doesn't actually commit to everything the user reviewed. The rejection is
  surfaced at broadcast (`transactions.ts` catches `PsbtSighashError`/
  `PsbtNotFullySignedError` from `finalizePsbt` and returns a plain-language re-sign message,
  not a raw exception).
- **Multisig (`bitcoin/multisigPsbt.ts`):** both `combineMultisigPsbts` (the two entry points
  where an incoming cosigner PSBT is merged) and `finalizeMultisigPsbt`'s pre-loop now
  validate any *pre-existing* finalization fields (`finalScriptWitness`/`finalScriptSig`)
  structurally — script binding, DER encoding, `SIGHASH_ALL` trailing byte, and quorum
  signature count — before treating an input as already-finalized, throwing
  `MultisigPsbtError('invalid_finalization')` otherwise. Previously a cosigner could attach
  garbage `finalScriptWitness` with zero real signatures and it would be copied through
  verbatim, durably marking the draft "ready to broadcast" when it wasn't (availability DoS
  — only the owner deleting/rebuilding could recover). Fixed at both combine entries **and**
  the finalize pre-loop so neither path can be used to smuggle a tampered finalization past
  the other.

**Scenarios:**
1. Sign a single-sig PSBT with a test signer forced to emit `SIGHASH_NONE` (or `SIGHASH_SINGLE`)
   instead of the default `SIGHASH_ALL`, then upload it for broadcast.
   - **Expected:** broadcast refuses with a plain-language "re-sign with the default
     (SIGHASH_ALL) setting" message — never finalizes, never reaches the network.
2. On a multisig draft, hand-craft a cosigner PSBT whose `finalScriptWitness` is garbage
   (not a real quorum of `SIGHASH_ALL` signatures over the correct `witnessScript`) and
   submit it both (a) as the incoming PSBT to combine, and (b) already sitting on a PSBT
   passed directly to `finalizeMultisigPsbt`.
   - **Expected:** both paths throw `invalid_finalization` — refused at combine **and**
     refused at finalize; neither path adopts the tampered finalization.
3. Import a PSBT that Bitcoin Core itself already finalized legitimately (e.g. via
   `walletprocesspsbt`/`descriptorprocesspsbt`, real quorum signatures, correct
   `witnessScript`/`redeemScript`).
   - **Expected:** this is **not** rejected — the structural check passes and the
     already-finalized input is adopted normally. The gate distinguishes tampered
     finalization from a legitimately-finalized import.
- **PASS:** scenario 1 refused with a re-sign message; scenario 2 refused at both combine and
  finalize; scenario 3's legitimate Core-finalized import still succeeds. **Residual scope**
  (not a gap in this scenario, just don't overclaim it): validation is structural (script +
  encoding + count), not full cryptographic signature verification against the descriptor's
  actual pubkeys — tracked as a separate P3 hardening follow-up, not required for this PASS.

### 18.10 Fee-rate ceiling + send-max `[none]/[emulator]`
1. Enter a fee **rate** above `MAX_FEE_RATE = 1000` sat/vB (or a sats-total fat-fingered
   into the rate field) → **Expected:** rejected with a clear message (backstop).
2. Choose **send-max ("sweep")** as the sole recipient → spends every eligible/selected
   coin, `amount = totalIn - fee`. Send-max with a second recipient is invalid.
- **PASS:** over-ceiling refused; send-max valid only as sole recipient.

---

## 19. Hardware wallet signing procedures

Secure-context requirement applies to every USB/live-device row (§19.6). Air-gapped
file/QR flows (ColdCard, Animated-QR) work over plain HTTP.

**Multisig parity, verified.** Live-USB signing is wired into the multisig send/sign page
at full parity with single-sig — confirmed by reading
`src/routes/(app)/wallets/multisig/[id]/send/+page.svelte`, which imports and mounts
`TrezorSigner`, `LedgerSigner`, `BitboxSigner`, and `JadeUsbSigner` directly (the same
components used by the single-sig send flow, `src/lib/components/signing/*`), each
accepting an optional `multisig` context object. This is real device-side multisig
support, not just wiring reuse: BitBox02 and Ledger each implement an on-device multisig
**registration** ceremony before they'll co-sign (`maybeRegisterMultisig()` /
`btcIsScriptConfigRegistered()` for BitBox02; an on-device BIP-388 wallet-policy review
persisted as an HMAC in `ledger_multisig_registrations` for Ledger — §19.2/§19.4), and
Jade's USB driver does the equivalent one-time registration (§19.5). `MultisigFileSigner`
(the generic PSBT-file round-trip) remains the only path for devices with no live driver
in this codebase (ColdCard) and for the inherently air-gapped camera/QR devices
(SeedSigner, Passport, Keystone) — the same split that already applies to single-sig, not
a multisig-specific limitation.

### 19.1 Trezor — emulator `[emulator]`
Precondition: vault-e2e up; `node setup-trezor.mjs` run this session; `hw_trezor` flag on.
1. Wallet create `/wallets/new` → Key step → pick **Trezor** → read xpub. The BIP-48/BIP-84
   xpub + master fingerprint are read live and stored on the `wallets` row.
2. Send `/wallets/{id}/send` → Sign step → Trezor tile (offered by `deviceSignMethods`).
   Trezor returns **per-input signatures** which Cairn merges (`mergeTrezorSignatures`).
3. Broadcast.
- **PASS:** the send confirms; the Trezor tile was `available:true` and signing merged.
- Multisig: same device, the driver handles both single-sig and multisig in one file
  (`TrezorSigner.svelte`) — repeat at `/wallets/multisig/{id}/send` to cover the multisig
  leg; see the parity note above.

### 19.2 Ledger — Speculos emulator `[emulator]`
Precondition: Speculos up (`node speculos-check.mjs` green), app-bitcoin-new 2.4.6;
`hw_ledger` flag on.
1. Read the account xpub + master fingerprint via the Ledger tile.
2. **Multisig policy registration (persisted server-side):** first multisig sign triggers a
   one-time on-device BIP-388 wallet-policy review; the returned HMAC is stored in
   `ledger_multisig_registrations` (`UNIQUE(multisig_id, master_fp)`, upsert). Verify a row
   appears after registration; re-signing does not re-prompt policy review.
3. Sign (per-input sigs merged like Trezor) + broadcast.
- **PASS:** multisig registration row persisted; subsequent signs skip re-approval; send
  confirms.

### 19.3 ColdCard — air-gapped file `[emulator]`
Precondition: `cc-sign.mjs` available (vault-e2e); no live driver — pure PSBT file
round-trip; works over plain HTTP (no secure context needed).
1. Build a draft; at the Sign step choose **ColdCard / Other-file** (the never-gated `file`
   fallback is always present — "a wallet is never a dead-end viewer").
2. Download the unsigned PSBT → sign with `cc-sign.mjs` (or a real ColdCard) → upload the
   signed PSBT back (`ColdCardSigner` / `MultisigFileSigner`).
3. Broadcast — `assertSameTransaction` guards the returned file.
- **PASS:** file round-trip signs and broadcasts; the universal `file` method is offered
  even when every hardware tile is unavailable. This is true for both single-sig and
  multisig — ColdCard has no live USB driver in either flow (by design, see the parity
  note above), so the file round-trip is its canonical procedure in both.

### 19.4 BitBox02 — real device `[real-hw]`
No emulator in the vault-e2e stack — physical device required. `hw_bitbox02` flag on.
1. **p2pkh guard:** for a legacy (p2pkh) single-sig wallet the BitBox02 tile is present but
   `available:false` with reason "The BitBox02 doesn't support legacy (P2PKH) single-sig
   wallets" — it never silently disappears.
2. **Wrong-device guard:** signing verifies the connected device's xpub/fingerprint matches
   the expected cosigner key (`assertBitboxIsExpectedKey`) before registering or signing.
3. **Multisig on-device registration:** `maybeRegisterMultisig()` checks
   `btcIsScriptConfigRegistered()` and runs the on-device "verify quorum + every cosigner
   key" ceremony only if not already registered (idempotent — re-signing never re-prompts).
   Registration lives **on the device only** (nothing server-side) — a browser-data wipe
   re-triggers the one-time approval.
4. BitBox02 is the **outlier**: `btcSignPSBT` returns the **whole signed PSBT** (no
   per-input merge).
- **PASS:** p2pkh tile disabled-with-reason; wrong device refused; first multisig sign
  prompts on-device registration once, later signs don't; single-sig (segwit) + multisig
  sends confirm.

### 19.5 Jade — real device `[real-hw]`
Physical Blockstream Jade required (USB and QR/air-gapped variants; `hw_jade` flag). USB
variant needs secure context (§19.6); the QR variant (`JadeQrSigner`/`jadeUr.ts`) is
air-gapped over plain HTTP.
1. Read xpub → build draft → sign via `JadeUsbSigner` (USB) or the QR round-trip → broadcast.
- **PASS:** send confirms via the chosen Jade transport.

### 19.6 Secure-context / HTTPS requirement check `[none]`
Browsers withhold WebHID/WebUSB/WebSerial and camera on insecure (plain-HTTP) origins —
Umbrel's default. Verify:
1. Open a Sign step over the plain-HTTP origin (Umbrel `:3211`, or local `http://…`).
   - **Expected:** `SecureContextHelp` appears (only when the page is an insecure context
     AND the server reports `httpsPort`), naming the gated capability ("USB signing",
     "camera scanning"), with an **"Open the secure address"** link to
     `https://{hostname}:{httpsPort}{path}` and plain-language guidance about the expected
     self-signed cert warning ("Advanced → Continue…", remembered ~a week) and that
     **passkeys work on the self-signed address** — it's the only secure-context surface, so
     the one place a browser runs the ceremony (cairn-ib7w).
2. On Umbrel the secure link targets host **4488** (mapped to container 3443) via
   `CAIRN_HTTPS_EXTERNAL_PORT`. Click through once.
3. **Auto-hop for returning users:** on a later visit, `secureRedirect.ts` silently hops to
   the HTTPS origin (a `no-cors` probe that only resolves if the cert was already accepted).
   Escape hatch: append `?insecure=1` to suppress the hop for the tab session. Exception:
   the hop never fires while the path is under `/wallets/new` or `/wallets/multisig/new` —
   those wizards keep resume state in origin-scoped `sessionStorage`, which a cross-origin
   hop would silently discard (`cairn-01gq`).
- **PASS:** insecure context shows the helper + link; after accepting the cert, USB tiles
  become `available:true`; returning-user auto-hop works outside the wizards and stays
  suppressed inside them; `?insecure=1` suppresses it everywhere.

### 19.7 Master-fingerprint presence check `[emulator or real-hw]`
Regression guard for cairn-alw8 (HW signing was always broken when no master fingerprint
was ever stored).
1. After creating a wallet from any device, inspect the wallet: it must have a
   `master_fingerprint` + `derivation_path` (single-sig) or per-key fingerprint/path
   (multisig).
2. Build a draft — the constructed PSBT must embed `bip32Derivation` on inputs + change so
   the signer can locate its key.
- **PASS:** fingerprint/path stored; PSBT carries `bip32Derivation`; the device finds its
  key and signs. A wallet with no stored fingerprint that then fails to sign is the cairn-alw8
  regression (FAIL).

---

## 20. Stress & edge-case scenarios

### 20.1 Multiple wallets — portfolio sanity `[emulator or mainnet]`
1. Create several single-sig + multisig wallets; open `/wallets` and `/` (portfolio).
   - **Expected:** list/detail render from `wallet_snapshots` (SWR) synchronously; a real
     cached balance is never replaced by a fake zero (`portfolioViewState`: `lastSyncedAt`
     wins over `refreshFailed` → `'ready'`/`'unreachable'`/`'first-sync'`).
   - **Dashboard Send/Receive with 2+ wallets (`cairn-5yz3.2`):** the hero pills no longer
     dump straight to `/wallets`. With exactly one wallet they still deep-link straight to
     it (unchanged). With 2+, clicking either pill opens a lightweight inline chooser
     (`src/routes/(app)/+page.svelte`, `.wallet-picker`) anchored under the pills, listing
     every wallet by name + balance — Send rows link to that wallet's `/send` page, Receive
     rows to its detail page. Closes on Escape, an outside click, or picking a row. The
     `/wallets` full-list fallback still exists (no-JS/direct-link safety net) but is no
     longer the everyday path for multi-wallet accounts.
- **PASS:** all wallets show; no wallet flips to a false 0 balance on a transient refresh
  failure. **Caveat (`cairn-kxhv`, open):** this PASS bar assumes the wallet's real activity
  fits inside `gapLimitScanner`'s `HARD_CAP = 400` (per chain — receive/change). A wallet
  with legitimate address activity past index 399 (a heavy long-lived wallet, or one
  restored from software using a larger gap limit) has its scan **silently truncated** —
  no log, no flag, no user-facing warning — and the balance shown will be an undercount of
  coins that are still on-chain and unspendable through Cairn. This scenario does not
  exercise that depth; treat a wallet believed to have >400 consecutive addresses used on
  either chain as a separate, not-yet-covered case, not an automatic PASS.

### 20.2 Concurrent draft builds on one wallet (serialization) `[emulator]`
- Same as §18.8. **PASS:** `withLock('wallet:<id>')` prevents two concurrent builds from
  reserving the same coin.

### 20.3 Duplicate broadcast attempts (dedup) `[emulator]`
- Same as §18.7, plus: fire two concurrent broadcasts of the **same draft row**.
  - **Expected:** the atomic `broadcast_started_at` claim lets only one reach the network;
    the loser sees `already_sent`. A stale claim (crash mid-broadcast) expires after 60s.
- **PASS:** one network broadcast; concurrent same-row loser is blocked, not double-sent.

### 20.4 Electrum server down / flaky — chain health degradation UX `[none]`
1. In `/settings` (admin Node-connection group) point Electrum at a dead/black-holing host
   and save (triggers `reconfigureChain()`).
   - **Expected:** after `UNHEALTHY_AFTER = 2` consecutive connect failures, the instance-
     wide `ChainHealthBanner` ("can't reach the Bitcoin network") appears; the initial dial
     is bounded by the connect-timeout (`armConnectTimeout`, cairn-vn48 — no infinite hang).
   - A flapping connection does **not** spam admins: the outage alert is 60s-debounced
     (`OUTAGE_GRACE_MS`) and latched.
   - **SSR on first paint (`cairn-favlc`, v0.2.41):** `ChainHealthBanner` was previously
     100%-client-JS-rendered (the live `chainHealth.svelte.ts` store's `.health` getter is
     hard-coded `null` during SSR) — a no-JS or pre-hydration fetch of `/` during an outage
     could never show the chain-down copy. `(app)/+layout.server.ts` now calls
     `getNetworkHealth()` and passes it down as `initialHealth`; the banner falls back to it
     whenever the live store hasn't seeded yet (`chainHealth.health ?? initialHealth`), so
     the correct verdict renders in the very first server response, not just after
     hydration.
2. With chain unreachable, load `/` and `/explorer`.
   - **Expected:** balances serve **stale-but-served** snapshots (fail-open); explorer shows
     the "Can't reach chain data" path with the **real** underlying cause surfaced (DNS/TLS/
     refused), not a generic "fetch failed" (cairn-s17j).
3. Payment notifications: while unreachable, **no** `tx_received`/`tx_confirmed` fires
   without SPV proof (fail-closed — never a fake alert).
4. Restore a good Electrum host → banner clears, `network_up` activity recorded.
- **PASS:** banner appears only after 2 failures, no hang, snapshots stay served, no fake
  payment notification, real cause shown, recovery clears the banner.

### 20.5 App restart mid-wizard — sessionStorage resume `[none]`
1. Start `/wallets/new`, advance to Verify (validated xpub + derived addresses shown).
2. Full-page reload (simulates Umbrel auth-layer forced reload).
   - **Expected:** the wizard offers to resume from the `sessionStorage` snapshot
     (`cairn.add-wallet-wizard.v2`, PUBLIC key material only, ≤1-hour age). A malformed/stale
     snapshot yields `null` and clamps `step` to 0 (never wedges).
3. Repeat for the multisig wizard (`cairn.multisig-wizard.v1`) — note it deliberately does
   **not** restore the in-progress "add one key" sub-form (a dead device connection can't
   survive reload; restoring half-typed text would look like resumable progress that isn't).
- **PASS:** single-sig resumes to the right step with public material intact; multisig
  resumes collected keys but not the half-entered key form; stale/bad snapshot never wedges.
- **Gotcha for the tester:** the two `wizardProgress.ts` files share exported names but are
  NOT shared — verify against the correct wizard directory.

### 20.6 Reload mid-send — DB-row `?tx=` resume `[emulator]`
1. Build a draft at `/wallets/{id}/send` (now `?tx={draftId}` in the URL). Advance to Sign.
2. Reload the page.
   - **Expected:** `initialStep()` derives the landing step from the saved
     `SavedTransaction` row's lifecycle: `completed`→Sent, `awaiting_signature`→Confirm (if
     fully signed) else Sign, else Review/`draft`. The send resumes on the correct step, not
     step 1.
- **PASS:** the send resumes at the lifecycle-correct step after reload (unlike wizards,
  this resume is DB-backed, not sessionStorage).

### 20.7 Newly-created wallet watch lag `[emulator]` — fixed, verify current behavior
1. Create a wallet, fund it immediately (16.5), mine a block.
   - **Current behavior (`cairn-0tvez`, fixed `343c9f5`, v0.2.40):**
     `createWallet`/`createMultisig` call `refreshWatches()` synchronously at
     creation, so the wallet's addresses are subscribed before you even
     finish the funding step — no more waiting on the 5-minute
     `REFRESH_INTERVAL_MS` periodic pass for a brand-new wallet. The sync
     layer also no longer persists an empty snapshot for a not-yet-watched
     wallet, which previously could make a freshly funded wallet's own
     detail page show a permanently stale "0.00 BTC" (Part I §15 gotcha #9,
     historical).
- **PASS:** the deposit is credited and `tx_received`/`tx_confirmed` fire
  promptly (seconds, not minutes) after creation+funding+confirmation. If you
  observe multi-minute lag on a fresh wallet, that's a regression — file it,
  don't assume it's expected.

### 20.8 Large-wallet perf sanity `[emulator or mainnet]`
1. Use a wallet with substantial address history; open `/wallets`, `/`, and a wallet
   detail in quick succession.
   - **Expected:** navigation stays responsive. Background gap-limit scans run on the
     `background` Electrum lane and through the global `SCAN_CONCURRENCY` limiter, so they
     don't starve interactive requests; the address watcher yields (`setImmediate`) per
     wallet during enumeration so a big portfolio doesn't hog the event loop.
   - Watch for the historical sync-SQLite stutter (cairn-xlrm); rapid nav should not freeze.
- **PASS:** no multi-second UI freeze during rapid navigation on a large portfolio.

### 20.9 Notification flood check `[emulator]` — regression guard (cairn-3bt1)
1. Create/import a wallet that already has substantial **pre-existing** on-chain history,
   then let the watcher baseline it.
   - **Expected:** the startup/baseline pass records existing history as `confirmed=1` with
     **no** notification; only genuinely new inbound txids notify. A per-scripthash baseline
     failure quarantines that address (un-notifiable) until a retry succeeds, rather than
     leaking its whole history as "new".
2. Observe `/activity` and the notification panel.
   - **Expected:** no flood of false "payment received"/"confirmed" for old txs.
- **PASS:** zero false notifications for pre-existing history; new deposits still notify
  once each (dedup via `notified_txids`). **Caveat (`cairn-43dx`, open):** live push
  notifications only cover the first `WATCH_WINDOW = 30` addresses per chain from index 0,
  independent of the wallet's actual gap-limit cursor (§4). A deposit to receive/change
  index 31+ on a wallet with that much history fires **no** live `tx_received`/`tx_confirmed`
  push — it's still picked up correctly (and correctly reflected in balance) on the next
  portfolio-load gap-limit scan, so this is a notification-timeliness blind spot, not a
  balance-correctness one. Don't test this scenario only with a fresh, low-index wallet and
  assume it also proves live-notification coverage at higher indices.

### 20.10 Back-button / browser-history regression sweep `[none]`
Covers the five-commit fix series (`cairn-y7ac`, `4b98a1e`, `7fbbdd4`, `d22888c`, `a19dfa2`
— Part I §15 gotcha #12). Any future in-page "back" control belongs in this sweep too.
1. Navigate to `/explorer/tx/[txid]` (or `/explorer/address/[address]`,
   `/explorer/block/[id]`, `/explorer/mempool`, `/explorer/mempool/blocks`,
   `/explorer/difficulty`) from `/explorer`, then use the in-page back control repeatedly.
   - **Expected:** lands back on `/explorer` on the first press; no alternation loop.
2. Open a wallet mid-first-sync (or navigate to `/sync` via the persistent `SyncBanner`'s
   "View details" link), then use "Back to Heartwood"/"Enter Heartwood".
   - **Expected:** leaves to `/` (or wherever the banner was opened from), not a loop
     between `/sync` and itself.
3. Open `/admin/users/[id]` for a specific user, then use the "All users" back-link.
   - **Expected:** lands on `/admin/users`, no loop.
4. During a **mandatory** (forced) `/recovery-setup` flow, check for a back control.
   - **Expected:** no back affordance is offered at all — this is a `[none]`-env absence
     check, not a navigation check (`a19dfa2` suppresses the control rather than fixing
     its target, since back shouldn't be offered mid-mandatory-setup).
- **PASS:** none of the four checks above loop; check 4 confirms absence, not a working link.

### 20.11 BIP21 payment-URI paste `[none]` — expected-fail / verify current behavior
Ties to Part I §15 gotcha #11. `parseBip21()` (`src/lib/bip21.ts`, commit `41545b9`) is
fully unit-tested but not wired into any page as of current HEAD.
1. On `/wallets/{id}/send` (Create step), paste a `bitcoin:`-scheme payment URI (e.g.
   `bitcoin:bc1q...?amount=0.001&label=Test`) into the recipient field
   (`RecipientCombobox.svelte`).
   - **Documented behavior:** the URI is treated as a plain string, not parsed — no
     auto-fill of amount/label. `RecipientCombobox` has no `bitcoin:`-scheme handling and
     nothing on this page imports `parseBip21`.
- **PASS (verify current behavior):** confirm the paste does **not** auto-fill anything
  (matches gotcha #11). Do **not** record this as a bug on its own — it's a known gap. If a
  future commit wires `parseBip21` into this field, this scenario flips to a real PASS/FAIL
  check on the auto-fill behavior instead, and gotcha #11 should be marked resolved.

### 20.12 QR scanner (`QrScanner.svelte`) direct coverage `[real-hw]` / `[none]`
Commit `96cd16a` extracted the shared `QrScanner`/`qrScannerLogic.ts` behind `QrSigner`
(BBQr) and `JadeQrSigner` (BC-UR) — see §9 and §19.5. §19.5 only asserts the end-to-end
Jade send confirms; this scenario exercises the shared component's own behavior.
1. `[real-hw]` On `/wallets/{id}/send` (Sign step), open a QR-capable device tile on a
   camera/browser combination that supports `track.getCapabilities().torch`.
   - **Expected:** a torch/flashlight toggle appears and functions.
2. `[real-hw]` Repeat on a camera/browser without torch capability.
   - **Expected:** no torch toggle rendered (progressive enhancement, not an error).
3. `[none]` Deny camera permission (or on a device with no camera), then use the
   paste-fallback text field instead.
   - **Expected:** frame/base64 paste-fallback still works identically to before the
     extraction (byte-for-byte per the refactor's own "zero behavior change" claim).
4. `[none]` Open the QR scanner over plain HTTP (no HTTPS listener reachable).
   - **Expected:** `SecureContextHelp` gates the camera the same way it gates USB in §19.6.
- **PASS:** torch toggle behaves per capability (1-2); paste-fallback unaffected (3);
  insecure-context gating matches §19.6 (4).

### 20.13 Multisig collaborator management UI `[none]`
`MultisigCollaborators.svelte`
(`src/routes/(app)/wallets/multisig/_components/MultisigCollaborators.svelte`) has no
scenario that walks the share/revoke UI directly — §17.2/17.5/17.6 test the underlying
access model, not this component's own affordances.
1. On `/wallets/multisig/{id}`, open the share modal and attempt to invite a user who is
   **not** an accepted contact.
   - **Expected:** clear refusal — sharing requires an accepted `contacts` relationship
     first (§7).
2. Invite an accepted contact as a viewer, then change their role to cosigner.
   - **Expected:** role updates visibly; pending-vs-accepted share state is distinguishable
     in the UI.
3. Revoke the share.
   - **Expected:** the collaborator loses access (verify via §17.5/17.6's boundary checks).
- **PASS:** refusal in step 1 is clear and non-technical; role change and revoke in
  steps 2-3 are reflected correctly in the UI.

### 20.14 Umbrel zero-config Electrum auto-connect probe `[none]`
Covers Wave A (`umbrelProbe.ts`, `docs/UMBREL-AUTOCONNECT-DESIGN.md`) — the credential-free
probe that runs alongside (and after) `chainEnvSeed.ts`'s env-var seed (§4 step 4, §12). Both
sub-scenarios need `CAIRN_PLATFORM=umbrel` set and a fresh `settings` table (no
`connection_mode` row yet — see 16.6 to reset).
1. **Auto-connects when reachable.** Boot Cairn with `CAIRN_PLATFORM=umbrel` set, no
   `CAIRN_ELECTRUM_*`/`CAIRN_CORE_RPC_*` env vars, and a real electrs (or Fulcrum) instance
   reachable at the well-known Umbrel Docker-network IP (`10.21.21.10:50001` for electrs;
   `10.21.21.200:50002` for Fulcrum if electrs isn't running) — the regtest stack's `electrs`
   container (16.4) re-addressed/port-forwarded to one of those IPs works for this, or run
   the real Umbrel target (16.3).
   - **Expected:** boot log's "startup config honored" line shows the Electrum host/port
     seeded this boot; `/settings` (admin Node-connection group) shows Connection mode =
     Custom with the probed host/port and an "auto-connected" indicator. Query the `settings`
     table (or the Settings page) to confirm `chain_provisioned_by = 'umbrel-probe'`.
2. **Untouched when nothing is reachable — wizard still works.** Boot the same way but with
   neither `10.21.21.10:50001` nor `10.21.21.200:50002` reachable (nothing listening, or
   blocked).
   - **Expected:** boot succeeds normally (probe never throws); `connection_mode` stays
     unset and Cairn falls back to the public-server default
     (`electrum.blockstream.info:50002`). `/settings` (admin Node-connection group) shows
     Connection mode = Public, no auto-connected indicator, `chain_provisioned_by` stays `null`.
   - Then manually walk `/settings#node-connection` → Custom connection → enter an Electrum
     host by hand and save.
   - **Expected:** the manual entry works exactly as it does today (§12's "Settings stored in
     DB vs env" boundary) — the probe having run and found nothing does not block or alter
     the manual wizard/form path in any way.
- **PASS:** scenario 1 shows the probed host live with the correct provenance stamp;
  scenario 2 boots clean with the public default active and the manual custom-connection
  form still fully functional.
- **Cleanup:** stop any electrs/Fulcrum test listener; unset `CAIRN_PLATFORM`; reset
  `connection_mode`/`electrum_host`/`chain_provisioned_by` via 16.6 or a fresh DB.

### 20.15 Never-configured vs. configured-but-unreachable — banner tone `[none]`
Covers `cairn-7zjo` (fixed `c90481f`/`85a24da`, 40 unit tests in `28df11a`, §9). Two visually
distinct unhealthy states must never be confused — do this alongside 16.6's DB reset so
`connection_mode` genuinely has no row yet, not just "set to public."
1. **State 1 — never configured.** Fresh DB, no `connection_mode` row, `chain_provisioned_by`
   unset (a true fresh install, not a reset-to-default). Load `/` as both an admin and a
   regular user, desktop and mobile (375x812).
   - **Expected:** a single calm, neutral-toned banner ("Heartwood isn't connected to the
     Bitcoin network yet") — `.neutral` surface-tone styling, **not** red. Admin sees a
     "Connect a node" link to `/settings#node-connection`; non-admin sees "ask your instance
     operator" copy, no link. `SyncBanner` is absent from the DOM (suppressed, since
     `deriveSyncStatus`
     reaches phase `'unreachable'` for this state too — one banner, not two).
2. **State 2 — configured but unreachable** (this is 20.4's scenario). An admin has explicitly
   set `connection_mode` (even to `'public'`) or Umbrel auto-connected
   (`chain_provisioned_by` set), and the endpoint is now genuinely unreachable.
   - **Expected:** the original red "can't reach the Bitcoin network" `ChainHealthBanner`,
     per 20.4. `neverConfigured` is `false` here even though `healthy` is also `false` — the
     distinguishing signal is `chain_provisioned_by`/`connection_mode`, not reachability alone.
- **PASS:** state 1 reads as an expected setup step, not an error, for both roles at both
  breakpoints, with only one banner visible; state 2 still reads as a real fault (20.4's PASS
  criteria). Don't test these two against the same DB row-state — they're distinguished by
  `isChainNeverConfigured()`'s two independent conditions, not by whether the chain currently
  answers.

### 20.16 Umbrel Bitcoin Core detect-and-connect card (Wave B) `[none]`
Covers `umbrelCoreProbe.ts` (Wave B Unit B1) and the assisted-connect card, now in
`/settings`'s admin Node-connection group (moved verbatim from the deleted `/admin/settings`,
UX Simplification Wave 2, `cairn-6c91u.2`; Unit B3, `docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md`,
`cairn-6uok`/`cairn-3p9z` fixed). Distinct from 20.14 — that scenario is the Electrum
auto-*connect* probe; this one is Core RPC detect-and-*surface only* (bitcoind's RPC
always needs a password Cairn is never handed automatically, so it can't silently
auto-connect the way Electrum does).
1. Boot with `CAIRN_PLATFORM=umbrel` and something answering at the well-known
   Umbrel bitcoind address (`10.21.21.8:8332`) — the regtest stack's `bitcoind`
   re-addressed/port-forwarded there works, or use a real Umbrel target (16.3).
   With `core_rpc_url` still unset, load `/settings#node-connection`.
   - **Expected:** a "Bitcoin Core detected on your Umbrel" card renders (`settings.
     core_rpc_detected === 'umbrel' && !coreRpcConfigured()`), with the RPC address/
     username already filled in (`UMBREL_CORE_RPC_URL`/`UMBREL_CORE_RPC_USER`,
     hidden fields) and just a password field to fill in.
2. Paste the correct RPC password and click **Connect**.
   - **Expected:** posts to the same `save` action with a hidden
     `coreRpcAssisted=umbrel` marker, which runs `testCoreRpc()` **before**
     persisting anything (fails closed on a bad password — `form.coreRpcTest.ok
     === false` renders inline, nothing is saved) and, on success, persists
     `core_rpc_url/user/pass` and stamps `core_rpc_provisioned_by =
     'umbrel-detect'`. The card is replaced by "Connected to your Umbrel's Bitcoin
     Core". Verify `connection_mode` (the Electrum toggle) is unchanged by this —
     the assisted-connect branch returns before reading it, unlike the old
     `useDetectedCoreNode()` workaround it replaced.
3. Reset (`core_rpc_url` unset again, `core_rpc_detected='umbrel'`) and this time
   click **Dismiss** instead of connecting.
   - **Expected:** posts to `?/dismissCoreDetection`, writes `core_rpc_detected =
     'dismissed'` — a purely cosmetic marker never consulted by `getChainConfig()`
     — and the card stops rendering. Nothing about Core RPC connectivity itself
     changes; this only silences the nudge (covers the design doc's "Core
     uninstalled later" stale-banner case).
4. With `core_rpc_url` already configured (from step 2, or configured any other
   way), reload `/settings#node-connection`.
   - **Expected:** the Bitcoin Core RPC subgroup renders unconditionally
     regardless of `connectionMode` (public or custom) — `cairn-3p9z` fixed the
     prior bug where these fields were only reachable after flipping to custom
     Electrum mode. Submitting the general Electrum-mode fields alongside
     unrelated Core RPC fields still persists both correctly per the "field
     absent = leave unchanged, present = write/clear" contract (`cairn-6uok`).
- **PASS:** card appears only when genuinely detected-and-unconfigured; Connect
  fails closed on a bad password and never half-persists; Dismiss is purely
  cosmetic; Connect/Dismiss never mutate `connection_mode`; Core RPC fields are
  reachable and function the same in both public and custom Electrum modes.

### 20.17 1yr/all-time balance horizons survive a data-retention purge `[none]` — regression guard (`cairn-ht11`, v0.2.29)
`dataRetention.purgeBalanceSnapshots` hard-deletes `balance_snapshots` rows past
~13 months. The one-time-per-wallet backfill (`buildBackfillPoints`) writes a
single carry-in point at the 1yr-horizon edge for a wallet imported with older
history — and since backfill never re-runs once any row exists, that fixed-in-
time anchor point eventually falls out of the retention window on some later
sweep, at which point `all` (which always reads `series[0]`) used to silently
report the change since whichever row happened to survive instead — wrong, not
an honest "no data", and could even flip sign.
1. Seed a wallet with tx history older than 13 months (script pattern:
   `scripts/qa/seed-r6-horizons.mjs`), let the one-time backfill run, then run
   (or simulate the effect of) `purgeBalanceSnapshots` aging the backfill's
   carry-in point out of `balance_snapshots`.
2. Load `/` (Home) and the wallet's detail page; read the **1yr** and
   **all-time** figures in `BalanceHorizons`.
   - **Expected:** both figures match what the wallet's own confirmed-tx
     history honestly reconstructs (`historyFromTxDeltas`/`changeWithTxFallback`
     in `src/lib/server/portfolio.ts`), not a value derived from whatever
     row of `balance_snapshots` happens to have survived the purge. **1d**/
     **30d** are unaffected by this scenario (retention always keeps the last
     30 days at full resolution) — verify they still read correctly too, as a
     control.
   - **Expected (fallback path):** if the tx history itself can't be trusted
     for a given wallet (missing timestamp on a confirmed tx, or deltas that
     don't reconcile with the scanned balance), the aggregate falls back to
     the persisted d365/all rather than guessing — this degrades to the
     pre-fix number for that one wallet's contribution rather than fabricating
     one; it's the same behavior as before the fix, not a regression on the
     honesty-check-fails path.
- **PASS:** 1yr/all-time stay accurate (or degrade honestly) across a
  retention purge; no sign flip, no silently-wrong "change since a random
  surviving row" figure.

### 20.18 Mining pool (multi-user solo) QA matrix `[emulator]` — epic `cairn-vn43`

Covers the in-process, multi-user solo engine (§8 "Mining engine" and §9
"Mining dashboard client" in Part I). As of this writing a QA wave is
actively adding dedicated scripts for this feature under `scripts/qa/` in
parallel with this doc update — check `ls scripts/qa/mining*` (or
`scripts/qa/*mining*`) for the actual current filenames/flags before
running anything below; treat the names here as the planned shape, not a
guarantee of the exact filename:

1. **Forced-solve harness against the real engine.** The existing
   `npm run mining:forced-solve-harness` (§13, `scripts/mining/
   forcedSolveHarness.mjs`) exercises `getblocktemplate`/`submitblock`
   directly against a **standalone reference** coinbase builder, not the
   in-process engine's own `job.ts`/`miningPool.ts` — that gap is the
   documented follow-up on `cairn-vn43.2`. A QA-wave script in this
   generation (planned name along the lines of `scripts/qa/mining-
   forced-solve*.mjs`) is expected to close that gap by driving a real
   Stratum TCP client through `mining.subscribe`/`mining.authorize`/
   `mining.submit` against the actual `MiningPool`, on regtest, and verify
   the resulting block on-chain (main-chain, ≥100 confs once matured, paid
   sats == `coinbasevalue`, paid to the connecting miner's own payout
   script — not a fixed/shared address).
   - **PASS:** forced solves against the live engine confirm on-chain with
     the correct per-miner payout, same invariants as §13's harness.
2. **Load test.** A companion script (planned name along the lines of
   `scripts/qa/mining-load-test*.mjs`, likely flags for miner/worker count,
   target share rate, and duration) should open many concurrent Stratum
   connections under distinct `mining_id`s and submit shares at a sustained
   rate, then check: the 15s aggregate flush keeps up without unbounded
   memory growth (§8's rolling-window prune/cap), no per-share DB writes
   occur (watch for `mining_workers`/`mining_stats` write volume — it
   should track the 15s cadence, not the share rate), and the admin
   dashboard's live figures stay consistent with what was actually
   submitted.
   - **PASS:** sustained multi-miner load doesn't degrade unrelated app
     requests (the `cairn-xlrm` sync-SQLite hazard this design is built to
     avoid), and post-run aggregate totals reconcile with shares sent.
3. **Flag-gate on/off.** With the `mining` feature flag off instance-wide
   (the Mining toggle in `/settings`'s admin groups, `#mining`): `/mining` and `/admin/mining` both render their
   flag-off empty state (`FeatureDisabled`-style, per `requireFeature`'s
   convention) regardless of `mining_enabled`, and `startMiningEngine()`
   never opens the Stratum port even if a stale `mining_enabled=true`
   setting is present from before the flag was turned off — the flag gate
   is checked first in `doStart()` and wins over the settings toggle.
   Turning the flag back on does **not** auto-start the engine by itself;
   the operator's `mining_enabled` setting (and a running Core RPC) still
   govern whether the pool actually listens.
   - **PASS:** flag off ⇒ both routes dark and the port never opens, no
     matter what `mining_enabled` says; flag on alone ⇒ still requires the
     separate operator toggle to actually start listening.
4. **Empty-state matrix (`/mining`).** Walk the precedence list in §9
   "Mining dashboard client" top to bottom with a fresh user: no wallet yet
   → engine stopped → not enabled → (with a wallet + enabled + engine
   running) full dashboard with a "waiting for your first share" hint on
   `MiningConnectionCard` before any miner has connected.
   - **PASS:** each state renders distinctly and in the documented
     precedence order; a user is never shown a blank/broken page for any
     combination of (has-wallet, engine-running, mining-enabled).
5. **Multi-user isolation.** With two distinct users (A and B) both
   enabled and each running a simulated miner under their own `mining_id`:
   confirm `GET /api/mining/me` for A never includes B's worker names,
   hashrate, shares, or blocks (and vice versa) — `getUserMiningView` scopes
   every query to the caller's own `userId`; this has a dedicated security
   test in `readModels.test.ts`, but re-verify at the HTTP layer too, not
   just unit level. Confirm `GET /api/admin/mining` (admin-only, 403 for a
   plain user) correctly shows **both** users' workers/blocks in the
   pool-wide view and attributes each to the right `userName`.
   - **PASS:** zero cross-user leakage on the per-user endpoint; the admin
     endpoint correctly attributes both users' activity and is unreachable
     by non-admins.
6. **Regenerate-ID caveat.** From `/mining`, use "regenerate" to rotate a
   user's `mining_id` while a simulated miner is actively connected/
   submitting shares under the **old** id.
   - **Expected:** the old id keeps resolving (shares keep being accepted)
     until the next `authTable` refresh — driven by the same
     `onPrefsChanged()` hook the regenerate action fires, so in practice
     this can flip within moments rather than the full 60s timer period,
     but don't assume it's synchronous with the button click. Once the
     snapshot rebuilds, any connection still authorizing with the old id is
     rejected `UNAUTHORIZED` and must reconnect with the new
     `<miningId>.<worker>` shown on the (now-updated) connection card.
     There is no grace period and no way to recover the old id once
     rotated — don't file this as a bug if a miner configured with the old
     id goes dark after a regenerate; that's the intended behavior.
   - **PASS:** old id stops working within one refresh cycle, not
     immediately-and-silently-broken (some in-flight shares under the old
     id before the refresh should still land) and not indefinitely valid
     either.
7. **Stratum V2 listener + admin surface (`cairn-qfez8.8`/`.9`/`.10`).** Run
   the SV2 unit/integration suites: `npx vitest run src/lib/server/mining/sv2`
   (covers `crypto`, `codec`, `frames`, `noise`, `authority`, `channels`,
   `sv2Server`, plus `parity.test.ts`'s V1/V2 byte-identical block-assembly
   assertion and `hardening.test.ts`) — all must be green before touching
   the UI. The SV2 forced-solve regtest e2e now exists at
   `sv2/forcedSolveSv2.e2e.test.ts` (Phase 5, `docs/SV2-IMPLEMENTATION-PLAN.md`,
   bead `cairn-qfez8.10`) — same shape as `../forcedSolve.e2e.test.ts`'s
   `describe.skipIf(!BITCOIND_AVAILABLE || !PORT_AVAILABLE)` gate and hermetic
   port allocation via `scripts/qa/mining-regtest-node.mjs`, but drives the
   engine directly in-process (no `--experimental-transform-types` child-process
   bootstrap needed). One regtest node + one `MiningPool` with both the V1
   standard listener and the SV2 listener enabled covers three cases: (a) an
   SV2 extended channel solving a real regtest block end to end (Noise
   handshake → solve → `submitblock` accepted → coinbase pays the winner's
   payout script exactly), (b) an SV2 standard channel (server-computed
   `merkle_root`) doing the same, and (c) V1 and V2 connected to the same pool
   simultaneously, each solving in turn under its own identity, with a
   stale-job SV2 share correctly rejected after a V1 solve invalidates it.
   Unlike the V1 driver it does not assert a `mining_blocks` DB row — `MiningPool`
   is deliberately DB-free, so that's left to the already-covered V1 e2e.
   `parity.test.ts`'s byte-identical block-assembly assertion remains
   additional coverage for "SV2 and V1 assemble the same block" at the unit
   level. Then, at `/admin/mining`: enable
   the "Next-generation miner connections (Stratum V2)" switch, save, and
   confirm (a) the engine reconfigures without a fatal error, (b) "Listening
   on" grows a third port, (c) reloading the page shows the toggle still on.
   At `/mining` (a non-loopback bind), confirm the connection card grows a
   third row with a `stratum2+tcp://host:port/<base58 pubkey>` string that
   copies correctly, and that the row disappears again when the admin turns
   SV2 back off or when the bind is loopback-only. Connect `sv2/testClient.ts`
   (or a real SV2-speaking miner) and confirm its connection badges "V2" —
   not "V1" — in the admin miners table, while an ordinary V1 connection on
   the same page still badges "V1".
   - **PASS:** SV2 off by default; enabling it never disturbs the two V1
     listeners; the connection string round-trips (copy → paste → a test
     client connects); the V1/V2 badge matches each connection's actual
     protocol; the row/badge honestly disappear when SV2 or LAN exposure is
     off.

---

## 21. UX evaluation checklist — new-Umbrel-user journey

One end-to-end pass as a brand-new Umbrel user. Pass criteria are drawn from the project UX
philosophy: plain language, no raw Bitcoin internals exposed, guided wizards, prominent
backups, clear house-standard errors, **never red for routine states**, working deep links.
`[none]` except the optional signing leg. Mark each checkpoint ✅/❌.

### 21.1 Install → first-run
1. Install Heartwood from the Umbrel store; open the app tile (host `:3211`).
   - ✅ The port answers immediately (503 "still starting" placeholder, never
     `ERR_EMPTY_RESPONSE`), then the real app.
2. Umbrel shows the derived credentials (`admin@cairn.local` + `${APP_PASSWORD}`).

### 21.2 Setup-admin (forced reset)
3. First login lands on `/setup-admin` (forced by `must_reset_password`).
   - ✅ Requires BOTH a **real (non-placeholder) email** and a **new password**, and
     refuses reuse of the bootstrap password.
   - ✅ Copy is plain-language about *why* (the install password was visible in Umbrel's UI).
   - ✅ Validation uses `--attention` warm-tan, **not red**, for routine "please choose a
     different password" states.

### 21.3 First wallet
4. `/wallets/new` — **Key → Verify → Finish**, a guided 3-step wizard.
   - ✅ Both "Add a wallet" and "Restore from a backup" land here (no indistinguishable
     entry points, cairn-rfuc).
   - ✅ Device grid (`DevicePicker`) always includes the universal **"Other / file — any
     PSBT wallet"** fallback (never a dead-end viewer).
   - ✅ `Term` dotted-underline glossary + `HowItWorks` explainer are available; jargon is
     explained inline, not dumped or omitted.
   - ✅ No raw Bitcoin internals (no bare xpub/derivation-path/PSBT jargon shoved at the
     user without explanation).
   - ✅ If a device read fails, the error is honest house-standard copy (via `safeAction`)
     — a blocked cross-site request reads "blocked before it reached Heartwood… not your key
     or your connection," a real network failure reads "Network hiccup," a session expiry
     silently redirects to login rather than showing "that key could not be read."
     *(Note: `safeAction`'s no-silent-failure guarantee is wizard-specific today, not
     app-wide.)*

### 21.4 First receive
5. On the wallet detail page, get a receive address (`POST /api/wallets/{id}/receive`).
   - ✅ Plain-language receive UI; the address is copyable (`CopyText`).
   - ✅ No exposed internals beyond the address/QR the user actually needs.
   - ✅ The receive section always renders, even before first sync or while the node is
     unreachable — it shows a plain-language "Still connecting to your node" waiting state
     instead of going blank (the `#receive` anchor is never missing).
   - ✅ **Rotate** (issue a fresh address) surfaces an explanation when it fails, on both
     failure paths: the server-side `fail(502, {receiveError})` case (unchanged), and a
     transport-level failure (network unreachable, thrown action) that the `use:enhance`
     callback's `result.type === 'error'` branch now catches and renders locally as
     `rotateError` — "Couldn't get a fresh address — check your connection and try again."
     Previously that second path just spun the button back to "Rotate" with no explanation
     (`cairn-sz1q`).
   - ✅ **QR scannability (`cairn-7d3q4`, v0.2.41):** the receive address
     already rendered a QR (`QRCode.toDataURL`, wired in `walletSync.ts`'s
     shared `QR_OPTS` plus both `wallets/[id]` and `wallets/multisig/[id]`
     `+page.server.ts`) — the actual defect was contrast: light-parchment
     modules on a transparent background, unreadable against the app's
     `--light-bg` in light theme. Fixed to opaque `--light-bg` background +
     evergreen-ink dark modules in all three `QR_OPTS` definitions, so it
     scans regardless of theme or surrounding surface. Verify: `<img
     class="hw-qr">` decodes to a 220×220 PNG with dark-on-light modules in
     both themes.
   - ✅ **First-deposit confidence (`cairn-gt05.6`, v0.2.39):** on a wallet with zero balance,
     zero tx history, and zero unconfirmed, the receive-address disclosure shows a
     mechanism-fact confidence line ("This address belongs to your wallet... nobody else can
     move it") — not reassurance filler, and it should disappear once the wallet has any
     activity.
6. Send funds in (real sats on mainnet, or 16.5 on regtest).
   - ✅ A `tx_received` then `tx_confirmed` notification arrives with a **working deep link**
     to the wallet/tx (broken deep links were a prior P1 — verify the link navigates
     correctly). SPV-verified before it fires (no fake alerts).
   - ✅ **First-deposit-pending note (`cairn-gt05.6`, v0.2.39):** the instant the unconfirmed
     inbound is visible to the node (before the first confirmation), the wallet detail hero
     shows a self-updating "Your payment is on its way in" note naming the exact incoming
     amount — answering "did it arrive" from the node's own data, no reason to leave for a
     block explorer. It should clear itself automatically (no manual dismiss, no reload
     needed) the moment the tx confirms.

### 21.5 First send `[optional signing leg: emulator/real-hw]`
7. `/wallets/{id}/send` — **Create → Review → Sign → Confirm → Sent**.
   - ✅ Review clearly shows recipient(s), fee, and change **as change** (not as a second
     recipient) — `bip32Derivation` on change lets it be labelled correctly.
   - ✅ Sign step offers appropriate device tiles + the universal file fallback; unavailable
     methods stay listed with a reason, never silently vanish.
   - ✅ On plain HTTP, `SecureContextHelp` guides the user to the secure `:4488` address for
     USB signing rather than leaving USB mysteriously non-functional.
   - ✅ A broadcast rejection shows friendly "what happened + what to do" copy
     (`friendlyBroadcastRejection`), and **red is reserved** for this genuinely-irrecoverable
     case — routine steps never go red.
   - ✅ `Sent` step confirms; `/activity` shows the send; `tx_confirmed` follows.
   - ✅ **Broadcast grace window** (v0.2.28, `cairn-avzs`): clicking the Confirm step's
     primary button does **not** broadcast immediately — it arms a "Sending in 5s — Cancel
     / Send now" control. Click **Cancel**: the window stops, the primary button returns to
     idle, and confirm the tx never appears in `/activity` / on the node's mempool — nothing
     was broadcast. Re-arm and this time **navigate away** (e.g. Back, or a nav-bar link)
     while it's counting: same result, no broadcast, draft/signatures untouched. Re-arm a
     third time and click **Send now**: fires immediately without waiting out the rest of
     the window. Finally, arm once and let the full 5s elapse untouched: it broadcasts
     exactly once (watch `/activity` for exactly one send event, not a duplicate). This is
     the same control on the multisig send page's Confirm step.
   - ✅ **Recipient last-4 verify micro-step** (v0.2.27, `cairn-l7sv`): send to a
     **brand-new address** (not a saved contact, never paid before from this wallet) an
     amount **≥100,000 sats or ≥10% of the wallet's spendable balance**, single recipient
     only. At Review, a "verify the last 4 characters" prompt should appear before the
     primary CTA unlocks; typing the wrong 4 characters keeps it locked with a gentle
     correction, typing the right ones (case/whitespace-insensitive) unlocks it. Repeat with
     a **known/saved** address at the same amount, and with a **small** amount (well under
     both floors) to a new address — neither should show the prompt. Also confirm a
     **multi-recipient (batch)** send at a qualifying amount never shows it, and that
     Confirm (a moment later, same draft) does **not** ask again — it's a Review-only,
     once-per-send check by design (F4: repeated warnings habituate).

### 21.6 Backup nudges (prominent backups)
8. Throughout, verify tiered, **decaying-cadence** backup nudges (`cairn-gt05.5`, v0.2.39 —
   see § "Wallet-config backup tracking & the decaying nudge" for the full mechanism):
   - ✅ Create a new multisig (`source='created'`) and leave it unbacked: the very first
     `(app)` layout load shows a calm-amber "back up this wallet" nudge for it.
   - ✅ Reload immediately (same session, well under 72h): the nudge does **not** re-show —
     it is no longer a per-session/`sessionStorage` dismiss, it's a server-persisted decay
     schedule (`backup_nudges` table). Confirm the first showing recorded `shown_count=1`
     directly in the DB if convenient.
   - ✅ **Escalation — second unbacked wallet:** create a second unbacked `created` multisig.
     Its due nudge (and the first wallet's, if still eligible) reflects the `MULTI` stakes
     tier — worth spot-checking the copy reads as more urgent than the lone-wallet `NEW`
     variant, without needing to wait out the decay window.
   - ✅ **Escalation — first funds in:** send funds to a still-unbacked wallet. The nudge for
     that wallet should be eligible again within the 72h floor (not the wider decay rung it
     would otherwise be on) — the `FUNDED` bucket, triggered from `addressWatcher.ts` the
     moment the deposit is seen.
   - ✅ Download that wallet's backup (`markBackedUp`): the nudge for it stops appearing
     entirely (`listUnbackedWallets` excludes it) — verify no further nudge shows on
     subsequent loads.
   - ✅ Separately, a wallet that already HAS a backup but it's >90 days stale shows the
     **distinct**, unchanged softer periodic reminder, whose dismissal **persists across
     browsers/devices** (server POST `/api/backup-reminder/dismiss`), not just locally — this
     mechanism did not change in the v0.2.39 rewrite.
   - ✅ An imported multisig (`source != 'created'`) and single-sig wallets are never nudged
     by either mechanism (`source` gates it).
   - ✅ Nudges stay proportionate to risk (never-backed/escalated = louder and more frequent
     than stale-backup) — never one generic "backup" nag shown identically every visit.

### 21.7 Global UX invariants (spot-check on any page)
   - ✅ Heartwood evergreen theme renders consistently in both Dark and Light
     (Settings → Display; System/Dark/Light, no flash of the wrong theme on load);
     `--text-faint` is never used for information-bearing copy (it deliberately
     fails AA — decorative/disabled only).
   - ✅ Routine validation + nudges are `--attention` (warm tan); `--error` red appears only
     for irrecoverable failures (broadcast rejected, invalid PSBT, node unreachable).
   - ✅ A `ChainHealthBanner` / `SyncBanner` appears only when actually relevant (silent
     when healthy / after first sync), and only one banner shows at a time — never both
     stacked for the same root cause (§20.15). A never-configured fresh install reads as a
     calm "not connected yet" setup step (neutral tone), not red error styling; red is
     reserved for a genuinely unreachable, previously-configured instance.
   - ✅ Toasts are transient action feedback; persistent/recoverable conditions use an inline
     `<Banner>` instead — the two are not confused.
   - ✅ Mobile (375×812) tap targets are ≥44px effective height, even where the visual
     control is smaller: global nav tabs (`MobileTabRow`), the settings BTC/sats unit
     toggle, the account-deletion danger button, the send-flow unit-cycle pill (invisible
     `::before` overlay, `inset: -7px 0`, visual pill unchanged at 30px), the Explorer
     search icon in `MobileTopBar` (invisible `::after`, `inset: -6px`, matching the
     avatar's existing treatment), and the backup-banner "Dismiss for now" icon button in
     `src/routes/(app)/+layout.svelte` (`.backup-banner-dismiss`, invisible `::after`,
     `inset: -13px` — visual icon stays 18×18, same pattern) — conservative hit-area
     expansion, no visual redesign (`cairn-amyl`). The `/admin/*` sub-nav-tabs 44px fix
     and the feature-flags switch-row 44px fix (`/admin/feature-flags`, `.switch::after`)
     are now **moot, not regressed** — both surfaces (the persistent admin tab strip, the
     flags grid page) were deleted outright in the UX Simplification pass (spec §5.2/§3.1),
     taking the fixed elements with them; don't go looking for either. Spot-check the
     **new** admin-only tap targets that replaced them instead: `/settings`'s Mining/
     Explorer toggle switches and the Health hub's footer link row — desktop admin
     density above 900px stays as-is by product intent, mobile is the only tier that
     must hit 44px.
- **PASS (journey):** every ✅ above holds through one uninterrupted new-user pass. Any raw
  internal leaked without explanation, any red used for a routine state, any broken
  notification deep link, any silent wizard failure, or a missing/weak backup nudge is a ❌.

---

## 22. Missing-scenario coverage: backup/restore, notifications, flags, auth, explorer, batch send, deletion

Gaps identified by the 2026-07-12 beads audit (`cairn-tx1w`): Part II had no scenarios
for these feature areas even though most of them have shipped security fixes worth
regression-guarding. Several sub-scenarios below are deliberately **verify current
behavior** checks tied to a still-**open** bead (`cairn-hla1`, `cairn-vop2`) — don't
record the documented gap as a surprise finding, and re-check against `git log`/`br
show` since, like the rest of Part II, this goes stale the moment a fix lands.

### 22.1 Admin instance backup/restore round-trip `[none]`
Preconditions: an admin account; at least one single-sig wallet and one multisig
wallet shared with a cosigner (§17) so `multisig_shares` has a row to round-trip.
1. `/admin/backup` → export: enter and confirm a passphrase (≥8 chars), click Export.
   - **Expected:** an AES-256-GCM-encrypted file downloads; the envelope and inner
     payload both stamp the current `VERSION`.
2. Restore that file (same instance, or a fresh install for the disaster-recovery
   case) via `/admin/backup`'s restore form with the same passphrase.
   - **Expected:** an inline `RestoreSummary` panel shows users/wallets/multisigs
     counts plus `sharesRestored` (recreated `multisig_shares` rows, remapped
     `multisig_id`/`owner_id`/`shared_with_id`, plus `multisig_keys.assigned_user_id`
     — `cairn-s6x3`). Any user row that didn't already exist gets exactly one
     single-use recovery code shown **once** in the panel (`reclaimCodes`) — restored
     accounts carry no credentials by design, so this code is genuinely their only
     way back in short of re-registering.
   - **PASS (round-trip):** every wallet/multisig/share present before export is
     present after restore; each `reclaimCodes` entry logs the reclaimed account in.
3. Include (or hand-craft) a backup whose settings contain
   `registration_mode`/`webhook_allow_private_targets`/`instance_mode`/`auth_mode`/
   `electrum_tls_insecure`, then restore it onto an instance with different values
   for those keys.
   - **Expected:** none of the five is adopted (`RESTORABLE_SETTING_KEYS`
     default-deny allowlist, `cairn-0dg4`) — they're listed in
     `RestoreSummary.settingsSkipped`, shown in the restore-summary panel, and bump
     the `admin_restore` notification to `warn`.
   - **PASS (posture withheld):** the instance's own security-posture settings are
     byte-for-byte unchanged after restore; the panel names exactly what was
     withheld.
4. Restore a backup whose `version` field is not a number, or exceeds the current
   `VERSION` constant.
   - **Expected:** rejected up front — "This backup was made by a newer version of
     Heartwood and cannot be restored here." (`cairn-lka5`) — no DB writes happen.
5. Restore a backup containing a user row with `is_admin: 1` for an
   otherwise-nonexistent email.
   - **Expected:** the imported row is force-downgraded to `is_admin = 0`
     unconditionally (`backup.ts`, `SECURITY (cairn-cpb5)` — every imported account
     is forced non-admin, no exceptions), counted in `RestoreSummary.adminDowngraded`,
     and surfaced in the `admin/restore` API response's message text ("N account(s)
     marked admin in the backup were imported as normal accounts — re-promote them
     yourself if that was intended.") A separate re-promotion by the admin (via
     `/admin/users`) is required — restore itself never grants admin.
- **Cleanup:** on a shared/multi-tester box, delete the imported test accounts and
  re-run §16.6/§16.7 before the next tester uses it.

### 22.2 Notification channels beyond tx-events `[none]`
Covers `/settings/notifications` (all five external channels, quiet hours) and the
`security_*`/`admin_*` event types, none of which had a scenario before this section
— only tx-event notifications (§20.9) and channel-visibility parity (Part I §8) did.
1. Configure and **Test** each channel in turn: email (personal SMTP or instance
   fallback), Telegram (`chatId`), ntfy (`server`+`topic`+ optional access token),
   Nostr (`recipientPubkey` + relay list), webhook (`url` + optional HMAC secret).
   - **Expected:** each `Test` button is disabled until `configured` is true for that
     channel; a successful test does not require saving first (it round-trips
     current form values); a failing test (bad URL, unreachable relay, SSRF-guarded
     private-target URL for webhook/ntfy — `ssrf.ts`) surfaces a specific reason
     inline, not a generic failure.
2. Reload the page after configuring a secret-bearing channel (webhook secret, ntfy
   access token, personal SMTP password).
   - **Expected:** the secret field renders blank (never echoed back), but
     `hasSecret`/`hasAccessToken`/`smtp.hasPass` reflect that one is stored — same
     redaction contract `notifyConfig.test.ts` proves for every `ConfigurableChannel`
     (`cairn-sask`, closed) and that `getPublicInstanceNotificationSettings` proves
     for the instance-level `smtp_pass`/`telegram_bot_token`.
3. Enable **Quiet hours** with a start/end window and a timezone; leave "Still
   deliver urgent security alerts during quiet hours" unchecked, then trigger a
   routine notification (e.g. `tx_confirmed`) inside the window and a
   `security_failed_login`/`security_new_device` event inside the same window.
   - **Expected:** the routine notification is suppressed/deferred by quiet hours;
     the security event's behavior should match the `urgentOverride` toggle state —
     verify current behavior for exactly which event types the override treats as
     "urgent" (the registry is `NOTIFICATION_EVENT_TYPES`'s `security_*` group plus
     `admin_*`) since this manual has not previously verified that boundary
     end-to-end.
4. Trigger each of `security_failed_login` (a wrong password), `security_new_passkey`
   (register a passkey), `security_password_changed`, and `security_new_device`
   (sign in from an unrecognized fingerprint) as a non-admin user, and
   `admin_new_signup`/`admin_invite_used`/`admin_restore`/`admin_server_health`/
   `admin_user_disabled`/`admin_settings_changed`/`admin_recovery_code_minted` as an
   admin action.
   - **Expected:** each fires exactly once, routes per `notification_preferences`
     (or `DEFAULT_PREFERENCES[eventType]` when unset), and reads in plain language —
     no raw internals leaked (per the UX philosophy, §21.7).
- **PASS:** all five channels configure/test/redact correctly; quiet hours suppress
  routine notifications in-window; every event type in this scenario fires exactly
  once with the correct channel routing.

### 22.3 Feature-flag admin flow `[none]`
**Rewritten for UX Simplification Wave 5 (`cairn-6c91u.5`, `docs/UX-SIMPLIFICATION-
SPEC.md` §3).** The 25-row `/admin/feature-flags` grid and the per-user override grid on
`/admin/users/[id]` are both **deleted** (Wave 2, `cairn-6c91u.2`) — only `mining` and
`explorer` still have an admin UI at all, now as plain Settings toggles. The three
2026-07-06 UI-parity bugs this scenario used to regression-guard (`cairn-8dup`,
`cairn-1x3w`, `cairn-jyh7`) are still real regressions to watch for, just exercised via
different entry points below since their original entry point (the grid) no longer exists.
1. **Settings toggle → nav visibility → route gate, in lockstep (spec R2/R5).** As admin,
   in `/settings` toggle **Mining** (`#mining`) off, then on; separately toggle
   **Explorer** (`#explorer`) off, then on.
   - **Expected:** each toggle flips server-authoritatively via the same
     `setGlobalFlag(key, enabled, adminId)` the old grid used (re-render confirms
     persisted state, no optimistic flip). Within one page load after each change, the
     primary nav (`primaryNav()`, §9) gains/loses the Mining/Explorer tab to match, and
     `GET /mining` / `GET /explorer` gain/lose reachability (403 while off) — nav-visible
     must never diverge from route-reachable. Turning Mining ON does **not** auto-start
     the pool (the separate `mining_enabled` operator toggle in `/admin/mining` still
     governs that, §8 "Mining engine").
2. **Code-only flag, no UI — set it off via the surviving DB/API path** (spec §3.2's "23
   code-only flags" list: `send`, `multisig_create`, `coin_control`, `csv_export`,
   `address_book`, `qr_scan`, `stateless_signer`, `wallet_config_export/import`, `hw_*`,
   `notify_*`, `announcement_banners`, `referral_links`, `batch_transactions`,
   `fee_bumping`, `tx_review` — none of these are reachable from any admin screen anymore).
   Disable `csv_export` globally either by writing the `feature_flags` row directly
   (`UPDATE`/`INSERT ... key='csv_export', enabled=0`) or via an admin API token against
   the flag-write endpoint — there is no page to click through.
   - **Expected:** `resolveAllFlags()`/`requireFeature()` treat this identically to the old
     grid's write (the DB row is the only thing either mechanism ever read) — a wallet
     detail page and the multisig-create card on `/wallets/new` render a greyed
     `FeatureDisabled` chip ("disabled by your administrator"), not a silently vanished
     button (`cairn-8dup`, `FeatureDisabled.svelte`).
3. Disable `coin_control` the same code-only way, then open that user's
   `/wallets/{id}/send`.
   - **Expected:** the manual UTXO-selection UI is gated behind `data.flags.coin_control`
     with a `FeatureDisabled` note, selection stays empty (falls back to automatic coin
     selection) — not still fully interactive (`cairn-jyh7`, fixed).
4. With `coin_control` still off, attempt to build a send anyway (bypassing the UI gate
   via a direct API call, or by racing a flag flip mid-session).
   - **Expected:** the server's `requireFeature()` 403s with the real reason ("Coin
     control has been disabled by your administrator"), and the client build-error
     handler shows that exact message — it reads `body.error ?? body.message`, matching
     `requireFeature`'s `error(403, def.userMessage)` JSON shape (`cairn-1x3w`, fixed;
     previously only `body.error` was read and the real reason was swallowed by the
     generic fallback).
5. **Per-user override — data-safety check, no UI to set it anymore.** Write a
   `user_feature_flags` row directly for one user (opposite of the global default) —
   there is no `/admin/users/[id]` UI for this now, only the table + `resolve.ts`'s
   per-user branch, which the spec explicitly keeps alive so pre-existing overrides
   aren't stranded (§7/§11 R7). Confirm solo-vs-team gating around it: with
   `instanceMode === 'solo'`, `/admin/users` 404s, but the override row you just wrote
   still resolves correctly for that user (§7's "toggling back to solo must not silently
   revoke access already granted" — verify the *reverse* direction here too: an override
   survives the mode toggle either way, regardless of how it was written).
6. **Redirect stubs.** `GET /admin/feature-flags` and `GET /admin/settings` (no-follow)
   both 307 — to `/settings#mining` and `/settings#node-connection` respectively — the
   same assertion `qa:route-crawl` runs automatically (§13); confirm manually here too
   since a browser follows the redirect and lands on the right anchor's group already
   expanded/scrolled-to.
- **PASS:** Mining/Explorer toggles keep nav and route gating in lockstep; every
  disabled code-only flag with a UI surface elsewhere still shows an explanatory
  `FeatureDisabled` chip, never a silent disappearance; server 403 reasons reach the user
  unmangled; a per-user override written directly persists correctly across solo/team
  toggles; both deleted admin pages redirect to the correct Settings anchor.

### 22.4 Auth beyond password happy-path `[none]`
Extends §16.6 (which only covers signup/login happy-path) — passkeys, recovery,
rate limiting, device/session revoke, and API tokens all lacked scenarios.
1. **Passkey add + login.** From `/settings`, register a passkey (WebAuthn ceremony)
   on an account that already has a password. Sign out, sign back in using only the
   passkey.
   - **Expected:** both credentials work independently; `security_new_passkey`
     fires on registration. Attempt to delete the account's only *remaining*
     passkey on a password-less account.
   - **Expected:** refused — `deleteCredential()` throws `AuthError('last_passkey')`
     (§7) since passkey-only recovery is by re-registering a new account, not
     password reset.
2. **Recovery phrase + codes** (updated v0.2.28, R4/`cairn-ux-r4-7fzr` —
   explain-before-reveal + recognition verify, `docs/UX-PSYCHOLOGY-RESEARCH-
   2026-07-15.md` F7). As the forced-recovery admin (or any user who
   navigates to `/recovery-setup`), work the phrase step's three sub-stages
   in order: **stakes** (a calm plain-language explainer of what this
   recovers and what it doesn't — the phrase is NOT generated yet, only
   fetched when "Show my recovery phrase" is clicked) → **reveal** (the
   12-word phrase, plus a "I've written this down" checkbox gate) →
   **verify**, a *recognition* quiz (not recall): 2 of the 12 positions,
   each a 4-way multiple choice among the real word and 3 decoys from a
   fixed sample pool (`recognitionVerify.ts`'s `buildVerifyQuestions`) — all
   positions must be answered correctly to unlock Continue into the codes
   step (a wrong pick is just corrected in place, not punished). Then
   generate the 8 one-time recovery codes (download + copy-all).
   - **Expected:** phrase/codes are generated **once** per page load and
     held only in memory (the plaintext is never persisted, only a hashed
     form). **Reload mid-flow** restores which SCREEN you were on (`phrase`
     or `codes`, via `sessionStorage` under `cairn.recovery-setup-wizard.v1`)
     but never the secret itself — a resume into the `phrase` step always
     lands back on the pristine **stakes** sub-stage (never mid-reveal or
     mid-verify), and a resume into `codes` re-generates a fresh code set.
     Each redeemed code is single-use (`used_at` marks it spent) and the
     phrase is reusable. Confirm the copy is explicit throughout that this is
     a **login** recovery mechanism, not a bitcoin-key backup
     (recovery.ts's core invariant) — do not confuse this wizard with wallet
     seed-phrase backup (§21.6/§9.4's wallet-config backup), which is a
     completely separate concern. A non-admin can defer via "Skip for now"
     (`/settings`'s `recovery-banner`, amber `alert-triangle`, dismissible
     only by completing the wizard — no "x"); an admin cannot skip (forced
     by `appGate.ts`'s recovery gate on every route except `/recovery-setup`
     itself).
3. **Rate limiting.** Attempt 6 failed logins for one email inside 15 minutes.
   - **Expected:** the 6th attempt (over `loginEmail = 5`) is throttled with a
     `retryAfter` seconds figure, independent of the looser per-IP bucket
     (`loginIp = 20`). Also attempt 11 invalid invite codes from one IP inside 15
     minutes (`invitesIp = 10`).
   - **Expected:** throttled past the 10th. All three buckets are in-process memory
     (a server restart clears them — acceptable per `rateLimit.ts`'s own doc
     comment).
4. **Device/session revoke.** From `/settings/devices`, revoke a *different*
   session (open the app in a second browser/profile first) and forget a
   remembered device.
   - **Expected:** the revoked session's cookie stops working on its next request;
     attempting to revoke your **own current** session is refused client-side
     ("This is your current session — use Sign out instead," not a silent self-
     lockout). Forgetting a device doesn't sign it out — it just means the next
     sign-in from that fingerprint re-triggers a `security_new_device` alert.
5. **API tokens.** From `/settings/tokens`, create a token (optionally with an
   expiry, 1–3650 days), copy the shown value once, then use it as
   `Authorization: Bearer cairn_...` against a `GET` API route.
   - **Expected:** the raw value is shown exactly once (`form.created`); the stored
     row only ever holds `hashToken()`'s SHA-256 hex, mirroring session storage.
     Revoke the token, then repeat the same authenticated request.
   - **Expected:** the revoked token is rejected; hitting the token cap
     (`MAX_TOKENS_PER_USER = 25`) refuses new-token creation with a clear message
     rather than a raw DB constraint error. Also send several requests with a
     **bad** Bearer token from one IP and confirm it throttles via the same
     fixed-window scheme as login (`apiTokens.ts`'s bearer-throttle mirror of
     `rateLimit.ts`).
6. **Admin-minted recovery code.** As admin, for a user with zero credentials
   (`needsRecoveryCode`, e.g. a restored account — see 22.1), mint a recovery code
   from `/admin/users`.
   - **Expected:** shown once, keyed by user id, not persisted client-side beyond
     the page's lifetime; `admin_recovery_code_minted` fires.
- **PASS:** every sub-scenario's *Expected* holds; no path silently locks a user out
  or leaks a secret on reload.

### 22.5 Explorer as a feature — general navigation `[none]`
Complements the explorer *degradation* scenarios (§20.4, §15 appendix's Esplora-
removal notes) with a plain happy-path navigation sweep — no prior scenario walks
the explorer as an ordinary feature with a healthy Electrum+Core backend.
1. From `/explorer`, follow the landing page's recent-block list into
   `/explorer/block/[id]` (by height), then a transaction row into
   `/explorer/tx/[txid]`, then a spent/received address into
   `/explorer/address/[address]`.
   - **Expected:** each page renders its hero details plus the reciprocal
     cross-links (tx → its block via block-context rail, block → its tx list,
     address → its tx history) without a full reload; back-navigation matches the
     §20.10 back-button sweep (lands on `/explorer`, not a loop).
2. Use the explorer search (`MobileTopBar` search icon / desktop search field) with
   a txid, a block height, a block hash, and an address in turn.
   - **Expected:** each resolves to the correct detail page; an invalid/garbage
     query shows a friendly "not found," not a raw error or blank page.
   - **Complete-but-nonexistent case (`cairn-ioeg5`, fixed `ef9de6e`, v0.2.40):**
     type a syntactically valid, 64-hex-char txid that doesn't exist. The
     backend (`classifySearch()`) always honestly returned
     `{type:'unknown',redirect:null}` for this — the bug was frontend-only:
     the live-suggestion dropdown kept showing the generic "keep typing —
     height, hash, txid, or address" hint even for a complete, definitively-
     unknown query, a dead end with no signal. `isCompleteSearchCandidate()`
     (`$lib/searchShape.ts`, sharing regexes with the backend so the two
     surfaces can't disagree) now distinguishes "still typing" from
     "complete and confirmed not found" in both the live-suggestion dropdown
     and the Explorer index's inline search form.
3. Visit `/explorer/mempool` and `/explorer/mempool/blocks`, and `/explorer/
   difficulty`.
   - **Expected:** mempool summary and projected-block view render (Core-gated per
     §15 appendix when Core is down — verify the healthy-backend case here);
     difficulty page shows current/historical difficulty without a Core
     dependency.
4. With the `explorer` feature flag off (fresh-install default per
   `explorerDefaultMigration.ts`), check every non-tx explorer link app-wide
   (dashboard `RecentActivity`, `/activity`, wallet-detail rows, post-broadcast
   pages).
   - **Expected:** those links degrade to plain non-interactive text (`svelte:
     element`), **except** tx-detail links, which remain live `<a href="/explorer/
     tx/…">` unconditionally — the app's only tx-detail surface (`cairn-5yz3.3`).
     `/explorer/tx/[txid]` itself is reachable directly even with the flag off
     (`requireUser` only, no `requireFeature` on that one route id); every other
     `/explorer/**` route still requires the flag server-side.
- **PASS:** happy-path navigation and search all resolve correctly with cross-links
  intact; the tx-link exemption is the only flag bypass — no other explorer surface
  is reachable with `explorer` off.

5. **Node-trust popover layout** (v0.2.26, `cairn-klxj`). On any explorer page with
   the `NodeTrustChip` ("Verified by your node" pill), click the chip to open its
   popover, both at desktop width and at 375×812 mobile.
   - **Expected:** the popover opens **beneath** the chip and pushes the page's own
     content (Status, Last block seen, Node info, and — on `/explorer/tx/[txid]` —
     the "involves your wallet" banner below the fold) **down**, never overlapping
     it. Click outside, or press Escape, to close — focus returns to the chip.
6. **Pending block position** (v0.2.26, `cairn-lynf`). On `/explorer`'s tip view
   (no `?before=` param) with a mempool projection available, inspect the block
   list.
   - **Expected:** the dashed "pending" row is the **first** row, above block
     height N (the latest confirmed block) — not below it. Paginate to an older
     page (`?before=`) and confirm no pending row appears there at all.

### 22.6 Batch sending (multiple recipients, one transaction) `[emulator]`
Covers `cairn-6s6` (closed/shipped) — no scenario existed for the shipped feature.
1. On `/wallets/{id}/send` (Create step), click **Add another recipient** twice to
   get 3 recipient rows; fill each with a distinct address and amount.
   - **Expected:** each row validates its own address/amount independently; the
     unit-cycle/amount entry works per-row.
2. With 2+ rows present, try to select **Everything** (send-max).
   - **Expected:** send-max is single-recipient-only — adding a second row while
     `amountMode === 'max'` resets it back to `'btc'` (`amountMode = 'btc'` on
     `addRow()`), and the max toggle itself has no effect with `rows.length > 1`.
3. Advance to Review with 3 recipients.
   - **Expected:** the review step lists all 3 recipients (not collapsed to one),
     shows the correct total across recipients, change is still labelled as change
     (not a 4th recipient), and the hardware-signing device-screen summary shows
     the first recipient plus "+N more recipients" rather than truncating silently.
4. Sign (any device/emulator) and broadcast.
   - **Expected:** all N outputs land in the broadcast transaction with the
     correct amounts, plus change reconciling exactly against inputs − fees.
5. RBF-bump the resulting batch transaction (§18.3).
   - **Expected:** the bump preserves all original recipients' amounts, only the
     fee (and change) changes — per `cairn-6s6`'s "batch RBF bumps supported and
     tested" closure note.
- **PASS:** N-recipient send builds, reviews, signs, and broadcasts correctly, with
  send-max correctly refused alongside multiple recipients, and RBF on a batch tx
  preserves every recipient's amount.

### 22.7 CSV export `[none]`
Covers `cairn-b1rg`/`cairn-mf68` (closed, same defect — CSV formula injection) and
the `csv_export` flag's UI parity (`cairn-8dup`, closed) — neither had a runbook
scenario.
1. Label a transaction (via the tx-labels UI or `PUT /api/wallets/[id]/labels`)
   with a value starting with `=`, `+`, `-`, `@`, `|`, a tab, or a CR — e.g.
   `=HYPERLINK("http://evil","x")`. Export the wallet's history as CSV
   (`GET /api/wallets/[id]/history.csv`, or the multisig equivalent).
   - **Expected:** the Label cell in the exported CSV is prefixed with a leading
     `'` (`neutralizeFormula()`), so opening it in Excel/Sheets/LibreOffice renders
     literal text, not an executed formula. A cell that's a genuine number (e.g.
     a negative BTC amount) is left untouched — verify the numeric `Amount`
     columns are never accidentally quote-prefixed.
2. Export a wallet's history with a mix of confirmed and unconfirmed transactions,
   and at least one transaction whose counterparty-address lookup fails
   transiently.
   - **Expected:** unconfirmed rows show `Pending` in the Date column (not a bad
     date); a failed counterparty lookup leaves the Address cell blank but still
     reports everything derivable from the row itself (txid/height/delta/fee) —
     degrades gracefully rather than aborting the whole export.
3. As admin, disable the `csv_export` flag globally, then reload a wallet detail
   page as a non-admin user.
   - **Expected:** the CSV export link/button renders as a `FeatureDisabled` chip
     ("disabled by your administrator"), not a silently missing control
     (`cairn-8dup`, fixed) — same pattern as `wallet_config_export`'s links on the
     same page.
- **PASS:** formula-leading labels are neutralized in the exported CSV without
  corrupting numeric columns; export degrades gracefully on a partial lookup
  failure; the flag-off state shows an explanatory chip, not a vanished control.

### 22.8 Stateless multisig route (`/wallets/multisig/stateless`) `[none]`
Covers the Caravan-compatible, nothing-persisted-server-side escape hatch — no
scenario existed despite two related beads (`cairn-e8de` closed, `cairn-hla1` open).
1. Confirm discoverability first: search the app for any inbound link to
   `/wallets/multisig/stateless` (multisig hand-off page, footer, docs link).
   - **Expected-fail / verify current behavior (`cairn-hla1`, open):** as of this
     writing there is **no** inbound link anywhere in the app — the route is only
     reachable by typing the URL directly. Don't record this as a new finding on
     its own; it's the documented open gap. Re-check `cairn-hla1`'s status before
     assuming it's still true.
2. Paste a Caravan-format JSON wallet config (or a bare output descriptor) into the
   Load phase.
   - **Expected:** balance + addresses scan from the pasted config alone, nothing
     server-side is created; a malformed/wrong-script-type cosigner path in a
     **bare descriptor** is now rejected at ingestion — `parseStatelessSource`'s
     descriptor branch calls `validateMultisigKeyPaths(desc, {mode:'import'})`
     right after parsing (`cairn-e8de`, fixed), matching the rules
     `parseCaravanImport` already applied (e.g. a legacy P2SH `1'`-suffix label
     warns rather than hard-stopping; a single-sig BIP-84 path pasted in as a
     cosigner path is rejected).
3. Build a send (Load → Build → Sign phases), reload the page mid-Build.
   - **Expected:** the config, scan, in-progress PSBT, and signing progress survive
     the reload via `sessionStorage` (mirrors Caravan's own persistence model);
     closing the tab entirely discards it — nothing here is DB-backed.
4. Sign with each available stateless signer path (QR/BBQr, Trezor, Ledger's
   on-device BIP-388 re-registration, File) and combine via `/api/stateless/
   combine`.
   - **Expected:** each signer works without any persisted multisig row; the
     combine step produces the same finalized PSBT/broadcast result as the
     persistent multisig flow (§17.3) for an equivalent quorum.
- **PASS:** steps 2-4 all succeed with zero server-side persistence; step 1's
  orphaned-route gap is recorded as the known open item, not a new bug.

### 22.9 Labels & address book `[none]`
No scenario previously exercised per-transaction labels or the saved-address book
directly (only referenced in passing via the CSV-export and flag-parity notes).
1. Label a transaction from a wallet-detail history row (`PUT /api/wallets/[id]/
   labels` or the multisig equivalent `/api/wallets/multisig/[id]/address-labels`
   family).
   - **Expected:** the label persists (60-char cap, per `saveAddress`'s equivalent
     bound on the address book — verify the actual per-field length caps in each
     route) and appears consistently in the history list and CSV export (§22.7).
2. On `/wallets/{id}/send`, type a previously-used address into the recipient
   field.
   - **Expected:** `RecipientCombobox` autocompletes from the saved address book
     (`GET /api/address-book`); after a successful broadcast, the "save this
     address" offer appears for a new, not-yet-saved recipient.
3. As admin, disable the `address_book` flag for one user, then repeat step 2 as
   that user.
   - **Expected:** the send page's `load()` withholds `savedAddresses` entirely
     (returns `[]`, doesn't call `listSavedAddresses`) rather than fetching the
     full list and hiding it client-side — no autocomplete, no post-broadcast save
     offer (`cairn-de7e`/`cairn-puyb`, fixed). Multisig send has no address book at
     all regardless of the flag (`saved={[]}` unconditionally) — confirm this
     reads as "feature not present here," not a broken flag.
4. Save/rename an address entry, then re-save the same address with a new label.
   - **Expected:** `saveAddress()`'s upsert semantics: an existing entry's
     `last_used_at` bumps and it's renamed when a label is sent (`created: false`,
     200), rather than a duplicate row (`created: true`, 201) for the same address.
- **PASS:** tx labels and address-book entries persist and surface correctly across
  history/CSV/send autocomplete; the `address_book` flag genuinely withholds data
  server-side, not just client-side.

### 22.10 Wallet/account deletion completeness `[none]`
`userDeletion.ts`'s three shared invariants (FK pre-cleanup, last-admin guard,
shared-multisig owner guard — Part I §7) already have scenario-adjacent coverage
via §21's danger-zone checkpoint; this scenario targets the two things that don't:
cascade completeness, and the one known open gap.
1. As a user with a fully-populated account (wallets, multisig shares, saved
   addresses, notification channel configs, known devices, API tokens, contacts),
   delete your own account from `/settings`'s danger zone (type `DELETE` to
   confirm).
   - **Expected:** every table `buildAccountExport` reads is empty afterward — the
     cascade-completeness regression this scenario guards
     (`cairn-684u`/`destructiveOps.test.ts`, closed; walks `PRAGMA
     foreign_key_list` over all user-FK tables). The danger-zone copy's warnings
     match reality: wallets shared *to* you are untouched (owner keeps them); a
     multisig you *own* and shared out is deleted for every cosigner/viewer
     immediately, without warning them.
2. As admin, attempt to delete (force admin-delete, `DELETE /api/admin/users` with
   `{id}`) a user who owns a multisig shared with a cosigner, **without** `force`.
   - **Expected:** refused with `AuthError` code `owns_shared_multisigs`, message
     enumerating the affected wallets + pending-signature count. Re-submit with
     `force: true`.
   - **Expected:** proceeds; every affected participant gets an in-app-only
     `multisig_removed` notification (`notifyOwnerDeletionCosigners`,
     best-effort). Note for the tester: **this admin-delete action has no
     discoverable button in `/admin/users` or `/admin/users/[id]` today** — those
     pages only expose Enable/Disable; the DELETE endpoint is reachable via
     devtools/API only. Record this as the current state, not an assumed bug.
3. Attempt to delete the sole enabled admin account (self-delete or admin-delete).
   - **Expected:** refused (`deletionOrphansAdmins`/`last_admin`) — counts the last
     admin **row** of any kind, so a *disabled* sole admin also can't be
     self-deleted into a zero-admin instance (`cairn-sclk`).
4. **Expected-fail / verify current behavior (`cairn-vop2`, open):** delete a whole
   wallet (not a single transaction) that has a transaction with a live
   `broadcast_started_at` claim or a completed/superseded broadcast record.
   - **Documented gap:** `deleteWallet` does an unconditional `DELETE FROM wallets`
     and `transactions.wallet_id` is `ON DELETE CASCADE`, so the broadcast record
     is erased along with everything else — unlike the hardened single-transaction
     delete guard (`cairn-up0q`) that blocks erasing a mid/post-broadcast row.
     Confirm this still reproduces (a whole-wallet delete is arguably legitimate
     total-removal intent; the narrow concern is only a delete racing an in-flight
     broadcast). Do not file this as a new bug — it's the tracked open item; note
     whether current behavior still matches the bead's description.
- **PASS:** step 1's cascade is complete; step 2's guard/force/notify sequence
  works exactly as described (the missing UI button in step 2 is a recorded
  observation, not a pass/fail criterion); step 3's last-admin guard holds; step 4
  is a verify-current-behavior check against the open bead, not a fresh finding.

---

### Appendix: known stale/uncommitted spots the tester will hit
- **Multisig `complete` flag (§17.3) — RESOLVED:** the quorum-aware
  `summarizePsbt(threshold)` fix, previously an uncommitted working-tree diff, is now
  commit `a93dd27` and shipped in Release v0.2.13 (Part I §15 gotcha #7). §17.3 no longer
  treats a premature `complete:true` as expected on current HEAD — re-verify against
  `git log` if testing an older checkout.
- **p2tr / `tr()` (rows D, H):** deliberate dead ends — clear "not supported yet" errors are
  the pass condition, not a spend.
- **New-wallet watch lag (§20.7):** up to ~5-min notification lag on a just-created wallet is
  by design (poll-based `refreshWatches`).
- **`safeAction` scope:** no-silent-failure is guaranteed only in the two `new`-wallet
  wizards, not app-wide — other forms still use `use:enhance`.
- **Esplora fully removed (cairn-zoz8.16):** the explorer runs purely on Electrum + Core RPC
  with no third-party HTTP explorer API; README and this manual describe that. A public-Electrum-only
  install has `core === null`. Explorer sections still gated to a "needs Core RPC" notice: the block's
  transaction LIST (Electrum has no "list this block's txids" method) and the mempool summary.
  **Exceptions (progressively fixed since this note was first written):** the **tx-detail page**
  works Electrum-only — `getTx` falls back to `getTxViaElectrum`, rendering the transaction plus a
  "basic"-tier block-context section (neighbour dates + merkle position + summary), no Core nag. The
  **block-detail page's hero** (height/hash/time/prevHash/merkleRoot/nonce/bits/difficulty) also now
  renders Electrum-only for a HEIGHT lookup — `getBlock` falls back to `getBlockViaElectrum`
  (cairn-kcxy), a bare-header decode with tx-count/size/weight/fee stats staying `null` (no Core
  enrichment) — only the tx-list section below the hero shows a "couldn't load transactions" Banner,
  not a whole-page gate. Tapping a neighbour block still resolves the same way (by height, from the
  block-context rail's own links). A block looked up by HASH (no known height) still shows the
  Core-gated notice — Electrum exposes no hash→height index — documented and accepted.
- **Explorer landing page's tip + recent-block list, Core-only direction (cairn-i4pa):** the flip
  side of the note above — a Core-up/Electrum-down (or Electrum-unreachable) deployment used to
  show the landing page's "Verified by your Bitcoin Core node" provenance chip alongside an EMPTY
  block list and a stuck tip, since `getTip()` and `getRecentBlocks()` were Electrum-only with no
  Core fallback (unlike `getBlock`/`getTx`, which already had one). Fixed: `getTip()` falls back to
  `getblockcount`+`getblockhash`; `getRecentBlocks()` degrades each height's baseline independently
  via the same `neighborHeader()` Electrum→Core fallback the tx block-context uses, instead of one
  failed Electrum header rejecting the whole batch. See the `ChainService` method docs above.
- **Regtest addresses are mainnet-derived:** you fund via the scriptPubKey/descriptor bridge
  (16.5), not by pasting Cairn's `bc1…` into regtest tooling.
- **BIP21 paste (§20.11) — expected-fail by design, not yet a bug to fix:** `parseBip21()`
  is built and tested (commit `41545b9`) but has no call site; a `bitcoin:` URI pasted into
  the send recipient field does nothing today (Part I §15 gotcha #11).
- **Back-button loop sweep (§20.10) — RESOLVED, but the pattern recurs:** the five commits
  (`cairn-y7ac`, `4b98a1e`, `7fbbdd4`, `d22888c`, `a19dfa2`) fixed every known instance as of
  current HEAD; any *new* in-page back control should still be checked against the
  `replaceState: true` convention (Part I §15 gotcha #12) since this bug shape has recurred
  five times already.
- **QR scanner torch toggle (§20.12) is new, opt-in, unspecified elsewhere:** commit
  `96cd16a`'s shared `QrScanner.svelte` added a torch/flashlight toggle neither original
  signer had; it's progressive enhancement only (hidden when unsupported), not a regression
  to chase if it doesn't appear on a given camera.
- **`/vaults*` is empty scaffolding, not a hidden route:** every directory under
  `src/routes/(app)/vaults` and `src/routes/api/vaults` has zero tracked files; any hit
  301-redirects to `/wallets`(`/wallets/multisig`) before reaching them (Part I §9).
- **Stateless multisig route is orphaned, not hidden (§22.8, `cairn-hla1`, open):**
  `/wallets/multisig/stateless` works fully once you're on it, but nothing in the app
  links to it — only a typed URL reaches it. Don't record this as a fresh discoverability
  finding; it's the tracked open item. Re-check `br show cairn-hla1` before assuming it's
  still unlinked.
- **Whole-wallet delete can erase a live broadcast record (§22.10, `cairn-vop2`, open):**
  `deleteWallet`'s `ON DELETE CASCADE` on `transactions.wallet_id` doesn't share the
  per-transaction delete guard (`cairn-up0q`) that blocks erasing a mid/post-broadcast row —
  deleting the whole wallet takes its transaction history with it regardless of broadcast
  state. Likely by design for a deliberate total-removal action; the narrow open concern is
  only a delete racing an in-flight broadcast. Verify current behavior, don't assume fixed.
- **Admin-initiated user deletion has no button in `/admin/users`/`/admin/users/[id]` (§22.10):**
  those pages only expose Enable/Disable; `DELETE /api/admin/users` (with its `force` escape
  hatch for `owns_shared_multisigs`) is reachable via devtools/API/scripting only as of this
  writing. Not filed as a bug — noted so a tester doesn't go looking for a missing button.
