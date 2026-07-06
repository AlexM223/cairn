# Cairn Unconfirmed-Spending + CPFP Plan

Status: **planning document**, not yet built. Written for parallel execution by
Opus subagents — same over-specified-contract approach as
`docs/NOTIFICATION-PLAN.md` and `docs/COLLABORATIVE-CUSTODY-PLAN.md`; read
those docs' header conventions if you haven't already.

**Scope boundary, stated up front:** this plan covers (1) allowing spends of a
wallet's own unconfirmed outputs, and (2) building CPFP (child-pays-for-parent)
child transactions to rescue a stuck low-fee transaction. RBF (replace-by-fee)
already exists for single-sig (`bumpTransaction` in `transactions.ts`) — this
plan wires it into the "what should I do about this stuck tx" decision, but
does not redesign it. Multisig RBF does **not** exist yet (`cairn-mklv`) — Unit
6 below builds it as a prerequisite for multisig CPFP-vs-RBF parity, not as a
separate initiative. **Also in scope:** §2 covers cluster mempool and package
relay (Bitcoin Core 28.0→31.0), which changed the mempool-policy ground this
whole plan sits on mid-scoping — read it before Unit 5 (ancestor/descendant
limits, rewritten to account for it) or Unit 8 (the new package-relay unit it
motivates).

## 0. What already exists (read this before building anything)

Confirmed directly against current code:

- **`src/lib/server/bitcoin/psbt.ts`, `constructPsbt`**: candidate coins are
  filtered to `u.height > 0` (confirmed only) on every path **except**
  `exactInputs` (RBF replacement, which reuses the original tx's own already-
  validated inputs). This is the literal answer to the scoping question in
  item 1: **yes, Cairn currently blocks spending unconfirmed change and
  unconfirmed received funds entirely**, for both single-sig
  (`psbt.ts:247-249`) and multisig (`multisigPsbt.ts:272`, same filter,
  independently duplicated). Sparrow, Electrum, and BlueWallet all spend
  unconfirmed change by default; Cairn is the outlier here.
- **`src/lib/server/chain/esplora.ts`**: already has `getTxRbf(txid)` and
  `getCpfp(txid)`, thin wrappers around mempool.space's `/v1/tx/:txid/rbf` and
  `/v1/cpfp/:txid`. **These are read-only, explorer-only today** — wired into
  `ChainService.getTxRbfInfo` / `getCpfpInfo` and rendered on
  `/explorer/tx/[txid]` (RBF replacement chain, CPFP effective-fee-rate badge)
  but never called from anything wallet-scoped. Nothing in the wallet UI knows
  "one of my incoming transactions is a low-fee package" — this data source
  exists and is normalized (`RbfInfo`, `CpfpInfo` in `src/lib/types.ts`) but is
  disconnected from the send flow entirely. Both are **mempool.space-only**
  (`probeV1()` gate) — a plain esplora backend (blockstream.info, a
  self-hosted plain-esplora instance) returns `null` for both. CPFP-building
  math (Unit 3) must not depend on these endpoints existing; it only needs the
  parent's own fee/weight, which plain esplora's `/tx/:txid` always has.
- **`src/lib/server/transactions.ts`, `bumpTransaction`**: full BIP-125 RBF for
  single-sig — validates every input signals replaceability, rejects a
  confirmed original, takes the fee increase entirely out of change, enforces
  the minimum-relay-fee bump (original fee + replacement vsize × 1 sat/vB),
  and reconstructs from the stored PSBT via `recoverPsbtInputs` +
  `exactInputs: true`. This is the reference implementation Unit 6 (multisig
  RBF) should mirror, not reinvent.
- **No RBF for multisig** (`cairn-mklv`, filed 2026-07-05): `constructMultisigPsbt`
  sets `RBF_SEQUENCE` on every input (so multisig txs already signal
  replaceability) but there is no `bumpMultisigTransaction` and no
  `/api/wallets/multisig/*/transactions/*/bump` route. A stuck multisig tx
  today has zero recourse except CPFP or waiting — which makes CPFP *more*
  urgent for multisig, not less, and means Unit 6 must ship RBF and CPFP
  together for multisig rather than CPFP alone.
- **No coin-control UI for multisig send** (`cairn-zcui`, filed 2026-07-05):
  single-sig has `CoinControl.svelte`; multisig's send flow has no coin
  picker at all. Unit 7 (safety UX distinguishing safe/risky unconfirmed
  coins) needs *some* coin list on the multisig send page to attach badges
  to — coordinate with whoever picks up `cairn-zcui` so the two aren't built
  twice.
- **`src/lib/server/bitcoin/walletScan.ts`**: already computes `confirmedSats`
  / `unconfirmedSats` per address and aggregate `confirmed` / `unconfirmed`
  totals (lines 20-23, 71-72, 162-171). The wallet already *displays*
  unconfirmed balance — it just can't spend it. Per-UTXO, `getWalletUtxos` in
  `transactions.ts` returns `height` (0 = unconfirmed) on every coin already;
  no new chain-data plumbing is needed to know which coins are unconfirmed,
  only to decide whether they're *eligible*.
- **`CoinControl.svelte`** (single-sig send flow): confirmed-only coin list
  today (its own header comment says so). Badges an immature-coinbase state
  already using the same `Term`-tooltip idiom Unit 7 should reuse for
  "unconfirmed — spending it risks X" copy, rather than inventing a new
  badge vocabulary.
- **`TxStatusBadge.svelte`** / wallet page (`wallets/[id]/+page.svelte`):
  `plausiblyUnconfirmed()` + the existing "Bump fee" (RBF) button on
  broadcast-but-unconfirmed *sent* transactions. There is no equivalent
  affordance on *received* unconfirmed transactions — that's exactly the gap
  Unit 4 ("Speed up" entry point) fills.
- **Send flow stepper** (`wallets/[id]/send/+page.svelte`): `create → review →
  sign → confirm → sent`, `?tx=<draftId>` resumes a saved draft at Review.
  RBF bump reuses this by inserting a fresh draft row (`replaces_txid` set)
  and navigating to `?tx=<id>`. **CPFP cannot reuse this the same way** — a
  CPFP child is a brand-new, unrelated transaction (it doesn't replace
  anything; the parent stays exactly as broadcast). Unit 4's "Speed up on a
  received tx" flow should still land at Create/Review with the CPFP inputs
  and fee pre-filled, but as a genuinely new draft, not a `replaces_txid` row.

## 1. Research: how Sparrow, Electrum, and BlueWallet handle this

**Spending unconfirmed outputs.** All three spend a wallet's own unconfirmed
change by default with no extra confirmation step — it's simply in the
"available balance." Unconfirmed *received* funds (not your own change) are
also spendable by default in all three, though Sparrow labels the UTXO's
confirmation state in its UTXO tab and Electrum's "spend unconfirmed" is
default-on but has historically had a preference to disable it
(`confirmed_only`). None of the three requires a special user action to spend
zero-conf change — the friction Cairn currently imposes (silently filtering it
out, with no explanation) is nonstandard and worth fixing simply by removing
the blanket confirmed-only filter and replacing it with a trust classification
(Unit 1) rather than a hard block.

**CPFP UX.** Sparrow's is the most complete reference: right-clicking an
unconfirmed transaction offers "Bump Fee" (RBF, when the tx is one of yours
and signals replaceability) or "Child Pays For Parent" (when there's an
unconfirmed *output* of that tx belonging to the wallet — i.e., you're the
receiver, or it's your own change). Sparrow's CPFP dialog shows the parent's
current fee rate, lets you pick a target package fee rate, and computes the
child's fee/rate live as you adjust it, spending only the qualifying output
plus (if needed) additional wallet UTXOs to cover the fee. Electrum's "Child
pays for parent" is reached from the transaction's context menu on an
unconfirmed output, with a similar target-rate input, but is a plainer dialog
(no live ancestor-package visualization). BlueWallet added both RBF ("Bump
fee") and CPFP to its transaction detail screen; its CPFP flow is the simplest
of the three — pick a new fee, it computes and broadcasts. All three warn (or
simply refuse) when the tx doesn't signal RBF for the bump-fee path; none of
the three block CPFP based on trust/source of the parent, which is a gap
Cairn can differentiate on (Unit 7).

**Common UX shape worth copying:** the entry point is always attached to the
*transaction* the user is looking at (history list or tx detail), not a
separate global "speed up" page, and the dialog always shows the *current*
ineffective rate next to the *target* rate so the user understands why they're
paying extra. Cairn's `/explorer/tx/[txid]` already renders this exact
before/after framing for CPFP context (`cpfp-hint`, lines 255-262) — Unit 4
should reuse that copy pattern on the wallet-scoped view instead of inventing
new language.

**Sparrow's TRUC/ephemeral-anchor status, checked directly:** as of Sparrow
v1.8.2 (2026), Sparrow reads BC-UR QR tags carrying v3 output descriptors and
displays the effective package fee rate when constructing a CPFP transaction
— i.e. it has started consuming v3/TRUC metadata and showing package-aware
fee rates, but nothing found indicates Sparrow *builds* its own zero-fee
ephemeral-anchor parents (that pattern is aimed at protocols like Lightning
and Ark, which construct their own commitment transactions — not at a normal
UTXO wallet paying an address). Read as: general-purpose wallets are
adapting to *display and interoperate with* TRUC/ephemeral-anchor
transactions built by other software, not yet racing to originate them
themselves. That's the same posture this plan recommends for Cairn — see §2.

## 2. Cluster mempool & package relay (Bitcoin Core 28.0 → 31.0) — what changed and how Cairn should adapt

This section exists because the user asked specifically to account for it.
Researched directly (Bitcoin Optech, the BIP-431 text, and the Bitcoin Core
31.0 release notes) rather than assumed, since this is a fast-moving area of
Core policy and it's easy to cite stale numbers here.

### 2.1 Timeline, so "which Core version does what" is unambiguous

- **Core 28.0 (Oct 2024):** standardized **TRUC / "v3" transactions**
  (`nVersion=3`, BIP 431, "Topologically Restricted Until Confirmation").
  A TRUC transaction is capped at **1 unconfirmed ancestor** and **1
  unconfirmed descendant** — strict 1-parent-1-child topology — plus size
  caps (10,000 vB max for any TRUC tx; 1,000 vB max for one with an
  unconfirmed TRUC ancestor). This is what makes 1-parent-1-child package
  relay and fee-bumping safe to reason about: pinning attacks (a low-fee but
  huge/deep descendant tree blocking replacement) are structurally impossible
  when the topology is capped at one child. 28.0 also added the
  `submitpackage` RPC and limited P2P package relay (1-parent-1-child only,
  TRUC-gated, "not yet reliable under adversarial conditions" per Core's own
  release notes).
- **Ephemeral anchors** (proposal, built on top of TRUC, still landing across
  28.0-era and later releases): lets a transaction pay **zero fee** and carry
  a single **dust/zero-value, anyone-can-spend anchor output**; the
  transaction is only relayed as part of a package with a fee-paying child
  that spends that anchor. This is aimed at protocols that pre-sign
  transactions before knowing the right fee (Lightning commitment
  transactions, Ark-style constructions) — not at a typical wallet-initiated
  payment, which always knows its fee at construction time. Relevant to
  Cairn only if it ever originates that kind of pre-signed, fee-deferred
  transaction (it doesn't today).
- **Core 31.0 (released April 19, 2026 — i.e. very recently relative to this
  doc):** shipped **cluster mempool** as the default policy, which is a
  larger internals rewrite, not just an extension of TRUC:
  - Per-transaction ancestor/descendant **count** limits are gone. Replaced
    by a **whole-cluster** cap: **64 transactions, 101,000 vB** per cluster.
    A transaction can have unlimited ancestors as long as the connected group
    of unconfirmed transactions it belongs to stays under that cap.
  - The **CPFP carve-out** (the old exception reserving one extra descendant
    slot at the 25-descendant cap so a stuck transaction could always get one
    fee-bumping child) was **removed** — no longer needed once cluster limits
    replace per-edge ancestor/descendant counting.
  - RBF acceptance was overhauled to a **feerate-diagram** comparison
    (replacement accepted only if the resulting mempool's feerate ordering is
    strictly better than before) rather than the old "pays enough more" rule.
  - 1-parent-1-child **package relay was expanded beyond TRUC**: packages
    can now include non-TRUC transactions too, and a 0-fee parent is
    accepted in a package regardless of TRUC tagging.
  - New RPCs `getmempoolcluster` and `getmempoolfeeratediagram` expose the
    new model, but — like `submitpackage` — these are Core RPCs, not
    something exposed over the Electrum protocol or esplora's REST API.

### 2.2 What this means for Cairn's actual reachable surface

Cairn never talks to Core RPC directly — its only chain-data paths are the
Electrum protocol (`ElectrumClient`) and an esplora-compatible HTTP API
(`EsploraApi`, mempool.space/Blockstream/self-hosted). Package relay and
cluster-mempool internals are Core-node concepts; whether Cairn can *use* them
depends entirely on whether those two intermediary layers expose them:

- **Electrum protocol:** a documented extension method
  `blockchain.transaction.broadcast_package` exists, taking a topologically-
  sorted parent(s)+child array and submitting it as a package via the backing
  node's `submitpackage` RPC — but it is explicitly gated on the backing node
  being **Core 28.0+**, and servers advertise support via a capability flag in
  their feature/version response (Cairn's `ElectrumClient` already has a
  `server.features()` passthrough at `client.ts:398` — extending the startup
  probe alongside the existing `server.version` negotiation in the connect
  path, mirroring `EsploraApi.probeV1()`'s "probe once, cache, degrade
  cleanly" pattern, is the natural hook). **Do not assume every self-hosted
  Electrum server (electrs, Fulcrum, ElectrumX) has this wired up even when
  its backing Core node supports it** — the extension is new enough that
  deployed server versions lag; treat it exactly like `probeV1()` treats
  mempool.space's `/v1/` endpoints: probe, cache, degrade silently.
- **Esplora-family HTTP:** mempool.space/Blockstream's API added a
  `/txs/package` endpoint accepting an array of raw hex transactions and
  submitting them as a package — same underlying idea, reachable from
  `EsploraApi` the same way `getCpfp`/`getTxRbf` already reach mempool.space-
  only endpoints (v1-probe-gated). A plain esplora backend without this route
  simply 404s, same fallback shape as every other v1-only method here.
- **Neither path is required for baseline CPFP.** Cairn's core CPFP use case
  (Unit 3) is a parent that's **already sitting in mempools network-wide**
  (it was accepted at broadcast time, is just confirming slowly as the fee
  market moved past it) — sequential broadcast (parent already out there,
  broadcast the child separately once built) works completely independently
  of package relay, exactly like Sparrow/Electrum/BlueWallet's baseline CPFP
  today. Package relay only matters for the narrower case of a parent that
  would be **rejected outright** if broadcast alone (below the node's minimum
  relay/mempool-floor fee) — which for Cairn means a transaction it built
  itself at too low a fee rate and hasn't yet broadcast, or a 0-fee ephemeral-
  anchor-style transaction (not something Cairn constructs today, per §2.1).

### 2.3 Recommendation

Ship Units 1-7 (baseline unconfirmed-spend + CPFP + RBF-vs-CPFP routing)
**without any dependency on package relay** — that's the complete answer to
the original ask and works against any Electrum server or esplora backend,
old or new. Layer package-relay support on top as a genuinely optional
enhancement (Unit 8, below): probe for `broadcast_package`/`/txs/package`
support, and when present, use it for the specific case where Cairn's own
*unbroadcast* draft would otherwise be rejected at the minimum relay fee —
building it as a parent+child package and submitting both atomically instead
of asking the user to wait and hope. Never make any unit's happy path assume
package relay exists; every fallback is "do what Units 1-7 already do."

## 3. Fee math (shared contract — every unit computing a CPFP fee uses this)

```
child_fee_sats = ceil(target_rate * (parent_vsize + child_vsize)) - parent_fee_sats
```

Where:
- `target_rate` — the sat/vB the user wants the **package** (parent + child)
  to average, e.g. the current "next block" estimate from
  `ChainService.getFeeEstimates()`.
- `parent_vsize` — from `EsploraTx.weight / 4` (esplora already exposes
  `weight`; `ChainService.toTxDetail` already computes `vsize = ceil(weight/4)`
  — reuse that, don't recompute).
- `parent_fee_sats` — `EsploraTx.fee` directly (esplora provides actual fee
  paid, not an estimate).
- `child_vsize` — computed the same way `constructPsbt`/`constructMultisigPsbt`
  already estimate vsize for a real draft (their existing `INPUT_VSIZE` /
  `multisigInputVsize` + `outputVsize` tables) — **not** a rough guess. This
  makes the CPFP builder a thin wrapper around the existing construction path
  rather than a new fee estimator (see Unit 3).

Guardrails:
- If `child_fee_sats <= 0`, the parent already meets or exceeds the target
  rate on its own — CPFP isn't needed; say so instead of building a
  zero/negative-fee child.
- The child's *own* rate (`child_fee_sats / child_vsize`) must independently
  clear the node's minimum relay fee (1 sat/vB) even in the (rare) case the
  formula above returns a very small number — clamp up to that floor.
- If the qualifying UTXO's value can't cover `child_fee_sats` plus a
  non-dust payout, either pull in additional confirmed UTXOs (same "coin
  selection" the normal builder already does — pass the unconfirmed coin as a
  forced input, everything else as normal candidates) or surface "this coin
  isn't big enough to CPFP effectively" rather than silently building a
  dust-losing transaction.
- Cap `target_rate` at the same `MAX_FEE_RATE` ceiling `psbt.ts` already
  enforces (1000 sat/vB) — the CPFP builder is a caller of `constructPsbt`,
  not a bypass of its validation.

## 4. RBF vs. CPFP decision logic (shared contract for Unit 4)

| Situation | Correct action | Why |
|---|---|---|
| You broadcast the tx (it's in your `transactions` table with `status='completed'`, no `replaces_txid` chain issue) | **RBF** (existing `bumpTransaction`) | You control every input; replacing is cheaper (no extra output, no extra input) and clears the whole tx at once. |
| You're the receiver of an incoming unconfirmed tx from someone else | **CPFP** | You don't hold the other inputs' keys — you can only spend what you were paid, not replace the tx. |
| The unconfirmed tx is **your own change** coming back from a prior send | **RBF if you still have the original draft's data and it signals replaceability; CPFP otherwise** (e.g. change from a tx built by a different wallet/instance, or the original predates `RBF_SEQUENCE` always being set) | RBF is preferred when available for the same reason as row 1; Cairn always sets `RBF_SEQUENCE` on its own constructions, so this only degrades to CPFP for externally-built or legacy transactions. |
| Both apply (you sent it **and** you're also about to spend its change before it confirms) | **RBF on the original send** — do not offer CPFP-on-your-own-change as the *first* suggestion, since it's strictly more expensive than just replacing the parent. Offer CPFP only as a fallback if RBF is unavailable (e.g. someone already tried to bump and the replacement is itself stuck — chain-of-stuck-txs is where CPFP genuinely helps even for your own sends). | Matches Sparrow's ordering: it always defaults to Bump Fee for a wallet-originated tx and only surfaces CPFP when the tx doesn't qualify for RBF. |

Detection inputs Unit 4 needs, all derivable from existing data:
- "Is this my own broadcast tx?" → `transactions.txid` match (single-sig) /
  `multisig_transactions.txid` (multisig) — already queried for the existing
  Bump button.
- "Do I have an unconfirmed output from someone else's tx?" → walk
  `getWalletUtxos()`'s `height <= 0` coins, and for each, check whether its
  txid also appears as one of *our* broadcast sends. Anything with
  `height <= 0` that ISN'T one of ours is a receive-side candidate for CPFP.
- "Does it still signal RBF?" → same check `bumpTransaction` already does
  (`sequence < 0xfffffffe` on every input) — reuse, don't reimplement.

## 5. Unconfirmed-chain limits: legacy ancestor/descendant caps AND cluster caps

**This section was rewritten after cluster mempool shipped (see §2) — the
limits are no longer a single fixed pair of numbers.** Two regimes exist in
the wild simultaneously, and Cairn cannot assume which one a given connected
node is running:

**Pre-cluster-mempool nodes (Bitcoin Core ≤ 30.x, still the majority of
deployed nodes for some time after 31.0's April 2026 release):** the classic
policy — **25** unconfirmed ancestors, **25** unconfirmed descendants,
**101,000 vB** ancestor package size, **101,000 vB** descendant package size
(`DEFAULT_ANCESTOR_LIMIT` / `DEFAULT_DESCENDANT_LIMIT` / `*_SIZE_LIMIT_KVB`).
Also has the CPFP carve-out exception (one extra descendant slot reserved so
a low-fee transaction can always get one fee-bumping child even at the
descendant cap) — since removed in 31.0, don't assume it's there.

**Cluster-mempool nodes (Bitcoin Core 31.0+, default policy per the release
notes):** per-transaction ancestor/descendant *count* limits are gone
entirely — a transaction can have any number of ancestors as long as the
whole connected **cluster** stays within **64 transactions** and **101,000 vB**
of virtual size. This is a materially different shape of limit (whole-graph
cap, not a per-edge cap), and RBF acceptance also changed: a replacement is
now accepted only if the resulting mempool's fee-rate diagram is strictly
better than before, not just "pays enough more than the original" — relevant
if a CPFP child itself is ever bumped a second time, though that's a forward-
looking note, not something this epic needs to build against yet.

A wallet that lets a user chain unconfirmed sends (spend change before it
confirms, repeatedly) can hit either limit without warning — the node simply
rejects the next one at broadcast time with an opaque policy error. Cairn
should count depth *before* that happens, but needs to pick the right
threshold for the node it's actually talking to:

- **Detecting which regime is in effect** is not solved by anything Cairn
  currently reads. Neither `ElectrumClient.request('server.version', ...)`
  nor `EsploraApi` expose the backing Core version or its mempool policy
  directly. Two new v31 RPCs (`getmempoolcluster`, `getmempoolfeeratediagram`)
  would answer this authoritatively but are plain Core RPCs, not something
  Electrum or esplora currently proxy through — see §2's reachability
  discussion. Absent a reliable signal, **default to the more conservative
  legacy numbers (25/25/101 kvB)** when the regime can't be determined: warning
  too early on a cluster-mempool node is a harmless false positive (the real
  ceiling there is looser), whereas warning too late on a legacy node means an
  unexplained broadcast rejection, which is the worse user experience.
- When building a normal send or a CPFP child that spends an unconfirmed coin,
  walk that coin's ancestor chain (mempool.space's `/v1/cpfp/:txid` already
  returns an `ancestors` array when available — reuse `ChainService.getCpfpInfo`
  for the "am I near the limit" check even though CPFP fee-building itself
  doesn't depend on it; on a plain-esplora backend where that endpoint is
  unavailable, fall back to walking `vin`/parent lookups directly, capped at a
  reasonable depth — don't hang trying to walk an unbounded chain). Note this
  endpoint's own shape (ancestors/descendants of one tx) doesn't map cleanly
  onto a cluster-mempool node's whole-cluster limit either — it's still the
  best available proxy, just an approximation on both regimes.
- Warn (don't hard-block) once the chosen threshold's ancestor/cluster count is
  within a few of the cap, or package vsize is within a margin of 101,000 vB
  (the size cap is the one number that hasn't changed between regimes) — a
  hard block risks false positives from the estimate; a clear warning with the
  actual numbers lets the user decide.
- This is a "nice to have that prevents a confusing broadcast failure," not a
  blocking dependency for Units 1-4 — sequence it last (Unit 5) and let it
  degrade silently (no warning shown) on backends where the ancestor data
  isn't available, exactly like every other v1-only `EsploraApi` method
  already does.

## 6. Safety: trust classification for unconfirmed coins

Two categories, surfaced distinctly (reusing the `Term` tooltip idiom from
`CoinControl.svelte`'s coinbase badge):

- **Own change, unconfirmed** — the wallet's own prior send hasn't confirmed
  yet. Low risk: you'd only lose if you *also* get RBF'd by someone else
  racing your own transaction, which for a single-owner wallet only happens if
  you build two conflicting spends yourself. Label: neutral tone, "Change ·
  unconfirmed."
- **Received funds, unconfirmed, from an address not our own** — the sender
  could still replace their transaction (RBF) or, if it doesn't signal RBF, a
  miner could still reorg it out in rare cases; either way, spending it before
  it confirms means your new transaction is only as good as theirs. Label:
  warning tone, "Unconfirmed · could still be replaced," with a tooltip
  explaining the double-spend risk in plain language (per
  `cairn-ux-philosophy` conventions — no "double-spend" jargon in the primary
  copy, save the term for the `Term` tooltip body).
- Classification test: a UTXO's `chain === 1` (change-chain derivation index)
  is *not* sufficient by itself for "safe" — a change output from a
  transaction that itself hasn't been broadcast by this wallet (e.g. imported
  history) doesn't qualify. Use the same "is this txid one of ours" check
  described in §4.

## 7. Buildable units

Each unit below is filed as a beads issue (`cairn-*`) under the epic. Read
"Shared contracts" (§3, §4) before starting any unit that touches fee math or
RBF/CPFP routing.

**Unit 1 — Allow spending unconfirmed own/received UTXOs (core).**
Replace the blanket `u.height > 0` filter in `constructPsbt` (`psbt.ts:247`)
and `constructMultisigPsbt` (`multisigPsbt.ts:272`) with a policy that admits
unconfirmed coins by default, classified per §6, while preserving the
existing `exactInputs` (RBF) and coin-control semantics untouched. Every UTXO
Cairn already tracks carries `height` — this is a coin-selection policy
change, not a new data source. Must not silently start selecting a risky
unconfirmed coin in *automatic* selection ahead of confirmed ones — prefer
confirmed first, fall back to unconfirmed own-change, then unconfirmed
received, so a normal send doesn't unexpectedly depend on someone else's
unconfirmed tx without the user opting in via coin control. Blocks Units 3, 6,
7.

**Unit 2 — Wallet-scoped stuck/incoming-tx detection.**
A query (single-sig + multisig) that, given a wallet's live UTXO set and
recent tx history, returns which unconfirmed coins are (a) our own change,
(b) received from elsewhere, and whether the underlying tx still signals RBF
— the data §4's decision table needs. This is the backend half of "detect
when a user has unconfirmed incoming transactions"; it does not build any
UI. Feeds Unit 4.

**Unit 3 — CPFP fee-math + PSBT builder.**
`buildCpfpDraft()` analogous to `buildDraft()`/`bumpTransaction()` in
`transactions.ts` (and the multisig equivalent in `multisigTransactions.ts`,
coordinated with Unit 6): given a parent txid + the wallet's unconfirmed
output on it + a target package rate, compute `child_fee_sats` per §3, force
that output as a required input (extending `onlyUtxos`/coin-control to
support "must include" rather than just "restrict to"), and route through the
existing `constructPsbt`/`constructMultisigPsbt` builders for actual
construction — do not hand-roll a second transaction builder. Depends on
Unit 1 (the forced input must be constructible even though it's
unconfirmed).

**Unit 4 — "Speed up" UI + RBF/CPFP routing.**
Surface a "Speed up" action on unconfirmed transactions in the wallet page
(mirroring the existing RBF "Bump fee" button's placement/style) that
applies §4's decision table: routes to the existing bump-fee flow when RBF
applies, or a new CPFP review screen (pre-filled amount/fee, still landing on
the Create/Review steps per §0's stepper note) otherwise. Reuses
`/explorer/tx/[txid]`'s existing CPFP/RBF badge copy rather than inventing
new language. Depends on Units 2, 3 (and Unit 6 for multisig parity).

**Unit 5 — Ancestor/descendant/cluster chain-depth warnings.**
Per §5: check chain depth before building a send or CPFP child that spends an
unconfirmed coin; warn (not block) near whichever limit applies — legacy
25 ancestors/25 descendants/101 KvB on a pre-31.0 node, or the newer 64-tx/
101 KvB whole-cluster cap on a 31.0+ (cluster mempool) node. Default to the
legacy (more conservative) numbers when the node's regime can't be
determined. Degrades to no warning on backends without `/v1/cpfp/:txid`.
Depends on Unit 1 (only matters once unconfirmed spends are allowed at all)
but is otherwise independent of Units 2-4 — can run in parallel with them.

**Unit 6 — Multisig RBF + CPFP parity.**
Closes `cairn-mklv` (build `bumpMultisigTransaction`, mirroring
`bumpTransaction`'s BIP-125 checks exactly) as a prerequisite, then extends
Units 1/3/4's unconfirmed-spend and CPFP-builder work to
`multisigPsbt.ts`/`multisigTransactions.ts`. Filed as its own unit rather than
folded into 1/3/4 because it has its own prerequisite (RBF doesn't exist yet
for multisig) and its own reviewer (multisig PSBT construction has quorum/
signing-mass considerations single-sig doesn't). Depends on Unit 1; do not
start the CPFP-parity half before `bumpMultisigTransaction` lands, since §4's
routing table needs multisig RBF to exist to route to it at all. Also note
(§2.1): Core 31.0's feerate-diagram RBF acceptance rule may accept or reject
bumps differently than the BIP-125 "pays enough more" rule `bumpTransaction`
implements today — out of scope to fix here, but don't be surprised if a
bump that would have passed under the old rule is rejected by a cluster-
mempool node, or vice versa; flag it as a follow-on if it surfaces during
testing rather than silently working around it in this unit.

**Unit 7 — Coin trust UX (safe vs. risky unconfirmed).**
Per §6: badge unconfirmed coins in `CoinControl.svelte` (own-change vs.
received-from-elsewhere) using the existing `Term`-tooltip idiom. For
multisig, this depends on `cairn-zcui` (no coin-control UI exists for
multisig send at all yet) — coordinate rather than duplicate; if `cairn-zcui`
is unbuilt when this unit starts, build the minimal coin list it needs as
part of this unit and note the overlap on both issues. Depends on Unit 1.

**Unit 8 — Opportunistic package-relay broadcast.**
Per §2.3: probe (once, cached, degrade-silently — same shape as
`EsploraApi.probeV1()`) whether the connected Electrum server supports
`blockchain.transaction.broadcast_package` and/or whether the configured
esplora backend supports `/txs/package`. When available, use it for the one
case sequential broadcast can't cover: a Cairn-built draft whose fee rate is
so low it would be rejected outright at broadcast (below the node's minimum
relay/mempool-floor fee) — submit it as a package with a fee-paying child
instead of broadcasting a doomed parent alone. This is explicitly NOT a
dependency of Units 1-7's baseline CPFP (which targets an already-broadcast,
already-in-mempools parent — sequential broadcast handles that fine, see
§2.2) — treat this unit as a pure enhancement, safe to defer or drop without
weakening anything else in this epic. Depends on Unit 3 (needs the CPFP
builder's parent/child construction to exist before it can be submitted as a
package instead of two sequential calls).

## 8. Sources for §2 (checked live, not from training-data recall)

Cluster mempool / TRUC / package relay is moving fast enough that the exact
version numbers and shipped-vs-proposed status above were verified against
these live sources rather than assumed, and are worth re-checking if this
plan sits unbuilt for long:

- Bitcoin Core 31.0 release notes — <https://bitcoincore.org/en/releases/31.0/>
  (cluster mempool default policy, 64-tx/101 KvB cluster cap, CPFP carve-out
  removal, feerate-diagram RBF rule, `getmempoolcluster`/`getmempoolfeeratediagram`)
- Bitcoin Optech, "Cluster mempool" — <https://bitcoinops.org/en/topics/cluster-mempool/>
- Bitcoin Optech, "Version 3 transaction relay" — <https://bitcoinops.org/en/topics/version-3-transaction-relay/>
- Bitcoin Optech, "Ephemeral anchors" — <https://bitcoinops.org/en/topics/ephemeral-anchors/>
- BIP 431 text (topology restrictions: 1 ancestor/1 descendant, 10,000 vB /
  1,000 vB size caps) — <https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki>
- Bitcoin Core 28.0 release notes — <https://bitcoincore.org/en/releases/28.0/>
  (TRUC standardized, `submitpackage` RPC, limited 1p1c P2P package relay)
- Electrum protocol `blockchain.transaction.broadcast_package` extension and
  its Core-28.0+-backing-node / capability-flag gating — electrum-protocol
  documentation (electrum-protocol.readthedocs.io) and ElectrumX protocol-methods
  docs
- Esplora API `/txs/package` endpoint — Blockstream Esplora API docs
  (<https://github.com/Blockstream/esplora/blob/master/API.md>) and
  mempool.space's blog on the same feature
- Sparrow Wallet v1.8.2 release notes (v3 output descriptor BC-UR support,
  CPFP effective-fee-rate display)
