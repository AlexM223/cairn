# Cairn Batch Transactions Plan — Send-to-Many at Mining-Pool/Exchange Scale

Status: **planning document**, not yet built. Research + scoping only, per
request. Read `docs/HARDWARE-PLAN.md`'s header conventions if you haven't
already — same rules apply: this doc is over-specified on purpose so a future
Opus session can execute it with subagents without re-deriving the starting
state of the codebase.

## 0. Correcting the starting assumption

The obvious assumption is "Cairn needs batch sends built from scratch." **That's
wrong — checked directly against the code.** Cairn already has small-scale
multi-recipient sends, and — more surprising — it already has infrastructure
that anticipates *receiving* coins born from huge batch payouts. What's
missing is everything needed to scale sending from "a handful of recipients a
human types in" to "2,000 mining-pool payouts a machine imports."

**What already exists and is directly reusable:**

- [`src/lib/server/bitcoin/psbt.ts`](src/lib/server/bitcoin/psbt.ts)'s
  `constructPsbt()` already takes `recipients: RecipientSpec[]` — an array,
  not a single address/amount pair. Coin selection, BIP69-style deterministic
  output ordering (`outputVsize`, value-ascending sort at psbt.ts:480-483),
  dust rejection (`DUST_SATS = 546`, psbt.ts:139), and fee math already work
  in terms of "sum of N recipients + change." **No output-count cap exists
  anywhere in this module today** — it will happily try to build a PSBT with
  2,000 outputs and let Bitcoin Core's mempool policy or the hardware wallet
  reject it later, uncontrolled.
- [`src/lib/server/transactions.ts`](src/lib/server/transactions.ts) and the
  `transactions` table (`src/lib/server/db.ts:73-86`) already store a
  `recipients` JSON column for exactly this shape — batch rows populate it in
  full; single-recipient rows leave it `NULL` and use the legacy
  `recipient`/`amount` columns for backward compat. Storage is a solved
  problem.
- The send UI
  ([`src/routes/(app)/wallets/[id]/send/+page.svelte`](src/routes/(app)/wallets/[id]/send/+page.svelte))
  already supports multiple recipient rows via `addRow()`/`removeRow()`
  (lines 219-228), with `isMax` correctly restricted to the single-recipient
  case (line 270 — send-max cannot be split across many outputs, which is the
  right call and should not change). This is a **manual, one-row-at-a-time**
  UI: no CSV import, no virtualized list, no bulk paste. It works fine for "3
  friends" or "a dozen contractors." It was never built for hundreds of rows
  and will not scale as-is (see §5).
- [`src/routes/(app)/wallets/[id]/_components/signingMass.ts`](src/routes/(app)/wallets/[id]/_components/signingMass.ts)
  is the single most relevant piece of prior art in the codebase. It already
  models the *consequence* of batch transactions — specifically that a coin
  born as one output of a giant mining-pool payout run has a giant parent
  transaction, and hardware wallets must import that whole parent
  (`nonWitnessUtxo`) to verify the amount, which makes *signing* slow even
  though the coin itself is fine. It already has a `source: 'pool-batch' |
  'batch' | ...` distinction, per-device signing-time estimates
  (`perDeviceLine`), and user-facing copy explaining "mass ≠ fees." **This was
  built for the receiving side** (Cairn users who get paid by a pool/exchange
  that batches). This plan is about the **sending side** — Cairn itself acting
  as the pool/exchange — and should reuse this module's mental model and
  copy conventions rather than reinvent them, but it is not itself the
  sending feature.
- Fee estimation
  ([`src/lib/server/chain/index.ts:434`](src/lib/server/chain/index.ts),
  `getFeeEstimates()`) already returns esplora/mempool.space-compatible
  sat/vB tiers (`fastest`/`halfHour`/`hour`/`economy`), and `psbt.ts`'s fee
  math is already vsize-based and scales linearly with output count — no
  rework needed, just needs to be surfaced per-recipient in the batch preview
  (§5).
- Coinbase/mining-reward maturity enforcement
  (`src/lib/server/bitcoin/coinbaseScan.ts`, `psbt.ts:274-291`) is already
  correct and orthogonal to this feature — batch *sends* don't touch it,
  only batch *receives from a pool* do (already handled).

**What does NOT exist and is the real scope of this plan:**

- Any output-count/size ceiling on `constructPsbt()` — needed to stop the
  server from building a PSBT that will be dead-on-arrival everywhere it goes
  (see §2).
- CSV import, bulk validation, and a UI that can handle hundreds–thousands of
  rows without falling over (see §5).
- A "split into multiple transactions" strategy for batches too large for one
  transaction or one hardware-wallet signing session (see §2, §4).
- Batch scheduling/queuing (immediate vs. time/threshold-batched vs.
  recurring) — Cairn has no concept of a pending/queued send today; every
  send is synchronous end-to-end (see §7).
- Any of this is genuinely new. Estimate: **large** relative to other recent
  Cairn features — this is closer in scope to the whole multisig wizard than
  to a UI tweak.

---

## 1. Use cases

| Use case | Recipient count | Cadence | Who |
|---|---|---|---|
| Mining pool payouts | 500–5,500 (F2Pool observed range) | Every block or on a timer/threshold | Pool operators |
| Exchange withdrawals | 10s–100s | Batched every 1–30 min | Exchange ops |
| Payroll | 5–500 | Monthly/biweekly, recurring | Small-to-mid businesses paying in BTC |
| Donations/grants disbursement | 10s–100s | One-off or occasional | Foundations, DAOs, grant committees |
| Power-user consolidation-avoidance | 2–20 | Ad hoc | Individuals paying several people at once |

The first three are the ones that actually need everything in this plan
(CSV import, splitting, scheduling). The last two are already mostly served
by the existing manual multi-row UI and mainly need the UI to not choke past
~20 rows and to get a proper fee/total preview.

## 2. Bitcoin transaction limits (why batch size has a hard ceiling)

- **Consensus limit**: 4,000,000 weight units (1,000,000 vbytes) per block —
  not a per-transaction limit, but nothing bigger than a block can ever
  confirm.
- **Practical mempool/relay limit — this is the one that matters**: Bitcoin
  Core's default standardness policy refuses to relay or mine any
  transaction over **100,000 vbytes** (`MAX_STANDARD_TX_WEIGHT`, i.e. 400,000
  WU). A batch transaction built bigger than this will not propagate on
  mainnet even at a generous fee rate — full stop. This is the design ceiling
  for §5's splitting logic.
  ([Bitcoin Optech: payment batching](https://bitcoinops.org/en/topics/payment-batching/))
- **Per-output vsize cost** (what determines how many recipients fit in
  100,000 vbytes): native SegWit (bc1q) output ≈ 31 vB, Taproot (bc1p) ≈ 43
  vB, legacy/P2SH ≈ 34 vB. Base tx overhead ≈ 10-11 vB plus per-input cost
  (SegWit input ≈ 68.5 vB, legacy ≈ 148 vB).
  ([transaction size calculator](https://bitcoinops.org/en/tools/calc-size/))
- **Rough capacity math**: a batch spending a handful of inputs and paying to
  bech32 addresses gets roughly **(100,000 − ~100) / 31 ≈ 3,200 outputs**
  before hitting the standardness ceiling — consistent with F2Pool's observed
  2,500–5,500 range (they likely span 1-2 transactions per payout run, or run
  close to the edge deliberately). **This is the number to design around**:
  Cairn's batch builder must compute projected vsize as recipients are added
  and hard-stop (or auto-split, see §4) well before 100,000 vbytes, with
  margin for the change output and any input growth from coin selection.
- **Ancestor/descendant mempool limits**: an unconfirmed transaction chain is
  capped at 25 ancestors/descendants by default mempool policy. Not directly
  relevant to a single well-formed batch payout (which is usually a single
  transaction spending confirmed coins), but relevant if Cairn ever chains
  batch transactions back-to-back before the previous one confirms (e.g. a
  "top up the payout wallet" transaction feeding a batch spend in the same
  block window) — worth a guard rail in scheduling (§7), not day-one work.

## 3. How others do it (research findings)

**Strike**: does not construct large on-chain multi-output transactions
itself for consumer sends — it settles Lightning internally and periodically
sweeps accumulated Lightning receipts to a merchant's on-chain wallet in a
single batched transaction, with the batching threshold configurable
(0.1–1 BTC) or time-based. This is a "many small internal ledger entries →
one on-chain output" pattern, not "one on-chain transaction with many
distinct final recipients" — different from the mining-pool/exchange
withdrawal case this plan targets, but the same batching *philosophy*
(aggregate, then flush).

**Mining pools (Foundry, F2Pool, Ocean, AntPool)**: sweep the pool's payout
wallet (accumulated from coinbase rewards, after the 100-block maturity
window Cairn already models) into a single large multi-output transaction per
payout run, rather than paying directly from coinbase UTXOs — coinbase
outputs are illiquid until mature and pools want payout timing decoupled from
which specific block matured. F2Pool's observed 2,500–5,500 output count per
transaction lines up with the vbyte math in §2. Payout methods (FPPS/PPS) are
an accounting layer on top — orthogonal to transaction construction.

**Exchanges (Coinbase, Kraken, River)**: batch on a **timer**, not a count
threshold. Coinbase batches at least once per minute and reported a ~75%
fee-per-withdrawal reduction after launching batching in 2018; River batches
standard/free withdrawals and broadcasts within a few hours (explicitly
trading latency for fee savings, disclosed to users up front). The consistent
pattern: a short queuing window (minutes, not seconds) captures most of the
fee benefit without materially hurting withdrawal UX, and users are told
withdrawals aren't instant when using the free/batched tier (paid/instant
tiers skip the queue and pay full per-tx fees).
([Coinbase: Reflections on Bitcoin Transaction Batching](https://www.coinbase.com/blog/reflections-on-bitcoin-transaction-batching),
[River: Batching](https://river.com/learn/terms/b/batching/))

**Bull Bitcoin's Batcher** (open-source, self-hosted, closest architectural
analog to what Cairn would need to build): queues withdrawal requests and
flushes them into one `sendmany`-style transaction on **whichever trigger
fires first** — a configurable timer (`BATCH_TIMEOUT_MINUTES`) or a
configurable accumulated-amount threshold (`BATCH_THRESHOLD_AMOUNT`), e.g.
"every hour or every 1 BTC, whichever comes first." Payments can be dequeued
before the batch fires (opt-out, pay solo). This dual-trigger model is the
right default for Cairn's own scheduling design in §7 — it's simple, well
understood, and battle-tested.
([Bull Bitcoin: Batcher](https://medium.com/bull-bitcoin/batcher-by-bull-bitcoin-open-source-non-custodial-on-chain-bitcoin-core-transaction-batching-api-b81e734a59e6))

**BTCPay Server Payouts**: a merchant creates individual "payout" records
(refunds, salary, withdrawals) that sit in an "Awaiting Approval" queue. The
merchant reviews the queue and explicitly chooses to batch-approve a
selection into one PSBT, sign it once, and broadcast — an **explicit,
human-gated batch trigger**, not automatic time/threshold batching. Good
model for Cairn's power-user/payroll use case (§1); the automatic
time/threshold model (Bull Bitcoin, exchanges) fits the pool/exchange use
case better. **Recommendation: support both** — an "approve queue now" manual
trigger for humans, and an optional time/threshold auto-flush for API/machine
use — rather than picking one.
([BTCPay Payouts docs](https://docs.btcpayserver.org/Payouts/))

**Sparrow Wallet "Send to Many"** (closest UX analog for a desktop wallet,
non-custodial): a dedicated Tools-menu screen, separate from the normal send
form, that accepts manual `+Add` rows *or* a CSV paste/file with one
`address,amount` pair per line, previews the combined transaction, and lets
the user label the batch as a whole. This validates the plan in §5's UI
design — a **separate batch-send surface**, not a stretched version of the
existing 1-3-recipient send form. (Sparrow has a known bug where per-row
labels collapse to the first row's label in the confirm screen — worth
avoiding by keeping the recipients array structurally labeled all the way to
the confirm step.)

## 4. Transaction construction, fee estimation, and splitting

**Extending `constructPsbt()`** (no architecture change, additive):

1. Add a **projected-vsize guard** as recipients accumulate: after BIP69
   ordering and before finalizing, compute vsize using the same
   `outputVsize`/input-cost math already in `psbt.ts`, and reject (or
   trigger auto-split, below) once projected vsize exceeds a configurable
   ceiling — default **90,000 vbytes**, leaving ~10% margin under the
   100,000 vbyte standardness wall for coin-selection variance (e.g. an extra
   input pulled in late, a Taproot change output).
2. **Auto-split strategy**: when a requested batch exceeds the ceiling,
   partition recipients into N transactions rather than failing outright.
   Simplest correct approach: greedily fill each transaction to the vsize
   ceiling in the order recipients were submitted (stable, predictable,
   auditable), each transaction independently coin-selected and each with
   its own change output. Do **not** try to share inputs/change across the
   split transactions — that reintroduces the ancestor-chain problem from
   §2 for no benefit. Surface the split plainly in the UI preview ("this
   batch will be sent as 3 separate transactions") — never split silently.
3. **Fee estimation for the preview**: reuse `getFeeEstimates()` as today;
   the total fee scales linearly with output count via the existing vsize
   math, so a per-recipient "your share of the fee" figure is just
   `totalFee * (recipientOutputVsize / totalVsize)` — cheap to compute,
   worth showing since it's the number pool/exchange operators actually
   care about reconciling against.
4. **Dust handling** (`DUST_SATS = 546` already defined at psbt.ts:139):
   currently a single sub-dust recipient throws for the whole PSBT
   (psbt.ts:412). For a 2,000-row batch import, one bad row should not
   invalidate the other 1,999. Recommendation: validate all rows up front
   in the UI/API layer (below dust → flagged, never silently dropped) and
   require the user to fix or explicitly exclude flagged rows before
   `constructPsbt()` ever sees them — keep `constructPsbt()`'s existing
   hard-reject behavior as the last line of defense, don't weaken it.

## 5. PSBT size and hardware wallet signing limits

This is the sharpest technical constraint in the whole feature, and it's
already partially modeled by `signingMass.ts` — but that module measures the
mass of *inputs* (parent tx size via `nonWitnessUtxo`). Batch **sending**
adds a second, independent size pressure: **output count itself** bloats the
PSBT, and every hardware wallet has a real ceiling here.

- **Root cause**: a PSBT includes each input's full previous transaction
  (`nonWitnessUtxo`) unless the wallet/device trusts SegWit's `witnessUtxo`
  shortcut — many hardware wallets still require the full parent for
  security. Documented real-world failure: a 100-input transaction, 14 KB
  unsigned, ballooned to a **505 KB** PSBT once parent transactions were
  attached.
- **Device-specific ceilings observed**:
  - **Coldcard**: hard errors with "PSBT is too big" past its SD-card/USB
    wire-protocol payload limit (**384 KB**).
  - **Ledger** (Nano S/X): no hard size error, but silently times out /
    fails after ~5-6 minutes on oversized PSBTs.
  - **Trezor**: multisig is capped at n-of-15 by firmware (unrelated to
    batch size, but a co-occurring constraint worth remembering if a
    multisig wallet is the one sending a batch).
- **Cairn-specific mitigation already half-built**: `signingMass.ts`'s
  per-device time estimates and "mass ≠ fees" framing should be extended to
  the **outbound** batch-preview screen too — before the user picks a
  device to sign with, show "ColdCard: ~X min, Ledger: may time out, Trezor:
  ~Y min" using the same tiering logic, not a separate implementation.
- **Workarounds to design for**, roughly in priority order:
  1. **Prefer `witnessUtxo`-only where the signer accepts it** — check per
     device driver (`src/lib/hw/*.ts`) whether omitting `nonWitnessUtxo` for
     SegWit inputs is already the default; if not, this is the single
     highest-leverage size reduction and should land before anything else
     in this section.
  2. **Auto-split (§4) doubles as a signing-limit workaround** — a
     transaction split for mempool-size reasons is very likely already
     small enough to sign, since 90,000 vbytes of *outputs* is nowhere near
     Coldcard's 384 KB PSBT ceiling on its own; the dangerous case is many
     outputs **plus** many large-parent inputs at once. The splitter should
     consider *both* projected vsize and projected PSBT byte size (inputs'
     attached parents included), not vsize alone.
  3. **QR/animated-QR signing** (`QrSigner.svelte`, already exists for
     air-gapped signing) has its own practical ceiling — UR-encoded PSBT
     transfer degrades badly well before 384 KB. For very large batches,
     recommend USB/file-based signing paths (Coldcard SD, Ledger/Trezor
     direct) over QR, and say so explicitly in the device picker when a
     batch is large.
  4. **Last resort, not a v1 requirement**: for batches too large for any
     single device to sign in one session, some workflows accept the
     transaction fee hit of just running it as more, smaller batch
     transactions purely to keep each PSBT signable — i.e. the splitting
     threshold in §4 could be tightened further, per-device, rather than
     fixed at the mempool ceiling. Worth a follow-up once real device
     testing data exists; don't over-engineer this ahead of measurements.

## 6. UI design

Mirroring the Sparrow "Send to Many" pattern rather than stretching the
existing 1-3-row send form (`+page.svelte`) past what it was built for:

- **Entry point**: a distinct "Batch send" flow off the wallet's send
  surface (button/tab next to the existing single-send form), not a mode
  toggle buried inside it — the existing form's `isMax`/coin-control
  interactions are already single-recipient-shaped and shouldn't be
  contorted to also handle CSV import and 1,000-row rendering.
- **Input methods**:
  - **CSV upload/paste**: `address,amount` per line (accept both BTC and
    sat units, auto-detect by presence of a decimal point + magnitude, but
    require the user to confirm which unit was assumed before proceeding —
    ambiguity here is a real-money mistake).
  - **Manual add-recipient**: keep the existing `+Add` row pattern for
    small batches (reuse, don't rebuild).
  - Both paths converge on the same in-memory `RecipientRow[]` model the
    current form already uses.
- **Validation, per Sparrow/BVNK-style batch-tool conventions**: validate
  every row on import, **don't halt the whole batch on one bad row**. Flag
  invalid rows inline (bad address checksum, wrong network, sub-dust
  amount, duplicate address) with a per-row error, let the user fix or
  exclude flagged rows in place, and block "Continue" only while any row is
  unresolved (not simply "any row invalid" silently dropped). Reuse
  `src/lib/server/bitcoin/xpub.ts`'s address validation as-is — no new
  validation logic needed there.
- **Preview screen** (before signing): total amount, recipient count,
  estimated fee (and fee rate used), per-recipient fee share (§4), whether
  the batch will be split into multiple transactions and why, and the
  signing-mass/device-time estimate from §5. This is the screen that
  most needs new work — nothing like it exists today.
- **Performance**: a plain `{#each}` over 2,000 Svelte rows will jank.
  Virtualize the recipient list past some threshold (a few hundred rows) —
  standard windowed-list technique, no exotic approach needed.
- **Error handling summary**: never let one bad row block 1,999 good ones;
  never silently drop a row either — always show what was excluded and why,
  matching the "no silent caps" principle worth applying broadly here.

## 7. Batch scheduling

Cairn has no queued/pending-send concept today — every send is built and
broadcast synchronously in one request. Recommend introducing this as its
own primitive rather than special-casing it inside batch send:

- **v1 scope: immediate only.** Build and preview the batch, sign, broadcast
  — same as today's send flow, just with N recipients instead of 1-3. This
  alone unlocks the payroll/donation/power-user use cases (§1) and is a
  fraction of the effort of full scheduling.
- **v2: manual queue (BTCPay-style)** — recipients can be added to a
  pending batch over time (e.g. an API endpoint pool-operator software
  calls per payout as it's calculated), with an explicit human (or
  scheduled job) "flush now" action that builds/signs/broadcasts everything
  queued so far. Matches the payroll/grants use case where recipients
  trickle in before a monthly run.
- **v3: automatic time/threshold flush (Bull Bitcoin-style)** — a
  configurable "flush every N minutes OR once queued value exceeds X BTC,
  whichever first" background job. This is the piece that actually serves
  mining pools and exchanges at their real operating cadence, and it's the
  most architecturally novel part of this whole plan for Cairn (background
  jobs, a queue table, unattended broadcast — all new concepts for this
  codebase). Should not be attempted until v1/v2 are shipped and the
  splitting/signing-limit logic (§4, §5) is proven correct on real batches.
- **Recurring/scheduled batches** (e.g. "run payroll on the 1st of every
  month") is a thin layer on top of v2/v3 and not worth designing in detail
  now — revisit once the queue primitive exists.

## 8. Batched RBF — additive batching (Strike-style)

Alex asked specifically about this after §3/§7 were already written — it's a
**different mechanism** from everything above, not a variant of it. §7's
model is *queue, then flush once* (broadcast happens after accumulation
stops). Strike's technique is *broadcast early, then keep mutating the
still-unconfirmed transaction* by replacing it with a superset version every
time a new recipient shows up — RBF used as an append mechanism, not just a
stuck-fee rescue.

**What Cairn already has, checked directly against the code**: this is not
starting from zero.
[`src/lib/server/bitcoin/psbt.ts:156`](src/lib/server/bitcoin/psbt.ts)
(`RBF_SEQUENCE = 0xfffffffd`) signals BIP-125 replaceability on every input of
every transaction Cairn builds, unconditionally — nothing needs to change
there.
[`src/lib/server/transactions.ts`](src/lib/server/transactions.ts)'s
`bumpTransaction()` already implements a real BIP-125 replacement: it enforces
rule 1 (signaling check, line 619-628), rule 4 (minimum incremental fee, line
689-701), spends the identical input set via `exactInputs` (psbt.ts:72), and
tracks the chain via a `replaces_txid` column and a `superseded` status
(transactions.ts:433-445) so only one version of a replaced transaction is
ever treated as live. **What this does NOT do**: it only ever changes the fee
— same recipients, same amounts, every time. Additive batching's entire
technical delta is *allowing a replacement to add new outputs*, not just
raise the fee on an unchanged set.

### 8.1 How Strike does it

Confirmed via Strike's own engineering blog
([Batching On-chain Sends](https://strike.me/blog/batching-on-chain-sends/),
Aug 2024): Strike batches "Priority send" withdrawal requests into a
transaction and broadcasts it once. While it's still unconfirmed, instead of
creating a *new sibling* transaction for the next wave of requests, Strike
appends the new recipients as additional outputs and rebroadcasts the result
as an RBF replacement — fee-bumped to the current market rate as part of the
same operation, so every append also refreshes the fee. Strike reports
30-50% cost savings per payment versus one transaction per withdrawal. The
operational challenge Strike calls out explicitly: a race between "a
non-latest version of the batch gets mined" and "we're still appending to
what we think is the latest version" — they must track exactly which
version (v1, v2, v3...) of a batch chain actually confirms, and roll any
recipients that were appended to a version that never got mined into a brand
new transaction. This requires meticulous bookkeeping of which txid is
currently "live," conceptually extending Cairn's existing
`replaces_txid`/`superseded` model from a single A→B link into an arbitrarily
long chain.

### 8.2 CardCoins field report — a second real implementation, harder edges

Bitcoin Optech published a field report on CardCoins doing the same additive
RBF batching
([Field Report: Using RBF and Additive Batching](https://bitcoinops.org/en/cardcoins-rbf-batching/)),
and it surfaces failure modes Strike's own post doesn't dwell on:

- **Customer confusion**: a customer's wallet shows their withdrawal's txid
  changing repeatedly as each replacement broadcasts — needs explicit product
  copy ("still processing, this is normal") or customers file support
  tickets thinking something's wrong.
- **Spending unconfirmed outputs pins the batch**: if a recipient (or a
  downstream service that receives the withdrawal and immediately forwards
  it) spends their still-unconfirmed output, that creates a descendant
  transaction. Mempool descendant/pinning limits then let that descendant
  **pin** the parent — the batching service can no longer replace it, even
  to legitimately bump a stuck fee, let alone append more recipients. This
  isn't something the batching operator controls; it happens downstream.
- **Net effect**: additive RBF batching is a real cost saver but introduces a
  category of bug that Cairn's existing fee-bump-only RBF doesn't have,
  because the *set of outputs* is now changing shape over time, not just the
  fee.

### 8.3 Who else does this

Not standard practice at Coinbase/Kraken/River (§3) — those batch on a pure
time/threshold queue-then-flush-once model, with no public evidence of
additive RBF. Strike and CardCoins are the only two documented real-world
implementations found. This is a niche technique used by a handful of
high-volume custodial operators with server-held keys, not an industry norm
— worth flagging so it isn't over-prioritized relative to §7's more common
and lower-risk time/threshold model.

### 8.4 Technical requirements

1. **Signaling** — already satisfied, no new work (see above).
2. **BIP-125 rules beyond what `bumpTransaction()` already checks** — rule 2
   (a replacement must not introduce *new unconfirmed* inputs) becomes live
   here in a way it isn't for a pure fee bump: appending recipients can
   shrink the change output below what the added fee needs, forcing
   additional inputs to be pulled in. Those must come from Cairn's existing
   confirmed-only coin selection, never from the batch's own (still
   unconfirmed) change — `exactInputs` mode (psbt.ts:72) is pure
   spend-the-same-inputs and doesn't fit; additive mode needs a third
   variant: "spend these exact inputs, plus optionally more confirmed
   coins."
3. **Never drop or shrink an existing recipient — the one hard invariant.**
   Every replacement must be a strict superset of the prior version's
   outputs: identical address+amount for every recipient already appended,
   changing only the new outputs added, the change value, and the fee. This
   is stricter than BIP-125 requires (BIP-125 doesn't forbid removing
   outputs) but is a Cairn product requirement — silently dropping a
   recipient a replacement no longer includes is a payment failure for
   whoever was expecting it. If a recipient must be pulled after the fact
   (compliance hold, user cancellation), that has to become a fresh,
   unrelated transaction, never framed as a "replacement" of the batch.
4. **Version-chain tracking, extended.** `replaces_txid`/`superseded`
   (transactions.ts:433-445) models one A→B replacement. Additive batching
   needs the same idea extended to an arbitrary A→B→C→D chain, plus new
   reconciliation logic Cairn doesn't have today: when any *non-latest*
   version in the chain confirms (Strike's core race condition, §8.1),
   whatever was appended after that version must be automatically detected
   and rolled into a brand-new transaction rather than silently lost.
5. **Pinning defense.** Since Cairn has no visibility into whether a
   recipient or downstream service has spent an unconfirmed output (§8.2),
   the practical mitigation is defensive, not detective: cap how long a
   batch stays open for additive append (a short window, not indefinite),
   and stop appending — falling back to a fresh transaction for further
   recipients — once the change output gets too thin to safely absorb
   another fee bump, rather than trying to detect pinning after it's already
   happened.
6. **Txid churn breaks anything keyed by a single txid.** A batch that stays
   open for append could change txid every few minutes for as long as it's
   open — a bigger UI/activity-feed lift than a normal RBF bump (which
   changes txid once). Any UI, block-explorer link, or activity-feed entry
   for an open batch needs to track the version chain, not a single txid.
7. **"Malleability" is not the risk here — worth stating explicitly.**
   Classic pre-SegWit transaction malleability (a third party mutating an
   unconfirmed transaction's txid without changing its economics) is a
   non-issue for Cairn's SegWit/PSBT-only stack. The txid instability in
   this feature is Cairn's *own* deliberate replacements, not third-party
   mutation — a future engineer shouldn't chase the wrong threat model here.

### 8.5 Multisig implications — the actual blocker for Cairn

Strike and CardCoins are custodial services with server-held keys: appending
a recipient and re-signing is fully automated and sub-second, no human in the
loop. Cairn's multisig wallets require M-of-N independent hardware-device
signatures (§5). Every additive-RBF replacement is a **new PSBT** — different
outputs, different change value, different fee — which means every cosigner
must plug in their device and sign again, from scratch, for every single
append. At Strike's cadence (append whenever a new withdrawal request
arrives, potentially every few minutes) this is a non-starter for any wallet
that isn't single-sig with an always-online key: nobody is re-signing with a
Coldcard every three minutes to let one more recipient into a batch.

**Recommendation**: do not build continuous additive-RBF-append for Cairn's
multisig wallets. Two narrower things fit instead, both consistent with
infrastructure that already exists:

- **Manual fee-bump RBF already works today** (`bumpTransaction()`) and is
  the right — and only — RBF use case for multisig: a stuck batch gets
  re-signed *once*, by the same cosigners, at a higher fee, with the
  identical recipient set. This is not additive batching and the UI copy
  should not conflate the two.
- The "don't create a new transaction per withdrawal" benefit Alex is really
  after for the mining-pool/exchange-operator persona (§1) fits much more
  naturally as **pre-broadcast queuing** (§7 v2/v3): accumulate recipients,
  sign *once*, broadcast *once*. Same fee-savings shape as Strike's
  technique, without ever asking cosigners to re-sign a moving target. This
  is very likely what Cairn should actually build for that persona, rather
  than literal Strike-style post-broadcast RBF append.
- True additive RBF is only worth revisiting if/when Cairn supports a
  single-sig hot-wallet role with a server-held (non-hardware) key
  specifically for this kind of automated high-frequency operation — out of
  scope for the multisig-first wallets this plan targets today.

## 9. Subagent breakdown for a future Opus build session

Ordered by dependency, each roughly independent enough to hand to a separate
unit once the prior phase's contract is fixed:

1. **`constructPsbt()` size guard + splitter** (§2, §4) — server-only,
   `psbt.ts` and its tests. No UI dependency; can build and unit-test against
   synthetic recipient lists entirely offline. Blocks everything else, build
   first.
2. **Batch preview API** — a new endpoint that takes a candidate recipient
   list and returns projected vsize/fee/split-plan/per-device signing
   estimate (composing #1 with the existing `signingMass.ts` model) without
   committing to a PSBT. This is what the UI preview screen (§6) calls.
3. **Batch-send UI** (§6) — CSV import, manual rows, virtualized list,
   validation, preview screen consuming #2. Can be prototyped against a
   stubbed preview API while #1/#2 are still landing.
4. **Hardware-signing hardening** (§5) — audit each `src/lib/hw/*.ts` driver
   for `witnessUtxo`-only opportunities and device-specific size ceilings;
   extend `signingMass.ts`'s copy/tiering to the outbound flow. Depends on
   #1's splitter existing so real large-batch PSBTs can be generated for
   testing against actual devices.
5. **Scheduling v2 (manual queue)** — new `batch_queue`-style table + API,
   BTCPay-style explicit flush. Depends on #1-#3 being stable (the queue
   just needs to produce the same recipient list #1-#3 already consume).
6. **Scheduling v3 (auto time/threshold flush)** — background job
   infrastructure, the most novel and highest-risk phase; do this last and
   only after v2 has real usage.
7. **Additive-RBF batching (§8)** — deliberately last and explicitly optional:
   per §8.5, this only makes sense for a future single-sig hot-wallet role,
   not the multisig wallets v1-v3 target. Don't schedule this phase until
   that role exists; if it never does, this phase never gets built and that's
   the right outcome, not an oversight.

Each phase should get its own "corrected starting assumption" section like
this doc's §0 when it's actually scoped for building — don't let a future
session assume more or less already exists than is true at that time.

## 10. Open questions (not blocking, but worth flagging)

- Does Cairn need per-recipient labels/memos persisted for reconciliation
  (mining pools care about this for accounting)? `recipients` JSON column
  already has room; UI doesn't expose it yet.
- Should batch sends get their own entry in the activity feed
  ([[cairn-observability]] conventions) distinct from single sends, or reuse
  the existing transaction log with a "batch of N" summary? Lean toward the
  latter for consistency, but not decided.
- Multisig batch signing means **every cosigner** must sign the same
  potentially-huge PSBT — coordination/PSBT-passing UX for multisig batch
  sends isn't addressed above and may need its own mini-plan once v1 lands.
  §8.5 covers the sharper version of this problem for additive-RBF batching
  specifically (re-signing on every append, not just once per batch).
