# Heartwood Redesign — Implementation Plan

Scoping doc for the Cairn → Heartwood rebrand + v3 visual redesign
(`heartwood design 2/design_handoff_heartwood_v3/README.md`). Written
2026-07-06. Stack note up front: **Cairn is SvelteKit + Svelte 5, not
React.** The design handoff suggests "React... if none exists" — it does
exist, so every component below is a Svelte 5 (runes) component, not a
React port. Canvas pieces stay `<canvas>` + `requestAnimationFrame` as the
handoff specifies.

Beads: epic `cairn-koy4` with one child bead per track (see §9).

---

## 0. Key decisions this doc makes (flag if you disagree)

1. **Ship the rebrand and the reskin together**, not the rebrand first.
   A "Heartwood" wordmark over the old Forge visuals (or vice versa) reads
   as a broken build, not a rename in progress. See §2 for why this also
   affects env vars and the Umbrel listing.
2. **Mobile/desktop nav split is CSS-only**, not a JS breakpoint store.
   Render both `HWRail` (desktop) and the mobile top-bar+tabs in markup,
   toggle with `@media (max-width: 900px)` — this is what the current
   768px sidebar→horizontal-nav collapse already does, just with a
   different shape on each side. No new client-side breakpoint detection
   needed.
3. **The palette has no red.** The spec's semantic colors are `sage`
   (good/valid) and `attention` `#D8B27A` (amber — nudges, *and* send-form
   validation errors, explicitly "never red"). Cairn today uses `--error`
   `#e85a5a` for hard failures (broadcast rejected, invalid PSBT, API
   errors) in `.btn-danger` / `.form-error` / error toasts. The spec is
   silent on hard failures. **Open question for design sign-off** — my
   recommendation: keep a `text/error` red as an *unspecified extension*
   for irrecoverable failures only (never for routine validation, which
   stays amber per spec), rather than inventing a new brand color or
   forcing real errors into calm amber. Flagged as a bead, not decided
   here.
4. **First sync (`1a`) is new functionality, not a reskin.** Cairn has no
   IBD/sync-progress screen today — grepped for it, nothing exists. Shipping
   `1a` needs a small backend slice (sync %, height, peer count, ETA from
   the node/Electrum connection) in addition to the canvas frontend piece.

---

## 1. What changes — token → component → screen mapping

### 1a. Design tokens (reskin, foundational, blocks everything else)

Good news: Cairn's current token system (`src/app.css`) already uses the
same copper-on-charcoal language, so several tokens are a **direct hex
match or near-miss** — this is a real reskin, not a rebuild, at the token
layer:

| Current | Hex | Heartwood token | Hex | Delta |
|---|---|---|---|---|
| `--accent` | `#e8935a` | `copper` | `#E8935A` | **identical** |
| `--accent-hover` | `#f0a06a` | `copper/hover` | `#EFA06B` | near-identical |
| `--text` | `#f0ebe5` | `text/primary` | `#EDE4DB` | near-identical |
| `--text-secondary` | `#a89e94` | `text/secondary` | `#A99C90` | near-identical |
| `--text-faint` | `#5c5147` | `faint` | `#5E554D` | near-identical |
| `--on-accent` | `#201409` | `text/on-copper` | `#1A1210` | close |
| `--bg` | `#1a1614` | `bg/page` | `#100D0B` | darker — real change |
| `--border-subtle` | `#2e2925` | `border/input` | `#2E2621` | near-identical |
| — | — | `hairline` | `#1D1712` | **new** — much subtler than any current border; the "no cards, hairline rows" grammar (§4) is the biggest structural token change |
| `--success` | `#6bbf6b` (bright green) | `sage` | `#8AA06E` (muted olive) | real recolor |
| `--warning` | `#e8c95a` (yellow) | `attention` | `#D8B27A` (warm tan) | real recolor + scope change (also covers form errors) |
| `--error` | `#e85a5a` | *(none in spec)* | — | **gap — decision #3 above** |
| `--radius-card` `--radius-control` `--radius-chip` | 8/6/4px | pills 26 · toggles 14–15 · status pills 16–20 · icon buttons 10–11 · badges 4–5 · **rows: none** | — | full radius-scale replacement, more granular |
| `--font-serif` | Fraunces Variable | Source Serif 4 | — | **real font swap**, not a token tweak — different type family, different metrics. New `@fontsource/source-serif-4` dependency, self-hosted per spec ("self-host for offline nodes") |
| `--font-ui` | Inter | Inter | — | no change |

Action: rewrite `src/app.css` token block in place (same variable names
where the concept survives, e.g. keep `--bg`/`--accent`/`--text-*` as the
public API so component files don't all need `find/replace`), add the new
`hairline`, `border/ghost`, `border/control`, pill/toggle radius tokens,
and the `copper/*` glow/dim tiers the spec's components need (rings,
sweeps, dashes all reference 5–6 distinct copper opacities/tints, not
just one accent color).

### 1b. Component-by-component: reskin vs rebuild vs new

| Component | File | Verdict | Notes |
|---|---|---|---|
| Buttons (`.btn*`) | `app.css` | **Reskin** | pill shape, height 52/46-50, copper fill / ghost border swap |
| Badges/chips | `app.css` | **Reskin** | radius + color only |
| Table rows | `app.css` `.table` | **Reskin** | already hairline-separated (`border-bottom`), just recolor/resize — closest existing match to spec grammar |
| Forms/inputs | `app.css` `.input` etc. | **Reskin** | filled `#17120F`, copper focus ring + caret |
| Toasts | `Toasts.svelte` | **Reskin** | same queue mechanics, restyle to spec's sage-check pill |
| Skeleton shimmer | `app.css` `.skeleton` | **Reskin** | recolor only, animation already matches `hwShimmer` |
| `BalanceChart.svelte` | `lib/components/portfolio/` | **Reskin+enhance** | already hand-rolled SVG w/ Catmull-Rom + range toggle — add gradient fill, draw-in (`hwGrow`), pulsing end dot |
| `Sparkline.svelte` | `lib/components/portfolio/` | **Reskin** | reused as-is for mobile edge sparkline |
| `AllocationBar.svelte` | `lib/components/portfolio/` | **Reskin** | not in spec explicitly; keep, recolor |
| `DevicePicker`, `signing/*Signer.svelte` | `lib/components/`, `lib/components/signing/` | **Reskin** | device-comms logic (WebUSB/WebHID/QR/file) is unchanged; only the container/rows/pills change |
| `NotificationPanel`, `Banner`, `AnnouncementBanner` | `lib/components/` | **Reskin** | hairline + toast treatment |
| `Logo.svelte` | `lib/components/` | **Rebuild → `HeartwoodMark`** | current mark is 3 stacked stones; new mark is concentric eccentric rings (full/simple/min detail, 4 tones) — see `HeartwoodMark.dc.html`, straightforward SVG port |
| `ConfirmMeter.svelte` | `lib/components/` | **Rebuild → `BurialRings`** | segment-bar → SVG rings glyph + the "buried N rings deep / sealed / no rings yet" string generator. Different data shape (needs direction: sent vs received, for sage-vs-copper) |
| `TxStatusBadge.svelte` | `lib/components/` | **Partial rebuild** | pre-broadcast states (Draft/Awaiting/Broadcast/Replaced) keep a badge; post-broadcast confirmation depth moves entirely to `BurialRings` |
| `Stepper.svelte` | `lib/components/` | **Rebuild** | Sign page's quorum + key-row list replaces the numbered-circle stepper for that flow; `Stepper` may still suit send/wizard step indicators elsewhere — audit call sites before deleting |
| `KeyHealthRow.svelte` | `wallets/multisig/_components/` | **Rebuild** | spec's exact language: stale = copper dot + "6 mo since signed" amber |
| `ExplorerNav.svelte` | `lib/components/` | **Replaced** | desktop Explorer has no sub-tabs in the spec (mempool/difficulty/next-blocks need a routing decision — see §7 open question); mobile gets the generic text-tab row instead |
| `MiningRewards.svelte` | `lib/components/` | **Reskin** | folds into block-detail's inline serif stats |
| *(none today)* | — | **New — Modal** | grepped the repo: no shared modal component exists (multisig/new rolls its own). Spec needs one shared irreversible-action modal ("Once it takes a ring, there is no undo.") |

### 1c. New signature components (don't exist at all)

| Component | Used by | Complexity |
|---|---|---|
| `GroveField` | every page shell | **M** — CSS radial-gradient stack (or SVG layer per `7a`), 3 volume presets, desktop+mobile geometry, reduced-motion gating |
| `BurialRings` | replaces `ConfirmMeter`, used in Activity/Home/Wallet/Sent | **M** |
| `EpochDial` | rail, at-tip pill, Node page (72–96px), Explorer hero | **M** — 3 states (at-tip/syncing/behind), multiple sizes, sweep-once-per-block |
| `RingStub` | Explorer block rows, Activity block events | **S** |
| `ChainStrip` | Explorer (120px), Explorer locator variant (56–64px), Home(?) | **L** — real `<canvas>`+rAF, 475 vertical lines at real epoch-duration-scaled x, halving markers, sapwood zone, now-edge pulse. Highest-risk component, see §7 |
| `QuorumArc` | Sign page, multisig eyebrow | **S** |
| `HWRail` | desktop shell | **S** — mostly a port of `HWRail.dc.html` |
| Mobile top bar + text-tab row | mobile shell | **S** |
| `BackCircle` | mobile flow pages | **XS** |
| `EyebrowBreadcrumb` | almost every page | **XS** |
| `AtTipPill` | Home, rail, Explorer, Node | **XS** — composes `EpochDial` |
| Ring-sweep-once moment | Sent page | **S** — CSS animation, one-shot |
| First-sync wood-growth canvas | First-sync screen | **L** — new canvas component *and* new backend sync-progress data (see decision #4) |

### 1d. Screens: route coverage

Per the spec's own route-coverage table, mapped onto Cairn's actual routes
(from the codebase map):

| Pattern | Cairn route(s) | Screen(s) |
|---|---|---|
| Login/Signup/Recover/legal | `(auth)/login`, `signup`, `recover`, `/terms`, `/disclosure`, `/agreement` | `5i`/`8j` |
| First sync | *(new — no current route)* | `1a` |
| Home | `(app)/+page.svelte` | `7a`/`8a` |
| Send / review / sent | `wallets/[id]/send`, `wallets/multisig/[id]/send` | `5a`/`4a` (+`8b`/`8k`) |
| Sign / stateless signer | send flow's signing step, `wallets/multisig/stateless` | `5b`/`8c` |
| Receive | wallet detail's receive panel | `5c`/`8d` |
| Wallet list + wizards | `wallets`, `wallets/new`, `wallets/multisig/new` | `7a` rows + `5a`-style steps |
| Wallet detail | `wallets/[id]`, `wallets/multisig/[id]` | `5d`/`8e` |
| Explorer home/mempool/difficulty/tx/address/block | `explorer`, `explorer/mempool(+/blocks)`, `explorer/difficulty`, `explorer/tx/[txid]`, `explorer/address/[address]`, `explorer/block/[id]` | `5e`/`8f` |
| Activity | `activity` | `5f`/`8g` |
| Admin (10 subpages) | `admin`, `admin/activity`, `announcements`, `backup`, `feature-flags`, `invites`, `logs`, `notifications`, `referral-settings`, `settings`, `users(/[id])` | `5g` rows + `5f` feed pattern |
| Settings | `settings(+/contacts,/devices,/notifications,/tokens)`, `recovery-setup` | `5h`/`8i` |

Do **not** implement: superseded turn-3 explorations, `4b`, `1b`, `2b`,
`6a`–`6f` (the README explicitly marks these dead — `2b`/`6x` were
native-app-styled, this is a web app).

---

## 2. The rebrand — Cairn → Heartwood

This touches more than strings. Ordered by blast radius:

1. **In-app strings** (~60+ hits, mostly copy in signing components,
   auth tagline, dashboard empty-states) — mechanical, low risk.
2. **Branding surfaces**: `static/manifest.json` (`name`/`short_name`),
   `<title>`, favicon (`src/lib/assets/favicon.svg` — becomes the
   `min`-detail `HeartwoodMark`), `static/icons/icon-{192,512}.png`
   (regenerate from the new mark), `package.json` `name`/`description`.
3. **Backward-compat-breaking operational surfaces** — the part that
   isn't cosmetic:
   - `Dockerfile`: `CAIRN_DB=/data/cairn.db`, `CAIRN_LOG_FILE=/data/logs/cairn.log`,
     `cairn` UID/GID user. Existing self-hosted installs (Umbrel, Start9,
     manual Docker) have real data at those exact paths under those exact
     env var names. **Do not rename the env vars or the data path** in
     place — that silently orphans existing users' databases on upgrade.
     Recommended: keep `CAIRN_DB`/`CAIRN_LOG_FILE` as the actual env vars
     (internal, invisible to users) indefinitely, or add `HEARTWOOD_DB`
     as a new alias that falls back to `CAIRN_DB` if unset. Either way
     this needs an explicit upgrade-path test (same rule as every Umbrel
     package bump per the `umbrel-update-app` skill), not just a rename.
   - Docker image name / repo name (`github.com/AlexM223/cairn`) —
     GitHub repo renames auto-redirect, low risk on their own. The
     **Umbrel app store listing is the real constraint**: Umbrel app IDs
     are effectively permanent — renaming the app ID reads to the store
     as a *new app*, and existing installed users do not automatically
     migrate to a renamed listing. This is a product decision, not an
     engineering one (ship "Heartwood" as a fresh listing + deprecate
     the old "Cairn" listing with a pointer, vs. keep the Umbrel app ID
     as `cairn` forever while the product renames itself, vs. something
     Umbrel supports for renames that I haven't checked). **Flagging,
     not deciding** — needs your call before Docker/Umbrel work starts;
     filed as a bead, not blocking the visual work.
4. **Docs**: everything under `docs/` currently says Cairn; low priority,
   sweep last.

Order: strings + branding surfaces (1–2) land together with the visual
relaunch (decision #1). Operational/Umbrel decisions (3) are a
**prerequisite decision, not a prerequisite task** — they don't block
frontend work, only the final release cut.

---

## 3. The grove field

Zero extra DOM, as the spec requires. Implementation:

```svelte
<!-- GroveField.svelte -->
<script lang="ts">
  let { volume = 'present' }: { volume?: 'whisper' | 'present' | 'grove' } = $props();
</script>
<div class="grove grove-{volume}" aria-hidden="true"></div>
```

- One absolutely-positioned `div` (or inline `<svg>` per `7a` if you want
  2–3 pulsing motes — the spec says either is fine), `z-index: 0`,
  `pointer-events: none`, siblings get `z-index: 1`.
- Three volume classes set the layered `radial-gradient` stack directly
  (values are already final in the spec — §"The grove field" and the
  `7b` reference board in the source file). Desktop pith `-380px,-320px`
  ~8 rings; mobile pith `-160px,-140px` ~5 rings — **this is the one
  place besides nav that needs a real breakpoint**, since the ring radii
  are absolute pixel values, not proportional. Use a `@media (max-width:
  900px)` swap of the same CSS custom properties (`--grove-pith-x` etc.)
  rather than duplicating the whole gradient stack.
- Grove volume adds one more `radial-gradient` layer underneath (the warm
  wood wash) — same component, extra class-conditional layer.
- Dust-mote pulse (`hwPulse`, 4.4–6s staggered) only if using the SVG
  variant; respect `prefers-reduced-motion` via the existing
  `@media (prefers-reduced-motion: reduce)` block already in `app.css`
  (extend it — right now it forces all durations to 0.01ms, which is
  actually the *desired* behavior here too, so this may need zero new code).

### Route → volume assignment

| Volume | Routes |
|---|---|
| **Whisper** | Activity, Node/Admin pages, Settings (+subpages) |
| **Present** | Home, Send, Sign, Receive, Wallet detail, Explorer (+subpages) |
| **Grove** | Login, Signup, Recover, Sent (post-broadcast), First-sync |

One `<GroveField volume="…">` call per top-level `+layout.svelte` (or
per-page where volumes differ within a route group, e.g. `(app)` mixes
Whisper and Present) — cheapest to set it in each page rather than the
shared layout, since the layout can't know which volume a given page wants.

---

## 4. Ring vocabulary — rename/restyle vs build from scratch

| Concept | Existing | Verdict |
|---|---|---|
| Confirmations | `ConfirmMeter.svelte` (6-segment bar) | **Build from scratch** as `BurialRings` — different visual system (concentric arcs, not segments), different copy ("buried 3 rings deep" not "3/6") |
| Blocks (explorer rows) | plain rows, no glyph | **Build from scratch**, `RingStub` |
| Chain strip | doesn't exist | **Build from scratch**, `ChainStrip` (canvas) |
| Epoch/node status | doesn't exist as a component (admin page has raw text/badges for sync state) | **Build from scratch**, `EpochDial` |
| Quorum (multisig) | `KeyHealthRow` shows per-key status but no ring/arc | **Build from scratch**, `QuorumArc`; `KeyHealthRow` restyled alongside it |
| The mark/logo | `Logo.svelte` (3 stones) | **Rebuild**, direct port of `HeartwoodMark.dc.html` — this one's nearly copy-paste, the source file already has the exact SVG math (eccentric pith, alternating stroke weights, 3 detail levels, 4 tones) |

None of these are a rename-only job — the whole point of the ring
vocabulary is that it's functionally different data made visual (arc
count = confirmation depth, arc position = quorum share), so every one
needs new render logic, not just new CSS on an old element.

---

## 5. Responsive mobile web

Current state: one 768px breakpoint, sidebar collapses to a horizontal
scrolling icon+label strip, `sidebar-foot` (user chip, terms, operator
note) just disappears entirely on mobile — no replacement, no menu.

Heartwood's mobile model is a **bigger structural change** than the
current CSS collapse:

- Breakpoint moves to ~900px (from 768px).
- **Tab pages** (Home, Explorer, Wallets, Activity) get a top bar
  (rings mark + "Heartwood" + at-tip dial pill) *plus* a second-row
  text-tab strip (the active/inactive pill-toggle grammar) — two new
  elements, not a squeeze of the existing sidebar.
- **Flow pages** (Send, Sign, Receive, Wallet detail, Sent) get a
  32px back-circle + centered eyebrow instead — no tabs at all. This is
  a per-route-type decision the current single mobile nav doesn't make;
  routes need to be classified as "tab" or "flow" pages, and the
  `(app)/+layout.svelte` mobile logic needs to conditionally render one
  shell or the other based on route (a Svelte `$derived` off
  `page.url.pathname`, same pattern already used for `isActive()`).
- **Node & Settings move behind the avatar/menu** on mobile — today,
  Settings is inline in the collapsed nav strip, so this drops an item
  from the always-visible mobile row.
- Content gutter 20→18px, full-width pills, chain strip/charts run
  edge-to-edge — mostly CSS, once the shell restructure above is in place.
- No native chrome (no status bar / home-indicator padding / bottom tab
  bar) — Cairn already doesn't do this, no change needed.

Because the mobile shell is genuinely a second layout, not a media-query
squeeze of the desktop one, **build `HWRail` (desktop) and the mobile
top-bar+tab-row/back-circle shell as two separate components**, both
rendered in `(app)/+layout.svelte`, visibility toggled by the 900px
media query (decision #2). Don't try to make one responsive component do
both — the DOM shapes are too different (icon column vs. two horizontal
bars vs. single back-circle row).

---

## 6. Implementation order

Serial where a track blocks others; parallel lanes marked.

```
Phase 0 (serial, blocks everything)
  └─ Tokens + fonts (§1a) — rewrite app.css, add Source Serif 4

Phase 1 (parallel, 3 lanes — all depend only on Phase 0)
  ├─ Lane A: Signature component library (§1c) — GroveField, BurialRings,
  │          EpochDial, RingStub, QuorumArc, EyebrowBreadcrumb, AtTipPill
  ├─ Lane B: Desktop shell — HWRail + HeartwoodMark
  └─ Lane C: Mobile shell — top bar + text-tab row + BackCircle,
             route classification (tab vs flow)

Phase 2 (parallel by page-group, depends on Phase 1 A+B+C)
  Each lane owns one page-family, desktop+mobile together (spec pairs
  them 1:1 anyway — 5a/8b, 5d/8e, etc.) and wraps its own page in
  <GroveField volume="…">:
  ├─ Lane 1: Home (7a/8a)
  ├─ Lane 2: Send + Sign + Sent (5a/5b/4a + 8b/8c/8k)
  ├─ Lane 3: Receive + Wallet detail + wallet list/wizards (5c/5d + 8d/8e)
  ├─ Lane 4: Explorer — home/mempool/difficulty/tx/address/block (5e + 8f)
             (includes ChainStrip — see risk in §7, may need its own lane)
  ├─ Lane 5: Activity + Node/Admin ×10 (5f/5g + 8g/8h)
  ├─ Lane 6: Settings ×5 + recovery-setup (5h + 8i)
  └─ Lane 7: Login/Signup/Recover/legal (5i + 8j)

Phase 2.5 (independent lane, can run any time after Phase 0)
  └─ First sync (1a) — needs a small backend slice (sync %, height, ETA,
     peer count from the node/Electrum connection) before the frontend
     canvas piece is meaningful; pair backend+frontend in one lane.

Phase 3 (independent lane, any time after Phase 0, converges before ship)
  └─ Rebrand sweep (§2): strings, manifest, favicon/icons, package.json.
     Operational (env vars, Umbrel listing) is a decision, not a task —
     don't schedule it as work until §2's open question is answered.

Phase 4 (serial, after all of Phase 2 lands)
  └─ Cross-cutting QA: reduced-motion audit, prefers-color-scheme (n/a,
     dark-only), font self-hosting check (offline nodes — no CDN Google
     Fonts, unlike the design prototype which needs internet for viewing),
     Umbrel/Start9 smoke test, screenshot diff against the 8 canonical
     desktop + 11 canonical mobile screens.
```

Fable-session assignment: Phase 0 and Phase 1 are short, foundational,
better done by 1–2 sessions handing off serially (everything else is
blocked on them). Phase 2's 7 lanes + Phase 2.5 + Phase 3 are the actual
parallel-fleet opportunity — up to 9 sessions concurrently once Phase 1
merges, each touching a disjoint set of route folders + at most one
shared read-only import (the component library), so collision risk is
low. Phase 4 is one session, last, after everything merges.

---

## 7. Risk areas

Ranked hardest → easiest:

1. **`ChainStrip` (canvas chain strip).** Highest risk. Real requirements:
   - x-position ∝ *cumulative epoch duration*, not index — needs real
     retarget timestamps for all 475 (growing) difficulty epochs, not
     just block heights. The spec gives anchor points (25 epochs with
     dates) "±14% in-span noise" for the *prototype* — production needs
     the actual retarget timestamps from the node, likely a new
     server-side computation/cache (epoch boundary heights are
     deterministic — `N*2016` — but wall-clock timestamps require
     reading the block at each boundary).
   - Per-epoch alpha encodes a difficulty-change magnitude
     (`0.07+0.14·n(i)`, "+.26 for ~13% pop rings") — another derived
     value, not raw chain data.
   - Halving epochs (104/208/312/416, and now beyond) get distinct
     styling; sapwood zone (last 8 epochs) gets a gradient zone; now-edge
     needs a live pulsing DOM overlay synced to canvas coordinates.
   - Two more variants: full strip (Explorer, 120px) and locator variant
     (56–64px, single block highlighted) — that's 2 canvas components or
     1 with a mode prop.
   - Recommend: prototype the epoch-duration data pipeline *before*
     committing to the canvas drawing code, since a wrong data shape
     forces a redraw-logic rewrite. Consider its own Phase 2 lane rather
     than bundling into Explorer.

2. **First-sync wood-growth canvas + backend.** Second-highest — not just
   new UI but new backend surface (decision #4). Node/Electrum connection
   sync state needs to expose %, height, peer count, ETA; "Verifying 2017
   — SegWit summer"-style year notes need a small lookup table (year →
   note) keyed off the epoch being verified. Emotionally important screen
   (spec calls it "Grove by nature") but only seen once per install, so
   it's high-effort/low-frequency — fine to sequence later (Phase 2.5)
   without blocking the rest.

3. **Grove field performance.** Probably fine — it's static gradients/SVG,
   no rAF loop for the CSS variant, and even the SVG dust-mote pulse is
   ≤4 elements animating via CSS. Real risk is layering it under content
   on *every* page without a perf regression — verify with a quick
   Lighthouse/paint-timing check on Activity (Whisper, "dense pages",
   likely the most row-heavy page) rather than assuming it's free.

4. **Ring animations (sweep-once, epoch dial sweep-per-block).** Low
   engineering risk, needs care: "sweep once per new block" implies a
   client-side trigger tied to the existing new-block SSE/WebSocket event
   (already exists per the codebase map — "optimistic height update on
   SSE new-block event"), not a timer. Reuse that event, don't add polling.

5. **Mobile shell restructure (§5).** Mechanical but touches the one
   shared file every page depends on (`(app)/+layout.svelte`) — do this
   once, early (Phase 1C), so no Phase 2 lane is fighting over it.

6. **The red/error gap (decision #3).** Not hard to build either way —
   the risk is purely in *not deciding* before Phase 2 lanes start
   independently improvising an answer, producing 7 inconsistent
   treatments of failed states across 7 sessions.

---

## 8. Open questions needing your decision (not blocking, but should be answered before the affected lane starts)

- **Explorer sub-pages** (`mempool`, `mempool/blocks`, `difficulty`):
  the spec's desktop Explorer (`5e`) shows no sub-tabs — home page has
  chain strip + latest rings + a "Mempool →" link. Does difficulty get
  folded into the Explorer home hero line (spec already shows
  "difficulty +2.1% in ≈ 9 days" inline) and retired as a separate route,
  or kept as a deep-link-only page with no nav entry? Affects Lane 4 scope.
- **Error/danger color** (decision #3 above).
- **Umbrel app-store identity** (§2.3) — new listing vs. same app ID
  vs. some Umbrel-supported rename path. Needs research into what Umbrel
  actually supports before Phase 3's operational half is scheduled.
- **`Stepper.svelte` fate** — audit remaining call sites once Sign page's
  quorum/key-rows replace it there; may still be the right shape for
  wallet-creation wizards (which aren't in the canonical screen set at all
  — the spec says "Wallet list/wizards → `7a` rows + `5a` steps",
  implying wizards reuse Send's step pattern, not `Stepper` as-is).

---

## 9. Beads filed

Epic `cairn-koy4` — "Heartwood redesign + rebrand" — with dependency
edges matching §6's ordering (Phase 2 lanes all block on foundation +
shell; QA blocks on every page lane):

- `cairn-koy4.1` — Foundation: design tokens, fonts, base CSS rewrite
- `cairn-koy4.2` — Signature component library (GroveField, BurialRings,
  EpochDial, RingStub, ChainStrip, QuorumArc, HeartwoodMark, misc small)
  — depends on `.1`
- `cairn-koy4.3` — Desktop + mobile shell (HWRail, mobile top-bar/tabs,
  route tab/flow classification) — depends on `.1`
- `cairn-koy4.4` — Page reskin: Home (7a/8a) — depends on `.2`, `.3`
- `cairn-koy4.5` — Page reskin: Send + Sign + Sent (5a/5b/4a, 8b/8c/8k)
  — depends on `.2`, `.3`
- `cairn-koy4.6` — Page reskin: Receive + Wallet detail + wallet
  list/wizards (5c/5d, 8d/8e) — depends on `.2`, `.3`
- `cairn-koy4.7` — Page reskin: Explorer incl. ChainStrip (5e, 8f)
  — depends on `.2`, `.3`
- `cairn-koy4.8` — Page reskin: Activity + Node/Admin (5f/5g, 8g/8h)
  — depends on `.2`, `.3`
- `cairn-koy4.9` — Page reskin: Settings (5h, 8i) — depends on `.2`, `.3`
- `cairn-koy4.10` — Page reskin: Login/Signup/Recover/legal (5i, 8j)
  — depends on `.2`, `.3`
- `cairn-koy4.11` — First sync (backend sync-progress + frontend canvas),
  independent lane
- `cairn-koy4.12` — Rebrand sweep (strings/manifest/icons/package.json)
  — depends on `.1`
- `cairn-koy4.13` — Umbrel/operational rebrand decision (env vars, app
  store identity) — blocked on Alex's decision, not scheduled as work yet
- `cairn-koy4.14` — Cross-cutting QA pass (Phase 4) — depends on `.4`
  through `.11`
