# Coinbase-Payout Mining Pool — Analysis Addendum (2026-07-19)

**Status: RESEARCH ADDENDUM to `docs/COINBASE-POOL-ANALYSIS.md` and `docs/COINBASE-PAYOUT-POOL-DESIGN.md`.**
Implementation remains gated on `cairn-vn43.14` / epic `cairn-l1zu` (legal gate `cairn-l1zu.1`).
Nothing here authorizes a build, reverses the gate, or overrides Alex's fixed §2 rulings.

> **What this adds.** The 2026-07-18 analysis proposed `m_min = 0.1·σ_min·D_net` (§5.6 / rec
> A-4) and a since-round-start-work-proportional split (C-1 / §6.6), and laid out the 6-item
> federation change-set (§6.6). This addendum stress-tests the `m_min` floor with a fresh,
> **seeded, reproducible** Monte-Carlo (unlike the original sims, whose code was never checked
> in — the `cairn-l1zu.23` provenance gap); pins down the exact rounding/tie-break rules for
> the work-prop split; re-examines the federation interactions with those two mechanisms; gives
> `cairn-l1zu.22` a concrete meta-leaderboard design sketch; and ships a provenance appendix so
> at least this addendum's numbers can be re-run. All new sim code lives in the session
> scratchpad (not the repo — see §6 for the in-repo-preservation recommendation, which is the
> orchestrator's call, not this addendum's).

---

## Table of contents

1. `m_min` sensitivity analysis (Monte-Carlo)
2. Work-proportional split — exact edge-case & rounding rules
3. Federation §14 interactions with `m_min` and work-prop split
4. `cairn-l1zu.22` — meta-leaderboard design sketch (design-only)
5. `cairn-l1zu.23` — simulation provenance (methodology, seeds, formulas)
6. Bead status & Alex-decision items

---

## 1. `m_min` sensitivity analysis

### 1.1 Model and the one number that governs everything

From analysis §5.6: a round closes when the **pool** finds a block, so round total pool work
is `Exp(mean = D_net)`, and a miner at pool-share `σ_i = h_i/H_pool` accrues per-round work
`W_i ~ Exp(mean = σ_i·D_net)`. The miner holds a board slot at round close iff `W_i ≥ m_min`,
so

```
P(on board) = exp( − m_min / (σ_i · D_net) ) = exp(−c_eff),
c_eff = m_min/(σ_i·D_net) = COEF · (σ_min/σ_i) · (D_net0/D_net)   for m_min = COEF·σ_min·D_net0.
```

**Every stress reduces to how far `c_eff` drifts from the nominal `COEF = 0.1`.** The MC (4M
Exp(1) draws/cell, seed 20260719) confirms `exp(−c)` to ≤3.8×10⁻⁴ absolute across
`COEF ∈ {0.05…1.0}` — so the closed form is exact and the sensitivity question is purely
"what moves `c_eff`, and how gracefully does `exp(−c_eff)` respond."

At the design point (`σ_i = σ_min`, `D_net = D_net0`): inclusion `= exp(−0.1) = 90.5%`.

### 1.2 Stress 1 — network-difficulty swing ±50% over an epoch, `m_min` held static

If `m_min` is frozen as a difficulty-unit constant at config time and `D_net` drifts, the
effective coefficient moves as `c_eff = 0.1·(D_net0/D_net)`. **Rising difficulty lengthens
rounds → miners accrue more work → inclusion rises; falling difficulty is the harmful
direction.**

| `D_net/D_net0` | `c_eff` (marginal) | incl. marginal | incl. 2× miner | incl. 5× miner |
|---|---|---|---|---|
| **0.50** | 0.200 | **0.819** | 0.905 | 0.961 |
| 0.75 | 0.133 | 0.875 | 0.936 | 0.974 |
| 1.00 | 0.100 | 0.905 | 0.951 | 0.980 |
| 1.25 | 0.080 | 0.923 | 0.961 | 0.984 |
| **1.50** | 0.067 | **0.936** | 0.967 | 0.987 |
| 2.00 | 0.050 | 0.951 | 0.975 | 0.990 |

**Headline:** a ±50% single-epoch difficulty swing moves the marginal (smallest) miner's
board-inclusion only within **81.9% … 93.6%** (from the 90.5% baseline). The swing is
**asymmetric** — falling difficulty costs ~8.6 pts, rising difficulty gains only ~3.1 pts —
but across the entire ±50% band `c_eff` stays in **[0.067, 0.20]**, an order of magnitude below
the `c_eff ≈ 1` cliff where inclusion craters to 37%. **A single difficulty epoch's swing is a
non-event for the floor.** The original §5.6 "factor-of-2 error moves inclusion by ~5–8 pts"
claim is confirmed and, if anything, conservative for the difficulty axis specifically.

### 1.3 Stress 2 — `σ_min` mis-sizing (the operator guessed the smallest miner wrong)

`m_min` is pegged to `σ_min` = "the smallest miner you intend to serve." A miner of actual size
`r × σ_min` sees `c_eff = 0.1/r`:

| `r = σ_actual/σ_min` | `c_eff` | inclusion | |
|---|---|---|---|
| 0.25 | 0.400 | **0.670** | below design point — degrading |
| 0.50 | 0.200 | 0.819 | below design point |
| 1.00 | 0.100 | 0.905 | design point |
| 2.00 | 0.050 | 0.951 | above — comfortably included |
| ≥5.00 | ≤0.020 | ≥0.980 | above — effectively always on |

**Miners at or above the design point are safe; the exposure is entirely for miners *smaller*
than the operator planned for.** A miner at half the design-smallest size drops to 82%
inclusion; at a quarter, 67%. This degrades gracefully (no cliff until `r ≈ 0.1`, i.e.
`σ_actual ≈ σ_min/10`), but it means **`σ_min` should be sized off the genuinely smallest
plausible participant, not the median small miner** — under-sizing `σ_min` is the same failure
as over-sizing `m_min`.

### 1.4 Stress 3 — pool growth is the real adaptivity driver (not difficulty)

Difficulty rising *helps* inclusion (§1.2). The dangerous secular drift is **pool-hashrate
growth**: if `m_min` is frozen in difficulty-units pegged to the old `H_pool`, then a fixed
smallest miner `h_min` sees its `σ_min` shrink as the pool grows, and `c_eff = 0.1·g` for pool
growth factor `g`:

| pool growth `g` | `c_eff` | incl. smallest |
|---|---|---|
| 1.0 | 0.100 | 0.905 |
| 1.5 | 0.150 | 0.861 |
| 2.0 | 0.200 | 0.819 |
| 3.0 | 0.300 | 0.741 |
| 5.0 | 0.500 | 0.607 |
| **10.0** | **1.000** | **0.368** |

A pool that grows 10× while holding a frozen `m_min` walks its smallest members straight into
the `e⁻¹ ≈ 37%` cliff. **This is the drift that actually forces adaptivity** — and unlike
difficulty (a bounded ±50%/epoch wiggle), pool hashrate for a *successful* small pool can
compound many-fold over its life.

### 1.5 Stress 4 — boundary behavior (a miner hovering at ~`m_min`)

Board presence is a per-round Bernoulli(`exp(−c_eff)`). Its round-to-round **flicker variance**
`p(1−p)` is maximized at `p = 0.5`, i.e. `c_eff = ln 2 = 0.693`:

| `c_eff` | `p = incl` | var `p(1−p)` | std(flicker) | miner size vs design-smallest |
|---|---|---|---|---|
| 0.100 | 0.905 | 0.086 | 0.293 | 1.000 |
| 0.500 | 0.607 | 0.239 | 0.489 | 0.200 |
| **0.693** | **0.500** | **0.250** | **0.500** | **0.144** |
| 1.000 | 0.368 | 0.233 | 0.482 | 0.100 |
| 2.000 | 0.135 | 0.117 | 0.342 | 0.050 |

**The worst-flicker miner is not the marginal design-smallest one — it is a miner at ≈0.144×
the design-smallest size**, whose board presence is a literal coin-flip each round (std 0.50).
For that miner the leaderboard delivers maximally erratic "am I on the board this round"
signal. This is inherent to any hard floor on an exponential quantity and is *not* a reason to
raise or lower `COEF` — raising the floor pushes the flicker zone up into legitimate small
miners; lowering it admits more phantom identities (§1.7). It is a reason to (a) size `σ_min`
low enough that no *intended* participant sits near `c_eff ≈ 0.7`, and (b) surface board
presence to users as a rolling/expected figure, not a raw per-round on/off.

### 1.6 Stress 5 — mixed-hashrate populations (board thinning)

Two realistic mixes, with `m_min` set statically at `0.1·σ_min·D_net0` (`σ_min = 0.05`):

| mix | `D_net/D_net0` | E[qualifiers/round] | E[legit small (≤σ_min) on board] |
|---|---|---|---|
| 1×50% + 2×15% + 4×5% (7 miners) | 0.50 | 6.13 | 3.28 |
| | 1.00 | 6.54 | 3.62 |
| | 1.50 | 6.69 | 3.74 |
| Pareto-ish, 20 miners (smallest σ=0.019) | 0.50 | 14.08 | 10.41 |
| | 1.00 | 16.73 | 12.89 |
| | 1.50 | 17.74 | 13.85 |

**Board thinning under a −50% difficulty swing is modest** (7-miner mix: 6.54→6.13 expected
qualifiers; small-miner presence 3.62→3.28). Note the Pareto mix contains miners *below* the
design `σ_min` (smallest σ=0.019 ≈ 0.38×σ_min): those are the ones §1.3 predicts sit at
~67–75% inclusion, and they are exactly the miners whose presence drops most when difficulty
falls — the thinning concentrates on sub-design-point miners, as expected.

### 1.7 The static-`m_min` sybil coupling (why the drift cuts both ways)

An attacker at pool-share `σ_evil` funds `k = σ_evil·D_net/m_min` qualifying phantom identities.
With a **static** `m_min`, `k = (σ_evil/σ_min)·(D_net/D_net0)/COEF` — so the *same* rising
difficulty that improved honest inclusion (§1.2) also **inflates the phantom-identity budget**:

| `σ_evil` | `D_net/D_net0` | `k` (identities) |
|---|---|---|
| 0.10 | 0.50 | 10 |
| 0.10 | 1.50 | 30 |
| 0.50 | 1.00 | 100 |
| 0.90 | 1.50 | 270 |

At `D_net +50%`, a static `m_min` hands an attacker 1.5× more slots than at config time. (`k`
here bounds *phantom* identities; a genuinely large honest miner packs slots too, bounded only
by the N-cap + per-user aggregation + social trust, exactly as §5.6/§6.5 already state — the
work-prop split makes that EV-neutral in *amounts*, so `k` only matters for slot displacement.)

### 1.8 Recommendation — keep `COEF = 0.1`; make the `m_min` **value** adaptive

The coefficient itself is well-chosen and should **not** change: 0.1 keeps the marginal miner
at 90.5% inclusion, a factor-of-2 error stays graceful (§1.2–1.3), and no single difficulty
epoch threatens it. **What should be adaptive is the `m_min` value, not the coefficient.** The
two harmful secular drifts — pool growth eroding inclusion (§1.4) and rising difficulty
inflating the sybil budget (§1.7) — are *both* eliminated by re-pegging `m_min` each difficulty
epoch:

```
m_min = 0.1 · h_min · D_net / H_pool          (recomputed at each 2016-block difficulty adjustment)
```

- `h_min` (smallest intended miner, in hashrate) stays an operator config value.
- `D_net` and `H_pool` are **already live to the engine** — the `TipPoller` reads difficulty,
  and the pool knows its own connected hashrate. So this costs nothing new to compute.
- Re-pegging holds `c_eff ≡ 0.1` regardless of difficulty swings *and* pool growth, fixing
  inclusion drift and sybil-budget drift in one move.

**One caveat — damp the `H_pool` term.** Tracking *instantaneous* connected hashrate would make
`m_min` jitter every time a miner connects/disconnects. Peg to a **smoothed `H_pool`**
(per-epoch average or an EMA) and **only re-evaluate at difficulty-adjustment boundaries**, so
the qualifier is stable *within* an epoch and steps at most once per ~2 weeks. This preserves
INV-8 (forward-only reconfiguration): a re-peg applies at the next build, never retroactively.

**Net for design §15 decision 3 / rec A-4:** adopt `m_min = 0.1·h_min·D_net/H_pool`, re-pegged
per difficulty epoch off a smoothed `H_pool`, rather than a frozen difficulty-unit constant.
The `0.1` is confirmed as the right coefficient; the adaptivity lives in re-pegging the value,
and it is cheap because the inputs are already polled. This supersedes the static phrasing of
§5.6's worked example (which computed one snapshot value) without changing its logic.

---

## 2. Work-proportional split — exact edge-case & rounding rules

The C-1 fix makes **since-round-start-work-proportional** the split. This section pins the exact
arithmetic so it is unambiguous in the design doc. All rules validated in
`split_rounding.py` (200,000 random pots, **zero** value-conservation failures; seed 424242).

### 2.1 The canonical split (value-conserving by construction)

Given integer leaderboard pot `P` (sats) and board members `i = 1..k` with since-round-start
cumulative work `w_i`:

```
sum_w   = Σ w_i
share_i = floor( P · w_i / sum_w )            (integer sats, big-int arithmetic)
R       = P − Σ share_i                        (rounding remainder, always ≥ 0)
fee_out = fee_base + R + Σ(dropped sub-dust shares)
```

**All remainder rolls to the fee output** (INV-4 / design §5.4). There is deliberately **no**
largest-remainder (Hamilton) redistribution among members: adding ±1-sat member adjustments
would buy nothing here (the pot is a percentage of a multi-BTC coinbase, so member shares are
large) and would introduce a tie-break surface. Rolling remainder to fee is deterministic,
matches the existing dust rule, and keeps every member share a clean floor of its work fraction.

### 2.2 Enumerated edge cases and their rules

| # | Case | Rule | Validated result |
|---|---|---|---|
| E-1 | **Zero-share / empty board** (no qualifier clears `m_min`; e.g. block found near-instantly) | Whole leaderboard pot rolls to **fee**. Keeps finder a pure `finderPct` (never inflate finder — INV-4/§5.4). | `P=1,562,500 → fee_roll=1,562,500`, conserved. **Flag (legal optics):** an empty-board round makes operator take = `feePct + leaderboardPct`, above the advertised fee. Document it; it is rare (needs finder's own work < `m_min` *and* no other qualifier) but should not surprise miners. |
| E-2 | **Finder has ~all the work** (finder also tops the board) | Finder collects `finderPct` output **plus** a board slot ≈ entire pot. Correct and intended (§6.7). Keep the two as **separate outputs** to the same script (INV-7 byte-identity — do **not** merge). | `finder_out=156.25M` + `finder_board=149,999,998` across two outputs; conserved. |
| E-3 | **Integer-sat rounding, thin pot** | `floor` each; remainder to fee. Any `share_i < DUST` (294 sat P2WPKH) is dropped and rolled to fee (`roll-to-fee`). | `P=1500`, 10 equal members → each 150 < 294 → all drop → `fee_roll=1500`. `P=4000` → each 400 ≥ 294 → all paid, `fee_roll=0`. |
| E-4 | **Miner joins mid-round** | "Since-round-start work" is a **running sum from round-open**; a joiner contributed 0 before joining, so its `w` is naturally its since-join work. **No proration rule needed.** Slot **gate** stays best-share (must beat rank-N); **amount** is work-prop on partial-round work. | `[1e8, 1e8, 3e6]` → joiner paid its small proportional share; conserved. A joiner with a lucky early share can hold a slot yet earn a small amount — correct. |
| E-5 | **Fewer members than N / single member** | Pay every qualifier; unfilled slots simply don't exist (no output). | `single member` → `floor(P)`, `fee_roll = P mod 1 = 0..`; conserved. |
| E-6 | **Exact tie in rank key** (equal realized hash — ~impossible at 256-bit) | Rank/slot **tie-break: (share_ts asc, then user_id asc)** for full determinism. Amounts need no tie-break (work-prop is continuous). | deterministic by construction. |
| E-7 | **Unpayable board address at build** | Existing §5.4 rule unchanged: promote the runner-up from `mining_round_shares`; roll-to-fee only once the promotion tail is exhausted. This is **separate** from sub-dust drop (E-3). | — |

### 2.3 Two rules the design doc should state explicitly

1. **Amount remainder always to fee; never to finder.** (E-1, E-3.) This is what preserves
   "finder is a pure fixed percentage" (§5.4) and INV-4 simultaneously.
2. **Gate vs amount are different functions.** The **slot gate** is best-share (Alex's ruling,
   decision 3, unchanged); the **amount** is since-round-start-work-proportional (C-1). Every
   edge case above respects that separation — E-2 and E-4 are the ones where conflating them
   would produce a wrong answer.

---

## 3. Federation §14 interactions with `m_min` and the work-prop split

The 6-item minimum change-set (analysis §6.6 / recs B-1…B-6) interacts with the two
single-instance mechanisms as follows. **Verdict up front: federation reopens *no* closed
attack — provided the work-prop split is carried up to the meta layer (B-2). The one real
hazard is *asymmetric adoption*.**

### 3.1 `m_min` and `meta_min_diff` are the same lever at two scales

`meta_min_diff` (B-4 / analysis §6.3-Q3) is the federation analog of `m_min`: a static
difficulty floor sized off the **smallest intended instance** rather than the smallest miner. It
does triple duty — DoS floor (share-flood protection), and the sybil lever capping fake users at
`W_evil/meta_min_diff` (exactly `m_min`'s §1.7 role one level up). **The §1.8 recommendation
transfers directly**: `meta_min_diff` should likewise be re-pegged per difficulty epoch off live
`D_net` (federation instances all observe the same Bitcoin difficulty, so this is coordination-
free), and sized off the smallest instance's smoothed hashrate. Freezing it invites the same
pool-growth erosion (§1.4) and the same rising-difficulty sybil-budget inflation (§1.7),
federation-wide.

### 3.2 The global on-chain round (B-1) creates a synchronized "young board" window

B-1 resets accumulated work federation-wide on each on-chain federation block. Immediately after
a reset, **every** miner is below `meta_min_diff` until it re-accrues work → the meta-board is
briefly sparse, federation-wide and synchronized (the single-instance "young round = weak board"
property, now global). Because the federation block cadence is ~4 years (analysis §6.1), this
sparse window is a negligible fraction of a round; `meta_min_diff` sized so the smallest instance
emits ~O(1) qualifying share/sec (Q3) keeps the window short. **No conflict** — the global round
and the floor compose cleanly.

### 3.3 Does work-prop at the meta layer reopen meta-sybil (§6.2 / C-3)? — No; it *closes* it

This is the crux. C-3's table shows the ranking-vs-split axis:

- **summed-work + equal-split** (single-instance v1 default carried naïvely up) is the **most
  exploitable combination tested** — 94% pot capture at x=0.5, splitting gain +0.841.
- **summed-work + proportional-to-work split** (the C-1/§6.6 rule carried up) collapses the
  splitting gain to **near-zero at minority evil sizes** (+0.012 at x=0.10).

So the work-prop split is not a *reopener* at the meta layer — it is precisely the *fix*. The
same rule that resolves single-instance C-1 resolves federation C-3. **The hazard is asymmetric
adoption**: shipping work-prop at the single-instance layer (the C-1 fix) but leaving
equal-split on the meta-board reconstructs the single worst configuration in the entire
analysis. This coupling must be stated in §14.5 as a hard invariant: *if the intra-instance
split is work-proportional, the meta split MUST be too.*

### 3.4 What `m_min`/`meta_min_diff` still cannot do (and doesn't need to)

Within one *admitted* instance, an evil operator can relabel its real work across users each
≥ `meta_min_diff`, capped at `k = W_instance/meta_min_diff` fake users. Under **work-prop split
this is EV-neutral in amounts** (splitting the same work across k identities collects the same
pot), so the floor's residual job is purely **slot-displacement** — packing meta-board slots to
push honest small instances' users off the visible top-N. That residual is bounded by the *other
three* change-set items acting together: **invite-gated admission (B-3)** makes minting a new
*instance* cost a human invite (so an attacker cannot escape the per-instance cap by spawning
instances — the C-5 hole); **cap M (B-4)** bounds slots per instance; **the N cap** bounds the
board. None of these is new to federation — they are the §6.5 single-instance mitigations
re-expressed one level up.

### 3.5 Federation interaction verdict

| Change-set item | Interaction with `m_min` / work-prop | Reopens a closed attack? |
|---|---|---|
| B-1 global round | Synchronized young-board window, negligible at ~4yr cadence | No |
| B-2 summed-work + prop split | **Closes** meta-sybil (C-3); the fix, not a reopener | No — but asymmetric adoption (equal-split at meta) reopens the worst case |
| B-3 invite-gated admission | Makes `meta_min_diff`/cap-M meaningful (plugs C-5 instance-minting) | No — it is the plug |
| B-4 cap M + `meta_min_diff` | `meta_min_diff` = `m_min` one level up; **inherit §1.8 adaptive re-peg** | No |
| B-5 pin ranking params | N, min-diff, ranking/split fn must match federation-wide or boards diverge | No |
| B-6 honest fee framing | Orthogonal to the floor/split | No |

**Bottom line:** federation is safe against re-opening the meta-sybil (§6.2) attack **iff all
of {work-prop split at meta, invite-gated admission, adaptive `meta_min_diff`, cap M} ship
together.** The single most important addition this addendum makes to §14.5 is the explicit
**work-prop-symmetry invariant** (§3.3): the meta split rule must equal the intra-instance split
rule, because the one combination that is fine single-instance-equal-split-alone becomes the
worst combination tested the moment it is the meta rule.

---

## 4. `cairn-l1zu.22` — meta-leaderboard design sketch (design-only)

A concrete, corrections-consistent scoping sketch for phase-2 federation mining. **Design-only;
R&D-stage; gated behind both the phase-1 legal gate and the `federation_enabled` networking
gate (F15).** This consolidates the analysis §6.3 answers into a single buildable-when-unblocked
shape.

### 4.1 Data gossiped

Reuse the analysis §14.4 `ShareAnnounce` envelope, with one addition (Q2 answer):

```
ShareAnnounce {
  instanceId,                        # sha256(pubkey)[:16], admitted via F4/F3 invite gate
  roundKey,                          # on-chain federation block height+hash of the CURRENT global round (B-1)
  preimage { versionHex, prevHashDisplay, merkleBranch[], ntimeHex, nbitsHex,
             nonceHex, coinbaseHex, en1, en2 },   # full self-certifying share
  boardMerkleRoot,                   # NEW: commitment to the instance's own claimed meta-board (Q2)
  sig                                # envelope sig vs handshake-pinned pubkey
}
```

Everything payout-relevant is *inside* the PoW: `out[0]` of `coinbaseHex` is the miner's payout
address, cryptographically bound into the hash (changing it changes the hash). The receiving
instance trusts **nothing** attested except "which instance relayed this."

### 4.2 Verification cost (per received share)

1. Recompute coinbase txid → apply `merkleBranch` → derive header → compute `hashValue`
   independently (**never trust claimed difficulty**). ~`O(merkle depth)` ≈ a dozen SHA-256d.
2. Read `out[0]` from `coinbaseHex` (trustless payout target).
3. Check `roundKey` == current global round + `OP_RETURN {magic, instanceId}` freshness (replay
   protection).
4. Verify envelope `sig` vs pinned pubkey.

Throughput: `meta_min_diff` is sized so even the largest (~2 PH/s) instance emits **~O(1)
qualifying share/sec**; across ~10 instances that is ~10 verifications/sec — a few hundred
hashes/sec. **Verification cost is trivial and bounded by the static floor** — this is the whole
reason `meta_min_diff` exists (Q3 / DoS floor).

### 4.3 Board consensus (Q1 — not Byzantine)

The board is **accounting, not money**, so no consensus protocol is needed: it is a
deterministic `rank(share_set)` over the **full-mesh-flooded, self-certifying** share set. Two
instances holding the same flooded set compute a **byte-identical** board with zero coordination
(the Monero-P2Pool precedent: every template embeds the whole window, verified locally). **Cut**
any Braidpool-style DAG — it exists to settle funds and kill orphan races; there is nothing to
settle here (no custody, block production stays local per instance).

### 4.4 The ranking / split / rounds / params stack (corrections-consistent)

| Concern | Rule | Correction it honors |
|---|---|---|
| Ranking | **summed verified work** (not best-share — infinite-variance squatting with no reset survives untrusted instances) | C-3 |
| Split | **proportional to summed work** (NOT equal-split) — §3.3 symmetry invariant | C-1 / C-3 |
| Rounds | **global, keyed on on-chain federation-block observation** | C-4 |
| Admission | **invite-gated (reuse F4/F3)** — the load-bearing sybil root | C-5 |
| Slot bound | **cap M + static-but-epoch-repegged `meta_min_diff`** (§3.1) | C-5 + §1.8 |
| Params | **finding-instance governs its own block** (f, fee local); **pin** ranking-affecting params (N, min-diff, ranking/split fn) federation-wide | Q5 |
| Fee | **finder-instance-takes-all**, framed honestly (small instances ≈ no fee ever) | C-6 |

### 4.5 Abuse cases and their bounds

| Abuse | Bound | Residual |
|---|---|---|
| **Meta-sybil** (relabel real work across fake users) | work-prop split → EV-neutral in amounts; cap M + `meta_min_diff` + invite gate bound slot displacement | Bounded slot displacement only; never funds (no custody) |
| **Template dishonesty** (omit rivals' shares from gossip) | **Detectable, not preventable** (can't prove a negative). Full-mesh flooding lets every instance see X underpay known-valid shares; `boardMerkleRoot` in OP_RETURN makes dishonesty cryptographically attributable → reputation/eviction (invite gate enables eviction). Accept ≤1 underpay before eviction. | One bounded underpay; blast radius = misallocated slots |
| **Offline slot-squat** (dead instance's shares immortal) | **Global on-chain round (B-1)** clears them at the next federation block | Cleared each round; optional liveness-expiry at meta layer only |
| **Gossip partition** | Heals automatically (shares additive); ~4yr cadence makes a partition outliving a block-find astronomically unlikely; no custody | None material |
| **Share-flood DoS** | Static `meta_min_diff` floor (Q3) | Bounded verification load (§4.2) |

### 4.6 Does this fully answer `cairn-l1zu.22`? — Yes, for design-only scope

The bead asks to scope: gossip protocol (§4.1), verification cost (§4.2), slot caps (§4.4),
meta-rank by summed work (§4.4), finder-instance fee (§4.4), round bookkeeping, and abuse cases
(§4.5). **All are answered** — with one correction to the bead's own framing: the bead specified
*per-instance* round bookkeeping, which analysis C-4 proved incoherent; this sketch supersedes it
with the **global on-chain round** (§4.4). With that substitution the design-only scoping is
complete, so `cairn-l1zu.22` is closed (see §6). Implementation remains out of scope under the
legal gate and the F15 networking gate.

---

## 5. `cairn-l1zu.23` — simulation provenance (this addendum's methodology)

`cairn-l1zu.23` tracks the original analysis's provenance gap: its §3/§5/§6 Monte-Carlo code was
never checked in and no longer exists. **This addendum does not re-create those original sims**
(that is the bead's full scope, which remains open). What it *does* provide is a fully
reproducible provenance record for **its own** new sims (Thread 1 and Thread 2), as a down-payment
and as a template for how the l1zu.23 re-implementation should be documented.

### 5.1 Scripts, seeds, parameters

| Script | Purpose | Seed(s) | Trials | Key params |
|---|---|---|---|---|
| `mmin_sensitivity.py` | Thread 1 — `m_min` inclusion `exp(−c_eff)`, all §1 tables | base **20260719** (sequential draws), Pareto mix seed **777** | 4,000,000 Exp(1) draws/cell | `D_net0 = 127.17e12`, `COEF = 0.1`, `σ_min = 0.05`, `DUST = 294` |
| `split_rounding.py` | Thread 2 — value-conservation + edge cases | **424242** | 200,000 random pots | `P ∈ [1, 5e6]`, `k ∈ [1,40]`, `w ∈ [1, 1e9]`, `DUST = 294` |

Environment: numpy 2.5.1, scipy 1.18.0, Python 3.13.7 (matches the original analysis's stated
stack, so results are comparable).

### 5.2 Exact formulas (sufficient to re-derive every table)

```
Round pool work        ~ Exp(mean = D_net)
Miner per-round work    W_i = σ_i · (round pool work) ~ Exp(mean = σ_i · D_net)
Board inclusion         P(W_i ≥ m_min) = exp(−c_eff),  c_eff = m_min/(σ_i·D_net)
Static m_min            m_min = COEF · σ_min · D_net0  →  c_eff = COEF·(σ_min/σ_i)·(D_net0/D_net)
Adaptive m_min (rec)    m_min = COEF · h_min · D_net / H_pool  →  c_eff ≡ COEF
Boundary flicker        Var[presence] = p(1−p), max at p=0.5 ⇔ c_eff = ln 2
Sybil identity bound    k = σ_evil · D_net / m_min = (σ_evil/σ_min)·(D_net/D_net0)/COEF   (static)
Work-prop split         share_i = floor(P · w_i / Σw);  remainder + sub-dust → fee (INV-4)
```

### 5.3 Reproducibility cross-check

The MC `exp(−c_eff)` matches the closed form to ≤3.8×10⁻⁴ absolute across `COEF ∈ {0.05…1.0}`
(§1.1). Thread 2 recorded **0** conservation failures over 200,000 random pots. Both are
deterministic under the recorded seeds.

### 5.4 Recommendation to the orchestrator (in-repo preservation — flag, not decide)

The bead's stated goal is checked-in, re-runnable sim code. Under this session's constraints,
the two scripts live in the scratchpad, **not** the repo, and this addendum does **not** commit
them. **Recommendation (orchestrator's call, not this addendum's):** preserve sim code under
`scripts/analysis/` (or as a `docs/` appendix), **never under `src/`** — it is analysis
infrastructure, not product code, so it is unaffected by the `cairn-l1zu.1` legal gate and can
land independently. The full `cairn-l1zu.23` re-implementation (the original §3/§5/§6 sims) should
adopt the same provenance discipline shown in §5.1–5.2: named scripts, recorded seeds, a
parameter table, and a closed-form cross-check per result. **`cairn-l1zu.23` stays open** — this
addendum covers only its Thread-1/Thread-2 surface.

---

## 6. Bead status & Alex-decision items

### 6.1 Bead status changes

- **`cairn-l1zu.22`** (meta-leaderboard, design-only) — **CLOSE.** §4 is a complete
  corrections-consistent design-only scoping sketch answering every item the bead asks (gossip,
  verification cost, slot caps, summed-work rank, finder-instance fee, abuse cases), with the
  bead's own "per-instance rounds" assumption corrected to the C-4 global on-chain round. Design
  scope is done; implementation stays gated (legal + F15 networking).
- **`cairn-l1zu.23`** (sim provenance) — **STAYS OPEN.** This addendum reproduces only its own
  Thread-1/Thread-2 sims with recorded seeds/params (§5) as a down-payment and a template. The
  bead's full scope — re-implementing the original §3/§5/§6 economics/federation sims as
  checked-in code — is untouched. Progress note + the §5.4 preservation recommendation attached.

### 6.2 Alex-decision items surfaced by this addendum

1. **Adaptive `m_min` (design §15 decision 3 / rec A-4).** Keep `COEF = 0.1` (confirmed
   correct), but adopt the **adaptive** value `m_min = 0.1·h_min·D_net/H_pool`, re-pegged per
   difficulty epoch off a **smoothed** `H_pool`, rather than a frozen difficulty-unit constant.
   Rationale: pool growth (not difficulty) is the drift that walks small miners toward the 37%
   cliff (§1.4), and a static floor also inflates the sybil budget when difficulty rises (§1.7);
   re-pegging fixes both, using inputs the engine already polls. **Decision needed:** adopt
   adaptive re-peg vs keep a static config number.
2. **`σ_min` sizing guidance.** Size `σ_min`/`h_min` off the genuinely smallest *plausible*
   participant, not the median small miner — sub-design-point miners degrade to 82% (0.5×) /
   67% (0.25×) inclusion (§1.3). This is guidance, not a code change.
3. **Empty-board fee optics (E-1).** An empty-board round routes the whole leaderboard pot to
   the operator fee output, so operator take transiently = `feePct + leaderboardPct`. Rare, but
   should be documented in the miner disclosure so it never reads as skimming. **Decision:**
   accept + document, or add an explicit "empty board → roll to finder instead" alternative
   (not recommended — it breaks finder-is-a-pure-percentage, INV-4/§5.4).
4. **Federation work-prop-symmetry invariant (§3.3).** If/when §14.5 is amended, state as a hard
   invariant that the meta split rule MUST equal the intra-instance split rule — because
   work-prop-single-instance + equal-split-meta reconstructs the single worst configuration in
   the whole analysis (C-3). No decision required now (federation is R&D), but flag for the §14.5
   edit.

**All of the above are design/analysis recommendations. None authorizes a build; the
`cairn-l1zu.1` legal gate governs all implementation.**

---

*End of addendum.*
