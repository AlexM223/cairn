# Competitor Analysis — Round 2 — Zeus, Blockstream Green, Envoy/Passport, Liana, Umbrel-ecosystem neighbors (+ Casa/Bitkey)

**Date:** 2026-07-19
**Status:** research snapshot (round 2), feeds UX / recovery-inheritance / collaborative-custody /
Umbrel-citizen decisions; not itself a design doc
**Method:** web research (WebSearch/WebFetch) against public product sites, docs sites, GitHub, help
centers, and third-party reviews, mid-2026. Cross-referenced against `docs/UX-REDESIGN-SPEC.md`,
`docs/DESIGN-MANIFESTO.md`, and round 1 (`docs/COMPETITOR-ANALYSIS.md`). Every claim is sourced
inline; anything that couldn't be independently verified is called out in §8 rather than smoothed
over.

**Relationship to round 1.** Round 1 covered BlueWallet, Sparrow, Nunchuk, and Ocean. This round
deliberately does **not** re-tread that ground (the "magical form" import pattern, Sparrow's
"structure tames density," Nunchuk's trust-minimized platform-key framing and testnet-first trial,
Ocean's pre-computed-payout / legal-positioning analysis all stand as written). Round 2 targets the
five surfaces round 1 left open: **mobile node-connection UX (Zeus)**, **2FA-managed "middle-ground"
self-custody (Green)**, **calm seedless onboarding for normies (Envoy/Passport)**, **timelock
recovery / inheritance prior art (Liana)**, and **good-Umbrel-citizen node-app UX (Alby Hub, LNbits,
umbrelOS itself)** — plus a short managed-multisig benchmark (Casa/Bitkey).

Cairn's own UX philosophy, for reference throughout: **plain language, no Bitcoin internals exposed
by default, guided wizards, one hero number / one primary action per screen, sats-first,
evergreen-ink palette** (spec principles 1–7; manifesto §1, §6). Two design-doctrine facts matter
repeatedly below: (a) Cairn is **key-on-device self-custody** — it holds public keys and wallet
*config*, never seeds or private keys (spec §2.2 "Cairn holds only your public key"); (b) Cairn has
**no inheritance/recovery story today** and an adjacent-but-incomplete collaborative-custody access
gate (owner/viewer/cosigner, per memory), which makes Liana and the managed-multisig products the
most load-bearing comparisons in this round.

---

## 1. Zeus (mobile node wallet — power features, mobile-ified)

**Snapshot.** Open-source React-Native mobile Bitcoin/Lightning wallet (iOS/Android), long-running
project. Three connection postures in one app: (a) **connect to your own remote node** (LND or Core
Lightning) over the Commando/`lnsocket` API, typically via Tor; (b) an **embedded node on the phone**
("node in the phone" — embedded LND, plus an LDK-Node path) that runs a real Lightning node locally,
Phoenix-style; (c) Lightning-address send/receive layered on top. Recent work (v0.13.1, ~March 2026
per search summary — *see §8*) hardened Commando/`lnsocket` reliability, added a reworked onboarding,
embedded-LND **device migration that keeps channels intact**, new amount-input + currency-selection
UX, **graduated wallet-upgrade prompts**, and a Lightning-address payment flow.
[zeusln.com](https://zeusln.com/), [GitHub ZeusLN/zeus](https://github.com/ZeusLN/zeus),
[Plan ₿ Academy — Zeus Embedded](https://planb.academy/tutorials/wallet/mobile/zeus-embedded-c67fa8bb-9ff5-430d-beee-80919cac96b9),
[Knowing Bitcoin — best LN wallets 2026](https://knowingbitcoin.com/best-lightning-wallets-2026-tested-compared/)

**UX model.** Maximum-control, expert-facing. Reviewers who like it call it "the best UX of any
self-custodial wallet," but the same reviews are explicit that **even Zeus's "simple" mode exposes
more settings than Phoenix or Breez**, and that advanced use "requires understanding channel
economics, liquidity management, and node operation." It is repeatedly ranked "not ideal for complete
beginners," with beginners pointed at Strike / Wallet of Satoshi instead.
[Knowing Bitcoin](https://knowingbitcoin.com/best-lightning-wallets-2026-tested-compared/),
[Coin Bureau](https://coinbureau.com/analysis/best-bitcoin-lightning-wallets)

**The direct comparison point — node-connection UX.** This is the single most relevant Zeus surface
for Cairn: Zeus is the reference implementation of *"drive your own node from a phone."* Its embedded
vs. remote choice is exactly the shape Cairn faces when it decides how much of the own-node story to
put on the surface. Two lessons stand out:

1. **The connect-to-your-own-node flow is a first-class onboarding branch, not a buried setting** —
   Zeus treats "which node am I talking to?" as a top-level identity decision. Cairn already makes
   the analogous call correctly (its own-node Explorer + Core-RPC auto-detection is the sovereignty
   payoff — manifesto §1), so Zeus mostly *validates* Cairn's instinct rather than teaching a new
   move here.
2. **Where Zeus fails is the exact failure mode Cairn's doctrine is built to prevent.** The Plan ₿
   walkthrough shows the embedded-node path deducting "10,000 satoshis" to auto-open a channel with
   the Olympus LSP, with the *reason* for the fee (channel-open cost, 3-month LSP liquidity
   commitment, capital lock-up) "buried in small details… most casual users won't understand why
   liquidity costs money upfront." That is a naked Bitcoin-internal (channel liquidity economics) on
   a money screen with no plain-language gloss — precisely what Cairn's `<Term>`/`HowItWorks`
   discipline (spec §4) exists to stop.

**What Zeus does better than Cairn today:**
- **Graduated wallet-upgrade prompts** — Zeus nudges a user *up* a capability ladder over time
  (custodial-ish → embedded node → your-own-node) instead of demanding the final posture at
  onboarding. This "grow into the advanced features" progression is a concrete pattern Cairn's wizards
  don't yet use; it's the temporal version of Cairn's spatial 3-tier disclosure.
- **Embedded-node device migration that preserves channels** — the hardest state-migration problem in
  mobile Lightning, handled as a guided flow. Not directly applicable (Cairn isn't a mobile LN
  wallet) but a benchmark for "migration is a flow, not a support ticket."
- **Best-in-class remote-node control from a phone** — the `lnsocket`/Commando transport is a mature
  proof that a phone can safely drive a home node; relevant if Cairn ever ships a companion mobile
  surface for its Umbrel node.

**Steal:** the **graduated-upgrade prompt** — surface advanced capability as an *earned next step the
user is invited into when ready*, not as an onboarding-time fork. Named Cairn application: the
wallet-creation wizard and Home. A first-week single-sig user should never see multisig/"shared
wallet," collaborative custody, or recovery-timelock options at creation; instead, once they have a
funded wallet and some tenure, Home (or Health) can surface a single calm, dismissible "Ready for
more? Add a recovery key / share this wallet ›" invitation. This is the temporal complement to spec
§1's first-week-visibility rule.

**Avoid:** Zeus's **unglossed liquidity/channel economics on money screens** (the buried 10k-sat fee
rationale) — the canonical example of the jargon-on-the-surface failure the manifesto's AVOID list
(§7, "blockchain jargon on the surface") forbids. Also avoid Zeus's **"simple mode still isn't
simple"** trap: a mode labelled "simple" that still out-exposes Phoenix/Breez has mislabelled its own
complexity. If Cairn ever ships a "simple/advanced" toggle, "simple" must be genuinely first-week-
clean, not merely a slightly-thinner expert view.

---

## 2. Blockstream Green (2FA-protected "managed self-custody" middle ground)

**Snapshot.** Open-source, multi-platform (mobile + desktop) wallet from Blockstream. Two account
models presented as a spectrum: **singlesig** (standard 12/24-word BIP39, fully interoperable/
exportable to other wallets) and **"Multisig Shield"** — a 2-of-2 (effectively 2-of-3 with a backup
key) where **one key lives on the user's device and one lives on Blockstream's servers, released only
when the user passes 2FA** (authenticator app, email, SMS, or call; a 6-digit code per outgoing
transaction). PIN login after first setup. Watch-only wallets supported (including multisig
watch-only). One recovery phrase spans both Bitcoin and Liquid across singlesig and multisig. Green
2.0 (desktop) shipped a simplified, more accessible redesign.
[Blockstream Green — Self-Custody](https://blog.blockstream.com/blockstream-green-bitcoin-self-custody/),
[Announcing Singlesig](https://blog.blockstream.com/en-blockstream-green-announcing-singlesig-wallets/),
[Green 2.0 desktop redesign](https://blog.blockstream.com/blockstream-green-2-0-a-new-accessible-experience-for-bitcoin-desktop-wallets/),
[Which account security policy should I choose?](https://help.blockstream.com/hc/en-us/articles/4403642609433-Which-account-security-policy-should-I-choose)

**The middle-ground thesis (the direct comparison point).** Green is the clearest living example of
*"managed self-custody"* — the user never gives up custody (they always hold a key + recovery
phrase), but a server participates in every spend to add a theft-resistance layer. This is exactly
the design space Cairn will enter the moment it offers *any* server-assisted feature (assisted
recovery, collaborative-custody signaling, or the mining split-mode bookkeeping round 1 flagged).
Round 1 already lifted Nunchuk's *rhetorical* framing ("we hold one key, never custody"); Green adds
the two mechanisms that make that framing safe and honest:

- **A timelock safety-net that removes the server from the trust model over time.** Green uses a CSV
  timelock (upgraded from the older nLockTime approach), default **51,840 blocks (~360 days)**, reset
  on each new deposit. After it expires, the 2-of-2 degrades to a 1-of-2 the user can spend **with
  their device key alone**, and an open-source recovery tool (`garecovery`) works even if Blockstream
  disappears entirely. The server is a *convenience with an expiry date*, never a permanent
  dependency.
  [CSV timelocks](https://blog.blockstream.com/en-blockstream-green-bitcoin-wallets-now-using-checksequenceverify-timelocks/),
  [Lost access to 2FA method](https://help.blockstream.com/blockstream-app/troubleshooting/lost-access-to-2fa-method)
- **An explicit "which policy should I choose?" decision-helper** framing singlesig vs. multisig as a
  tradeoff a novice can actually reason about (interoperability & self-reliance vs. an anti-theft
  second factor), rather than dumping the choice on the user unframed.
  [Which policy should I choose?](https://help.blockstream.com/hc/en-us/articles/4403642609433-Which-account-security-policy-should-I-choose)

**What Green does better than Cairn today:**
- **It turns the scariest choice in self-custody (how many keys, who holds them) into a guided,
  plain-language decision** with a documented default and an honest statement of what each option
  protects against. Green's help center is explicit that 2FA-multisig "protects against theft" but
  does *not* protect against losing your own device key or simultaneous PIN+2FA compromise — a clean
  threat-model articulation Cairn's multisig ("shared wallet") creation flow does not currently match.
  [2FA multisig protection explained](https://help.blockstream.com/hc/en-us/articles/900001391763-How-does-Blockstream-Green-s-2FA-multisig-protection-work)
- **The timelock "server expires, you keep the coins" pattern is a gold-standard trust-minimization
  primitive** — it is the honest answer to "what if the company dies?", baked into the script rather
  than promised in a ToS. Directly relevant to any future Cairn assisted-recovery or
  collaborative-custody feature.
- **Watch-only as a first-class wallet type** (including multisig watch-only) — a clean way to let a
  user monitor cold storage without exposing spend capability. Cairn's viewer tier is adjacent but
  Green's watch-only is a more polished, self-contained surface.

**Steal:** the **"which security policy should I choose?" decision-helper** — a short, plain-language
tradeoff screen with a recommended default, shown when a user creates a wallet whose security model
is a real choice. Named Cairn application: the wallet-creation wizard's single-sig vs. "shared
wallet" (multisig) fork, and any future recovery-key/inheritance setup. Two cards, plain sentences
("Just you, on your device" vs. "Shared — needs more than one approval to spend"), one marked
*Recommended for most people*, each with a one-line "protects you from / doesn't protect you from"
honesty note — squarely inside spec §4 (no jargon by default) and §6 (safety never hidden). Also
steal: the **timelock-degrades-to-self-custody framing** as the template for how Cairn should
describe *any* server-assisted recovery it ever builds ("after N months, you can recover with your
key alone, even if Cairn is gone").

**Avoid:** Green's **2FA lockout cliff** — losing your 2FA method triggers a **1-year reset window
during which you cannot spend at all** (short of waiting out the timelock). That is a catastrophic,
under-communicated foot-gun for a non-expert, and the exact opposite of Cairn's "friction ∝ stakes,
undo beats a warning" doctrine (manifesto §5). Any Cairn feature with a time-locked recovery path
**must** surface the lockout consequence *before* the user opts in, in plain language, not bury it in
a help-center article. Also avoid Green's **residual-risk asymmetry** that its own docs half-hide:
once the timelock expires, an attacker with only the recovery phrase can steal funds without 2FA —
i.e. the safety-net has a security cost the marketing doesn't lead with. Cairn's recovery UX should
state such tradeoffs plainly (spec §6), not smooth them.

---

## 3. Envoy + Foundation Passport (calm seedless onboarding for normies)

**Snapshot.** Foundation makes the **Passport** hardware wallet and the **Envoy** mobile companion
app. Envoy's positioning is the strongest "Bitcoin, simplified" onboarding story in hardware-adjacent
land: **60-second, seedless setup** via **Magic Backups**, plus biometric/PIN auth and a
swipe-to-hide-balance gesture. Passport Prime extends the same "magic" idea to the hardware device
with a Shamir-split master key.
[foundation.xyz/envoy](https://foundation.xyz/envoy/),
[Announcing Envoy — Bitcoin Simplified](https://foundation.xyz/blog/announcing-envoy-wallet-bitcoin-simplified),
[Magic Backups: How Do They Work?](https://foundation.xyz/blog/magic-backups-how-do-they-work),
[Envoy Backups docs](https://docs.foundation.xyz/backups/envoy/)

**Magic Backups — the mechanism (the direct comparison point).** This is the most transferable
onboarding pattern in the entire round, because it dissolves the single worst moment in self-custody
onboarding (the 12/24-word write-down) without lying about custody:
- The wallet seed is generated **in the phone's secure element** ("a hardware-protected environment
  isolated from apps and the OS"). The seed **never leaves the device** in plaintext.
- Non-sensitive app data (**account labels, settings** — explicitly *not* the seed) is **encrypted
  with the seed as the key** and uploaded to Foundation's servers as an opaque blob: *"We have no
  access to the contents, no ability to decrypt it."*
- The seed itself is carried across the user's own devices by the OS's existing encrypted sync
  (**iCloud Keychain / Android Auto-Backup**), end-to-end encrypted by the OS, *without* granting
  Foundation any access to the user's cloud account.
- Restore legitimacy is proven by storing a **SHA256 hash of the seed** alongside the encrypted blob:
  the server can verify a restore request "without ever knowing your actual seed."
- Passport Prime uses **Shamir Secret Sharing** to split the master key into 3 parts (2 NFC Keycards
  + 1 phone-backed), any 2 of which recover — no single point of failure.
[Magic Backups: How Do They Work?](https://foundation.xyz/blog/magic-backups-how-do-they-work)

**Progressive disclosure — the second transferable pattern.** Envoy runs **three auto-advancing setup
screens** (create key in secure element → encrypt backup → upload) that "advance automatically," so
the default path is nearly button-free. Advanced users get an explicit **"Manually Configure Seed
Words"** branch to generate/import/verify their own seed and choose their own backup location. The
default is calm and seedless; the honest, technical path is one deliberate choice away — the exact
"default to simplicity, keep the honest path one gesture down" rule Cairn's spec §4 codifies.
[Envoy Mobile Wallet Setup](https://docs.foundation.xyz/envoy/setup/)

**What Envoy does better than Cairn today:**
- **It makes "back up your wallet" a thing that already happened, not a chore you're nagged about.**
  Cairn's Health surface currently *nudges* an un-backed wallet with an amber "Back up now" row (spec
  §2.6a) — good, but reactive. Envoy's model (encrypted config backup happens automatically at
  creation, framed as done) is a calmer resolution of the same duty.
- **The "we literally cannot read your backup" framing** is a stronger, more concrete privacy
  statement than a generic "your data is safe" — it names *why* (encrypted with a key only you hold),
  which spec §6 / manifesto §5 (active-affordance privacy, not reassurance-banner) would reward.
- **Swipe-to-hide-balance** validates Cairn's own inline balance-privacy eye toggle (manifesto §5) —
  convergent evidence the gesture is right; nothing new to steal, but a confidence signal.

**Steal:** the **"encrypted config backup, done automatically, and we can't read it" pattern** for
Cairn's *wallet-config* backup. Named Cairn application: the Health "Backups" duty (spec §2.6a) and
the wallet-detail "Download backup file" flow (spec §2.2). Crucial doctrine fit: Cairn is key-on-
device self-custody, so it is backing up **wallet descriptors / labels / settings, never seeds** —
which is *exactly* the non-sensitive class Envoy encrypts and stores. Cairn can adopt the honesty
framing ("this backup contains your wallet's public setup and labels, encrypted so only you can read
it — never your keys") verbatim in spirit, turning the backup from a scary chore into a calm,
already-handled state. Also steal: **auto-advancing setup screens** for any Cairn wizard step that is
purely mechanical (key generation, config write) — don't make the user click through work they didn't
ask to supervise.

**Avoid:** the **cloud-dependency ambiguity** Envoy's own docs create — the seed's cross-device
survival leans on iCloud Keychain / Android Auto-Backup being enabled, which many privacy-minded
users disable, creating a silent single-device-loss risk the "60 seconds, no seed words!" headline
doesn't foreground. For Cairn, whose whole identity is *your* node / *your* sovereignty, never let a
"magic" convenience quietly introduce a third-party (or cloud) dependency without a plain-language
disclosure and a fully-local alternative on the same screen. (This is also a positioning note: Envoy
softens self-custody toward "trust the secure element + your phone vendor's cloud"; Cairn's brand is
harder-line and should stay so.)

---

## 4. Liana (Wizardsardine) — timelock recovery / inheritance prior art

**Snapshot.** Open-source desktop (daemon + `iced` GUI) Bitcoin wallet built on **Miniscript**,
positioned as **"the missing safety net for your coins."** Its differentiator is **timelocked
recovery paths**: you define not only *who* can spend but *when* — a recovery key (or keyset) that can
only move funds after a configured delay if the primary key(s) are lost or unavailable. Use cases:
trustless inheritance, loss protection, safer backups.
[Announcing Liana](https://wizardsardine.com/blog/liana-announcement/),
[Liana wallet](https://wizardsardine.com/liana/wallet/),
[Liana 8.0 release](https://wizardsardine.com/blog/liana-8.0-release/),
[GitHub wizardsardine/liana](https://github.com/wizardsardine/liana)

**Why this is the most important comparison in round 2.** Cairn has explicit inheritance/recovery
ambitions and a collaborative-custody access model, but **no recovery story today**. Liana is the
mature prior art for the exact primitive Cairn will need: *"if you lose your key, after N months a
recovery key works."* And critically, Liana has already solved the **hard UX problem** — making
miniscript timelock policies comprehensible to non-experts — which is precisely where Cairn's plain-
language doctrine must land.

**The Liana 8.0 UX breakthrough (the steal-worthy material).** Early Liana admitted "UX was not
prioritized for this first version." Liana 8.0 fixed it with three moves Cairn should copy almost
directly:
1. **Pre-configured policy templates** instead of raw miniscript. Two concrete named templates —
   **"Simple Inheritance"** (single primary key + one timelocked inheritance key) and **"Expanding
   Multisig"** (2-of-2 primary that expands to 2-of-3 with a recovery key) — plus a **"Build your
   own"** escape hatch for power users. The user just links their devices/public keys into a proven
   shape; they never author a policy from scratch.
2. **A graphical "here's the setup you're about to create" explainer step** *before* the user commits
   — "an intermediate step in which we try to explain graphically which will be the expected setup."
   Understanding precedes commitment.
3. **Visual primary-vs-recovery-key distinction** — color-coding separates primary keys from recovery
   keys, and green primary-action buttons guide the user to the next expected step, reducing the
   cognitive load of a genuinely multi-key mental model.
[Liana 8.0 release](https://wizardsardine.com/blog/liana-8.0-release/),
[BitBox — exploring Miniscript with Liana](https://blog.bitbox.swiss/en/exploring-bitcoin-miniscript-with-liana-and-the-bitbox02/)

**What Liana does better than Cairn today:**
- **It has a working, plain-language recovery/inheritance product at all** — the single biggest
  capability gap between Cairn and this cohort. The "define who *and when*" framing is the cleanest
  articulation of timelock recovery found anywhere in this research.
- **Templates-over-raw-policy is the right abstraction ladder** — it maps a fearsomely-flexible
  primitive (miniscript / "virtually unlimited options") down to 2–3 human-meaningful choices, with
  full power reachable underneath. This is Cairn's 3-tier disclosure rule (spec §5) applied to a
  script policy: guardrails on top, full flexibility one gesture down.
- **The "explain graphically before you commit" step** is a direct answer to the highest-stakes,
  least-reversible setup decision in self-custody — who can take your coins, and when. Cairn's
  friction ladder (manifesto §5) says friction should scale with stakes; a recovery-policy setup is
  maximum-stakes and deserves exactly this kind of comprehension gate.

**Steal (highest-value of the round):** the **template + graphical-preview + color-coded-key-roles**
pattern for Cairn's future inheritance / recovery / collaborative-custody wizard. Named Cairn
application: a new recovery-setup flow (and the existing "shared wallet"/multisig creation). Concrete
shape, in Cairn's voice: offer **"Simple recovery"** ("If you ever lose access, a backup key you
choose can recover the funds after a waiting period — say 6 months") and **"Shared wallet"** ("More
than one person or device must approve a spend") as named templates with a **"Build your own"** power
path; render a **plain diagram of the resulting setup** (which key is primary, which is recovery,
what the delay is) as a mandatory review step before creation; and **color/label primary vs. recovery
keys** consistently (fitting the evergreen palette — primary in the slate-blue action accent, recovery
in a distinct-but-calm tone, never red unless destructive — manifesto §2). This is the round's top
recommendation because it converts Cairn's *stated* inheritance ambition into a concrete, doctrine-
aligned, buildable flow with a proven exemplar.

**Avoid:** Liana's **origin sin — shipping the powerful primitive first and the UX later** ("UX was
not prioritized for this first version"). For a maximum-stakes feature like recovery/inheritance,
Cairn cannot ship the miniscript/timelock capability ahead of the plain-language wizard the way Liana
did; the comprehension layer *is* the feature for Cairn's audience, not a follow-up. Also avoid
Liana's residual **desktop-daemon + technical-installer footprint** as a model for the *default* path
— fine for a power tool, but Cairn's on-Umbrel, guided-wizard posture should never make a novice
think about daemons or policy syntax.

**Legal/positioning note.** Timelock recovery for inheritance edges toward estate-planning-adjacent
territory. Liana frames it purely as a self-custody *tool* ("safety net"), not as legal/estate
advice — a positioning line Cairn should hold to as well: ship the *mechanism* and plain-language
explanation, never imply it constitutes legal inheritance/estate counsel. (Consistent with round 1's
discipline around not inferring legal cover from a competitor's mere existence.)

---

## 5. Umbrel-ecosystem neighbors + Start9 equivalents (good-node-app-citizen UX)

**Snapshot.** Cairn ships as an Umbrel (and Start9-class) app, so "how do the *best* node-attached
finance apps behave as citizens of these platforms" is a first-order UX question distinct from the
wallet-vs-wallet comparisons above. The reference neighbors: **Alby Hub**, **LNbits**, the **mempool**
app, and umbrelOS's own platform affordances.
[umbrelOS](https://umbrel.com/umbrelos),
[Umbrel App Store](https://apps.umbrel.com/),
[UmbrelOS makes self-hosting feel like a product](https://webiano.digital/umbrelos-makes-self-hosting-feel-like-a-product/)

**What umbrelOS gives every app for free (and what a good citizen leans on rather than reinventing).**
umbrelOS is "a home cloud OS with a browser-first interface, built-in app store, one-click updates,
app-level permissions and dependencies, **unified authentication**, hardware monitoring, and
**encrypted backups**." Backups "run automatically every hour once set up," are "encrypted client-side
before being uploaded over Tor and are padded with random data," can target another Umbrel / a NAS /
external USB, and support **Rewind** for granular file/folder restore.
[Introducing Backups on umbrelOS](https://community.umbrel.com/t/introducing-backups-on-umbrelos/23961),
[Backing up your data — umbrelOS Support](https://umbrel.com/support/backups-and-recovery/backing-up-your-data)

**Alby Hub — the model good citizen.** Alby Hub demonstrates the patterns worth copying:
- **Auto-detect and configure against the platform's native node** — it "auto-detects and configures
  with the native Lightning Node app when present, eliminating manual setup friction," and offers
  embedded-node *or* connect-to-existing-node as a first-class choice.
- **Sub-wallets for family and friends** — distributed accounts without new custody machinery.
- **Zero-config one-click install** backed by the user's own node; leans on umbrelOS's app model
  rather than shipping its own installer.
[Alby Hub | Umbrel App Store](https://apps.umbrel.com/app/albyhub),
[Alby Hub community guide](https://community.umbrel.com/t/alby-hub-get-a-lightning-address-and-use-your-umbrel-in-any-bitcoin-app/18887)

**LNbits — the "multi-user on one node" pattern.** LNbits is "a simple multi-user and account system
for Lightning… for creating separate wallets for friends and family," bundled with a transaction
table, a spending line-chart, and CSV export.
[LNbits | Umbrel App Store](https://apps.umbrel.com/app/lnbits)

**What these neighbors do better than Cairn today (or that Cairn should be careful to match):**
- **They lean on umbrelOS's unified auth instead of fighting it.** This is directly load-bearing for
  Cairn: memory records Cairn's **dual-auth model** and a standing rule that **Umbrel needs password
  mode and password auth must NOT be removed** (`cairn-auth-model`). A good-citizen posture is to
  honor the umbrelOS SSO/session context and never make an Umbrel user hit a *second* login wall that
  duplicates what the platform already did.
- **They integrate with (don't duplicate) umbrelOS's hourly encrypted backups.** Cairn's own
  wallet-config backup (spec §2.6a Health "Backups" duty) should be *legible to* and *coherent with*
  the umbrelOS backup story — a user should not have to reason about two overlapping backup systems,
  and Cairn's Health copy should acknowledge the platform layer ("your wallet setup is included in
  your Umbrel backup") where true, rather than implying Cairn is the only safety net.
- **One-click updates + zero-config install** — the citizens set the bar that Cairn's install/update
  path must clear (which the umbrel-update skill process in memory already governs).
- **Auto-detect the node** — Alby Hub auto-wires to the native Lightning app; Cairn's Core-RPC
  auto-detection (memory: v0.2.9 Core-RPC) is the same good instinct and should stay the default.

**Steal:** **good-Umbrel-citizen conformance as an explicit, checklist-able UX bar** — (1) honor
umbrelOS unified auth so an Umbrel user isn't double-gated; (2) make Cairn's config backup coherent
with (and legible against) umbrelOS's hourly encrypted backups rather than a parallel scheme; (3)
keep node auto-detection the default. Named Cairn application: the Health surface (spec §2.6a — the
"Backups" and "Node" duty rows should reference the umbrelOS layer where it exists), the auth/session
layer, and the update path. This is lower-glamour than the wallet steals but it's the difference
between "an app that runs on Umbrel" and "an app that feels native to Umbrel."

**Avoid:** the neighbors' common weakness — **exposing multi-user/sub-wallet and Lightning-liquidity
machinery on the surface** (LNbits' admin-key/user-management model and Alby Hub's channel/NWC
plumbing are powerful but jargon-dense). Cairn's collaborative-custody / shared-wallet features must
not inherit that "admin dashboard for your money" texture (manifesto §7 AVOID: sales-floor stacking,
data-walls). Also avoid making Cairn's backup story *compete* with umbrelOS's — a second, differently-
shaped backup nag is exactly the kind of duplicated-duty clutter spec §5's consistency mandate
forbids.

---

## 6. Casa / Bitkey — managed-multisig UX benchmarks (brief)

**Snapshot.** Two managed/collaborative-custody products worth a short benchmark for Cairn's shared-
wallet and future recovery work.
- **Bitkey (Block).** A **pre-configured 2-of-3 multisig**: a hot key in the mobile app, an
  **NFC hardware key with no display**, and a **recovery key held by Block** (which cannot spend
  alone — only assist recovery). Deliberately usability-first: hot mobile key instead of a second
  cold device, a screenless hardware key, and key-generation/backup "abstracted away entirely,"
  yielding "a smooth onboarding process and a very clean UI." Inheritance runs through Block's
  identity-verification flow.
  [Bitkey review — Nunchuk](https://nunchuk.io/blog/bitkey),
  [Bitkey vs Casa](https://thebitcoinhole.com/inheritance/bitkey-vs-casa)
- **Casa.** Polished collaborative custody with **2-of-3 and 3-of-5 tiers** and an **Inheritance
  Plan** letting a named beneficiary recover via identity verification; subscription $250–$2,500/yr.
  [Casa review](https://www.walletpilot.com/collaborative-custody/casa/review),
  [Casa inheritance](https://thebitcoinhole.com/inheritance/casa)

**What they do better than Cairn today:** they prove that **multisig can feel like one clean product,
not a key-management console** — Bitkey especially collapses "2-of-3 multisig" into a single "set it
up and forget the keys" experience. That is the bar for Cairn's "shared wallet" naming (spec §4
already renames multisig → "shared wallet"): the *feeling* should match the name.

**Steal:** Bitkey's **"pre-configured quorum with abstracted key management"** as the mental model for
Cairn's shared-wallet default — offer a sensible default quorum shape and hide the key-ceremony
machinery behind the wizard, rather than making the user compose a policy. (Complements the Liana
template steal in §4.) Named Cairn application: the "shared wallet" creation wizard.

**Avoid:** the **subscription/tier pricing opacity** (round 1 already flagged this via Nunchuk;
Casa's $250→$2,500 ladder is the same anti-pattern) and Bitkey's **vendor-held recovery key** as a
custody-model choice — Block-cannot-spend-alone is good, but a permanent third-party key cuts against
Cairn's harder-line sovereignty brand unless it degrades to self-custody over time (Green's timelock
model, §2, is the better primitive here).

---

## 7. Cross-cutting synthesis — top steal-worthy patterns, ranked by impact

Ranked by impact for Cairn specifically, given its stated inheritance/recovery ambitions, its
collaborative-custody gap, and its on-Umbrel posture. (`[steal]` = adopt a concrete pattern;
`[guard]` = a doctrine boundary to hold.)

1. **[steal] Liana's template + graphical-preview + color-coded-key-roles pattern for recovery /
   inheritance / shared-wallet setup (§4).** Highest impact: it converts Cairn's *stated but unbuilt*
   inheritance/recovery ambition into a concrete, doctrine-aligned, buildable wizard with a proven
   exemplar — named templates ("Simple recovery," "Shared wallet," "Build your own"), a mandatory
   plain-diagram review before commit, and consistent primary-vs-recovery key coloring in the
   evergreen palette. This is the single most valuable transfer in the round because it targets
   Cairn's biggest capability gap with the most mature prior art.

2. **[steal] Green's "which security policy should I choose?" decision-helper + timelock-degrades-to-
   self-custody framing (§2).** High impact and directly complementary to #1: the plain-language,
   recommended-default, honest "protects you from / doesn't protect you from" chooser is exactly the
   comprehension gate Cairn's single-sig-vs-shared-wallet fork needs, and the "after N months you can
   recover with your key alone, even if we're gone" pattern is the honest template for *any* server-
   assisted recovery Cairn ever builds. Adopt the framing; **do not** adopt Green's under-communicated
   2FA lockout cliff.

3. **[steal] Envoy's "encrypted config backup, done automatically, and we can't read it" pattern (§3).**
   Medium-high impact, cleanly doctrine-fit: Cairn backs up wallet descriptors/labels/settings (never
   seeds — the exact non-sensitive class Envoy encrypts), so Cairn can turn its amber "Back up now"
   Health nudge into a calmer *already-handled* state, with the concrete "encrypted so only you can
   read it — never your keys" honesty framing (manifesto §5 active-privacy). Plus auto-advancing setup
   screens for purely-mechanical wizard steps.

4. **[steal] Zeus's graduated-upgrade prompt — advanced capability as an earned next step, not an
   onboarding fork (§1).** Medium impact: the temporal complement to spec §1's first-week-visibility
   rule. A tenured, funded single-sig user gets one calm, dismissible "Ready for more?" invitation
   toward recovery keys / shared wallets — instead of every user facing the full capability ladder at
   creation. Cheap, low-risk, and it keeps the first-week screen clean.

5. **[steal] Good-Umbrel-citizen conformance as an explicit UX bar — Alby Hub / umbrelOS (§5).**
   Medium impact, high leverage-for-cost: honor umbrelOS unified auth (no double login wall — respects
   the `cairn-auth-model` rule), make Cairn's config backup coherent with umbrelOS's hourly encrypted
   backups rather than a parallel scheme, keep node auto-detection the default. The difference between
   "runs on Umbrel" and "feels native to Umbrel."

*Guardrails carried alongside the steals:*
- **[guard] No unglossed Bitcoin-internals on money screens (Zeus's buried liquidity fee, §1).** The
  canonical manifesto-§7 violation; Cairn's `<Term>`/`HowItWorks` discipline must hold especially in
  any new recovery/shared-wallet surface where the temptation to expose policy detail is highest.
- **[guard] Never let a "magic" convenience introduce a silent cloud/third-party dependency (Envoy's
  iCloud/Android reliance, §3; Bitkey's vendor recovery key, §6).** Cairn's sovereignty brand requires
  any such dependency to be plainly disclosed with a fully-local alternative on the same screen.
- **[guard] Surface lockout/residual-risk consequences before opt-in, not in a help article (Green's
  1-year 2FA reset and post-timelock attacker asymmetry, §2).** Friction ∝ stakes (manifesto §5); a
  maximum-stakes recovery choice deserves maximum comprehension up front.

---

## 8. Unverified / flagged

Preserved honestly, not smoothed into the narrative above:

- **Zeus version/date specifics are single-source.** The "v0.13.1, ~March 2026" Commando/`lnsocket`
  reliability claim and the specific recent-feature list (device migration, graduated upgrade prompts,
  new amount/currency UX) came from a search-result *summary*, not a directly-fetched changelog or
  release page (the `zeusln.com` fetch returned only a title). Treat the *patterns* as solid (they
  recur across reviews) but the exact version numbers/dates as unconfirmed.
- **The "best UX of any self-custodial wallet" claim for Zeus is reviewer opinion**, and sits in
  tension with the same reviews calling it "not for beginners." Reported as a subjective quality
  signal, not a fact.
- **Blockstream Green's timelock parameters** (51,840 blocks / ~360 days default, CSV-vs-nLockTime
  upgrade, 1-year 2FA-reset window, `garecovery` tool) come from Blockstream's own help center and
  blog; the mechanism is well-documented but exact current defaults may have changed and were not
  cross-checked against the live app.
- **Envoy Magic Backups internals** (secure-element seed storage, SHA256-hash restore verification,
  Shamir 2-of-3 split for Passport Prime) are sourced entirely from Foundation's own blog/docs —
  Foundation's characterization, not an independent audit. The specific claim that iCloud
  Keychain/Android Auto-Backup is *required* for cross-device seed survival is my inference from their
  description of the default flow; the manual-seed path exists as an alternative, but the precise
  failure mode if a user disables OS cloud sync *and* uses Magic Backups was not confirmed from a
  primary troubleshooting doc.
- **Liana template names and the 8.0 UX specifics** ("Simple Inheritance," "Expanding Multisig,"
  "Build your own," the graphical explainer step, green primary-action coloring) come from the Liana
  8.0 release post as summarized; exact current template names/wording may differ in the shipping app
  and were not verified against a live install.
- **umbrelOS backup specifics** (hourly cadence, client-side encryption over Tor, random padding,
  Rewind granular restore) are from umbrelOS's own announcement/support pages; not independently
  verified, and cadence/behavior may vary by umbrelOS version. Whether Cairn's app data is
  *automatically* included in a umbrelOS backup (vs. requiring app-level opt-in) was **not**
  confirmed and should be verified before any Health copy claims it.
- **Casa/Bitkey figures** (Bitkey 2-of-3 composition, Casa $250–$2,500/yr tiers and 3-of-5 option)
  come from third-party comparison sites, not the vendors' primary pricing pages this pass; treat as
  approximate.
- **No dedicated adversarial/criticism pass** was run against Green, Envoy, Liana, or the Umbrel
  neighbors (only Zeus drew explicit "too complex for beginners" criticism in search). As in round 1,
  treat the positive framing as under-stress-tested until a dedicated critical pass is done.
- **Start9 equivalents were covered only by inference** from the umbrelOS analysis; no Start9-specific
  app-citizen research was performed this pass. The "good citizen" patterns (honor platform auth,
  integrate with platform backups, one-click updates) are assumed to transfer but not verified against
  Start9's actual app model.

---

## Beads filed

Concrete buildable patterns filed as beads (br CLI). Each references its originating section above.

- **`cairn-u7vtd`** (P2) — Recovery/inheritance wizard: Liana-style templates + graphical setup
  preview. *(§4, §7 rec #1 — the round's top steal.)*
- **`cairn-givyl`** (P2) — Wallet-creation security-policy chooser (single-sig vs shared wallet),
  Green-style decision-helper + timelock-degrades-to-self-custody framing. *(§2, §7 rec #2.)*
- **`cairn-i16vl`** (P2) — Config-backup UX: Envoy-style "auto, encrypted, we can't read it" framing
  + auto-advancing mechanical steps. *(§3, §7 rec #3.)*
- **`cairn-27rx2`** (P3) — Graduated-upgrade prompt: advanced features as an earned next step
  (Zeus-style), not an onboarding fork. *(§1, §7 rec #4.)*
- **`cairn-rtunw`** (P3) — Good-Umbrel-citizen UX conformance: honor unified auth, backup coherence
  with umbrelOS, node auto-detect. *(§5, §7 rec #5.)*

---

*End of report.*
