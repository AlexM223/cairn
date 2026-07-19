# Coinbase-Payout Mining Pool — Research Analysis

**Status: RESEARCH ANALYSIS of `docs/COINBASE-PAYOUT-POOL-DESIGN.md`**
Date: 2026-07-18
Implementation remains gated on the `cairn-vn43.14` legal decision.

**Simulation provenance (read this before citing any number below).** The Monte-Carlo
results throughout this analysis (§3, §5, §6) were produced by scratchpad code — `sims\`
(single-instance economics: `common.py`, `sim1_share_model.py`, `sim2_distributions.py`,
`sim3_finder_sweep.py`, `sim4_edge_cases.py`, `sim5_economics.py`) and `fed-sims\`
(federation: `timescale_fee.py`, `sybil.py`, `splitting_incentive.py`), numpy 2.5.1 / scipy
1.18.0, Python 3.13. **That code was never checked into the repo and no longer exists.** The
numbers below are therefore point-in-time results from unretained code: they cannot currently
be re-run or independently verified, and anyone re-deriving them must re-implement the sims
from the parameters described here (§3's input table and the model statements in each
subsection). This is a provenance gap, not a retraction — the findings stand as reported;
what is missing is reproducible, checked-in code. Tracked as **`cairn-l1zu.23`** (see §3).

> **This is research, not a decision.** Nothing here authorizes a build, reverses the
> `cairn-vn43.14` gate, or overrides Alex's fixed rulings in §2 of the design doc. It is an
> evidence-backed evaluation of the design as written, so that any future build decision is
> made with the corrections and costs on the table. Where this analysis recommends a change,
> it names the exact design-doc section it would amend and flags — never overrides — any
> tension with Alex's fixed rulings.

---

## Table of contents

1. Executive summary
2. Corrections & contradictions to the design doc
3. Simulation results (single-instance Monte-Carlo)
4. Comparative analysis (vs the field)
5. Edge cases
6. Federation analysis (Phase 2)
7. Legal analysis
8. Economic viability
9. Recommendations for Alex

---

## 1. Executive summary

**Overall verdict: the design is a novel, internally-coherent, and genuinely unoccupied
point in the payout-scheme design space — sound at its core, but shipping-incorrect in a
handful of specific and fixable ways.** Four independent research workstreams (Monte-Carlo
simulation at 200k–500k trials/scenario on real mid-2026 network numbers; a comparative
survey against FPPS/PPLNS/TIDES/P2Pool/ckpool/Braidpool; a 10-instance quantitative
federation model; and a FinCEN/MTL/tax/developer-liability legal risk mapping) converge on
the same picture: the coinbase-split *architecture* is right, the *no-custody posture* is
its strongest asset legally and structurally, and the problems that exist trace almost
entirely to two things — the **equal-split v1 default** and, at the federation layer, an
**under-specified §14**.

**Confirmed strengths (all four workstreams agree):**

- **The share model is correct, not assumed.** `B_i = W_i / E_i` with `E ~ Exp(1)` was
  *derived* from the raw per-hash process (KS test p=0.56, cannot reject); `P(rank-1 = miner
  i) = W_i / ΣW` holds exactly across five hashrate mixes (worst deviation 1.49σ over 20
  comparisons). Best-share winner-take-all is exactly hashrate-proportional in expectation.
- **Mean-hopping is genuinely neutralized.** Unlike Rosenfeld's proportional attack (where
  hopping is EV-*positive*), here loyal EV = 0.98φ independent of the finder %, while the
  hopper ceiling = φ·(0.98−f) < 0.98φ. Finder-forfeit makes hopping EV-neutral-to-negative.
  The finder % genuinely defeats the profitable hopping that PPLNS was invented to stop.
- **Best-in-class custody.** Zero custody at every point ties Ocean and ckpool and beats
  every custodial pool (FPPS/PPLNS) and even Braidpool (which FROST-custodies cross-block
  rewards). This is also the single strongest fact in the legal analysis.
- **Simplest accounting in the field.** Per-round store, no cross-block balances, no
  carry-forward — this is what lets the design keep its clean custody posture, and it is a
  real advantage over TIDES's carry-forward ledger.
- **The right product for a 2–50 node sovereignty pool** — it keeps the solo jackpot (finder
  gets the largest cut) that TIDES lacks, and adds a between-wins trickle that ckpool lacks.

**Headline corrections (each detailed in §2):**

1. **The equal-split v1 default breaks the proportionality the game-theory section sells.**
   Under the shipping default a big miner is paid 0.15–0.24× of proportional and a ~90% whale
   keeps only ~57% of its EV; work-proportional split restores ratio = 1.000 for everyone.
   *Three workstreams independently converge on making §6.6 the v1 default.*
2. **The §6.4 hopper-survival constant is inverted** — true median survival is
   `(H_hop/H_ong)·t_mined` with no constant; the doc's 1.44× overstates squat persistence by
   ~44% (favors the design).
3. **§14.5's "summed-work is splitting-neutral" claim is backwards** — neutrality lives in
   the split rule, not the ranking gate; summed-work + equal-split is the *most* exploitable
   combination tested (94% pot capture at 50% evil hashrate).
4. **Per-instance rounds + a federation meta-board is incoherent** — there is no well-defined
   "shares live right now" federation-wide; fix is a global round keyed on on-chain
   federation-block observation.
5. **The meta-board slot cap M is defeated by free `instanceId` minting** — invite-gated
   admission is the load-bearing dependency §14 omits.
6. **"Fee averages out" is misleading** — a 50 TH/s instance has a 73% chance of zero fee
   revenue after 100 years.
7. **The design is economically coherent only at ≥1–10 PH/s pooled scale** — 1 TH/s earns
   ≈$11.3/yr EV regardless of pool size; the 2% fee only covers a $20/mo node above ~1 PH/s;
   a sub-1-year block cadence needs ~17 PH/s. This wall-clock reality dominates everything and
   is under-stated in the "few vs many miners" framing.

None of these is fatal. Corrections 1–2 are v1 design-doc amendments; 3–6 are §14 federation
amendments (federation is explicitly R&D-stage, so these land before any federation build);
7 is an honesty fix in the docs. The legal analysis independently concludes the posture is
"on the favorable side of every controlling US authority," with the real risk dial being
stranger-facing public scale, not the split feature itself — and it adds concrete mitigations.

---

## 2. Corrections & contradictions to the design doc

This section consolidates every correction found across all four workstreams. Each carries
its evidence and the concrete fix. Read this before §15's open decisions — several of those
decisions are affected.

### C-1. Equal-split v1 default breaks EV-proportionality *(three workstreams converge)*

**The contradiction.** The doc ships **equal-split** as the v1 settings default (§5.9,
"v1 pot distribution is equal-split across ranks") but simultaneously claims "EV is
approximately proportional for everyone" (§6.7) and "E[total]_loyal ≈ 0.98φ … independent
of f" (§6.2). Simulation shows those two claims hold **only** under the §6.6
work-proportional split, which the doc *recommends* but does not make the default.

**Evidence (simulation, f=50%, fee=2%, N=10, 200k rounds).** Ratio = (miner's share of
leaderboard pot) / (miner's hashrate share); 1.000 = perfectly proportional:

| Mix | rule | whale/big ratio | small-miner ratio | Gini(payout) vs Gini(hash) |
|---|---|---|---|---|
| 1×100+4×5 TH | equal (v1 default) | **0.24×** | 4.80× | 0.32 vs 0.63 |
| 1×100+4×5 TH | work-prop (§6.6 rec) | **1.00×** | 1.00× | 0.63 vs 0.63 |
| 1×100+4×5 TH | best-value-prop | 0.81× | ~1.97× | 0.55 vs 0.63 |
| Pareto-30 | equal | 0.61–0.79× | 1.4–1.74× | 0.54 vs 0.61 |
| Pareto-30 | work-prop | 1.00× (all) | 1.00× | 0.68 vs 0.61 |
| 1×100+9×5 TH | equal | **0.145×** | 2.90× | 0.30 vs 0.59 |
| 1×100+9×5 TH | work-prop | 1.00× | 1.00× | 0.59 vs 0.59 |

- Under the shipping equal-split default, a big miner is paid as little as **0.145–0.24× of
  proportional**; small miners get **2.9–4.8×**. Equal-split is a large structural
  whale→small-miner subsidy.
- Whole-payout impact: a ~90% whale under equal-split (finder 50% + one board slot) nets
  **~57% of proportional EV**; ~43% is redistributed to small miners. Work-prop restores the
  full 0.98φ.
- **Only work-proportional gives ratio = 1.000 for every miner in every mix** (confirmed to
  three decimals).
- The variance tradeoff is real but does not rescue the default: equal-split buys
  small-miner variance reduction (small-miner CV ~0.85–1.4 under equal vs 2.45–2.7 under
  work-prop) at the cost of that disproportionality. Best-value-prop is the worst of both —
  highest CV everywhere (1.7 vs 1.53 even in the uniform mix) and still not proportional,
  confirming the §6.6 "one monster share eats the pot" concern.

The comparative workstream reaches the same conclusion from a different direction: the §6.6
split (keep best-share as the *gate*, split the pot by since-round-start cumulative work)
"recovers most of TIDES's amount-fairness and Sybil/tail resistance while honoring no-decay,
and should be the v1 default rather than equal-split." The federation workstream reaches it a
third way: summed-work **proportional** split collapses the meta-layer splitting-sybil gain
to near-zero, where summed-work **equal** split is the single most exploitable combination
tested (see C-3).

**Fix — amends §5.9 and §15 decision 4.** Make **since-round-start-work-proportional** the
v1 default pot-distribution rule. Keep equal-split available as an explicit, documented
small-miner-subsidy option, framed honestly as a rule that taxes large miners ~43% of EV and
will push them back to solo/ckpool. This is fully compatible with Alex's fixed no-decay
ruling (decision 4): "since-round-start work" is a running sum from round-open, requires no
rolling window and no aging, and leaves the best-share *gate* (who's in the top-N and in what
order) exactly as Alex specified. It touches only the *amounts*, not the *ranking*.

### C-2. Hopper-survival constant is inverted (§6.4)

**The error.** §6.4 states expected survival of a departed hopper's leaderboard entry as
`E[survival] ≈ 1.44 × (H_hopper / H_pool_ongoing) × t_mined`.

**Evidence (simulation; hopper = 100 TH/s mined 1 day, ongoing pool varies):**

| H_ongoing | doc formula (1.44×) | sim median | sim mean |
|---|---|---|---|
| 500 TH/s | 6.9 h | 4.8 h | 2.5 d |
| 100 TH/s | 34.6 h (1.44 d) | 23.9 h | 15.2 d |
| 10 TH/s | 14.40 d | 9.98 d | 142.6 d (diverging) |

The true **median** survival is `(H_hop/H_ong)·t_mined` with **no constant**. The doc's 1.44
is `1/ln 2`, the reciprocal of where it belongs — it overstates the true median by ~44%. The
*mean* is infinite (Fréchet, α=1), which is why the doc's single-number "survives ~7 hours /
~1.4 days / ~14 days" worked examples are better read as medians anyway.

**Direction of the error favors the design:** squats are slightly *less* persistent than the
doc advertises, so the doc's honest-costs section (§6.3) is if anything slightly
pessimistic. Right order of magnitude, wrong constant.

**Fix — amends §6.4.** Replace the constant with `E[median survival] ≈ (H_hopper /
H_pool_ongoing) × t_mined`, and note the mean is infinite (heavy tail) so the median is the
meaningful summary. Recompute the three worked examples (~4.8 h / ~24 h / ~10 d medians).

### C-3. "Summed-work is splitting-neutral" is backwards (§14.5)

**The error.** §14.5 argues the meta-board must "rank by additive summed work
(splitting-neutral, unlike best-share)." The neutrality claim is placed on the *ranking gate*.
It belongs on the *split rule*.

**Evidence (federation simulation; evil instance with fraction x of federation hashrate
relabels its own real share stream across free, unlinkable fake "users"; board N=10, 40
honest users, 4–6k trials).**

Max pot fraction captured (fair = x):

| x | (a) best+equal | (b) **summed-work+equal** | cap M=2 | M=3 | M=5 | (d) sw+proportional |
|---|---|---|---|---|---|---|
| 0.05 | 0.062 | 0.100 | 0.100 | 0.100 | 0.100 | 0.087 |
| 0.20 | 0.235 | 0.451 | 0.200 | 0.300 | 0.448 | 0.386 |
| 0.50 | 0.532 | **0.938** | 0.200 | 0.300 | 0.500 | 0.934 |
| 0.70 | 0.714 | 1.000 | 0.200 | 0.300 | 0.500 | 1.000 |

Splitting *incentive* isolated (pot from one entry → optimal relabel; the doc's actual
"neutral" claim):

| x | best+eq gain | **sw+eq gain** | sw+prop gain |
|---|---|---|---|
| 0.10 | +0.045 | **+0.114** | +0.012 |
| 0.20 | +0.140 | **+0.351** | +0.074 |
| 0.50 | +0.432 | **+0.841** | +0.290 |

- best-share + equal over-extracts only modestly (1.02–1.25×); its real problem is
  variance/squatting, not mean-capture.
- **summed-work + equal-split — the design's own v1 default (§5.9) carried to the meta
  layer — is the most exploitable combination tested** (1.4–2.3×; 94% of the pot at x=0.5).
  Summed-work makes slot-occupation cheap and deterministic, and equal-split pays every
  packed slot equally.
- **Splitting-neutrality is a property of the SPLIT rule, not the ranking gate.** Pot split
  *proportional to summed-work* (the §6.6 intra-instance recommendation, which §14.5 never
  carried up to the meta layer) collapses the splitting gain to near-zero at minority evil
  sizes (+0.012 at x=0.10).

Note this is the *same* correction as C-1, one layer up: the equal-split default is the root
of both the single-instance proportionality break and the federation sybil-splitting hole.

**Fix — amends §14.5.** State that the meta-board needs **summed-work ranking *and*
proportional-to-summed-work split** together — ranking alone does not confer
splitting-neutrality. This is the natural extension of the C-1 fix to the federation layer.

### C-4. Per-instance rounds + a meta-board is incoherent (§14.5)

**The incoherence.** §14.5 recommends per-instance rounds ("each instance's own found block
resets only its own board") while the meta-board is federation-wide. When instance A finds a
block, either:

- (i) A's shares stay live on everyone's meta-board until B finds → a miner at A gets paid at
  A's block *and again* at B's block for one round's work (double-count); or
- (ii) A's shares purge from everyone's board → a purely local event at A silently craters
  A-miners' standing inside B's mid-round template for reasons a B-observer cannot see.

There is no single round clock, so "the shares live right now" is undefined federation-wide.
As stated, **the meta-board has no well-defined contents.**

**Fix — amends §14.5 / §14.7 Q4 (this is the highest-priority federation change).** Define
the round boundary as a **federation-global round keyed on on-chain block observation**: "any
federation instance's block confirming on the Bitcoin chain." This is self-certifying and
globally observable with zero consensus — every instance already runs a `TipPoller`, and a
federation block carries the `OP_RETURN {magic, instanceId}` tag. On that event, every
instance resets the meta-board simultaneously (keyed on block height/hash). One clock,
globally consistent standing. Local intra-instance boards stay per-instance/best-share per
Alex's ruling. **The Bitcoin blockchain *is* the shared ledger of "when did a federation
block happen"** — supplied free, no shared-ledger violation. The tip watcher and OP_RETURN
seam already exist in the phase-1 design. This single change also fixes the immortal-dead-slot
failure mode (F-1 below) in one move.

### C-5. Slot cap M is defeated by free `instanceId` minting (§14.5)

**The gap.** §14.5 offers a per-instance slot cap `M` as a structural sybil mitigation. Two
problems the doc understates:

- **(a) It penalizes the honest whale.** The legitimate 2 PH/s instance (52.6% fair share)
  is capped at 0.30 of the pot under M=3. M cannot distinguish evil-splitting from a
  genuinely large honest instance (see the cap columns in C-3's table — M=3 caps *everyone*
  at 0.30, honest or not).
- **(b) It is defeated by instance-level sybil.** M is enforced per `instanceId =
  sha256(pubkey)[:16]`, which is free to mint. An evil operator runs `⌈s/M⌉` instance
  identities and recovers full uncapped capture.

**The load-bearing omitted dependency.** The real sybil root is **invite-gated instance
admission**. `docs/FEDERATION-SCOPE.md` F4/F3 already require an issued invite plus an
out-of-band fingerprint confirmation to admit an instance. If meta-mining reuses that gate,
minting an `instanceId` costs a human invite and M becomes meaningful. If it accepts
un-invited gossip, M is worthless. **This linkage is the load-bearing fact §14 omits.**

**Fix — amends §14.5 / §14.7.** State explicitly that the meta-board's sybil resistance
depends on reusing the F4/F3 invite gate for instance admission; M is a secondary structural
mitigation that is only meaningful behind that gate. Size a static `meta_min_diff` off the
*smallest* intended instance (it doubles as the DoS floor and as §6.5's `m_min` sybil lever,
capping fake users at `W_evil / meta_min_diff`).

### C-6. "Fee averages out" is misleading (§14.5)

**The over-sold promise.** §14.5 recommends finder-instance-takes-all fee revenue, reassuring
that "fee revenue then averages out proportionally to each instance's hashrate over time."
This is true only on a geological timescale.

**Evidence (federation simulation; federation = 3.80 PH/s, 850 EH/s network → whole
federation finds one block ≈ every 4.3 yr).** Blocks (and years) for cumulative fee share to
converge to hashrate-fair under finder-instance-takes-all:

| instance | fair share | ±25% | years | ±10% | years |
|---|---|---|---|---|---|
| big (52.6%) | 0.526 | 14 blocks | 61 | 90 blocks | 383 |
| mid (13.2%) | 0.132 | 106 blocks | 449 | 660 blocks | 2,809 |
| small (1.3%) | 0.013 | 1,200 blocks | **5,107** | 7,500 blocks | **31,918** |

Monte-Carlo realized fee share: after **100 yr** (~23 federation-blocks) the small (50 TH/s)
instance has a **73% chance of zero fees** (97% after 10 yr; still 4% after 1000 yr). The big
instance converges in decades.

**Fix — amends §14.5.** The "averages out" reassurance is misleading at any human timescale
for small operators and should be **cut**. Replace with the honest headline: small instances
collect essentially no fee, ever — run one for sovereignty, not fee income. This is tolerable
as an engineering choice (it buys zero cross-instance accounting), but it must be stated
plainly, not buried in a footnote.

### C-7. Economic-scale reality: coherent only at ≥1–10 PH/s (§7, §8)

**The under-stated constraint.** §8 ("few vs many miners") discusses board dynamics — slot
competition, displacement math — without the wall-clock block cadence that dominates
everything. The leaderboard pays only when the pool finds a block, so payouts arrive on the
same cadence as E[time/block], and below ~1 PH/s that cadence is decades to millennia.

**Evidence (simulation, real mid-2026 numbers: ~900 EH/s network, difficulty 127.17 T,
3.125 BTC subsidy, ~$62,000 BTC):**

| Pool | E[time/block] | blocks/yr | Operator fee $/yr (2%) | P(≥1 block in 1 yr) | 1 TH/s EV $/yr |
|---|---|---|---|---|---|
| 10 TH/s | 1,712 yr | 0.0006 | $2.26 | 0.06% | $11.32 |
| 100 TH/s | 171 yr | 0.0058 | $22.63 | 0.58% | $11.31 |
| 1 PH/s | 17.1 yr | 0.0584 | $226 | 5.7% | $11.31 |
| 10 PH/s | 1.7 yr | 0.584 | $2,263 | 44% | $11.31 |
| 100 PH/s | 62.5 d | 5.84 | $22,630 | 99.7% | $11.32 |

- **1 TH/s EV ≈ $11.3/yr at every pool size** — the pool changes variance, not EV (as §6.7
  states). Product value = variance-smoothing + the trickle, not extra yield.
- **Minimum pool hashrate for a human-relevant (E ≤ 1 yr) block: ~17 PH/s.** At 5-yr
  cadence: 3.4 PH/s; at 10-yr: 1.7 PH/s.
- **Operator break-even vs home-node hosting ($20–50/mo):** the 2% fee only covers hosting
  at ~1.06 PH/s ($20/mo) to ~2.65 PH/s ($50/mo). Below ~1 PH/s the operator runs at a loss on
  fee revenue — i.e. essentially all friends-and-family deployments. The fee is cost-recovery
  at best, not a business.

**Fix — amends §7 / §8.** State next to the "few vs many miners" discussion that the design
is economically coherent only at ≥1–10 PH/s pooled — beyond a literal "few friends with a
couple ASICs." Below ~1 PH/s the 2% fee does not cover a $20/mo node and blocks (hence
leaderboard payouts) are decade-to-millennium events. This is honesty framing, not a design
change, and it aligns with the doc's own "honest costs" voice.

### Correction summary table

| ID | Correction | Amends | Severity | Direction |
|---|---|---|---|---|
| C-1 | Equal-split default breaks EV-proportionality; make §6.6 work-prop the default | §5.9, §15.4 | **High** | fix required |
| C-2 | Hopper-survival constant inverted (1.44× → no constant) | §6.4 | Low | favors design |
| C-3 | Summed-work neutrality is a split-rule property, not a ranking property | §14.5 | **High** (fed) | fix required |
| C-4 | Per-instance rounds + meta-board incoherent; global on-chain round | §14.5, §14.7 Q4 | **High** (fed) | fix required |
| C-5 | Cap M defeated by free instanceId minting; invite-gate is load-bearing | §14.5, §14.7 | **High** (fed) | fix required |
| C-6 | "Fee averages out" misleading; small instances get ~no fees ever | §14.5 | Med (fed) | honesty fix |
| C-7 | Economically coherent only at ≥1–10 PH/s | §7, §8 | Med | honesty fix |

---

## 3. Simulation results (single-instance Monte-Carlo)

> **Reproducibility caveat.** Every number in this section (and in §5 and §6) is a point-in-time
> result from Monte-Carlo code that was run in a session scratchpad and **never checked into the
> repo; it no longer exists**. The results are reported honestly and are not retracted, but they
> are not presently reproducible: to re-verify or update them, the sims must be re-implemented
> from the parameters below (the input table, trial counts, and the model statement in each
> subsection — e.g. §3.1's raw per-hash process, §3.2's split rules, §3.3's finder sweep).
> Re-implementing them as checked-in, seeded code is tracked as **`cairn-l1zu.23`** (p3, under
> epic `cairn-l1zu`). Treat the tables as the analysis's best evidence as of 2026-07-18, not as
> a live artifact.

Real inputs used (WebSearch, 2026-07-18):

| Quantity | Value | Source |
|---|---|---|
| Network hashrate | ~900 EH/s (7-day avg ~908) | minerstat / hashrateindex / gncrypto |
| Difficulty | 127.17 T (2026-07-11 adj) | coinwarz / bitcoin.com |
| Block subsidy | 3.125 BTC | lbank / bitbo |
| BTC price | ~$62,000 | fortune.com (07-13/07-14) |

Trial counts: sim1 raw-process 200k, rank-1 400k/mix; sim2 200k rounds/mix; sim3 200k rounds
(variance-reduced, shared exponentials across `f`); sim4 20k–500k; sim5 closed-form +
Poisson. Rank-1 probabilities resolved to ±0.001 (95% CI); reported deviations within CI
unless stated.

### 3.1 Foundational share model (§6.1) — CONFIRMED

The Pareto(α=1) / `B=W/E` model was **derived, not assumed.** Simulating the raw per-hash
process (each hash Uniform(0,1) on a normalized target axis, best-of-stream = `1/min`):

- `W·min(uniforms) → Exp(1)`: sample mean 0.9979 (theory 1.0000); KS vs Exp(1) stat=0.0018,
  p=0.560 → cannot reject. Therefore `B = W/E`, `E ~ Exp(1)` follows directly.
- Tail is Pareto(α=1): exact law `P(B>b) = 1 − exp(−W/b) → W/b` for `b >> W`. Confirmed
  (`P(B>10000)` at W=1e5 = 0.99997 vs `1−exp(−10)=0.999955`).
- `E[best share]` is infinite (Fréchet, α=1): sample mean 2.21M vs median 144k — diverges as
  designed. This underpins the "heavy-tail squatting" cost (§6.3). CONFIRMED.

`P(rank-1 = miner i) = W_i / ΣW` **exactly** — 5 mixes, 400k rounds each. Worst deviation
1.49σ (Pareto-20, expected over 20 comparisons); all others <1σ.

| Mix | max abs dev from W_i/ΣW | σ vs 95% CI |
|---|---|---|
| uniform 5× | 0.00082 | 0.66 |
| 3:1 two miners | 0.00078 | 0.58 |
| 1×100+4×5 TH | 0.00085 | 0.78 |
| whale 90%+10 small | 0.00044 | 0.92 |
| Pareto 20 | 0.00076 | 1.49 |

### 3.2 Pot-split rules & payout-vs-hashrate proportionality (§5.9, §6.6) — KEY CONTRADICTION

This is the evidence base for correction **C-1**. See C-1 for the full table and discussion.
The one-line result: only work-proportional split gives ratio = 1.000 for every miner in
every mix; equal-split (the shipping default) pays big miners 0.145–0.24× and small miners
2.9–4.8× of proportional. The clean §6.2/§6.7 EV identities are work-prop results.

**Recommendation (from the workstream):** if "EV ~ proportional" matters, the v1 default
should be work-proportional, not equal-split. Equal-split is defensible only as a deliberate
small-miner subsidy and will push large miners back to solo/ckpool.

### 3.3 Finder-% sweep & loyal-vs-hopper (§6.2) — CONFIRMED (under work-prop)

f ∈ {20,30,40,50,60}%, work-prop split, 200k rounds, variance-reduced. Reproduces the §6.2
table to 3–4 decimals:

| f | Loyal EV (φ=0.15) | theory 0.98φ | Hopper ceiling | theory φ(0.98−f) | Hop penalty | theory f·φ | H/L | theory |
|---|---|---|---|---|---|---|---|---|
| 20% | 0.14714 | 0.147 | 0.11700 | 0.117 | 0.030 | 0.030 | 0.795 | 0.796 |
| 30% | 0.14720 | 0.147 | 0.10200 | 0.102 | 0.045 | 0.045 | 0.693 | 0.694 |
| 40% | 0.14727 | 0.147 | 0.08700 | 0.087 | 0.060 | 0.060 | 0.591 | 0.592 |
| 50% | 0.14734 | 0.147 | 0.07200 | 0.072 | 0.075 | 0.075 | 0.489 | 0.490 |
| 60% | 0.14741 | 0.147 | 0.05700 | 0.057 | 0.090 | 0.090 | 0.387 | 0.388 |

- Loyal EV flat in f (0.98φ); hop-penalty = f·φ exactly (φ ∈ {0.05, 0.15, 0.40}). **Finder %
  is a variance/loyalty dial, not an EV lever.** CONFIRMED.
- **Caveat (ties to C-1):** under the equal-split default, loyal EV is NOT 0.98φ and NOT flat
  in f — for φ=0.15 it runs 0.108→0.128 and rises with f. The clean §6.2 identities are a
  work-prop result.
- Per-class variance (1×100+4×5, f=50%, work-prop): big miner CV 0.23, small miners CV 2.45 —
  ~10× relative variance. Equal-split would cut small CV to ~0.85.

### 3.4 Scorecard: doc claims CONFIRMED vs CONTRADICTED

| # | Claim | Verdict |
|---|---|---|
| §6.1 | Share difficulty ~ Pareto(α=1), derived from exponential share process | CONFIRMED (derived, KS p=0.56) |
| §6.1 | `B_i = W_i/E_i`, `E~Exp(1)`; `E[best]` infinite | CONFIRMED |
| §6.1 | `P(rank-1=i) = W_i/ΣW` exactly | CONFIRMED (<1.5σ, 5 mixes) |
| §6.2 | Loyal EV = 0.98φ, independent of f | CONFIRMED — but only under work-prop split, not equal-split v1 default |
| §6.2 | Hop penalty = f·φ; H/L = (0.98−f)/0.98 | CONFIRMED (3–4 decimals) |
| §6.5 | Per-user aggregation → whale holds 1 slot | CONFIRMED |
| §6.5 | Sybil ~8%-class pot gain (50% share, N=2, flat) | CONFIRMED (sim 8.4% vs claim 8.3%) |
| §6.4 | Hopper survival ~ `1.44·(H_hop/H_ong)·t` | CONTRADICTED (constant): true median = `(H_hop/H_ong)·t`; doc overstates by 1/ln2 ≈ 1.44×; mean infinite |
| §6.3 | Months-old #1 in long rounds | CONFIRMED (mean age = 0.499 of round) |
| §6.3 | Late-joiner freeze-out `W_new/(W_new+W_inc)` | CONFIRMED (3 decimals) |
| §5.9 vs §6.7 | v1 equal-split default delivers "EV ~ proportional for everyone" | CONTRADICTED: equal-split pays big 0.15–0.24×, small 2.9–4.8× of proportional. Needs §6.6 work-prop split |
| §7/§8 | Dust never triggers at mainnet subsidy | CONFIRMED indirectly — 1/N of a thin pot >> 294-sat dust; never binding |

---

## 4. Comparative analysis (vs the field)

### 4.1 Key comparative verdicts

1. **Novel niche, confirmed:** no production pool implements a top-N best-share leaderboard;
   Heartwood occupies an unoccupied point — non-custodial direct-coinbase (matching
   Ocean/ckpool, beating all custodial pools) + zero cross-block accounting + preserved solo
   jackpot + small-miner trickle.
2. **Hopping, mean sense — NOT hoppable (design's real win):** unlike Rosenfeld's
   proportional attack where hopping is EV-*positive*, here `E[loyal]=0.98φ` independent of f
   while hopper ceiling `= φ(0.98−f) < 0.98φ`. Finder-forfeit makes hopping
   EV-neutral-to-negative. Finder-% genuinely neutralizes the profitable form of hopping that
   PPLNS was invented to stop.
3. **Hopping, tail sense — IS hoppable, and finder-% does NOT fix it:** best-share is
   Fréchet(α=1), infinite `E[best share]`; a lucky outlier squats a slot for months under
   beat-only. Young rounds = cheap slots (Rosenfeld-adjacent time-dependence). Windowed
   schemes (PPLNS/TIDES) prevent this structurally; Heartwood only mitigates probabilistically
   (rounds outlast squats at small scale) + `m_min`.
4. **Verdict on finder-% sufficiency:** sufficient for EV-fairness, insufficient for
   tail-fairness — the doc knows and accepts this.
5. **Worse than FPPS** on the one thing FPPS sells: continuous smoothing. Heartwood pays
   nothing until block-find (months–years at small scale). But FPPS is impossible for a 2–50
   miner self-hosted pool anyway (no reserves).
6. **Worse than Ocean TIDES** on amount-variance-given-a-win (best-share = maximally noisy
   estimator vs TIDES smoothed pro-rata) and on structural hop-immunity; **better** by dropping
   TIDES's carry-forward balance accounting and by keeping a jackpot (TIDES finder = 0%).
7. **Better than ckpool solo** for the target use case (adds a trickle; ckpool pays finder
   only), same non-custody/scale; ckpool is only lighter regulatorily.
8. **Better custody than Braidpool** (Braidpool FROST-custodies cross-block rewards via 66%+1
   of ~50 signers; Heartwood never custodies).
9. **Avoids P2Pool's killers** (N≤40 vs thousands of coinbase outputs; no sharechain/orphan
   races) but inherits none of its windowed variance-smoothing.
10. **Highest-leverage fix:** the §6.6 recommendation (keep best-share as the *gate*, split
    the pot by since-round-start cumulative work) recovers most of TIDES's amount-fairness +
    Sybil/tail resistance while honoring no-decay — should be the v1 default over equal-split.

### 4.2 Current sourced facts (2026)

**FPPS (Foundry, Antpool, F2Pool, Braiins)** — fixed payout per valid share covering subsidy
+ estimated tx-fee, paid continuously regardless of block-find; operator absorbs all variance
(an insurance product). Foundry ~37% network hashrate, tiered FPPS to 0% for largest; Antpool
2.5% FPPS / 1.5% PPLNS; F2Pool ~2.5–4% FPPS; Braiins 2% FPPS or Score. Custodial. Total
hop-resistance (time-invariant share value). Sources:
[Foundry FAQ](https://pool-faq.foundrydigital.com/what-is-foundry-usa-pools-payout-methodology),
[F2Pool](https://f2pool.zendesk.com/hc/en-us/articles/360061042332-Payout-schemes-PPS-PPLNS-FPPS-PPS),
[Antpool](https://antpoolsupport-hc.zendesk.com/hc/en-us/articles/5983010227993-Miners-Settings-Fees),
[Spark](https://www.spark.money/tools/bitcoin-mining-pool-comparison),
[Lightspark](https://www.lightspark.com/knowledge/bitcoin-mining-pools-explained-a-beginners-guide).

**PPLNS + Rosenfeld origin** — reward split over last N shares (rolling window, ignores round
boundaries). Exists because the **proportional** scheme it replaced pays `R/n` (n = shares
since last block); share value falls as round lengthens, so a hopper mines only while rounds
are young and abandons them, earning above-fair reward (classic c≈0.435 cutoff). PPLNS
normalizes independent of round boundaries so share value no longer depends on round age.
Braiins "Score" = recency-weighted PPLNS. Sources:
[Rosenfeld pool_analysis.pdf](https://bitcoil.co.il/pool_analysis.pdf),
[RPPLNS arXiv:2102.07681](https://arxiv.org/abs/2102.07681),
[Braiins Academy](https://academy.braiins.com/braiins-pool/rewards-and-payouts).

**Ocean TIDES** — window = **8× network difficulty** in shares (~8 blocks), 99.9665% chance
a share is rewarded ≥once; exact pro-rata incl. fees paid **non-custodially as direct coinbase
outputs**; fee **2% / 1% DATUM**; TIDES itself has **no minimum-payout** but pools may
accumulate to a threshold (doc cites Ocean's ~1,048,576-sat minimum with **carry-forward** =
balance accounting, which Heartwood rejects). Anti-hop = the window ("can't bunch shares in
one spot"). Sources: [ocean.xyz/docs/tides](https://ocean.xyz/docs/tides),
[d-central Ocean guide](https://d-central.tech/ocean-mining-pool-guide/).

**P2Pool / Monero P2Pool / Braidpool** — Bitcoin P2Pool died from: coinbase bloat (thousands
of outputs), dust economics, share variance, 30s-sharechain orphan/DOA races, couldn't match
FPPS smoothness. Monero P2Pool: **0% fee**, ~10s sidechain, PPLNS window up to **2160 blocks
(~6h auto-adjust)**, **uncle blocks** (no orphan loss), **mini/nano** tiers for small miners.
Braidpool (pre-prod, active March 2026): DAG "beads" kill orphan races; **FROST/ROAST
threshold-Schnorr federation custodies cross-block rewards** — after 4 blocks, 66%+1 of ~50
recent block-miners sign RCA→UHPO (this **is** shared custody). Sources:
[SChernykh/p2pool](https://github.com/SChernykh/p2pool),
[getmonero p2pool](https://www.getmonero.org/resources/moneropedia/p2pool.html),
[braidpool spec](https://github.com/braidpool/braidpool/blob/main/docs/braidpool_spec.md),
[Bitcoin Magazine](https://bitcoinmagazine.com/technical/braidpool-a-second-competitor-in-decentralizing-mining).

**ckpool solo** — finder keeps ~98%, **2% fee** on block-find, no accounting/custody/
registration; `BTCSOLO` username = BTC address. 2026-04-09 block 944,306 solved by 70 TH/s
hobbyist for ~3.13 BTC (~$222k) after 2% via eusolo. Maximal variance vs ~954 EH/s network.
Sources: [solo.ckpool.org](https://solo.ckpool.org/),
[bitcoin wiki](https://en.bitcoin.it/wiki/Solo.ckpool),
[cryptotimes](https://www.cryptotimes.io/2026/04/09/this-solo-bitcoin-miner-won-222k-in-block-reward-how-you-can-do-it/).

**DEMAND / Braiins / non-custodial frontier** — DEMAND (DMND) native Stratum V2; Braiins 2%
FPPS/Score, only top-ten pool shipping V2 in production, custodial. Non-custodial precedents
are narrow: Ocean/TIDES+DATUM and ckpool-solo; Braidpool is the decentralized-but-
federated-custody frontier. Heartwood sits with Ocean/ckpool on custody but is the only one
pairing non-custody with a best-share leaderboard. Sources:
[d-central 2026 comparison](https://d-central.tech/bitcoin-mining-pool-comparison-2026/),
[coinwebmining Braiins](https://coinwebmining.com/braiins-pool-review/).

### 4.3 Comparison matrix

| Dimension | **Heartwood split** | FPPS | PPLNS/Score | Ocean TIDES | ckpool solo | Monero P2Pool | Braidpool |
|---|---|---|---|---|---|---|---|
| EV/hashrate | ~0.98φ (proportional in expectation) | fair − high fee | fair − fee | fair − 2%/1% | 0.98φ, 100% to finder only | fair, 0% fee | fair |
| Variance (small miner) | **High** — pays only on block-find; amount keys on one luckiest hash | **Lowest** (smooth daily) | Medium (windowed) | Medium (windowed pro-rata) | **Maximal** (lottery) | Low-med | Low-med |
| Hop incentive | EV-neutral/negative avg, **tail-squat exploitable** | None | Low | Low | None | Low | Low |
| Hop-resist mechanism | **Finder % only (no window)** | time-invariant value | rolling window | 8× diff window | n/a solo | 2160-blk window+uncles | sharechain+window |
| Custody/trust | **None** (direct coinbase) | Custodial | Usually custodial | **None** | **None** | None | **Shared FROST custody** |
| Regulatory surface | Pool-operator (sets 3rd-party %, fee output) | Highest | High | Pool-operator, non-custodial | Lightest (solo) | Decentralized | Decentralized-federated |
| Accounting complexity | **Low** (per-round store, no balances) | High | Med-high | Med-high (carry-forward) | **Lowest** | Medium | High |
| Coinbase size | Trivial (N≤40) | 1 out | 1 out | tens–hundreds | 1 out | **Thousands (killed it)** | bounded |
| 2–50 miner fit | **Purpose-built** (jackpot+trickle) | Impractical | Works, trickle on rare wins | Works, low-var amounts | Solo only, no trickle | XMR only | Not yet prod |

### 4.4 Rosenfeld-style hoppability assessment (the core analytical result)

**(a) Mean exploitation — largely NO (design's genuine strength).** Rosenfeld's proportional
attack is EV-*positive* (exploit the `R/n` denominator on short rounds). Heartwood:
`E[loyal]=0.98φ` independent of f; hopper ceiling `= φ(0.98−f) < 0.98φ`. The finder leg
(largest cut, EV scales with φ) can only be collected while present, so hopping is
EV-neutral-to-negative — it trades finder EV for nothing. `P(rank-1)=W/ΣW` is also
identity-split-invariant, so simple Sybil doesn't move the mean. Finder-% genuinely
neutralizes the profitable hopping PPLNS was invented to stop.

**(b) Tail/squat exploitation — YES, and finder-% does NOT fix it.** Best-share is
Fréchet(α=1), infinite `E[best share]`; a 10–100× outlier squats a top-N slot for months
under beat-only/no-decay. Entry threshold is low when a round is young (weak board) and rises
as it ossifies — a Rosenfeld-*adjacent* time-dependence: presence-at-round-start is
over-rewarded, so the rational play is "hop into fresh rounds, grab a cheap durable slot,
leave." The doc's §6.3 late-joiner freeze-out is this exploit from the incumbent's side. A
window defeats it by construction; beat-only cannot.

**Sufficiency verdict:** finder-% is **sufficient for EV-fairness, insufficient for
tail-fairness**. PPLNS exists not only for mean-fairness but to make a share's value
*independent of when in the round it was mined*; beat-only reintroduces exactly that
time-dependence at the tail, which finder-% doesn't touch. The doc knows this and leans on:
(i) at 2–50 miner scale rounds run months-to-years so squats usually evaporate before a block
lands (`E[survival] ≈ (H_hop/H_pool)·t_mined`, corrected per C-2); (ii) `m_min` + per-user
aggregation. Adequate for a small socially-trusted deployment; not the structural immunity a
window gives. Federation makes it worse — the social anchor evaporates and best-share "does
not survive untrusted instances," forcing the meta-board onto additive summed work (§14.5,
corrected per C-3).

### 4.5 Where Heartwood is honestly worse

- **vs FPPS:** worse on the one thing FPPS sells (continuous smoothing) — pays nothing until
  block-find. But FPPS is unavailable to a 2–50 miner pool anyway. Different product, not
  strictly inferior; a miner wanting a paycheck shouldn't use Heartwood.
- **vs PPLNS/Score:** worse on recency fairness (board ossifies; months-old rank-1 collects
  while productive late-joiners earn nothing) and amount-variance (single luckiest hash vs
  smoothed window). Better: no window ledger, non-custodial.
- **vs Ocean TIDES (closest sibling):** worse on amount-variance-given-a-win, on
  hop-resistance (window = structural vs finder-% = partial/tail-leaky), and TIDES's
  carry-forward guarantees eventual small-miner payment where Heartwood drops sub-dust to fee.
  Better: no carry-forward accounting (cleanest custody win) and a real jackpot (TIDES finder
  = 0%).
- **vs ckpool solo:** Heartwood better for the target use case (adds trickle; ckpool pays
  finder only). ckpool only lighter regulatorily + trivially simpler. Finder-% dial spans
  exactly ckpool(≈98%)→Ocean(0%).
- **vs Monero P2Pool:** solved small-miner starvation with *more* windowing
  (window+uncles+mini/nano) — opposite of beat-only. Heartwood avoids P2Pool's coinbase-bloat
  and orphan races (no sharechain: "leaderboard is accounting, not consensus") but inherits
  none of its smoothing.
- **vs Braidpool:** Heartwood better on custody (Braidpool FROST-custodies cross-block
  rewards); Braidpool better on decentralization + cross-block smoothing (UHPO). Heartwood's
  phase-2 borrows Braidpool's self-certifying-share lesson while avoiding its signing
  federation.

### 4.6 Net comparative verdict

A novel, internally-coherent, unoccupied design point — best-in-class custody (ties
Ocean/ckpool, beats all custodial), simplest accounting (no cross-block balances), preserved
jackpot (TIDES lacks), small-miner trickle (ckpool lacks). Right product for a 2–50 node
sovereignty pool. Both real weaknesses trace to the **beat-only/no-decay ruling**, not the
coinbase-split architecture: (1) amount-variance (best-share = maximally noisy hashrate
estimator) and (2) tail-hoppability (finder-% neutralizes mean-hopping but not heavy-tail
squatting). The §6.6 recommendation — keep best-share as the *gate*, split the pot by
since-round-start cumulative work — recovers most of TIDES's amount-fairness and Sybil/tail
resistance while honoring no-decay, and should be the v1 default rather than equal-split.

---

## 5. Edge cases

### 5.1 1000 × 1 TH/s vs N=10 — freeze-out CONFIRMED, worse in wall-clock

- ~11 distinct paid recipients/round. Coverage: 50% of miners in 67 rounds, 99% in 408, 100%
  in 627.
- But 1000×1 TH/s = 1 PH/s → 0.0584 blocks/yr = one block every 17.1 years. So "67 rounds to
  pay half" = **~1,150 years**. In any human timeframe the vast majority are never paid. The
  binding constraint is block cadence, not board size.
- EV per 1 TH/s = 0.000183 BTC/yr = $11.31/yr, realized as a ~1-in-17-years lump.

This is the edge-case face of correction C-7: §8's board-dynamics discussion is dominated by
a wall-clock cadence it does not mention.

### 5.2 Whale + Sybil (§6.5) — CONFIRMED

- Whale 90% + 10×1%: whale holds exactly 1.000 board slot (per-user aggregation caps it),
  P(rank-1)=0.899. Whale does NOT dominate the board. Under equal-split that 1 slot = 1/N of
  pot for 90% hashrate (the C-1 sub-proportionality).
- Sybil, equal-split, 50% share, N=2: captured pot k=1 → 0.376, k=2 → 0.461. Gain = 8.4
  pct-pts vs doc `pool_share/6 = 8.3%`. **CONFIRMED to the decimal.** (k=3 → 0.477, k=4 →
  0.483.)

### 5.3 Hopper slot survival (§6.4) — PARTIALLY CONTRADICTED (constant off by 1/ln2)

This is the evidence base for correction **C-2**. Hopper = 100 TH/s mined 1 day; ongoing pool
varies. Sim median vs doc `1.44·(H_hop/H_ong)·t`:

| H_ongoing | doc formula | sim median | sim mean |
|---|---|---|---|
| 500 TH/s | 6.9 h | 4.8 h | 2.5 d |
| 100 TH/s | 34.6 h (1.44 d) | 23.9 h | 15.2 d |
| 10 TH/s | 14.40 d | 9.98 d | 142.6 d (diverging) |

The doc constant 1.44 = 1/ln2 overstates the true median by exactly 1/ln2×. Clean result:
median survival = `(H_hop/H_ong)·t_mined` (no 1.44). Mean is infinite (Fréchet). Right order
of magnitude, wrong constant; squats are slightly LESS persistent than advertised — cuts in
the design's favor.

### 5.4 Beat-only ossification (§6.3) — CONFIRMED

- Age of rank-1 at block-find = argmax time of a running max = Uniform(0,1): mean 0.499,
  median 0.499. In a 1-year round the #1 is on average **6.0 months old**. CONFIRMED.
- Late-joiner displacement `P(new beats incumbent) = W_new/(W_new+W_inc)` — CONFIRMED to 3
  decimals: ratio 0.05→0.048, 0.10→0.092, 0.25→0.200, 0.50→0.332, 1.0→0.499, 2.0→0.666. A
  miner joining with 5% of an incumbent's accumulated work has <5% chance to displace them.

### 5.5 Dust — CONFIRMED non-issue at mainnet subsidy

1/N of a thin pot is orders of magnitude above the 294-sat (P2WPKH) dust relay limit at a
3.125 BTC coinbase; never binding. The `roll-to-fee` policy handles the rare theoretical case
without introducing carry-forward accounting.

### 5.6 Sizing `m_min` — the single-instance sybil qualifier (design §6.5 / §15 decision 3)

Design §15 decision 3 leaves `m_min` — the minimum-share-count / minimum-cumulative-work a
user identity must clear to hold a leaderboard slot — as "needs a concrete number." Here is
one, with the reasoning that bounds it.

**Scope it narrowly — two things you might reach for `m_min` to fix, it does not need to:**

- **Mean / finder capture is already splitting-invariant.** `P(rank-1 = i) = W_i/ΣW` is exactly
  invariant to identity-splitting (§3.1), so simple sybil never moves the finder leg or the
  rank-1 mean. `m_min` is not what protects the finder's expected take.
- **Amount capture is neutralized by the C-1 split fix.** Under the recommended
  since-round-start-work-proportional split, `k` identities holding the same total work collect
  the same total pot as one identity holding that work (§3.2 / C-1). Once work-prop is the
  default, splitting is EV-neutral in *amounts* too, `m_min` or no `m_min`.

**That leaves `m_min` exactly two jobs:**

1. **Top-N slot-squatting / board displacement.** Even with work-proportional *amounts*, a sybil
   that packs `k` of the `N` visible slots pushes `k−1` real small miners off the public board —
   and the board's entire product purpose is "something for small miners to chase between wins"
   (§6.7). Multi-slot occupation is also the only place the residual ~8%-class equal-split leak
   lives if equal-split is ever chosen (§5.2; design §6.5's accepted residual).
2. **Finder-gate / coinbase-output integrity.** Every qualifying identity is one leaderboard
   slot = one coinbase output (§5.7 schema, §7 N-problem). With no floor, one miner mints
   unlimited near-zero-work identities, each a dust-adjacent coinbase output, bloating the
   coinbase and diluting the gate. `m_min` makes each output cost real hashrate: an attacker with
   round-work `W` funds at most `W / m_min` outputs.

**The sizing tension is fundamental — the same one C-5 flagged for `meta_min_diff`.** `m_min`
trades slot-squat resistance against small-miner inclusion, and no fixed value wins both,
because honest per-round work spans a >1000× range. Worse, round length is **exponential** (a
round ends when the *pool* finds a block: `T ~ Exp(mean = D_net / H_pool)`), so a miner's
per-round work `W = h·T` is itself exponentially distributed, not concentrated. A miner at
pool-share `σ = h/H_pool` is on-board *at the moment the block lands* (has `W ≥ m_min` when the
round closes) with probability `exp(−m_min / (σ·D_net))`. Set `m_min` anywhere near a real
miner's *mean* per-round work `σ·D_net` and that probability collapses toward `e⁻¹ ≈ 0.37` —
freezing the marginal miner off the board 63% of the time.

**Recommendation — size `m_min` for inclusion, off the smallest miner you intend to serve, at
one-tenth of its mean per-round work:**

```
m_min = 0.1 · σ_min · D_net           (σ_min = h_min / H_pool ; D_net = network difficulty)
      = one-tenth of the smallest intended miner's expected per-round cumulative work.
```

Expressed as the "minimum share count" the setting literally names, that is `m_min / d_min`
accepted-share-equivalents at the vardiff floor `d_min`. Worked example — smallest intended
miner 50 TH/s in a 1 PH/s pool (`σ_min = 0.05`), `D_net = 127.17 T`: `m_min ≈ 0.005 · D_net ≈
6.4 × 10¹¹` difficulty-units of cumulative round work (~0.5% of one network block's worth of
work).

**Why one-tenth, and what breaks at 2× either way (sensitivity):**

- **Inclusion at 0.1×:** the marginal smallest miner is on-board when a block lands `e⁻⁰·¹ ≈
  90%` of the time; any miner ≥2× that size, `≥ e⁻⁰·⁰⁵ ≈ 95%`. The 10× margin below the
  mean-per-round-work cliff (where inclusion craters to 37%) is the whole point.
- **Sybil bound at 0.1×:** an attacker at pool-share `σ_evil` funds `k = σ_evil·D_net / m_min =
  10 · σ_evil/σ_min` identities — ten qualifying slots per smallest-miner-equivalent of hashrate
  it commands. `m_min` alone does **not** stop a whale packing slots (a 90% miner in a pool whose
  smallest member is 5% funds ~180 identities); it stops *free* phantom identities and bounds
  coinbase-output count. Slot-*count* is bounded by pairing `m_min` with the N cap (design §5.9,
  `N ≤ ~40`), per-user aggregation, and — in the F&F target deployment — operator social trust.
  This matches the standing position that the residual sybil leak is "bounded and accepted," not
  solved.
- **`m_min` 2× too HIGH (`0.2·σ_min·D_net`):** inclusion for the marginal miner drops to `e⁻⁰·²
  ≈ 82%`; sybil `k` halves. Tolerable, but every ~5-pt inclusion loss erodes the product's reason
  to exist for the smallest members. The danger is monotonic — stay well below `σ_min·D_net`.
- **`m_min` 2× too LOW (`0.05·σ_min·D_net`):** inclusion rises to `e⁻⁰·⁰⁵ ≈ 95%`; sybil `k`
  doubles (more phantom outputs / more board displacement). Backstopped by work-prop split + N
  cap, so the failure is graceful.

The number is therefore not knife-edge: a factor-of-2 error moves inclusion by ~5–8 pts and
phantom-identity count by 2×, both further absorbed by the C-1 split fix, per-user aggregation,
and the N cap. The one regime to avoid is `m_min ≳ σ_min·D_net`, which silently freezes small
miners — exactly the outcome the leaderboard exists to prevent. Note the symmetry with the
federation layer: C-5's `meta_min_diff` is this same lever one level up, sized off the smallest
*instance* rather than the smallest *miner*.

---

## 6. Federation analysis (Phase 2)

**Verdict up front:** the cryptographic core (self-certifying shares; trustless difficulty +
payout address; no custody) is sound. But three of §14's stated Phase-2 recommendations are
wrong or incoherent, all corrected in §2 above: (C-6) "fee averages out proportionally" is
true only on a geological timescale; (C-3) §14.5's claim that summed-work is "splitting-neutral
unlike best-share" is false — neutrality lives in the split rule; (C-4) per-instance rounds +
a federation meta-board is incoherent. Federation is R&D-stage, so these land before any
build.

### 6.1 Scenario & block/fee timescale

Federation = 3.80 PH/s (1×2 PH/s = 52.6%, 3×500 TH/s = 39.5%, 6×50 TH/s = 7.9%). At 850 EH/s
network:

| entity | hashrate | solo block cadence |
|---|---|---|
| whole federation | 3.80 PH/s | **1 block ≈ every 4.3 yr** |
| big instance | 2 PH/s | every **8 yr** |
| mid instance | 500 TH/s | every **32 yr** |
| small instance | 50 TH/s | every **323 yr** |

(700 EH/s → 3.5 yr fed; 1000 EH/s → 5.0 yr.) The whole premise of federation is here: a 50
TH/s instance solo-finds once every ~3 centuries, so its miners only ever get paid because
the *federation* finds a block every ~4 yr and the meta-board pays them from a bigger
instance's coinbase. **Legitimate motivation** — this is the reason federation exists at all.

**Fee revenue under finder-instance-takes-all** — this is correction **C-6**; see §2 for the
convergence table and the 73%-chance-of-zero-fee-after-100-yr Monte-Carlo result.

### 6.2 Meta-sybil — attacking §14.5

This is the evidence base for correction **C-3**. See §2 (C-3) for both simulation tables
(max pot fraction captured; splitting-incentive isolated). The core finding restated:

**§14.5 has the ranking-vs-split axis backwards.** best-share+equal over-extracts only
modestly (1.02–1.25×) — its real problem is variance/squatting, not mean. summed-work +
**equal-split** — the design's *own* v1 default (§5.9) — is the **most exploitable combination
tested** (1.4–2.3×, 94% of the pot at x=0.5): summed-work makes slot-occupation cheap and
deterministic, and equal-split pays every packed slot equally. **Splitting-neutrality is a
property of the SPLIT rule, not the ranking gate** — pot split *proportional to summed-work*
(the §6.6 intra-instance recommendation, never carried into §14.5) collapses the splitting
gain to near-zero at minority evil sizes.

**Slot cap M — two problems the doc understates** (correction **C-5**): (a) it penalizes the
*honest* whale — the legitimate 2 PH/s instance (52.6% fair) is capped at 0.30 of the pot
under M=3; M can't distinguish evil-splitting from a genuinely large instance. (b) it's
defeated by instance-level sybil: M is enforced per `instanceId = sha256(pubkey)`, which is
free to mint; an evil operator runs `⌈s/M⌉` instance identities and recovers full uncapped
capture. **The real Sybil root is invite-gated instance admission** — `FEDERATION-SCOPE.md`
F4/F3 already require an issued invite + out-of-band fingerprint confirm to admit an instance.
If meta-mining reuses that gate, minting an instanceId costs a human invite and M becomes
meaningful; if it accepts un-invited gossip, M is worthless. **This linkage is the
load-bearing fact §14 omits.** Also: best-share imports §6.3's `E[best share]=∞` squatting
into a meta-context with no reset and no revocation (append-only self-certifying gossip) — a
single lucky foreign share squats every instance's board for months. Decisive reason to drop
best-share at the meta layer.

**Net:** the meta-board needs **all four** — summed-work ranking + proportional-to-work split
+ cap M + invite-gated admission. The doc names two, gets one's rationale inverted, and omits
the two that carry the weight.

### 6.3 The five §14.7 open questions — answered

- **Q1 (board consensus w/o ledger):** Not Byzantine — it's accounting, not money. Board =
  pure deterministic `rank(shares)` over a full-mesh-flooded self-certifying share set; two
  instances with the same set compute an identical board with zero coordination (Monero-P2Pool
  precedent: every template embeds the whole window, verified locally). **Cut** the
  Braidpool-style DAG (it exists to settle funds/kill orphan races; nothing to settle here).
- **Q2 (template honesty):** Omission of rival shares is **detectable, not preventable**
  (can't prove a negative from a coinbase). Full-mesh flooding lets every instance detect X's
  found block underpaying known-valid shares → reputation/eviction (which invite-gated
  admission enables). Add a commit-to-board-Merkle-root in the existing OP_RETURN to make
  dishonesty cryptographically attributable. Accept one under-pay before eviction; blast
  radius bounded, never funds.
- **Q3 (meta min-difficulty):** Static (not retargeting — P2Pool's retarget race was a death
  cause) floor `meta_min_diff` sized so even the 2 PH/s instance emits ~O(1) qualifying
  share/sec. Doubles as §6.5's `m_min` sybil lever (caps fake users at
  `W_evil/meta_min_diff`). Size off the *smallest* intended instance or you freeze the 50 TH/s
  instances off the board.
- **Q4 (rounds):** Global on-chain round — this is correction **C-4**; see §2.
- **Q5 (param consensus):** **Finding-instance's params govern its own block** (matches
  finder-takes-all, needs no consensus): a block found by A pays A's finder `f_A`, A's fee,
  meta-board out of A's `leaderboardPct_A`. Pin only the *ranking-affecting* params
  federation-wide (N, min-diff, ranking/split fn — these MUST match or boards diverge); leave
  f/fee local. Payout-varies-by-finder is just hash-hopping pressure, which Alex's decision 10
  declares a feature.

### 6.4 Rounds incoherence (the core defect)

This is the full statement of correction **C-4**. Per §14.5, rounds are per-instance; a found
block resets only that instance's board. But the meta-board is federation-wide. When instance
A finds a block: either (i) A's shares stay live on everyone's meta-board until B finds → a
miner at A gets paid at A's block *and again* at B's block for one round's work (double-count),
or (ii) A's shares purge from everyone's board → a purely local event at A silently craters
A-miners' standing inside B's mid-round template for reasons a B-observer can't see. **There
is no single round clock, so "the shares live right now" is undefined federation-wide. As
stated, the meta-board has no well-defined contents.**

**Fix — federation-global round keyed on on-chain block observation:** define the round
boundary as "any federation instance's block confirming on the Bitcoin chain." This is
**self-certifying and globally observable with zero consensus** — every instance already runs
a `TipPoller`, and a federation block carries the `OP_RETURN {magic, instanceId}` tag. On that
event, every instance resets the meta-board simultaneously (keyed on block height/hash). One
clock; globally consistent standing. Local intra-instance boards stay per-instance/best-share
per Alex's ruling. **The Bitcoin blockchain *is* the shared ledger of "when did a federation
block happen"** — supplied free, no shared-ledger violation. Highest-priority change; the tip
watcher and OP_RETURN seam already exist.

### 6.5 Failure modes

| mode | outcome | severity | mitigation |
|---|---|---|---|
| **Offline slot-squatting** | Dead instance's shares are immortal (no local block resets them, gossip has no revocation) → its slots persist in everyone's templates forever | **High** | Global on-chain round (§6.4/C-4) clears them at the next federation block; optional liveness-expiry (breaks strict no-decay, but only at meta layer where that ruling never applied) |
| **Gossip partition** | Divergent share sets → divergent boards; a block in partition P pays P's view | **Low** | No custody; ~4-yr cadence makes a partition outliving a block-find astronomically unlikely; heals automatically (shares additive) |
| **Param divergence (f=50% vs 20%)** | Same board member earns 1.6× more when the generous instance finds | **Low-Med** | Coherent under "finding-instance governs" (Q5); the variance is hash-hopping pressure = Alex's declared feature |
| **Tor latency vs 20s debounce** | Share propagates in seconds; debounce ≥20s; board only cashed at a block every ~4 yr | **Negligible** | Latency < debounce; staleness on a board cashed once per several years is irrelevant. Real risk is outage→partition (above). Correctly avoids P2Pool's latency-sensitive sharechain |

Every failure is bounded by two facts the design gets right: **no custody** (worst case =
misallocated slots) and **block-cadence-of-years** (neutralizes latency/partition/staleness).
The two that bite (immortal slots, incoherent rounds) are **both fixed by the single
global-round change** (C-4).

### 6.6 Federation verdict & minimum change-set

**Viable as R&D, not build-ready; the core is sound and the fixes are small and mostly
already-scoped.** Keep: self-certifying shares, no-custody, invite-gated Tor transport, the
years-cadence that neutralizes latency.

**Minimum change-set (priority order):**

1. **Global round reset on on-chain federation-block observation** (C-4/§6.4) — fixes rounds
   incoherence *and* immortal-dead-slots in one move; nearly free.
2. **Meta-board = summed-work ranking + proportional-to-work split** (not equal-split, which
   is the worst option tested at the meta layer — C-3).
3. **Invite-gated instance admission as Sybil root** (reuse F4/F3) — without it, cap M is
   defeated by free instanceId minting (C-5).
4. **Cap M + static `meta_min_diff`** sized off the smallest instance (min-diff doubles as
   DoS floor and `m_min`).
5. **Pin ranking-affecting params** (N, min-diff, ranking/split fn) federation-wide; leave
   f/fee local (Q5-C).
6. **Reframe the fee model honestly** — small instances get ~no fees ever (C-6).

**Cut:** best-share at the meta layer (infinite-variance squatting, no reset/revocation);
per-instance rounds for the meta-board; any Braidpool DAG/sharechain (settles nothing here);
the "fee averages out" reassurance.

None of the fixes needs new consensus machinery — the Bitcoin blockchain and the existing
invite gate supply every shared truth the meta-board requires. §14 as written has one
incoherence (rounds), one inverted claim (summed-work neutrality), one omitted load-bearing
dependency (invite-gated admission), and one over-sold promise (fee averaging); all four are
fixable. Recommend updating §14.5/§14.7 with these results before this is ever scheduled,
behind both the phase-1 legal gate and the `federation_enabled` networking gate.

---

## 7. Legal analysis

> **NOT LEGAL ADVICE** — research-grade risk mapping from public authority, for Alex to take
> to counsel. Considerations, not conclusions. Two exposure layers are analyzed separately:
> **Layer A** = the instance operator (a hobbyist running the pool for friends/family);
> **Layer B** = Alex, the non-operating open-source publisher of the software.

### 7.1 Bottom line (risk picture)

The design's zero-custody, coinbase-direct posture is legally strong and lands on the
favorable side of every controlling US authority (FinCEN FIN-2019-G001's pool-operator split
and four-factor "total independent control" test, the 2014 miner rulings, and the 2025 DOJ
non-enforcement posture). No US mining pool — custodial or not — has ever been enforced
against for money transmission; enforcement has only ever hit *custodial* mixers/exchangers.
The two facts that erode the otherwise-clean posture are that the operator **sets third-party
percentages** and **takes a fee output** — enough to make split mode "arguable" where solo
mode is "clearly clear." The real risk dial is not the split feature but **stranger-facing
public scale**: friends-and-family / single-jurisdiction is low-risk across the board; a
public, multi-state, fee-taking pool triggers a 50-state MTL problem (NY the worst) that is
the only place exposure becomes genuinely large. Alex's own exposure as *publisher* (Layer B)
is the best-protected layer of all — a neutral tool with a dominant legitimate purpose, no
anonymizing function, no illicit-finance nexus, unlike Tornado Cash/Samourai which were
prosecuted on intent + laundering facts. The sleeper item that bites regardless of custody or
scale is **operator tax**: the fee output is taxable income the instant it's taken, with zero
enforcement discretion. The design's mitigations (published %s, opt-in, acknowledgment, no
carry-forward) are all sound — strengthen with miner-selected splits, a hard fee cap, and
jurisdictional gating.

**Top counsel questions** (developer/publisher exposure split into the two independent
questions it actually contains, 3a and 3b):

**1.** Does an operator who sets third-party coinbase percentages and takes an on-chain fee,
but never takes custody, stay outside both the federal MSB definition and the operator's
home-state MTL? (Written FIN-2019-G001 four-factor analysis.)

**2.** Which states (NY/CA especially) must be geofenced before *any* stranger-facing launch,
and how different is F&F vs public exposure?

**3a.** *(prosecutorial posture — does it reach the publisher, and will it last?)* Does the
2025 DOJ non-enforcement posture — the **Blanche Memo (Apr 7, 2025)** and the **Galeotti
declination guidance (Sept 2025)** — actually protect a non-custodial pool-*software* publisher
who never operates the pool or takes custody? And how durable is that protection, given it is
charging-policy discretion (alongside the **NY DFS software-dissemination carve-out**), not a
statutory safe harbor — i.e. how exposed is it to reversal by a future administration?

**3b.** *(residual statutory exposure, independent of charging policy)* Does the still-standing
§1960 conviction in ***US v. Storm*** leave residual *developer* exposure that survives any
favorable enforcement posture — is the risk a matter of law (statutory, and therefore not
removed by any DOJ climate), or purely prosecutorial discretion that the current posture
already addresses?

**4.** *(weight of unchallenged prior art)* Ocean (TIDES / DATUM), the closest real-world
coinbase-embedded non-custodial payout, has **no discoverable public legal or regulatory
statement of its money-transmitter status** — only generic industry commentary (§7.4). Does its
unchallenged public US operation carry any legal weight, or is it legally irrelevant? ("Ocean
already does this" is not usable cover — see §7.4.)

### 7.2 US Federal — FinCEN / BSA

Money transmitter (31 CFR 1010.100(ff)) requires **both acceptance AND transmission** of
value. **FIN-2019-G001 (May 9, 2019)** is favorable on three independent grounds:

- **Miners for own account are not MSBs** — mining "solely for the user's own purposes and not
  for the benefit of another … involve[s] neither 'acceptance' nor 'transmission.'" (The
  shipped solo pool sits squarely here.)
- **Pool-operator split:** NOT a transmitter where the operator "merely transfers CVC earned
  to the pool members" (integral-to-another-service exemption, (ff)(5)(ii)(F); and in
  coinbase-direct the operator never *accepts* the value). IS a transmitter where it "also
  hosts wallets on behalf of the pool members" (account-based/custodial).
- **Four-factor test:** (a) who owns value, (b) where stored, (c) whether owner interacts
  directly with the payment system, (d) whether intermediary has "total independent control." A
  coinbase-direct pool fails *every* prong that would make it a transmitter — miners own the
  outputs, value is on-chain in the block, PoW interacts directly with the network, operator
  has no independent control.

"Directing coinbase output composition" is best read as **not** acceptance+transmission
(analogous to Ocean/DATUM template authority and a payment instruction). **Weakness:** setting
third-party percentages + taking a fee is more operator-like than solo, moving from "clearly
not a transmitter" to "arguable." 2014 rulings reinforce: FIN-2014-R001 (mining for self = not
a transmitter); FIN-2014-R007 (renting mining capacity, benefiting only from fees = exempt
delivery/communication/network-access services).

**Enforcement 2019–2026:** none ever against a mining pool. Only custodial mixers/exchangers
(Helix/Harmon, BTC-e). **DOJ Blanche Memo (Apr 7, 2025):** stop "regulation by prosecution";
no §1960/BSA regulatory charges absent knowledge + willfulness. **DOJ Sept 2025 (Galeotti):**
decline §1960 charges where software "is truly decentralized and solely automates
peer-to-peer transactions, and where a third party does not have custody and control." Most
favorable federal climate to date — but discretion, not statutory safe harbor.

### 7.3 State MTL — the real exposure, fragmented

Custody/control axis governs; coinbase-direct doesn't "receive value for transmission."
URVCBA "control" test — operator has none. **Low-risk states:** Wyoming, Montana (no MTL
law), control-test states. **Aggressive — NY (BitLicense + Art. 13-B):** favorable that NY
DFS says "software development or dissemination by itself is not virtual currency business
activity" (protects Layer B), but a NY-resident operator setting percentages + taking a fee,
stranger-facing, is the single highest-risk scenario here. California DFAL (2026) and others
tightening. Public multi-state = 50-state analysis, must clear the strictest state.

### 7.4 Precedent

**Ocean (TIDES/DATUM)** — non-custodial coinbase payout was partly a deliberate legal-design
choice ("your bitcoin never touches OCEAN's wallet … payouts come directly from the coinbase
transaction"); direct precedent, operated publicly in the US with no enforcement.
**FPPS/custodial pools** pay from pool wallets = the account-based transmission FIN-2019-G001
flags; Heartwood avoids this. No enforcement against any pool, ever.

**Caveat — "Ocean already does this" is not usable legal cover.** There is **no discoverable
public legal or regulatory statement of Ocean's money-transmitter status** — no FinCEN
administrative ruling, no state MTL determination, no litigated holding, only generic industry
commentary about its non-custodial design. Unchallenged public operation is *absence of
enforcement*, not *endorsement*: it establishes that no regulator has yet acted, not that a
regulator has blessed the model. It is weak evidence (a favorable data point on the enforcement
climate, §7.2) and must not be leaned on as precedent. The design's actual protection has to
rest on its own non-custodial-by-construction posture measured against FIN-2019-G001's
four-factor test (§7.2), plus independent counsel — not on Ocean's example. This is counsel
question 4 in §7.1.

### 7.5 Facts that matter + Layer B

**Help:** zero custody, no operator balance, **no carry-forward accounting** (§6.8 —
load-bearing, keep it), published open-source-default %s + opt-in + acknowledgment, every
miner is own finder. **Hurt:** operator sets third-party %s; operator takes a fee output.
**Tax (Layer A):** fee = ordinary income at FMV on receipt; hobby (Schedule 1, no SE tax, no
deductions) vs business (Schedule C, 15.3% SE tax on net >$400) turns on scale/continuity/
profit motive; 1099-DA (2025/26) auto-reports disposals. Most-likely-to-bite item.

**Layer B (Alex) — best-protected:** FIN-2019-G001 (tools/software ≠ accept+transmit), NY DFS
software-dissemination carve-out, DOJ 2025 neutral-tool posture. Climate: **Tornado
Cash/Storm** convicted Aug 2025 on §1960 conspiracy, hung on ML/sanctions; acquittal motion
pending (~Apr 2026), retrial sought (~Oct 2026) — §1960 conviction stands, the cautionary
point. **Samourai** — DOJ dropped the §1960(b)(1)(B) charge post-Blanche, defense sought
dismissal citing FinCEN's own 2023 "likely not a transmitter" assessment; trending toward
dismissal/reduction (confirm final disposition). Both were *mixing tools prosecuted on
laundering intent* — a mining-payout tool has a dominant legitimate purpose and no
illicit-finance nexus, so Alex's risk is low, not zero.

### 7.6 Non-US

**EU MiCA** (in force Dec 30 2024; transition ~Jul 1 2026): mining out of scope (BTC has no
issuer); MiCA regulates CASPs — non-custodial payout is a weak fit, but "transfer services on
behalf of clients" is a defined CASP activity, so an EU fee-taking operator should get local
advice; publishing (Layer B) isn't a CASP activity. Hostile: ban/mining-hostile regimes →
jurisdictional gating matters more than any single country.

### 7.7 Risk matrix

**Case A (friends-and-family, single jurisdiction, small fee):**

| Risk | Likelihood · Impact → Net |
|---|---|
| Federal MSB | Low · High → Low-Med |
| State MTL | Low · High → Low-Med |
| **Operator tax** | **High · Low-Med → Med (bites regardless)** |
| Developer (Alex) | Low · Med-High → Low |
| Securities | negligible |

**Case B (public, stranger-facing, multi-state, larger fee):**

| Risk | Likelihood · Impact → Net |
|---|---|
| **State MTL** | **Med-High · High → HIGH (binding constraint)** |
| Federal MSB | Low-Med · High → Med |
| Operator tax | High · Med → Med-High |
| Developer (Alex) | Low · Med-High → Low-Med |
| Securities | negligible |

Gradient driven by custody (zero — good) and public-stranger scale (the dial), not the split
feature.

### 7.8 Legal mitigations

Keep all current ones (flag + acknowledgment, published %s, opt-in, no carry-forward, counsel
gate). **Add:**

1. **Miner-selected splits** over operator-selected — strongest structural fix to the
   "operator sets third-party %" weakness.
2. **Hard-cap the fee %** in code, default ~2%.
3. **Jurisdictional gating / geofencing guidance** (steer away from NY/hostile jurisdictions
   for stranger-facing; make F&F the blessed default).
4. **In-product operator tax notice.**
5. Prominent "not a custodian, network pays you directly" miner disclosure.
6. Keep solo-mode hard gate as default.

### 7.9 Key sources

FIN-2019-G001 (fincen.gov/system/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf);
FIN-2014-R001 & R007; Kelman PLLC (four-factor + pool-operator); Ocean TIDES/DATUM docs;
Dechert (URVCBA); NY DFS + innreg (BitLicense software carve-out); MoFo & Greenberg Traurig
(Blanche Memo); fintechanddigitalassets.com + WilmerHale (DOJ Sept 2025 Galeotti); Mayer
Brown + Money Laundering Watch + DeFi Education Fund (Storm); CoinDesk (Samourai); ESMA +
Norton Rose Fulbright (MiCA); TokenTax + Klasing (mining tax).

---

## 8. Economic viability

This is the full statement of correction **C-7**. Real mid-2026 numbers (~900 EH/s network,
difficulty 127.17 T, 3.125 BTC subsidy, ~$62,000 BTC):

| Pool | E[time/block] | blocks/yr | Operator fee $/yr (2%) | P(≥1 block in 1 yr) | 1 TH/s EV $/yr |
|---|---|---|---|---|---|
| 10 TH/s | 1,712 yr | 0.0006 | $2.26 | 0.06% | $11.32 |
| 100 TH/s | 171 yr | 0.0058 | $22.63 | 0.58% | $11.31 |
| 1 PH/s | 17.1 yr | 0.0584 | $226 | 5.7% | $11.31 |
| 10 PH/s | 1.7 yr | 0.584 | $2,263 | 44% | $11.31 |
| 100 PH/s | 62.5 d | 5.84 | $22,630 | 99.7% | $11.32 |

**Headline economics:**

- The leaderboard pays only when the pool finds a block → payouts arrive on the same cadence
  as E[time/block]. Below ~1 PH/s that cadence is decades to millennia.
- Minimum pool hashrate for a human-relevant (E ≤ 1 yr) block: **~17 PH/s**. At 5 yr: 3.4
  PH/s; at 10 yr: 1.7 PH/s.
- Operator break-even vs home-node hosting ($20–50/mo): the 2% fee only covers hosting at
  ~1.06 PH/s ($20/mo) to ~2.65 PH/s ($50/mo). Below ~1 PH/s the operator runs at a loss on
  fee revenue — i.e. essentially all friends-and-family deployments. **The fee is
  cost-recovery at best, not a business.**
- 1 TH/s EV ≈ $11.3/yr at every pool size — the pool changes variance, not EV (as §6.7
  states). Product value = variance-smoothing + the trickle, not extra yield.

**Implication for the design's framing:** §8 ("few vs many miners") discusses board dynamics
without the wall-clock block cadence that dominates everything. The design is economically
coherent only at ≥1–10 PH/s pooled — beyond a literal "few friends with a couple ASICs." This
should be stated next to the "few vs many miners" section. Note this does not undermine the
product thesis (variance-smoothing + trickle for a sovereignty-minded group); it bounds where
that thesis is honest.

---

## 9. Recommendations for Alex

Ranked, each mapped to the design-doc section it would amend. These are research
recommendations, not decisions — and every one is framed to respect Alex's fixed rulings in
§2. Where a recommendation touches an area §2 governs, it is written as *compatible with* the
ruling (never an override); the one genuine tension is flagged explicitly.

### (a) v1 design amendments

**A-1. Make since-round-start-work-proportional split the v1 default.** *Amends §5.9, resolves
§15 decision 4.* This is the single highest-leverage change and three workstreams converge on
it. Evidence: C-1 / §3.2. **Compatible with Alex's rulings:** it changes only the pot
*amounts*, never the best-share *gate* (decision 3) and never introduces a window, aging, or
decay (decision 4) — "since-round-start work" is a running sum from round-open. It keeps
everything percentage-based (decision 6). Keep equal-split as a documented, opt-in
small-miner-subsidy alternative, framed honestly as a rule that taxes large miners ~43% of EV.

**A-2. Fix the survival constant.** *Amends §6.4.* Replace `1.44 × (H_hop/H_ong) × t` with
`(H_hop/H_ong) × t_mined` (median; mean infinite). Evidence: C-2 / §5.3. Mechanical
correction; favors the design (squats less persistent than advertised).

**A-3. Add economic-scale honesty to the docs.** *Amends §7/§8.* State that the design is
economically coherent only at ≥1–10 PH/s pooled, that the 2% fee only covers a $20/mo node
above ~1 PH/s, and that below ~1 PH/s leaderboard payouts are decade-to-millennium events.
Evidence: C-7 / §8. Honesty framing in the doc's own "honest costs" voice; not a design change.

**A-4. Set `m_min = 0.1 · σ_min · D_net`.** *Resolves §15 decision 3; amends design §6.5.*
Size the minimum-share-count / minimum-cumulative-work qualifier at **one-tenth of the smallest
intended miner's expected per-round work** (`σ_min = h_min/H_pool`, `D_net` = network
difficulty). Full derivation and sensitivity: §5.6. **Rationale:** once the C-1 work-prop split
is the default, splitting is EV-neutral in amounts and `P(rank-1)` is splitting-invariant, so
`m_min`'s only remaining jobs are bounding top-N slot-squatting/board-displacement and keeping
each coinbase output backed by real work — not defending the mean. Because round length is
exponential, per-round work is exponentially distributed; 0.1× keeps the marginal smallest
miner on-board ~90% of the time (vs the `e⁻¹ ≈ 37%` cliff at `m_min ≈ σ_min·D_net`) while
bounding an attacker to `k = 10·σ_evil/σ_min` phantom identities. A factor-of-2 error moves
inclusion by only ~5–8 pts; the regime to avoid is `m_min ≳ σ_min·D_net`. **Compatible with
Alex's rulings:** it is a qualification gate on the *entrants*, not a change to the best-share
ranking (decision 3) or the no-decay rule (decision 4); it is a structural companion to A-1,
not a substitute. `m_min` remains a *secondary* mitigation — per-user aggregation, the N cap,
work-prop amounts, and F&F social trust carry the primary load, and the residual leak stays
"bounded and accepted" per design §6.5.

### (b) Federation §14 amendments (the 6-item minimum change-set)

All of these are R&D-stage and land before any federation build. They amend §14.5/§14.7.
Evidence: §6.

**B-1. Global round reset on on-chain federation-block observation** (highest priority) —
fixes the rounds incoherence (C-4) *and* the immortal-dead-slot failure mode in one nearly-free
move. The Bitcoin blockchain supplies the shared "when did a federation block happen" clock;
no new consensus machinery. **Compatible with Alex's rulings:** local intra-instance boards
stay per-instance/best-share per decisions 3–5; this is a meta-layer clock only.

**B-2. Meta-board = summed-work ranking + proportional-to-work split** (not equal-split) —
corrects the inverted §14.5 neutrality claim (C-3). Summed-work + equal-split is the *most*
exploitable combination tested.

**B-3. Invite-gated instance admission as the Sybil root** (reuse `FEDERATION-SCOPE.md`
F4/F3) — the load-bearing dependency §14 omits (C-5). Without it, cap M is worthless.

**B-4. Cap M + static `meta_min_diff`** sized off the smallest intended instance (min-diff
doubles as DoS floor and `m_min` sybil lever).

**B-5. Pin ranking-affecting params** (N, min-diff, ranking/split fn) federation-wide; leave
f/fee local (finding-instance governs its own block). Payout-varies-by-finder is hash-hopping
pressure — **which Alex's decision 10 explicitly declares a feature**, so this is compatible.

**B-6. Reframe the fee model honestly** — small instances collect ~no fee, ever; run one for
sovereignty, not fee income (C-6). Cut the "averages out" reassurance.

### (c) Legal posture

*Amends §13; adds to §5.9's acknowledgment flow. NOT LEGAL ADVICE — for counsel.* Evidence:
§7. Keep all current mitigations. **Add:** (1) miner-selected splits over operator-selected —
strongest structural fix to the "operator sets third-party %" weakness, and it happens to
align with A-1's shift of control toward the miner; (2) hard-cap the fee % in code, default
~2%; (3) jurisdictional gating/geofencing guidance (F&F as the blessed default; steer
stranger-facing away from NY/CA/hostile); (4) in-product operator tax notice (the fee is
ordinary income on receipt — the item most likely to bite). **Counsel questions** (the five
from §7.1, numbered 1/2/3a/3b/4): (1) federal MSB + home-state MTL status of a
percentage-setting, fee-taking, non-custodial operator; (2) which states to geofence before any
stranger-facing launch; (3a) whether the 2025 DOJ posture (Blanche/Galeotti) reaches a
non-custodial pool-*software publisher* and how durable that charging-policy discretion is;
(3b) whether the standing *Storm* §1960 conviction leaves *statutory* developer exposure that
survives any favorable posture; and (4) whether Ocean's unchallenged public operation carries
any legal weight (it has no public MTL determination — not usable cover). **Compatible with the
design's existing posture:** these strengthen, they do not replace, §13's off-by-default / flag
/ acknowledgment / opt-in / counsel-gate stance.

### (d) Explicitly out of scope / unchanged

These respect Alex's fixed §2 rulings and are **not** recommended for change:

- **Beat-only, no-decay ranking (decisions 3, 4)** stays. Every recommendation above is built
  to honor it. The honest costs of beat-only (heavy-tail squatting, months-old #1,
  late-joiner freeze-out) are confirmed real (§5.4) but are Alex's owned tradeoff, not a
  proposal to change. Flagged tension, not override: the comparative and simulation
  workstreams note that a *window* would structurally defeat tail-hoppability where finder-%
  only mitigates it — this is surfaced as information, and the design's own §6.3 already owns
  it.
- **Finder gets the largest percentage (decision 2)** and **per-miner templates (decision
  1)** stay — unaffected by any recommendation here.
- **Everything percentage-based / no fixed-sat payouts (decision 6)** stays — A-1's
  work-proportional split is percentage-based by construction.
- **Centralized template construction (decision 9)** and **real-time updates (decision 8)**
  stay — the analysis touches economics and payout math, not the engine's INV-1…INV-9
  structure, which the design already specifies soundly.
- **Hash-hopping between instances is a feature (decision 10)** stays — and B-5 leans on it
  positively (payout-varies-by-finder = declared-feature hopping pressure).
- **Finder-% default (§15 decision 1, 40% vs 50%)** — unchanged by this analysis. Both are
  in-range; the finder % is confirmed a variance/loyalty dial, not an EV lever (§3.3), so the
  40-vs-50 choice is a pure preference call with no correctness content. Alex's stated 50% is
  fine.
- **Operator fee 2% (§15 decision 5)** — unchanged; matches Ocean and ckpool precedent, and
  the legal mitigation only asks to hard-*cap* it, not lower it.

---

**Amendment pass — 2026-07-18.** Three gaps closed against the original analysis: (1) a
concrete `m_min` proposal with derivation and sensitivity (new §5.6; recommendation A-4;
resolves design §15 decision 3); (2) legal counsel question 3 split into **3a** (durability and
publisher-reach of the 2025 DOJ non-enforcement posture) and **3b** (residual *statutory*
developer exposure from the standing *US v. Storm* §1960 conviction), plus a new question 4 and
a §7.4 caveat that Ocean's unchallenged operation is not usable legal cover; (3) an honest
simulation-provenance caveat (top-of-doc block and §3) noting the Monte-Carlo code was never
checked in and no longer exists — findings stand, reproducibility is tracked as **`cairn-l1zu.23`**.
No findings were retracted or softened.

*End of research analysis.*
