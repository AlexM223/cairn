# Sync Engine Phase 1 — Dirty-Tracking Design (cairn-wcxw)

Status: DESIGN (not yet implemented)
Parent epic: cairn-6xxa (Perf re-architecture)
Author: Fable deep-reasoner audit, 2026-07-13
Related beads: cairn-qyvl, cairn-xlrm (closed), cairn-y802, cairn-8ubd (sequence-before), cairn-1q4b (Phase 2)

---

## 0. TL;DR

Today every wallet refresh does a **full gap-limit Electrum scan** (up to 400
addrs/chain) on a 20 s throttle, whether or not anything changed on-chain — and
the app already holds a **live Electrum scripthash subscription for every watched
address** whose status-change signal it throws away. Phase 1 closes that gap:
persist the last-seen Electrum status per scripthash, mark a wallet **dirty** only
when a status actually changes (new tx, confirmation, reorg, RBF, reconnect
delta) or on a user action / TTL fallback, and **skip the scan entirely when a
wallet is clean**. It also fixes a live notification-correctness bug found in the
same code (`WATCH_WINDOW` blind spot, §2.2) that would otherwise poke a hole in
the dirty signal.

Phase 1 is **~150–250 LOC**, additive schema only. It explicitly does **not**
make SQLite async or move work off the event loop — the qyvl/xlrm concurrency
cliff has a different root cause (§4) and is Phase 2.

---

## 1. Current-state map

### 1.1 Who triggers a sync

Every sync funnels through three exported entry points in
`src/lib/server/walletSync.ts`:
`refreshWalletSnapshot` (:483), `refreshMultisigSnapshot` (:563), and the
coalesced `refreshPortfolio` (:803). They are invoked from:

| Trigger | Path | Entry point |
|---|---|---|
| Wallet detail page mount | `routes/(app)/wallets/[id]/+page.svelte:88` → `POST /api/wallets/[id]/refresh` (`+server.ts:28`) | `refreshWalletSnapshot` |
| Wallet detail new-block SSE | `wallets/[id]/+page.svelte:96` (`onNewBlock`) → same route | `refreshWalletSnapshot` |
| Multisig detail mount / new-block | `wallets/multisig/[id]/+page.svelte`; `.../refresh/+server.ts:25` | `refreshMultisigSnapshot` |
| Wallets list + Dashboard | `routes/(app)/+page.svelte:120` → `POST /api/portfolio/refresh` (`+server.ts:28`) | `refreshPortfolio` |
| Startup warm (every user) | `hooks.server.ts:270` `startPortfolioWarm` → `portfolioWarm.ts:161` → `warmAllSnapshots` (`walletSync.ts:855`) | `refreshPortfolio` per user |
| Reconciled inbound disappearance | `addressWatcher.ts:871` `forceSnapshotRefresh` (`{force:true}`) | `refreshWalletSnapshot`/`Multisig` |

New blocks are surfaced to the browser over SSE (`chainEvents.ts:111` emits
`new_block`; `routes/api/events`), and the **client** re-fires the refresh route —
there is no server-side per-wallet re-scan on a new block. So the load pattern is
"N logged-in tabs each POST a refresh on every block," coalesced only by the
per-wallet single-flight + 20 s throttle.

### 1.2 What a sync pass fetches and writes

`doWalletScan` (`walletSync.ts:412`) per refresh:

1. `scanWallet` → `runGapScan` (`gapLimitScanner.ts:310`): receive **and** change
   chains scanned in parallel. Each chain (`scanChainAddresses` :60) derives in
   batches of `BATCH_SIZE=20`, issues a batched `get_history` + `get_balance` per
   scripthash (:76–85), and walks until `GAP_LIMIT=20` consecutive unused
   addresses or `HARD_CAP=400` (:69). For an active wallet that is dozens of
   Electrum calls **every 20 s even when nothing changed**.
2. `collectScanTxs` (`gapLimitScanner.ts:217`) fetches up to `TX_DETAIL_CAP=50`
   tx details (`getTx`, or `getTxHex` + raw-parse fallback `txDeltaFromRaw` :145).
   The raw-parse path decodes each tx **and its parents** — synchronous CPU on the
   event-loop thread between awaits.
3. `peekReceiveAddress` + QR encode, one `getWalletUtxos`, one `getTip`,
   `detectUnconfirmedInflows`.
4. `writeSnapshot` (:221) — one synchronous SQLite `upsert` of the whole snapshot
   JSON + summary blob into `wallet_snapshots` (`db.ts:480`).

`doMultisigScan` (:504) is the same shape via `getMultisigDetail`.

**None of this checks whether anything changed.** `singleFlightThrottled`
(:313) only guards against *duplicate concurrent* scans and re-scans younger than
`THROTTLE_MS=20_000`; past 20 s it unconditionally does the full scan again.

### 1.3 Where the event loop blocks

`db` is `node:sqlite`'s **synchronous** `DatabaseSync` (`db.ts:1`, `:21`). Every
`db.prepare().get()/.all()/.run()` blocks Node's single thread for its duration.
The awaited Electrum I/O does **not** block the loop (verified and recorded when
cairn-xlrm closed) — but two synchronous things do:

- **SQLite calls**: `writeSnapshot` (`walletSync.ts:229`), and on the read side
  `readCachedSummary` looped once per wallet in `listCachedPortfolio` (:605–630),
  plus the per-navigation gate queries in `+layout.server.ts` (the biggest lever,
  already partly addressed under xlrm).
- **Synchronous scan CPU**: address derivation (~60 EC ops/wallet, called out in
  `addressWatcher.ts:227` `enumerateAll`) and the `txDeltaFromRaw` raw-tx parsing
  run as uninterrupted JS between awaits.

### 1.4 How the qyvl collapse emerges

Under the mixed 40/20/40 load scenario at 200 concurrent requests, cairn-qyvl
measured **88.4 % errors** (baseline 0.3 %) and p50 1.5–2.0 s (vs 1–4 ms
sequential). The mechanism: node:sqlite serializes every read *and* write on the
one event-loop thread, so the 20 % unbounded `POST /api/wallets` writes
(`createWallet`, `wallets.ts:288`, cairn-y802) interleave with 80 % reads and the
whole thing collapses bimodally (instant failures + 10 s timeouts). Event-loop
lag tracks p99 in *every* scenario, including read-only — confirming sync SQLite
as the shared root cause.

**How dirty-tracking helps, and how it doesn't.** Phase 1 attacks the *volume of
scan work*, not the *serialization*. Removing full scans for clean wallets
eliminates, per skipped refresh: dozens of Electrum round-trips, the synchronous
raw-tx CPU, the `JSON.stringify` of the whole snapshot, and the synchronous
`writeSnapshot` upsert. That is a large multiplier on the **background** passes
(`warmAllSnapshots` runs `refreshPortfolio` for *every* user at boot; the periodic
portfolio refresh re-scans everything most-stale-first) and on steady-state
new-block refresh storms. It does **not** make any single remaining SQLite call
async, so the fundamental concurrency cliff (especially the write-heavy
`POST /api/wallets` path) **persists after Phase 1** — that is Phase 2 (§3).

### 1.5 The two bugs Phase 1 must fix (from the cairn-wcxw audit)

**(a) The status-hash is discarded (the whole point of Phase 1).**
The watcher subscribes every watched address's scripthash
(`addressWatcher.ts:1184`, `refreshWatches`), and the subscription infra
faithfully carries the status hash: `subscribeScripthash` *returns* the current
status (`electrum/client.ts:626–632`), and the `'scripthash'` event is emitted
with `(sh, status)` both on live change (`client.ts:501`) and on reconnect replay
(`client.ts:439`), which the pool forwards verbatim (`pool.ts:95`). The
`WatchState.onScripthash` type even declares the second arg
(`addressWatcher.ts:87`: `(sh, status: string | null) => void`). **But the
installed handler ignores it** — `state.onScripthash = (sh: string) => {...}`
(`addressWatcher.ts:1283`) takes only `sh`, and `subscribeScripthash`'s return
value at :1184 is awaited-and-dropped. So the subscription infra and the
balance/scan path are completely disjoint: the app is *told* exactly which
address changed and re-scans everything on a blind 20 s timer anyway.

> Discrepancy note: the bead cites `addressWatcher.ts:1021`; the file has since
> grown and the handler is now at :1283. The finding is unchanged — trust the
> code line.

**(b) `WATCH_WINDOW=30` is a fixed window, not gap-trimmed.**
`addressWatcher.ts:45` watches indices `0..29` on each chain
(`walletAddresses` :182, `multisigAddresses` :205), from index 0, fixed. The
*scanner* discovers up to 400 addresses and gap-trims to `lastUsed + GAP_LIMIT`
(`gapLimitScanner.ts:107–109`). A wallet with **>30 used addresses on one chain**
has live addresses beyond index 30 that are **never subscribed** — deposits there
fire no scripthash event today (a live notification miss) and, once dirty-tracking
keys off scripthash events, would **never mark the wallet dirty** (a false-clean
stale-balance bug). Fixing the window is therefore a **prerequisite**, not a
bonus: the dirty signal is only sound if the watch set covers the scanned set.

---

## 2. Phase 1 scope — dirty-tracking

### 2.1 Data model

Two additive pieces, both guarded like the existing `summary`-column migration
(`db.ts:497–504`):

**(1) `scripthash_status` — the last-seen status baseline (persisted).**

```sql
CREATE TABLE IF NOT EXISTS scripthash_status (
  scripthash  TEXT PRIMARY KEY,
  wallet_kind TEXT NOT NULL,     -- 'wallet' | 'multisig'
  wallet_id   INTEGER NOT NULL,
  status      TEXT,              -- Electrum status hash; NULL = never used
  updated_at  INTEGER NOT NULL   -- ms epoch
);
CREATE INDEX IF NOT EXISTS idx_scripthash_status_wallet
  ON scripthash_status(wallet_kind, wallet_id);
```

Persisting the baseline (rather than an in-memory Map) is what makes **reconnect
and restart reconciliation correct and cheap**: after a reboot or a client swap we
compare each freshly returned status against the stored one and only mark wallets
whose status actually moved while we were away. Swept by the existing
`trg_*_delete_children` delete triggers (same keying as `wallet_snapshots` and
`notified_txids`).

**(2) `wallet_snapshots.dirty_since` — the dirty flag (persisted).**

```sql
ALTER TABLE wallet_snapshots ADD COLUMN dirty_since INTEGER;  -- NULL = clean
```

`NULL` = clean; a ms-epoch timestamp = "marked dirty at T, needs a scan." A
timestamp (not a bool) lets the refresh path apply a short coalescing throttle
against the *mark* time and lets us observe staleness. Chosen over recomputing
"is any scripthash status != baseline" at read time because the refresh gate then
needs exactly **one** extra column on a row it already reads (`readSnapshot`
already selects from this table), keeping the hot path a single indexed read.

Dirtiness is **per-wallet**, not per-address: a scan re-scans the whole wallet, so
address-level granularity buys nothing in Phase 1.

### 2.2 Invalidation triggers (what marks a wallet dirty)

1. **Live status change** — in the watcher's scripthash handler, when the incoming
   `status` differs from the stored `scripthash_status.status`, write the new
   status and set `dirty_since` on the owning wallet. Electrum's status hash is a
   hash over the address history *including confirmation heights*, so this fires on
   **new tx, confirmation, reorg, and RBF replacement** alike — satisfying the
   bead's acceptance criteria (dirty on confirmations, not just new txs).
2. **Reconnect / client-swap reconciliation** — `refreshWatches` already
   re-subscribes on every (re)connect (`addressWatcher.ts:1184`). Use
   `subscribeScripthash`'s **return value** (currently discarded) as a free
   checkpoint: status != stored ⇒ mark dirty. This is the outage/reorg-during-
   downtime path and the required "reconnect-after-outage marks dirty" criterion.
3. **User actions** —
   - Wallet/multisig created ⇒ no snapshot row ⇒ treated dirty by *absence*
     (existing "never synced" path already forces a scan).
   - Send broadcast ⇒ mark the sending wallet dirty so the client's post-broadcast
     refresh actually scans instead of being skipped as clean. (Broadcast paths in
     `transactions.ts` / `multisigTransactions.ts`; the reconcile path already
     force-refreshes at `addressWatcher.ts:871`.)
   - Receive cursor advanced past the current watch window ⇒ mark dirty + widen the
     watch set (ties into §2.4).
4. **TTL fallback (`MAX_CLEAN_TTL`)** — a wallet that has stayed clean longer than
   `MAX_CLEAN_TTL` (proposal: 30 min, tunable) is treated as dirty for one scan.
   This is the self-healing safety net for any missed signal (dropped event,
   residual window blind spot) and bounds the worst-case stale window. It replaces
   "never re-scan a clean wallet" with "re-scan a clean wallet rarely."

### 2.3 The refresh gate (what reads dirty)

`singleFlightThrottled` (`walletSync.ts:313`) gains the clean-skip. New decision
order in `refreshWalletSnapshot` / `refreshMultisigSnapshot`:

- **No snapshot** ⇒ scan (unchanged: first-sync).
- **Snapshot exists, clean (`dirty_since IS NULL`), and `now - last_synced_at <
  MAX_CLEAN_TTL`** ⇒ return cached, **no scan** (the new lever).
- **Dirty, or older than `MAX_CLEAN_TTL`** ⇒ scan (single-flighted + a short
  coalescing throttle so a burst of tabs coalesces), and **on successful persist
  clear `dirty_since`** back to NULL. Clearing only on success preserves the
  existing "a failed scan never overwrites the last good snapshot" contract
  (`walletSync.ts:21–24`): a failed scan leaves the wallet dirty, so it retries.

`runPortfolioRefreshPass` (`walletSync.ts:682`) gains a `dirty` field on
`PortfolioRefreshItem` and **skips clean items** (counted as `skipped`, never
scanned). This is the biggest single win for `warmAllSnapshots` and the periodic
portfolio pass, which today re-scan every wallet of every user regardless.

The 20 s `THROTTLE_MS` stays as the burst-coalescing floor for *dirty* scans;
`MAX_CLEAN_TTL` (minutes) is the new *clean* ceiling. Two windows, orthogonal
jobs.

### 2.4 Fixing the WATCH_WINDOW blind spot (prerequisite)

The watch set must cover the scanned set or the dirty signal has holes. Chosen
approach: **derive the per-chain watch depth from the persisted snapshot's highest
used index + `GAP_LIMIT`**, with a floor of the current `WATCH_WINDOW` (30) for
never-scanned wallets. The snapshot already stores addresses with their indices
(`WalletSnapshot.scan.addresses`), so the watcher can learn "watch receive to
index 47, change to index 12" directly from the last scan — making watcher
coverage a strict function of scan coverage, which is exactly the invariant
dirty-tracking depends on. (Interim simpler alternative in §5 Q3.)

### 2.5 Interaction with existing machinery

- **Warm portfolio cache** (`listCachedPortfolio` :592, `buildPortfolioAggregate`
  :746): unchanged. They read snapshots synchronously and never scan — dirty
  tracking only changes *when a scan runs*, not what the cached read returns.
- **Watcher** (`addressWatcher.ts`): we *extend* the existing scripthash handler
  to also persist status + mark dirty. The **notification path stays
  independent** — a status change marks dirty even when it produces no
  notification (e.g. a pure confirmation or an outbound change), and the SPV /
  baseline gates (`:647` onward) are untouched.
- **Send/spend path**: untouched. `getWalletUtxos`/`getMultisigUtxos` stay live
  (`walletSync.ts:24` — the send flow never reads snapshots and must keep scanning
  live for fresh UTXOs). Do **not** route spending through dirty-tracking.

---

## 3. What Phase 1 explicitly does NOT do

| Deferred | Why not now | Phase 2 bead |
|---|---|---|
| Worker-thread offload of DB/scan work | The qyvl/xlrm root cause is sync SQLite on the event loop; measure first, and only after dirty-tracking + derivation memoization land | cairn-1q4b |
| Async SQLite driver swap (DatabaseSync → async) | The real fix for the concurrency cliff; large blast radius across every `db.*` call site; out of a 150–250 LOC scope | (open under cairn-6xxa) |
| Normalized `wallet_addresses` / `wallet_txs` / `wallet_utxos` | The bead explicitly rejected this for Phase 1: ~2000–2500 LOC, hard tx-eviction/refcounting risk under reorg/RBF, scan-storm-on-backfill migration. Gate as its own bead, opened only if Phase 1 proves insufficient | (new, TBD) |
| Memoized address derivation | Separate concern; **sequence before** this work (both touch `addressWatcher.ts`) | cairn-8ubd |

Phase 1 narrows scan *frequency*. The concurrency collapse under a write-mixed
200-concurrent load (cairn-qyvl, cairn-y802) is a *serialization* problem that
Phase 1 does not claim to solve.

---

## 4. Migration / rollout plan

Each step is independently shippable and testable. Steps 0–2 are behavior-neutral
(schema + observation only); the actual behavior change is gated in step 3.

**Step 0 — Fix `WATCH_WINDOW` (notification-correctness).**
Snapshot-derived (or raised, per §5 Q3) watch depth. Ships alone as a live bug
fix even if the rest slips.
*Test:* unit — a wallet with 35 used receive addresses subscribes index 34's
scripthash (extend `addressWatcher` tests; `_internals.state` at :1346 exposes
`byScripthash`).

**Step 1 — Schema.**
Add `scripthash_status` table + `wallet_snapshots.dirty_since` column, both
PRAGMA-guarded/additive (`db.ts:497` pattern). No reader/writer yet.
*Test:* migration test in the notified_txids-rebuild style (recent commit
2746b7d, cairn-ug2g) — fresh DB and pre-existing DB both end with the column.

**Step 2 — Watcher writes status + marks dirty (observe-only).**
Wire the discarded status through: capture `subscribeScripthash`'s return in
`refreshWatches`; change the `onScripthash` closure to accept and use `status`;
persist to `scripthash_status`; set `dirty_since` on change. **Nobody reads
`dirty_since` yet**, so this is zero-risk and independently verifiable.
*Test:* unit — a differing status marks dirty and updates the baseline; an
identical status does not; a reconnect with a changed status marks dirty (drive
via the emitter, assert rows).

**Step 3 — Refresh path reads dirty (the behavior change), behind a flag.**
Clean-skip in `singleFlightThrottled` / the two refresh entry points; clear
`dirty_since` on successful persist; skip clean items in
`runPortfolioRefreshPass`. Gate behind a feature flag in
`src/lib/server/featureFlags/registry.ts` (cairn-43sq) so a false-clean
regression has an instant kill-switch.
*Test:* unit on the already-exported seams — `singleFlightThrottled` (:313),
`createLimiter` (:360), `runPortfolioRefreshPass` (:682) — for clean-skip,
dirty-scan-then-clear, and failed-scan-stays-dirty.

**Step 4 — Measurement (before/after evidence).**
Run the existing load harness (`scripts/load-test/`,
`docs/TEST-REPORT-2026-07-12-loadtest.md`) with the flag off vs on. Capture:
(a) Electrum round-trips per steady-state refresh cycle for a clean wallet
(expect ~0 vs dozens); (b) `warmAllSnapshots` wall-time and event-loop lag at
boot; (c) event-loop-lag p99 on the read-heavy portions of the mixed 40/20/40
scenario. **Report honestly** that the `POST /api/wallets` write path is
unchanged (that regression belongs to y802 / Phase 2), so the 200-concurrent
write-mixed cliff should improve only insofar as background scan pressure drops,
not disappear.

---

## 5. Risks and open questions for Alex

1. **False-clean → stale balance (medium; the bead's headline risk).** A missed
   status signal shows a stale balance until `MAX_CLEAN_TTL` or the next real
   event. Mitigated by the window fix (§2.4), the reconnect reconciliation (§2.2.2)
   and the TTL fallback. **Q: what `MAX_CLEAN_TTL`?** 30 min is my proposal —
   shorter is safer but claws back less benefit; longer is a bigger win but a
   longer worst-case stale window.

2. **Cold-start baseline.** First boot after deploy has an empty
   `scripthash_status`, so the first reconnect reconciliation sees every stored
   status as `NULL` and marks everyone dirty ⇒ one full warm scan for all wallets.
   This *matches today's* `warmAllSnapshots` behavior (it already scans everyone at
   boot), so it is not a regression — **confirming that's acceptable.**

3. **Window-fix approach.** §2.4 proposes snapshot-derived watch depth (correct,
   but couples the watcher to snapshot freshness; a never-scanned wallet falls back
   to the floor of 30). **Q: is a simpler raised fixed cap (e.g. 60 or 100)
   acceptable as an interim**, accepting that a pathological >cap-address wallet
   still relies on `MAX_CLEAN_TTL` to catch far-out deposits?

4. **Flag or no flag for the clean-skip.** I recommend **yes** (step 3) for safe
   rollout and an instant kill-switch given the medium false-clean risk. Confirm
   you want the extra flag rather than shipping it unconditionally.

5. **Sequencing (hard constraint from the bead).** Do **not** run concurrently
   with cairn-8ubd (derivation memoization) — both touch `addressWatcher.ts`;
   single-session only (the concurrent-session branch hazard is a repeat offender
   here). **Q: confirm cairn-8ubd is landed/parked before this starts.**

6. **Multisig parity.** Multisig addresses are subscribed through the same
   scripthash mechanism (`multisigAddresses` :195), so the design applies
   uniformly; no separate wrinkle identified, but worth a confirming test.
