# Competitor Analysis — BlueWallet, Sparrow, Nunchuk, Ocean vs Cairn

**Date:** 2026-07-18
**Status:** research snapshot, feeds UX/mining-pool decisions; not itself a design doc
**Method:** web research (WebSearch/WebFetch) against public sites, GitHub release notes, and
third-party reviews, mid-2026. Cross-referenced against `docs/UX-REDESIGN-SPEC.md`,
`docs/DESIGN-MANIFESTO.md`, `docs/MINING-POOL-SCOPE.md`, and `docs/COINBASE-PAYOUT-POOL-DESIGN.md`
for the Cairn-side comparison points. Every claim below is sourced inline; anything that couldn't
be independently verified is called out in §6 rather than smoothed over.

Cairn's own UX philosophy, for reference throughout: **plain language, no Bitcoin internals exposed
by default, guided wizards, one hero number / one primary action per screen** (spec principles 1–4;
manifesto §1, §6).

---

## 1. BlueWallet (mobile wallet)

**Snapshot.** Latest major release is **v8.0.0**: refreshed Receive/Wallet/Wallet-Details/Search
screens, faster Electrum sync, general performance work. [BlueWallet v8.0.0 announcement](https://bluewallet.io/bluewallet-v8-0-0-drops-fresh-faster/),
[GitHub Releases](https://github.com/BlueWallet/BlueWallet/releases). *(Exact release date is
disputed between sources — see §6.)* Free, open-source, React Native, iOS/Android. Positions itself
as spanning both "everyday spend" and "cold storage" in one app, including multisig vaults,
watch-only, coin control, payjoin, PSBT, hardware-wallet connectivity, and a Lightning wallet.
[Features page](https://bluewallet.io/features/)

**UX model.** Onboarding centers on a "magical form" that auto-detects and imports assorted wallet
backup formats, plus guided creation flows for on-chain vs. Lightning wallets. Marketing copy is
plain ("Your keys, your bitcoin") but feature/support docs mix in technical terms (BIP32, SegWit,
BIP47, RBF/CPFP) without much translation layer. [Features page](https://bluewallet.io/features/),
[Cryptonews review](https://cryptonews.com/reviews/bluewallet-review/)

**What BlueWallet does better than Cairn today:**
- One app credibly serves both a casual daily-spend user and a serious cold-storage user, with a
  single "magical form" recovery/import flow that quietly detects format — Cairn's wizards are
  more prescriptive and less forgiving of "I have some kind of backup file."
- Lightning is a first-class wallet type, not a bolt-on — relevant if Cairn ever extends past
  on-chain.
- No 2FA, no fiat ramp, is a deliberately narrow feature set that keeps the product legible; it
  resists feature-creep pressure well.

**Steal:** the "magical form" auto-detecting import pattern for restoring/importing wallets — one
input, format sniffed, rather than asking the user to know their own wallet's technical shape up
front. This is directly aligned with Cairn's "no jargon by default" principle (spec §4).

**Avoid:** the default-custodial Lightning wallet that reviewers flag as a frequent point of user
confusion — non-custodial-by-default should stay a hard line for any Cairn feature that touches
funds custody, per Cairn's own solo-mining legal posture (`docs/MINING-POOL-SCOPE.md` gate
`cairn-vn43.14`). Also avoid BlueWallet's mixed jargon/plain-language docs — Cairn's `<Term>`
glossary discipline (manifesto §7 AVOID: "blockchain jargon on the surface") is stricter and should
stay that way.

---

## 2. Sparrow Wallet (desktop power-user wallet)

**Snapshot.** Latest is **2.5.2** (May 31, 2026): PSBT sighash verification, Silent Payments dust
detection, Send-To-Many fixes. The preceding 2.4–2.5 run (Feb–May 2026) shipped Silent Payments
send+receive (BIP375), PSBTv2 as the default internal representation, TOFU cert pinning for Core
RPC over TLS, and v3 transaction support. [GitHub Releases](https://github.com/sparrowwallet/sparrow/releases).
Free/open-source, Java desktop (Windows/macOS/Linux), **no mobile app**. Full single-sig and
multisig across legacy/SegWit script types, deep hardware-wallet support (USB + airgapped via UR/QR
fountain codes), own-node/Tor connectivity, Whirlpool CoinJoin integration.
[Features page](https://sparrowwallet.com/features/)

**UX model.** Deliberately expert-facing: byte-level transaction inspection, editable input/output
diagrams, heavy unglossed use of PSBT/UTXO/script-type/coinbase terminology. Reviews are explicit
that this is *not* a beginner tool — "steep learning curve," "not ideal for users who... do not want
to learn server concepts." [CryptoAdventure review](https://cryptoadventure.com/sparrow-wallet-review-2026-the-power-user-bitcoin-wallet-that-rewards-good-privacy-habits/),
[Sourceforge/Slashdot](https://sourceforge.net/software/product/Sparrow-Wallet/)

**What Sparrow does better than Cairn today:**
- Radical transaction transparency without becoming unusable — reviewers consistently praise that
  it "doesn't hide information... but in a way that is manageable." This is the same tension Cairn's
  3-tier disclosure architecture (spec §5) is trying to solve, and Sparrow is a mature existence
  proof that a dense power-user surface can still read as "structured," not chaotic — directly
  relevant to Cairn's Explorer surface (spec §2.5), which keeps density but adds glossing.
- Own-node/Tor connectivity and hardware-wallet breadth are both best-in-class; Cairn's own-node
  Explorer is philosophically the same "sovereignty payoff" move (manifesto §1) but Sparrow's HW
  device matrix is wider today.
- Multisig policy is fully user-controlled at creation and editable later — a flexibility bar worth
  benchmarking Cairn's multisig wallet-detail flow against.

**Steal:** the "structure tames density" lesson explicitly cited in Cairn's own manifesto (§4,
"Density panels... reads as 'this tool is powerful,' because it sits inside a clearly bounded
panel") — Sparrow is the reference implementation of that idea for Explorer-style dense surfaces.
Also worth studying: Sparrow's transaction-diagram visualization as a model for Cairn's
`TxFlowDiagram`/BlockContext work.

**Avoid:** Sparrow's total absence of a plain-language layer. It has no equivalent of Cairn's
`<Term>` tooltip mechanism — jargon is just permanently on the surface. That's a legitimate choice
for a power-user-only tool, but it's exactly the failure mode Cairn's jargon glossary (spec §4) is
built to prevent, and Cairn should not let its Advanced/Details layers regress toward Sparrow's
"assume literacy" default. Also avoid Sparrow's desktop-only scope as a cautionary data point — it
caps their addressable "first-week user," which cuts against Cairn's plain-language, broad-audience
positioning.

---

## 3. Nunchuk (multisig / collaborative custody)

**Snapshot.** Free tier (DIY single-sig/multisig) plus three paid "assisted multisig" tiers: **Iron
Hand** ($120/yr, one assisted 2-of-4-style wallet), **Honey Badger** ($480/yr, flagship — two
assisted 2-of-4 wallets + inheritance planning with a dedicated inheritance key), **Honey Badger
Premier** ($2,100/yr, three assisted 3-of-5 wallets, two inheritance keys, multi-person
roles/access-control). [nunchuk.io/individuals](https://nunchuk.io/individuals)

**Collaborative custody mechanics (the direct comparison point for Cairn's multisig work).**
Nunchuk calls itself "the world's first multi-user multisig wallet." The user holds most of the
keys via their own hardware devices (TAPSIGNER, COLDCARD, Jade, Ledger, etc. — bought separately, at
a 10–15% partner discount); **Nunchuk's own servers hold one platform key** used to help
cosign/recover — explicitly framed as trust-minimized, never full custody of funds. Multi-person
coordination (family/partners/business) runs through the platform with end-to-end-encrypted
communication and transaction data; **wallet configuration** (not the keys themselves) is backed up
server-side to enable assisted recovery on a new device. Inheritance uses either an on-chain
timelock ("autonomous") or an off-chain, Nunchuk-assisted timelock ("flexible").
[nunchuk.io/individuals](https://nunchuk.io/individuals), [BlockDyor review](https://blockdyor.com/nunchuk-review/),
[Bitcoin Magazine](https://bitcoinmagazine.com/business/nunchuk-the-open-source-mobile-multi-sig-wallet-now-securing-over-1-billion-in-bitcoin)

**UX model.** Free testnet trial before committing to a paid tier; guided setup for paid plans;
dedicated support for inheritance planning on Honey Badger. Explicitly *not* built for hand-holding
— "built for sovereignty" — which reviews flag as a real learning-curve cost for casual users.
[BlockDyor review](https://blockdyor.com/nunchuk-review/)

**What Nunchuk does better than Cairn today:**
- **True multi-human coordination.** This is Nunchuk's whole differentiator and something Cairn
  does not currently offer: Cairn's multisig is a single user managing multiple keys/devices
  themselves, not multiple *people* coordinating a shared wallet with server-assisted signaling.
  Cairn's `docs/COLLABORATIVE-CUSTODY` 3-tier access gate (owner/viewer/cosigner, per memory) is
  adjacent but not the same as Nunchuk's live multi-party cosigning flow.
- **Inheritance as a first-class, dual-mode feature** (on-chain vs. off-chain timelock) — Cairn has
  no inheritance story today; this is a gap worth scoping.
- A clean freemium ladder that maps complexity to price (DIY free → assisted 2-of-4 → assisted
  3-of-5 with multi-person roles) — a useful reference if Cairn ever needs to communicate "how much
  quorum/complexity is this for."

**Steal:** the **trust-minimized platform-key framing** — "we hold one key, never custody" — is a
good rhetorical and architectural pattern for any future Cairn feature that needs *some* server
assistance without crossing into custody (directly analogous to the language Cairn will need for
any assisted-recovery feature). Also worth adopting: Nunchuk's testnet-first trial before a user
commits real funds to a new (multisig) configuration — a low-risk onboarding pattern Cairn's wizards
don't currently use.

**Avoid:** Nunchuk's explicit acceptance that its product is "not built for hand-holding" and that
"casuals might find it overkill" is precisely the failure mode Cairn's plain-language/guided-wizard
philosophy exists to avoid — Cairn should not let multisig/collaborative-custody UI regress to
Nunchuk's assumed-literacy default even though the underlying coordination problem is similar. Also
avoid the steep per-tier price cliff ($480/yr → $2,100/yr for one more key and one more cosigner) as
a pricing-communication anti-pattern if Cairn ever gates features by tier — it reads as opaque
compared to a flat, transparent feature list.

---

## 4. Ocean (mining pool)

**Snapshot.** Founded by Bitcoin Core developer **Luke Dashjr** and "Bitcoin Mechanic," launched
Nov 2023 with a $6.2M seed round led by Jack Dorsey; explicit mission is "miners, not pools, should
decide what goes into blocks." [CoinDesk](https://www.coindesk.com/business/2023/11/29/jack-dorsey-aims-to-create-anti-censorship-bitcoin-mining-pool-with-new-startup).
By mid-2026, Tether is reportedly deploying hashrate to Ocean.
[Tether.io](https://tether.io/news/tether-to-deploy-hashrate-on-ocean-advancing-decentralized-bitcoin-mining-infrastructure/)
**Fees: 2% standard, 1% if mining via DATUM.** Payout threshold ~0.01048576 BTC (1,048,576 sats),
with a lower discretionary threshold (~0.00065536 BTC) if a miner stops hashing, and **Lightning
payouts via BOLT12** to bypass the on-chain threshold entirely.
[ocean.xyz](https://ocean.xyz/), [d-central.tech pool guide](https://d-central.tech/ocean-mining-pool-guide/),
[Sazmining blog](https://www.sazmining.com/blog/how-ocean-payouts-work-at-sazmining)

### 4.1 TIDES mechanics — full detail, as prior art vs. Cairn's coinbase-payout design

TIDES ("Transparent Index of Distinct Extended Shares") is Ocean's non-custodial payout scheme.
[OCEAN TIDES docs](https://ocean.xyz/docs/tides)

- **Window sizing.** Dynamic window equal to **8× the found block's network difficulty worth of
  shares**. This sizing is chosen so "all shares submitted have a 99.9665% chance of being rewarded
  at least once," averaging 8 reward payouts per share over its lifetime. The window recalculates on
  every block found, using that block's difficulty.
- **Anti-gaming.** The window's cutoff point is pinned to what the share log looked like at the
  moment work was *handed out* to a miner, not at the moment a block happens to be found — this
  prevents miners from timing their submissions to game the window boundary.
- **Share scoring.** Every accepted proof-of-work is logged individually (not aggregated), weighted
  by its own target difficulty — full per-share resolution is preserved through the system's
  lifetime.
- **Payout formula:** `miner_reward = (miner_shares_in_window ÷ total_share_log_window) ×
  current_block_reward`, applied against the **full** block reward (subsidy + fees).
- **Non-custodial mechanics.** Because TIDES's payout math is fully determined by the share log,
  Ocean can **pre-compute the generation (coinbase) transaction at the moment work is assigned** —
  payouts are baked directly into the block's own coinbase output. Ocean's operator wallet never
  holds miner funds in the interim; "when OCEAN finds a block, miners are paid directly from the
  coinbase transaction."
- **Carry-forward.** Payouts below the on-chain minimum threshold are carried forward to a future
  block rather than dropped — which requires the pool to do *some* balance accounting across blocks
  even though it's non-custodial in the sense that matters (no operator-held BTC balance).
- **DATUM.** Launched publicly ~Sept 2024, DATUM lets individual miners construct their **own block
  templates** from their own node rather than trusting Ocean's template — explicitly framed as
  restoring miner-level censorship resistance against the concentration of hashrate in a few large
  pools' template-construction power. DATUM miners still get TIDES-style variance-reduced payout;
  the pool still dictates the generation-tx payout outputs and pool tag even when the miner builds
  the rest of the template. [OCEAN DATUM origins doc](https://ocean.xyz/docs/datum),
  [OCEAN DATUM press release](https://ocean.xyz/docs/datum-press-release)
- **Dashboard.** Miners are identified by `bitcoinaddress.workername`; Ocean states earnings data is
  "100% transparent" and viewable on-site; TIDES payouts are marketed as "fully auditable" per-block,
  unlike PPLNS/FPPS.

**Comparison to Cairn's designed coinbase-payout mode** (`docs/COINBASE-PAYOUT-POOL-DESIGN.md`,
DESIGNED-NOT-BUILT, gated on `cairn-vn43.14`): Cairn's own design doc (§3) already places itself on
the same spectrum Ocean anchors one end of — **"Ocean 0% finder … Cairn's design (20–60%,
recommended 40%) … ckpool ~98% finder."** Three concrete divergences worth restating for a
competitor-facing audience:
1. **Windowed proportional (Ocean) vs. beat-only top-N leaderboard (Cairn).** Ocean pays everyone in
   an 8×-difficulty rolling window every block; Cairn's design explicitly rejected a rolling window
   in favor of a no-decay, beat-only leaderboard that resets only when a block is found (owner
   ruling, §2 of the Cairn design doc) — a real, acknowledged tradeoff (heavy-tail squatting,
   "months-old #1," late-joiner freeze-out — Cairn design doc §6.3), not a strict improvement.
2. **No carry-forward (Cairn) vs. carry-forward (Ocean).** Cairn's design deliberately does **not**
   adopt Ocean's sub-threshold carry-forward mechanism, because it "would reintroduce exactly the
   kind of custody-adjacent state this design otherwise avoids" (Cairn design doc §6.8) — this is a
   sharper non-custodial line than Ocean draws.
3. **Finder keeps a jackpot (Cairn) vs. finder keeps 0% extra (Ocean).** Cairn's design preserves a
   "jackpot" feel for the actual block-finder (recommended 40–50% straight to the finder) precisely
   because Ocean's fully-proportional model, while minimizing variance, eliminates the solo-mining
   psychological payoff Cairn's target user (a home miner, per `MINING-POOL-SCOPE.md`'s "honest odds
   / lottery-ticket framing") is there for.

### 4.2 Legal / regulatory positioning — explicitly flagged, not smoothed over

**Ocean's own public documentation (TIDES docs, DATUM docs, homepage) contains no explicit legal
analysis, regulatory citation, money-transmitter-exemption claim, or reference to any legal opinion
or filing regarding its non-custodial payout structure.** Every search performed for this report
(including targeted queries for "Ocean mining pool money transmitter license non-custodial legal")
returned only Ocean's own design-intent language ("ensuring miners' rewards are directly linked to
their contributions without the need to trust pool operators to later distribute the earnings") and
generic third-party commentary about non-custodial services in general — never anything specific to
Ocean's jurisdiction, corporate structure, or regulatory status.
[OCEAN TIDES docs](https://ocean.xyz/docs/tides)

**This must be stated plainly for Cairn's own decision-making: "Ocean does it this way" is not legal
cover, and must not be treated as one.** Cairn's coinbase-payout design document already reaches the
same conclusion independently and far more rigorously — `docs/COINBASE-PAYOUT-POOL-DESIGN.md` §13
states outright that split-mode payout "changes the operator's role" in ways that "unambiguously
reads as a 'pool operator,' a different regulatory and tax character than a solo-only relay," that
"money-transmission definitions vary by jurisdiction on exactly this axis," and that the design
"does not ship without [Alex's] explicit go-ahead," gated on `cairn-vn43.14` with **counsel review**
named as a precondition before shipping beyond a controlled test. Nothing in Ocean's public presence
changes or weakens that gate — Ocean simply doesn't publish whatever legal analysis it may or may
not have obtained privately, so it cannot be cited as precedent one way or the other. Cairn's counsel
must independently assess the non-custodial-by-construction design on its own facts (Cairn's own
INV-4/INV-5 value-conservation and shape-gate invariants, jurisdiction, operator posture, and
opt-in/disclosure flow) rather than inferring safety from Ocean's continued operation.

**Business model.** Fee-only (2%/1%), no subscription tier; institutional hashrate (Tether) reported
flowing to the pool in 2026 alongside the home-miner base.
[Tether.io](https://tether.io/news/tether-to-deploy-hashrate-on-ocean-advancing-decentralized-bitcoin-mining-infrastructure/)

**What Ocean does better than Cairn's shipped pool today:**
- Ocean has a **live, auditable, multi-year-proven** non-custodial payout scheme (TIDES) with
  Lightning payout support; Cairn's shipped solo pool (`cairn-vn43`, v0.2.34) is single-payout-only
  and the split/leaderboard mode is still design-only, unshipped.
- DATUM's miner-owned-template story is a stronger, more concrete decentralization narrative than
  anything Cairn currently communicates about its own (currently pool-operator-templated) engine.
- Ocean publishes a clear, simple fee number (2%/1%) up front; Cairn's future split-mode fee/finder/
  leaderboard percentages are more configurable (a strength for flexibility, but a potential
  communication burden — see recommendation #4 below).

**Steal:** the **pre-computed-payout-at-work-assignment** trick — TIDES's core insight that if
payout math is fully determined before a share is even mined, the generation transaction can be
built once and is inherently non-custodial. Cairn's own design doc already independently arrived at
a structurally similar approach (INV-7 shared-tail byte-identity, `PayoutSet` frozen at `buildJob()`
time) — worth explicitly citing Ocean as prior art validating the general shape when the eventual
feature is documented/marketed. Also steal: Ocean's plain per-block transparency framing
("100% transparent," worker-suffix addressing) as a model for what Cairn's `/mining` and
`/admin/mining` dashboards should surface once split mode ships.

**Avoid:** (1) Ocean's carry-forward balance accounting — Cairn's design doc already correctly
avoids this, and this analysis reinforces that the avoidance is well-founded, not overcautious; (2)
launching without any public legal-positioning statement — if Cairn ever ships split-payout mode,
the operator-acknowledgment and miner-opt-in flow specified in `COINBASE-PAYOUT-POOL-DESIGN.md` §13
should be more transparent about the regulatory reasoning than Ocean's public materials are, not
less; (3) DATUM's dependency on the miner running their own full node for template construction — a
real technical barrier that cuts against Cairn's plain-language, low-friction onboarding philosophy,
worth deliberately not replicating in a first-week flow.

---

## 5. Cross-cutting synthesis — top 5 actionable recommendations, ranked by impact

1. **[watch]** Treat Ocean's absence of public legal/regulatory documentation as a red flag, not
   reassurance, for Cairn's own `cairn-vn43.14` gate. Do not let "Ocean ships this way" enter the
   internal decision record as evidence of safety for `docs/COINBASE-PAYOUT-POOL-DESIGN.md` §13 —
   counsel review stays a precondition regardless of what any competitor does or doesn't publish.
   Highest impact because it directly guards a legal/regulatory decision already identified as the
   single blocking gate on Cairn's next mining-pool epic.

2. **[steal]** Adopt a Nunchuk-style **"we hold one key/piece, never custody"** trust-minimized
   framing as the template for any future Cairn feature needing light server assistance (assisted
   recovery, collaborative custody, or the mining split-mode's leaderboard bookkeeping) — plus
   Nunchuk's **testnet-first trial** pattern before committing real funds to a new multisig/quorum
   configuration. High impact because Cairn has no current collaborative-custody UX and this is the
   most directly transferable pattern found across all four products.

3. **[steal]** Roll Sparrow's "structure tames density" lesson (already named in
   `docs/DESIGN-MANIFESTO.md` §4) forward explicitly into Cairn's Explorer and future mining-pool
   admin dashboard: dense data is fine and reads as powerful *only* inside a clearly bounded panel
   on an otherwise calm field — Sparrow is the best living proof-of-concept of this principle
   outside Cairn's own docs. Medium-high impact, directly actionable in the ongoing gt05.4 (Explorer
   de-jargon) and future mining-split admin UI work.

4. **[avoid]** Do not let Cairn's future split-payout percentages (finder/leaderboard/fee) become an
   opaque, operator-discretion configuration the way Nunchuk's tier pricing feels ($480→$2,100 for
   one more cosigner slot) or the way a poorly-communicated version of Ocean's DATUM fee discount
   could read. `COINBASE-PAYOUT-POOL-DESIGN.md` §13 already flags "published, open-source-default,
   miner-consented" percentages as the better legal posture — this recommendation reinforces that on
   pure UX-trust grounds too, independent of the legal reasoning. Medium impact, directly actionable
   whenever the split-mode admin UI (file #10 in the design doc's change list) is built.

5. **[steal]** BlueWallet's "magical form" auto-detect-on-import pattern is the single most portable
   plain-language UX win found in this research — apply it anywhere Cairn currently asks a user to
   pre-identify a technical format (backup file type, wallet descriptor type, hardware-wallet
   protocol) before it will proceed. Lower impact than #1–#4 (no legal or architectural risk
   attached) but cheap to implement and squarely inside Cairn's "no jargon by default" principle
   (spec §4).

---

## 6. Unverified / flagged

Preserved honestly, not smoothed into the narrative above:

- **BlueWallet v8.0.0 release date is disputed between sources.** BlueWallet's own blog post dates
  the release June 2, 2026 (announcement published June 10, 2026)
  [BlueWallet v8.0.0 announcement](https://bluewallet.io/bluewallet-v8-0-0-drops-fresh-faster/), but
  a direct fetch of BlueWallet's GitHub Releases page rendered the same v8.0.0 entry with a "June 2,
  2024" date [GitHub Releases](https://github.com/BlueWallet/BlueWallet/releases). This could be a
  scraping/rendering artifact rather than a genuine discrepancy, but it was not resolved and should
  not be treated as confirmed either way.
- **No critical/negative commentary on Ocean or DATUM was found.** Every search targeting Ocean
  criticism, DATUM pushback, or technical objections (including a query naming Luke Dashjr directly)
  returned only favorable or promotional coverage. This may reflect a genuine lack of prominent
  public criticism, or it may reflect a gap in this research pass (search-engine result bias, timing,
  or query phrasing) — treat Ocean's positive framing in §4 as under-stress-tested until a
  dedicated adversarial pass is done.
- **Ocean's money-transmitter/legal status could not be verified in either direction.** As detailed
  in §4.2, no Ocean-specific legal statement, filing, or counsel opinion was found. This is reported
  as an absence of evidence, not evidence of either compliance or non-compliance.
- **Nunchuk's exact platform-key cryptographic mechanism (true MPC vs. a conventional Nth
  multisig-cosigner key held server-side) was not confirmed from primary technical documentation** —
  all sourcing here is marketing copy and third-party reviews describing it in trust-minimized terms,
  not a technical whitepaper or audit. Treat "trust-minimized" as Nunchuk's own characterization, not
  an independently verified security property.
- **Sparrow's exact current user-base size, and Nunchuk's exact current AUM beyond the
  previously-reported "$1 billion+" figure** [Bitcoin Magazine](https://bitcoinmagazine.com/business/nunchuk-the-open-source-mobile-multi-sig-wallet-now-securing-over-1-billion-in-bitcoin),
  were not re-verified for this pass and may be stale.

---

*End of report.*
