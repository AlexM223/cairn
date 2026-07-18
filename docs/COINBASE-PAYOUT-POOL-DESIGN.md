# Coinbase-Payout Mining Pool — Design Document

**Ocean-style split payout for Heartwood's multi-user solo pool.**

Status: DESIGNED, NOT BUILT — gated on the `cairn-vn43.14` legal decision
Epic: TBD (follows `cairn-vn43`)
Date: 2026-07-18

---

## 1. Executive summary

Heartwood shipped a multi-user **solo** mining pool in v0.2.34 (epic `cairn-vn43`):
any authenticated user can point a miner at one shared Stratum listener, and a
found block pays the finding connection's own wallet in full — no splitting,
no custody, no accounting. This document designs the next step: an
**Ocean-style coinbase-split payout mode**. A found block's coinbase pays the
**finder** a configurable percentage, a **top-N leaderboard** of the round's
best miners a configurable percentage, and the **operator** a configurable fee
percentage — all three legs paid directly by the coinbase transaction itself,
to addresses the engine already knows. Every payout is a fixed percentage of
`coinbasevalue`, so the design is halving-proof by construction: it needs no
BTC-denominated constants anywhere. There is **zero custody at any point** —
funds never sit in an operator-controlled balance; the network pays miners
directly, the same non-custodial posture the solo pool already has.

**Phase 1** is a single Heartwood instance running its own leaderboard and its
own rounds. **Phase 2** is federation: multiple Heartwood instances gossiping
share evidence over the existing Tor transport so miners at *different*
instances compete on one meta-leaderboard, still paid out of whichever
instance's block is found. Phase 2 is R&D-stage, not a near-term build.

**This is gated, prominently, on the `cairn-vn43.14` legal decision.** The
solo pool's hard legal gate — no reward-splitting, no pooled/PPS/PPLNS payout,
no custody of one user's coins by another or by the operator — was a
deliberate design choice, reviewed and shipped as-is in v0.2.34. This design
proposes crossing that gate: the operator would begin setting third-party
payout percentages and taking a fee output, which changes the instance's
regulatory and tax posture even though custody never enters the picture. See
§13. Nothing in this document should be read as a decision to build; it is
the design that exists *if and when* Alex clears that gate.

---

## 2. Owner decisions (fixed)

These are Alex's rulings. The rest of this document is the design that
implements them, not a menu of alternatives to them:

1. **Per-miner templates.** Every connection still gets its own personalized
   coinbase (as today) — the miner is the finder in their own template.
2. **Finder gets the largest percentage** of the coinbase, always.
3. **Top-N leaderboard, ranked by best share difficulty.** Not PPLNS, not a
   rolling window.
4. **Beat-only, no time decay.** An entry holds its slot until it is beaten
   by a better share, or the round ends. No window, no aging, no decay
   function.
5. **Round resets on block found.** A found block closes the round and opens
   a fresh one; the leaderboard starts empty.
6. **Everything is percentage-based.** No fixed-sat payouts anywhere in the
   design.
7. **All percentages are admin-configurable, including the finder
   percentage.** No hardcoded splits.
8. **Real-time output updates.** The leaderboard and its effect on payout
   outputs update live, not on a batch cadence visible to the user.
9. **Centralized template construction.** One engine builds one shared
   coinbase tail (leaderboard + fee) and personalizes only the finder output
   per connection — not N independent template builders.
10. **Hash-hopping between Heartwood instances is a feature, not a bug.**
    Miners moving their hashrate toward whichever instance currently offers
    the best opportunity is treated as healthy market behavior to design
    for, not an exploit to close.

---

## 3. Prior art

No existing pool implements a top-N-best-share leaderboard payout. This
design is novel on that specific axis. The relevant precedents bound the
design space on the one axis that *is* well trodden — how much of the
coinbase the finder keeps:

- **Ocean (TIDES)** — finder keeps **0%** above the shared payout; every
  miner's share of the coinbase is `miner_shares_in_window / window_total ×
  reward × (1 − fee)`, windowed at `network_difficulty × 8`, fee 2% (1% for
  DATUM, Ocean's miner-built-template mode — the pool still dictates the
  generation-tx payout outputs and primary tag even when miners build their
  own templates). Payouts land directly in miner wallets, no custody.
  On-chain minimum payout is 1,048,576 sats; anything below that carries
  forward, which requires balance accounting — a mechanism this design
  explicitly does **not** adopt (§6, "Ocean's carry-forward"). Precedent for
  a very wide coinbase: Eligius has shipped 900+ output coinbase
  transactions. Coinbase maturity is 100 blocks; dust relay limits are 294
  sats (P2WPKH) / 546 sats (P2PKH).
- **This design** — finder keeps a configurable, admin-set percentage
  (recommended default 40%, Alex's preferred 50% also acceptable, range
  20–60%), with a leaderboard trickle and a 2% operator fee filling the
  remainder. See §6 for the full game-theoretic justification of where this
  sits between the two anchors.
- **solo ckpool** — finder keeps **~98%**, operator 2%, no accounting, no
  custody. Each miner mines to their own address; `BTCSOLO` mode requires
  usernames to literally be Bitcoin addresses. Templates regenerate on every
  block change with the full transaction set — same shape Heartwood's engine
  already uses.

The spectrum: **Ocean 0% finder … this design (20–60%, recommended 40%) …
ckpool ~98% finder.** Ocean minimizes variance and pays proportionally at the
cost of the "jackpot" feeling; ckpool preserves the full solo jackpot with
zero pooling benefit. This design deliberately sits in between: finder keeps
a meaningful jackpot, the leaderboard gives small miners something to chase
between wins.

---

## 4. What exists today

**Heartwood's shipped multi-user solo pool** (`src/lib/server/mining/`,
v0.2.34, epic `cairn-vn43`):

- `stratum.ts` — Stratum V1 TCP server. Per-connection random unique 4-byte
  extranonce1; `mining.authorize` resolves `miningId.workerName` via
  `AuthProvider`; vardiff steps by power-of-two (×2/÷2), clamped, and is
  frozen per `(connection, jobId)`; dedupes accepted submits on
  `en1:en2:nonce`; rate-limits stale submits; sends a personalized
  `mining.notify` per connection.
- `job.ts` `buildJob()` — `scriptSig = BIP34 height ‖ poolTag ‖ EN1(4) ‖
  EN2(4)`, capped at 100 bytes; coinbase today is **exactly one** value
  output (the full reward, to the miner's own wallet script) plus a
  zero-value witness commitment. There is a **hard error if more than one
  value-bearing output is present** ("splitting is forbidden"), plus a
  value-conservation assert. This single check *is* the `cairn-vn43.14`
  legal gate, expressed in code.
- `miningPool.ts` — a `TipPoller` polling every 1s, `getblocktemplate
  {rules:[segwit]}` → `buildJob` → `setJob`; a 30s fee refresh
  (`cleanJobs:false`); all tip/solve/refresh events go through one
  serialized promise queue. On solve: re-personalize, assemble, assert the
  hash matches, `submitblock`.
- `aggregates.ts` — in-memory share aggregates, flushed to SQLite in a
  single transaction every 15s (avoids the sync-SQLite contention hazard);
  per-worker `best_share_diff` is tracked with milestone notifications.
- `authTable.ts` — a 60s snapshot that peeks each enabled miner's next
  receive address and pre-encodes their payout script; the finder's address
  cursor is advanced only when their block is accepted.
- **DB:** `mining_prefs`, `mining_workers` (cumulative counters,
  `best_share_diff`), `mining_stats` (1-minute buckets, with a `round_id`
  column already reserved and explicitly `NULL` today as a future
  split-mode seam), `mining_blocks`. There is an explicit DB comment
  prohibiting any value-owed-across-users accounting.
- **Views:** user page `/mining` + `GET /api/mining/me` (credentials,
  per-worker stats, earnings, solo odds); admin `/admin/mining` + `GET
  /api/admin/mining` (engine status, workers, hashrate series, per-user
  `sharePct`, recent blocks). Mining is off by default — feature flag,
  setting, and Core RPC are all required.
- **Payout today** is native: the coinbase pays the finder's wallet
  directly. There is no accounting anywhere. A `mining_blocks` row and
  notifications fire on accept.

**Tessera (`C:\dev\raffle`)**, Alex's earlier pool codebase, already proves
the split-coinbase mechanics work:

- `core/src/coinbase.ts` `buildCoinbaseTransaction` is **already
  multi-output**: `out[0]` pool fee (absorbing remainder, dust, and
  unpayable-address fallbacks), `out[1]` finder bounty (2%), `out[2..N]`
  winner loop (up to 30 winners), plus `OP_RETURN` commitments.
  `Σoutputs == coinbaseValue` is asserted. Address→script conversion is
  ECC-free (bech32/bech32m OP_N direct, base58 fallback). BIP34 height push
  and 100-byte scriptSig trim are both present.
- `pool/src/job.ts` — `en1Offset = 4 + 1 + 36 + varint(scriptLen) +
  scriptPrefix.length` is computed purely from the **input** side, which
  means the coinb1/coinb2 extranonce split is **output-count-independent**.
  This is the single most important enabling fact for this design (§5).
  Merkle branches are computed once per job from template txids only —
  coinbase outputs never affect them; `applyBranches` refolds only the
  coinbase leaf per share, `O(depth)`. The witness commitment is appended
  after the conservation check. Per-connection variants today differ only
  in the finder output, and are rebuilt on every announce **and every
  submit with no memoization** — a real hot-path cost this design fixes
  (§5, "Update cadence"). Tip poll is 250ms; a full template rebuild only
  happens on a new block.

**Heartwood's hard single-output gate is the `cairn-vn43.14` legal line.**
Tessera proves the multi-output mechanics are sound and already built;
crossing into split-payout mode is a legal decision, not an engineering one.

---

## 5. Architecture

### 5.1 Core structural insight

`en1Offset` is output-count-independent (Heartwood `job.ts:105` /
Tessera `job.ts:115`), and merkle branches are independent of coinbase
outputs entirely. Heartwood's freeze today is per-`(connection, jobId)`
finder-payout only (`stratum.ts:158`, frozen at `:448`, re-personalized on
every submit at `:643` — with no memoization). `installJob` mints a fresh
`jobId` on every build (`miningPool.ts:243`); the tip/solve/refresh queue is
already serialized (`miningPool.ts:67`); `authTable`'s payout scripts are
already reusable for a leaderboard join.

**INV-7** (below) is the structural consequence: since every payout value is
a fixed percentage of `coinbasevalue`, the entire coinbase **tail** —
leaderboard outputs, fee output, `OP_RETURN`, witness commitment — is
byte-identical across every connection's template for a given `jobId`. Only
`out[0]`, the finder script, varies per connection. Per-miner personalization
therefore collapses to a **one-output swap**; a `(jobId, finderScriptHex) →
CoinbaseVariant` memo is small and correct.

### 5.2 Payout-set lifecycle

A `PayoutSet` (leaderboard scripts + percentages + fee script) is frozen into
the `BuiltJob` closure at `buildJob()` time and is immutable for that
`jobId`. The finder script is frozen per `(connection, jobId)` exactly as it
is today. Share validation and block assembly go through the identical
`personalize()` closure, guaranteeing byte-identity between what a miner
grinds and what gets assembled and submitted.

**Staleness is intentional and correct.** A job built when the board was
`[X, Y, Z]` pays `[X, Y, Z]` even if the board changes afterward — the miner
ground exactly those bytes. Jobs refresh at least every 30s (the existing fee
refresh cadence), so any snapshot is at most ~30s stale. This is the same
staleness property Ocean already has with its own windowed snapshots.

### 5.3 Invariants

| ID | Invariant |
|---|---|
| **INV-1** | `jobId` ⇔ payout-set version. A fresh `jobId` is minted on every build; a `jobId` is never reused for a different payout set. |
| **INV-2** | `personalize()` is pure and deterministic. |
| **INV-3** | The finder script is frozen per `(connection, jobId)` at announce time, exactly as today. |
| **INV-4** | Value conservation: `Σoutputs == coinbasevalue`; the fee output is the exact bigint remainder. |
| **INV-5** | Mode-aware shape gate: solo mode still requires exactly one value output (`cairn-vn43.14` preserved); split mode requires exactly one finder + k leaderboard + one fee + zero-value outputs. |
| **INV-6** | Validate-path ≡ assemble-path — the existing assembled-hash == solve-hash assert is preserved unchanged. |
| **INV-7** | Shared-tail byte-identity: the leaderboard + fee + `OP_RETURN` + witness-commitment tail is byte-identical across every connection sharing a `jobId`. |
| **INV-8** | Reconfiguration is forward-only: settings changes apply starting at the next build/new `jobId`, never retroactively. |
| **INV-9** | Round reset is forward-only: a round close never retroactively alters an already-announced `jobId`. |

### 5.4 Coinbase layout

```
in[0]     BIP34 height ‖ poolTag ‖ EN1(4B) ‖ EN2(4B)
out[0]    finder      = floor(cbval × finderPct/100) → connection's own frozen script
out[1..k] leaderboard = floor(pot × weight_i), rank order, sub-dust dropped
out[k+1]  pool fee    = cbval − finder − Σleaderboard   (remainder absorbs rounding dust)
out[..]   OP_RETURN {magic, version, roundId, instanceId}  (federation seam, zero-value, in shared tail)
out[last] witness commitment (zero value)
```

The finder stays a **separate** output from the leaderboard even if the
finder also ranks on the board — two outputs to the same script is fine;
merging them would break INV-7's shared-tail byte-identity. Rounding dust
always rolls into the **fee** output, never into the finder's, keeping
finder a pure fixed percentage. If a leaderboard address is unpayable at
build time, the runner-up promotes from `mining_round_shares`; roll-to-fee
only happens once the promotion tail is exhausted. **Solo mode is the
degenerate case**: `finderPct = 100`, empty board, no fee output — exactly
what ships today.

### 5.5 Update cadence

Rebuild triggers:

- New tip — 1s poll, `cleanJobs: true` (unchanged from today).
- 30s fee refresh — picks up the current leaderboard for free (unchanged
  cadence, new side effect).
- Leaderboard top-N set/order change — **debounced ≥ 20s**
  (`MIN_LEADERBOARD_REBUILD_MS`), always `cleanJobs: false`, always routed
  through `pool.enqueue()` (the existing serialized queue — required, see
  §11 failure modes).
- **Never** rebuilt per share.

Cost per rebuild at 128 connections: `buildJob` once (sub-ms), then
per-connection `personalize` at ~1–2ms × 128 ≈ tens of milliseconds, once
per 20–30s. Leaderboard-only rebuilds require **no merkle recompute**.
Memoizing `personalize` per `(jobId, finderScriptHex)` fixes today's
rebuild-per-submit hot path (13+ accepted shares/s at vardiff 6/min across
128 connections) — a strict win even in solo mode, independent of whether
split mode ever ships.

### 5.6 Leaderboard state machine (beat-only, per round)

An entry is a user's single best **realized** share of the current round; it
holds until beaten. This is a pure monotonic ratchet — order changes *only*
when a new share beats an existing round-best in a way that alters the top-N
set or its order.

- **Ranking key:** realized hash value (lowest wins = highest realized
  difficulty), not announce-time assigned difficulty. `ShareEvent` gains a
  **required** `realizedHashValue: bigint` field — `stratum.ts` already
  computes `hashValue` at `:646`; today it only ships announce-time
  difficulty. This closes the vardiff-gaming hole for free (§11).
- **Scoring is a pluggable seam** (`ScoreFn` over stored raw round shares);
  the default is best-share, per Alex's ruling. See §6 for why the *split*
  of the pot is recommended to differ from the *ranking* function while
  staying compatible with the no-decay rule.
- **Aggregation is per-USER**, not per-worker — a user's workers collapse
  into one leaderboard entry keyed on `userId`.
- **Round lifecycle:** block-found to block-found, managed in `index.ts`
  (ensure exactly one open round on start; close current + open new on
  `handleBlockAccepted`). `round_id` is stamped on `mining_stats` and the new
  tables below.
- **Restart is lossless.** Rehydration is a direct read from
  `mining_round_shares` — there is no rolling window to rebuild. This is the
  concrete operational payoff of the no-decay ruling.

### 5.7 DB schema

```sql
CREATE TABLE IF NOT EXISTS mining_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  started_height INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT, ended_block_hash TEXT,
  status TEXT NOT NULL  -- 'open' | 'closed'
);
CREATE TABLE IF NOT EXISTS mining_round_shares (
  round_id INTEGER NOT NULL REFERENCES mining_rounds(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worker_name TEXT NOT NULL,
  hash_value TEXT NOT NULL,      -- realized hash, 64-hex (exact ranking key)
  difficulty REAL NOT NULL,      -- derived, display only
  share_ts TEXT NOT NULL,
  rank_in_user INTEGER NOT NULL, -- 1..10 within (round_id, user_id)
  preimage_json TEXT,            -- FULL verification preimage, rank_in_user=1 only
  PRIMARY KEY (round_id, user_id, rank_in_user)
);
CREATE INDEX IF NOT EXISTS idx_round_shares_rank ON mining_round_shares(round_id, hash_value);
CREATE TABLE IF NOT EXISTS mining_block_payouts (
  block_id INTEGER NOT NULL REFERENCES mining_blocks(id) ON DELETE CASCADE,
  out_index INTEGER NOT NULL,
  role TEXT NOT NULL,            -- 'finder' | 'leaderboard' | 'fee'
  instance_id TEXT, user_id INTEGER,
  address TEXT NOT NULL, sats TEXT NOT NULL,
  pct_bps INTEGER,               -- percentage in basis points as configured at build
  rank INTEGER,
  PRIMARY KEY (block_id, out_index)
);
```

Storage cost is negligible: top-10 shares per user per round is ≈60 bytes/row
≈ 12KB/round at 20 users; rank-1 preimages at ~2–3KB each add ≈60KB/round.

### 5.8 onShare pseudocode

```
onShare(e):
    aggregates.recordShare(e)
    if leaderboard.observe(e)                      // true only on top-N-changing new best
       and now - lastLeaderboardBuildAt >= 20s:
        pool.enqueue(() => pool.refreshJob())      // serialized, cleanJobs:false
```

### 5.9 Settings

| Key | Meaning | Default | Validation |
|---|---|---|---|
| `mining_payout_mode` | `'solo'` \| `'coinbase-split'` | `'solo'` | enum |
| `mining_finder_pct` | finder share % | 50 | 0 ≤ x; finder + fee ≤ 100 |
| `mining_fee_pct` | operator fee % | 2 | 0 ≤ x; finder + fee ≤ 100 |
| `mining_fee_address` | operator payout address | — | encodable; **required** in split mode |
| `mining_leaderboard_n` | top-N size | 10 | 1 ≤ N ≤ ~40 |
| `mining_leaderboard_rank` | scoring seam | `'best-share'` | enum |
| `mining_dust_policy` | sub-dust handling | `'roll-to-fee'` | enum |

`leaderboardPct` is implicit: `100 − finder − fee`. v1 pot distribution is
equal-split across ranks, with per-rank weights left as a future seam — see
§6 for why a since-round-start-work-proportional split is the stronger
recommendation for v1 itself.

**Admin UI:** a live preview built from the current board plus a
representative `coinbasevalue` — e.g. "At current top-10 and 3.125 BTC:
finder 1.5625 BTC (50%), fee 0.0625 BTC (2%), each slot ≈ 0.0148 BTC…".
Gated behind the `mining_split` feature flag **and** an explicit operator
legal acknowledgment, mirroring the existing `admin_disclosure_acceptances`
pattern.

---

## 6. Economics & game theory

### 6.1 The B = W/E result

Share achieved difficulty follows a Pareto(α=1) distribution. A miner's
round-best `B_i = W_i / E_i`, where `W_i` is total work and `E_i ~ Exp(1)`
i.i.d. across miners. From this, `P(miner i holds rank-1) = W_i / ΣW`
**exactly** — winner-take-all best-share payout is exactly proportional to
hashrate *in expectation*. The full ranking is a Plackett-Luce model with
weights `W_i`.

**The problem with best-share is not bias, it's variance.** Best-share uses
only the single luckiest hash a miner produced, discarding 99%+ of the share
stream's information — it is the maximally noisy unbiased estimator of
hashrate available. Flatter payout curves tilt outcomes toward small miners
(worked example: at a 3:1 hashrate ratio, a flat top-2 split pays the big
miner only ½ of the pot vs. ¾ under strictly proportional payout); steeper
curves (more winner-take-all) restore proportionality at the cost of more
variance.

### 6.2 Finder percentage and the hopping equilibrium

With no rolling window (per Alex's no-decay ruling), **the finder percentage
is the sole loyalty mechanism** — Ocean's anti-hop protection is its window,
which this design does not have.

Hop-and-squat is a lottery, not a dominant strategy: a squatted leaderboard
slot usually evaporates in hours to days, long before a block actually lands
(which takes years at small-pool scale). For a loyal miner with hashrate
share `φ` of the pool:

- `E[total]_loyal = φ·f + φ·(1 − f − fee) ≈ φ·(0.98)` — **independent of
  f**. The finder percentage redistributes variance and the loyalty
  incentive, not expected value.
- Hopper ceiling = `φ·(0.98 − f)`.
- Hop penalty = `f·φ` — scales with miner size, so **big miners are
  anchored while small miners remain free to hop**. This is exactly the
  sort-by-size equilibrium Alex wants, and `f` is the dial that tunes it.
  `f = 0` collapses to pure hopping with no loyalty incentive at all;
  `f → 1` collapses to pure solo, eliminating any reason to pool.

**Finder percentage scenario table:**

| Finder f | Loyal E[total] (all sizes = 0.98φ) | Hopper ceiling = φ·(0.98−f) | Hop penalty = f·φ | Hopper/Loyal |
|---|---|---|---|---|
| 10% | 0.98φ | 0.88φ | 0.10φ | 90% |
| 20% | 0.98φ | 0.78φ | 0.20φ | 80% |
| 30% | 0.98φ | 0.68φ | 0.30φ | 69% |
| 40% | 0.98φ | 0.58φ | 0.40φ | 59% |
| 50% | 0.98φ | 0.48φ | 0.50φ | 49% |

| Finder f | Small φ=0.05 | Medium φ=0.15 | Large φ=0.40 |
|---|---|---|---|
| 10% | 0.005R | 0.015R | 0.040R |
| 20% | 0.010R | 0.030R | 0.080R |
| 30% | 0.015R | 0.045R | 0.120R |
| 40% | 0.020R | 0.060R | 0.160R |
| 50% | 0.025R | 0.075R | 0.200R |

**Thresholds:** as `f` rises past ~60%, the leaderboard pot thins (N=10
average slot ≈ 0.038R) and small miners drift back to plain solo mining; at
`f ≈ 98%` this collapses to ckpool and pooling becomes pointless. The
anchors are Ocean (`f = 0`, but its loyalty mechanism is the window, which
this design lacks — not directly transferable) and ckpool (`f ≈ 98`).

**Recommendation:** default `f = 40%`, admin-configurable in `20–60%`.
Alex's preferred 50% is in-range and fine — it is more stay-biased than the
recommended default, not wrong. Worth considering as the pool grows: tiering
`f` down over time (e.g. 50% at 2–5 miners, 40% at 6–15, 30% at 16–50) —
finder percentage functions as a variance knob that can track pool size.

### 6.3 The honest costs of beat-only

Beat-only, no-decay is Alex's ruling, and this design implements it as
specified. It has real costs worth surfacing plainly rather than glossing
over:

- **Heavy-tail squatting.** `E[best share]` is infinite (Fréchet, α=1); with
  non-trivial probability a single hopper lands a 10–100× share and then
  squats on that slot for months.
- **Months-old #1.** In long rounds (which can run years for a small pool),
  the board ossifies: a miner's rank-1 entry from months ago simply collects
  on eventual block-find, having contributed nothing recently.
- **Late-joiner freeze-out.** A miner joining after the board has ossified
  has `P(displacing #k) ≈ their_work / (their_work + accumulated_work)` —
  structurally hard to break in.

These are presented as an honest assessment of the ruling's tradeoffs, not as
a proposal to change it.

### 6.4 Displacement law

Expected survival time of a departed hopper's leaderboard entry:

```
E[survival] ≈ 1.44 × (H_hopper / H_pool_ongoing) × t_mined
```

Worked examples: 100 TH/s mined for 1 day, against an ongoing pool of 500
TH/s → survives ~7 hours. Against 100 TH/s ongoing → ~1.4 days. Against 10
TH/s ongoing → ~14 days.

### 6.5 Sybil analysis and mitigations

Splitting hashrate `W` across `k` identities does **not** change rank-1
probability (§6.1's proportionality is invariant to identity-splitting), but
with `N > 1` it does let one entity occupy multiple lower leaderboard slots.
Quantified: ~`b/6` ≈ 8% pot gain at 50% pool hashrate share, `N = 2`, a flat
payout curve — and this grows with larger `N` and flatter curves.

Mitigations:

- **Per-user aggregation** kills sybil-by-worker outright (already the
  design — leaderboard keys on `userId`, not worker name).
- **Minimum-share-count qualification** `m_min`: an attacker with work `W`
  can field at most `W / m_min` identities, so sybil now costs real
  hashrate rather than being free. This is the effective economic lever
  against multi-slot sybil.
- **Operator social trust** — a friends-and-family deployment knows the
  humans behind the accounts.

The residual ~8%-class leak under per-user aggregation plus min-share-count
is bounded and **accepted**, not solved.

- **Vardiff gaming:** ranking on realized hash value rather than assigned
  difficulty is a complete, free fix — the hash itself is unforgeable.
- **Block withholding:** structurally self-harming here, because every
  miner is their own finder — withholding a block forfeits your own reward.
  This is a security *win* relative to classic pooled mining.

### 6.6 Pot distribution recommendation

**Ranking stays best-share**, per Alex's ruling — the leaderboard *gate*
(who's in the top N, and in what order) is unaffected. The recommendation is
narrower: **split the top-N pot proportional to each member's cumulative
since-round-start work**, not proportional to their ranking best-share value
and not equal-split. Since there is no window and no decay, "since-round-start
work" is fully compatible with the no-decay rule — it requires no rolling
window, just a running sum from round-open.

This gets most of the variance/fairness/sybil benefit into the *amounts*
paid, while the *gate* stays exactly what Alex specified. It also avoids the
alternative failure mode of paying proportional to the Fréchet-distributed
best-share value itself, where one monster share would eat the entire pot.

This is offered as a strong recommendation; equal-split (the v1 settings
default, §5.9) and a general configurable weighting are both viable
alternatives if Alex prefers to keep v1 simpler.

### 6.7 Solo-vs-pool spectrum

- **Pure solo (100% finder):** maximum variance, small miners are never
  paid between wins.
- **This design:** keeps the jackpot dream (finder still gets the largest
  cut) and adds a leaderboard trickle; EV is approximately proportional for
  everyone; variance sits in the middle of the spectrum.
- **Pure proportional (Ocean):** minimum variance, no jackpot at all.

For the "friends who solo-mine together but don't want to see zero for
months" use case, this middle position is the right product. The finder
stays eligible for their own leaderboard slot in addition to the finder
output — excluding them would create an odd incentive to *not* also compete
on the board.

### 6.8 Ocean's carry-forward — deliberately not built

Ocean carries forward any miner's below-threshold payout to a future block.
This requires balance accounting and is explicitly **not** built here — it
would reintroduce exactly the kind of custody-adjacent state this design
otherwise avoids. Sub-dust here simply means no output for that participant
this block, which is essentially never triggered at mainnet subsidy levels
(see §7).

---

## 7. The N problem and dust

- **N default is 10, capped around 40.** Each leaderboard output is ~124
  weight units — at N=40 that's negligible added weight relative to a
  standard block.
- **Dust is a non-issue at mainnet subsidy.** P2WPKH dust relay limit is 294
  sats; at a 3.125 BTC coinbase even a thin leaderboard slice clears that by
  orders of magnitude. Policy for the rare case a computed share does fall
  under dust: **drop it, roll it into the fee output** (`mining_dust_policy
  = 'roll-to-fee'`).
- **Fewer miners than N** simply pays every qualifier — there's no
  requirement to fill all N slots.
- **Per-user aggregation** means one output per user, not per worker, even
  if a user runs many devices.

---

## 8. Few vs. many miners

- **2–5 miners:** the leaderboard is close to "everyone gets paid" — a
  near-solo feel with a small trickle on top. Competition for slots is
  minimal because N (10 default) exceeds the miner count.
- **10–50 miners:** a real leaderboard emerges — genuine competition for
  top-N slots, and the displacement math in §6.4 starts to matter in
  practice (established miners are genuinely hard to displace).
- Finder-percentage tiering (§6.2) is worth revisiting as a pool crosses
  from the "few" to the "many" regime — the loyalty economics shift as the
  denominator grows.

---

## 9. Integration with existing Heartwood

Split-payout mode is an extension of the shipped solo pool
(`src/lib/server/mining/`), not a parallel system: same Stratum server, same
admin dashboard, same user mining view, gated by the same settings/flag
conventions used elsewhere in Heartwood (`registry.ts`, `requireFeature()`).
**Solo mode is the degenerate case** of split mode (`finderPct = 100`, empty
board, no fee output) — the two modes share one code path, not two.

Gating: `mining_split` feature flag (visibility) plus the legal-acknowledgment
record from §5.9/§13 (actual activation) — the same flag-vs-setting split
pattern Heartwood already uses for federation (`federation` flag,
`federation_enabled` setting).

### File-by-file change list (phase 1)

| # | File | Change | Size |
|---|---|---|---|
| 1 | `mining/types.ts` | `PayoutSet`, `LeaderboardEntry`, `ShareEvent.realizedHashValue` (required), `SolveEvent` payout-set ref | M |
| 2 | `mining/job.ts` | multi-output builder, mode-aware shape gate, `(finderScriptHex → variant)` memo, payout set in closure, `OP_RETURN` round/instance tag | L |
| 3 | `mining/stratum.ts` | frozen memoized variant per `(connection, jobId)`, emit `realizedHashValue`, no rebuild-per-share | M |
| 4 | `mining/miningPool.ts` | leaderboard snapshot into `installJob`, debounced enqueued rebuild trigger, solve records payout set | M |
| 5 | `mining/leaderboard.ts` (new) | monotonic ratchet state machine, persistence, rehydration, `ScoreFn` seam | M |
| 6 | `mining/aggregates.ts` | `round_id` stamping on flush | XS |
| 7 | `mining/authTable.ts` | `userId → payoutScript` lookup for leaderboard join | S |
| 8 | `mining/settings.ts` | new keys + validation (percentages sum, fee address required in split) | M |
| 9 | `mining/index.ts` | `onShare` → leaderboard wiring, round lifecycle, split gating (flag + legal ack), persist payout snapshot on block accept | M |
| 10 | admin mining UI | mode toggle, % inputs, fee address, N, live preview, legal ack gate | M |
| 11 | user mining view | split-mode earnings display (finder % + your rank/est. share) | M |
| 12 | `db.ts` migrations | `mining_rounds`, `mining_round_shares`, `mining_block_payouts`, `round_id` usage | M/L |
| 13 | disclosures | split-mode operator acknowledgment record | S |

---

## 10. Migration path

- New setting `mining_payout_mode: 'solo' | 'coinbase-split'`; **solo stays
  the default** — nothing about existing behavior changes unless an operator
  opts in.
- Phase 1 ships single-instance coinbase-split behind flag + legal ack.
  Phase 2 (federation, §14) is separate and later.
- **Merge gate:** a forced-solve regtest end-to-end test, in the same spirit
  as the solo pool's existing forced-solve gate, asserting that a
  multi-output block is accepted by `bitcoind` and pays every configured
  output exactly. No split-mode code merges without this passing.

---

## 11. Security considerations

- **Can miners game the leaderboard?** Ranking on realized hash value
  (`stratum.ts:646`, already computed) rather than assigned/announced
  difficulty makes vardiff manipulation a non-issue — the hash itself is
  unforgeable proof of work.
- **Sybil:** per-user aggregation plus a minimum-share-count qualification
  bound the exploitable leak to the ~8%-class residual quantified in §6.5,
  which is accepted rather than fully closed.
- **Block withholding is self-harming** here, since every miner is their own
  finder in their own template — withholding a found block forfeits the
  withholder's own payout. This is a structural security improvement over
  classic pooled mining, where withholding harms only other participants.
- **Rebuild-storm protection:** the ≥20s debounce plus routing every
  leaderboard-triggered rebuild through the existing serialized
  `pool.enqueue()` queue prevents a burst of top-N-changing shares from
  causing a rebuild storm.
- **Address-reuse privacy:** payout addresses are reused across leaderboard
  appearances within a round in the same way Ocean's are — a known,
  accepted privacy tradeoff, flagged here as a follow-up item rather than
  solved in phase 1.

---

## 12. Performance

Rebuild cost is quantified, not hand-waved: at 128 connections, `buildJob`
runs once per rebuild (sub-millisecond), and per-connection `personalize`
costs roughly 1–2ms each, ≈ tens of milliseconds total — and this only
happens once per 20–30s (new-tip poll, fee refresh, or debounced leaderboard
change), never per share. Leaderboard-only rebuilds require **no merkle
recompute** at all, since merkle branches depend only on the shared
transaction set, not on coinbase outputs. The `(jobId, finderScriptHex)`
memoization fixes the existing rebuild-per-submit hot path — today's engine
re-personalizes on every accepted share (13+ shares/s at vardiff 6/min across
128 connections) with no caching; this is a strict performance win
independent of whether split mode ships.

---

## 13. Legal gate (`cairn-vn43.14`)

**Not legal advice — considerations for Alex to weigh, and the reason this
design does not ship without his explicit go-ahead.**

The solo pool's no-custody posture is preserved exactly: the network still
pays miners directly, and this remains its strongest posture — worth stating
prominently rather than burying. But split mode changes the operator's role
in ways custody-preservation does not neutralize:

- The operator now **sets** third-party payout percentages and **takes a
  fee output** — this unambiguously reads as a "pool operator," a different
  regulatory and tax character than a solo-only relay.
- Money-transmission definitions vary by jurisdiction on exactly this
  axis — custody/control vs. merely "facilitating" a payout — and this
  design sits closer to the facilitating end without being unambiguously
  clear of it.
- The fee output is on-chain operator revenue with real tax/business
  implications.
- **Operator-discretion percentages are a worse legal posture than
  published, open-source-default, miner-consented ones** — the percentages
  should be visible and the miner's participation should be an informed
  opt-in, not a silent default.
- A low-profile friends-and-family deployment carries different exposure
  than a stranger-facing one; miners should explicitly opt in either way.

**Ship posture:** off by default, behind the `mining_split` feature flag,
requiring an explicit operator acknowledgment plus miner opt-in — and
counsel review before shipping to anyone beyond a controlled test. The
reversal of the `cairn-vn43.14` gate, if Alex makes it, should be documented
as a conscious and owned decision, not a quiet code change.

---

## 14. Phase 2: Federation

Federation extends coinbase-split payout across multiple Heartwood
instances, so miners at different instances compete on one meta-leaderboard.
This is **R&D-stage, not a near-term build** — it depends on both the
phase-1 split design shipping and the legal gate clearing, plus its own open
consensus questions (below).

### 14.1 Precedent: P2Pool

P2Pool's central idea transfers directly: **a share is not a claim to be
reconciled later — it is a self-certifying artifact that already encodes the
payout obligation it creates.** In P2Pool, a share literally *is* a
sub-difficulty Bitcoin block; peers verify its proof of work, that its
generation transaction correctly pays the entire PPLNS window, and its
parent linkage — an invalid payout is simply rejected as an invalid share.

Bitcoin P2Pool ultimately died from failure modes worth naming so this
design avoids them: share variance (share difficulty rose with pool
hashrate, leaving small miners without a share for weeks), orphan/DOA races
from its 30-second linear sharechain penalizing latency, coinbase bloat
(both raw size and ASIC firmware limits), poor dust economics, and an
inability to compete with FPPS payout smoothness. Monero's P2Pool fixed most
of this with a 10-second sidechain, a 2160-block (~6h) PPLNS window, zero
fee, every candidate template embedding the whole window's payouts, uncle
blocks crediting lost races, and mini/nano tiers for small miners.
Braidpool (pre-production) goes further with a DAG of weak-block "beads"
that kills orphan races entirely, payout metadata committed via coinbase
`OP_RETURN`, and UHPO threshold-Schnorr (FROST) settlement — the closest
prior art to a small, semi-trusted federation.

**The transferable lesson:** a small, invite-gated Tor federation sidesteps
P2Pool's variance and orphan failure modes *by construction* — there is no
sharechain consensus to maintain, no share-difficulty retargeting race, and
block production stays purely local to each instance. The leaderboard is
accounting, not consensus.

### 14.2 Transport

Federation mining reuses the transport already scoped for PSBT federation
(`docs/FEDERATION-SCOPE.md`): Tor hidden-service transport, ed25519 instance
identity (`instanceId = sha256(pubkey)[:16]`). Mining federation is simply a
new consumer of that same transport, and it respects the same networking
gate (F15 in the federation scope doc — a feature flag alone must never open
network traffic; a separate enabled-setting does that).

The physical fact that shapes everything downstream: **a share is proof of
work over a specific coinbase whose `out[0]` is the grinding miner's own
payout address — it cannot retroactively commit to another instance's
payout set.** Any federation design has to work with that fact, not around
it.

### 14.3 Option A vs. Option B

- **Option A (shared leaderboard):** treat foreign shares purely as ranking
  evidence. This collapses into Option B's mechanics anyway, since the
  verification requirements are identical either way.
- **Option B (meta-leaderboard, recommended):** every instance embeds a
  federation-wide top-N in its own templates, built from its own Core node,
  with its own connected miner still acting as finder in its own template.

### 14.4 Gossip and verification

**Message:** `ShareAnnounce {instanceId, roundTag, preimage {versionHex,
prevHashDisplay, merkleBranch[], ntimeHex, nbitsHex, nonceHex, coinbaseHex,
en1, en2}, sig}`.

**Verification, on receipt, in four steps:**

1. Recompute the coinbase txid, apply the branch, derive the header, and
   compute `hashValue` independently — **never trust a claimed difficulty.**
2. Read `out[0]` from `coinbaseHex` — the miner's payout address is
   **cryptographically bound into the proof of work itself**; this makes it
   trustless rather than merely attested — changing the address changes the
   hash.
3. Check the `OP_RETURN (roundTag, instanceId)` inside the preimage for
   replay/freshness protection.
4. Check the envelope signature against the handshake-pinned pubkey for
   instance binding.

### 14.5 Trust model

**Trustless** (verified directly, cannot be forged): share difficulty, the
payout address, round freshness. **Attested** (relies on instance identity
being honest): which instance a share came from.

An evil instance **can**: sybil-relabel its own real hashrate across fake
users (mitigated by a per-instance slot cap — see below; and by ranking the
meta-board on summed work rather than best-share, see below), and censor
gossip (bounded by full-mesh flooding). An evil instance **cannot**: fake
difficulty, steal another miner's payout, or cause any custody loss. The
blast radius of a misbehaving instance is misallocated leaderboard slots —
never funds.

**The meta-sybil finding is the critical result of this analysis:** across
instances, a "user" is just a payout address — free to generate and
unlinkable. No operator can see another instance's actual humans, so the
intra-instance social-trust anchor that partially backstops phase-1's sybil
mitigations (§6.5) evaporates entirely at the federation layer. **Best-share
ranking does not survive untrusted instances**: an instance with real
hashrate `H` can relabel its own distinct top-K shares as K different users
and legitimately occupy K meta-board slots — each share is genuine proof of
work paying a genuine address, so no dedup logic can catch it.

**Implication:** the meta-board must rank by **additive summed work**
(splitting-neutral, unlike best-share) or add reputation/stake weighting —
even while each instance's *own, intra-instance* board stays best-share per
Alex's ruling. A **per-instance slot cap `M`** on the meta-board is a
further structural mitigation.

**Fee:** recommended as finder-instance-takes-all — fee revenue then
averages out proportionally to each instance's hashrate over time, with no
cross-instance accounting and no custody anywhere. This does mean a
small-operator instance sees fee revenue that lags its hashrate share in the
short run; a real but probably tolerable asymmetry, since small operators
are typically running for sovereignty rather than fee income.

**Rounds:** recommended as per-instance — each instance's own found block
resets only its own board. A federation-wide global round would require
cross-instance boundary consensus, which is the single biggest open
question below.

### 14.6 Federation-ready seams built in phase 1

Five phase-1 changes are deliberately federation-ready without enabling any
federation networking themselves:

1. The `OP_RETURN (roundId, instanceId)` tag already lives in the shared
   coinbase tail (S/M sizing, and it preserves INV-7 byte-identity).
2. Full verification preimages are already captured on rank-1 shares — free,
   already in the phase-1 schema (`mining_round_shares.preimage_json`).
3. `(instanceId, userId)` keying is used everywhere already; `instanceId` is
   just a local constant in phase 1 (XS sizing).
4. A versioned-JSON `PayoutSet` wire serializer (S sizing).
5. A stable local `instanceId`, derived from the federation identity seed,
   **without** enabling any federation networking — this respects the F15
   networking gate from the PSBT federation scope doc.

### 14.7 Open questions before federation is buildable

1. Canonical meta-board consensus — how do instances agree on one ranked
   view without a shared ledger?
2. Template-honesty enforcement — how is an instance prevented from
   omitting rival instances' shares from what it gossips onward?
3. Meta minimum-difficulty threshold, to prevent share-flood DoS across the
   federation.
4. Whether rounds stay strictly per-instance (recommended) or a
   federation-global round is ever pursued, and if so how boundaries are
   agreed.
5. Formal parameter consensus — whose finder %, fee %, and N apply on a
   federation-wide meta-board when instances configure these independently.

---

## 15. Open decisions for Alex

1. **Finder percentage default — 40% (recommended) vs. 50% (Alex's stated
   preference).** Both are inside the acceptable 20–60% range (§6.2); 50%
   is more stay-biased than the recommended default, not incorrect.
2. **N default.** Recommended 10, cap ~40 (§7).
3. **Minimum-share-count qualification value (`m_min`).** The sybil
   mitigation in §6.5 needs a concrete number.
4. **Pot-distribution formula.** Equal-split (v1 settings default) vs.
   since-round-start-work-proportional (§6.6 recommendation, still fully
   compatible with the beat-only ranking ruling).
5. **Operator fee percentage.** Recommended 2%, matching both Ocean and
   ckpool precedent.
6. **Legal gate go/no-go (`cairn-vn43.14`).** Whether and when to cross it,
   under what acknowledgment/opt-in flow, and with what counsel review
   (§13) — this gates the entire phase-1 build, not just a launch detail.
7. **Federation phase-2 open questions** (§14.7) — meta-board consensus
   mechanism, template-honesty enforcement, meta min-difficulty/DoS
   threshold, per-instance vs. federation-global rounds, and cross-instance
   parameter consensus.

---

*End of design document.*
