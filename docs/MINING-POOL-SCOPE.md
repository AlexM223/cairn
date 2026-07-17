# Mining Pool Scope — Heartwood Solo Mining

**Date:** 2026-07-12
**Status:** SCOPED (research complete, not built)
**Author note:** Produced by the mining-pool research orchestration. Sources: Tessera codebase audit, NodeView audit, Cairn integration survey, web research (all 2026-07-12).

---

## DOCTRINE UPDATE — 2026-07-17: pivot to multi-user solo, as built

**This supersedes the single-user "Tessera-solo sidecar" plan below.** The
rest of this document is kept for history — it explains the reasoning that
led here and most of it (raffle-dead, non-custodial, peek-hold payout,
Stratum V1, forced-solve gate) still holds — but the **sidecar/second-
process architecture and the single-payout-address framing are no longer
what shipped.**

**What actually got built (epic `cairn-vn43`):**

- **In-process, not a sidecar.** The engine (`MiningPool` in
  `src/lib/server/mining/miningPool.ts`, wrapping a `TipPoller` +
  `StratumServer` + a serialized tip/solve event queue) runs **inside the
  same Heartwood Node process**, started/stopped from `hooks.server.ts`.
  There is no second container, no separate pool-runner process, and no
  HTTP stats-bridge protocol between two processes — `cairn-vn43.12`'s
  dev-mode child-process supervisor is obsolete. This resolves Open
  question areas around the engine/Heartwood process boundary in favor of
  the simpler shape; Umbrel packaging (`cairn-vn43.11`) follows suit —
  it just publishes the Stratum port on the existing web service/container,
  the same mechanism already used for the `4488:3443` HTTPS port, rather
  than adding a second container.
- **Multi-user solo, not single-payout-address.** Any authenticated user on
  the instance can enable mining and point a miner at the one shared
  Stratum listener under their own opaque per-user identity (`mining_id`,
  `hw_` + 8 hex, username `<miningId>.<workerName>`, password ignored). The
  engine resolves the connecting miner's identity at `mining.authorize`
  time (`authTable.ts`, a synchronous in-memory snapshot rebuilt off the
  hot path) and builds **that connection's own job** with a coinbase paying
  **that miner's own wallet** — not one instance-wide payout address.
- **Per-connection coinbase, not a shared job.** Where a traditional solo
  setup has one job template shared by every connected device, this engine
  personalizes the payout script per authenticated connection (still off
  one shared `getblocktemplate`/tip — the fee/transaction-set portion of
  the template is shared; only the coinbase payout output differs per
  miner). A found block still pays **the finding connection's own wallet
  in full** — no splitting, no aggregation, no pooled treasury at any point.
- **Identity contract**, replacing the sidecar plan's bearer-token engine
  API: `mining_prefs` (per-user `mining_id`/`enabled`/`payout_wallet_id`),
  `mining_workers`/`mining_stats` (durable low-rate aggregates, 15s-batched
  — never per-share, per the `cairn-xlrm` sync-SQLite hazard), `mining_blocks`
  (one row per submitted block, accepted or rejected). Full detail in
  `MANUAL.md` § "Mining engine" and § "Mining dashboard client".

**The hard legal gate (`cairn-vn43.14`) still stands, unchanged, and this
design was deliberately reviewed against it:** no reward-splitting, no
pooled/PPS/PPLNS payout, no custody of one user's coins by another or by
the operator. Each miner mines directly to their own wallet's own address;
the operator's instance only ever brokers *whose* address goes into *whose*
connection's job — it never touches, holds, or redirects value between
users. This is still solo mining, just with more than one solo miner
sharing one Stratum listener and one `getblocktemplate` poll loop; it is
explicitly **not** the raffle/PPS/PPLNS mode the gate exists to block, and
nothing about the multi-user pivot narrows or removes that gate.

Everything from here down is the original single-user-sidecar scoping
document, unchanged, kept for the historical reasoning trail.

---

## Executive summary

Heartwood gets a first-party **solo mining** feature: a "Mining" tab where a home user points a Bitaxe/small ASIC at their own node and, in the astronomically rare win, receives the full coinbase directly into their Heartwood wallet. Architecture = **"Tessera-solo sidecar"**: a solo-only mining engine extracted from Alex's existing Tessera codebase (`C:\dev\raffle`), running as its OWN process (second container on Umbrel, child process in dev), with Heartwood providing config, payout addresses, stats UI, and notifications. Solo-only, non-custodial, Stratum V1. The raffle layer is NOT ported.

---

## Key decisions + rationale

1. **Solo-only, never multi-user.** Multi-user PPS/PPLNS = reserve liability, custody of others' funds, money-transmission exposure; at home hashrate the shared block never comes anyway. Non-custodial: the coinbase pays the user's own address directly — no forwarding, no operator funds.

2. **Raffle layer dropped.** Operator-run prize draws for third parties = gambling (consideration + chance + prize; licensing; some US states ban online raffles). Also: at home scale it would never fire, and it's the largest source of coupling in the Tessera code. "Lottery ticket" survives ONLY as honest UI framing of solo odds. HARD GATE: any future multi-user or shared-reward mode requires legal review before any code.

3. **Engine = Tessera-derived, separate process.** Two independent syntheses converged on: (a) the engine must not run inside the wallet's Node process (raw LAN-facing TCP parser near session cookies/instance_secrets; sync `node:sqlite` event-loop hazard cairn-xlrm; crash containment — Tessera itself once shipped a vardiff-overflow process crash); (b) the engine should be Tessera's code, not bundled GPL public-pool/CKPool — Alex owns it (can relicense at will), it's TypeScript, its Stratum V1 transport was validated by a 33-hour real-Bitaxe soak on testnet4, and `umbrel/pool-runner.ts` + `Dockerfile.umbrel` already exist. Deployment: SAME Heartwood image, second container with a pool-runner entrypoint on Umbrel; child process in dev. Fallback (timeboxed): if Tessera-solo extraction stalls badly, bundling Public Pool (GPL-3.0, NestJS — proven mainnet blocks incl. 920440) as an unmodified sidecar container is the plan B; GPL is fine as mere aggregation.

4. **Forced-solve proof is a P1 gate.** The one code path that must be flawless is template→job→share→submitblock on the one occasion it matters. Tessera's regtest e2e already exercises accepted submitblocks; this must become a maintained CI harness (regtest forced-solve → block actually confirmed → chain-verified) gating mainnet enablement.

5. **Stratum V1 (+version-rolling/ASICBoost) only.** All deployed Bitaxe/AxeOS/Antminer firmware speaks V1; SV2 is niche in 2026 (2 native pools; AxeOS SV2 support only added June 2026 in ESP-Miner v2.14.0). SV2 = explicitly deferred.

6. **Payout design: peek-hold + advance-on-block.** The job's payout address comes from `peekReceiveAddress(walletId)` (does NOT advance the cursor), held stable across template rebuilds; `nextReceiveAddress()` advances the cursor ONLY when a block is actually found. Avoids both gap-limit pollution (thousands of burned addresses/day) and address reuse where it matters. Dedicated/labeled mining address; `MiningRewards.svelte` already renders coinbase UTXOs with the 100-conf maturity countdown. MVP pays own-Heartwood-wallet only; arbitrary external addresses = phase 2.

---

## Architecture overview

```
                 ┌──────────────────────────────┐
                 │   bitcoind (Umbrel bitcoin    │
                 │   app) — fully synced, non-   │
                 │   pruned, wallet-independent  │
                 │   getblocktemplate            │
                 └───────────────┬───────────────┘
                                 │ RPC (getblocktemplate, submitblock)
                                 ▼
                 ┌──────────────────────────────┐
                 │  ENGINE CONTAINER             │
                 │  TipPoller/GBT → job builder  │
                 │  → Stratum V1 TCP :3333       │──── LAN ──▶ Bitaxe / ASIC miners
                 │  submitblock on solve         │
                 │  small HTTP stats/control API │
                 └───────────────┬───────────────┘
                                 │ HTTP (bearer token from instance_secrets)
                                 ▼
                 ┌──────────────────────────────┐
                 │  HEARTWOOD WEB CONTAINER      │
                 │  stats bridge (poll+cache)    │
                 │  config push (payout addr,    │
                 │    port, vardiff)             │
                 │  SvelteKit /mining UI         │
                 │  notify() / activity feed     │
                 └──────────────────────────────┘
```

Umbrel `app_proxy` is HTTP-only, so port 3333 is published directly in `docker-compose` (same mechanism as the existing `4488:3443` HTTPS mapping). `umbrel-app.yml` should declare the bitcoin app dependency (it's `dependencies: []` today).

---

## Tessera reuse map

**Port ~verbatim:**
- `pool/src/stratum.ts` — 859-line hardened Stratum V1: subscribe/authorize/submit, unique extranonce1, race-free announce-time vardiff weighting, stale-job window, dedupe, bounded buffers, loopback-default bind, `maxConnections` 64.
- `pool/src/wire.ts` — consensus byte math; never reimplement.
- `TipPoller` from `pool/src/rpc.ts`.
- `pool/src/types.ts` (trim raffle types).
- `core/src` — `addressToOutputScript`/`validateAddressEncodable` (ECC-free address→script), `merkle.ts` if needed, `constants.ts` network params.

**Rewrite:**
- `pool/src/job.ts` → solo coinbase builder (keep BIP34 height push, extranonce placement, coinb1/coinb2 split offsets, witness-commitment output, `headerFor`/`assemble` closures; output = single payout, no RAFFLE/RAFFND OP_RETURNs, no per-connection variants).
- `pool/src/pool.ts` → thin solo coordinator (keep the serialized tip/solve promise queue; drop RaffleEngine/draw/finder/reorg-void + flat-file persistence; on solve: submitblock + notify).

**Stay out:**
- ALL raffle machinery (engine/draw/finder/tiers/window/ledger/commitment/verifier).
- `pool/src/api.ts` as-is (a new minimal stats/control API replaces it).
- The 38k-LOC gateway commerce layer.
- alerts/logger (Cairn's `notify()`/pino take over).

---

## Integration points with Heartwood (seams)

- **Nav:** `src/routes/(app)/+layout.svelte:29` — one-line tab, absent-when-flag-off convention; new routes `src/routes/(app)/mining/` modeled on `explorer/`.
- **Feature flag:** `mining` in `src/lib/server/featureFlags/registry.ts` (`defaultEnabled: true` is compiler-enforced) + `requireFeature()` in `src/lib/server/api.ts`.
- **Core RPC:** engine keeps its own minimal RPC client (Tessera `rpc.ts`) fed the same `core_rpc_*` settings; Heartwood's `CoreRpcClient` gains `getblocktemplate`/`submitblock` only if/when the engine moves closer (phase 2 consideration). `CoreRpcRequiredNotice.svelte` = empty state when Core isn't configured; `reconfigureChain()` in `src/lib/server/chain/index.ts` must push new config to the engine.
- **Payout:** `nextReceiveAddress()`/`peekReceiveAddress()` in `src/lib/server/wallets.ts` (withLock, cursor semantics as decided above); `MiningRewards.svelte` + `src/lib/shared/coinbase.ts` maturity.
- **Persistence:** Heartwood stores only low-rate aggregates (worker rollups, best_share, blocks_found, hashrate history) via batched writes; per-share state lives in the engine (in-memory + periodic flush), respecting the sync-SQLite hazard (cairn-xlrm). New tables appended `CREATE TABLE IF NOT EXISTS` style in `src/lib/server/db.ts`.
- **Notifications:** new event types (`block_found`, `mining_worker_offline`, best_share milestone) in `NOTIFICATION_EVENT_TYPES` (`src/lib/server/notifyTypes.ts`) + `notify()` (`src/lib/server/notifications.ts`); activity via `recordActivity()`.
- **Settings:** plain kv for port/bind/vardiff/enabled; `instance_secrets`/`setSecretSetting` for the engine API auth token; admin settings section following the per-section save/test pattern in `src/routes/(app)/admin/settings/+page.svelte`.
- **Process lifecycle:** `server.mjs` `shutdown()` seam + `hooks.server.ts` `init()`/`start*()` pattern for the dev child-process supervisor.
- **UI kit:** `CairnChart.svelte`, `Banner.svelte`, `Amount.svelte`, `CopyText.svelte`, `Term.svelte`, `FeatureDisabled.svelte`.
- **NodeView (`C:\dev\nodeview`) contributions:** `pools.json` coinbase matcher, hashrate-from-difficulty fixed-sample chart method, RPC concurrency gate + 503 backoff pattern, graceful-degrade ZMQ hashblock pattern (phase 2 template trigger).

---

## MVP user journey (~6 steps)

1. Enable flag + honest intro ("at ~1 TH/s expect a block roughly every 15,000–35,000 years — but 5+ home-hardware blocks exist; if you win, the full ~3.125 BTC + fees lands directly in your wallet; no custody, no fees").
2. Get config card (host, port 3333, username).
3. Point the Bitaxe.
4. Daily dopamine loop (best-share-ever high score, live/24h hashrate, worker health, measured-hashrate odds calculator).
5. The rare `block_found` celebration + `MiningRewards` maturity countdown.
6. Matured spendable balance.

---

## MVP feature list

| # | Size | Feature |
|---|------|---------|
| 1 | L | Extract Tessera-solo engine: port `stratum.ts`/`wire.ts`/`TipPoller`/`types` verbatim; rewrite `job.ts` as solo coinbase builder; rewrite `pool.ts` as thin coordinator; standalone runnable (pool-runner entrypoint). |
| 2 | M | Forced-solve regtest harness + CI gate: GBT→job→share→submitblock→block CONFIRMED→verified; adapt Tessera e2e; required before mainnet enablement. **[P1]** |
| 3 | M | Engine stats/control API: minimal HTTP (status, workers, shares/best-share, blocks; config push payout-address/port/vardiff; health) with bearer token from `instance_secrets`. |
| 4 | M | Heartwood stats bridge: server-side client + light cache; batched aggregate persistence (new tables: `mining_workers`, `mining_stats` rollups, `mining_blocks`). |
| 5 | S | Feature flag `mining` + nav entry + `requireFeature` + `/mining` route scaffold. |
| 6 | M | Payout wiring: dedicated labeled mining address; peek-hold + advance-on-block; config push to engine. |
| 7 | L | Mining dashboard UI: connection setup card, worker status, hashrate chart (CairnChart), best-share high score, honest odds calculator, empty states (flag off / Core missing / no workers). |
| 8 | S | Notifications: `block_found` + `worker_offline` (+ best-share milestone) event types, celebration UI, activity feed. |
| 9 | S | `MiningRewards.svelte` wiring for the mining address (coinbase maturity view — mostly exists). |
| 10 | M | Admin settings section: enable, bind (loopback default, LAN opt-in with explicit consent step), stratum port, target wallet, vardiff bounds, engine health/restart. |
| 11 | M | Umbrel packaging: second container from same image (pool-runner command), publish 3333 directly in compose, add bitcoin dependency to `umbrel-app.yml`, digest pin. |
| 12 | S | Dev-mode child-process supervisor for the engine (Windows-friendly). |
| 13 | S | Docs: MANUAL.md sections + help panel + release notes. |

---

## Phase 2+

- ZMQ hashblock template trigger (NodeView graceful-degrade pattern).
- External payout addresses (`validateAddressEncodable` on untrusted input).
- Multi-worker per-device stats.
- Knots-vs-Core template policy testing.
- Stratum TLS on separate port.
- Custom coinbase tag.
- Durable per-share persistence.
- SV2 when firmware adoption justifies.
- MinerSentinel-compatible read API.
- (Explicitly parked, legal-gated) any household/multi-party raffle concept.

---

## Technical requirements

- Fully-synced non-pruned Core node with wallet-independent `getblocktemplate` access + `rpcallowip` from the engine container.
- Raw TCP 3333 published on the LAN.
- Node 24 runtime in engine container.
- `bitcoinjs-lib` (already a Cairn dep).
- Engine memory footprint trivial at home scale.
- Time sync sane (ntime handling).

---

## Open questions

Each of these also becomes a bead.

1. **Raffle disposition confirmed dead for Heartwood?** Recommendation: yes — legal + dead-weight; Tessera continues separately.
2. **LAN bind default:** loopback-only default with explicit LAN opt-in consent step (recommended) — sign off?
3. **External payout addresses in MVP or phase 2?** Recommendation: phase 2.
4. **Mainnet posture:** ship mainnet-enabled with honest-odds UI from day 1, or testnet4-first soak? Needs Alex.
5. **Tessera licensing:** verified facts — `C:\dev\raffle\package.json` (package name `raffle-pool`, the actual pool code lives under `raffle/pool/` but there is no separate `pool/package.json`; the root manifest covers it) declares `"license": "GPL-3.0"`. Cairn's `C:\dev\cairn\LICENSE` is MIT. So one synthesis's "GPL-3.0 in pool/package.json" read is directionally correct (GPL-3.0 is the declared license, just recorded at the repo root rather than a nested `pool/package.json`), and the other synthesis's MIT assumption is wrong. Alex owns the Tessera code, so relicensing/vendoring it into Heartwood (or dual-licensing) is his call to make — needed action: Alex decides whether to relicense the extracted solo-engine code before it is vendored into the MIT-licensed Cairn/Heartwood repo, or keep it in a separate GPL-3.0 sidecar package/container to avoid mixing license terms in one image.
6. **Engine fallback trigger:** how long to timebox Tessera-solo extraction before falling back to bundling Public Pool?
7. **Naming/branding:** "Mining", "Solo Mining", or lottery-flavored framing?

---

## Estimated complexity

MVP ≈ 13 units above ≈ 3 L + 6 M + 4-5 S — on the order of the explorer epic (cairn-6efi) in scope; suitable for a multi-wave orchestrated build (engine extraction wave → integration wave → UI wave → packaging/QA wave). The forced-solve harness is the schedule long pole and should start first.

---

## Risks (top 5)

1. **Winning-path correctness** — a coinbase/split/witness-commitment bug voids the once-in-decades win. Mitigated by porting `wire.ts` untouched + forced-solve CI gate + real-Bitaxe testnet4 re-soak.
2. **Attack surface of a LAN-facing raw TCP parser.** Mitigated by process isolation, loopback default, ported hardening (bounded buffers, maxConnections, dedupe).
3. **Event-loop/SQLite contention** if per-share work leaks into the wallet process. Mitigated by aggregates-only bridge design.
4. **Honest-framing failure** (feature reads as income; or drift toward pooled/raffle mechanics). Mitigated by odds-forward UI + the legal hard gate.
5. **Two-process operational complexity** (config drift, engine down while UI up). Mitigated by same-image packaging, health surfacing in admin, config push on `reconfigureChain()`.
