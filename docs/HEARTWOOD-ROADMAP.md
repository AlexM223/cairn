# Heartwood Roadmap — 2026-07-19

Status: living document. Written by the Roadmap & Strategy session 2026-07-19; cross-references the beads backlog (`br show <id>` for any ID below). Companion docs: [UX-PSYCHOLOGY-NOTES.md](UX-PSYCHOLOGY-NOTES.md), [COMPETITOR-ANALYSIS.md](COMPETITOR-ANALYSIS.md).

---

## 1. Current state (as of v0.2.41, v0.2.42 shipping today)

**Product**: Heartwood (formerly Cairn) — a self-hosted Bitcoin wallet suite + multi-user SOLO mining pool + block explorer, packaged for Umbrel. Positioning: **"solo mining with friends"** (see HASH-ATTRACTION-STRATEGY.md).

**What's built:**

- **Wallet**: single-sig + multisig (BIP-48, Caravan-compatible round-trip), hardware signing (Trezor / Ledger / BitBox02, WebUSB via self-signed HTTPS), RBF + CPFP on a generic feeBump engine, unconfirmed spends, sub-1 sat/vB, collaborative custody (owner / viewer / cosigner tiers), per-user SMTP notifications, announcements + referrals, account data export/deletion, scheduled backups, API tokens.
- **Mining**: multi-user SOLO pool (epic cairn-vn43) — in-process stratum v1 engine, per-connection coinbase (each miner's reward pays directly to their own wallet; no custody ever), worker tracking, per-user hashrate history. v0.2.42 adds: best-share leaderboard (cairn-20k25), public pool stats (cairn-et38g), explorer block celebration, dual stratum ports 3333 low-diff / 3334 high-diff for ASICs (cairn-pz8v5), plus the P1 fixes below.
- **Explorer**: full block/tx explorer on local Bitcoin Core + Electrum (Esplora dependency removed — epic cairn-zoz8; Umbrel installs never dial third-party APIs), BlockContext tx visualization, live SSE updates everywhere (single `/api/live` stream, epic cairn-wmty — polls dead).
- **Platform**: dual auth (Umbrel password mode + standard), solo mode (instanceMode), feature-flag registry, pino observability (/admin/logs, /activity), instance-secrets encryption, data-retention seams, native regtest QA stack (no Docker, electrum-shim.mjs), `qa:route-crawl` + `qa:notif-deeplink` release gates (manual pre-release — **not yet in CI**, nor is the prod-boot smoke test that would have caught the v0.2.36 outage class).
- **Non-negotiable invariants** (MANUAL §1): server never holds private keys; PSBTs commitment-checked byte-for-byte pre-broadcast; Electrum data SPV-verified before payment notifications (fails closed); never `await` inside open SQLite transactions; `initReady` gates all requests until boot completes. Roadmap items must not erode these.
- **Design**: DESIGN-MANIFESTO.md doctrine (evergreen-ink, slate signal-blue, green = growth-only, Fraunces hero serif, sats-first) — implementation epic cairn-sdx5 OPEN; it superseded both the copper identity and the explorer-only redesign (cairn-6efi CLOSED as superseded).

**Version & distribution**: package.json 0.2.41; v0.2.42 shipping today (sibling session, in flight at time of writing). Umbrel store (AlexM223/heartwood-app-store, app `heartwood-bitcoin`) lags at 0.2.41-pending. `main` branch is stale at v0.2.7 — release lineage is `design/evergreen-identity` (operational hazard, see §6).

**Tests**: 4,094 vitest tests (4,084 passing, 9 failing in 4 files at snapshot time — in-flight v0.2.42 work on this shared branch, e.g. sendBoundaryMatrix2.test.ts; expected green at tag time).

**Backlog**: 1,105 beads; 200 open, 26 dep-blocked, 9 open epics: l1zu (coinbase payout), wmty (live updates — mostly landed), sdx5 (visual identity), gt05 (UX redesign), 6xxa (perf re-architecture), zoz8 (Esplora removal — mostly landed), 49xi (Umbrel auto-admin), vn43 (solo mining MVP — shipped, gate bead open), cz3q (federation). Closed-as-done epics worth knowing: cairn-ivae (admin parity vs Gitea/Nextcloud — all 6 units shipped), cairn-6efi (explorer redesign — superseded by sdx5).

---

## 2. Short-term (next 2 weeks)

Theme: **land the excitement layer, close the store gap, burn down the audit-wave P2s.**

| Item | Beads | Status |
|---|---|---|
| Five pool P1 fixes: /mining silent blanking, explorer pool-blind, admin-only stats, hidden best-share, unreachable stratum default | cairn-et5a0, cairn-r1hca, cairn-et38g, cairn-20k25, cairn-bm7c2 | v0.2.42, in flight today |
| Dual stratum ports (3333 low-diff / 3334 high-diff ASIC) | cairn-pz8v5 | v0.2.42, in flight today |
| Umbrel store update 0.2.41 → latest (one PR can cover multiple versions, per 0.2.36→41 precedent) | — (process; umbrel-update-app skill) | pending v0.2.42 tag |
| Coinbase classification fail-open (immature 50 BTC shown spendable) — **money-correctness bug** | cairn-8lwa6 | open P2, priority |
| Split-brain network warning (mining RPC vs wallet chain source) | cairn-4nvuq | open P2 |
| Wallet-pool integration P2s: duplicate finder notifications, missing "spendable now" notification, block-found amount display, /mining spendable overstatement, Home immature-coinbase inclusion, mining-reward tx identity, "ours" badge on explorer index | cairn-eu7el, cairn-9ukbn, cairn-lomlh, cairn-e176o, cairn-25ges, cairn-i0d0q, cairn-f44vg | open P2s |
| Pool UX P2s: rejected-share visibility/efficiency %, block-found + worker-offline notification defaults, per-user hashrate chart | cairn-bduog, cairn-6w1qp, cairn-2pgy5 | open P2s |
| Backup-nudge escalation when mining payout wallet is unbacked (loss-aversion moment — see UX-PSYCHOLOGY-NOTES.md) | cairn-tngdk | open P2 |
| Stratum reliability hardening (watchdog, reconnect UX, uptime) + Bitaxe onboarding guide | cairn-54m1q, cairn-8tfek | open P2s |
| Positioning reframe in-product: "solo mining on your own node, with your friends" — kill "pool" framing | cairn-g7eqi | open P2 |
| Hash-attraction Stage 0 remainder (all legally un-gated): public stats page, verifiable best-share leaderboard, press kit / block-celebration content, KPI instrumentation | cairn-19o5e, cairn-192dr (dupe of cairn-vtsni — dedupe), cairn-7msai, cairn-qqmbq | open P2s |
| Backup-nudge decay cadence + first-deposit confidence UX — implementation-ready specs in UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md | cairn-gt05.5, cairn-gt05.6 | spec'd, ready to build |
| Regtest e2e live-block confirmation (owed since v0.2.35) | cairn-lk7h | open, needs Docker-capable box |
| MANUAL.md header still claims branch `single-sig-full-wallet` @ 2026-07-12 — reconcile with release lineage | cairn-g94xd | open |
| Wire qa:route-crawl / qa:notif-deeplink / prod-boot smoke into CI | cairn-k81jl | open |
| BIP-329 label export/import (top table-stakes gap vs Sparrow, per competitor R3) | cairn-3wo2d | open |

**Definition of done for the fortnight**: store serves latest version; a Bitaxe owner can go from install → mining → seeing their best share celebrated without touching a config file; no money-display bug (8lwa6, 25ges, e176o) remains open.

## 3. Medium-term (1–3 months)

1. **Coinbase-payout pool mode (Ocean-style split)** — epic cairn-l1zu, design canonical in COINBASE-PAYOUT-POOL-DESIGN.md, economics in COINBASE-POOL-ANALYSIS.md (+ ADDENDUM-2026-07-19). **ALL implementation is BLOCKED on the legal gate cairn-l1zu.1 (P0)** — Alex must document a legal decision reversing cairn-vn43.14's single-output rule for this specific non-custodial mode. The counsel deliverable already exists: **COUNSEL-QUESTION-PACKAGE-L1ZU1-2026-07-19.md** — the fastest unblock on the whole roadmap is Alex sending it to counsel. Implementation beads are fully decomposed and ready (l1zu.3–.12, QA gate l1zu.17); economics decision beads l1zu.19/.20/.21 (finder %, pot distribution, m_min sybil lever) can be decided in parallel with counsel review; note the analysis's C-1 correction — default should be work-proportional split, not equal split. Also owed: re-create the Monte-Carlo sims as checked-in code (cairn-l1zu.23 — the analysis's numbers are currently non-reproducible). Ship posture already agreed: off-by-default, operator legal-ack gate, miner opt-in.
2. **Federation P2P (instance-to-instance PSBT coordination)** — epic cairn-cz3q, ~20 open children in dependency-ordered waves A (identity/transport, cz3q.5–6) → B (peering/invites, .7–.10) → C (vault manifests + recovery-kit gate, .13–.15) → D (federation PSBT endpoints + cosigner UX, .16–.19) → E (watcher + sneakernet fallback, .20–.21). Security gates F1/F4/F12 from FEDERATION-SCOPE.md are hard requirements; decision cz3q.27 (onion-spike outcome → app-layer encryption in MVP?) blocks the transport wave. Federation is also the strategic unlock for hash attraction (§6, market risk) and the coinbase-pool OP_RETURN tag (l1zu.5) — sequence it to start as soon as cz3q.27 is decided.
3. **UX redesign phases 2–4** — epic cairn-gt05 per UX-REDESIGN-SPEC.md: Phase 2 Send fee-line + wallet detail (gt05.2), Phase 3 Settings grouping + Admin→Health (gt05.3), Phase 4 Navigation rewrite + Explorer de-jargon (gt05.4, deliberately last). Runs alongside the evergreen visual identity epic cairn-sdx5 (which absorbed the explorer redesign). R2 color doctrine and R9/R5 doctrine decisions from Alex unblock parts of this.
4. **Explorer elevation** — remaining post-6efi items (6efi.10 visual research follow-up, 6efi.13 BTC precision rounding) + pool-awareness follow-through: trophy-wall permanence, "found by this pool" depth (builds on r1hca/f44vg).
5. **Perf re-architecture** — epic cairn-6xxa (dashboard/portfolio, derivation, sync engine). The sync-SQLite event-loop cliff (cairn-qyvl; xlrm closed but the architecture remains) caps multi-user pool ambitions; do the async/worker split before marketing pushes concurrency up.
6. **Tech debt with money-risk**: unify buildDraft/broadcast behind the feeBump spec engine (cairn-rg99) — the copy-pasted broadcast-claim UPDATE is "the most dangerous line in the codebase to have two of"; do it before CPFP forks it a third time.
7. **Umbrel auto-admin** — epic cairn-49xi (scoped); pairs with Start9 packaging prep (START9-PLAN.md, scoping only; StartOS's per-server root CA may fix the WebUSB/HTTP hazard cairn-4b2b — verify on hardware first).
8. **Competitor table-stakes** (from COMPETITOR-ANALYSIS-R3-2026-07-19.md): Taproot spend support (cairn-ctl6w — epic-sized, design doc first), SV2 translation-proxy compatibility statement (cairn-ng3kl — cheap hedge; ~75% of hashrate joined the SV2 working group, firmware-default SV2 projected end-2026), UX-psychology feature wave (cairn-hz1wt, momdr, udqzi, 0dxvi, jc2lb).

## 4. Long-term (3–6 months)

- **Competing as a real pool alternative.** COINBASE-POOL-ANALYSIS.md puts the viability floor at **≥1 PH/s** aggregate (operator fee covers a ~$20/mo node) and **~17 PH/s** for sub-1-year block cadence; 1 TH/s earns ~$11.3/yr EV at ANY pool size, so a single instance of hobbyist miners never reaches viability. The path is: coinbase-payout mode (legal-gated) → federation transport (cz3q; the no-payout federation rail cairn-34epf can start pre-gate) → **federated hash aggregation** across instances (HASH-ATTRACTION-STRATEGY.md Stage 2 meta-leaderboard; note analysis correction C-5 — invite-gating of instanceIds is the load-bearing sybil defense). Until then, the honest sell is lottery-style solo mining with social features — the strategy doc is explicit that the hash-attraction flywheel is FALSE at instance level.
- **Settlement-credit network** (federation end-state): instance-to-instance netting/credit for shared block rewards — depends on federation waves A–E complete, F-gates passed, and the legal posture from l1zu.1 extended to cross-instance settlement (a second, harder legal question — treat as a separate future gate, do not assume l1zu.1 covers it).
- **Start9 distribution** — execute START9-PLAN.md once Umbrel store cadence is stable and auto-admin (49xi) removes the manual-setup tax.
- **Difficulty raffle** — DIFFICULTY-RAFFLE-ANALYSIS.md verdict is adopt-with-conditions; the conditions overlap heavily with l1zu.1's legal posture. Park until the coinbase-payout mode has shipped and survived contact with operators.
- **Tessera relicensing/integration** — Tessera is GPL-3.0, Alex-owned; decide whether pool engine work upstreams there or stays in-repo (see decision gates).

## 5. Decision gates (everything waiting on a human)

| Gate | Owner | Blocks | Bead |
|---|---|---|---|
| Legal review: coinbase splitting + operator fee output (reverses vn43.14 for this mode). **Counsel question package is ready to send**: COUNSEL-QUESTION-PACKAGE-L1ZU1-2026-07-19.md | Alex + counsel | ALL of epic cairn-l1zu (17+ impl beads), difficulty raffle adoption, long-term pool strategy | **cairn-l1zu.1 (P0)** |
| Multi-user/shared-reward hard gate (parent rule) | Alex | any shared-reward mode beyond per-connection solo | cairn-vn43.14 |
| Finder % default (econ says 40%, Alex proposed 50%) | Alex | l1zu payout config | cairn-l1zu.19 |
| Top-N pot distribution: equal vs work-proportional (econ strongly favors proportional) | Alex | l1zu payout engine | cairn-l1zu.20 |
| m_min share-count qualification (sybil lever) | Alex | l1zu leaderboard | cairn-l1zu.21 |
| Onion spike outcome → app-layer encryption in federation MVP? | Alex | federation wave A transport | cairn-cz3q.27 |
| Federation security gates F1/F4/F12 | Alex/security review | federation waves B–E ship | FEDERATION-SCOPE.md |
| R2 color doctrine; R9/R5 UX doctrine (brief: DECISION-BRIEF-R5-R8-R9.md; amendments: DESIGN-MANIFESTO-AMENDMENTS-2026-07-19.md) | Alex | parts of sdx5 + gt05 phases | (doctrine docs, no beads) |
| Send-flow USD-default indicator | Alex (small UX call) | send-flow polish | cairn-4vh2 |
| Tessera GPL-3.0 licensing direction (relicense/vendor; upstream pool engine vs in-repo) | Alex | long-term pool code home | cairn-vn43.19 |
| Store update approval cadence (store PRs are manual) | Alex | distribution latency | — (process) |

## 6. Risk register

| Risk | Class | Notes / mitigations | Refs |
|---|---|---|---|
| Pool payouts = money-transmission / gambling exposure. Operator-set third-party payout percentages + fee output is pool-operator posture even without custody; raffles add consideration+chance+prize | **Legal (highest)** | Non-custodial architecture is the core defense; ship off-by-default + operator legal-ack + miner opt-in; do NOT let implementation momentum leak past the gate | cairn-l1zu.1, vn43.14, COINBASE-PAYOUT-POOL-DESIGN.md legal § |
| Sync SQLite blocks the event loop → concurrency cliff under multi-user pool load | Technical | Perf epic 6xxa; async/worker split before promoting concurrency | cairn-qyvl, cairn-6xxa |
| Wallet code duplication: broadcast-claim UPDATE copy-pasted across single-sig/multisig — divergence is a money-losing bug class | Technical | cairn-rg99 sequence: extract engine → unify → only then build new spend features | cairn-rg99 |
| Coinbase classification fails open (immature shown spendable) — users could act on unspendable balance | Technical/money | Fix in short-term window | cairn-8lwa6, 25ges, e176o |
| Hash-attraction flywheel is FALSE at instance level: more miners on one instance = each miner's solo odds unchanged, no network effect until federation | Market | Honest positioning ("solo mining with friends", not "join our pool"); federation is the real unlock; don't market a flywheel that doesn't exist | HASH-ATTRACTION-STRATEGY.md, cairn-g7eqi |
| Uniqueness claim is narrower than assumed: Public Pool (self-hosted, 0% fee, on Umbrel) already does multi-address solo with coinbase-to-your-address; new 2026 entrant "BASED Mining Pool" is close in motion | Market | Sell the INTEGRATION ("the only pool where the block reward lands in a wallet the same app manages"), never "only multi-user solo pool"; fold into cairn-g7eqi copy | COMPETITOR-ANALYSIS-R3-2026-07-19.md |
| Umbrel store lag (0.2.41-pending vs today's 0.2.42): users judge the store version | Operational | Batch store PRs; store-update-per-release discipline | cairn-kf135, cairn-s33a (legacy store at v0.2.9) |
| `main` branch stale at v0.2.7 while releases cut from design/evergreen-identity — confuses contributors, breaks "PRs to main" convention, and pre-filter-repo branches re-import stripped blobs on merge | Operational | Either fast-forward main to release lineage (with the range-limited filter-repo recipe) or document the lineage in README/MANUAL | cairn-t5a5z, v0.2.18 ship notes |
| Prod-boot phantom-dep class (v0.2.36 outage): CI smoke test still not wired; qa:route-crawl and qa:notif-deeplink gates are manual-only | Operational | Audit done (luqs closed, one phantom fixed); add `node server.mjs → app ready` + both QA gates to CI | cairn-luqs (closed), CI bead in §7 |
| Coinbase-pool economics rest on Monte-Carlo sims whose code was never checked in — numbers currently non-reproducible | Analytical | Re-create sims as committed scripts before any l1zu parameter is finalized | cairn-l1zu.23 |
| MANUAL.md header documents branch `single-sig-full-wallet` @ 2026-07-12 while releases cut from design/evergreen-identity — the "manual disagreement = bug" doctrine is undermined by its own header | Operational | Reconcile header + drift pass | bead in §7 |
| Single-maintainer bus factor + legal entity: pool operation invites scrutiny at exactly the moment the project depends on one person | Operational/legal | Out of scope for engineering; flag for Alex | — |

## 7. Beads filed by this session (all verified with `br show`)

| Bead | What |
|---|---|
| cairn-g94xd (P3) | Reconcile MANUAL.md stale branch header with release lineage |
| cairn-k81jl (P2) | Wire qa:route-crawl / qa:notif-deeplink / prod-boot smoke into CI |
| cairn-t5a5z (P2) | Resolve main-branch staleness (main at v0.2.7) |
| cairn-kf135 (P2) | Umbrel store update to v0.2.42 once tagged |
| cairn-hz1wt (P2) | Best-share context line + personal-best celebration (memoryless gloss) |
| cairn-momdr (P3) | Community solo-wins feed card on /mining |
| cairn-udqzi (P3) | Cumulative work + "your odds so far" panel |
| cairn-0dxvi (P3) | Worker identity cards (name/hardware/first-seen/best share) |
| cairn-jc2lb (P3) | Uptime streak with graceful lapse, no guilt mechanics |
| cairn-fx5ps (P3) | Adopt honest-mechanics doctrine table into DESIGN-MANIFESTO.md |
| cairn-9la2f (P3) | Legal placeholder: cross-instance settlement is a SEPARATE gate from l1zu.1 |
| cairn-3wo2d (P2) | BIP-329 label export/import |
| cairn-ng3kl (P3) | SV2 translation-proxy compatibility test + support statement |
| cairn-ctl6w (P2) | Taproot SPEND support (epic-sized; design doc first) |

Housekeeping: closed cairn-vtsni as duplicate of cairn-192dr.

## 8. Research companions

- **UX psychology** (what makes hobbyist mining sticky, ethically): [UX-PSYCHOLOGY-NOTES.md](UX-PSYCHOLOGY-NOTES.md) (new, this session; builds on UX-PSYCHOLOGY-RESEARCH R1–R3). Headlines: solo mining is a *natural* variable-ratio schedule — surface what's true, manufacture nothing; best shares are genuine, PoW-verifiable near-misses (Clark et al. 2009) but must carry a "memoryless" gloss; leaderboards motivate only against similar peers → weekly windows + luck-normalized view for cairn-192dr; loss-aversion framing is honest ONLY where loss is real (backup nudges yes, streak-guilt no); "your odds so far" is honest endowed progress. Top proposals (S-effort first): best-share context line + personal-best moment, community solo-wins feed card, cumulative-odds panel, worker identity cards, uptime streak with graceful lapse; plus adopting the honest-mechanics table into DESIGN-MANIFESTO.md as doctrine.
- **Competitive landscape**: [COMPETITOR-ANALYSIS-R3-2026-07-19.md](COMPETITOR-ANALYSIS-R3-2026-07-19.md) (new, this session; delta over R1/R2). Verdict: the "full wallet + multi-user solo pool + explorer in one self-hosted app" claim HOLDS as an integration claim, but the pool mechanic alone is NOT unique (Public Pool). Top gaps: Taproot spend (cairn-ctl6w), Stratum V2 (cairn-ng3kl hedge), BIP-329 labels (cairn-3wo2d), variance smoothing (strategically scoped out — OCEAN sells "sovereign AND paid" at 1%), fleet-monitoring depth (partially answered by worker identity cards cairn-0dxvi). Prior rounds: [COMPETITOR-ANALYSIS.md](COMPETITOR-ANALYSIS.md), [COMPETITOR-ANALYSIS-R2-2026-07-19.md](COMPETITOR-ANALYSIS-R2-2026-07-19.md).
