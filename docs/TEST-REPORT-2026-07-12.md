# QA Wave Report — 2026-07-12

**Branch:** `test/qa-wave-2026-07-12`
**Bead label:** `test-wave-2026-07-12`

## Wave overview

Five parallel tracks:

1. **Destructive ops** — 14 tests (`src/lib/server/destructiveOps.test.ts`, plus
   `backupRoundTrip.test.ts`).
2. **Hostile Bitcoin inputs** — 87 tests across `src/lib/server/bitcoin/hostileAddresses.test.ts`,
   `hostileXpubs.test.ts`, `hostilePsbts.test.ts`.
3. **Hostile text + session edges** — 109 tests across `src/lib/server/hostileText.test.ts` and
   `src/lib/server/sessionEdges.test.ts`.
4. **Concurrency** — 18 tests across `concurrencyMultisigRace.test.ts`,
   `concurrencySingleSigRace.test.ts`, `concurrencyWriteBurst.test.ts`,
   `concurrencyMultiHandle.test.ts`.
5. **Load harness** — `scripts/load-test/` (offline, repeatable, seeded-data throughput/latency
   measurement) plus its worker helper `scripts/stress/dbWriterWorker.mjs`.

## Suite totals

| | Test files | Tests passed | Skipped | Failed |
|---|---|---|---|---|
| Baseline (start of wave) | — | 2445 | 1 | 0 |
| Final (`npx vitest run`, this report) | 183 passed + 1 skipped (184) | 2669 | 1 | **0** |

Full suite is green. Zero failures. The one skip is `vaultRegtestE2E` ("vault 2-of-3 regtest
E2E (cairn-a4k) needs a live regtest stack" — skipped by design unless `VAULT_E2E=1` with a
local regtest `bitcoind`; unrelated to this wave).

## New files added this wave

Test files (11):

- `src/lib/server/destructiveOps.test.ts`
- `src/lib/server/backupRoundTrip.test.ts`
- `src/lib/server/hostileText.test.ts`
- `src/lib/server/sessionEdges.test.ts`
- `src/lib/server/concurrencyMultisigRace.test.ts`
- `src/lib/server/concurrencySingleSigRace.test.ts`
- `src/lib/server/concurrencyWriteBurst.test.ts`
- `src/lib/server/concurrencyMultiHandle.test.ts`
- `src/lib/server/bitcoin/hostileAddresses.test.ts`
- `src/lib/server/bitcoin/hostileXpubs.test.ts`
- `src/lib/server/bitcoin/hostilePsbts.test.ts`

Supporting scripts (not test files, exercised by the concurrency suite / used standalone):

- `scripts/stress/dbWriterWorker.mjs` — worker-thread helper used by the concurrency write-burst
  tests to drive genuinely parallel writer threads against `DatabaseSync`.
- `scripts/load-test/` — the full load-test harness (`bootstrap.mjs`, `config.mjs`, `driver.mjs`,
  `elmon.mjs`, `report.mjs`, `run.mjs`, `scenarios.mjs`, `seed.mjs`, `xpubDerive.mjs`,
  `fixtures/generate-xpubs.mjs`, `fixtures/xpubs.json`). `results/` is gitignored — per-run JSON
  and server logs are throwaway artifacts, not committed.

## How to run the load harness

```
node scripts/load-test/run.mjs --scenario all
```

This bootstraps an offline instance (dead-port Electrum stub, no real network calls), seeds 200
users / 453 wallets / a 1,100-address hot wallet with 130 txs via `scripts/load-test/seed.mjs`,
then runs each scenario (`steady-browsing`, `rapid-fire`, `mixed-40-20-40`, `write-pressure`) at
concurrency tiers 10/50/100/200, recording p50/p95/p99/max latency, throughput, error rate, and
server event-loop lag. Results land as JSON in `scripts/load-test/results/` (gitignored) plus a
human-readable summary via `scripts/load-test/report.mjs`. Pass `--scenario <name>` to run a
single scenario instead of all four.

## Findings and load results

See `docs/TEST-FINDINGS-2026-07-12.md` for:

- The full findings table (11 new bugs, headline cairn-piow P1).
- What was verified clean (SQLi, XSS, unicode round-trips, session/auth edges, concurrency
  guards, idempotency).
- Existing beads now pinned by tests, ready to flip closed when fixed.
- The full load-test results table and analysis.

All beads from this wave are labeled `test-wave-2026-07-12` for cross-reference.
