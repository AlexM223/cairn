# Load Test Report — 2026-07-12/13 (Track E)

**Harness:** `scripts/load-test/` (offline, repeatable, seeded-data throughput/latency
measurement; built by the 2026-07-12 test wave, `test-wave-2026-07-12`).
**Invocation:** `node scripts/load-test/run.mjs --scenario all --no-build`
**Git SHA at run time:** `44fdf42` (branch `single-sig-full-wallet`) — `--no-build` reused the
production build already sitting in `build/handler.js` (built 21:57 same day) rather than
triggering a fresh `npm run build`, to avoid colliding with other concurrent work on this shared
checkout.
**Run started:** 2026-07-13T03:13:47.104Z · **Node:** v24.14.1 · **CPUs:** 16
**Config:** all 4 scenarios (`a` steady-browsing, `b` rapid-fire, `c` mixed-40-20-40, `d`
write-pressure) × tiers 10/50/100/200, 15s measured window + 5s warmup per tier (harness
defaults, untouched). Seed: 200 users / 453 wallets / 1 hot wallet with 1,100 addresses / 130
txs. Server pointed at a dead Electrum port (`59999`) so every chain call fails fast — this is a
pure app/DB-layer measurement, no network variance.
**Raw artifacts:** `scripts/load-test/results/run-2026-07-13T03-13-47-104Z-{a,b,c,d}.json`
(gitignored, left in place per instructions).

## Important caveat: this run was not isolated

Unlike the 2026-07-05 baseline (`docs/LOAD-TEST-RESULTS-2026-07-05.md`, run against a dedicated
`vite dev` instance with no other load on the box) and unlike the same-day 2026-07-12 baseline
captured in `docs/TEST-FINDINGS-2026-07-12.md`, this run shared the machine with other active
work. Evidence:

- `git rev-parse HEAD` immediately after the run returned `64c2ed4` — a different commit than the
  `44fdf42` this run's own `meta.gitSha` recorded at start. Something else committed to this
  branch *while the load test was running* (the `concurrent-session-branch-hazard` pattern noted
  in project memory).
- A `tasklist` check right after the run showed **36 `node.exe` processes**, several in the
  500-700 MB range — far more than this harness's own server+driver processes account for. Other
  Claude Code sessions/dev servers were active on the same box throughout the run.

**Consequence:** the absolute throughput/latency numbers below are almost certainly worse than
what this build could do in isolation — CPU contention from sibling processes inflates every
number, especially latency. Treat magnitude comparisons against the isolated 2026-07-05 baseline
with real skepticism. The *shape* of the results (which scenario/tier breaks first, relative
ordering of reads vs. writes vs. mixed, error patterns) is still meaningful signal and is
consistent across every prior run of this harness, so the qualitative conclusions below stand.

## Headline numbers

`scenario | tier | reqs | rps | p50 | p95 | p99 | max | errRate | non2xx | lagP99` (times in ms):

| scenario | tier | reqs | rps | p50 | p95 | p99 | max | err% | non2xx% | lagP99 |
|---|---|---|---|---|---|---|---|---|---|---|
| steady-browsing | 10 | 1,110 | 74.0 | 101.6 | 432.7 | 599.5 | 1,206.0 | 0.0% | 0.0% | 596.6 |
| steady-browsing | 50 | 1,995 | 133.0 | 459.1 | 789.1 | 895.9 | 949.7 | 0.0% | 0.0% | 790.1 |
| steady-browsing | 100 | 3,430 | 228.7 | 537.4 | 938.7 | 1,020.6 | 1,124.4 | 0.0% | 0.0% | 999.8 |
| steady-browsing | 200 | 3,990 | 266.0 | 963.0 | 1,337.6 | 1,419.5 | 1,813.1 | 0.0% | 0.0% | 837.8 |
| rapid-fire | 10 | 460 | 30.7 | 334.1 | 482.5 | 531.4 | 599.2 | 0.0% | 0.0% | 609.8 |
| rapid-fire | 50 | 1,108 | 73.9 | 719.5 | 1,111.2 | 1,218.8 | 1,241.1 | 0.0% | 0.0% | 1,096.8 |
| rapid-fire | 100 | 1,524 | 101.6 | 1,190.6 | 1,880.4 | 2,020.5 | 2,087.2 | 0.0% | 0.0% | 1,888.5 |
| rapid-fire | 200 | 1,692 | 112.8 | 2,272.7 | 3,401.3 | 4,120.7 | 6,150.2 | 0.0% | 0.0% | 2,504.0 |
| mixed-40-20-40 | 10 | 172 | 11.5 | 797.9 | 1,568.7 | 1,979.1 | 2,141.2 | 0.0% | 0.0% | 978.3 |
| mixed-40-20-40 | 50 | 378 | 25.2 | 2,024.2 | 4,005.4 | 4,692.9 | 4,984.4 | 0.0% | 0.0% | 1,801.5 |
| mixed-40-20-40 | 100 | 470 | 31.3 | 3,765.1 | 7,381.9 | 8,365.4 | 9,931.6 | 0.0% | 0.0% | 3,116.4 |
| **mixed-40-20-40** | **200** | **2,635** | **175.7** | **18.5** | **10,012.8** | **10,121.1** | **10,215.3** | **88.4%** | **88.4%** | **4,425.0** |
| write-pressure | 10 | 380 | 25.3 | 406.5 | 573.3 | 658.3 | 658.5 | 0.0% | 0.0% | 656.9 |
| write-pressure | 50 | 3,032 | 202.1 | 238.0 | 387.1 | 510.9 | 514.9 | 0.0% | 0.0% | 417.6 |
| write-pressure | 100 | 6,800 | 453.3 | 220.2 | 316.0 | 340.3 | 357.6 | 0.0% | 0.0% | 338.4 |
| write-pressure | 200 | 7,002 | 466.8 | 450.1 | 668.6 | 796.9 | 5,033.1 | 0.0% | 0.0% | 432.3 |

Zero test-harness failures (all 16 tier-runs completed, server never died mid-run, CSRF/auth
smoke test passed).

## Top bottleneck: `mixed-40-20-40` at tier 200 collapses

This is the standout result. Every other scenario/tier degrades gracefully (latency climbs,
throughput plateaus, zero errors). `mixed-40-20-40` at c200 is qualitatively different:
**88.4% error rate**, and a bimodal latency distribution — p50 of 18.5ms sitting right next to a
p95/p99/max all pinned at ~10,000-10,215ms (the driver's `AbortSignal.timeout(10_000)` ceiling,
see `scripts/load-test/driver.mjs:40`).

That shape (most requests either near-instant or exactly at the 10s timeout wall, almost nothing
in between) is the signature of two failure modes happening together, not one:

1. **A large share of requests failing near-instantly** (dragging p50 down to 18.5ms despite an
   88.4% error rate) — consistent with the server hitting a connection-accept/backlog limit and
   refusing new connections outright once its single event loop is saturated, rather than queuing
   them.
2. **The requests that *do* get accepted queuing behind synchronous SQLite work until the client
   gives up at 10s** — matching every prior run of this harness and the 2026-07-05 baseline's
   root-cause finding.

`mixed-40-20-40` scenario `c` is 20% `POST /api/wallets` (a write: xpub parse + `DatabaseSync`
insert, `wallets.ts:288`) mixed with 80% portfolio/send-page reads. It is the only scenario in
the whole matrix that mixes writes into a majority-read pattern with no idempotency (each POST
mints a new wallet row), so it's also the one most exposed to the write path's synchronous-lock
cost compounding under concurrency — exactly what the 2026-07-05 report and the 2026-07-12
`TEST-FINDINGS` doc both flagged as the likely `createWallet` culprit.

**Secondary bottleneck — recovery straggler in `write-pressure` tier 200:** p50/p95/p99 all
recover to reasonable levels (450/669/797ms) but `max` spikes to 5,033ms, a single outlier ~6x
the p99. `write-pressure` runs last in the scenario order (`a,b,c,d`), immediately after
`mixed-40-20-40`'s tier-200 meltdown. This matches the 2026-07-05 baseline's Scenario 6 finding
almost exactly: "dropping straight back to [lower] concurrent, the typical request is instantly
fast again... but one request stalled" — a single straggler queued behind leftover work from the
prior scenario's backlog, not a `write-pressure`-specific problem.

## Corroboration of the sync-SQLite concurrency finding (cairn-xlrm)

Yes — this run corroborates it directly, on two independent axes:

1. **Event-loop lag tracks request latency in every scenario**, not just the ones with DB writes.
   `steady-browsing` (mostly GETs) still shows `lagP99` climbing from 597ms → 838ms alongside its
   own p99 climbing 600ms → 1,420ms across tiers. If reads were cheap and only writes blocked the
   loop, read-heavy scenarios' lag should stay flat — it doesn't. This is the same signature
   documented in `TEST-FINDINGS-2026-07-12.md` ("event-loop lag tracks request latency in every
   scenario... consistent with... Node's synchronous `DatabaseSync` usage").
2. **The one scenario with unbounded writes (`mixed-40-20-40`, via repeated `POST
   /api/wallets`) is the only one that ever produces errors**, and it does so catastrophically
   at the highest tier — a strictly worse result than every pure-read or idempotent-write
   scenario at the same concurrency. That is exactly what "the write path serializes on one
   synchronous SQLite connection" predicts: unbounded/non-idempotent writes are the one workload
   shape that can actually exhaust server resources under load, not merely slow down.

This broadens cairn-xlrm's evidence base: the mechanism isn't confined to explicit write-heavy
scenarios (`write-pressure` here stayed error-free even at c200, because its writes are
idempotent upserts on a small fixed row set) — it's specifically **unbounded insert volume**
(new wallet rows per request) combined with concurrency that tips the server from "slow" to
"failing."

## Baseline comparison

Two baselines exist. Comparing against the **same-day 2026-07-12 wave baseline**
(`docs/TEST-FINDINGS-2026-07-12.md`, run earlier the same day on this same harness/branch):

| scenario | tier | baseline (07-12) rps | this run rps | baseline p50 | this run p50 | baseline err% | this run err% |
|---|---|---|---|---|---|---|---|
| steady-browsing | 10 | 286.3 | 74.0 | 15.1ms | 101.6ms | 0.0% | 0.0% |
| steady-browsing | 200 | 642.0 | 266.0 | 372.0ms | 963.0ms | 0.0% | 0.0% |
| rapid-fire | 10 | 96.8 | 30.7 | 97.8ms | 334.1ms | 0.0% | 0.0% |
| rapid-fire | 200 | 278.8 | 112.8 | 788.3ms | 2,272.7ms | 0.0% | 0.0% |
| mixed-40-20-40 | 10 | 41.5 | 11.5 | 213.1ms | 797.9ms | 0.0% | 0.0% |
| mixed-40-20-40 | 200 | 59.1 | 175.7 | 4,484.0ms | 18.5ms | 0.3% | **88.4%** |
| write-pressure | 10 | 1,061.3 | 25.3 | 9.1ms | 406.5ms | 0.0% | 0.0% |
| write-pressure | 200 | 657.7 | 466.8 | 333.1ms | 450.1ms | 0.0% | 0.0% |

Every scenario is worse in this run at every comparable tier — throughput down roughly 2-4x,
latency up roughly 3-10x — **except** `mixed-40-20-40` at tier 200, where throughput actually beat
the baseline (175.7 vs 59.1 rps) because the server started **failing fast** instead of queuing:
88.4% of requests errored out (mostly near-instantly, per the bimodal split above) rather than
queuing for the full window, so more requests got attempted per second even though almost none of
them succeeded. That is a worse outcome dressed up as a better throughput number — not a real
improvement.

Given the concurrent-session contention documented above (different git SHA before/after, 36
node processes running), **this comparison is confounded and should not be read as "the app got
slower since this morning."** The consistent, uniform ~2-4x degradation across every scenario and
tier (not just the ones touching the DB) points at shared-machine CPU contention, not an app
regression — a genuine regression would be expected to hit write/DB paths disproportionately, and
it doesn't (reads degraded by a similar factor to writes here). The one qualitative difference
that *isn't* explained by generic contention is `mixed-40-20-40` c200 crossing from "slow" (0.3%
errors) to "failing" (88.4% errors) — that's a real signal that this exact workload shape sits
right at a cliff edge, where additional load (from any source, including a noisy neighbor) is
enough to tip it from degraded to broken. Recommend re-running this harness in isolation (quiet
machine, dedicated worktree) before trusting the magnitude of that shift.

## Anomalies

- **`mixed-40-20-40` c200's bimodal latency** (p50=18.5ms next to p95/p99/max pinned at the 10s
  client timeout) is the most actionable anomaly in this run — see bottleneck section above.
  Worth a direct repro with server-side request logging correlated to accept-queue depth to
  confirm whether it's connection-refusal or synchronous-lock queuing (or both).
- **`write-pressure` tier 10 running far below its own tier 50/100/200** (25.3 rps vs 202/453/467
  rps) is the opposite of every other scenario's shape (which degrade as tier rises) and the
  opposite of the 2026-07-12 baseline's write-pressure shape too (which peaked at tier 10). Most
  likely explanation: `write-pressure` runs last (`a,b,c,d` order) immediately after
  `mixed-40-20-40`'s c200 meltdown, and its own tier-10 pass absorbed residual backlog/recovery
  cost from that meltdown before the server settled — the same "spike recovery straggler" pattern
  as the 5,033ms max at its own tier 200. Not itself a `write-pressure` bug.
- No 5xx or crash was ever logged by the server process itself across all 16 tier-runs; all
  error samples are either connection-level (`status: 0`) or client-side 10s timeouts, not
  server exceptions.

## Cleanup performed

- Harness's own teardown already stopped the server and removed its throwaway dir
  (`C:\Users\alexl\AppData\Local\Temp\cairn-loadtest\<pid>`) as part of `run.mjs`'s `finally`
  block — confirmed empty after the run.
- Verified no process is listening on the harness's ports (3399 HTTP, 9399 elmon) after
  completion.
- `scripts/load-test/results/*.json` artifacts left in place per instructions (gitignored).
- No beads filed, no commits made, per instructions.
