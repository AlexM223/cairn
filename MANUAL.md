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
in the tree today — followed by **Part II: QA Test Runbook** (§16–21), a set
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
source, with optional Bitcoin Core RPC for explorer-grade detail and Esplora
as a last-resort HTTP fallback. All durable state lives in one synchronous
`node:sqlite` database.

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
Browser (Svelte 5 runes, Heartwood dark-only CSS, HW drivers in src/lib/hw/*)
   │  fetch / form actions (?/action via safeAction) / SSE (/api/events, /api/notifications/stream)
   ▼
SvelteKit edge: src/hooks.server.ts  handle()
   │  await initReady (gate) → locals.user + locals.flags → access gates → CSP/headers → request log
   ▼
Routes:  src/routes/(app)/**  (+page.server.ts loaders & form actions)
         src/routes/api/**/+server.ts  (~100 JSON endpoints; guards from src/lib/server/api.ts)
   ▼
Domain services: src/lib/server/**
   wallets.ts / wallets/multisig.ts, transactions.ts / multisigTransactions.ts,
   feeBump.ts, bitcoin/{psbt,multisigPsbt,xpub,multisig}.ts, auth.ts, notifications.ts,
   featureFlags/*, walletSync.ts / chainSync.ts (SWR), addressWatcher.ts
   ▼
Chain facade: src/lib/server/chain/index.ts  (ChainService singleton, getChain())
   ├─ Electrum pool (electrum/pool.ts → N × electrum/client.ts sockets)   [PRIMARY]
   ├─ Bitcoin Core RPC (bitcoinCore/client.ts)                            [optional]
   └─ Esplora HTTP (chain/esplora.ts)                                     [optional, fallback]
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
| `src/lib/server/chain/` | `index.ts` (`ChainService` facade), `esplora.ts`, `cache.ts`. |
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
`getChain()` from `src/lib/server/chain/index.ts`. That facade hides three
backends behind one API and picks between them by a documented priority
order, so nothing above it needs to know or care whether the operator has
Bitcoin Core configured.

### Backend priority (deliberate, documented in the facade's file header)

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
   descendant context. Added in the "Esplora-removal Wave 2" so a
   local-only Umbrel deploy (Core + electrs, no internet route) is fully
   self-sufficient.
3. **Esplora** (optional, only when the operator sets an explicit
   `esploraUrl`) — last-resort fallback for the above when Core isn't
   configured or a Core call fails, and the *only* source for things Core
   genuinely can't do (the RBF replacement tree/history — Core keeps no
   historical-replacement index).
4. **Public `mempool.space` price endpoint** — the very last fallback, and
   only for BTC/USD spot price, and only if the configured Esplora backend
   has no `/v1/prices` of its own (a self-hosted mempool instance is checked
   first, so a sovereignty-minded operator's box never silently leaks to the
   public internet).

`ChainService.core` and `.esplora` are `null` when not configured. Every
Core/Esplora-backed method either falls through to the next backend in the
chain or throws a clear "needs Core RPC" error that the UI renders as
`CoreRpcRequiredNotice` (`src/lib/components/CoreRpcRequiredNotice.svelte`).
**A stock Umbrel deploy has `esplora === null` and `core !== null`** — keep
this in mind; README.md's "Configuration notes" section still describes
Esplora as if it were the primary external dependency, which is stale (§15).

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
keepalive timer.

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
**Caveat (`cairn-sp74`, open):** that ceiling only bounds the *scheduled*
eager-reconnect timer path. `ensureConnected()` itself never checks
`reconnectTimer` — any ordinary `request()`/`batchRequest()` call during an
outage triggers its own fresh connect attempt regardless of backoff state,
so ambient request traffic (not just the subscription-driven reconnect
loop) can still hammer a dead server faster than the nominal 1s→30s
schedule implies.

**Message framing**: buffers by newline, JSON-parses each line, and
defensively rejects non-object payloads (null/array/primitive) rather than
crashing on a `TypeError` from a hostile or buggy server. Dispatch: numeric
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

### Esplora HTTP client — `src/lib/server/chain/esplora.ts`

`EsploraApi` wraps mempool.space-style / plain-esplora REST APIs. **Only
constructed when the operator explicitly sets `esploraUrl`** — never dialed
on a stock Umbrel/local-only deploy. `REQUEST_TIMEOUT_MS = 12_000`. Caches:
`SHORT_TTL_MS = 10s` (tip/mempool/fees), `IMMUTABLE_TTL_MS = 10min` (confirmed
txs/blocks), `PRICE_TTL_MS = 5min`. Uses global `fetch` (undici) normally;
falls back to node `http`/`https` + `SocksProxyAgent` when a SOCKS5 proxy is
configured (global `fetch` can't take a SOCKS dispatcher), using the
`socks5h://` scheme so DNS resolution stays proxy-side (no leak, `.onion`
hosts resolve — `cairn-oh7a`). `fetchErrorDetail()` unwraps chained `.cause`
up to 3 levels so a collapsed `TypeError: fetch failed` doesn't hide the real
DNS/TLS/refused cause underneath (`cairn-s17j` — this was the actual root
cause behind a prior "can't reach chain data" investigation). `probeV1()`
probes once whether the backend exposes mempool.space `/v1/*` endpoints
versus plain esplora (blockstream.info-style); a 4xx pins the answer false, a
network error leaves it undecided for re-probing later. Covers tip, blocks
(preferring `/v1/blocks` for `extras` — medianFee/feeRange/pool name),
block txs, tx detail/outspends/hex, RBF tree (mempool.space only), CPFP
(mempool.space only), address info/txs, mempool summary, fee estimates,
mempool block projections, mempool 2h statistics, difficulty
adjustment/history, hashrate. Kept strictly as a last-resort fallback.

### Bitcoin Core RPC client — `src/lib/server/bitcoinCore/client.ts`

`CoreRpcClient` — HTTP POST JSON-RPC 1.0-envelope client against `bitcoind`.
Added in the Esplora-removal Wave 2 so a Core+electrs-only deploy pays no
third-party timeout penalty. `REQUEST_TIMEOUT_MS = 12_000`. Auth: user/
password Basic auth, or cookie-file auth (reads `user:pass` from Core's
`.cookie` file, memoized, **re-read from disk on a 401** since Core rewrites
the cookie on every restart — retries once after refresh). Same SOCKS5/Tor
proxy pattern and cause-chain-unwrapping fix as Esplora, plus
`AggregateError.errors` unwrapping for Node's happy-eyeballs multi-address
dial failures. `CoreRpcError` carries Core's numeric error code (`-5`/`-8` =
not found, `-28` = still warming up/IBD) so `ChainService` can branch
cleanly on "not found" vs. "fall back to Esplora." Deliberately **no TTL
caching** in this module ("thin, honest transport" — callers cache where
appropriate). Wrapped RPCs: `getBlockchainInfo`, `getBlockCount`,
`getBlockHash`, `getBlockHeader`, `getBlock` (verbosity 0-3),
`getBlockStats`, `getRawTransaction` (needs `txindex` for arbitrary confirmed
non-wallet txids — errors propagate, not swallowed), `getTxOut`,
`getMempoolInfo`, `getMempoolEntry`, `estimateSmartFee`, `getNetworkHashPs`.
`ping()` never throws (used for the admin "test connection" button).

### `ChainService` facade — `src/lib/server/chain/index.ts` (~1700 lines)

Constructed from `getChainConfig()` (`settings.ts`). Notable methods:

- `getTip()` — TTL-cached (10min ceiling, invalidated instantly on every
  `'header'` event) via `electrum.headersSubscribe()`.
- `getRecentBlocks(limit, fromHeight)` — Electrum headers only; txCount/
  size/weight/fees are 0/null unless later enriched by Core.
- `getBlock` / `getBlockTxs` / `getTx` — try Core first, catch
  `CoreRpcError` codes -5/-8 as "not found" (with an Esplora retry attempted
  first, since Core's -5/-8 is ambiguous between "genuinely missing" and "no
  txindex"), else fall back to Esplora, else throw the "needs Core RPC"
  error.
- `getTxHex()` — Electrum `blockchain.transaction.get(verbose=false)`, LRU-
  cached cross-build by txid (`RAW_TX_CACHE_MAX = 200`) since confirmed tx
  bytes never change.
- `getTxRbfInfo()` — Esplora-only (`/v1/tx/{txid}/rbf`); `null` otherwise.
- `getCpfpInfo()` — Core (`getmempoolentry` + ancestors/descendants)
  preferred, Esplora fallback.
- `getAddressInfo` / `getAddressTxs()` — Electrum scripthash protocol only
  (no lifetime totalReceived/Sent field — Electrum has no equivalent without
  walking full history; the UI shows "unknown" rather than a misleading 0).
- `getMempoolSummary()` — Core `getmempoolinfo` preferred, Esplora fallback.
- `getFeeHistogram()` / `getMempoolBlocks()` — Electrum
  `mempool.get_fee_histogram`, projected locally into blocks via
  `projectBlocksFromHistogram()` (a greedy 1MvB-bucket packer, approximate by
  design), Esplora fallback only if the histogram is empty.
- `getMempoolTrend()` — reads the **locally persisted** rolling sample
  window (`mempoolSamples.ts`, §4.7), not a live call.
- `getFeeEstimates()` — 30s TTL-cached; 4 Electrum `estimatefee` targets
  (1/3/6/144 blocks) converted BTC/kvB → sat/vB, with a "carry forward from
  the next-longer target" repair pass for targets the server can't estimate
  (`-1`), floored at 1 sat/vB.
- `getDifficultyInfo()` / `getDifficultyHistory()` / `getHashrate()` — all
  derived from Electrum block headers, no Esplora/Core dependency at all.
- `getBtcUsdPrice()` — see the backend-priority list above.

`reconfigureChain()` is called after an admin saves connection settings —
tears down the old `ChainService` (no restart needed) and resets **every**
piece of per-backend in-memory state: connection dedup state
(`chainEvents.ts`), chain-health failure counters, package-relay support
cache, and the tip/fee TTL caches. **This is the one place that must reset
all per-backend caches/state** — a new module that adds backend-specific
in-memory state needs a reset hook wired in here too, or it will leak stale
data across an admin-triggered server switch. `testElectrum`/`testEsplora`/
`testCoreRpc` are standalone connectivity probes for the admin settings "Test
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
pure read with no network call, feeding the "can't reach the Bitcoin
network" banner and the admin settings proxy indicator.
`noteProxyConfigured()` lets the banner distinguish "misconfigured Tor/SOCKS
proxy" from "node down."

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
  inbound txids.
- On each new block (`'header'`) → `handleNewBlock()`: re-checks every
  pending (`confirmed=0`) `notified_txids` row's confirmation count against
  `CONFIRM_THRESHOLD = 1`, firing `tx_confirmed` once crossed.
- Refreshed every `REFRESH_INTERVAL_MS = 5min` (`refreshWatches()`) to pick
  up newly created wallets — this is **poll-based, not a creation hook**,
  deliberately, to avoid an import cycle with the wallet layer. A brand-new
  wallet is not watched instantly; don't "fix" this by adding a redundant
  creation hook (§15).

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
  new-block event passes `force: true`. `doRefresh()` fetches recent blocks
  (the "required" fetch — its failure means the backend is unreachable) plus
  mempool summary/fees/tip/mempool-blocks/fee-histogram/mempool-trend, each
  individually `.catch(() => null)` so a partial-capability backend (plain
  esplora) degrades field-by-field instead of failing the whole refresh.
  Epoch-scale data (hashrate/difficulty info/history) is only refetched when
  the tip height actually changed since the last successful refresh —
  otherwise carried forward from the persisted snapshot, since refetching
  every 20s would waste 3 Electrum round-trips for data that's identical
  within a block. **Never overwrites a good snapshot with a failure** — on
  error, returns the last-good snapshot (stale) if one exists; only throws
  when there's nothing cached at all.
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
  so `GET /api/portfolio` is a synchronous cache read. `warmAllSnapshots()`
  is the startup warm across every user, aborting the whole pass on a
  connect-class failure. **The send/PSBT flow deliberately bypasses
  snapshots entirely** — it always re-scans live for fresh UTXOs
  (correctness beats freshness there).
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
  Prefers mempool.space's all-time retarget-history endpoint; falls back to
  fetching each boundary block directly on plain esplora. Cached forever in
  the `settings` table — immutable chain history, only a new boundary
  crossing (~every 2 weeks) adds one entry.
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
   port/TLS and Core RPC url/user/pass from `CAIRN_ELECTRUM_*`/
   `CAIRN_CORE_RPC_*` env vars. Seed-once-if-unset, non-destructive: only
   writes a setting if it has never been stored, so an admin's later manual
   edit in Admin → Settings is never clobbered on restart. `core_rpc_pass`
   goes through the encrypted `setSecretSetting()` path, never plaintext.
   Setting `electrum_host` also flips `connection_mode` to `'custom'` if
   unset (a stored host is otherwise inert in `'public'` mode). Only when the
   adopted host actually got written does this also stamp
   `chain_provisioned_by = 'umbrel-env'` (never on a no-op skip, so a
   manually-entered connection is never mislabeled as auto-connected).
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
   non-destructive contract as step 3. Covers Umbrel installs where
   electrs/Fulcrum is running but Cairn's manifest doesn't declare a hard
   `dependencies:` entry on it (so step 3's env vars never arrive). Never
   throws; every candidate unreachable (or non-Umbrel platform, or already
   configured) is a silent no-op — the existing public-server default /
   manual Admin → Settings entry is unaffected.
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
3. **Esplora is a fallback, not a first-class backend** — every
   `ChainService` method that touches it checks `this.esplora` for null
   first.
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
fetch) is treated conservatively as possibly-immature. `preferLowMassOrder()`
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
rejects if change would drop below `DUST_SATS` (546) rather than pulling in
new inputs to cover a bigger fee — the code deliberately refuses rather than
silently changing what the user reviewed.

**Known gap (`cairn-ykk6`, open): plain recipient amounts have NO pre-flight
dust check.** `DUST_SATS = 546` is only enforced on the two paths above —
the send-max sweep result and the RBF change-output floor. A plain
recipient amount (e.g. `amount: 100`) has no equivalent check at
`constructPsbt`/`constructMultisigPsbt` time: the draft builds and persists
silently, and the dust output only ever fails much later, at broadcast,
via the network's mempool relay policy — a confusing, late failure instead
of an immediate, clear one. Found (not fixed) during the `cairn-9v9g`
send-flow boundary-matrix work and pinned in "KNOWN GAP" `describe()`
blocks in `src/lib/server/bitcoin/sendBoundaryMatrix.test.ts` and
`src/lib/server/sendBoundaryDraft.test.ts` so a future fix can't land
without those tests being updated. A correct fix needs
per-destination-script-type dust thresholds (via `outputVsize()` —
P2SH/P2WPKH/P2TR outputs have different dust floors), applied at
draft-build time for plain sends, not just the sweep/RBF paths.

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
- `validateRecipientsAndFeeRate()` — recipient/fee-rate validation, identical
  user-facing messages for both wallet types.
- `selectSpendCandidates()` — coin eligibility + coinbase-maturity
  filtering.

`multisigPsbt.ts` imports both directly from `./psbt`. This was a deliberate
refactor — the file headers of `multisig.ts`/`psbt.ts` note that
`multisigPsbt.ts` "used to carry a verbatim copy of each block."

### buildDraft / broadcast — shared lifecycle, still two parallel services

Two structurally parallel services, **not** merged into one:
`src/lib/server/transactions.ts` (single-sig, table `transactions`) and
`src/lib/server/multisigTransactions.ts` (multisig, table
`multisig_transactions`). The multisig file's header comment states this
explicitly: "Mirrors transactions.ts deliberately — same lifecycle
vocabulary, same atomic broadcast claim, same substitution guard — but
against the parallel multisig_transactions table." `multisigTransactions.ts`
imports several helpers straight from `transactions.ts` (`normalizePsbt`,
`InvalidPsbtError`, `BroadcastError`, `detectUnconfirmedInflows`,
`classifyUnconfirmedTrust`, `tryPackageRescue`, `coinsReservedByDrafts`,
`reservationErrorMessage`, `reservationWarningFor`) — so the two files are
coupled (one imports from the other) for these pieces, not siblings of a
third shared module.

**`buildDraft` lifecycle** (`transactions.ts` `buildDraft()`):

1. `withLock('wallet:<id>', ...)` (`keyedLock.ts`) — serializes concurrent
   draft builds *per wallet* (commit `ff2d16f`). The reservation-exclusion
   read is racy on its own (multiple awaits between the read and the
   INSERT), so two truly concurrent `buildDraft` calls could each see
   "nothing reserved" and pick the identical coin; the lock closes that
   window. Builds against *different* wallets are unaffected (keyed by
   walletId) — the same primitive `nextReceiveAddress` uses for an analogous
   read-scan-derive-write race.
2. Fetches live UTXOs (`getWalletUtxos` → Electrum `scripthash.listunspent`,
   batched, lane-routed `background`), classifies unconfirmed trust,
   optionally fetches tip height (only if a coinbase coin is present).
3. Derives the next change address.
4. **Coin reservation**: `reservedWalletCoins(walletId)` returns a map of
   `"txid:vout" -> draft ids` for every coin referenced by this wallet's
   other in-flight (`draft`/`awaiting_signature`) drafts, computed by
   re-parsing each draft's stored PSBT via `summarizePsbt().inputs`
   (`coinsReservedByDrafts`, shared with multisig — **there is no
   reservation table**). Auto-selection excludes these coins; coin control
   can still deliberately target a reserved coin (RBF/respend), surfaced as
   a non-blocking `reservationWarning` naming the colliding draft id(s).
5. Calls `constructPsbt()`, inserts a `'draft'` row, returns `{draft,
   details, chainDepthWarning, reservationWarning}`.

**Broadcast dedup** (`broadcastTransaction()`, commit `8b591c2`): several
drafts built from identical inputs/recipient/amount/feeRate — exactly what
the coin-reservation race used to allow — sign to the byte-identical
transaction (deterministic ECDSA/RFC6979). Previously every one of them
would broadcast "successfully" and each get marked `'completed'` with the
same real txid — N phantom "sends" on record for one transfer. The fix:
- `findCompletedDuplicateId()` checks whether a *different* `'completed'`
  row already exists in this wallet with this exact txid.
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
  (`broadcast_started_at`) so two concurrent calls for the *same* row can't
  both reach the network — the loser sees `'already_sent'`. A stale claim
  (crash mid-broadcast) expires after 60s so **retry** isn't wedged forever
  — `broadcastTransaction`/`broadcastMultisigTransaction` let a claim older
  than 60s be overwritten by a fresh attempt. That 60s staleness window is
  **not** mirrored on the delete path: `deleteTransaction`/
  `deleteMultisigTransaction` refuse to delete a row whenever
  `broadcast_started_at IS NOT NULL`, full stop, with no age check — so a
  row left behind by a broadcast that crashed mid-flight blocks deletion
  indefinitely until it's explicitly reclaimed by a retry or transitions to
  `completed`/`superseded` (`cairn-ytnc`, open — low-severity by design,
  since it errs toward never silently losing a broadcast record, but the
  60s figure is retry-only, not a universal expiry).
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
  childVsize) = ceil(targetRate*(parentVsize+childVsize)) - parentFee`,
  floored to the child's own 1 sat/vB relay minimum. Qualifying inputs are
  the wallet's own unconfirmed outputs ON the stuck parent txid,
  coin-controlled and swept (send-max) to a fresh change address. Caps the
  target rate at the same `MAX_FEE_RATE` the PSBT builder enforces (a
  caller of it, not a bypass). Errors are typed (`CpfpError`) with specific
  codes: `no_unconfirmed_output`, `already_confirmed`, `parent_fee_unknown`,
  `not_needed` (parent already meets target), `coin_too_small`.
- `BumpError`/`CpfpError` are typed error classes with closed `code` unions
  the UI branches on.

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
inconsistency. Two known gaps in the gate itself, both open: **`cairn-ryjc`**
— the BIP-48 coin/account/script-type levels are checked by numeric value
only (`unhardened()`), never confirming the hardened bit is actually set,
so `m/48'/0/0'/2'` (unhardened coin type) or `m/48'/0'/0'/2` (unhardened
script-type) both pass when they shouldn't; every existing acceptance test
happens to use fully-hardened paths, so this hole doesn't show up in
practice yet. **`cairn-e8de`** — `stateless.ts`'s descriptor-import escape
hatch never calls `validateMultisigKeyPaths` at all, so a malformed or
wrong-script-type cosigner path pasted through that path is not caught at
ingestion the way the wizard and Caravan-JSON import paths are. Don't
describe this gate as airtight when reviewing or extending it.

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

**Shared** (post wallet-dedup-refactor):
- `psbt.ts`'s `validateRecipientsAndFeeRate` / `selectSpendCandidates`.
- `feeBump.ts`'s entire RBF+CPFP engine — the single biggest dedup win; both
  services call the same `executeRbfBump`/`executeCpfpDraft` skeletons.
- `coinsReservedByDrafts` / `reservationErrorMessage` / `reservationWarningFor`
  / `detectUnconfirmedInflows` / `classifyUnconfirmedTrust` / `normalizePsbt`
  / `InvalidPsbtError` / `BroadcastError` / `tryPackageRescue` — all defined
  in `transactions.ts` and imported directly by `multisigTransactions.ts`.
- All 4 USB hardware-signer drivers (Trezor/Ledger/BitBox02/Jade) already
  handle both single-sig and multisig signing within one file each.
- Descriptor/BIP-48/Caravan logic in `multisig.ts`/`multisigExport.ts` has no
  single-sig equivalent to fork from — it's inherently multisig-only.

**Still forked** (confirmed remaining duplication, `cairn-rg99`):
- `constructPsbt` (`psbt.ts`) vs `constructMultisigPsbt` (`multisigPsbt.ts`)
  — two separate PSBT-building functions sharing only the two validation/
  eligibility helpers above. Multisig construction additionally handles
  N-of-M `bip32Derivation` sets, witnessScript/redeemScript attachment, and
  incremental-signature accumulation (`combineMultisigPsbts`,
  `multisigPsbtProgress`) that single-sig has no analog for.
- `transactions.ts` vs `multisigTransactions.ts` — two parallel service
  files over two parallel DB tables. The multisig file's own header comment
  names this as deliberate: a multisig draft's lifecycle genuinely differs
  (accumulates signatures across several attach calls until quorum; roster
  freeze/notification hooks; viewer-vs-cosigner-vs-owner access tiers) even
  though the *shape* mirrors `transactions.ts` closely.
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

**Cross-table cleanup via triggers, not app code.** Five "polymorphic child"
tables (`balance_snapshots`, `wallet_backups`, `address_labels`,
`backup_missing_notified`, `notified_txids`) key off a `(wallet_kind,
wallet_id)` pair rather than a real FK (SQLite has no polymorphic FK). Two
triggers, `trg_wallets_delete_children` and `trg_multisigs_delete_children`
(`db.ts:833-853`), sweep all five whenever a `wallets`/`multisigs` row is
deleted — covering both direct `DELETE`s and cascaded user deletion. They're
defined with `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` (not `IF NOT
EXISTS`) specifically so edits to the trigger body actually redeploy to
existing DBs. `deleteCascade.test.ts` introspects the DB and fails loudly if
a new `(wallet_kind, wallet_id)` table is ever added without wiring it into
both triggers — **if you add such a table, wire the trigger first or this
test will catch you.** One exception: `multisig_shares` also has a
`wallet_kind` column but is deliberately excluded — its parent link is a
real `multisig_id` FK with `ON DELETE CASCADE`. There's also a plain "sweep
now, unconditionally, every boot" orphan purge (`db.ts:864-877`) for rows
left behind before the triggers existed.

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
| `invites` | invite codes (code, max_uses, used_count, revoked, expires_at) |
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
| `settings` | plain key/value store (registration_mode, instance_mode, electrum_*, esplora_url, socks5_*, core_rpc_url/user, auth_mode, ...) |
| `instance_secrets` | key/value_enc — encrypted-at-rest counterpart to `settings` |
| `feature_flags` / `user_feature_flags` | global + per-user overrides |
| `announcements` / `announcement_dismissals` | admin banner system |
| `multisig_service_referrals` | admin-managed "buy a device / managed multisig service" links |
| `device_keys` | cache of xpub last read off a HW device per (user, master fingerprint, purpose) |
| `backup_reminders` | per-user dismissal timestamp for the periodic backup nudge |
| `wallet_backups` | one row per wallet once its config file has been downloaded |

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

---

## 8. Server: API Routes & Cross-Cutting Server Concerns

### API route map (`src/routes/api/**/+server.ts`, ~100 endpoint files)

| Area | Endpoints (relative to `src/routes/api/`) |
|---|---|
| Auth | `auth/login/{options,password,verify}`, `auth/me`, `auth/passkeys[/:id][/options]`, `auth/recover/{password,register/options,register/verify,verify}`, `auth/recovery/{codes,phrase,status}`, `auth/register/{options,password,verify}` |
| Wallets (single-sig) | `wallets`, `wallets/[id]`, and under `wallets/[id]/`: `address-labels`, `addresses`, `config`, `descriptor`, `history.csv`, `labels`, `psbt`, `receive`, `refresh`, `transactions[/:txId][/broadcast\|/bump\|/file]`, `transactions/cpfp`, `transactions/saved`, `utxo-mass` |
| Wallets (multisig) | `wallets/multisig`, `wallets/multisig/import`, `wallets/multisig/[id]` and under it: `address-detail`, `address-labels`, `backup-pdf`, `caravan`, `coldcard`, `descriptor`, `history.csv`, `keys/[keyId]/verified`, `ledger-registration`, `psbt`, `receive`, `refresh`, `shares[/:shareId]`, `transactions[/:txId][/broadcast\|/bump\|/file]`, `transactions/cpfp`, `utxo-mass` |
| Chain / market data | `blocks`, `blocks/[id]`, `chain/refresh`, `chain-health`, `mempool/{fees,projected,summary}`, `price`, `search`, `sync`, `tx/[txid]`, `address/[address]`, `signing-time-preview` |
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
`wallet_config_export/import`, `explorer` (defaults on, but fresh installs
get it toggled off as a newcomer-declutter default via
`explorerDefaultMigration.ts` — NOT an admin restriction, hence its
differently-worded `userMessage`; every `/explorer/**` link app-wide —
multisig detail, send-sent pages, activity feed, wallet detail — degrades to
plain non-interactive text via `svelte:element` when the flag is off rather
than a dead link; `cairn-o90e` closed the last two pages (activity, wallet
detail) that still skipped this); `hw_trezor/ledger/coldcard/bitbox02/jade`;
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
`security_password_changed`, `security_new_device`.

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

**SMTP — global + per-user creds**: `channels/email.ts`'s
`readSmtpConfig(userId)` resolves SMTP host/port/user/`smtp_pass`/from/tls
per-user from `notification_channel_config`; `resolveSmtp(userId)` wraps
that with error handling. A **global** SMTP config also exists via
`readSecretSetting('smtp_pass')` in `instance_secrets` for the admin-level
fallback/test-smtp route (`admin/notifications/test-smtp`,
`notifications/channels/email/test-smtp`).

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
Wraps every authenticated page with:
- `HWRail` (desktop left rail nav — 92px wide, each icon carries a persistent
  always-on text label underneath it, no hover-to-reveal) / `MobileTopBar` +
  `MobileTabRow` (mobile),
  switching on `isTabRoute()` — tab pages are `/`, `/wallets`, `/vaults`,
  `/activity`, `/explorer/**`; everything else is a "flow" page and gets a
  `BackCircle` header instead (wallet/vault detail, send/sign wizards,
  `/settings/**`, `/admin/**`, `/recovery-setup`). `/vaults` is classified as
  a tab route for consistency, but **has no real pages** — see the route
  table note below before "helpfully" building one.
- `ChainHealthBanner` — always mounted, silent unless Electrum/SOCKS5 is
  unhealthy. Two distinct unhealthy states, both from `getChainHealth()`
  (`chainHealth.ts`): **never-configured** (`health.neverConfigured` true —
  `isChainNeverConfigured()` in `settings.ts` sees `connection_mode` still on
  its `'public'` default AND `chain_provisioned_by` unset, i.e. a fresh
  install nobody has touched) renders a calm neutral `.neutral`-variant
  banner ("Heartwood isn't connected to the Bitcoin network yet", admin-only
  "Connect a node" link to `/admin/settings`, operator-facing copy for
  non-admins) instead of red warning styling; any other unhealthy state
  (admin configured it, or Umbrel auto-connected, and it's now actually
  unreachable) keeps the original red "can't reach it" copy/styling. Fixed
  `cairn-7zjo` (`c90481f`/`85a24da`) — previously every unhealthy state used
  the same red error treatment, which read as "broken" rather than
  "not connected yet, please configure a node" on a healthy fresh install.
- `SyncBanner` — shown until first chain-history sync completes (polls
  `/api/sync`); self-suppresses (`{#if !hidden && !suppressed}`) when
  `syncStatus.ts`'s `deriveSyncStatus` reports phase `'unreachable'`, since
  that phase is only reached when `chainHealthy` is already false — i.e. the
  identical root cause `ChainHealthBanner` is already showing. Also fixed in
  `cairn-7zjo`: before this, a never-configured or unreachable instance
  could show BOTH banners stacked, which read as doubly broken; distinct
  causes (connecting/history-scan progress while the chain IS reachable)
  still show `SyncBanner` normally.
- `AnnouncementBanner` — admin announcements, server-filtered by flag/
  expiry/dismissal.
- Backup nudge banners: an urgent "N wallets aren't backed up" banner
  (dismiss via `sessionStorage cairn.backup.banner.dismissed`) and a gentler
  90-day "reminder" banner (dismiss is a server POST to
  `/api/backup-reminder/dismiss`, since it must persist across
  browsers/devices).
- `maybeRedirectToSecure()` fires in `onMount` to auto-hop returning users to
  the HTTPS listener (§9.7 below).
- Desktop content column caps at `max-width: 940px` (settings/activity/admin
  narrow further to 760px in their own pages).

Pages under `(app)`:

| Route | Purpose |
|---|---|
| `+page.svelte` | Home/portfolio dashboard |
| `activity/+page.svelte` | user activity feed |
| `wallets/+page.svelte` | wallet list |
| `wallets/new/+page.svelte` | single-sig add-wallet wizard (§9.4) |
| `wallets/[id]/+page.svelte` | single-sig wallet detail |
| `wallets/[id]/send/+page.svelte` | single-sig send flow (§9.4) |
| `wallets/multisig/new/+page.svelte` | multisig creation wizard (§9.4) |
| `wallets/multisig/[id]/+page.svelte` | multisig vault detail |
| `wallets/multisig/[id]/send/+page.svelte` | multisig send/co-sign flow |
| `wallets/multisig/stateless/+page.svelte` | stateless (no-account) multisig PSBT signer |
| `explorer/+page.svelte` | block explorer home — includes an "Up next" strip (up to 4 projected-block chips, fed by the same server-loaded `mempoolBlocks` snapshot, linking through to the full mempool treemap viz; hidden gracefully rather than erroring when the chain backend has no projection data) |
| `explorer/address/[address]`, `explorer/block/[id]`, `explorer/tx/[txid]` | detail pages — `explorer/block/[id]` shows a block-level "Yours in this ring" callout AND (cairn-6efi.12) a per-row sage "Yours" pip on any transaction in the paginated tx list that touches the viewer's own wallets, via `ownership.server.ts`'s memoized, viewer-scoped `ownedTxids()`/`ownedTxsInBlock()` — zero extra chain calls, same privacy boundary (viewer's own wallets only) as the index's `ownedBlockHeights()` pip |
| `explorer/mempool/+page.svelte`, `explorer/mempool/blocks/+page.svelte` | mempool visualizer |
| `explorer/difficulty` | difficulty chart |
| `recovery-setup/+page.svelte` | post-signup recovery/backup setup flow |
| `settings/+page.svelte` | general settings |
| `settings/contacts` | address book |
| `settings/devices` | linked/trusted devices |
| `settings/notifications` | per-user notification prefs incl. SMTP |
| `settings/tokens` | API tokens |
| `admin/+layout.svelte` + `admin/+page.svelte` | node/admin home |
| `admin/activity`, `admin/announcements`, `admin/backup`, `admin/feature-flags`, `admin/invites`, `admin/logs`, `admin/notifications`, `admin/referral-settings`, `admin/settings`, `admin/users[/[id]]` | admin-only surfaces; the nav link itself is hidden (not just gated) for non-admins |
| `vaults/{new,[id],[id]/send,stateless}` + `_components` | **empty scaffolding only** — `git ls-files` returns zero tracked files under any of these dirs. Mirrors the `wallets` tree in shape (list → `[id]` → send) but nothing is implemented. Any hit on `/vaults*` (bare or with a path) is 301-redirected to the equivalent `/wallets` (or `/wallets/multisig`) route by `hooks.server.ts:505-516` before it would ever reach these directories — see §7 and the Part II route note. Don't start building real `/vaults` pages without checking scope first. |

**`(auth)` — unauthenticated.** `+layout.server.ts`/`+layout.svelte`,
`login/+page.svelte` (+ `nextUrl.ts`/test — safe post-login redirect target
parsing), `signup/+page.svelte`, `recover/+page.svelte`.

**Top-level standalone routes**: `agreement/`, `terms/`, `disclosure/` (each
has a `+page.server.ts`; `agreement` has a `server.test.ts`); `setup-admin/`
(first-run admin bootstrap); `sync/+page.svelte` (dedicated first-sync
progress page, distinct from the in-layout `SyncBanner`); `logout/+page.server.ts`
(logout action only, no UI).

**`api/`** — the ~100-endpoint JSON tree covered in §8, consumed by client
polling/fetch (e.g. `ChainHealthBanner` polls `/api/chain-health`,
`SyncBanner` polls `/api/sync`).

### Svelte components (`src/lib/components`)

Flat top-level components: `Amount` (renders a BTC/sats value plus its live
fiat equivalent from `$lib/price` wherever a price is available; used
app-wide including the stateless multisig flow, single-sig send, explorer
address history, and the wallet unconfirmed-incoming line — PSBT
"verify against your device" panels, fee/change/input breakdown line items,
and `BalanceChart` axis labels stay BTC/sats-only by design),
`AnnouncementBanner`, `Banner` (persistent inline
error/status banner — contrast with toasts below), `CopyText`,
`CoreRpcRequiredNotice`, `DevicePicker` (grid of signing-device tiles, gated
per-tile by feature flag, `file` is the ungated universal fallback — §9.7),
`FeatureDisabled` (flag-gated placeholder), `HowItWorks` (collapsible
per-page explainer, open/closed state persisted in `localStorage` keyed
`cairn.explain.{id}`), `Icon`, `MiningRewards`, `NotificationPanel`,
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
`MobileTopBar`, `Modal`, `NavProgress`, `QuorumArc` (multisig m-of-n
visual), `RingStub`, `SyncBanner`, `SyncIndicator`.

**`portfolio/`**: `AllocationBar`, `BalanceChart`, `RecentActivity`,
`Sparkline` — home-dashboard widgets.

**`signing/`** — shared hardware-wallet signer UI (used by both single-sig
send and elsewhere): `BitboxSigner.svelte`, `JadeUsbSigner.svelte`,
`LedgerSigner.svelte`, `TrezorSigner.svelte`, `DeviceHelpLink.svelte`,
`SecureContextHelp.svelte` (§9.7). Route-local signer variants that aren't
shared live under `wallets/[id]/send/_components/` (`ColdCardSigner`,
`QrSigner`, `JadeQrSigner`, `DeviceCard`, `CoinControl`,
`RecipientCombobox`) and `wallets/multisig/[id]/send/_components/
MultisigFileSigner.svelte`.

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
  polling/SSE-style helpers for chain-tip refresh (`onNewBlock` is imported
  by the send page to refresh fee estimates on a new block).
- **`src/lib/sseReconnect.ts`** — reconnect-with-backoff helper, backing
  `/api/events` SSE consumers.
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
desktop keeps the original device-first card order unchanged. Uses `DevicePicker` for the flag-gated device grid,
`_components/deviceRead.ts` for the actual WebUSB/WebHID reads,
`_components/coldcardImport.ts` for ColdCard file parsing,
`_components/multisigDetect.ts` to catch a multisig config uploaded here and
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
would look like resumable progress that isn't. Phase 1 explicitly scoped as
sessionStorage-only, no server-side draft persistence. `vaultIntent.server.ts`
handles server-side intent/state for the wizard. Also uses its own
`_components/coldcardImport.ts`, `_components/deviceRead.ts` (device read
reused per-wizard, not shared with single-sig's copy).

**Send flow** — `src/routes/(app)/wallets/[id]/send/+page.svelte`
(single-sig). Five steps: **Create → Review → Sign → Confirm → Sent**
(`StepKey` union). Resumable via a saved `SavedTransaction` row (not
sessionStorage) — `?tx=` query param round-trips the draft id
(`syncTxParam`), and `initialStep()` derives which step to land on from the
saved row's lifecycle (`completed`→Sent, `awaiting_signature`→Confirm if
fully signed else Sign, else Review/`draft`). Composes: `CoinControl`,
`RecipientCombobox`, `GroveField`/`EyebrowBreadcrumb`/`QuorumArc`/
`BurialRings`/`Modal`/`BackCircle`/`AtTipPill` (Heartwood chrome), `Term`/
`HowItWorks` (plain-language scaffolding), per-device signer components
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

The Create step's amount field (`AmountEntry.svelte`, shared by both the
single-sig and multisig send flows) is a labelled pill that cycles
BTC → sats → USD → BTC via a swap-horizontal glyph on `Icon` — deliberately
not the circular refresh-arrow glyph it replaced, which phone testing showed
users read as "reload" rather than "switch currency" (`cairn-id5o`). Sats
display as an integer with thousands separators. Cycling only re-renders the
input text from the existing canonical value; the amount is always stored in
sats, so switching the displayed unit never recomputes it and can't drift.

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
warning and a note that passkeys don't work on the self-signed address.
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
  get the same affordance as mouse hover.
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
- **Backup nudges** in the `(app)` layout are tiered by urgency
  (never-backed-up wallet = persistent warm-tan banner that returns every
  session until resolved; stale backup = softer periodic reminder
  dismissible for 90 days) rather than one generic "backup" nag —
  proportionate friction matched to actual risk.

---

## 10. Client: Heartwood Design System

`src/app.css` is the single global stylesheet, self-described in its header
comment: "Standing inside the trunk: deep wood charcoal, copper growth
rings, serif numerals. Grammar: hairlines not boxes, pills not cards, depth
from the grove field — not glow." Reading that comment is the fastest way to
internalize the visual language before touching any component.

Theming is CSS custom properties on `:root`, **dark-only**
(`color-scheme: dark`, no light theme toggle):

| Group | Variables | Notes |
|---|---|---|
| Surfaces | `--bg` (#100d0b), `--bg-deep`, `--bg-input`, `--bg-strip` | legacy tiers `--surface`/`--surface-elevated` kept only for not-yet-reskinned cards — new work uses `--bg-input` fills + hairline rows instead of boxed cards |
| Borders | `--border`, `--border-subtle`, `--hairline`, `--border-control`, `--border-ghost` | `--hairline` = the 1px row separators that give the "hairlines not boxes" grammar its name |
| Text | `--text`, `--text-hero`, `--text-rows`, `--text-secondary`, `--text-muted`, `--text-faint` | `--text-faint` is **explicitly documented as failing AA contrast by design** — decorative/disabled only, never informative copy |
| Breadcrumb | `--eyebrow`/`--eyebrow-path` | used by `EyebrowBreadcrumb` |
| Accent | `--accent` (#e8935a family: hover/pressed/bright/glow/glow-strong/core), `--accent-dim`/`--accent-dim-2`, `--accent-muted`, `--accent-border`/`--accent-border-strong`, `--on-accent`/`--on-accent-ghost` | copper |
| Status | `--sage` (success/received/connected/valid), `--attention` (warm tan — nudges AND form validation), `--caution`/`--caution-muted`/`--caution-border` (burnt-orange, #dd7a52 — sits between `--attention` and `--error`; backs the multisig quorum-risk panel's salmon "Loose" tier so it reads as its own tier distinct from the red "Risky" one, not just a bolder border on the same red), `--error`/`--danger` (red, #e0604c) | "never red for routine states"; red is reserved for irrecoverable failures only — an explicitly-called-out "off-spec extension: Heartwood has no red" otherwise |
| Typography | `--font-ui` (Inter), `--font-serif` (Source Serif 4, used for `.hero-number`), `--font-mono` | the "serif numerals" branding element |
| Radii | `--radius-pill` (26px), `--radius-toggle`, `--radius-status-pill`, `--radius-icon-btn`, `--radius-badge`, `--radius-strip` | pill-first; legacy `--radius-card`/`--radius-control`/`--radius-chip` kept as literal fallbacks for unreskinned components |
| Motion | `hwPulse`, `hwBlink`, `hwSweepOnce`, `hwGrow`, `hwShimmer`, `hwSpin`, `hwBreathe` | raw `@keyframes` primitives; components set their own duration/timing at the call site; all neutralized under `@media (prefers-reduced-motion: reduce)` |

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
- There is no light theme to keep in sync — don't add one without a
  deliberate design decision, since `color-scheme: dark` is hardcoded.

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
(SLIP-132 version bytes), normalizes to standard xpub bytes, and rejects
private keys and non-mainnet prefixes outright — Cairn is mainnet-only by
design. HW drivers (`src/lib/hw/common.ts`) implement single-sig BIP-44/49/
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
| `CAIRN_ORIGIN` | unset (falls back to request origin) | absolute origin used in notification email links / WebAuthn origin fallback; Umbrel sets `http://${DEVICE_DOMAIN_NAME}:3211` |
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
(`src/lib/server/settings.ts`), changeable from `/admin/settings` with no
restart. The `CAIRN_ELECTRUM_*`/`CAIRN_CORE_RPC_*` env vars only *seed* that
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

**Bitcoin Core RPC settings are saved independently of `connection_mode`.**
`core_rpc_url`/`core_rpc_user`/`core_rpc_pass` have no relationship to the
Electrum `connection_mode` toggle — `getChainConfig()` returns `coreRpc*` in
both `'public'` and `'custom'` modes, since Core is "configured" purely by
whether `core_rpc_url` is set. The `/admin/settings` `save` form action
(`src/routes/(app)/admin/settings/+page.server.ts`) and the JSON endpoint
(`src/routes/api/admin/settings/+server.ts`) both write these three keys
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

**The `/admin/settings` UI now matches that backend contract too
(`cairn-3p9z`, swept into `03879a0`).** The Bitcoin Core RPC subgroup in
`+page.svelte` used to be nested inside the same `connectionMode === 'custom'`
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

Aliases `$lib` → `src/lib` and `$env/dynamic/private` →
`src/tests/env-stub.ts`. `test.include: ['src/**/*.test.ts']`,
`setupFiles: ['src/tests/setup.ts']`.

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

**CI**: `.github/workflows/ci.yml` — on every push/PR: checkout, Node 22,
`npm ci`, `npm run check`, `npm test`. No Docker build step in CI today
(flagged as a still-open improvement).

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

1. **README's "Configuration notes" section is stale on Esplora.** It still
   describes Esplora as an external dependency required for block/mempool
   detail. Esplora was demoted to a last-resort fallback and Bitcoin Core
   RPC was added as the primary "explorer-rich" backend in the v0.2.9
   "Esplora-removal Wave 2" (see §4). A stock Umbrel deploy has
   `esplora === null`, `core !== null`. The manual describes the current
   Electrum→Core→Esplora priority; README needs a docs pass to match.
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
9. **Watcher registration is poll-based (5-minute `refreshWatches()`), not
   event-driven** — a newly created wallet is not watched instantly; it
   picks up on the next 5-minute sweep. This is a deliberate choice (avoids
   an import cycle between `addressWatcher.ts` and the wallet layer), not a
   bug, but it's surprising enough that someone will eventually propose
   adding a redundant creation hook. Don't — the poll-based design is on
   purpose (§4).
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
    `stateless` signer page has zero inbound links), **cairn-jy3g**
    (multisig wizard needs server-side draft persistence, unlike single-sig's
    sessionStorage resume), **cairn-czi0** (`multisigScan.ts` almost entirely
    untested, including the spend-flow data path); the **cairn-6xxa** P1
    epic (sync/dashboard/derivation perf re-architecture, 7 dependent beads);
    and the **cairn-zoz8** P1 epic (removing the last Esplora remnants —
    Wave 2 already shipped Core RPC + zero third-party calls on Umbrel, but
    `EsploraApi` removal/admin-settings cleanup/RBF-lineage-on-Core-RPC
    children are still open).
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
- **The Heartwood system is dark-only** (`color-scheme: dark` hardcoded);
  there is no light-theme variable set to maintain (§10).
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
  `electrs`/`bitcoin` dependency wiring); a stock deploy has `esplora === null`,
  `core !== null`, Electrum primary.
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

### 16.5 Funding a Cairn wallet on regtest — the scriptPubKey bridge `[emulator]`
**Critical constraint (grounded):** `parseXpub()` is **mainnet-only** — Cairn derives only
`bc1…`/`3…`/`1…` mainnet address strings and rejects testnet/regtest xpub prefixes. A
regtest `bitcoind` will not `sendtoaddress` a mainnet bech32 string. But the watcher and
scanner attribute inbound value by **scriptPubKey membership, not address string**
(cairn-v13r/j6fv). So fund via the scriptPubKey, not the displayed address:
1. In Cairn, get the wallet's descriptor: `GET /api/wallets/{id}/descriptor` (single-sig)
   or `/api/wallets/{id}/config` / the multisig Caravan/descriptor export.
2. Import that descriptor **watch-only** into a Core regtest wallet
   (`importdescriptors`), then `getnewaddress`/`deriveaddresses` from Core to obtain the
   `bcrt1…` address that shares the **same scriptPubKey** as Cairn's `bc1…` at that index.
3. `sendtoaddress` regtest coins to that `bcrt1…` address; `generatetoaddress 1` to confirm.
4. Cairn's watcher/scan matches by scriptPubKey and credits the deposit.
- **PASS:** balance appears in `/wallets/{id}` and a `tx_received` then `tx_confirmed`
  fires (subject to the ≤5-min watcher-refresh lag for a newly created wallet — see §20.4).
- This is why fully-GUI receive testing on regtest has friction: the displayed address
  can't be pasted into regtest tooling directly. On **mainnet** the GUI receive→fund path
  is direct (real sats). Prefer the vault-e2e module-level harness for regtest signing.

### 16.6 Creating test users
- **First user = admin** automatically (`isFirstUser`). Signup at `/signup`
  (email + password; passkeys are additive, not required and not usable on the self-signed
  HTTPS origin — email+password there).
- Additional users: registration mode is `open`/`invite`/`closed` (`/admin/settings`,
  `/admin/invites`). Multi-user *management* (invites, contacts, shares) is gated on
  `instance_mode = 'team'`; a fresh install defaults to **solo** — flip it in
  `/admin/settings` before testing §17 collaborative scenarios.
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
  live DB setting; change it through `/admin/settings` so `reconfigureChain()` resets the
  in-memory caches/health counters too.

---

## 17. Multi-user collaborative multisig scenarios

Preconditions for all of §17 unless stated: instance in **team** mode (`/admin/settings`);
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
1. In `/admin/settings` set instance mode to **solo**.
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
     would drop below `DUST_SATS` (546) the bump is **refused** with a clear message;
     (d) a **changeless** original cannot be bumped (no fee headroom) — expected refusal.
2. Sign + broadcast the replacement.
   - **Expected:** replacement → `completed`; the **original row flips
     `completed`→`superseded`**; only **one live replacement per original** is allowed
     (a second concurrent bump hits the partial UNIQUE index on `(owner, replaces_txid)`
     and is rejected).
- **PASS:** the replacement confirms, original shows `superseded`, second-bump attempt is
  refused.

### 18.4 CPFP (child-pays-for-parent) `[emulator]`
Precondition: a **stuck** tx that paid change back to the wallet (the wallet owns an
unconfirmed output on it).
1. Trigger CPFP on the stuck parent. `executeCpfpDraft` sweeps the wallet's own unconfirmed
   output(s) **on that parent txid** (coin-controlled, send-max) to a fresh change address;
   child fee = `ceil(target*(parentVsize+childVsize)) - parentFee`, floored to 1 sat/vB.
2. Verify typed error codes on the unhappy paths: `no_unconfirmed_output`,
   `already_confirmed`, `parent_fee_unknown`, `not_needed` (parent already meets target),
   `coin_too_small`.
- **PASS:** a legitimate CPFP builds+broadcasts a child spending only the parent's own
  unconfirmed output; each unhappy path returns its specific code, not a generic error.

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
- **PASS:** stranger-unconfirmed never auto-selected; own-change used only as confirmed
  fallback; immature coinbase blocked with a clear message.

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
     **passkeys don't work on the self-signed address** (sign in with email+password there).
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
1. In `/admin/settings` point Electrum at a dead/black-holing host and save (triggers
   `reconfigureChain()`).
   - **Expected:** after `UNHEALTHY_AFTER = 2` consecutive connect failures, the instance-
     wide `ChainHealthBanner` ("can't reach the Bitcoin network") appears; the initial dial
     is bounded by the connect-timeout (`armConnectTimeout`, cairn-vn48 — no infinite hang).
   - A flapping connection does **not** spam admins: the outage alert is 60s-debounced
     (`OUTAGE_GRACE_MS`) and latched.
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

### 20.7 Newly-created wallet watch lag `[emulator]` — expected-fail / verify current behavior
1. Create a wallet, fund it immediately (16.5), mine a block.
   - **Documented behavior:** watcher registration is **poll-based** — `refreshWatches()`
     runs every `REFRESH_INTERVAL_MS = 5 min`, NOT a creation hook (avoids an import cycle).
     So a deposit to a brand-new wallet may **not** notify until the next refresh (up to
     ~5 min). This is by design, not a bug (Part I §15 gotcha #9).
- **PASS (verify current behavior):** the deposit is eventually credited and
  `tx_received`/`tx_confirmed` fire within ~one refresh interval. Record the actual lag.
  Do not assert instant notification on a just-created wallet.

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
     seeded this boot; `/admin/settings` shows Connection mode = Custom with the probed
     host/port and an "auto-connected" indicator. Query the `settings` table (or the admin
     settings page) to confirm `chain_provisioned_by = 'umbrel-probe'`.
2. **Untouched when nothing is reachable — wizard still works.** Boot the same way but with
   neither `10.21.21.10:50001` nor `10.21.21.200:50002` reachable (nothing listening, or
   blocked).
   - **Expected:** boot succeeds normally (probe never throws); `connection_mode` stays
     unset and Cairn falls back to the public-server default
     (`electrum.blockstream.info:50002`). `/admin/settings` shows Connection mode = Public,
     no auto-connected indicator, `chain_provisioned_by` stays `null`.
   - Then manually walk `/admin/settings` → Custom connection → enter an Electrum host by
     hand and save.
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
     "Connect a node" link to `/admin/settings`; non-admin sees "ask your instance operator"
     copy, no link. `SyncBanner` is absent from the DOM (suppressed, since `deriveSyncStatus`
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
6. Send funds in (real sats on mainnet, or 16.5 on regtest).
   - ✅ A `tx_received` then `tx_confirmed` notification arrives with a **working deep link**
     to the wallet/tx (broken deep links were a prior P1 — verify the link navigates
     correctly). SPV-verified before it fires (no fake alerts).

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

### 21.6 Backup nudges (prominent backups)
8. Throughout, verify tiered backup nudges:
   - ✅ A never-backed-up wallet shows a persistent warm-tan "N wallets aren't backed up"
     banner that returns each session until resolved (dismiss is sessionStorage-scoped).
   - ✅ A stale (90-day) backup shows a softer periodic reminder whose dismissal **persists
     across browsers/devices** (server POST `/api/backup-reminder/dismiss`), not just locally.
   - ✅ An imported/created multisig surfaces its mandatory-backup UX (`source` gates it).
   - ✅ Nudges are proportionate to risk (never-backed = louder than stale), not one generic
     nag.

### 21.7 Global UX invariants (spot-check on any page)
   - ✅ Dark-only Heartwood theme renders consistently; `--text-faint` is never used for
     information-bearing copy (it deliberately fails AA — decorative/disabled only).
   - ✅ Routine validation + nudges are `--attention` (warm tan); `--error` red appears only
     for irrecoverable failures (broadcast rejected, invalid PSBT, node unreachable).
   - ✅ A `ChainHealthBanner` / `SyncBanner` appears only when actually relevant (silent
     when healthy / after first sync), and only one banner shows at a time — never both
     stacked for the same root cause (§20.15). A never-configured fresh install reads as a
     calm "not connected yet" setup step (neutral tone), not red error styling; red is
     reserved for a genuinely unreachable, previously-configured instance.
   - ✅ Toasts are transient action feedback; persistent/recoverable conditions use an inline
     `<Banner>` instead — the two are not confused.
- **PASS (journey):** every ✅ above holds through one uninterrupted new-user pass. Any raw
  internal leaked without explanation, any red used for a routine state, any broken
  notification deep link, any silent wizard failure, or a missing/weak backup nudge is a ❌.

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
- **README Esplora section is stale:** README still lists Esplora as an external dependency;
  a stock Umbrel deploy is Electrum-primary + Core RPC, `esplora === null`. Ignore the README
  on this point.
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
