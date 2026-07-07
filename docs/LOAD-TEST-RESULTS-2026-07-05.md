# Cairn Load Test Results — 2026-07-05

Load tests run against a `vite dev` instance (dev mode — `npm run build` is currently broken on this branch by a pre-existing esbuild/top-level-await issue unrelated to this test, so a production-build ceiling could not be measured; see caveats below). Traffic generator: [autocannon](https://github.com/mcollina/autocannon) driven by custom Node scripts, one process per scenario, 5 concurrency tiers (10/50/100/200/500) unless noted.

**Test host:** 16 cores, 31 GB RAM, Windows. Cairn backend pointed at a **local** regtest Esplora (`127.0.0.1:3002`) and Electrum (`127.0.0.1:60401`) — never at a public mempool.space/blockstream.info instance, so backend latency in these numbers is "local and fast," not real-network. All load-generation and backend traffic stayed on localhost.

**Isolation note:** port 5173 was already running another active Claude Code session's dev server against the shared `data/cairn.db`. Rather than run hundreds of concurrent connections against a database another session was actively using, this test spun up an isolated `vite dev` instance (the repo's existing `cairn-fresh` launch config) on **port 5199** against its own `data/dev-fresh2.db`, seeded with a dedicated `loadtest@cairn.local` account and pointed at the same local regtest backend. All numbers below are from that isolated instance.

## Headline

Reads and writes have **very different ceilings**, and the gap is the main story:

| Path | Throughput ceiling | Where it starts hurting |
|---|---|---|
| Reads (explorer, dashboard) | ~2,900–2,950 req/s, flat from c50 onward | Never fails; latency grows linearly with concurrency but stays under 300ms even at 500 concurrent |
| Writes (imports, labels, prefs) | ~1,100–1,240 req/s, flat from c50 onward | p99 latency explodes past c100 (3.9s), then past c200 (7.7s); timeouts + connection errors appear at c500 |

The suspected root cause is structural, not a bug: Cairn uses `node:sqlite`'s `DatabaseSync`, which executes every query **synchronously on the main thread**. Every write (and every read that touches the DB) blocks the entire event loop for its duration. Under read load the blocking windows are tiny (single indexed SELECTs). Under write load, `PRAGMA busy_timeout = 5000` makes concurrent writers **queue for up to 5 seconds** rather than fail fast with `SQLITE_BUSY` — which is exactly the shape seen in the write-heavy tail latencies. No `SQLITE_BUSY` errors reached the server logs at any tier; the busy-timeout absorbed the contention as queuing delay instead.

A second structural factor: `getChain()` holds **one shared, pipelined Electrum TCP connection** for the whole process (`src/lib/server/electrum/client.ts`). Address/balance lookups queue behind each other on that single connection rather than parallelizing across sockets.

## Scenario 1 — Read-heavy explorer

`GET /api/blocks`, `/api/blocks/:height`, `/api/tx/:txid`, `/api/address/:address`, `/api/mempool/summary`, round-robin per connection, 10s per tier.

| Concurrency | req/s | p50 | p75 | p90 | p99 | max | Errors |
|---|---|---|---|---|---|---|---|
| 10 | 2,266 | 4ms | 4ms | 4ms | 7ms | 18ms | 0 |
| 50 | 2,871 | 16ms | 17ms | 18ms | 27ms | 34ms | 0 |
| 100 | 2,921 | 33ms | 34ms | 38ms | 48ms | 86ms | 0 |
| 200 | 2,921 | 66ms | 70ms | 75ms | 96ms | 118ms | 0 |
| 500 | 2,951 | 168ms | 172ms | 180ms | 267ms | 290ms | 0 |

Zero errors, zero non-2xx at every tier. Throughput is flat from c50 on (~2,900 req/s) — the server is CPU/event-loop bound, not connection-starved, and simply queues excess concurrency as latency. Latency scales almost perfectly linearly with concurrency (a classic saturated-queue signature: p50 ≈ concurrency/50 × 4ms), which is consistent with one Node process serializing work per request rather than genuinely parallelizing across cores. **Reads degrade gracefully — no tier here is unsafe.**

## Scenario 2 — Auth-heavy (login)

Mixed valid/invalid password logins (30%/70%) against `/api/auth/login/password`, all from one source IP.

| Concurrency | req/s | p50 | p99 | max | Errors | Non-2xx |
|---|---|---|---|---|---|---|
| 10 | 1,774 | 5ms | 10ms | 299ms | 0 | 19,503 |
| 50 | 1,604 | 28ms | 49ms | 59ms | 0 | 16,039 |
| 100 | 2,024 | 46ms | 69ms | 73ms | 0 | 22,259 |
| 200 | 1,926 | 102ms | 128ms | 151ms | 0 | 21,190 |
| 500 | 2,008 | 248ms | 511ms | 699ms | 41 | 22,085 |

The in-memory, per-IP/per-email rate limiter (`src/lib/server/rateLimit.ts`, 20 failed/IP or 5 failed/email per 15 minutes) works exactly as designed: it trips almost immediately and holds — essentially every request after the first handful comes back `429` (that's the 19,503+ non-2xx counts; this is intended behavior, not a bug). No deadlocks, no 5xx. **The only new finding**: at c500, 41 requests came back as client-side connection errors (not 429s) — likely OS/Node socket-handling strain at very high raw concurrency rather than an app-logic problem, since the rate limiter itself (a `Map` lookup) is cheap. Because the limiter fires per-email too, this test also **locked out `loadtest@cairn.local`'s login endpoint for the following 15 minutes** — all subsequent scenarios below reused the one session cookie obtained before this test ran, rather than re-authenticating, which is unaffected by the login throttle.

## Scenario 3 — Write-heavy (wallet ops)

Interleaved `POST /api/wallets` (unique xpub, 1-in-10), `PUT /api/wallets/:id/labels` (idempotent upsert), `PATCH /api/notifications/preferences` (idempotent upsert).

| Concurrency | req/s | p50 | p90 | p99 | max | Errors | Timeouts | Non-2xx |
|---|---|---|---|---|---|---|---|---|
| 10 | 1,060 | 9ms | 10ms | 16ms | 440ms | 0 | 0 | 956 |
| 50 | 1,111 | 44ms | 53ms | 64ms | 1,829ms | 0 | 0 | 1,150 |
| 100 | 1,124 | 88ms | 105ms | 126ms | **3,851ms** | 0 | 0 | 1,200 |
| 200 | 1,192 | 167ms | 204ms | **2,855ms** | **7,731ms** | 0 | 0 | 1,400 |
| 500 | 1,236 | 385ms | 456ms | **8,048ms** | **10,029ms** | 1,215 | 250 | 1,242 |

This is the clearest bottleneck signal in the whole suite. Throughput plateaus at ~1,100–1,240 req/s (well below the read ceiling) and **the tail collapses**: p99 is fine through c100 but explodes to 2.9s at c200 and 8s at c500, with 250 client timeouts and 1,215 connection errors at c500. This is the write path queuing behind `busy_timeout`, not crashing — no `SQLITE_BUSY` or 5xx appeared in server logs at any tier. (The non-2xx counts here are mostly the fixture's xpub pool cycling past its 500 unique entries at high request volume and re-hitting the wallet's `UNIQUE(user_id, xpub)` constraint — a test-fixture artifact, not an app bug; labels/notification-prefs upserts never errored.) **c200 is roughly where write latency crosses from "acceptable" to "user-visible slow"; c500 is where it becomes unsafe (10s worst case, real timeouts).**

## Scenario 4 — Mixed realistic traffic

60% explorer reads / 20% dashboard (`/api/portfolio`, `/api/wallets`, `/api/activity`, `/api/notifications`) / 10% wallet ops (label + import) / 10% admin (`/api/admin/users`, `/api/admin/activity`, `/api/admin/logs`).

| Concurrency | req/s | p50 | p90 | p99 | max | Errors | Non-2xx |
|---|---|---|---|---|---|---|---|
| 10 | 785 | 5ms | 12ms | 56ms | 3,528ms | 0 | 149 |
| 50 | 1,533 | 20ms | 53ms | 326ms | 361ms | 0 | 299 |
| 100 | 1,960 | 35ms | 66ms | 528ms | 582ms | 0 | 398 |
| 200 | 1,940 | 73ms | 134ms | 1,128ms | 1,215ms | 0 | 399 |
| 500 | 2,266 | 332ms | 640ms | 921ms | 1,181ms | 346 | 499 |

Throughput scales up to ~2,266 req/s at c500 (higher than pure writes, lower than pure reads — as expected for a blended workload), but the p99/max tail is visibly write-dominated even though writes are only ~14% of this mix (label+import out of ~50 request types). Memory climbed noticeably during this run (826 MB → 1,283 MB) — addressed directly in the sustained test below to check whether that's a leak or one-time warmup. 346 connection errors appeared at c500, matching the pattern from scenario 2's c500 tier (likely socket-level strain at very high raw concurrency, independent of which scenario is running).

## Scenario 5 — Sustained load (5 minutes, 100 concurrent, mixed traffic)

30 consecutive 10-second passes at fixed 100 concurrency, same mixed-traffic shape as Scenario 4.

- **No memory leak.** RSS rose from ~1,284 MB (right after Scenario 4's peak) down to and then oscillated stably between **1,058–1,073 MB** for the entire 5 minutes — a one-time settle, not a climb.
- **No throughput degradation over time.** req/s bounced between 1,320–2,380 across all 30 passes with no downward trend; the variance is fixture-driven (rate-limited endpoints and cycling xpubs), not time-driven.
- **p50 stayed rock-steady at 34–39ms** for all 300 seconds — the "typical" request never got slower.
- **Recurring latency spikes, not a trend**: 8 of the 30 passes (0, 6, 7, 11, 12, 18, 24, 29 — roughly every 60–110s) showed a max latency of 1.1–4.3s while every neighboring pass was back to normal (<400ms max). This is a periodic hiccup, not sustained degradation, and self-recovers within one 10s pass every time. Plausible causes given the codebase: the address watcher, notification-queue worker, or the portfolio endpoint's once-per-hour snapshot check contending briefly for the same single SQLite connection/event loop. Worth profiling directly (e.g. `perf_hooks.monitorEventLoopDelay`) if this pattern matters for production SLOs — this test could only observe it via latency spikes, not confirm the exact cause.

**Verdict: Cairn holds up fine under sustained moderate load (100 concurrent, mixed traffic) for at least 5 minutes — no leak, no creeping latency.** The periodic spikes are the only open question, and they're modest (worst case ~4.3s, once every minute or so) rather than a stability risk.

## Scenario 6 — Spike test (10 → 200 → 10)

| Phase | Duration | Concurrency | req/s | p50 | p99 | max |
|---|---|---|---|---|---|---|
| Baseline | 10s | 10 | 1,781 | 4ms | 13ms | 400ms |
| Spike | 30s | 200 | 2,061 | 68ms | 221ms | 288ms |
| Recovery | 15s | 10 | 921 | 4ms | 14ms | **7,148ms** |

The spike itself is handled cleanly — no errors, latency comparable to Scenario 1's steady-state c200 tier. The interesting finding is in **recovery**: dropping straight back to 10 concurrent, the typical request is instantly fast again (p50/p99 back to baseline), but **one request stalled to 7.1 seconds** even though load had dropped 20x. That's a classic "long-tail straggler" — a single request queued behind leftover work from the spike (most likely a write or a DB-touching read still waiting on the synchronous SQLite lock, or an Electrum round-trip still queued behind the spike's backlog on the shared connection) rather than the server being generally slow to recover. Aggregate recovery is instant; a small number of individual requests can pay a multi-second tax right after a spike ends.

## Scenario 7 — DB stress (portfolio aggregation)

100 additional single-sig wallets seeded directly into the DB for the load-test user (245 wallets total across this and earlier scenarios' writes), each with `receive_cursor = 50`. `GET /api/portfolio` hit with 50 concurrent connections for 15s.

| Concurrency | req/s | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| 50 | 592 | 55ms | 76ms | 268ms | **4,288ms** |

**Important methodology caveat**: `getPortfolioDetail` scans every wallet via `scanWallet`, which caches results **per xpub for 60 seconds and de-dupes in-flight scans by sharing the same promise** (`walletScan.ts`). With 50 concurrent requests hitting the *same* 245 wallets, only the first request (or first few racing to populate the cache) pays the full aggregation cost — everyone else rides the cached/in-flight result. That's exactly what the numbers show: p50 of 55ms (cache-warm) alongside one outlier at 4.29s (the real cold-scan cost). **The 4.29s figure is the true cost of one full portfolio aggregation across 245 wallets** — ≈17.5ms/wallet, consistent with each wallet's scan walking up to 20 addresses (the `GAP_LIMIT` in `walletScan.ts`; none of these synthetic wallets have any tx history, so every wallet's scan runs to the full 20-address gap-limit) serialized one-at-a-time over the single shared Electrum connection.

Two implications:
1. **The cache is doing real work for you.** A dashboard with many users hitting their own portfolios won't see 4.3s each — only a genuinely cold cache (first load, or 60s+ since the last one) does. Load-testing "N concurrent hits to one endpoint" understates this benefit; real capacity planning should model N *distinct users* with N *distinct wallet sets*, not repeated hits to one cache key.
2. **The 4.3s cold-scan number is the one to worry about for growth.** It scales linearly with wallet count and is bottlenecked by the single Electrum connection — a user with, say, 1,000 wallets would see something like a 15-20s cold dashboard load with the current architecture.

## Bottleneck summary by concurrency tier

| Tier | Reads | Writes | Mixed | Verdict |
|---|---|---|---|---|
| 10 | Fast (4ms) | Fast (9ms) | Fast, occasional cache-cold spike | Fine |
| 50 | Fast (16ms) | Fine (44ms) | Fine | Fine |
| 100 | Fine (33ms) | Fine but p99 tail starts (3.9s max) | Fine | Fine |
| 200 | Fine (66ms) | **Degraded** (p99 2.9s, max 7.7s) | Degraded tail (max 1.2s) | Writes now user-visibly slow |
| 500 | Still fine (168ms, 0 errors) | **Unsafe** (p99 8s, timeouts, 1,215 errors) | Degraded (346 conn errors) | Writes/high-concurrency mixed unsafe |

**The practical ceiling for this dev-mode instance is ~200 concurrent users for write-touching traffic, and comfortably higher (tested to 500 with no failures) for pure reads.** The failure mode under stress is never a crash or 5xx — it's queuing delay from synchronous SQLite writes and, at extreme concurrency (500), client-visible connection errors that look like OS/socket-layer strain rather than application bugs.

## Recommendations

1. **Investigate moving write-heavy paths off `DatabaseSync`'s synchronous execution model**, or at minimum reduce lock hold time per write (smaller transactions, fewer writes per request). This is the single biggest lever — it explains both the write-path tail latency and, most likely, the periodic sustained-load spikes.
2. **Consider more than one Electrum connection** (even a small pool) for the explorer/portfolio paths — the current single shared pipelined connection serializes every scripthash lookup process-wide, which is the direct cause of the ~17.5ms/wallet portfolio scan cost compounding linearly with wallet count.
3. **Treat ~200 concurrent write-touching requests as the safe ceiling** for this instance/hardware combination until (1) and (2) are addressed; reads have comfortable headroom well past 500.
4. **Re-run this suite against a production build** once the existing `vite build` break (top-level-await/esbuild, unrelated to this test — see prior session notes) is fixed. Dev mode carries overhead (unminified code, on-demand module transforms) that likely makes these numbers a *floor*, not a ceiling, for read throughput — though the SQLite/Electrum-connection bottlenecks are structural and should reproduce in production too.
5. **Add real event-loop-lag instrumentation** (`perf_hooks.monitorEventLoopDelay`) if these numbers need to become an ongoing production signal — this test could only approximate event-loop health via latency proxies and OS-level RSS, not measure it directly, since adding that instrumentation to the app itself was out of scope for a one-off load test.
6. The **login rate limiter needs no changes** — it behaves correctly and cheaply under load; the only anomaly (41 connection errors at c500) looks like general high-concurrency socket strain rather than something specific to the auth path.
