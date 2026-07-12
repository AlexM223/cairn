# BEADS-AUDIT.md — Cairn Beads Audit

**Date:** 2026-07-12 · **Branch:** single-sig-full-wallet · **Method:** 5 parallel analysis lenses (status/staleness, dependency graph, area clustering, MANUAL.md cross-reference, elevation-directive coverage), synthesized.

---

## 1. Status overview

| Metric | Value |
|---|---|
| Total issues | 648 (649 JSONL records incl. 1 tombstone, cairn-snez) |
| Closed | 583 |
| Open | 65 (64 excluding tombstone; cairn-hxfn closed today, so effectively 64) |
| In progress | 0 (workflow goes open→closed in one step) |
| Open by priority | P0: 0 · P1: 21 · P2: 29 · P3: 15 |
| Open by type | bug 36 · task 18 · epic 5 · feature 4 · question 1 · docs 1 |
| Ready / blocked | ~54 ready, 10 blocked. **Lens discrepancy:** `br ready` reported 20 in one run (likely a display limit); direct JSONL edge-parse and `br blocked` both independently give 10 blocked → 54 ready. Trust 54/10. |
| Dep cycles | None (verified two ways) |
| Data hygiene | 4 closed beads have labels stuffed into `issue_type` (cairn-aiyw, cairn-xsuq, cairn-jnka, cairn-un1g) — cosmetic |

## 2. Staleness + priority findings

- **50 of 65 open beads untouched >3 days.** The dominant cohort is the review-2026-07-07 batch (32 beads, all last touched 2026-07-08) that never got a dispatch wave.
- **Of 21 open P1s, only ~3 are live code defects** (cairn-gakd subscription leak, cairn-zdgt double fetch, cairn-p9c3 SSRF — but see the p9c3 caveat in §5). Eleven P1 "bugs" are test-gaps: missing proof of security/consensus invariants (cairn-x7vk, cairn-er7r, cairn-8nk5, cairn-es7a, etc.). The P1 band now means "prove behavior," not "fix breakage."
- **Underweighted (recommend P2→P1):** cairn-u2r5 (SIGHASH_ALL not enforced at finalization — spend-path safety), cairn-vo6z (untrusted finalScriptWitness adopted in multisig combine — also contradicts MANUAL §18.9), cairn-0dg4 (backup restore can inject `registration_mode=open` / disable SSRF guard — auth-posture bypass, small fix). Arguable: cairn-vzvw, cairn-wqkk (systemic root cause of the authz-gap class).
- **Overweighted:** cairn-zdgt (P1→P2 or close — likely overtaken by the 2zxt.8 snapshot/SWR rework of 2026-07-10; verify before touching).
- **Needs-Alex, not agent-actionable:** cairn-49xi.4 (real-device umbrelOS pass), cairn-koy4.13 (rebrand decision), cairn-2ldr (Electrum-defaults product decision).
- No open bead falsely claims to be shipped (done-language scan clean; cairn-jy3g correctly scopes Phase 2 as open).

## 3. Dependency health

Graph is shallow (max depth 3, via epics only) and cycle-free. Three structural defects:

1. **cairn-6xxa (P1 perf epic) is inverted and empty.** Zero children, empty description, yet 6 open beads carry `blocks` edges *on* it — cairn-wcxw (P1 sync engine), cairn-2ldr, cairn-uhg1, cairn-8ubd, cairn-1q4b, cairn-5pov. The epic shows READY while all its real work shows BLOCKED — opposite of the zoz8/koy4/49xi convention, and those 6 can never become ready until someone closes or rewires the epic. This is the single biggest gate in the tracker. (Proof the edges encode nothing real: cairn-b7to closed 2026-07-11 while "blocked" by 6xxa.) One lens listed children for 6xxa; the graph lens's direct edge parse (0 parent-child, 6 blocks) is authoritative.
2. **cairn-vknb (P1 epic): all 6 children closed**, fix QA-verified on live Umbrel 2026-07-08, `br epic status` says eligible_for_close. It pollutes the P1 count and the ready list. One lens claimed vknb.6 (ARM verification) was residual — the status lens shows it closed 2026-07-08; trust closed. Close the epic.
3. **cairn-2zxt.8.9 is orphaned** — open P3 under closed parent cairn-2zxt.8 and closed grandparent epic; invisible in epic views. Reparent (6xxa's perf scope fits) or accept as standalone.

**Only genuine build-order chain left:** cairn-zoz8.13 ∥ cairn-zoz8.16 (both ready) → cairn-zoz8.17 → close cairn-zoz8. **Warning:** cairn-zoz8.17 ("remove EsploraApi entirely") predates the 2026-07-10 finding that Explorer/Home need a separate Esplora HTTP API that Electrum cannot satisfy — rescope before executing or it regresses Home/Explorer on Umbrel.

**Confirmed duplicate pair:** cairn-b1rg ≡ cairn-mf68 (same defect, historyExport.ts:50-52 CSV formula injection, filed 7 min apart). Close one as dup.

## 4. Area clustering + zero-coverage areas

Open-backlog clusters (65 beads): Electrum transport/migration 17 · test-gap debt 13 · security/trust-boundary 12 · perf re-architecture 9 · multisig correctness 9 · send/fee-bump 7 · data integrity/backup 7 · Umbrel/packaging 7 · scanning 3 · UX/tech-debt 4. 62% of open beads are residue of the two 2026-07-07 audits.

**Three recurring patterns:**
- **A. Sibling-path guard divergence** — a guard exists on the primary path, its parallel entry silently lacks it: cairn-etz9 (API still accepts removed p2sh), cairn-e8de (stateless route skips validateMultisigKeyPaths), cairn-vo6z, cairn-u2r5, cairn-wqkk, cairn-0dg4/cairn-lka5, cairn-o7zy, cairn-b1rg/mf68. Security-facing expression of the known fork problem (cairn-rg99, cairn-7rge).
- **B. Unmanaged Electrum resource lifecycle** — grow-only state, no teardown: cairn-gakd, cairn-afdy, cairn-32kh, cairn-sp74, cairn-1hb0, cairn-zdgt, cairn-43dx. Seven beads, one subsystem, one shape.
- **C. Verification debt dominates P1** — failures were fixed; the evidence they stay fixed was never built.

**Zero-bead areas where zero beads = zero examination** (young code, never audited): **api/search** (1 commit ever; parses free-form user input into chain backends), **settings/tokens** (auth-bearing, 3 commits), **admin announcements**, **admin referral-settings** (renders admin-entered URLs to users), **admin feature-flags page**. All other zero-bead surfaces (receive, auth UI, wizards, legal, /sync, admin core) have verified fix/QA history — genuinely stable. Trivial cleanup: empty `src/routes/(app)/vaults/**` and `src/routes/api/vaults/**` directory skeletons from the vault→multisig rename.

## 5. MANUAL.md cross-reference gaps

**Part I features with no Part II QA scenario** (risk order): admin backup/restore round-trip (two open bugs sit exactly there: cairn-0dg4, cairn-lka5); notification channels beyond tx-events (cairn-sask makes this non-academic); feature-flag admin flow; auth beyond password happy-path (compounds cairn-x7vk); explorer as a feature; batch sending; CSV export (open bug pair against it); stateless multisig route (cairn-e8de, cairn-hla1 live there); labels/address book; wallet/account deletion (cairn-vop2, cairn-684u open).

**Part II scenarios with no run evidence ever:** §17.4 reversed sign order, §18.10 send-max, §19.4/19.5 real-hardware rows, §21 full Umbrel journey (= unexecuted cairn-49xi.4), §20.14 (shipped today on unit-test evidence only).

**Fixes without beads (violates the beads-for-every-fix rule):** the §18.8 `withLock` draft serialization (commit ff2d16f) and the §20.12 QrScanner extraction (96cd16a).

**Tracker/manual contradictions (manual/behavior disagreement = a bug):**
- §11/§17.2 "lossless" Caravan round-trip vs open cairn-o7zy — §17.2 can false-PASS (byte-identical JSON, semantically corrupted path).
- §18.1 row G legacy-p2sh create leg vs cairn-acft (closed, removed from wizard) + cairn-etz9 — row G needs an import-only rewrite.
- §18.9/§1 "tampered PSBT rejected" vs cairn-vo6z (witness-level tampering passes).
- §5 60s broadcast-claim expiry vs cairn-ytnc (true for retry, false for delete).
- §4 backoff ceiling vs cairn-sp74 (ensureConnected bypasses it).
- §5 key-path gate strength vs cairn-ryjc + cairn-e8de.
- §1/§15 "name split permanent" vs open decision cairn-koy4.13.
- Omissions where Part II asserts PASS bars: HARD_CAP=400 silent truncation (cairn-kxhv), WATCH_WINDOW=30 blind spot (cairn-43dx).
- **Internal tracker contradiction:** cairn-zn7z (CLOSED, fix 4418db9, relay-URL SSRF validation) vs cairn-p9c3 (OPEN P1, identical finding, identical line). Lenses disagree on whether p9c3 is live or a stale review dup. **Verify against current code first**; likely verify-and-close, else it's the top open vuln.

**Untracked "not yet" items in Part I:** parseBip21 built-but-unwired, QrScanner `mode="single"` unwired, README Esplora staleness, no .env.example, no CI Docker build step, safeAction adoption stalled at 2 call sites, vite-plugin-top-level-await still in devDependencies (forbidden), wizardProgress twin-file / signingMass triple-naming hazards (cairn-sb3h doesn't cover these two).

## 6. Elevation-directive coverage map (7 workstreams)

| Workstream | Covered by existing beads | Uncovered → proposed |
|---|---|---|
| (a) Consumer-wallet UX | zoz8.18 (price plumbing), hla1, 7rge (enablers) | Fiat display everywhere (verified: `usd` only on dashboard hero); plain-language send confirm; xpub/descriptor progressive disclosure |
| (b) Edge-case testing | 13 test-gap beads, kxhv, gakd, 32kh, sp74, b1rg/mf68 | Send boundary matrix (dust/zero/amount≤fee/sweep); scale fixtures (1000 UTXO/50 wallets); hostile-input sweep; mid-op disruption; inbound double-spend reconciliation |
| (c) Admin + flags + no leakage | 43sq epic (closed), 8nk5, wqkk, sask, 0dg4, zoz8.16 | Systematic admin→user content-leak audit; admin-tools flag-matrix pass |
| (d) Load testing | 6xxa cluster (fix-side), closed 2026-07-05 wave | Repeatable harness (all prior load testing was ad-hoc); SQLite index/query benchmarks |
| (e) Explorer elevation | zoz8.13/.16/.17/.18/.19, d8aa; rich closed history | Explorer↔wallet linking is one-directional (verified); large-block perf; wallet links ignore explorer flag |
| (f) Redundancy audit | rg99, 7rge, sb3h, hla1, zdgt (all code-level or spot) | Holistic user-facing click-path/duplicate-surface audit |
| (g) Umbrel auto-connect | hxfn (Wave A, CLOSED today), loq7, 2ldr (decision), 5pov | **Wave B (Core RPC via Docker DNS) has zero beads**; provenance UI card (chain_provisioned_by exposed but no UI consumes it — verified); on-device probe test pass |

## 7. Recommendations (ranked)

1. **Fix cairn-6xxa** — write description + convert its 6 inbound `blocks` edges to parent-child (or dissolve the epic). One edit unblocks a P1 and 5 more beads; also unblock cairn-2ldr specifically (it's a product decision, not perf work).
2. **Verify cairn-p9c3 against code** (vs closed cairn-zn7z / fix 4418db9); close as stale dup or dispatch immediately — it's either the top open vuln or tracker noise.
3. **Close cairn-vknb** (6/6 children closed, QA-verified) and **close one of cairn-b1rg/cairn-mf68** as dup; fix the CSV escaping once.
4. **Bump cairn-u2r5, cairn-vo6z, cairn-0dg4 to P1** and dispatch as one signing/restore-hardening wave (all are small, funds/auth-safety fixes; vo6z also restores MANUAL §18.9's invariant).
5. **Rescope cairn-zoz8.17** against the 2026-07-10 Esplora/Electrum-split finding before running the zoz8 tail (.13/.16 are ready now).
6. **Dispatch the test-gap P1 cohort** starting cairn-x7vk, cairn-er7r, cairn-czi0; fold in the new send-boundary matrix bead.
7. **MANUAL.md correction pass** (contradictions in §5) + Part II scenario expansion — the runbook currently false-PASSes on Caravan round-trip and row G.
8. **File the two workstream-P1 gaps:** Umbrel Wave B auto-connect and the admin leak audit.
9. **Reparent cairn-2zxt.8.9**; delete the empty vaults/ route skeletons; verify-then-downgrade cairn-zdgt.
10. **Queue the Alex-gated trio** (49xi.4, koy4.13, 2ldr) as an explicit "needs Alex" list so they stop reading as stale agent work.

## 8. Proposed new beads (preview — full detail in structured output)

| Title | Type | Pri | Workstream |
|---|---|---|---|
| Umbrel auto-connect Wave B: Core RPC auto-detect via Docker DNS | feature | P1 | g |
| Admin-surface leak audit: zero admin data in non-admin sessions | task | P1 | c |
| Send-flow boundary matrix tests (zero/dust/amount≤fee/sweep/min-relay) | task | P1 | b |
| Fiat equivalents across wallet, send, and tx surfaces | feature | P2 | a |
| Plain-language send confirmation with Details disclosure | feature | P2 | a |
| Scale-fixture generator: 1000-UTXO / 50-wallet / 100-tx | task | P2 | b,d |
| Hostile-input sweep (unicode/RTL/emoji/XSS/SQLi) | task | P2 | b |
| Mid-operation disruption tests | task | P2 | b |
| Reconcile replaced/evicted inbound unconfirmed txs | bug | P2 | b |
| Admin tools flag-matrix test pass | task | P2 | c |
| Repeatable load-test harness | task | P2 | d |
| Explorer recognizes user's own addresses/txs | feature | P2 | e |
| Large-block explorer perf: paginate + 4000-tx benchmark | task | P2 | e |
| App-wide click-path + duplicate-surface audit | task | P2 | f |
| Settings-UI provenance card for auto-connected backends | task | P2 | g |
| umbrelOS test pass: auto-connect probe on real device | task | P2 | g |
| MANUAL.md Part II missing-scenario expansion | task | P2 | manual |
| Fix MANUAL.md claims contradicted by tracker/code | bug | P2 | manual |
| Audit never-examined young surfaces (api/search, tokens, admin announce/referral/flags) | task | P2 | coverage |
| Progressive disclosure of xpub/derivation/descriptor | task | P3 | a |
| SQLite index audit + 100k-row query benchmarks | task | P3 | d |
| Wallet→explorer links honor the explorer flag | bug | P3 | e |
| MANUAL.md §15 untracked TODOs umbrella | task | P3 | hygiene |
| Remove empty vaults/ route skeletons | task | P3 | hygiene |

*Dropped as already covered:* fiat plumbing (cairn-zoz8.18), sync-engine perf (cairn-wcxw et al.), heavy-wallet truncation (cairn-kxhv), Electrum robustness (gakd/afdy/32kh/sp74), requireUser sweep (cairn-wqkk), CSV injection fix (b1rg/mf68), multisig funnel (cairn-hla1), Umbrel env seeding (cairn-5pov), auto-admin device pass (cairn-49xi.4 — the new probe pass is distinct and complementary).
