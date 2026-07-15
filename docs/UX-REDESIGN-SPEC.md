# Cairn UX Redesign — The Spec: *Simple and Confident*

Epic: **cairn-gt05** "Full UX redesign — simple and confident"
Date: 2026-07-14
Status: canonical design spec. Synthesizes Proposal A (consumer-radical) and Proposal B
(sovereign tool, with grace) under the owner's directive. Where the proposals disagreed, this
document makes one call and states why.

Inputs (in scratchpad; screenshots referenced by filename since binaries aren't committed):
`ux-audit-current.md`, `ux-research-competitors.md`, `ux-design-A-consumer.md`, `ux-design-B-sovereign.md`.

---

## 1. Vision + principles

**Cairn should feel simple and confident — not feature-packed.** A new user opens it and knows
what to do. It is still an honest self-hosted sovereignty tool (your keys, your node), but that
depth is *one predictable gesture away*, never on the surface.

The synthesis rule between the two proposals:

> **Default to A's simplicity. Keep B's honesty where funds-safety or self-hosted identity is at
> stake.** Simplicity is the posture; nothing that can lose money or that *is* the product's
> identity gets deleted — it gets renamed, glossed once, or moved one calm layer down.

Seven principles, in priority order:

1. **First-week visibility test.** If a first-week user with one funded wallet would not touch
   it, it does not render by default. It lives behind a `Details`/`Advanced` expander, a subpage,
   or the account menu.
2. **One primary action per screen.** Exactly one accent-filled button per view. Everything else
   is ghost/secondary. (Home's Send+Receive pair is the sanctioned exception.)
3. **One hero number per screen.** The balance renders once, big, in the user's unit; fiat is a
   smaller muted line beneath, never a competing figure. Two hero-sized numbers on a screen means
   one is wrong.
4. **No jargon by default — but never lie.** The default label is plain language. The real term
   survives one tap down via a `Term` tooltip or a `Details` layer. Rename/gloss; don't delete
   capability. (B's "explain-once", not A's "delete".)
5. **Breathing room and clear hierarchy.** Generous whitespace, hairline separators over boxed
   "hero" cards, a strict small type scale, one accent color.
6. **Safety is never hidden.** Backup state and node/chain health surface as a calm, honest status
   — one line, not a foot-gun and not a data-wall. (B's Health concept.)
7. **Keep the soul.** The Heartwood identity (the ring mark, the organic voice, the block
   explorer pointed at *your* node) is the differentiator. We make it legible, not generic.

**Build order the owner asked for: Home + Send first.**

---

## 2. Per-screen decisions

Each screen: **Current problems** (audit) → **Decision** (top-to-bottom wireframe + real copy) →
**Removed / hidden / renamed** → **Stays prominent** → **A/B rationale** where they diverged.

---

### 2.1 Home (`/`, `src/routes/(app)/+page.svelte`)

**Current problems** (`ux-audit-current.md` §Home): three regions each fight to be the hero
(welcome-tour card, balance card, wallet-list card — "no clear single focal point"). ~16
interactive controls before nav. A 4-button chart-range picker guards an *empty* chart
(offender #6). "0 sats" printed twice, stacked. Zero mobile simplification — the full clutter
just reflows narrower. Operator duties (backup, node health) aren't on Home at all — they hide.

**Decision.**

**State A — zero wallets (the actual first-week screen). One thing to do:**
```
            ◍   (small Heartwood ring mark)

        Welcome to Cairn
   Your keys, your node, your bitcoin.

        ┌──────────────────────┐
        │  Add your first wallet │        ← the ONE primary action
        └──────────────────────┘

   New to this?  What Cairn does ›         ← collapsed Tier-1 expander (absorbs the tour)
```
No balance card (no balance), no chart, no activity, no Send/Receive (nothing to send). One
sentence, one button. The multi-panel welcome tour collapses into the single "What Cairn does ›"
expander and never shows again once a wallet exists.

**State B — has wallet(s), funded or not:**
```
                                                    ← 48px air
   Total balance                            👁       ← --t-label muted; eye = inline hide toggle
   $4,182.55                                        ← --t-hero. Fiat primary if enabled…
   0.0402 BTC                                       ← …else BTC is hero, fiat line hidden
                                                    ← 32px air
   ┌───────────────┐   ┌───────────────┐
   │   ↗  Send     │   │  ↙  Receive   │            ← the two verbs, equal weight
   └───────────────┘   └───────────────┘
                                                    ← 24px air
   Health · All good                     Details ›  ← ONE calm line (amber if attention needed)
   ─────────────────────────────────────────────
   Your wallets                                     ← rendered ONLY if >1 wallet (see rationale)
     Everyday Spending          0.31 BTC   ›
     Cold Storage               0.10 BTC   ›
     + Add wallet
   ─────────────────────────────────────────────
   RECENT                                    All ›  ← omitted entirely when empty
     ↙  Received      +$120.00     2h ago
     ↗  Sent          −$45.00      Yesterday
```
**Single-wallet users get the Muun-clean version** (no list; Send/Receive act on the one wallet).
**Multi-wallet users get a compact quiet list**; Send/Receive open a lightweight wallet chooser.

**Empty-but-has-wallet:** balance shows `$0.00`; the RECENT region becomes a nudge:
`Your wallet is empty. Tap Receive to get your first bitcoin. ›` (deep-links Receive).

**Removed / hidden / renamed and where it goes:**
- **Duplicate "0 sats" line → deleted.** One balance number. (Both proposals; settled.)
- **Balance-history chart + 24h/7d/30d/All picker → removed from Home**, relocated to Wallet
  detail → Details (§2.2). An empty chart guarded by 4 buttons is the worst
  clutter-to-content ratio in the app. (Both; settled.)
- **Welcome-tour card + "Dismiss welcome tour" → collapsed** into State A's "What Cairn does ›".
- **"Hide balance" button → small inline eye affordance** on the balance row, not a competing button.
- **Fiat toggle → moves to Settings → Display.** Home just honors the setting.
- **"synced Ns ago" → removed from Home.** Sync state belongs to the Health line / ChainHealthBanner,
  which speaks up only when something is wrong.
- **"Total balance" tooltip button → plain static label** (nothing to explain with one obvious balance).
- **NEW: Health line** — the signature sovereign move (see §2.6b), one calm line, amber when a duty
  needs attention.

**Stays prominent:** balance (hero, alone in whitespace), Send + Receive (the two verbs), the Health
line (calm but present). Home drops from ~16 interactive controls to ~5.

**A/B rationale — the wallet list on Home (the one real Home conflict):**
- **A said:** delete the wallet list from Home entirely; Home is aggregate-only; wallets live in the
  Wallets tab; Send/Receive open a chooser sheet.
- **B said:** keep a compact wallet list on Home — it is "the real content" of the page for a
  self-custody household.
- **Call:** hybrid by wallet count. **One wallet → A (no list, pure Muun);** **multiple → B (compact
  quiet list).** Why: for the actual first-week user (one wallet) A's clean screen wins and there's
  nothing to list anyway. A's "aggregate-only + chooser sheet" adds *machinery* (a sheet, a separate
  tab as the only wallet home) for multi-wallet users — that's more, not less. B's compact list is
  the simpler answer exactly when there's more than one wallet. This satisfies the directive (simple
  by default) without hiding a user's own wallets.

---

### 2.2 Wallet detail (`/wallets/[id]`, `src/routes/(app)/wallets/[id]/+page.svelte`)

**Current problems** (audit §Wallet detail, top-10 #1): ~13 controls. An always-visible **raw xpub
fragment** ("xpub6DN4eY…Gjbo7PYJ") in the primary info row of a screen new users visit constantly —
pure implementation detail, not even fully copyable. A **"Native SegWit"** tag with zero explanation.
An **"Addresses · 40"** tab exposing pre-generated addresses nobody asked to browse. A destructive
**"Remove this wallet"** button in normal scroll flow at equal weight. Doubled balance again. The one
genuinely good pattern here — the Receive panel — should be the *model*, not the exception.

**Decision.**
```
‹ Wallets                                          [ Single-key ⌵ ]   ← chip → opens Details
                                                                       (no raw "Native SegWit" tag)
Everyday Spending                                  ← --t-title

$4,182.55                                          ← --t-hero (this wallet)
0.0402 BTC

┌──────────┐  ┌──────────┐
│ ↗ Send   │  │ ↙ Receive│                         ← same two-verb grammar as Home
└──────────┘  └──────────┘

Activity  |  Receive                               ← two tabs only
─────────────────────────────────────────────
(Activity tab, default)
  No transactions yet.
  Send some sats to a receive address and they'll show up here.
─────────────────────────────────────────────
Wallet details ›                                   ← Tier-1 expander, collapsed
Wallet settings ›                                  ← Tier-2 link → /wallets/[id]/settings
```

**`Wallet details ›`** (Tier-1 expander, collapsed) — plain language, mono only where cryptographic:
- **Type:** "Single-key wallet." Real term one line down: "Address type: Native SegWit (bech32)"
  wrapped in `<Term tip="…">`.
- **How this wallet signs:** "Signs on your device. Cairn holds only your public key; you approve
  each payment on your hardware wallet." (Replaces the fake-clickable "Signs on your device" button.)
- **Wallet fingerprint & full xpub** — *fully* copyable here (not a truncated fragment).
- **The balance-history chart + range picker** (relocated from Home).

**`/wallets/[id]/settings`** (Tier-2 subpage): rename, "Download backup file" (was "Export config"),
the full address list ("Addresses · 40" lives here, not as a top tab), and — at the bottom, in a
demoted red **Danger** block, confirmation-gated — "Remove this wallet from Cairn — this only stops
Cairn tracking it; your funds are safe if you keep your backup."

**Removed / hidden / renamed and where it goes:**
- **Raw xpub → Wallet details expander**, labeled, fully copyable, off the main surface (fixes top-10 #1).
- **"Native SegWit" tag → "Single-key" chip**; real term glossed inside Details.
- **Doubled balance → single.**
- **"Addresses · 40" tab → removed**; address list lives in the settings subpage.
- **Tabs (Transactions/Addresses/Sending) → collapse to Activity + Receive** two-tab set.
- **"Remove this wallet" → settings subpage, red Danger block, confirm-gated** (never in scroll flow).
- **"synced Ns ago" → removed** (Health owns sync).

**Stays prominent:** name, balance, Send/Receive, activity. Everything cryptographic is invisible
until asked for. The **Receive panel is kept verbatim** — the audit's best disclosure pattern
(QR + "A fresh address, every time." + Advanced expander) — and becomes the template other panels copy.

**A/B rationale — where the deep detail lives:**
- **A said:** two collapsed expanders (Details + Backup) on the page; xpub inside Backup.
- **B said:** one Details expander + a `/wallets/[id]/settings` subpage for rename/export/remove/addresses.
- **Call:** **B.** The subpage keeps the destructive remove-wallet action on its own gated URL and
  matches the 3-tier disclosure rule (§5) exactly. Both hide the xpub and kill the tag/tab — settled.

---

### 2.3 Send (`/wallets/[id]/send/+page.svelte`) — the Venmo flow *(implement first, with Home)*

The fiat-primary plain-language **review** step already shipped (`ReviewDisplay`, steps
`create → review → sign → confirm → sent`, one primary button per step). Build on it. The problem is
the **create** step crams four decisions onto one screen (`AmountEntry` hero + `RecipientCombobox` +
`FeeChoice`/`FeeEstimates` + `CoinControl` + a `HowItWorks` block that surfaces "PSBT"), and the
zero-balance guard is a bare unexplained "0" that reads as a dead end.

**Current problems** (audit §Send, top-10 #8): the create step stacks amount, recipient, fee picker,
coin control, and a PSBT explainer on one screen. `AtTipPill` shows "at tip ·" chain-sync jargon on a
money screen. Zero-balance renders a bare "0" — a silent wall.

**Decision — two inputs → review → done.**

**Screen 1 — create step, stripped to "how much, to whom":**
```
‹ Cancel                              Everyday Spending
                                                        ← 40px air
                 $  0.00                                ← amount hero, fiat-primary, autofocus
                 tap to switch to BTC                   ← --t-label toggle (was Amount/Max/BTC)

   To  [ address or saved name          ] [scan]        ← RecipientCombobox, unchanged
       ✓ Valid Bitcoin address                          ← existing inline validation, keep

                 ┌──────────────────────┐
                 │   Review payment  →  │                ← the ONE primary button
                 └──────────────────────┘

   Send everything  ›                                   ← quiet text link (replaces Max toggle)
   Advanced  ›                                          ← collapsed; contains CoinControl only
```
Two inputs, one button. `Advanced ›` is a single quiet collapsed line (holds `CoinControl` — one
predictable gesture away, never on the surface).

**Screen 2 — review (`ReviewDisplay`, shipped) — the fee arrives here as ONE line:**
```
   You're sending

        $45.00                                          ← --t-hero
        to bc1q…x7f  (Alice)

   ────────────────────────────────────
   Network fee      $0.42 · about 30 min             ›  ← single tappable line; expands FeeChoice
   They receive     $44.58
   ────────────────────────────────────

                 ┌──────────────────────┐
                 │   Slide to send      │                ← existing confirm CTA
                 └──────────────────────┘
```
Tapping the fee line expands the existing `FeeChoice`/`FeeEstimates` as three **plain-language speeds**:
**"Priority · ~10 min"**, **"Standard · ~30 min"**, **"Economy · a few hours"** — each with its fiat
cost beside it and the raw `sat/vB` demoted to muted micro-text inside a `<Term>`. Default **Standard**,
pre-selected; most users never open it.

**Zero-balance state** (replaces the bare "0"):
```
‹ Everyday Spending · Send

   This wallet is empty.
   Add bitcoin before you can send.

   ┌──────────────────────┐
   │   ↙  Receive bitcoin │                              ← the one primary for this state
   └──────────────────────┘
```

**Removed / hidden / renamed and where it goes:**
- **`FeeChoice`/`FeeEstimates` → off the create screen, onto the review card as one collapsed line.**
  Default Standard. This is the core Venmo move: don't ask about fees before the amount is confirmed.
- **`CoinControl` → off the default surface** into the create screen's collapsed `Advanced ›` expander
  (also still reachable from the consolidate deep-link). "Coin control" never appears as a phrase.
- **`HowItWorks` PSBT block → removed from create.** A single quiet "Why do I sign on my device? ›"
  link on the **sign** step. "PSBT" never appears unprompted; when hardware signing forces it, it is
  glossed via `<Term>` as "unsigned transaction (a proposal)".
- **"Max" toggle → text link "Send everything ›".**
- **`AtTipPill` / "at tip" chip → deleted from Send.** Chain-sync is a Health concern, not a per-send one.
- **Zero-balance bare "0" → real empty state + Receive CTA** (fixes top-10 #8).
- **Batch/multi-recipient → behind "Add another recipient ›"**, only after a first recipient exists.

**Stays prominent:** Screen 1 — amount (hero), To (second), one button. Screen 2 — amount+recipient
restated as hero, fee as one demoted line. The user makes exactly **two** decisions (amount, recipient)
before a review; fee is a default overridable in one tap. That is the Venmo shape.

**A/B rationale — fee and coin control placement:**
- **A said:** create = amount + recipient + button only; fee moves to the review as one line; coin
  control leaves the create flow entirely.
- **B said:** keep the create step mostly as-is (it already honors one-primary-action); fee stays on
  create as a plain-language speed picker; coin control stays as a collapsed expander on create.
- **Call:** **A's structure for the fee** (move it to review — it's the Venmo move the owner asked for,
  and the draft's fee is computed at review anyway, so it's a natural home), **plus B's honesty for coin
  control** (keep it reachable, one gesture down, via a collapsed `Advanced ›` on create rather than
  deleting/relocating it far away). Lower blast radius than A's full relocation, more Venmo than B's
  as-is create. Both agree on the zero-balance fix and killing the "at tip" chip — settled.

---

### 2.4 Receive (`/wallets/[id]/receive`, canonical subpage)

**Current problems:** effectively none — the audit names the existing Receive panel the app's **best
pattern** (§Wallet-detail #7). The only issue: it's buried inside a cluttered wallet-detail page.

**Decision** — formalize it as the canonical Receive surface that *both* Home's and wallet-detail's
Receive buttons route to (Tier-2 subpage; also embeddable as the wallet-detail Receive tab):
```
‹ Back                                    Receive
                                                     ← 40px air
        ┌───────────────────┐
        │      [ QR ]       │                         ← QR is the hero
        └───────────────────┘

        A fresh address, every time.                 ← keep this exact copy
        bc1q x8k2 … 9f4d                             ← grouped, readable, full on tap
        Give this to whoever is paying you.

        ┌──────────┐  ┌──────────┐
        │  Copy    │  │  Share   │                    ← Copy filled, Share outline
        └──────────┘  └──────────┘

   Advanced ›                                         ← Tier-1: rotate address, derivation path
```

**Removed / hidden / renamed:** the manual "Rotate" form → behind `Advanced ›` (rotation is
automatic); the Advanced expander is kept, collapsed, contents unchanged. Nothing on the surface is jargon.

**Stays prominent:** QR (hero), address, Copy (leads over Share), one explainer link. This is the
**reference implementation** of the disclosure rule — every other detail-bearing panel copies it.

**A/B rationale:** A wanted a focused sheet opened from any Send/Receive button; B wanted a
`/wallets/[id]/receive` subpage as the canonical surface. **Call: B's canonical subpage** (both Home
and wallet-detail route to it, so the pattern is identical everywhere) — functionally what A wanted,
with one honest URL. Both keep the panel verbatim — settled.

---

### 2.5 Explorer (`/explorer`, `/explorer/mempool`, `/explorer/block/[id]`, `/explorer/tx/[txid]`)

**Explorer stays — it is the sovereignty payoff** (a block explorer pointed at *your own node*, which
Muun/Phoenix can't offer) — **but it leaves the primary nav** (into the account menu, §2.7). The pages
stay allowed to be dense; the **jargon and metaphor get glossed, not deleted**, because a curious
first-week user *will* click it once.

**Current problems** (audit §Explorer, top-10 #3, #10): "The timechain" poetic subtitle with no gloss.
The **"ring"** metaphor for difficulty epochs, unexplained, repeated across Explorer/Mempool/Admin.
"not one removed" (dev-brain for no-reorgs). "vMB" raw. `sat/vB` on 15+ block rows unexplained. A footer
strip duplicating the top banner verbatim (top-10 #10). A node-unreachable banner rendered *next to*
full chain data (contradictory signal). The `heartwood/` set confirms the machinery: `BurialRings`,
`EpochDial`, `GroveField`, `RingStub`.

**Decision** — keep the soul, add the legend:
```
Search the blockchain
[ Paste a block, transaction, or address — your node will find it ]

The timechain  ⓘ                                      ← soul retained; ⓘ = one-time Term gloss
Block 672 · at the tip
Difficulty period · block 672 of 2,016  ⓘ             ← "ring" glossed once, kept as identity
─────────────────────────────────────────────
Latest blocks
  672   just now    ~1 sat/vB ⓘ (≈ next block)   1,204 tx
  671   10 min ago   2 sat/vB (≈ 10 min)         2,013 tx
  …
  Load older blocks ›

How does this work? ›                                 ← keep (good pattern)
```

**Removed / hidden / renamed and where it goes:**
- **Explorer nav entry → out of primary nav**, into the account menu ("Explore the blockchain").
- **Footer duplicate strip → deleted** (top-10 #10).
- **"The timechain" → kept as the page's soul + a one-time `<Term>` gloss** ("Bitcoin's block-by-block
  history") on first view.
- **"ring" → default label "difficulty period", `ring` kept as the glossed identity term** via `<Term>`
  + a one-time `HowItWorks` ("Why we call them rings ›"). The `BurialRings`/`EpochDial`/`GroveField`/
  `RingStub` components stay; their user-facing labels get glosses.
- **`sat/vB` → the Mempool page's proven pattern rolled out via a shared `FeeRate` component**: raw
  rate + plain time side by side ("~1 sat/vB · ≈ next block"). Highest-leverage jargon fix in the app
  (the audit's own conclusion — a three-screen win).
- **"vMB" → "mempool size · N MB waiting."** **"not one removed" → "every block still stands."**
- **Node-status contradiction → one honest status owned by Health.** Explorer stops rendering its own
  "node unreachable" banner; it reads the same signal Home's Health line reads. If truly unreachable:
  one line, once — "Showing your last saved snapshot" — no "your node is broken" beside a full block list.
- Block/tx detail (Tier-2 subpages) keep the **BlockContext visualization** (the epic headline) and
  adopt the same `FeeRate` + `Term` glossing.

**Stays prominent:** search (hero — why anyone opens this deliberately), latest-blocks list, two quiet
summary lines. Density is retained *by identity* (Sparrow's lesson: structure tames density), but every
unit is paired with a plain gloss.

**A/B rationale — the explorer's fate:**
- **A said:** cut the entire ring/epoch/timechain metaphor from user-facing copy; the components lose
  their labels.
- **B said:** the explorer is the core sovereignty payoff; keep it *and* keep the Heartwood metaphor,
  glossing it once — deleting the identity is "personality-by-subtraction."
- **Call: B keeps the metaphor (glossed-once); A's nav placement wins.** Per the directive, jargon dies
  via explain-once, and the self-hosted identity is exactly what must be preserved — so the ring stays,
  legible. But it's not a first-week task, so it leaves primary nav (A). Both agree on killing the footer
  dupe, "vMB", "not one removed", and rolling out the `sat/vB`+plain pattern — settled.

---

### 2.6 Admin → **Health** + Settings (grouped)

#### 2.6a Health (was "Node", `/admin`, `src/routes/(app)/admin/+page.svelte`)

**Current problems** (audit §Admin, top-10 #5, #7, #9): a 9-tab flat sub-nav; a data-wall grid mixing
one urgent item (never-backed-up config) with dev metrics (Uptime 5 min, raw `127.0.0.1:60401`) at equal
weight; the ring/laid jargon again; "Factory reset…" styled identically to routine links; the nav label
"Node" has no first-week meaning.

**Decision** — a calm status page, not a dashboard:
```
Health                                             ← renamed from "Node"

  ● All systems healthy                            ← ONE status headline, color-coded
    or:  ⚠ 1 thing needs your attention

  Node       Connected · at the tip                Details ›
  Backups    ⚠ 1 wallet not backed up   [ Back up now ]   ← promoted, amber, actionable
  Storage    70% full · 1.39 / 2.00 TB             Details ›
  Users      1 admin                               Manage ›
─────────────────────────────────────────────
  Instance settings ›   Logs ›   Registration: invite ›
  ─
  Factory reset…                                   ← bottom, muted, red, confirm-gated subpage
```

**Removed / hidden / renamed and where it goes:**
- **9-tab strip → collapses.** Overview becomes *Health* (Node/Backups/Storage/Users only). Feature
  flags / Announcements / Referrals / Notifications / Backup-schedule / Logs move behind "Instance
  settings ›" and contextual links — not a permanent tab row.
- **Never-backed-up item → promoted** to row two, amber dot, inline `[ Back up now ]` (fixes top-10 #5).
- **Uptime, raw `host:port`, backend internals → Node → Details expander** (advanced). Default Node row:
  "Connected · at the tip" in plain language.
- **Factory reset → bottom, muted red, confirm-gated subpage** (fixes top-10 #7).
- The layout's existing persistent backup banner (`ChainHealthBanner` / `unbackedWallets` in
  `+layout.svelte`) is **retained** but re-pointed at the same Health object with the same amber grammar.

**Stays prominent:** one status headline → four monitored duties (urgent one promoted) → rare admin
links → destructive at the bottom.

#### 2.6b The Health concept (B's signature move — adopted)

Health is a **single derived object surfaced at three altitudes**:
1. **Home:** one line — "Health · All good" (calm) / "Health · 1 needs attention" (amber).
2. **Banners:** the existing backup / chain-health banners, re-pointed at this object.
3. **Health page:** the full breakdown above.

It aggregates node reachability + chain-sync (`/api/chain-health`, `ChainHealthBanner`), backup state
(`unbackedWallets`, already in layout data), storage, and user/registration posture. **Nothing new to
compute** — the data already exists, scattered across three components and the admin grid. Health *unifies*
it so a duty is impossible to miss and impossible to over-shout. This is the honest-sovereign answer to
A's instinct to hide the backup warning: **surface it, but as one tidy line.**

#### 2.6c Settings (`/settings`, `src/routes/(app)/settings/+page.svelte`) — grouped

**Current problems** (audit §Settings, top-10 #2): 14 flat ungrouped rows at equal weight — the app's
clearest grouping candidate. Surfaces disabled/dev features ("Contacts · team features off", "API tokens")
as NOISE for a solo first-week user.

**Decision — five groups, in this order:**
```
Settings

ACCOUNT
   Display name · alex …                          Edit ›
   Email · alex@… (admin)

DISPLAY
   Units · BTC / sats                             ›
   Fiat · USD (shown)                             ›
   Theme · Heartwood (dark)                       ›

SECURITY
   Recovery phrase · set                          ›   ← ranked first here (loses funds if lost)
   Passkeys · 0 active                            ›
   Devices & sessions                             ›

ADVANCED  ⌄                                            ← collapsed by default
   API tokens
   Contacts (team features)                            ← only shown if team mode is on
   Download my data
   About this app

DANGER ZONE  ⌄                                         ← collapsed, red, one sentence + confirm
   Delete my account
```

**Removed / hidden / renamed and where it goes:**
- **14 flat rows → 5 named groups** (Account / Display / Security / Advanced / Danger) — fixes top-10 #2.
- **Units + Fiat + Theme → merged into a Display group** (they're the same class of decision).
- **API tokens → Advanced**; **Contacts → hidden unless team mode is on**.
- **Recovery phrase → Security, ranked first** (backup-adjacent).
- **Danger-zone 4-bullet caveat wall → one sentence + confirm dialog**.

**Stays prominent (Health + Settings):** the single most consequential item on each surface — **back up
your config** (Health) and **recovery phrase** (Settings) — sits above everything. Dev metrics and power
features collapse into Details/Advanced. Destructive actions are red, collapsed, confirm-gated.

**A/B rationale — the admin destination's name:**
- **A said:** rename "Node" → "Server" (maps to "the box this runs on").
- **B said:** rename "Node" → "Health" and make it an aggregated status object.
- **Call: B ("Health").** The directive makes backup/health-visibility non-negotiable, and B's Health
  object is the mechanism that surfaces it at three altitudes. "Server" is just a nicer label on the same
  data-wall; "Health" restructures it. Both agree on grouping Settings, red-gating destructive actions,
  hiding disabled features, and promoting the backup nudge — settled.

---

### 2.7 Navigation (`src/routes/(app)/+layout.svelte`, `heartwood/MobileTabRow.svelte`, `HWRail.svelte`)

**Current problems** (audit §Nav): **8 destinations, all equal weight**, no primary/secondary
distinction. **Duplicate nav landmarks** in the accessibility tree ("Home" ×3, "Wallets" ×2, "Explorer"
×2, "Activity" ×2) at every viewport — a real a11y bug. "Node" is an opaque label.

**Decision — 3 primary destinations, everything else in the account menu.** *(Rewrite this LAST — it
wraps every screen; every destination needs its new home to exist first.)*
```
Desktop rail / Mobile tab row:
   ⌂ Home        💳 Wallets        ⧗ Activity
```
**Account menu** (top-right avatar; keeps a bell badge on the avatar for unread notifications):
```
   alex.l.martinez
   ─────────────
   Explore the blockchain      (was Explorer nav)
   Health                      (was "Node"; admin only)
   Settings
   Notifications
   ─────────────
   Sign out
```

**Removed / hidden / renamed and where it goes:**
- **Explorer, Node→Health, Settings, Notifications → out of primary nav, into the account menu.**
- **"Node" → "Health"** everywhere (nav, page title, aggregated object).
- **Nav drops from 8 to 3.** The active item is the *only* accent-colored nav element.
- **Duplicate accessibility landmarks → collapse to one `<nav>`** rendered per breakpoint (fix the second
  "Sections" landmark: remove or `aria-hidden`). Notifications bell gets an accessible label.
- Desktop and mobile now show the **same three**.

**Stays prominent:** three peers, one active accent, Home leftmost/default. The avatar is the single
"everything else" escape hatch.

**A/B rationale — the three primaries:**
- **A said:** Home / Wallets / Activity; Explorer + Settings + Node into the avatar menu.
- **B said:** Home / Wallets / Explorer; Activity + Health + Settings into the avatar menu (Explorer is a
  deliberate identity primary).
- **Call: Home / Wallets / Activity** (A's set) **+ Health naming** (B). Per the directive, Explorer stays
  as a feature but leaves the primary nav — so the third primary is Activity (the "what happened" check,
  matching Muun's 3-icon norm). Both agree on 8→3, one active accent, and fixing the duplicate landmark —
  settled.

---

## 3. Global visual language

**Keep the Heartwood identity** (the ring mark, `HeartwoodMark`, the organic voice, dark default) and make
it legible. Reduce boxed "hero" cards; prefer hairline separators + quiet section labels.

**Type scale — 5 sizes, no more:**
| Token | px / weight | Used for |
|---|---|---|
| `--t-hero` | 56 / 600, tabular-nums | The balance. Exactly one per screen. |
| `--t-title` | 22 / 600 | Screen title / wallet name |
| `--t-body` | 15 / 400 | Everything readable |
| `--t-label` | 13 / 500, `--text-secondary` | Field labels, meta ("about 30 min") |
| `--t-micro` | 11 / 500, uppercase-tracked | Section eyebrows only ("RECENT", "TO") — sparingly |

Kill ad-hoc sizes. The balance is the only hero-sized element, ever.

**Spacing — an 8px rhythm, generous:** section gap **32px**; within-section gap **12px**; the balance gets
**48px above / 32px below** before the action buttons. Never stack two zero-value readouts.

**Color restraint — one accent, three greys, two semantics:**
- **One** accent (Heartwood green) — only on the primary button and the active nav item. Not on secondary
  links, labels, or charts.
- Text greyscale: `--text` / `--text-secondary` / `--text-muted`. That's the whole vocabulary.
- Semantics: **green** = confirmed/healthy, **amber** = a duty needs attention (backup missing, node
  unreachable). **Red is reserved exclusively for destructive confirmation** — nowhere else.
- Balance is `--text`, not accent-colored — found by *size*, not hue.
- **Monospace is a signal, not a default** — only for addresses/cryptographic strings, and only inside a
  Details/Advanced layer. A raw xpub never sits in a primary row again.
- **One primary button per screen, and it looks like it** — exactly one `btn-primary`; everything else
  `btn-secondary`/`btn-ghost`.
- Two themes, one soul: keep the dark default; the light theme preserves the ring identity, not a generic
  white wallet.

---

## 4. Jargon glossary (term → default replacement / explain-once treatment)

Rule: **the default label is plain; the real term survives one tap down** via `<Term tip="…">` (tooltip) or
a `Details`/`HowItWorks` layer. Rename the default, keep the mechanism honest and reachable. Pure-noise
strings with no consumer consequence are deleted outright.

| Current term (audit source) | Default surface label | Where the real term survives |
|---|---|---|
| **xpub** / raw fragment | *(removed from surface)* | Wallet → Details, "Wallet fingerprint & xpub", fully copyable |
| **Native SegWit** / p2wpkh | "Single-key" chip | Wallet → Details, `<Term>`: "Native SegWit (bech32)" |
| **PSBT** | *(nothing on surface)* | Sign step only, `<Term>`: "unsigned transaction (a proposal)" |
| **sat/vB** (fee rate) | plain speed + time ("about 30 min") + fiat | muted micro `<Term>` beside the speed; shared `FeeRate` component |
| **RBF / CPFP / "Speed Up"** | "Speed up this payment" (verb) | `HowItWorks` on the tx detail |
| **ring / epoch / laid / forming** | "difficulty period" | `<Term>` "ring" + one-time `HowItWorks` ("Why we call them rings ›") |
| **The timechain** | kept as the explorer's soul + one-time gloss | `<Term>`: "Bitcoin's block-by-block history" |
| **not one removed** (no reorgs) | "every block still stands" | `<Term>`: "no blocks have been reorganized out" |
| **vMB** | "mempool size · N MB waiting" | `<Term>`: "virtual megabytes of pending transactions" |
| **Node** (nav + page) | "Health" | page explains node status in plain lines |
| **Electrum · yours / 127.0.0.1:60401** | "Your node · connected" | Health → Node → Details (backend + host:port) |
| **Uptime: 5 minutes** | *(removed — dev metric)* | Health → Node → Details (advanced) only |
| **Watch-only / "Signs on your device"** | "Cairn holds only your public key; you approve on your device" | Wallet → Details (static line, not a fake button) |
| **UTXO / coin control** | *(hidden)*; "Choose which coins to spend" | Send create → `Advanced ›` expander / consolidate flow |
| **Addresses · 40** (tab) | *(removed as a tab)* | Wallet → settings subpage → "Addresses" |
| **Multisig** | "Shared wallet" | — |
| **Export config** | "Download backup file" | Wallet → settings subpage |
| **at tip / Node at tip** | *(removed from money screens)* | Health / Explorer only |
| **Doubled "0 sats", footer dupe** | *(deleted outright — pure noise)* | — |

---

## 5. Disclosure architecture — the 3-tier rule (B's spine, adopted)

The real problem isn't *too much information* — a sovereignty tool legitimately has a lot. It's that detail
is scattered with **no predictable rule** for where it lives, so everything ends up on the surface "just in
case." Fix the rule and the clutter collapses on its own.

**Three tiers. One decision question. Applied without exception.**

> When placing any piece of detail, ask: *"Does this belong to the object I'm looking at, and might I want
> it **while** looking at that object?"*
> - **Yes, and it's about this object →** **Tier 1: inline expander** on the same screen.
> - **No — it's a distinct task with its own flow →** **Tier 2: subpage** (own URL).
> - **It's instance config I set once and forget →** **Tier 3: Settings / Health.**

**Tier 1 — inline expander.** Object-scoped detail a curious user might want in context, collapsed by
default. **One component, one chevron, one label grammar.** Allowed labels, in priority order: **"Details"**
(neutral facts), **"Advanced"** (power controls), **"How does this work?"** (education). No other expander
verbs. Examples: send fee breakdown & coin control; receive rotation/derivation; wallet type/xpub/chart;
explorer "How does this work?".

**Tier 2 — subpage (own URL).** A distinct *task* or object identity: `/wallets/[id]/send`,
`/wallets/[id]/receive`, `/wallets/[id]/settings` (rename/export/addresses/**remove**),
`/explorer/block/[id]`, `/explorer/tx/[txid]`. Reachable by a clear affordance; back returns to the
parent's scroll position.

**Tier 3 — Settings / Health.** Instance config touched rarely: node connection, backups, storage, users,
registration, factory reset (Health); display unit, fiat, theme, notifications, passkeys, API tokens,
feature flags (Settings).

**Consistency mandate:** the same detail never appears in two tiers. Chain facts own **one** home
(Explorer / Health) and are *referenced* elsewhere by a single glossed line, never re-rendered as a data
block. (Today `sat/vB` and the "ring" line appear on four surfaces with no owner — that ends.)

---

## 6. Implementation phases

Sequenced per the owner's ask (**Home + Send first**) and B's staging logic (navigation rewrite **last**,
after every destination has its new home). Blast radius = how many files/screens a change can break.

### Phase 1 — Home + quick pure-deletion wins  *(bead: P1)*

**Scope:**
- Home (§2.1): zero-wallet State A; funded State B (balance / Send+Receive / Health line / conditional
  compact wallet list / conditional RECENT). Remove the chart + range picker, the duplicate "0 sats",
  the welcome-tour card, the "synced Ns ago" line, the fiat toggle (→ Settings). Inline eye toggle.
- Pure-deletion wins (both proposals; ship day one, near-zero risk): doubled "0 sats" on Home *and* wallet
  detail; Home empty-chart range picker; Explorer footer duplicate strip; always-visible xpub fragment on
  wallet detail (move to Details stub — full wallet-detail restructure is Phase 2).
- A minimal Health line on Home reading `unbackedWallets` + `/api/chain-health` (the full Health page is
  Phase 3; Phase 1 ships only the one calm line so Home's layout is settled for Phase 3 to plug into).

**Files touched:** `src/routes/(app)/+page.svelte` (primary); `wallets/[id]/+page.svelte` (delete doubled
balance + xpub-fragment removal only); `explorer/+page.svelte` (footer strip); a small `health` derivation
helper (server load or `$lib`); `+layout.svelte` (read Health signal for the Home line).

**Blast radius:** medium — Home is the front door and the boldest deletion; the deletion wins are tiny and
per-file. No route or data-model changes.

**Verification plan:** boot dev server (reuse `scripts/qa/seed-uxaudit.mjs` pattern, seed one funded + one
empty wallet); confirm via `read_page` + screenshots at 1280×800 and 375×812: (a) zero-wallet Home shows
one button; (b) single-wallet Home shows no list, balance+Send+Receive+Health; (c) multi-wallet Home shows
the compact list; (d) no chart, no doubled balance, no xpub fragment, no footer dupe; (e) Health line reads
amber when a wallet is unbacked. Existing Home/portfolio tests green.

### Phase 2 — Send (fee-line) + wallet detail  *(bead: P2)*

**Scope:**
- Send (§2.3): strip the create step to amount + recipient + one button + quiet "Send everything ›" and a
  collapsed `Advanced ›` holding `CoinControl`; move `FeeChoice`/`FeeEstimates` onto the review card as one
  expandable line with plain-language speeds; delete `AtTipPill` from Send; remove the create-step
  `HowItWorks`/PSBT block (add a quiet link on the sign step, `Term`-glossed); replace the zero-balance bare
  "0" with the empty-state + Receive CTA; "Max" → "Send everything ›".
- Receive (§2.4): formalize the canonical `/wallets/[id]/receive` subpage; route Home + wallet-detail
  Receive buttons to it.
- Wallet detail (§2.2): "Single-key" chip → Details; move xpub/type/signing-model/**chart** into a `Wallet
  details ›` expander; add the `/wallets/[id]/settings` subpage (rename / "Download backup file" / address
  list / red-gated remove); collapse tabs to Activity + Receive; drop "Addresses · 40" tab.

**Files touched:** `wallets/[id]/send/+page.svelte` (2846 lines — reorder within the `create`/`review` state
machine, **do not rewrite** or disturb build/sign/broadcast); `send/_components/CoinControl.svelte`,
`RecipientCombobox.svelte`; components `FeeChoice`, `FeeEstimates`, `ReviewDisplay`, `AtTipPill`,
`HowItWorks`, `Term`; `wallets/[id]/+page.svelte` (2429 lines); new `wallets/[id]/receive/+page.svelte` and
`wallets/[id]/settings/+page.svelte`.

**Blast radius:** medium-high — Send is the highest correctness-sensitivity surface. Guard with the existing
send tests; the fee already computes at review, so moving the picker there changes presentation, not the
draft. Remove-wallet moving behind a gate is a behavior change — test the destructive path.

**Verification plan:** with a funded wallet, drive create → review → sign → confirm → sent and confirm two
inputs before review, one fee line on review (expands to 3 speeds, default Standard), no "at tip" chip;
verify the zero-balance empty state on the empty wallet routes to Receive; verify xpub/type/chart only
appear under Details; verify remove-wallet is gated on its subpage. Screenshots desktop + mobile.

### Phase 3 — Settings + Admin→Health  *(bead: P2)*

**Scope:**
- Settings (§2.6c): five groups (Account / Display / Security / Advanced / Danger); merge Units+Fiat+Theme
  into Display; API tokens → Advanced; Contacts hidden unless team mode on; Recovery → Security top;
  Danger-zone caveat wall → one sentence + confirm.
- Admin → Health (§2.6a/b): rename Node→Health; status headline + four duties (Node/Backups/Storage/Users);
  promote the backup nudge (amber + `[ Back up now ]`); collapse the 9 tabs behind "Instance settings ›" +
  contextual links; Uptime/host:port → Node → Details; factory reset → bottom, red, confirm-gated subpage;
  re-point the layout backup/chain banners at the same Health object; render the full Health object that
  Phase 1's Home line already reads.

**Files touched:** `settings/+page.svelte` (presentational regroup, no logic change); `admin/+page.svelte` +
its sub-nav; the `health` derivation helper (extend Phase 1's); `+layout.svelte` (re-point banners);
`ChainHealthBanner.svelte`.

**Blast radius:** low-medium — Settings is pure regrouping; Admin is admin-only (lower user-facing risk),
but the factory-reset demotion is a safety improvement and the Health object is new shared derivation over
*existing* data (aggregation + layout, not new plumbing).

**Verification plan:** confirm Settings shows five groups, Contacts hidden in solo mode, API tokens under
Advanced; confirm Health shows the status headline, amber backup row with a working "Back up now", factory
reset gated; confirm the Home Health line, the layout banner, and the Health page agree (one truth, three
views). Admin/auth tests green; destructive-ops tests green.

### Phase 4 — Navigation rewrite  *(bead: P2, last)*

**Scope** (§2.7): reduce primary nav to Home / Wallets / Activity (same on desktop + mobile); move Explorer
("Explore the blockchain") / Health / Settings / Notifications into the account menu; rename Node→Health in
nav; one active accent; fix the duplicate `<nav>` landmark (remove/`aria-hidden` the second "Sections"
block); add an accessible label to the notifications bell; keep the bell's unread badge on the avatar.
Explorer de-jargon rollout (§2.5: shared `FeeRate`, `Term` glosses, node-status reconciliation, kill
"vMB"/"not one removed") rides here or as an independent parallel task — it depends on nothing.

**Files touched:** `src/routes/(app)/+layout.svelte`, `heartwood/MobileTabRow.svelte`, `HWRail.svelte`, the
account-menu markup; `explorer/+page.svelte`, `explorer/mempool/+page.svelte`, `explorer/block/[id]`,
`explorer/tx/[txid]`; a new shared `FeeRate` component.

**Blast radius:** highest — the layout wraps every screen and the landmark fix touches the app-wide a11y
tree. Do **last**, after every destination's new home exists (Health must exist before the Node→Health nav
rename; Receive/settings subpages must exist before nav points at them).

**Verification plan:** re-test all breakpoints (desktop rail, mobile tab row, mobile account menu); confirm
exactly one `<nav>` landmark in the accessibility tree (no more "Home ×3"); confirm 3 primaries with one
active accent; confirm Explorer/Health/Settings/Notifications reachable from the avatar; run a screen-reader
pass on the landmark fix. Explorer: confirm `FeeRate` renders raw+plain everywhere, one honest node-status
line, no footer dupe.

---

## Appendix — the settled calls (both proposals agreed; adopted without further debate)

Kill the doubled "0 sats"; kill the empty-chart range picker; move the always-visible xpub off the surface;
flatten nothing but *group* Settings; red-gate every destructive action (remove wallet, factory reset,
delete account); fix the duplicate nav landmark; build on the shipped `ReviewDisplay` send-review rather
than replacing it; keep the Receive panel verbatim as the disclosure model; roll the Mempool page's
`sat/vB`+plain-language pattern out everywhere via a shared `FeeRate` component.
