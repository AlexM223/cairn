# QA Wave Master Report — 2026-07-12b

Branch: `single-sig-full-wallet` (shared). Tag: `qa-2026-07-12b`.

## 1. Scope + method

Eight parallel tracks ran against this branch over 2026-07-12/13, coordinated via
session-seeded auth (no password entry, no signup flow — a throwaway user + session
token seeded directly into each instance's SQLite DB, cookie set via `document.cookie`
on a dedicated `*.localhost` subdomain per agent to avoid bare-`localhost` cookie
collisions across concurrent QA instances):

1. **Admin + feature-flag leak audit** (Track G2) — every `/admin/**` page and
   `/api/admin/**` endpoint probed with admin/non-admin/unauthenticated callers;
   full feature-flag matrix toggled through the real admin UI/API seams.
2. **Browser UX flows** (Track A2) — 13 assigned user-facing flows driven end-to-end
   in the browser (dashboard, wizard, receive, send, tx list, explorer, activity,
   settings, notifications, backup, error states), desktop + mobile.
3. **New-feature verification** (Track F) — quorum-risk classifier, fiat display,
   explorer "yours" badges, Core-RPC auto-connect probe.
4. **Bitcoin/auth edge-case test suites** (this session, Step 1) — two standalone
   branches merged in: `qa/edge-btc-2026-07-12` (89 tests) and
   `qa/edge-auth-2026-07-12` (43 tests).
5. **Stress / concurrency track** — scripted multi-agent scenarios
   (`scripts/qa/scenario1-mixed.mjs` through `scenario4-session-churn.mjs`) plus the
   unit-level concurrency suite (`concurrencyMultisigRace.test.ts`,
   `concurrencySingleSigRace.test.ts`, `concurrencyWriteBurst.test.ts`,
   `concurrencyMultiHandle.test.ts`, 18 tests) probing cross-session data bleed and
   write races.
6. **Load test** (Track E) — offline, repeatable throughput/latency harness
   (`scripts/load-test/`) across 4 scenarios x 4 concurrency tiers.
7. **Destructive-ops audit** — account deletion, instance reset, and backup/restore
   exercised against a real runtime instance (`destructiveOps.test.ts`,
   `backupRoundTrip.test.ts`, plus direct DB-state verification before/after each
   operation).
8. **QA-infra / tooling** — cross-cutting hazards discovered while running the other
   seven tracks (shared Vite cache, synthetic-click flake, agent stalls).

All work happened on the shared branch `single-sig-full-wallet`; this report itself
is the synthesis pass that merges the two outstanding edge-case test branches, files
beads housekeeping, and aggregates the four written track reports plus bead-comment
evidence from the tracks that didn't produce a standalone doc (stress, destructive
ops).

## 2. Headline verdicts

| Track | Verdict | Key evidence |
|---|---|---|
| Merge + baseline | 3a01b56 (jsonl dedupe) prior repair holds; this wave's merge of both edge-case branches is clean, no `.beads`/`.br_recovery` blob hazard, full suite **2999 passed / 1 skipped** post-merge (up from a 2734-green baseline before this wave's various merges) | this session, Step 1 |
| Browser UX (13 flows) | 13/13 dispositioned: 6 PASS, 1 PARTIAL/INCONCLUSIVE (HMR churn), 5 BLOCKED (env — no live chain backend / downstream of the wizard bug), 1 P0 finding downgraded to **P3 automation flake** after a 3-discriminator scoping pass; 1 new P2 (below-fold CTA), 1 new P3 (duplicate error copy) | `docs/TEST-REPORT-2026-07-12-browser-ux.md` |
| New features (4/4) | All 4 verified with **no product defects**: quorum-risk classifier (26/26 unit + 2 live combos exact match), fiat display (code-verified, live drive-through blocked by env), explorer "yours" badges (negative case live, positive case already covered by cairn-a3fw), auto-connect probe (clean detect-and-surface, no silent fallback). One infra hazard filed: **cairn-sx6f** shared-Vite-cache | `docs/TEST-REPORT-2026-07-12-features.md` |
| Admin + flag matrix | **CLEAN leak verdict** — 12 admin pages + 10 admin API/mutation endpoints all reject non-admin (403) and unauthenticated (302/401) callers, zero admin-only data in any denied body; flag matrix (6 flags + 1 per-user-override pair) resolves exactly per documented precedence | `docs/TEST-REPORT-2026-07-12-admin-flags.md` |
| Bitcoin/auth edge tests | **132 tests added**, merged clean (see per-file table §3) | this session, Step 1 |
| Stress / concurrency | Scripted scenarios 1/2/4 clean (zero cross-session data bleed, zero write races observed); unit concurrency suite 18/18 green; scenario 3 (UTXO double-reservation) **inconclusive** — unfunded regtest wallet, rerun scoped as cairn-l05x; event-loop lag tracks p99 latency in every load-test scenario, corroborating the sync-SQLite root cause (**P2**, filed as cairn-qyvl) | `docs/TEST-REPORT-2026-07-12-loadtest.md`, bead cairn-qyvl, `scripts/qa/scenario*.mjs` |
| Load test | Every scenario degrades gracefully except **mixed-40-20-40 at tier 200: 88.4% error rate** (baseline 0.3%) — bimodal latency (p50=18.5ms next to p95/p99/max pinned at the 10s client timeout), root-caused to unbounded `POST /api/wallets` writes serializing on synchronous SQLite under concurrent read load. Run was contended (36 sibling node processes, git HEAD moved mid-run) — numbers are directional, not clean-box absolutes | `docs/TEST-REPORT-2026-07-12-loadtest.md` |
| Destructive ops | **All 5 PASS/resolved**: cairn-piow (admin deleteUser raw FK crash) and cairn-8r0l (owner deletion silently destroyed shared multisigs for cosigners, zero notice) both **confirmed fixed at runtime** in 6aff163; cairn-qlxs (session-drop during recovery setup) proven **not a server bug** (real per-request pipeline test 3/3 green, symptom matches a known browser-automation hard-navigation cookie-drop artifact); cairn-6uok (admin settings dropped `core_rpc_*` outside custom mode) fixed in 6a06e17 (25/25 targeted tests); restore-is-additive-only gap newly documented as a UI-copy issue (**cairn-11q3**, this session) — factory-reset correctly wipes everything including `core_rpc_*` (memory's earlier "preserve" language referred only to the 6uok settings-form fix, not factory-reset scope) | bead comments on piow/8r0l/qlxs/6uok, this session's cairn-11q3 |

## 3. Edge-case tests merged this wave (132 tests, Step 1)

**`qa/edge-btc-2026-07-12` (commit d387d1e, 89 tests):**

| File | Focus |
|---|---|
| `src/lib/server/multisigScan.edge.test.ts` | UTXO attribution, change-index derivation, receive-address gap clamping — closes cairn-czi0 |
| `src/lib/server/bitcoin/gapLimitScanner.edge.test.ts` | GAP_LIMIT=20 boundary/tail-trim, delta attribution, ScanCache TTL/failure behavior — closes cairn-es7a |
| `src/lib/server/bitcoin/hugeUtxoSet.test.ts` | Large-UTXO-set scan/selection behavior |
| `src/lib/server/bitcoin/malformedSendInputs.test.ts` | Hostile/malformed send-amount inputs — surfaced cairn-ozc5 (`toAmount()` hex-string/array coercion) |
| `src/lib/server/bitcoin/sendBoundaryMatrix2.test.ts` | Additional dust/fee/boundary matrix coverage |

**`qa/edge-auth-2026-07-12` (commit 696a059, 43 tests):**

| File | Focus |
|---|---|
| `src/lib/server/teamModeGate.test.ts` | assertTeamMode/requireTeamMode boundary (independent coverage alongside teamModeBoundary.test.ts, already closing cairn-8nk5) |
| `src/lib/server/webauthnVerification.test.ts` | Counter-replay, origin/RPID binding, challenge lifecycle, notifyNewPasskey — closes cairn-x7vk; surfaced cairn-ixnv (readAuthChallenge consume-once gap) |
| `src/lib/server/concurrentSessionsIntegrity.test.ts` | Concurrent-session state integrity |
| `src/hooks.server.redact.test.ts` | redactPath privacy redaction — closes the last real gap in cairn-16xi |

Both branches merged with `--no-ff`, no conflicts, no `.beads`/`.br_recovery` blob
re-import (verified via `git diff --stat` against merge-base before merging — both
branches touch only new test files). `.git` directory size unchanged at ~138M
post-merge. Full suite after both merges: **2999 passed / 1 skipped (3000 total)**,
zero failures.

## 4. Beads filed / closed this wave

**Created (tag `qa-2026-07-12b`):**

| Bead | Priority | Title |
|---|---|---|
| cairn-qyvl | P2 | Sync-SQLite concurrency collapse under multi-user load (linked to cairn-xlrm, cairn-y802) |
| cairn-ixnv | P3 | webauthn.ts readAuthChallenge has no consume-once guard |
| cairn-11q3 | P3 | Backup restore is additive-only — UI copy should say so |
| cairn-ozc5 | P3 | toAmount() coerces hex-string and single-element-array amounts |
| cairn-l05x | P3 | Load-test rerun needed on quiet box + funded regtest for UTXO double-reservation scenario |

**Closed this wave (with test/runtime evidence):**

| Bead | Resolution |
|---|---|
| cairn-16xi | hooks.server.ts coverage — premise stale, redactPath gap closed by merged `hooks.server.redact.test.ts` |
| cairn-x7vk | WebAuthn coverage — closed by merged `webauthnVerification.test.ts` |
| cairn-czi0 | multisigScan.ts coverage — closed by merged `multisigScan.edge.test.ts` |
| cairn-es7a | gapLimitScanner.ts coverage — closed by merged `gapLimitScanner.edge.test.ts` |

**Commented (already closed, noting additional coverage):** cairn-8nk5 (teamModeGate.test.ts adds independent coverage alongside its existing close evidence).

**Filed by the individual tracks (referenced, not re-created here):** cairn-61bh (P0→P3, wizard dead-click, scope-discriminator-downgraded to automation flake), cairn-coza (P2, below-fold CTA), cairn-s002 (P3, duplicate error copy), cairn-sx6f (P2, shared Vite-cache hazard).

`br doctor` clean after all churn (844 records, DB/JSONL in sync, `blocked_issues_cache` staleness repaired via `br doctor --repair`).

## 5. Known gaps

- **Mobile spot-checks unreliable**: `resize_window` to 375x812 reported success but the
  Browser pane's `window.innerWidth/innerHeight` stayed at desktop size (595x717) in
  two independent tracks (admin-flags, features) — a harness/tooling limitation, not
  an app defect. No mobile-specific layout issue could be confirmed or ruled out this
  wave.
- **Fiat display live positive case untested**: `Amount.svelte`'s BTC/sats/USD cycle is
  code-verified correct (single-source-of-truth via sats, no float drift across unit
  changes) but was never observed live with a non-zero balance — the wallet-creation
  flow needed to seed one kept getting interrupted by shared-Vite-cache churn (cairn-sx6f).
- **Stress scenario 3 (UTXO double-reservation) needs a funded regtest rerun** — see
  cairn-l05x for the exact recipe (quiet box, funded coins, isolated scenario run).
- **Load-test numbers are contended, not clean-box** — 36 sibling node processes and a
  mid-run git HEAD change (`concurrent-session-branch-hazard`) confound the absolute
  throughput/latency figures in `docs/TEST-REPORT-2026-07-12-loadtest.md`; the *shape*
  of the results (mixed-write-scenario cliff at tier 200) is trusted, the magnitude is
  not. Rerun scoped in cairn-l05x.
- **cairn-cl13** (hw_* feature flags don't gate the wallet-creation device picker) and
  **cairn-de7e**/**cairn-puyb** (flag-off state doesn't hide UI client-side) remain open,
  reconfirmed present by code re-check this wave, not re-filed.

## 6. QA-infra lessons

- **Shared `node_modules/.vite` optimizer cache is a live, recurring hazard**
  (cairn-sx6f): concurrent dev servers on one checkout invalidate each other's Vite
  dependency cache, producing generic 500 pages and HMR-reload-spam on random routes
  that are indistinguishable from real product crashes without server-side log
  correlation. Every track this wave that used a shared dev server hit this at least
  once. Fix is per-instance cache isolation or dedicated worktrees for parallel QA —
  already tracked, not re-scoped here.
- **Synthetic-click flake is a real, reproducible automation artifact, not a product
  signal.** cairn-61bh's full lifecycle this wave is the canonical example: filed as
  P0 (wizard entry point completely dead), then run through three independent
  discriminators (regression-window git history, prod build + throwaway instance,
  real Chrome via claude-in-chrome) that each showed the *same* handler and state
  machine behaving correctly for every JS-dispatched click in every context, while
  only the automation tool's coordinate/ref-based synthetic click intermittently
  no-op'd on different buttons in different sessions. Downgraded P0 to P3 on that
  evidence. Lesson: a dead-click finding with zero console/network signal and a
  syntactically-correct handler should be settled with a JS-dispatched click and/or a
  unit test before being treated as a shipped defect.
- **Agent stall/nudge economics held up**: no track in this wave required more than
  the documented 1-3 nudge budget to recover from a stalled browser-driving subagent
  (per the standing `cairn-browser-agent-stall-recovery` pattern); transcript-mining
  with a fresh worker remains the fallback when nudges don't land.
- **Session-seeding (throwaway user + token + per-agent `*.localhost` subdomain)**
  continues to be the only reliable authenticated-QA pattern — zero password entry,
  zero signup-wizard tar-pitting, zero cross-agent cookie collisions across every
  track this wave.
