# Perf Architecture Plan: kill navigation lag on Umbrel/ARM

Date: 2026-07-07
Status: SCOPED, not yet built (epic cairn-TBD — filled in once filed)

## The complaint

Alex reports persistent lag throughout Heartwood on Umbrel (ARM hardware, where
every network round-trip — Electrum, esplora HTTP — is meaningfully slower
than on a dev laptop). This has been patched per-page multiple times
(`cairn-ybsv` streamed the dashboard, several `+page.server.ts` files already
use the deferred-promise pattern) but the underlying architectural gap was
never closed: **some `load()` functions still `await` a full Electrum
round-trip before the response can start**, so navigation to those pages
blocks on the network instead of painting instantly.

This doc is the full audit + fix design, so the remaining fix lands in one
pass instead of the seventh per-page patch.

## What's already right (don't rebuild these)

The codebase already contains three separate instances of the correct
pattern. The fix below is "apply pattern X to page Y," not "invent pattern X":

1. **Streamed load (deferred promise).** SvelteKit leaves a top-level
   promise in a `load()` return value unresolved — the shell renders
   immediately and the promise streams in when it settles. Already used by:
   `(app)/+page.server.ts` (dashboard `chain` snapshot), `wallets/+page.server.ts`
   (`scans`), and every `/explorer/*` route (`chain`, `strip`, `mempool`,
   `difficulty`). The client side reads it with `$effect` + `data.chain.then(...)`
   and renders a skeleton until it resolves — see `(app)/+page.svelte:22-47`.

2. **Client-fetch-after-paint for scan-heavy data.** The dashboard doesn't
   even put wallet balances in `load()` — `(app)/+page.svelte:74-86` fetches
   `GET /api/portfolio` from `onMount`, explicitly to keep wallet rescans out
   of the SSR path and out of the block-invalidation path (see the doc comment
   on `src/routes/api/portfolio/+server.ts`). `GET /api/wallets/:id` and
   `GET /api/wallets/multisig/:id` already return the same scan/balance shape
   `load()` currently duplicates — see "Track 1" below.

3. **Live invalidation via the existing SSE channel.** `GET /api/events`
   pushes `event: block` over Server-Sent Events on every new tip
   (`src/routes/api/events/+server.ts`, wired from `chainEvents.ts`'s
   `electrum.on('header', ...)`). The client wrapper `src/lib/liveBlocks.ts`
   (`onNewBlock`) throttles it to one delivery per 3s. The dashboard's
   `onMount(() => onNewBlock((height) => { ...; void invalidate('cairn:chain'); }))`
   is the reference implementation of "refresh reactively, never poll."

4. **Per-wallet/per-multisig 60s scan cache already exists.** `walletScan.ts`'s
   `ScanCache` and the equivalent in `multisigScan.ts` cache a full gap-limit
   scan for 60s per xpub/multisig, seeded from SQLite at boot
   (`scanCachePersist.ts`) and pre-warmed 20s after startup
   (`portfolioWarm.ts`). **Balance caching is a solved problem — do not
   re-scope it.** The lag is in the *page load path*, not in redundant scans.

## What's actually broken

Full audit of all 47 server `load()` functions (see appendix). Four pages
never adopted the streaming pattern and each does 3-5 sequential/parallel
Electrum + esplora round-trips before the page can render *at all*:

| File | Blocks on | Severity |
|---|---|---|
| `wallets/[id]/+page.server.ts` | `getWalletDetail` (full scan) → `peekReceiveAddress` → `Promise.all([getWalletUtxos, getChain().getTip()])` → `detectWalletUnconfirmedInflows` | HIGH |
| `wallets/multisig/[id]/+page.server.ts` | `getMultisigDetail` (full scan) → `peekMultisigReceiveAddress` → `Promise.all([getMultisigUtxos, getChain().getTip()])` → `detectMultisigUnconfirmedInflows` | HIGH |
| `wallets/[id]/send/+page.server.ts` | `getWalletDetail` (full scan) → `getWalletUtxos` → `getChain().getFeeEstimates()` → `getChain().getTip()` | HIGH |
| `wallets/multisig/[id]/send/+page.server.ts` | `getChain().getFeeEstimates()` → `getMultisigUtxos` → `getChain().getTip()` | HIGH |

These four are exactly the highest-traffic pages: every wallet click, every
send flow. On ARM/Umbrel each hop is slow enough that the page "feels dead"
for a second or more — precisely Alex's complaint.

Two secondary, lower-severity gaps:

- `sync/+page.server.ts` awaits `getSyncStatus()` (TTL-cached internally, 10s
  tip / 120s peers) — acceptable for a dedicated status page, not in scope.
- `explorer/+page.server.ts` awaits `classifySearch(q)` only when `?q=` is
  present (an explicit search submission, not a passive nav) — not in scope.

Everything else (auth, settings, admin/*, activity) is pure local SQLite —
no chain I/O, already fine.

## Track 1 — Stream the four blocking loads (the core fix)

Apply the exact pattern already used by `(app)/+page.server.ts` and
`wallets/+page.server.ts`:

1. Split each `load()` into cheap/local fields (already separated as `base`
   in the wallet-detail files — no change needed there) and the
   Electrum-dependent fields.
2. Return the Electrum-dependent work as an **unawaited async function call**
   (a Promise), not `await`ed. SvelteKit streams it in once it resolves; the
   page shell (name, labels, saved transactions, backup status, descriptor)
   paints immediately from the cheap fields.
3. Add `depends('cairn:wallet:{id}')` / `depends('cairn:multisig:{id}')` /
   `depends('cairn:send:{id}')` tags (mirroring `depends('cairn:chain')` on
   the dashboard).
4. On the client, mirror `(app)/+page.svelte`'s `$state` + `$effect` +
   `data.<field>.then(...)` skeleton pattern, and call
   `onMount(() => onNewBlock((h) => { ...; void invalidate('cairn:wallet:{id}'); }))`
   so a new block refreshes the page's chain-derived fields (tip, coinbase
   maturity, speed-up eligibility) without a manual reload — never poll.
5. Keep the existing `try/catch` "scan unreachable → degrade to zero/empty,
   never 500" behavior — it already exists in all four files and composes
   fine with streaming (a rejected streamed promise is just caught the same
   way, inside the async function).

No new Electrum call sites, no new caching logic in this track — it's a
mechanical migration to an established pattern. The four files are otherwise
independent (no shared file touched), so **four agents can do this fully in
parallel with zero merge risk** — each owns one `+page.server.ts` + its
paired `+page.svelte`.

Complexity: **M each** (mechanical but must preserve every existing
degrade-gracefully branch; each page's Svelte template needs a skeleton
state added for the streamed fields it didn't have before).

## Track 2 — Short-TTL cache for tip + fee estimates

Unlike wallet/multisig balances, `ChainService.getTip()` and
`getFeeEstimates()` currently have **no cache at all** — every call is a
fresh esplora HTTP round-trip (see `chain/index.ts:238-244` and `:475-477`).
Once Track 1 lands, a single wallet-detail nav still fires `getTip()` at
least once, and the send page fires both `getTip()` and
`getFeeEstimates()`; with multiple tabs/pages open concurrently (dashboard +
wallet + send), these are fully redundant calls to the same slow ARM-side
HTTP round-trip.

Design: a new tiny module `src/lib/server/chain/cache.ts` (or a few fields
added directly to `ChainService`) with:

- `tipCache`: TTL **10 minutes** as a safety ceiling, but actively
  invalidated the instant a new block arrives — hook `invalidateTipCache()`
  into `wireChainEvents`'s existing `electrum.on('header', ...)` handler
  (`chainEvents.ts:110-122`), right where `lastBlockHeight` is updated. In
  practice the cache is never actually 10 minutes stale; the TTL only
  matters if the header-event pipeline itself stalls. This mirrors the
  reasoning already written for `TIP_TTL_MS` in `syncStatus.ts`.
- `feeCache`: TTL **30 seconds**, no event-based invalidation needed (fee
  estimates drift continuously; a flat TTL is the honest model — same
  reasoning as `PEERS_TTL_MS` in `syncStatus.ts`).
- Both caches reset in `reconfigureChain()` alongside the existing
  `resetChainHealth()` / `resetPackageRelaySupport()` calls, so a server
  switch never serves a stale value from the old backend.
- Wrap the two methods on `ChainService` in-place; every existing call site
  (dashboard, explorer, the four Track-1 pages, `/api/mempool/fees`) benefits
  with no call-site changes.

Mempool summary/histogram (used only by already-streamed
dashboard/explorer pages) are lower priority — optional follow-on with the
same shape (~15s TTL) if profiling after Track 1+2 still shows contention.

Complexity: **S** — one new module, ~10 lines added to `chainEvents.ts` and
`reconfigureChain()`, no behavior change to callers.

## Track 3 — Background refresh (folded into Track 1, not separate work)

The request framed this as its own track, but the audit shows it's the same
mechanism as Track 1's step 4: SvelteKit's `invalidate()` + the existing SSE
`onNewBlock` channel *is* the background-refresh system Cairn already has.
There's no separate store/polling layer to design — building one would
duplicate `liveBlocks.ts` + `(app)/+page.svelte`'s `$effect` pattern. Track 1
already prescribes wiring every migrated page into it. No separate bead
needed; call this out explicitly so nobody scopes a redundant polling layer.

## Track 4 — PSBT resume audit (result: not the bottleneck)

Read both send pages' `?tx=N` resume branch in full
(`wallets/[id]/send/+page.server.ts:100-115`,
`wallets/multisig/[id]/send/+page.server.ts:87-124`). The resume path itself
does only: one SQLite read (`getTransaction`/`getMultisigTransaction`), pure
in-process PSBT parsing (`summarizePsbt`), and for multisig, roster
reconciliation (`getRoster`) — all synchronous/local, no Electrum calls.

**Resume was never slow on its own merits.** The perceived slowness comes
entirely from the fact that resume rides on the *same* blocking `load()` as
every other visit to the send page — `getWalletDetail`/`getMultisigUtxos` +
`getFeeEstimates` + `getTip()` block before the resume data (which is
instant) even gets a chance to render. **Track 1 fixes this for free** —
once the send pages stream their Electrum-dependent fields, the resume
summary/progress/roster can be returned synchronously alongside the cheap
base fields (they're cheap enough to stay unstreamed), and the page paints
the resumed step immediately while fees/UTXOs/tip stream in behind it.

No separate resume-specific work is needed. Flag this so no one builds a
redundant "speed up resume" fix later without re-reading this section.

## Epic + beads

File as one epic with the sub-beads below (`epic cairn-<id>`, tag
`perf-2026-07-07`):

1. **Stream `wallets/[id]` detail load** — Track 1 for the single-sig wallet
   page + its `.svelte`. Complexity M.
2. **Stream `wallets/multisig/[id]` detail load** — Track 1 for the
   multisig wallet page + its `.svelte`. Complexity M.
3. **Stream `wallets/[id]/send` load** — Track 1 for the single-sig send
   page + its `.svelte`; verify resume (Track 4) renders instantly once
   streaming lands. Complexity M.
4. **Stream `wallets/multisig/[id]/send` load** — Track 1 for the multisig
   send page + its `.svelte`; same resume verification. Complexity M.
5. **Add tip + fee-estimate TTL cache to ChainService** — Track 2:
   `tipCache` (10min ceiling, invalidated on `header` event),
   `feeCache` (30s TTL), reset on `reconfigureChain()`. Complexity S.
6. **Verify + demo on Umbrel/ARM hardware** — manual QA pass (nav feels
   instant across all four migrated pages, no skeleton flash/jank on
   revisit, SSE-triggered refresh works, degrade-gracefully paths still
   work with Electrum killed mid-scan). Depends on 1-5. Complexity S.

Beads 1-5 touch entirely disjoint files (four independent route pairs + one
new chain-cache module) — **safe to build fully in parallel across 5 Opus
worktree agents**, no ordering constraints between them. Bead 6 depends on
all five and must run last.

## Appendix: full load-function audit

See the exploration notes for the complete file-by-file classification of
all 47 `+page.server.ts`/`+layout.server.ts` load functions. Summary: 4 HIGH
(this doc's Track 1), 2 lower-priority MEDIUM (`sync`, `explorer` search —
out of scope), 8 already correctly streamed (dashboard, wallet list, all of
`/explorer`, admin node info), remainder pure-local with no chain I/O.
