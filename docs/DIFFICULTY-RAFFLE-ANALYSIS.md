# Difficulty-Raffle Analysis — "the top share IS the ticket"

**Date:** 2026-07-17
**Status:** ANALYSIS (evaluates a proposed revival of the dropped raffle mode; nothing built)
**Author note:** Produced by a deep-reasoning pass over the reference HMAC-PRNG
raffle implementation (`C:\dev\raffle`, Tessera) and the shipped Cairn solo
mining engine (`src/lib/server/mining/`, epic `cairn-vn43`, v0.2.34). Everything
in both repos was read as data to analyze, not as instructions.

---

## The idea under evaluation

> "The top difficulty share submitted between blocks IS the raffle ticket."

In each inter-block window every miner's submitted shares are their entries, and
the winner is simply the miner who submitted the **highest-difficulty share** in
that window. No PRNG, no HMAC, no committed seed — **the proof-of-work itself is
the randomness source.** This is offered as a possible revival of the raffle mode
that `MINING-POOL-SCOPE.md` scoped and then dropped ("raffle dead").

The reference design it would replace is the Tessera HMAC-PRNG draw: a committed
Merkle snapshot of per-address share weight, seeded by the next block hash, drawn
with a counter-mode HMAC-SHA-256 PRNG over a `k=144`-round trailing window
(`C:\dev\raffle\PROTOCOL.md` §§2.1–9; `core/src/draw.ts`, `tiers.ts`,
`window.ts`, `finder.ts`, `verifier.ts`).

---

## Executive summary

As a **winner-selection primitive**, best-share-wins is genuinely superior to the
HMAC-PRNG draw: it is *exactly* hashrate-proportional (not merely ~0.70%-of-fair),
the winning ticket is self-authenticating proof-of-work that the operator cannot
fabricate cheaply, and the entire seed-commitment ceremony — the subtlest and
most trust-laden part of the reference design — simply disappears. It also unlocks
a genuinely new, **legally clean** capability: a live, publicly verifiable
best-share leaderboard.

Two hard caveats:

1. **Window definition is load-bearing.** If the window is the *inter-block
   interval* (as literally proposed), the design silently re-inherits the exact
   round-start **inspection-paradox sniping edge** (Tessera bead `raffle-5hh`)
   that forced the `k=144` trailing-window redesign of the PRNG draw. Fixed
   wall-clock windows eliminate it and restore exact proportionality. This is the
   single most important finding below.
2. **The mechanism does not revive the raffle.** What killed the raffle was the
   legal/custody gate (`cairn-vn43.14`): redistributing one entity's block reward
   to non-finders is money-transmission / gambling exposure. Best-share-wins
   changes *how you pick a winner*, not *whether rewards get redistributed*. The
   legal calculus is untouched.

**Recommendation: ADOPT-WITH-CONDITIONS**, but scoped precisely — adopt
best-share as (a) the winner-selection primitive *reserved* for any future,
legally-cleared prize mechanism, and (b) immediately, as the basis of a
non-custodial verifiable leaderboard. **Reject** using it to reopen a
reward-redistributing raffle absent the legal review the gate already requires.

---

## a) Probability model — is max-share-wins hashrate-proportional?

**Setup.** Model SHA-256d as a random function: each hash attempt yields a value
`h` uniform on `{0 … 2²⁵⁶−1}`. A share's "difficulty" is strictly decreasing in
`h` (difficulty ≈ `2²⁵⁶ / h`), so **"highest-difficulty share" ≡ "smallest hash
value"** — the raffle winner is whoever produced the global *minimum* `h` in the
window.

**Symmetry argument (distribution-free).** Over a window, let the miners together
compute `N` hashes, `Nᵢ` of them by miner `i`. All `N` draws are i.i.d., hence
**exchangeable**: the minimum is equally likely to be any one of the `N` draws.
Therefore

```
P(miner i holds the window minimum | N₁ … N_k)  =  Nᵢ / N.
```

This needs *only* that the draws are i.i.d. and continuous (no ties) — it does not
even depend on the hash distribution being uniform. The winner is hashrate-
proportional by pure symmetry.

**Marked-Poisson refinement (removes the conditioning).** Model miner `i` as a
Poisson process of hash attempts at rate `λᵢ`, each attempt carrying an i.i.d.
Uniform mark `h`. The superposition is a marked Poisson process; by the marking
theorem the smallest mark belongs to process `i` with probability

```
P(win)  =  λᵢ / Σⱼ λⱼ  =  pᵢ        (exactly, independent of window length T)
```

So per window the win probability is **exactly the hashrate fraction**, and —
critically — **independent of how long the window is.** Contrast the PRNG draw,
whose single-round variant was provably *biased* by round length (the inspection
paradox, `raffle-5hh`) and whose `k=144` windowed fix only reduces the residual
edge to `k/(k−1) ≈ +0.70%` (`window.ts` header). Max-share, with a properly
defined window, has **zero** such residual.

**Ties.** Two equal minima require a 256-bit collision: `P(tie) ≤ C(N,2)/2²⁵⁶ ≈
10⁻²⁷` even at an absurd `N = 10²⁵` hashes/window. Resolve deterministically
(earliest accepted-share timestamp, then `miningId`) so verification is
reproducible; the probability this tie-break is ever exercised is negligible.

**Precision pitfall (implementation-critical).** The ticket must be the **raw
256-bit hash value**, not the rounded float "difficulty." The shipped engine
already *computes* the exact value — `hashValue = hashValueFromDisplay(hashDisplay)`
at `src/lib/server/mining/stratum.ts:646` — but the `ShareEvent` it emits carries
only `announceDifficulty` (the vardiff floor the share cleared,
`stratum.ts:664`), and `aggregates.ts` records that floor as `bestShareDiff`
(`aggregates.ts:127`). Selecting a raffle winner off `announceDifficulty` would
produce enormous tie-clusters at each vardiff level and would **not** be
proportional. **Fix:** carry the raw `hashValue` (or the achieved difficulty
`2²⁵⁶/hashValue`) in `ShareEvent`; select the minimum `hashValue`.

**Verdict (a):** With a fixed-length window, max-share-wins is *exactly*
hashrate-proportional — a cleaner fairness guarantee than the PRNG design can
offer. The only precision requirement is comparing full hash values.

---

## b) Provable fairness, censorship, grinding, and window boundaries

### What a participant can verify

A share is **self-authenticating proof-of-work**. The winning ticket is a tuple
`(jobId, extranonce1, extranonce2, ntime, nonce)`; anyone holding the job
template (prev-hash, merkle branches, `coinb1`/`coinb2`) can recompute the header
hash and confirm (i) it equals the claimed winning value and (ii) the coinbase it
commits to pays the winner's address. Because Cairn already builds a
**per-connection coinbase** (`job.ts` `makeVariant`, the miner's own payout script
in `coinb1`/`coinb2`), the winning share is **self-attributing** — it names its
own payee, exactly the property the PRNG design needed a whole second OP_RETURN
"finder registry" (`finder.ts`, PROTOCOL §7.1) to achieve.

The decisive asymmetry versus HMAC-PRNG:

- **Fabricating a winner is not cheap.** The operator cannot conjure a low-hash
  share without *doing the work* — producing a hash below value `v` costs, in
  expectation, exactly the hashrate that value represents. An operator that wants
  to win must point its own hardware at the pool, which is simply *being a
  proportional participant* — fair by construction. In the PRNG design, by
  contrast, the winner is a function of an operator-committed `merkleRoot` and the
  seed; the whole "commit strictly before the seed exists" ceremony (PROTOCOL §1,
  §4) exists precisely because the operator's inputs are otherwise grindable.

### Residual operator attacks (and required mitigations)

Self-authentication defeats *fabrication* but not *censorship / suppression*:

| # | Attack | Feasible? | Mitigation required |
|---|--------|-----------|---------------------|
| 1 | **Share censorship** — operator silently drops an honest miner's genuinely-lowest share and declares a favored miner the winner | Yes, and *undetectable* without receipts | Operator issues a **signed receipt** per accepted share (or a running signed commitment); operator **publishes the winning share + the job** each window; a censored miner proves fraud by exhibiting its receipt for a lower share |
| 2 | **Winner fabrication** — operator claims a low share nobody submitted | No (self-authenticating PoW; only obtainable by doing the work) | None needed beyond (1); reduces to "operator mines too" = proportional |
| 3 | **Snapshot/entry omission** (PRNG's completeness problem) | N/A | *Disappears* — there is no weight snapshot to keep complete; only the single winning share matters |
| 4 | **Window-membership shifting** — operator assigns a boundary-straddling share to the window that suits it | Yes, if membership is by operator receipt-time | Bind membership to a **pool-signed job issue-time** (see below), cross-checked by miners' real-time observation of job announcements |

Attack 1 is the real one and is *strictly easier to audit* than the PRNG
equivalent: a censored miner needs only one signed receipt and the published
winner, versus reconstructing a `k=144`-round windowed snapshot and re-running the
PRNG (PROTOCOL §9 checks 1a/2). What must be published for third-party
auditability shrinks from "the full windowed share-weight snapshot + per-round
constituents + seed replay" to "the winning share + its job + a commitment (Merkle
root) over the set of accepted shares."

### Can a miner grind anything beyond raw hashrate?

- **extraNonce / nonce / version rolling (ASICBoost):** every roll is another
  i.i.d. draw. More rolling = more draws = proportionally more chance. This *is*
  the honest strategy; there is no way to make one hash "count twice."
- **Selective submission:** a miner may withhold all but its personal best — only
  the minimum matters. This is a *feature*: unlike the PRNG design (where every
  share adds weight, so miners spam everything), max-share gives **zero incentive
  to submit anything but a new personal best**, collapsing share bandwidth and the
  associated DoS surface. Vardiff's role shifts from rate-limiting to simply
  gating "is this a new low worth recording."
- **Stale shares across the boundary:** see attack 4 — membership must be
  verifiable, not receipt-timed.

### The window-boundary problem (open, and it interacts with §b/§c)

There is a real tension:

- **Verifiable membership** pushes toward **block-defined windows** (a share's
  header already contains the tip's prev-hash, so its round is self-evident) — but
  block-defined windows are *variable length* and reintroduce sniping (§next).
- **Sniping-resistance** pushes toward **fixed wall-clock windows** — but `ntime`
  is miner-controlled within a ±~2h tolerance and cannot be trusted to place a
  share in a wall-clock window.

**Proposed resolution:** the pool **signs each job** with `(jobId, issueTimeMs)`;
`window = floor(issueTimeMs / T)` for a fixed `T`; a share inherits its job's
window via `jobId`. The operator cannot backdate (its own signature binds the
time, and miners recorded the announcement in real time) and cannot move a share
across the boundary. This gives fixed-length windows (sniping-proof, §c) *and*
verifiable membership. This is the recommended construction and is a concrete
open-design item, not a solved one.

---

## c) The inspection-paradox sniping edge — the load-bearing caveat

**Claim:** if the window is the *inter-block interval* (as the idea is literally
stated), max-share-wins re-inherits the exact positive-EV round-start sniping
attack that bead `raffle-5hh` found in the PRNG v0x01 single-round draw.

**Why.** Block arrival is memoryless: window length `L ~ Exp(β)`, `β ≈ 1/600 s`.
One prize is awarded per window. The marginal value of a hash is its chance of
being the window minimum, `≈ 1/H` where `H` is the window's *total* hash count.
A window that has already accumulated many hashes has a high `H` floor; a
freshly-started window (just after a block) has a low `H`. So hashes are worth
more early in a window. A miner who mines only the first `s` seconds after each
block and idles the tail captures the cheap-jackpot short windows.

**Math.** Let others hash at `μ`, the sniper at `ν ≪ μ`, `p = ν/μ`. Per window the
sniper's win probability is `p` if `L < s` and `p·s/L` if `L > s` (always `≤ p`),
while its energy per window `∝ ν·min(s,L)`. Then

```
E[P(win)]     ≈ p·β·s·(1 + ln(1/(βs)) − γ)
energy/window ∝ ν·s
EV per unit energy   /   continuous-mining EV per unit energy
      =  1 + ln(1/(βs)) − γ            (γ ≈ 0.577)
```

At `s = 6 s` (`βs = 0.01`) this is ≈ **5.0× fair EV per unit of energy**, growing
*without bound* (logarithmically) as `s → 0`. This matches, in mechanism and
magnitude, the Tessera finding of "≈2.3–2.9× fair EV" for first-1–2-minute
mining under the fixed-pot ÷ variable-round-length draw (`window.ts` header,
`raffle-5hh`). **It is the same inspection paradox.** The PRNG design fixed it
with the `k=144` trailing window; max-share would need its own fix.

**The fix is cleaner for max-share than for PRNG.** The entire reason the PRNG
design was chained to block-defined rounds is that it needs the *next block hash*
as its seed (PROTOCOL §5). Max-share needs no seed — the PoW is the randomness —
so its window boundaries are **free to choose.** Use **fixed wall-clock windows
of length `T`** (via the signed-job-time construction, §b): the sniper who mines
`s < T` gets `P(win) = p·s/T` for energy `∝ ν·s`, so `EV/energy = p/(νT)` —
identical to continuous mining. **No edge.** Fixed windows restore the exact
proportionality of §a and kill sniping outright.

**Verdict (c):** inter-block windows = broken (re-imports `raffle-5hh`);
fixed-length windows = provably clean. **Condition #1 of adoption: fixed
wall-clock windows, never inter-block windows.**

---

## d) Invariant impact on the shipped solo engine

Cairn shipped three invariants (`MINING-POOL-SCOPE.md` doctrine update,
`cairn-vn43.14`): **per-connection coinbase**, **finder-keeps-block**, and **no
pooled/redistributed reward or custody**. A raffle mode inherently *redistributes
a found block's coinbase to non-finders*, which collides with the last two — and
that collision is **identical whether the winner is picked by HMAC or by best
share.** The randomness mechanism is orthogonal to the custody question.

| Invariant / component | Best-share raffle impact | Same under HMAC-PRNG? |
|---|---|---|
| Per-connection coinbase (`job.ts`) | **Reusable as-is** — the per-connection payout script makes the winning share self-attributing (replaces `finder.ts` registry) | PRNG needs an *extra* committed finder registry to do this |
| Finder-keeps-block | **Would be violated** by any pot funded from a found block's coinbase | Identical violation |
| No pooled treasury / no custody (`cairn-vn43.14` legal gate) | **Would be violated** by any redistribution of reward between users | Identical violation |
| Serialized tip/solve queue (`miningPool.ts`) | Untouched (raffle bookkeeping is off the hot path) | Same |
| Value-conservation assert (`job.ts` `makeVariant`, "splitting is forbidden") | **Would have to be relaxed** for a multi-output raffle coinbase — this assert is *the* code embodiment of the legal gate | Identical relaxation |
| `hashValue` computation (`stratum.ts:646`) | **Reusable** — already computed; must be *emitted* (see §a) | PRNG ignores it; uses share *weight* instead |
| `bestShareDiff` aggregate (`aggregates.ts`) | **Reusable** for the leaderboard once it tracks true `hashValue` | Not used by PRNG draw |

**Key structural point:** the one line that would have to change to build *any*
raffle — best-share or PRNG — is the `valueOuts.length > 1 → throw` /
`value conservation` guard in `job.ts`. That guard is deliberately the on-chain
enforcement of `cairn-vn43.14`. Best-share does not make relaxing it any more
legal than PRNG does. **A legally-clean best-share application must leave that
guard intact** — i.e., it must *not* redistribute coinbase value at all (see §f).

---

## e) Simplicity vs the HMAC-PRNG design

| Dimension | HMAC-PRNG (Tessera) | Best-share-wins |
|---|---|---|
| Randomness source | Committed `merkleRoot` + next block hash → HMAC-SHA-256 counter PRNG | The PoW itself (min hash value) |
| Trusted/consensus modules | `draw.ts` (124 LOC), `tiers.ts` (51), `window.ts` (62), `commitment.ts`, `finder.ts` (161), `verifier.ts`, `engine.ts`, `ledger.ts` + 206-line normative spec | Winner = `min(hashValue)` over the window; verify by recomputing one header |
| Seed-commitment ceremony | **Required** — commit strictly before seed exists; "anchoring honesty" caveat when the pool doesn't mine the block (PROTOCOL §4) | **Gone** — no seed |
| Windowed snapshot merge (`window.ts`) | Required to dilute round-length variance to +0.70% | **Gone** — proportionality is exact with fixed windows |
| Finder attribution (`finder.ts`, 2nd OP_RETURN) | Required to make the payee verifiable | **Gone** — winning share self-attributes via its per-connection coinbase |
| Winner completeness / snapshot audit | Publish full windowed snapshot + `k` constituents; re-run PRNG (§9 checks 1a/2) | Publish winning share + job + Merkle root over accepted shares |
| Trust assumptions | ~5: commit-before-seed, seed ungrindable, snapshot completeness, modulo-bias, tier/dust math | ~2: share-log non-censorship (receipts), window-membership integrity (signed job time) |
| Sniping resistance | `k=144` trailing window (residual +0.70%) | **Fixed windows: exact.** Inter-block windows: broken (§c) |
| Fabrication resistance | Rests on commitment ceremony | Rests on physics (PoW is not cheaply forgeable) |

**Tiers.** They still work, by *rank of best share*: sort miners by their window-
best `hashValue` ascending; GRAND = rank 1, MAJOR = ranks 2–5, FIELD = ranks 6–30
(mirroring PROTOCOL §6). One behavioral difference worth flagging: PRNG samples
**with replacement** (`draw.ts` `runDraw`), so a whale can sweep several tiers;
rank-by-best-share gives **at most one prize per miner**. GRAND stays exactly
`pᵢ`-proportional; lower tiers become "conditional on not already having won,"
which is *approximately* proportional and structurally anti-whale. That is a spec
choice (spread winners vs strict proportionality), not a bug — but it is a
deliberate change from PROTOCOL §6 semantics and must be chosen explicitly.

**Net:** best-share deletes the three most bug-prone, most trust-laden Tessera
components (seed ceremony, windowed-snapshot merge, finder registry) and roughly
halves the trust assumptions, for a small, self-verifying winner-selection rule.

---

## f) Variance / UX, and the one legally-clean win

Per-window win probability for a small miner is `pᵢ` (tiny) either way — the
mechanism cannot fix home-scale odds. But max-share is **psychologically and
epistemically superior**: the "ticket" is a *visible, real-time, self-verifiable*
quantity. The existing shipped `bestShareDiff` high-score (`aggregates.ts`) becomes
a **live leaderboard** — "your best share this window is diff 4.2M; the leader's is
4.7M; you're at 89%." No sealed draw, no hidden RNG, no waiting for a reveal: the
leaderboard *is* the mechanism, and every position on it is independently checkable
PoW. This is a capability the sealed PRNG draw structurally cannot offer.

Crucially, **the leaderboard needs no pot.** As pure bragging-rights / high-score
competition it redistributes nothing, touches no coinbase, keeps the `job.ts`
value-conservation guard intact, and therefore sits **entirely outside the legal
gate.** It is the one application of Alex's idea that is unambiguously safe to
build today, and it is a real product win (a competitive, verifiable, social layer
over the solo-mining dopamine loop already described in `MINING-POOL-SCOPE.md`'s
MVP journey).

---

## Verdict and recommendation

**The idea is analytically sound and, as a winner-selection primitive, strictly
better than the HMAC-PRNG draw it would replace** — exactly hashrate-proportional
(with fixed windows), self-authenticating and cheap-fabrication-resistant by
physics, and dramatically simpler (the seed-commitment ceremony, windowed-snapshot
merge, and finder registry all evaporate). It is a better mousetrap.

**But it does not, by itself, revive the raffle for Cairn.** The raffle was
dropped for a *legal/custody* reason (`cairn-vn43.14`: redistributing block reward
between parties = gambling + money-transmission exposure), and best-share-wins
changes only *how the winner is chosen*, not *whether rewards are redistributed*.
The `job.ts` value-conservation guard — the on-chain embodiment of that gate — is
equally load-bearing under either mechanism.

**Recommendation: ADOPT-WITH-CONDITIONS**, split by application:

1. **Adopt now (legally clean):** build the **non-custodial verifiable
   best-share leaderboard** on the existing `bestShareDiff` plumbing. Conditions:
   emit the raw `hashValue` in `ShareEvent` (§a); no pot, no coinbase
   redistribution (leave the `job.ts` guard intact).
2. **Reserve the primitive:** record best-share-wins as *the* winner-selection
   design for any future prize mechanism, superseding the HMAC-PRNG approach — but
   do **not** build a reward-redistributing raffle on it without the legal review
   `cairn-vn43.14` already mandates. The mechanism's elegance is not a substitute
   for that review.
3. **If a prize mechanism is ever legally cleared, the binding conditions are:**
   - **Fixed wall-clock windows, never inter-block windows** (§c) — else the
     `raffle-5hh` inspection-paradox sniping edge returns, unbounded as `s → 0`.
   - **Verifiable window membership** via pool-signed `(jobId, issueTimeMs)`
     (§b), cross-checked by miners' real-time job-announcement records.
   - **Signed per-share receipts + published winning share/job + a Merkle
     commitment over accepted shares** (§b attack 1) — the only residual operator
     attack is censorship, and this makes it provable.
   - **Winner selection on raw 256-bit `hashValue`**, deterministic tie-break
     (§a) — never on the vardiff-floor `announceDifficulty`.
   - **Explicit tier semantics** — decide rank-based (at-most-one-prize-per-miner,
     anti-whale) vs with-replacement, and specify it (§e).

### Open problems

- Window-membership vs sniping-resistance tension (§b) — the signed-job-time
  construction is proposed but unproven; needs a written mini-spec and conformance
  fixtures analogous to Tessera's.
- Pot funding under the legal gate — every coinbase-funded pot violates
  finder-keeps-block; there is no identified legally-clean funding source for an
  inter-party pot, which is why (2) stays gated.
- Rank-based tier proportionality below GRAND is only approximate; quantify if
  multi-tier payouts are ever pursued.

---

## Appendix — reference files

- HMAC-PRNG design: `C:\dev\raffle\PROTOCOL.md` (§§1–10); `core/src/draw.ts`,
  `tiers.ts`, `window.ts`, `finder.ts`, `verifier.ts`, `commitment.ts`.
- Shipped Cairn engine: `src/lib/server/mining/job.ts` (per-connection coinbase,
  value-conservation guard), `stratum.ts` (`hashValue` at :646, `ShareEvent`
  emit at :664), `aggregates.ts` (`bestShareDiff`), `miningPool.ts` (serialized
  queue, finder-keeps-block), `types.ts` (`ShareEvent`).
- Prior scope + legal gate: `docs/MINING-POOL-SCOPE.md`, `cairn-vn43.14`.
</content>
</invoke>
