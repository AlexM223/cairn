# Counsel Question Package — Legal Gate `cairn-l1zu.1` (2026-07-19)

**Purpose.** This is the question package Alex takes to licensed counsel to clear legal gate
`cairn-l1zu.1` (the gate blocking all implementation of epic `cairn-l1zu`, the coinbase-payout
mining pool). It assembles (a) a facts-for-counsel statement of exactly what the software does,
(b) the refined list of questions for counsel, and (c) a per-question annex mapping each question
to the design/analysis facts counsel needs to answer it.

**This package is NOT legal advice and NOT a legal decision.** It decides nothing, reverses no
gate, and authorizes no build. See §4 (Non-goals). It is prepared *for* counsel, not *by* counsel.
It supersedes nothing in `docs/COINBASE-PAYOUT-POOL-DESIGN.md` §2 (Alex's fixed rulings) or the
gate bead's hold status.

**Source documents** (counsel and Alex should read alongside this package):
- `docs/COINBASE-PAYOUT-POOL-DESIGN.md` — canonical design (fund flow §5.4, invariants §5.3,
  legal-gate framing §13, federation §14).
- `docs/COINBASE-POOL-ANALYSIS.md` — risk mapping (legal §7, its §7.1 counsel-question seed list,
  economic viability §8).
- `docs/COINBASE-POOL-ANALYSIS-ADDENDUM-2026-07-19.md` — the 2026-07-19 refinements this package
  incorporates (deterministic split rounding §2, adaptive `m_min` §1.8, empty-board optic §2.2/§6.2,
  federation symmetry invariant §3.3).

---

## 1. Facts for counsel (what the software actually does)

Written so counsel can analyze the money-transmission / MTL / developer-liability questions from an
accurate factual predicate. Every claim carries a design/analysis citation. Two exposure layers are
kept distinct throughout: **Layer A** = the *instance operator* who runs the pool; **Layer B** =
*Alex*, the open-source *publisher* who never operates a pool or takes custody.

### 1.1 What ships today (the baseline the gate protects)

Heartwood already ships a **multi-user solo** mining pool (`src/lib/server/mining/`, v0.2.34, epic
`cairn-vn43`). Today the coinbase pays **exactly one** value output — the finder's own wallet script —
plus a zero-value witness commitment; `job.ts` hard-errors if more than one value-bearing output is
present ("splitting is forbidden"). **That single-output check is `cairn-vn43.14`, the legal gate,
expressed in code** (design §4, §5.4 degenerate case). The proposed epic reverses that check for a new
opt-in split mode. Nothing custodial exists today and nothing custodial is proposed.

### 1.2 Where the sats flow — there is no custody window at any point

This is the load-bearing fact for the whole legal posture. In split mode the coinbase transaction is
built with these outputs (design §5.4 coinbase layout; Tessera mechanics proven in `C:\dev\raffle`
per design §4):

```
out[0]     finder      → the connected miner's OWN payout script (frozen per connection)
out[1..k]  leaderboard → each board member's OWN pre-encoded payout script
out[k+1]   pool fee    → the operator's OWN fee address (operator revenue)
out[..]    OP_RETURN + witness commitment (zero value)
```

- **The network pays every recipient directly, on-chain, inside the block.** The value is created by
  the coinbase and lands in each recipient's own script in the same transaction. It never passes
  through, and never rests in, any operator-controlled wallet or account (design §5.4; §13 "the
  network still pays miners directly"; analysis §7.5 "zero custody, no operator balance").
- **The payout address is cryptographically bound into the proof of work.** A share is proof of work
  over a specific coinbase whose `out[0]` is the grinding miner's own address — changing the address
  changes the hash, so it cannot be redirected (design §14.2, §14.4 step 2).
- **No carry-forward accounting exists, by deliberate design.** Every round pays out completely in the
  block that closes it; there is no cross-block balance, no minimum-payout ledger, no "amount owed to a
  miner" state anywhere. A DB comment explicitly prohibits any value-owed-across-users accounting
  (design §4, §5.6 "no rolling window," §6.8; analysis §7.5 flags no-carry-forward as load-bearing —
  keep it). This is what keeps the custody posture clean and is a real advantage over Ocean's TIDES
  carry-forward ledger.
- **There is therefore no moment at which the operator holds, controls, or could abscond with another
  person's funds.** Under FinCEN's FIN-2019-G001 four-factor "total independent control" test, a
  coinbase-direct pool fails every prong that would make it a transmitter — miners own the outputs,
  value is on-chain in the block, PoW interacts directly with the network, the operator has no
  independent control (analysis §7.2). The blast radius of even a *malicious* operator is misallocated
  leaderboard *slots*, never funds (design §14.5).

### 1.3 What the operator CAN influence (the discretion surface)

The operator is not passive — this is the sole axis on which split mode is legally "arguable" rather
than "clearly clear" (analysis §7.1, §7.2 "Weakness," design §13). The operator sets, via admin
settings (design §2 decision 7, §5.9; bead `cairn-l1zu.11`):

- **The top-level percentages** — `finderPct`, the leaderboard pot percentage, and `feePct` (design
  §2.7 "all percentages admin-configurable, including finder"). This is the "operator sets third-party
  payout percentages" fact that drives the entire legal weakness (analysis §7.1, §7.5 "Hurt").
- **The fee address** — the operator directs its own fee output to its own script; that fee is on-chain
  operator revenue (design §13; analysis §7.5 "Hurt: operator takes a fee output").
- **`N`** (leaderboard size), rank direction, dust policy (bead `cairn-l1zu.11`).
- **NEW (addendum §1.8): the `m_min` eligibility floor, but only as a parameter.** The operator sets
  `h_min` — the smallest miner it *intends to serve*. The engine then deterministically recomputes the
  actual eligibility threshold `m_min = 0.1 · h_min · D_net / H_pool` at each difficulty epoch from
  **live network data the engine already polls** (network difficulty `D_net`, pool hashrate `H_pool`).
  So the operator sets an intent parameter; the *engine*, not the operator, computes the running
  threshold, and it re-pegs forward-only (addendum §1.8, INV-8). This governs **who is eligible for a
  board slot**, and touches neither custody nor the amount any given member is paid.

### 1.4 What the operator CANNOT influence (and how the addendum shrank the discretion surface)

- **The allocation of the leaderboard pot AMONG board members is now fully deterministic — zero
  operator discretion.** Under the 2026-07-19 deterministic work-proportional rule, each member's
  amount is `share_i = floor(P · w_i / Σw)` where `w_i` is since-round-start realized work; the
  rounding remainder and any sub-dust shares roll to the fee output (addendum §2.1, §2.3 rule 1;
  design INV-4). The operator cannot tilt who-gets-what among members — it is a pure function of proof
  of work. **This is a reduction in operator discretion relative to the earlier equal-split default**,
  where the operator's choice of `N` and the equal weighting drove allocation (analysis C-1). Counsel
  should weigh whether removing operator discretion over intra-board *amounts* strengthens the
  non-transmitter / non-"control" posture, and whether it partially substitutes for the analysis's
  recommended "miner-selected splits" mitigation (analysis §7.8 item 1) even though splits remain
  operator-*parameterized* rather than miner-*selected*.
- **Who finds a block or who ranks** — determined by realized proof of work (lowest hash), not by the
  operator (design §5.6 ranking key).
- **Anything retroactive** — settings and round changes are forward-only; a change applies only at the
  next job build, never to an already-announced job (design INV-8, INV-9).
- **Custody of any funds, at any point** — see §1.2.

### 1.5 One new fee-optics fact counsel should see (empty-board over-take)

There is a rare edge case where the operator's realized on-chain take transiently exceeds its
advertised fee. If a round produces **no** board qualifier (no miner clears `m_min` — e.g. a block is
found near-instantly), the entire leaderboard pot rolls to the fee output, so the operator's effective
take for that block = `feePct + leaderboardPct`, above the advertised fee (addendum §2.2 case E-1,
§6.2 item 3). It is rare (requires the finder's own work below `m_min` *and* no other qualifier) and
value-conservation still holds, but the effective fee is not always exactly the advertised number.
This bears on the "operator merely takes a published fee" characterization and on the honest-disclosure
mitigation the whole posture leans on (analysis §7.8, §13). The addendum recommends documenting it in
the miner disclosure so it never reads as skimming; counsel should say whether disclosure cures it.

### 1.6 Ship posture and mitigations already designed in

The design already builds in every mitigation the risk analysis recommends, all gated behind this
bead (design §13; analysis §7.8; beads `cairn-l1zu.13`, `.15`):

- Off by default, behind the `mining_split` feature flag; solo single-output mode stays the default
  and keeps its hard gate.
- An explicit **operator legal-acknowledgment** gate before the split toggle can be enabled
  (`cairn-l1zu.13`, `.15`), plus **miner opt-in**.
- Published, open-source-default percentages (operator-discretion percentages are the worse posture;
  visible + opt-in is the better one — design §13, analysis §7.8).
- No carry-forward accounting (§1.2).
- Still-recommended-but-not-yet-built additions from the risk analysis: miner-selected splits, a hard
  fee-percentage cap (~2% default), in-product operator-tax notice, jurisdictional gating guidance, a
  prominent "not a custodian, the network pays you directly" disclosure (analysis §7.8).

### 1.7 Scale context (why "who is this for" matters to the legal answer)

The economics bound where this is even coherent: payouts arrive only when the pool finds a block, so
below ~1 PH/s pooled the block cadence is decades to millennia and the 2% fee is cost-recovery at best,
not a business (analysis §8). The realistic deployment is a **friends-and-family / single-jurisdiction
sovereignty pool**, which the risk analysis rates low-risk across the board; the risk dial is
**stranger-facing, multi-state public scale**, not the split feature itself (analysis §7.1, §7.7). The
operator-tax item bites regardless of scale (the fee output is ordinary income at receipt).

---

## 2. Refined counsel questions

These carry forward the five questions the risk analysis already seeded (analysis §7.1: Q1, Q2, Q3a,
Q3b, Q4), refined for the 2026-07-19 addendum, plus one new question (Q5) the addendum's empty-board
optic raises. **Numbering note:** the seed list's developer-exposure question was already split into
**3a** (prosecutorial posture) and **3b** (residual statutory exposure); that split is retained — see
§2.6 for why the addendum does not disturb it.

### 2.1 Q1 — Operator money-transmission status (four-factor), refined for reduced-discretion facts

Does an operator who **sets the top-level coinbase percentages and takes an on-chain fee output, but
never takes custody at any point**, stay outside both the federal MSB definition (31 CFR 1010.100(ff))
and the operator's home-state MTL — under a written FIN-2019-G001 four-factor "total independent
control" analysis? Refined sub-questions the addendum raises:

- **(a)** Does the now-**deterministic** intra-board split (operator has zero discretion over which
  member is paid what — it is a pure function of proof of work) **strengthen** the non-transmitter /
  non-"control" posture versus an operator-chosen allocation, and does it partially satisfy the
  "miner-selected splits" structural mitigation even though the top-level percentages remain
  operator-set?
- **(b)** Does the operator setting the **`m_min` eligibility parameter** — which governs *who* may
  hold a board slot, but never custody and never per-recipient amounts, and whose running value the
  *engine* computes from live network data — constitute "control" under the four-factor test, or is it
  legally immaterial like `N` or a dust threshold?

### 2.2 Q2 — State MTL geofencing and F&F-vs-public exposure

Which states (New York and California especially) must be geofenced before *any* stranger-facing
launch, and how materially different is the friends-and-family / single-jurisdiction exposure from the
public, multi-state exposure? (Public multi-state = a 50-state analysis that must clear the strictest
state; NY BitLicense + Art. 13-B is the worst case for a fee-taking, percentage-setting operator.)

### 2.3 Q3a — Developer/publisher: durability of the prosecutorial posture *(Layer B)*

Does the 2025 DOJ non-enforcement posture — the **Blanche Memo (Apr 7, 2025)** and the **Galeotti
declination guidance (Sept 2025)**, alongside the **NY DFS software-dissemination carve-out** — actually
protect a non-custodial pool-*software publisher* who never operates the pool or takes custody? And how
**durable** is that protection, given it is charging-policy discretion rather than a statutory safe
harbor — i.e. how exposed is it to reversal by a future administration?

### 2.4 Q3b — Developer/publisher: residual statutory exposure independent of charging policy *(Layer B)*

Does the still-standing §1960 conviction in ***US v. Storm*** leave residual *developer* exposure that
survives any favorable enforcement posture? Is the developer risk a matter of **law** (statutory, and
therefore not removed by any DOJ climate), or purely **prosecutorial discretion** that the current
posture already addresses?

### 2.5 Q4 — Weight of unchallenged prior art (Ocean)

Ocean (TIDES / DATUM) is the closest real-world coinbase-embedded non-custodial payout and has operated
publicly in the US with **no discoverable public legal or regulatory statement of its
money-transmitter status** — no FinCEN ruling, no state MTL determination, no litigated holding, only
generic industry commentary. Does its unchallenged public operation carry any legal weight, or is it
legally irrelevant (absence of enforcement ≠ endorsement — analysis §7.4)? "Ocean already does this"
must not be leaned on as cover; counsel should confirm.

### 2.6 Q5 — NEW: does the empty-board over-take create disclosure/misrepresentation exposure?

In a round with no board qualifier, the operator's realized on-chain take for that block transiently
equals `feePct + leaderboardPct`, above the advertised fee (§1.5; addendum E-1). **Independent of the
money-transmission question**, does this create any misrepresentation / UDAP / consumer-protection
exposure, and does the planned honest disclosure ("in an empty-board round the leaderboard pot rolls to
the operator fee") cure it? Is disclosure sufficient, or should the code instead cap the operator's
effective take (the addendum notes routing the empty-board pot to the finder is *not* recommended
because it breaks "finder is a pure fixed percentage," INV-4)?

### 2.7 Does the addendum disturb the Q3a/Q3b split? — No (stated explicitly)

The Q3a/Q3b split carves the **developer/publisher (Layer B)** exposure into two independent axes:
**3a** = the durability of *prosecutorial/charging-policy* protection (Blanche/Galeotti/NY DFS
carve-out), and **3b** = *residual statutory* exposure that survives any charging policy (the standing
`US v. Storm` §1960 conviction — a matter of law vs. of discretion). That split is about **who Alex is
as a publisher and whether the law vs. the current DOJ climate protects him.**

The addendum's three substantive changes — the deterministic work-proportional split (addendum §2), the
adaptive `m_min` eligibility parameter (§1.8), and the empty-board fee optic (§2.2/§6.2) — all act on
the **operator's discretion surface, amounts, and fee optics (Layer A)**. They bear on **Q1** (the
four-factor operator analysis, which is why Q1 is the refined question) and raise **Q5** (fee-optics
disclosure). **They do not touch the Layer-B publisher axis at all** — Alex's posture as a
non-operating, non-custodial software publisher is unchanged whether the split is deterministic or
operator-chosen, and whether or not `m_min` is adaptive. **Therefore the Q3a/Q3b split still carves its
issue correctly and needs no revision.** The addendum's effect is concentrated on Q1 and creates Q5;
it leaves Q2, Q3a, Q3b, and Q4 substantively as the risk analysis seeded them.

---

## 3. Per-question annex — facts counsel will need

Maps each question to the design/analysis sections that establish its factual predicate, so counsel can
locate the operative facts without re-reading everything.

### Q1 — Operator four-factor / MSB + MTL
- **Custody = zero, no window:** design §5.4 (coinbase layout), §13 (network pays miners directly),
  §14.2 (payout address bound into PoW); analysis §7.2 (four-factor, fails every transmitter prong),
  §7.5 ("zero custody, no operator balance, no carry-forward").
- **Operator sets percentages + takes a fee (the weakness):** design §2 decision 7, §13; analysis §7.1,
  §7.2 "Weakness," §7.5 "Hurt."
- **Reduced discretion — deterministic split (sub-question a):** addendum §2.1 (`share_i = floor(P·w_i/Σw)`,
  remainder→fee), §2.3 rule 1; design INV-4; analysis C-1 (contrast with the old equal-split default),
  §7.8 item 1 (miner-selected-splits mitigation this partially approaches).
- **`m_min` eligibility parameter (sub-question b):** addendum §1.3–1.8 (operator sets `h_min`; engine
  computes `m_min` from live `D_net`/`H_pool`; forward-only re-peg); design §15 decision 3, §5.6, INV-8.
- **Federal authority:** FIN-2019-G001 (pool-operator split; integral-to-another-service exemption
  (ff)(5)(ii)(F)); FIN-2014-R001/R007; DOJ Blanche + Galeotti — all in analysis §7.2.

### Q2 — State MTL geofencing
- **State fragmentation + control axis:** analysis §7.3 (URVCBA control test; low-risk states; NY
  BitLicense + Art. 13-B worst case; CA DFAL 2026).
- **F&F vs public risk gradient:** analysis §7.7 (Case A vs Case B risk matrices), §7.1 (scale is the
  dial, not the split feature).
- **Scale reality (who this is realistically for):** analysis §8; design §8; this package §1.7.
- **Mitigation:** analysis §7.8 item 3 (jurisdictional gating / geofencing; make F&F the blessed default).

### Q3a — Developer prosecutorial-posture durability *(Layer B)*
- **The posture and its non-statutory nature:** analysis §7.2 (Blanche Memo Apr 7 2025; Galeotti Sept
  2025 declination — "decline where software is truly decentralized … and a third party does not have
  custody and control"; "discretion, not statutory safe harbor").
- **Software-dissemination carve-outs:** analysis §7.3, §7.5 (NY DFS "software development or
  dissemination by itself is not virtual currency business activity"; FIN-2019-G001 tools/software ≠
  accept+transmit).
- **Why Alex fits the protected profile:** analysis §7.5 Layer B (neutral tool, dominant legitimate
  purpose, no anonymizing function, no illicit-finance nexus — unlike Tornado Cash/Samourai).

### Q3b — Developer residual statutory exposure *(Layer B)*
- **The standing conviction:** analysis §7.5 (Tornado Cash/Storm convicted Aug 2025 on §1960
  conspiracy; §1960 conviction stands; acquittal motion pending ~Apr 2026, retrial sought ~Oct 2026).
- **The law-vs-discretion distinction the question turns on:** analysis §7.1 Q3b framing, §7.2 (statutory
  definition requires acceptance AND transmission), §7.4 (posture ≠ endorsement).
- **Contrast facts that lower Alex's exposure:** analysis §7.5 (Samourai §1960(b)(1)(B) charge dropped
  post-Blanche; both were mixing tools prosecuted on laundering intent).

### Q4 — Ocean prior-art weight
- **What Ocean does and why it's the closest precedent:** design §3 (TIDES/DATUM, non-custodial,
  coinbase-direct), analysis §7.4.
- **Why it is weak evidence, not cover:** analysis §7.4 (no FinCEN ruling, no state determination, no
  litigated holding; absence of enforcement ≠ endorsement).

### Q5 — Empty-board over-take / disclosure *(NEW)*
- **The mechanism:** addendum §2.2 case E-1 (empty board → whole leaderboard pot rolls to fee →
  effective take = `feePct + leaderboardPct`), §6.2 item 3 (document it so it doesn't read as skimming).
- **Why routing to finder is rejected as the alternative fix:** addendum §2.2 E-1, §2.3 rule 1; design
  §5.4, INV-4 (finder must stay a pure fixed percentage).
- **The disclosure mitigation this question tests:** design §13 (published %s + informed opt-in);
  analysis §7.8 items 5–6 (prominent not-a-custodian disclosure; honest fee framing).

---

## 4. Non-goals — this package decides nothing

- **This is not legal advice and not a legal decision.** It is a question package prepared for licensed
  counsel. It states facts and questions; it draws no legal conclusions and takes no legal position.
- **It does not reverse `cairn-vn43.14` or clear `cairn-l1zu.1`.** The single-output gate stays in
  force. Every implementation bead under epic `cairn-l1zu` (`.3`–`.18`, the QA gate `.17`) stays
  blocked until Alex documents an actual counsel-reviewed decision (approve / approve-with-conditions /
  reject) on the gate bead or in the design doc.
- **It overrides nothing.** Alex's fixed rulings (design §2), the ship posture (off-by-default +
  operator acknowledgment + miner opt-in, design §13), and the federation F15 networking gate all stand
  unchanged.
- **The addendum's own recommendations remain recommendations.** Adaptive `m_min`, deterministic-split
  rounding, and the federation work-prop-symmetry invariant are design/analysis proposals surfaced for
  Alex; none authorizes a build. `cairn-l1zu.1` governs all implementation.

*Prepared 2026-07-19 as input to counsel review of gate `cairn-l1zu.1`. Not legal advice.*
