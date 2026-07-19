# Hash-Attraction Strategy — Heartwood

**Date:** 2026-07-19
**Status:** STRATEGY (Session 3, hash-attraction audit)
**Inputs:** docs/COINBASE-PAYOUT-POOL-DESIGN.md, docs/COINBASE-POOL-ANALYSIS.md, docs/MINING-POOL-SCOPE.md, docs/FEDERATION-SCOPE.md, docs/DIFFICULTY-RAFFLE-ANALYSIS.md; two deep-reasoning passes (skeptical-miner framing; flywheel-architect framing); web research 2026-07-19 (sources at end).

> **Legal gate.** ALL coinbase-split payout-pool implementation is gated on **cairn-l1zu.1** (the `cairn-vn43.14` reversal decision). Strategy and docs are fine; every payout-pool implementation bead carries the gate. Roadmap items #1–#6 below are deliberately scoped so **no coinbase value moves** and are therefore NOT gated on l1zu.1 (item #6 is infra-gated on cairn-cz3q).

---

## 1. Positioning statement

**Heartwood does not win as a pool. It wins as the sovereign mining stack — and, later, as the federation.**

For any miner seeking income, incumbent pools win on the only axis that matters to them: variance smoothing. 1 TH/s earns ≈$11.3/yr in EV at any pool of any size (COINBASE-POOL-ANALYSIS §8) — a pool changes *variance*, not *yield* — and FPPS pools absorb 100% of that variance as an insurance product. Heartwood pays nothing until block-find; a 500 TH/s instance finds a block every ~32 years. We cannot out-smooth Foundry, and we should stop implying we can.

What survives the skeptic is a different, genuinely winnable product: **"solo mining on your own node, with your friends."** Your own full node builds your own templates; your own coinbase pays your own wallet directly (per-connection coinbase — the miner IS the payout, zero custody at any point, shipped v0.2.34); your stats, odds, and leaderboard live in the command center you already run. Mining is a $0-CAC feature of Heartwood, not a destination pool — and for the fast-growing home-miner lottery segment (40+ solo blocks via ckpool since mid-2023; 22 verified solo blocks in 2025; Bitaxe wins of ~$258k and ~$310k; 4 blocks found by self-hosted Public Pool instances on Umbrel), sovereignty + verifiable fairness + a social leaderboard is exactly what the incumbents structurally cannot offer.

The vision's network-effect loop — "more users → more hash → more blocks → more attractive" — is **false at the instance level**: each Heartwood instance is a separate pool, and instances do not combine hash until federation ships. The honest loop is staged: **users → distribution → (federation-enabled) aggregation → hash.** Pre-federation, the flywheel is distribution + engagement + content (§7). Post-federation, invite-gated trust-pods aggregate hash toward human-scale block cadence — the only point where the original sentence becomes literally true.

## 2. The market: why miners choose pools

- **Payout model & variance tolerance** dominate: FPPS (Foundry, Antpool, F2Pool, Braiins) = smooth daily pay, operator absorbs variance — the default for anyone covering power bills. FPPS requires large custodial treasuries; smaller pools lack reserves to absorb bad luck [simplemining.io].
- **Fees:** Ocean 2% (1% with DATUM), Braiins 2–2.5% FPPS, F2Pool 4% FPPS, ViaBTC 4% PPS+, solo.ckpool 2%, Public Pool 0% [sources below].
- **Minimum payouts gate small miners:** Ocean 0.01048576 BTC on-chain threshold (Lightning below it; discretionary payouts above 0.00065536 BTC on exit); F2Pool 0.001 BTC; Braiins 0.0002 BTC; ViaBTC 0.0001 BTC. At Bitaxe scale most thresholds mean months-to-years before first payout — balances sit custodially meanwhile.
- **Trust & transparency:** 0xB10C's stratum-work research found Antpool-identical templates across BTC.com, Binance Pool, Poolin, EMCD, Rawpool — an FPPS-insurance "pool of pools" with rewards routed through Bitmain custodial infrastructure; Antpool+proxies ≈40% of network hash through 2024, plus Foundry ≈30% → two entities directing template construction for ~70% of blocks [tftc.io, nobsbitcoin.com]. Ocean's TIDES/DATUM exists precisely to sell verifiability against this backdrop.
- **The solo-lottery segment is real and growing:** solo.ckpool has 40+ verified block wins since mid-2023 (3 in early 2026); 22 verified solo blocks in 2025; every win is a press story (Bitaxe Supra ~480 GH/s won block 887,212, ~$258k, Mar 2025; six Bitaxe Gammas won block 924,569, ~$310k, Nov 2025; a Bitaxe Gamma won block 957,382, ~$200k, Jul 2026 — via Public Pool) [d-central.tech, solosatoshi.com, bitcoinfoundation.org].
- **Self-hosting demand is proven:** Public Pool ships as a one-click Umbrel/Start9 app; all 4 of its confirmed block finds came from self-hosted instances on Umbrel ("Public Pool on Umbrel" coinbase tags) [apps.umbrel.com, blockdyor.com]. Ocean's DATUM (self-hosted template building, 50% fee discount) monetizes the same instinct [ocean.xyz].

## 3. Target-miner segments

| Segment | Hash | What they buy | Verdict for Heartwood |
|---|---|---|---|
| **Home/hobby (Bitaxe, Apollo, S9)** | 0.5–10 TH/s | Lottery ticket + sovereignty + fun; income is irrelevant (≈$11/yr/TH EV) | **Primary target.** Already node-curious; Umbrel distribution reaches them at $0 CAC; leaderboard + verifiable odds beat ckpool's bare lottery. |
| **Small farm** | 10–500 TH/s | A paycheck to cover power → FPPS smoothing | **Not winnable for income** (500 TH/s → ~32-yr cadence). Winnable only as the sovereignty slice of their hash, or post-gate as friends-and-family split-mode groups. |
| **Mid-tier** | 1–100 PH/s | SLAs, redundancy, SV2, smoothing | **Not our buyer today** — the segment where the economics finally work (≥1 PH/s operator floor; blocks in 1.7 yr–62 d at 10–100 PH/s) is precisely the one that will not run a hobbyist stack. Stratum reliability (#5) is the credibility floor if this ever changes; SV2 is deferred. |

## 4. Competitive comparison

| Pool | Fee | Model | Min payout | Custody | Weakness (for our segments) |
|---|---|---|---|---|---|
| Foundry USA | tiered (unpublished) [needs citation] | FPPS | n/a | Custodial | Institutional/KYC-only; closed to home miners |
| Antpool | 2.5% FPPS / 1.5% PPLNS [needs citation — support page] | FPPS | low | Custodial | Proxy-pool template hub; weak fee transparency [tftc.io] |
| F2Pool | 4% | FPPS | 0.001 BTC | Custodial | High fee + highest threshold for small miners |
| ViaBTC | 4% | PPS+ | 0.0001 BTC | Custodial | High fee; ~13% hash concentration |
| Braiins | 2–2.5% | FPPS | 0.0002 BTC | Custodial | Custodial; firmware tie-in is its moat, not miner sovereignty |
| Ocean | 2% / 1% DATUM | TIDES (non-custodial coinbase above threshold) | 0.01048576 BTC on-chain | Non-custodial above threshold; carry-forward ledger below | Threshold = de-facto custody for small miners; template-filtering reputation; still someone else's infrastructure |
| solo.ckpool | 2% | Solo, finder-takes-~98% | n/a (block only) | Non-custodial | Zero smoothing, zero social layer, zero self-host UX, no node of your own |
| Public Pool (self-host) | 0% | Solo | n/a | Non-custodial | Hobby-grade ops; bare stats; no wallet/command-center integration |
| **Heartwood (today)** | **0%** | **Multi-user solo, per-connection coinbase** | **n/a — coinbase pays you directly** | **Zero custody ever** | Solo variance; single-node reliability; no cross-instance aggregation until federation |

Structural gap Heartwood occupies: **polished, self-hosted, wallet-integrated, non-custodial, small-miner-first** — the Umbrel/public-pool niche done as a first-class product with a social/verifiable layer, and (post-gates) the only path from solo-lottery to friends-scale smoothing that never touches custody.

## 5. Heartwood's structural edges (ranked by what survives skepticism)

1. **Zero custody, on your own node, by construction.** The coinbase pays the finding miner's own wallet; there is no operator balance, no threshold ledger, no carry-forward (MINING-POOL-SCOPE doctrine; COINBASE-PAYOUT-POOL-DESIGN §1). Ties Ocean/ckpool at their best, beats every FPPS treasury and even Ocean's sub-threshold ledger. Legally load-bearing (COINBASE-POOL-ANALYSIS §7: favorable side of FIN-2019-G001's four-factor test).
2. **$0-CAC bundling.** Mining is one click inside a command center the user already runs for wallet + node + explorer. Nobody else's pool is a feature of the user's own sovereignty stack.
3. **Verifiable fairness as product.** Per-connection templates mean the winning share is self-attributing PoW; the pot-free best-share leaderboard (DIFFICULTY-RAFFLE-ANALYSIS §f) makes every position independently checkable — a transparency story Ocean sells and we can exceed at home scale, with no legal gate.
4. **The (gated) between-wins trickle.** Split mode keeps the jackpot (finder ≥40–50%) and adds a leaderboard trickle ckpool lacks, with hopping EV-neutral-to-negative by finder-forfeit (COINBASE-POOL-ANALYSIS §4.4) — conditional on work-proportional split (C-1) and on cairn-l1zu.1.
5. **The federation option.** Invite-gated Tor federation (FEDERATION-SCOPE; PAYOUT-DESIGN §14 as corrected by ANALYSIS §6) is the only mechanism by which self-hosted instances ever aggregate hash — no incumbent can offer "your pods' pooled odds without anyone custodying anything."
6. **Halving-proof, percentage-only payout design** — no BTC-denominated constants anywhere (PAYOUT-DESIGN §1).

## 6. Honest weaknesses & mitigations

| Weakness | Reality | Mitigation |
|---|---|---|
| Solo variance, no smoothing | Nothing pays until block-find; 1 TH/s ≈ $11.3/yr EV realized as a decades-lump | Never sell income (anti-hype doctrine: odds displayed as years-per-block, never earnings projections — MiningOddsPanel/soloOdds is deliberate). Sell sovereignty + lottery + leaderboard. |
| Broken pre-federation loop | More users = more separate instances; hash does not combine | Reframe positioning (#cairn-g7eqi); build the money-free federation rail (#cairn-34epf) before any payout federation. |
| ≥1 PH/s operator-viability floor; ~17 PH/s for sub-1-yr cadence | The 2% fee covers a $20/mo node only above ~1 PH/s; F&F pools run at a loss on fees (ANALYSIS C-7) | State it plainly in product and docs; the operator fee is cost-recovery, not a business; pods mine for sovereignty. |
| Single-node reliability | One flaky listener churns any serious miner | Stratum hardening + uptime surfacing (#cairn-54m1q). |
| Invite-gate vs open growth | Sybil resistance requires invite-gated admission (ANALYSIS C-5), which caps federations at trust-pod scale — loop (a) saturates; it will not organically assemble 17 PH/s | Accept: many small pods, not one open pool. Growth compounds on instances and activated hash, not on one pool's size. |
| Small instances earn ~no fee ever | 50 TH/s instance: 73% chance of zero fee revenue after 100 years (ANALYSIS C-6) | Never promise operator income; sovereignty framing only. |

## 7. The network-effect flywheel (staged, honest)

**Stage 0 — pre-gate, pre-federation (NOW):** Distribution + engagement + content. One-click Umbrel install + Bitaxe guide (#cairn-8tfek) → activated miner → leaderboard (#cairn-192dr) and public stats page (#cairn-19o5e) retain and evangelize → a lucky solo block → verifiable press kit (#cairn-7msai) → installs. Compounds on **installs and activated hash**; moves no money; entirely outside l1zu.1. Within an instance there is no hash network effect — this stage compounds *distribution*, and that is fine.

**Stage 1 — post-legal-gate (l1zu.1):** Single-instance split mode adds the between-wins trickle and the finder-% loyalty anchor (hop penalty = f·φ). Deepens retention for F&F groups; economics honest only ≥1 PH/s. No new loop — a better Stage 0.

**Stage 2 — post-federation (cz3q + l1zu.22 + §14 corrections):** The meta-leaderboard closes the loop the vision promises: pods aggregate hash → human-scale cadence → pointing hash at any member instance gets more attractive → more members. Hash-hopping toward the best instance is a declared feature (owner decision 10). Capped at pod scale by invite-gating — by design.

**KPI:** north star = **aggregate TH/s pointed at the Heartwood fleet**. Unmeasurable centrally today (no phone-home); proxy = **activated mining instances** (#cairn-qqmbq); true fleet measurement arrives only as opt-in telemetry on the no-payout federation rail (#cairn-34epf).

## 8. Prioritized roadmap (expected hash attracted per unit effort)

| # | Item | Effort | Gate | Bead |
|---|---|---|---|---|
| 1 | Verifiable best-share leaderboard (no pot) | S–M | none | cairn-192dr |
| 2 | Public read-only stats page (opt-in; coordinate with the "blocks this house has found" explorer-ledger candidate — reference, don't duplicate) | S | none | cairn-19o5e |
| 3 | Bitaxe/home-miner onboarding + wizard polish | S | none | cairn-8tfek |
| 4 | Solo-win celebration + verifiable press kit | S | none | cairn-7msai |
| 5 | Stratum reliability/failover hardening | M | none | cairn-54m1q |
| 6 | No-payout leaderboard federation (bragging rights; the aggregation + KPI rail) | L | cairn-cz3q (infra); legally outside l1zu.1 — obtain legal sanity note anyway | cairn-34epf |
| 7 | Positioning reframe ("solo mining on your own node, with your friends") | S | none | cairn-g7eqi |
| 8 | Flywheel KPI instrumentation (activated instances) | S | none | cairn-qqmbq |
| 9 | Single-instance coinbase-split mode | L | **cairn-l1zu.1** | existing epic cairn-l1zu (.2–.21; C-1 work-prop default per ANALYSIS A-1) |
| 10 | Federation payout mode (meta-board) | XL | **cairn-l1zu.1 + cairn-cz3q + §14.7 open questions** | existing cairn-l1zu.22 |

Items 1–8 are new [hash-strategy] beads filed by this session; items 9–10 map to the existing cairn-l1zu epic and are listed for completeness — no duplicate beads filed.

## 9. Legal gate note

Every payout-pool item (#9, #10) is blocked on **cairn-l1zu.1** (P0, open): reversal of the cairn-vn43.14 no-splitting gate requires Alex's decision plus counsel review (ANALYSIS §7: F&F/single-jurisdiction is low-risk; stranger-facing multi-state MTL is the real dial; operator fee is taxable income regardless). Items #1–#8 move no coinbase value and are not gated; item #6 additionally warrants a legal sanity note despite moving no money. Nothing in this strategy authorizes crossing the gate.

## Sources

Market claims researched 2026-07-19. Repo-internal claims cite the docs inline.

- Ocean TIDES/fees/minimum: https://ocean.xyz/docs/tides ; https://d-central.tech/ocean-mining-pool-guide/
- Fee/minimum comparison (Braiins, F2Pool, ViaBTC): https://academy.braiins.com/braiins-pool/rewards-and-payouts ; https://d-central.tech/bitcoin-mining-pool-comparison-2026/ ; https://www.spark.money/tools/bitcoin-mining-pool-comparison ; https://www.simplemining.io/insights/post/best-bitcoin-mining-pools
- solo.ckpool + solo block wins: https://solo.ckpool.org/ ; https://www.solosatoshi.com/best-solo-mining-pool/ ; https://d-central.tech/bitaxe-block-wins/ ; https://bitcoinfoundation.org/news/bitcoin-mining-news/solo-miner-success/
- Public Pool (self-hosted, Umbrel): https://apps.umbrel.com/app/public-pool ; https://blockdyor.com/public-pool-review/ ; https://bitcointalk.org/index.php?topic=5536109.0
- Pool centralization / Antpool proxies (0xB10C, Corallo): https://www.tftc.io/bitcoin-mining-pool-centralization/ ; https://www.nobsbitcoin.com/bitmain-antpool-pool-of-pools-report/
- FPPS treasury/variance economics: https://www.simplemining.io/insights/post/a-guide-to-bitcoin-mining-pool-payouts
- Items marked [needs citation] were not verifiable in the research time-box and should be confirmed before external use.

*End of strategy document.*
