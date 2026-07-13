# Test Findings — QA Wave 2026-07-12

**Audience:** UX orchestrator and infra orchestrator (parallel Fable sessions on this repo).
**Branch:** `test/qa-wave-2026-07-12`
**Bead label:** `test-wave-2026-07-12`

## What this wave was

A dedicated QA pass across four hostile-input/destructive-op test suites plus a repeatable
load-test harness:

1. **Destructive ops** (14 tests) — account deletion, instance reset, cascade behavior.
2. **Hostile Bitcoin inputs** (87 tests) — addresses, xpubs, PSBTs.
3. **Hostile text + session edges** (109 tests) — free-text fields, auth/session boundary
   conditions.
4. **Concurrency** (18 tests) — races across multisig signing, single-sig spends, write
   bursts, and multiple concurrent handles.
5. **Load harness** — offline, repeatable, seeded-data throughput/latency measurement.

Every finding below is now **pinned by a test**: the relevant test asserts today's (broken)
behavior and is written to **fail loudly** the moment someone fixes the underlying bug, so
regressions can't silently reappear and fixes can't silently go unnoticed. None of these tests
should be "fixed" by loosening their assertions — if one starts failing, that's a signal the
underlying bug was fixed and the bead should close.

## New bugs found this wave

| Bead | Severity | Finding |
|---|---|---|
| cairn-piow | P1 | `admin.ts` deleteUser throws raw `FOREIGN KEY constraint failed` (not `AuthError`) when the target user created invites or updated feature flags; the row survives the failed delete. |
| cairn-sclk | P2 | A disabled sole admin can still self-delete, leaving zero admin rows. |
| cairn-3l1e | P2 | Whitespace-padded valid address crashes `constructPsbt` with a raw `@scure/base` error. |
| cairn-b9iv | P2 | `parseXpub` accepts a depth-0 master xpub with no warning (privacy/scope exposure). |
| cairn-y73r | P2 | NUL byte silently truncates stored text in every free-text write path. |
| cairn-l04v | P2 | Registration `displayName` has no length cap (10k chars stored; fans into notifications/activity/admin list). |
| cairn-3is8 | P3 | Cosigner fingerprint is only regex-checked, never cross-validated; a wrong value gets baked into PSBT `bip32Derivation` + descriptors. |
| cairn-k89i | P3 | Some `finalizePsbt` call sites use an untyped plain-Error parse-failure path that can leak raw messages. |
| cairn-qmx8 | P3 | Wallet name `slice(0,64)` splits surrogate pairs, producing U+FFFD. |
| cairn-vgbv | P3 | Multisig name cap counts UTF-16 code units, not glyphs. |
| cairn-b9rw | P3 | `attachMultisigSignature` is race-free *only* because it is fully synchronous today; any future `await` inside it needs `withLock`. |

### Notes on the headline (cairn-piow, P1)

`admin.ts:98-107`'s `deleteUser` has no pre-cleanup step for rows that reference the target user
(invites created, feature-flag overrides authored by them) before issuing the `DELETE`. SQLite's
foreign-key enforcement throws a raw driver error instead of the app's `AuthError`, and — because
the delete never runs — the target user row survives untouched. `accountDeletion.ts:66-68`
already has the correct pattern (delete/null out referencing rows first); `admin.ts` needs the
same treatment mirrored in.

### Verified clean (no findings)

- SQL injection is inert everywhere tested — all queries are parameterized.
- Stored XSS payloads are stored and rendered as literal text, never executed.
- Unicode/RTL/zalgo text round-trips cleanly wherever no length cap applies.
- Session/auth edges are all correct: expired tokens, tampered tokens, post-logout use, the
  exact expiry-boundary instant, and deleted-user cascade all behave correctly. Concurrent
  logins from multiple devices are allowed by design (not a bug).
- All concurrency guards hold: the coin-reservation `withLock` is load-bearing and effective;
  broadcast-claim is atomic; the RBF unique constraint prevents double-bump races.
- Double-submitted requests (deletion, broadcast, signature attach) are idempotent.

## Existing beads now pinned by tests

These beads pre-date this wave. New tests assert the current (broken) behavior for each, so
each will now fail loudly the moment a fix lands — flip status to closed once its test flips to
"passing new/expected behavior" and update the assertion:

- **cairn-rksw** — factory reset leaves `instance_secrets` + `feature_flags` behind.
- **cairn-s6x3** — backup export omits `multisig_shares` + notification prefs / contacts /
  address labels / device keys / flag overrides.
- **cairn-8r0l** — owner delete destroys a shared multisig wallet and any in-flight PSBT with
  zero notice to cosigners.
- **cairn-z93o** — cosigner self-delete is data-clean but sends no notice to the wallet owner.
- **cairn-90k8** — no backup-version floor is enforced; missing fields silently default.
- **cairn-684u** — cascade-delete correctness now verified complete by this wave — closable on
  merge.
- **cairn-nohi** — the sweep-on-delete behavior is now verified complete by this wave — closable
  on merge.
- **cairn-a857** — session cleanup on account changes is only half done; mid-operation
  disruption (an in-flight request when the session is invalidated) remains open.

## Load test results

Repeatable, offline harness lives at `scripts/load-test/` (see `docs/TEST-REPORT-2026-07-12.md`
for how to run it: `node scripts/load-test/run.mjs --scenario all`). It runs entirely offline
against a dead-port Electrum stub, against a seeded dataset of 200 users / 453 wallets / a
1,100-address "hot" wallet. Per-run JSON artifacts land in `scripts/load-test/results/`
(gitignored, not committed).

**Key findings:**

- The **mixed read/write scenario** degrades ~21x from tier 10 to tier 200 concurrency (p50
  213ms → 4,484ms), throughput stays stuck at 41-59 rps, and it's the only scenario that shows
  any errors at all (0.3% at tier 200). This points at `POST /api/wallets` serializing badly
  under concurrent load.
- **Event-loop lag tracks request latency in every scenario** — consistent with the existing
  finding that Node's synchronous `DatabaseSync` usage is the ceiling on throughput (matches
  cairn-xlrm).
- **Write-pressure throughput is non-monotonic**: 1,061 → 1,013 → 587 → 658 rps at concurrency
  tiers 10/50/100/200. That shape (a dip, not a plateau) is a lock-contention signature, not
  simple resource saturation.
- **Rapid-fire** (many small reads) plateaus around 190-280 rps regardless of concurrency tier.

### Full results table

`scenario | tier | reqs | rps | p50 | p95 | p99 | max | err% | lagP99ms` (times in ms):

```
steady-browsing   10   4295  286.3   15.1  111.7  129.8  166.3  0.0  124.9
steady-browsing   50   4030  268.7  184.4  241.9  257.4  286.6  0.0  273.2
steady-browsing  100   6500  433.3  242.5  319.5  341.6  373.4  0.0  351.8
steady-browsing  200   9630  642.0  372.0  461.3  488.5  505.2  0.0  278.4

rapid-fire        10   1452   96.8   97.8  181.1  217.3  338.8  0.0  239.1
rapid-fire        50   2902  193.5  234.8  520.4  600.7  678.1  0.0  581.4
rapid-fire       100   3986  265.7  394.7  554.6  618.6  758.1  0.0  541.1
rapid-fire       200   4182  278.8  788.3 1152.9 1234.5 1372.0  0.0  850.9

mixed-40-20-40    10    623   41.5  213.1  428.9  495.1  525.7  0.0  240.4
mixed-40-20-40    50    697   46.5 1023.9 1748.0 2520.3 2524.0  0.0  897.6
mixed-40-20-40   100    792   52.8 1990.9 3194.7 3440.3 4701.2  0.0 1696.6
mixed-40-20-40   200    887   59.1 4484.0 8938.1 10007.6 10013.1 0.3 2946.5

write-pressure    10  15920 1061.3   9.1   11.5   16.9   24.4  0.0   25.6
write-pressure    50  15200 1013.3  44.6  115.1  130.3  144.9  0.0  129.0
write-pressure   100   8800  586.7 173.5  190.3  198.1  237.6  0.0  195.7
write-pressure   200   9866  657.7 333.1  368.8  372.3  464.4  0.0  217.1
```

A new P2 bead has been filed for the mixed-scenario finding above (see
`docs/TEST-REPORT-2026-07-12.md` for the bead id and evidence file), pointing at the sync
xpub-parse + `DatabaseSync` insert path in `createWallet` (`wallets.ts:288`) as the likely
culprit, relating to cairn-xlrm and cairn-6xxa.
