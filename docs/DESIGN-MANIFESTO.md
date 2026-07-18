# Heartwood — Design Manifesto

Canonical visual-identity doctrine for Heartwood (the Cairn codebase). This is the single source of
truth for color, type, layout, and interaction. Where a component or a screen disagrees with this
document, the component is wrong.

This manifesto synthesizes two research-backed drafts: **"The Instrument"** (craft/identity
discipline) and **"The Feeling"** (emotion/psychology). The rule of the synthesis: *A's identity
discipline is the skeleton; B's psychology-derived mechanisms are the muscles.* Concretely — the
color/type/density system is built for restraint and legibility (accent touches only what you can
act on; semantic colors carry meaning and nothing else), and the money-behavior rules
(sats-first, multi-horizon deltas, notification throttling, the friction ladder, the privacy
gesture, growth-only motion) are **MUST-level normative rules**, not flavor.

Research is cited in brief parentheticals throughout.

---

## 0. Preamble — relationship to the spec, and what this replaces

**Builds on `docs/UX-REDESIGN-SPEC.md` (epic cairn-gt05), does not refight it.** The spec's locked
*structure* is inherited verbatim: the 7 principles, one-primary-action / one-hero-number per screen,
the 3-tier disclosure architecture (`Details` / subpage / Settings-Health), the 8→3 nav collapse,
the jargon glossary and the `<Term>` mechanism, "keep the soul" (ring mark, organic voice, own-node
explorer). The phase ordering is inherited too: **Phase 4 (nav) goes last**, after every destination
Phases 1–3 create has a home. A visual pass must respect that ordering or it will restyle routes
about to be removed from primary nav.

**This manifesto explicitly supersedes the spec's *visual-style* items** in exactly these places,
and only these:

- The spec names the accent **"Heartwood green"** while also naming green as the health semantic — a
  genuine self-contradiction (audit §1). We resolve it decisively (§2): **green is meaning; a slate
  signal-blue is action.** This supersedes "Heartwood green" as the *accent* while honoring green as
  the *semantic* the spec also names.
- The spec's Home mock implies a **fiat-primary** balance. We supersede that: **sats/BTC-first is the
  default** (§3), fiat demoted to a muted secondary line. The spec's own "fiat primary *if enabled*"
  wording makes this a default-flip, not a structural change.
- The spec locks `--t-hero` at 56/600 for a static serif. We supersede the weight and family: **56px
  Fraunces at optical size, weight ~440** (§3) — /600 on a variable display serif reads too heavy for
  one calm numeral.

Everything else in the spec's §3 ("hairlines not boxes, pills not cards," red-only-for-destructive,
size-not-hue for the balance, monospace-only-for-addresses, one-primary-per-screen) is **adopted, not
superseded.**

**What this replaces:** the **v0.1.9 Heartwood copper identity** (epic cairn-koy4). That was already
a bespoke system — *not* generic Bitcoin-orange — of deep-wood charcoal, copper growth-rings, and
serif numerals. It is good work and most of it survives. What is retired is the specific pair that
still makes the app "squint crypto": the **warm-brown base** (`--bg: #100d0b`) and the
**copper-orange accent** (`--accent: #e8935a`, ~15° off Bitcoin-orange `#f7931a`). The story is not
"throw the copper out." It is *"the copper oxidized"* — fresh copper is an orange coin; weathered
copper is patina and cool ink, older and worth more. The warmth does not vanish; it migrates into the
serif numerals and the gold "attention" signal. Everything else — the rings, the dial vocabulary, the
organic voice, the own-node explorer — is recolored, not rebuilt.

---

## 1. Identity thesis

**Heartwood is a warm serif balance floating in evergreen ink.** The signature move — the thing that
makes a cropped screenshot unmistakable — is that **the money is set in a serif** (Fraunces),
large, in warm ivory, alone in a wide field of cool near-black, with growth and confirmation rendered
as **concentric rings** (`BurialRings` / `EpochDial`) rather than bars, percentages, or "3/6." No
other finance product sets a *live* balance in an editorial serif; no crypto app does it at all.
Around that number sits a **cool evergreen-ink canvas** — a luminance-stacked near-black with a faint
green-slate undertone, the way Linear stacks near-blacks and Mercury tints its neutrals — never warm
brown, never pure black, never navy. Exactly one restrained **slate signal-blue** touches only the
thing you can act on. **Green means growth.** Gold means *attend to this.* Red appears only when
something is about to be destroyed.

The gestalt is a precision instrument photographed at dusk in a forest — warm where it is human (the
serif, the gold), cool where it is exact (everything else) — the deliberate opposite of "orange coin
on a black terminal." And it must read as **neither generic crypto nor generic fintech**: not crypto,
because there is no orange, no neon, no circuit motif, no matrix-green-on-black; not generic fintech,
because the identity is not carried by the accent (which is a small, quiet control) but by the
**serif living balance + growth-rings on evergreen ink**, which no fintech has. Where Linear's tell
is near-black luminance stacking and Mercury's is indigo-tinted neutrals, **Heartwood's tell is the
serif living balance and the growth-rings.**

---

## 2. Color palette

Depth comes from **luminance steps of one near-constant hue**, not from shifting color or from glow
(Linear). Borders are **translucent white washes** so every surface stays tonally coherent regardless
of what sits under it (Linear's anti-muddy trick). Every neutral carries a faint tint — surfaces tint
**cool green-slate**, the primary type tints **warm ivory** — because a tinted neutral is the cheapest
"this was designed" signal (Stripe/Mercury). That cool-ground / warm-type split *is* the identity at
the token level.

All token **names** are preserved (components consume them as a public API); only **values** change.

### Surfaces — evergreen-ink luminance stack

| Token | Current | New | Rationale |
|---|---|---|---|
| `--bg` | `#100d0b` | `#0e1312` | Evergreen-ink near-black; faint green-slate undertone (R<G≈B). The single highest-leverage anti-crypto change. |
| `--bg-deep` | `#0a0807` | `#090d0c` | Deepest step (page gutter / behind cards). |
| `--bg-input` | `#17120f` | `#141b19` | Filled inputs; one luminance step up. |
| `--bg-strip` | `#14100c` | `#111716` | Explorer chain-strip fill. |
| `--surface` | `#17120f` | `#141b19` | Legacy card fill (kept until lanes retire it). |
| `--surface-elevated` | `#241c15` | `#1c2523` | Raised panel / hover fill / the rare bordered density-panel. |
| `--border` | `#3a2f27` | `rgba(255,255,255,0.11)` | White-alpha wash. Canvas hex-mirror `#2b3331`. |
| `--border-subtle` | `#2e2621` | `rgba(255,255,255,0.08)` | Panel edges. Canvas mirror `#232a28`. |
| `--hairline` | `#1d1712` | `rgba(255,255,255,0.05)` | The row separator — the "hairlines not boxes" grammar. Canvas mirror `#1a201e`. |
| `--border-control` | `#2a2320` | `rgba(255,255,255,0.09)` | Input/control borders. |
| `--border-ghost` | `#3a2f27` | `rgba(255,255,255,0.14)` | Ghost-button border. |

### Text — warm money, cool metadata

The synthesis executes the thesis literally: **warm where it is human, cool where it is exact.** The
balance and primary copy carry a faint warm ivory (warmth lives in the type — Mercury); secondary and
muted metadata go cool-neutral (exact, quiet — the failure mode we avoid is all-cool "trading-terminal
steel").

| Token | Current | New | Rationale |
|---|---|---|---|
| `--text` | `#ede4db` | `#ece7de` | Warm ivory, barely cooled. Primary copy **and the balance** (balance is text-colored, found by size not hue — spec §3). |
| `--text-hero` | `#f1e7dd` | `#f3efe6` | Balance highlight ivory — glows warm against the evergreen. The one bright thing. |
| `--text-rows` | `#e5dbd1` | `#e2ddd3` | Dense-row body (faint warmth). |
| `--text-secondary` | `#a99c90` | `#9ba6a1` | **Cool-neutral.** Labels, meta ("about 30 min"). |
| `--text-muted` | `#8b7f75` | `#6e7975` | **Cool.** Section eyebrows, tertiary. |
| `--text-faint` | `#5e554d` | `#49524e` | **Cool**, decorative/disabled only (fails AA by design). |
| `--eyebrow` | `#8f8379` | `#77827d` | Breadcrumb current segment (cool). |
| `--eyebrow-path` | `#6b6058` | `#59635f` | Breadcrumb path segments (cool). |

### The accent — the one contested decision, resolved

**Slate signal-blue is action; green is meaning. The accent is blue.**

The spec conflated two roles into one word ("Heartwood green" as both the sole accent *and* the health
semantic). A premium instrument needs an unambiguous color language, so the two roles are split:

- **Green (`--sage`) is the emotional/semantic color of growth and health** — confirmed, received,
  connected, the balance ticking up, the confirmation rings sealing. Growth *is* green; green must
  therefore stay meaningful, never be spent on button chrome. (Green = growth/safety — financial-psych
  research; and this directly protects the emotional thesis "watching net worth grow.")
- **The single interactive accent is a restrained slate signal-blue `#6796c9`** — a
  blueprint / instrument-dial blue, pulled greyer and less violet than Mercury-indigo or Stripe-violet
  so it reads as Heartwood's own, not a clone. It touches **only the one primary button and the active
  nav item** (spec §3) — never labels, body links, or charts.

**Why blue won, decisively:**
1. **Semantic cleanliness.** If green were both accent and semantic, a green button would sit beside
   green "confirmed" text beside a green growth-tick, and the eye could not tell "clickable" from
   "good." Blue-for-action + green-for-good is the cleanest possible mental model for someone who has
   never seen a Bitcoin app — which is the whole brief.
2. **It protects the emotional core.** The manifesto's most load-bearing feeling is *growth = green*.
   Spending green on chrome dilutes it exactly where it matters most. Blue-accent keeps growth-green
   pure.
3. **Distinctiveness lives elsewhere.** The identity is carried by the **serif balance + rings**, not
   the accent. So the accent's job is to be clean, not loud. A single quiet slate-blue control on an
   evergreen field with a warm serif and growth-rings does **not** read as "Chase app."

**Why the losers lost:**
- **Green-as-accent (Draft B):** dilutes the growth semantic, muddies the action/meaning grammar,
  carries Robinhood-green adjacency, and green-on-dark has its own "matrix terminal" crypto risk. Its
  one real advantage — executing the spec's literal "Heartwood green" naming — is void because that
  naming is self-contradictory (green can't be *both* the accent and the health semantic without
  collision). We supersede it.
- **Desaturated-orange / keeping copper:** retains the warm crypto tell that is the entire complaint.
- **A green-blue teal hybrid:** reads as "crypto teal," and being green-adjacent it re-muddies the
  action/meaning separation. Rejected.
- **"Every fintech is blue" is the accepted risk**, mitigated by (a) the accent being greyed toward
  the evergreen tint, not Mercury-indigo, and (b) the rings + serif doing the identity work so the
  blue never has to.

| Token | Current | New | Rationale |
|---|---|---|---|
| `--accent` | `#e8935a` | `#6796c9` | Slate signal-blue. Primary button + active nav only. |
| `--accent-hover` | `#efa06b` | `#7aa6d5` | Hover lift. |
| `--accent-pressed` | `#d9884f` | `#5a86ba` | Press. |
| `--accent-bright` | `#f4b486` | `#96bbe0` | Bright ring stroke / glints. |
| `--accent-glow` | `#f6c89a` | `#b6d2ea` | Ring "signal sheen" (cool, not warm glow). |
| `--accent-glow-strong` | `#fbe1c6` | `#d4e5f4` | Strong ring highlight. |
| `--accent-core` | `#ffe9ce` | `#eaf3fb` | Innermost ring core. |
| `--accent-dim` | `#7a5238` | `#3f5f80` | Dim ring tier. |
| `--accent-dim-2` | `#5e3f2c` | `#2f475f` | Dimmest ring tier. |
| `--accent-muted` | `rgba(232,147,90,.15)` | `rgba(103,150,201,.15)` | Tinted-panel fill / selection. |
| `--accent-border` | `rgba(…,.30)` | `rgba(103,150,201,.30)` | Accent-panel edge. |
| `--accent-border-strong` | `rgba(…,.45)` | `rgba(103,150,201,.45)` | Emphasized "next step" edge. |
| `--on-accent` | `#1a1210` | `#0b1016` | Dark ink on the light-blue pill (keeps the light-accent/dark-text contract; ~5:1 at button size). |
| `--on-accent-ghost` | `#e8c6a8` | `#bcd2ea` | Ghost-pill label, faint blue tint. |

### Semantics — one green, one gold, one red, one salmon

Because the accent is blue, the growth-green gets to be a single **clean vivid grove-green** instead of
a muddy olive-to-avoid-collision compromise. High-chroma is rationed to things that carry meaning
(financial-psych: chroma matters as much as hue; calm = low-chroma surfaces, saturation only where a
decision or a state lives).

| Token | Current | New | Rationale |
|---|---|---|---|
| `--sage` (growth / health / confirmed) | `#8aa06e` | `#83b892` | Clean grove-green, less olive. The single color of growth, health, confirmed, received, connected, sealed rings. ~90° from the blue accent — never confused with it. |
| `--sage-muted` | `rgba(138,160,110,.10)` | `rgba(131,184,146,.12)` | Success-chip fill. |
| `--attention` (needs attention) | `#d8b27a` | `#d9b47e` | Warm gold — inherits the retired copper's warmth. The one warm signal on a cool field (warm-on-cool pops). Backup missing, node unreachable, form validation — **never red** ("subtle amber, not red" for expected swings — financial-psych §4). |
| `--attention-muted` | `rgba(216,178,122,.10)` | `rgba(217,180,126,.10)` | Amber-chip fill. |
| `--error` (destructive only) | `#e0604c` | `#e0664f` | Red reserved **exclusively** for destructive confirmation and genuinely broken states (broadcast rejected, invalid PSBT, node down). Nowhere else (spec §3, locked). |
| `--caution` (quorum-risk salmon) | `#dd7a52` | `#d87a55` | Niche multisig quorum-risk tier between amber and red. Kept — but it is the last orange-adjacent hue; shift toward amber if any "orange" read survives QA. |

Aliases hold: `--success` = `--sage`, `--warning` = `--attention`, `--danger` = `--error`.

### Light-mode strategy — first-class, warm-not-stark, dark stays default

Dark is the default and the identity's home, but **dark-mode-only *as identity* is itself a crypto
tell** (explicit AVOID). Light mode is a **first-class peer, defined in tokens on day one**; the toggle
ships in Settings → Display (the spec's "Theme · Heartwood (dark)" row already implies it). Today only
Explorer has a light theme.

Light mode is **warm parchment, not stark white** (Betterment's warm light-gray, not a clinical bank
white) — the identity's warmth surfaces in the *ground* here, mirroring how dark mode surfaces it in
the *type*. Extend the existing "Daylight grove" machinery app-wide:

- ground `#f3efe7` (warm parchment) · deep step `#e9e3d7`
- ink `#1f2623` (umber-evergreen, never pure black) · secondary `#5c635e`
- accent `#3f6ea6` (slate-blue **darkened for AA on parchment**) · `--on-accent` `#f7f3ea`
- `--sage` `#3f7a56` · `--attention` `#9a6f28` · `--error` `#b6402f`

Same soul in both modes — the ring mark and the serif balance persist; neither theme is "the brand"
exclusively.

---

## 3. Typography

### Families

- **UI / body — `Inter`** (`@fontsource/inter`, weights 400/500/600/700, already bundled). The premium
  tell is discipline, not an exotic face (Linear and Raycast both use Inter and win on restraint).
  Unchanged. Token: `--font-ui: 'Inter', system-ui, -apple-system, sans-serif`.
- **Display / the balance — switch to `Fraunces` variable.** Add `@fontsource-variable/fraunces`; drop
  `@fontsource/source-serif-4`. Token: `--font-serif: 'Fraunces', 'Source Serif 4', Georgia, serif`
  (Source Serif 4 stays as the fallback so a cold load never breaks the numeral).
- **Mono — unchanged.** `--font-mono: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas,
  monospace`. Addresses and cryptographic strings only, only inside a Details/Advanced layer.

**The serif is the second contested decision, resolved: switch to Fraunces.** The reasoning is that
the serif balance is the *primary identity carrier* — and distinctiveness spends best where identity
is carried. Source Serif 4 (Draft A) is a fine, safe, already-bundled workhorse, but it is also
Adobe's default premium serif — low distinctiveness at the exact place the brand lives. Fraunces is a
high-contrast editorial serif on `@fontsource-variable` (one variable file, self-hosted, privacy-clean,
*leaner* than the three static Source Serif weights it replaces), whose optical-size axis lets the
56px hero be elegant and high-contrast in a way a static face cannot. It is the same editorial-serif
move Robinhood makes for its display numerals.

- **Why keeping Source Serif 4 (Draft A) lost:** its only advantages were zero switching cost and zero
  re-test — but the cost is bounded (the hero numeral plus a handful of canvas numerals), and A itself
  conceded the direction by proposing an optional later move to a variable face. Trading a bounded,
  one-time cost for permanent distinctiveness at the identity's focal point is the right call.
- **The quirk risk is real and mitigated:** Fraunces can read artisanal. Dial it to **low `SOFT`,
  `WONK` off, optical size tracked to render size** — that yields editorial gravitas (private-banking
  register), not craft-coffee quirk. Reserved **exclusively** for the balance and screen-defining hero
  numerals; never body, never labels.
- **Implementation gotcha:** canvas-drawn numerals (`BreathingCounter`, `WalletStepChart`) must guard
  their first draw on `document.fonts.ready` (or a Fraunces-specific `FontFace.load()`), or the first
  paint falls back to the serif fallback and reflows. Wire this in the same pass as the font swap.

### The 5-token type scale

The spec's 5 sizes are **not yet CSS tokens** — sizing is ad hoc per component (audit §2). Tokenize
them now. Sizes are the spec's; family, weight, and tracking are set here.

| Token | Size / weight | Family | Extras | Used for |
|---|---|---|---|---|
| `--t-hero` | 56px / **~440** (opsz matched to size) | **Fraunces** | `tabular-nums`, `-0.02em`, line-height 1.02 | The balance. Exactly one per screen. **Supersedes the spec's /600** (too heavy on a variable display serif). |
| `--t-title` | 22px / 600 | Inter | `-0.01em` | Screen title / wallet name. |
| `--t-body` | 15px / 400 | Inter | line-height 1.5 | Everything readable. |
| `--t-label` | 13px / 500 | Inter | color `--text-secondary` | Field labels, meta ("about 30 min"). |
| `--t-micro` | 11px / 500 | Inter | uppercase, `0.09em`, color `--text-muted` | Section eyebrows only ("RECENT", "TO"). Sparingly. |

Implement as size/weight/family token triplets or five utility classes (`.t-hero` … `.t-micro`).
Kill ad-hoc sizes. The balance is the only hero-sized element, ever.

### Money-typesetting rules (MUST)

1. **Tabular numerals on every amount** — `font-variant-numeric: tabular-nums` on balance, fees,
   amounts, tables. Digits align so a growing balance reads as steady accumulation, not jitter.
2. **One constant money weight.** Define `--weight-money: 460` for all Inter-set amounts (fiat lines,
   tx amounts, fee lines) — never flip 400↔700 between sizes. Money that never looks "boldened ad hoc"
   reads considered and trustworthy (the Stripe/Mercury variable-weight craft tell; reconciles A's
   ~440 and B's 480). The Fraunces hero sits at its own opsz-matched ~440.
3. **BTC / sats is the hero; fiat is a muted secondary line — by default. (MUST, supersedes the spec's
   implied fiat-first.)** This is the single most load-bearing rule in the manifesto. The BTC amount is
   monotonically non-decreasing for a saver, so a sats-hero turns every glance into a *growth* signal;
   a fiat-hero turns every glance into a coin-flip that can register a "loss" on pure price noise,
   paying the ~2× loss-aversion penalty (myopic loss aversion — Benartzi & Thaler). The Settings →
   Display fiat-primary toggle ships **off by default**. When a user opts into fiat-primary, the fiat
   figure takes the serif hero and BTC drops to the muted line — **never two hero-sized numbers.** Fiat
   renders in `--text-muted`, one `--t-label` line beneath the hero.
4. **Formatting.** Balance = Fraunces hero, `--text` (never accent-colored — found by size). Sats
   grouped with thin spaces (`4 020 000 sats`); BTC to sensible precision (`0.0402 BTC`). Fee/secondary
   amounts = Inter tabular, muted. **Monospace is never used for money** — mono is addresses only,
   inside Details.
5. **Direction color.** A received `+` uses `--sage` (growth). A normal outgoing send uses `--text` or
   `--text-muted` for its `−`, **never red** — an ordinary spend is intentional, not dangerous. Red is
   destructive-only.

---

## 4. Layout philosophy

**Calm by default; quarantine density.** The governing move is Linear's: keep the chrome sparse, and
push real data density *inside bordered panels*. A wallet legitimately has dense data — it just never
lives loose on a calm surface.

- **Calm surfaces (huge whitespace, one hero, hairlines, no bordered cards):** Home, Send
  create/review, Receive, wallet-detail top. One hero number, one primary action, air. SoFi's
  "sales-floor" stack of equal-weight tiles is the explicit anti-pattern.
- **Density panels (bounded "instrument glass"):** Explorer block lists, the balance/allocation
  charts, UTXO/coin-control tables, Health's duty breakdown, the wallet-detail Details expander.
  Density is *allowed* here and reads as "this tool is powerful," because it sits inside a clearly
  bounded panel against the calm field.

**Flat by default; hairlines, not boxes; borders, not shadows.**
- Primary surfaces use **hairline separators** (`--hairline` wash), not boxes. A bordered "case"
  (`--border` wash, `--radius-panel: 14px`, `--surface-elevated` fill) appears *only* around a genuine
  density cluster — it is the instrument's glass, not decoration.
- **Kill the crypto-neon glow.** Remove the warm accent-glow button shadow
  (`box-shadow: 0 4px 20px rgba(232,147,90,0.25)` on `.btn-primary`) — a colored outer bloom is a
  crypto tell and contradicts the identity's own "depth from the field, not glow" grammar. Replace with
  a **restrained neutral lift** on the single primary button only (`0 1px 2px rgba(0,0,0,0.4)`,
  optionally a 1px inset top highlight à la Raycast's native button). Every other surface is
  shadowless.

**Spacing rhythm (locked).** 8px rhythm: **32px** section gap, **12px** within-section, **48px above /
32px below** the balance before the action buttons. **Never stack two zero-value readouts** (the
doubled "0 sats" bug). Generous air is what makes one calm number instead of a dashboard.

**Empty states.** One plain sentence + at most one action; never a spinner-wall, never a caveat wall
(Apple's "one idea, one action, huge whitespace"). Constructive and forward-looking, never a dead
ledger (Mint's failure mode). Keep the shipped voice: "No transactions yet. Send some sats to a receive
address and they'll show up here." Zero-balance Send → "This wallet is ready. Receive your first
bitcoin ↙" with Receive as the one primary. Empty invites growth; it never reads as a wall.

---

## 5. Interaction patterns

### Motion — animate growth and process; never animate alarm (MUST)

This is the load-bearing motion rule for a savings instrument.

- **Animates (earned, calm):** the balance **counts up** on load / on sats arriving
  (`BreathingCounter`); confirmation depth as rings sealing inward (`BurialRings`) — the wealth-
  accreting payoff; the once-only ring sweep on a completed send; the balance chart drawing in; page
  entrance `fade-in-up`; the faint first-sync breathing aura (that screen only). Motion narrates
  *process* and celebrates *accretion* — arrival, growth, accumulation only.
- **Never animates:** the balance on a price tick; fiat price movement; losses; down-days; "at-risk"
  prices. **No red flash, no shake, no alarm motion, ever, on price.** Value that goes *down* changes
  quietly in `--text`, no transition drama. (Every extra evaluation of a fiat delta is a chance to
  register a loss; motion amplifies it — myopic loss aversion.)
- **Durations / easings.** Keep `--ease: cubic-bezier(0.25,0.1,0.25,1)` for UI micro-interactions at
  **130ms**; panels/expanders **200ms**. Add **`--ease-grow: cubic-bezier(0.16,1,0.3,1)`** (expo-out)
  for the balance count-up at **~900ms** — slow enough to feel *earned*, not a slot machine. Ring-sweep
  one-shot **~640ms**. Buttons: hover = subtle bg shift + the neutral 1px lift; press = `scale(0.97)`.
  Rows: hover = faint white-alpha wash (`rgba(255,255,255,0.018)`), **no transform**. All neutralized
  under `prefers-reduced-motion` (already global).

### Confirmation-friction ladder — friction ∝ stakes (MUST)

Uniform "Are you sure?" trains click-through and reads as fear; friction must scale by **impact ×
reversibility × frequency**, and **undo beats a warning dialog** (it invites exploration instead of
reinforcing dread).

| Stakes | Example actions | Treatment |
|---|---|---|
| Trivial, reversible, frequent | rename wallet, label a contact, categorize, edit a draft, the hide-balance toggle | **Zero friction + Undo toast.** No dialog. |
| Low, reversible | rotate receive address, cancel a draft | Single tap, no modal. |
| Medium, hard-to-reverse | remove-wallet-from-tracking, change display unit | Gated subpage + one plain "what this does / does not do" line ("your funds are safe if you keep your backup"). |
| High, **irreversible — real money** | broadcast a send | **"Slide to send"** physical gesture on a review that restates amount + recipient as the hero. This is where the pain-of-paying *should* be felt — the act must register as intentional. Confident, not scary. |
| Destructive-max | factory reset, delete account | Bottom of page, muted, collapsed, **red**, typed-confirmation subpage. Red is used *only* here. |

Error copy is specific and forward-looking, never a bare "failed" ("We paused this transfer to confirm
it's you…").

### Notification & delta-display rules (MUST)

- **Never push a notification on a fiat price drop. Ever.** Batch and throttle all value-change
  notifications; real-time price alerts are prohibited by design (each is a fresh loss-aversion hit on
  noise).
- **No naked point-deltas.** Any value-change display shows **1d / 30d / 1yr / all-time together**
  (Wealthfront/Betterment multi-horizon) so a red day can't dominate the emotional read. A lone
  "−$142 today" is forbidden; it must sit inside a horizon set where the longer, saver-positive frames
  are equally weighted. Lead growth stories with percent framing ("+8% this month"); keep absolute sats
  one layer down.
- **Attach a human rationale to notable events**, not a bare delta ("Your balance grew — you received
  0.002 BTC" beats "+$120"). Visible cause-and-effect = felt competence (self-efficacy).
- **Down is neutral, never red** — price wobble is not a decision.

### The balance-privacy gesture (MUST)

Privacy is an **active affordance the user reaches for**, not a passive "trust us" banner (active
controls read empowering; passive banners read defensive). An inline **eye toggle on the balance row**
masks to a calm `••••••` glyph (not a scary lock icon). Reveal is a deliberate gesture ("tap to
reveal," optionally biometric), framed as the user's calm choice each time ("Hide balance" / "your
numbers, when you want them"), never as "protect yourself from thieves." The privacy *is* the
empowerment; we do not editorialize about danger.

---

## 6. The Heartwood test (falsifiable)

Shown a cropped screenshot, or run against a fixture — ship only if all pass:

1. **The squint test.** Blur Home until type is illegible. If the dominant impression is "orange +
   dark," fail. Target: "evergreen calm, warm ivory numeral, one small blue control."
2. **The serif-balance test.** The balance is set in **Fraunces**, large, in warm `--text` ivory — not
   a sans, not accent-colored. A sans or an accent-colored balance is not Heartwood.
3. **The one-hero / one-button test.** No screen has two `--t-hero`-sized numbers and no screen has two
   `btn-primary` (Home's Send+Receive pair is the sanctioned exception). More than one filled button,
   or an orange one, fails.
4. **The color-count test.** Exactly one accent hue (slate-blue), used only on the primary button and
   active nav; three text greys; two non-destructive semantics (grove-green, gold). Red appears only on
   destructive-confirm and irrecoverable-failure surfaces. No `#f7931a` / `#f97316` / copper `#e8935a`
   anywhere. Growth and confirmation are **concentric rings**, not bars or "3/6."
5. **The red-day test.** Drop the fiat price 8% in a fixture. Nothing turns red, nothing flashes, no
   notification fires, and the hero BTC number does not move. Any alarm signal on a price move fails.
6. **The friction-proportionality test.** A trivial reversible action (rename) shows zero dialogs and
   an Undo; a broadcast shows the slide gesture. A low-stakes "Are you sure?" fails.
7. **The two-themes-one-soul test.** Toggle light mode: the ring mark and Fraunces balance persist, the
   parchment ground is warm (not stark white), and no surface reads as a generic white bank app.

---

## 7. AVOID

**Crypto clichés**
- **Orange / copper as any accent** (`#f7931a`, `#f97316`, the outgoing `#e8935a` in any role) — the
  exact "too Bitcoin" tell. The copper oxidizes to gold-attention + cool ink; it never returns as an
  action color.
- **Colored (crypto-neon) glow shadows** — no colored outer bloom on buttons or rings.
- **Circuit-board / mesh / neon-gradient / coin-and-rocket / "to the moon" motifs.**
- **Matrix-green-on-black terminal** — the reason green is a *semantic on an evergreen field*, never a
  saturated green field or a green button.
- **Blockchain jargon on the surface** (xpub, PSBT, sat/vB, UTXO, "at tip," "timechain") — glossed one
  tap down via `<Term>`, never in a primary row.

**Fintech / anxiety failure modes**
- **Naked point-deltas** ("−$142 today") with no horizon context.
- **Alarm-color misuse** — red or high-chroma on routine price movement. Red is destructive-confirm and
  irrecoverable-failure only.
- **Push notifications on price** — prohibited.
- **Sales-floor stacking** — a grid of equal-weight product/feature tiles competing on Home. One hero,
  one action.
- **Compliance / caveat walls** — 4-bullet warnings, footnote-stacking under every control. One plain
  sentence up top; detail one tap down.
- **Badge-wall security theater** — no wall of lock/shield badges. Privacy is an active control, not a
  reassurance banner.
- **Red for routine sends or form validation** — amber for validation, `--text` for a normal `−`.
- **Raw ledger with no forward story** (Mint's failure mode) — pair every number with plain-language
  meaning / "what changed and why."
- **Green-everywhere / money-green buttons** — green stays *meaningful*; that is why the accent is blue.
- **A fully-clinical cool palette** — keep the two warm anchors (the serif and the gold) so it reads
  premium-calm, not trading-terminal.

---

## 8. Implementation plan

Ship the palette as **one atomic value swap ahead of the remaining gt05 phases**, so those phases build
on the final colors and are not restyled twice. Tokens are foundational; a half-swapped palette reads
as a broken build. File a **fresh visual-identity epic** that supersedes the administratively-open
`cairn-koy4` and `cairn-6efi` parents, so history does not fork into three "redesign the look" epics.

### (1) Atomic `src/app.css` token swap + type-scale tokenization — one commit

Swap token **values**, keep every **name** (the public API components consume):
- Surfaces → evergreen-ink stack; text → warm-money / cool-metadata split; `--accent*` ramp →
  slate-blue; `--border*` / `--hairline` → white-alpha washes; `--sage` → clean grove-green; keep
  `--attention` gold, `--error` red, `--caution` salmon (retuned).
- **Fonts:** replace the `@fontsource/source-serif-4/*` imports with `@fontsource-variable/fraunces`;
  set `--font-serif: 'Fraunces', 'Source Serif 4', Georgia, serif`.
- **Add the missing type tokens** `--t-hero` … `--t-micro` (§3 values), `--weight-money: 460`, and
  `--ease-grow`. Set `--t-hero` family = Fraunces, opsz-matched, weight ~440, tracking `-0.02em`.
- **Remove the accent-glow `box-shadow`** on `.btn-primary`; replace with the neutral lift.
- Update the `color-scheme` comment.

### (2) Hand-sync list — edit in lockstep (drawing APIs can't read CSS vars)

These desync silently unless touched with step (1):
- **Canvas/SVG identity components** (recolor copper→slate/patina + grove-green; convert warm glow →
  cool signal-sheen): `heartwood/ChainStrip.svelte`, `PendingBand.svelte`, `FirstSyncGrowth.svelte`,
  `EpochDial.svelte`, `HWRail.svelte`, `HeartwoodMark.svelte`, `BurialRings.svelte`, `RingBar.svelte`,
  `RingStub.svelte`, `GroveField.svelte`, `QuorumArc.svelte`.
- **Inline-SVG fills (1–2 hex each):** `WalletStepChart`, `BalanceChart`, `AllocationBar`, `AtTipPill`,
  `TxFlowDiagram`, `ValueFlowBar`, `MobileTopBar`, `QrSigner`, `JadeQrSigner`.
- **`src/lib/server/channels/emailTemplate.ts`** — 9 hardcoded palette literals (has token-name
  comments); swap accent + surfaces to the new values.
- **`src/app.html`** — `<meta name="theme-color" content="#100D0B">` → `#0e1312`.
- **`src/routes/sync/+page.svelte`** — the one genuine off-token drift file (`#b39a88`, `#241c18`, the
  `#b5673a`→`var(--accent)` gradient, `#201a16`); re-derive from tokens while here.
- **Recommended once, here:** refactor the canvas/SVG components to read a shared JS token-mirror
  (`getComputedStyle` or an exported constants module) so the *next* re-palette is a one-file change.
- Guard canvas numeral first-draw on `document.fonts.ready` for the Fraunces swap (§3 gotcha).

### (3) Per-surface passes — ride the open gt05 phases, in gt05 order

Apply the **type-scale tokens, the Fraunces hero, the money rules, the friction ladder, the
multi-horizon deltas, the growth-count-up motion, and the balance-privacy gesture** on each surface as
it is (re)built. Do **not** restyle these against the old palette — the swap goes first.
- **Home** — already shipped Phase 1; it inherits the token swap for free. Retrofit the money rules
  (sats-first default, multi-horizon delta, privacy gesture) here.
- **Send + wallet detail** — gt05.2. Friction ladder (slide-to-send), one-hero, sats-first review.
  Touch **both** the single-sig and the `wallets/multisig/[id]` route trees.
- **Settings + Health** — gt05.3. Destructive-max friction (typed confirm, red-gated), the fiat-primary
  toggle (default off), the theme toggle.
- **Nav + Explorer de-jargon** — gt05.4, **last**. Nav inherits the palette; apply the "one active
  accent" rule to the active nav item only.

### (4) Light-mode rollout

Author the full app-wide light token set now under `:root[data-theme="light"]` +
`@media (prefers-color-scheme: light)` (warm parchment + AA-darkened slate-blue, §2). Ship the app-wide
*rollout* + the Settings toggle as the deferred larger effort the spec already anticipates.

### KEEP from the current identity (craft, not cliché — recolor, do not rebuild)

- **The ring / dial component family** — `HeartwoodMark`, `BurialRings`, `EpochDial`, `RingStub`,
  `RingBar`, `QuorumArc`, `ChainStrip`, `GroveField`. Genuine ownable craft and the true differentiator
  (spec principle 7). The reframe from "earthy/mystical wood" to "horological instrument" is a
  **recolor** (copper → cool sheen/patina + grove-green), not a rebuild. Do not genericize these away.
- The **serif living balance** (now Fraunces) — the signature.
- The **organic, plain-language voice** and the `<Term>` / `HowItWorks` / `Details` disclosure
  mechanism.
- The **own-node block explorer** — the sovereignty payoff.
- The **grammar** — hairlines-not-boxes, pills-not-cards, the pill radius scale, 8px rhythm, tabular
  money, mono-only-for-addresses, `prefers-reduced-motion`.

### CHANGE — the entire visual delta

Warm-brown base → evergreen ink. Copper-orange accent → slate signal-blue. Olive sage → clean
grove-green promoted to *the* growth color. Source Serif 4 → Fraunces (hero only). Warm accent-glow
shadow → cool restrained lift. Everything else is preserved and recolored.

---

## 9. Desktop widening rules

Companion doctrine to `docs/DESKTOP-LAYOUT-DESIGN.md` (the layout spec that widens the shell and
content lanes past the phone frame the app was originally designed in). These six rules are the
identity-level constraints that layout work must not violate; the layout document carries the
breakpoints, tokens, and per-page specs.

1. **The field widens, the hero stays singular.** Surplus width becomes margin and quiet secondary
   columns — never a second `--t-hero` number, never a second `.btn-primary`.
2. **Secondary columns whisper.** A quiet rail carries metadata in `--t-label` / `--t-micro` and cool
   tones; anything that starts competing with the hero belongs one tap down instead.
3. **Reading lanes cap; data lanes fill.** Two measures only — roughly 780px for reading, 1180px/1320px
   for data. Calm, single-decision, single-flow screens never exceed reading measure. Dense screens
   fill the data measure and stack rows; they never tile into cards.
4. **Asymmetry over symmetry.** Offset grids — hero plus rail, two-thirds plus one-third — read as
   editorial. A centered pair of equal-weight cards is the sales-floor tile in disguise, just with the
   count changed from many down to two.
5. **The rail grew; it did not become a dashboard.** The sidebar is the icon rail with its labels
   revealed and air added around it — nothing more. Active nav remains the single accent touch it
   always was; no nested widgets, no embedded search, no promotional content in the sidebar.
6. **Density stays in bordered glass.** Every dense cluster — tables, UTXO panels, metric grids — lives
   inside one instrument panel floating in whitespace. Density loose on a calm surface is the failure
   mode this whole document exists to prevent.
