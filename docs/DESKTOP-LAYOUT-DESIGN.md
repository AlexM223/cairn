# Heartwood — Desktop Layout Design

Canonical spec for widening Heartwood beyond the phone frame it was designed in. Today the app is a
mobile layout stretched onto a desktop viewport: a single narrow column (`main.main { max-width:
940px }`, with several pages capping even tighter) floating in a sea of unused whitespace, navigated
through a bottom tab bar that persists past the point where a real sidebar would serve better. This
document is the single source of truth for how the shell, the content measures, and every route adapt
across breakpoints. Where a component or a page disagrees with this document, the component is wrong.

Companion to `docs/DESIGN-MANIFESTO.md` (color/type/motion doctrine — untouched by this document) and
`docs/UX-REDESIGN-SPEC.md` (information architecture — this document supersedes its nav-collapse item
only, see §1).

---

## 0. Governing idea

**The mobile experience is sacred; the desktop experience is new.** Nothing below 900px changes in any
way — same top bar, same tab pills, same everything, byte-identical. Above that line, Heartwood stops
pretending to be a phone: the nav becomes a real sidebar, the content stops capping at a phone-plus-
margins width, and pages that carry real data (explorer, tables, tx history) are allowed to use the
room they're given. Pages that carry a single decision or a single number (Home, Send, a form) are
**not** allowed to use the room they're given — they keep a comfortable reading width and let the
surplus become margin. Width is not free real estate to fill; it is a resource to spend deliberately,
per page, according to what that page is for.

---

## 1. Shell tiers

Three tiers, two breakpoints. The breakpoints are exclusive (`max-width: 900px` / `min-width: 901px` /
`min-width: 1160px` / `min-width: 1600px`) so no viewport width satisfies two rules at once.

| Tier | Range | Shell | Notes |
|---|---|---|---|
| Mobile | `< 900px` | Top bar + tab pills | Untouched. Byte-identical to today. Hard QA requirement — this is not a target for revision, it is a frozen baseline. |
| Laptop | `900–1159px` | Compact icon rail (today's `HWRail`, 88–92px) | Icons + tiny labels, unchanged markup. This tier already exists and already looks right; it is not being touched. |
| Desktop | `≥ 1160px` | Full labeled sidebar `HWSidebar`, 236px (248px at `≥1600px`) | New. Sticky, full height, hairline right border. Detailed below. |

### 1.1 `HWSidebar` anatomy (desktop, `≥1160px`)

Top to bottom:

1. **Mark + wordmark** — the Heartwood mark and name, same as today's top bar treatment, pinned at the
   sidebar's top.
2. **Nav rows** — one row per nav destination, 40px tall, laid out as a 19px icon + a `--t-body` label,
   left-aligned (not centered like the compact rail's icon-over-label stack).
   - **Active state** is the single sanctioned accent, applied three ways at once: an `--accent-muted`
     pill fill behind the row, `--accent-bright` on both the icon and the label, and a 2px accent
     marker on the row's left edge. This is deliberately the *only* place on desktop that spends the
     accent on more than "the one primary button" — nav is a navigation control, not chrome.
   - **Hover state** (inactive rows only) is quiet: `--text-secondary` on the label/icon plus a faint
     background wash. No accent on hover — accent is reserved for "where you are," not "where your
     mouse is."
3. **Bottom cluster** — pushed to the sidebar's floor via `margin-top: auto`, so it stays anchored
   regardless of how many nav rows sit above it:
   - **Epoch dial**, inline with a one-line sync status readout ("Synced · block 861,204").
   - **Notifications row** — bell icon + label + an unread-count badge. Opens the existing
     `NotificationPanel`, but as a **right-anchored popover** rather than whatever surface it opens
     from today's top bar.
   - **Account row** — avatar + `displayName` + a trailing chevron. Opens the existing account menu,
     also as a popover, anchored to this row.

### 1.2 Collapse behavior

The sidebar is **user-collapsible**: a chevron toggle at the sidebar's foot collapses it from the full
236px labeled sidebar down to the compact icon-only rail (visually converging with the laptop tier's
markup). State persists to `localStorage('hw.sidebar.collapsed')`.

This read must be **SSR-safe**. Do not read `localStorage` during Svelte's synchronous effect phase
before hydration completes — gate the read on a `hydrated` flag and apply it in `onMount`, not in a
top-level `$effect` that could run before mount. (This project has an established hazard here: user
`$effect`s run in source order, and a persistence effect that fires before `onMount` can clobber a
just-loaded saved value. See the "Svelte 5 effect/onMount ordering hazard" pattern — same shape
applies to reading the collapsed flag as to writing it.) The practical rule: render the *expanded*
sidebar markup on first paint, then apply the collapsed class only after the hydrated flag flips true
and the stored value has been read — this trades a theoretically-possible one-frame flash for
guaranteed correctness, and in practice the read happens before first paint on any real browser. No
hydration flash is acceptable; if the naive approach produces one, gate harder rather than ship it.

### 1.3 Nav-conflict note

`docs/UX-REDESIGN-SPEC.md` §2.7 calls for collapsing primary nav down to 3 destinations. **That item is
superseded by Alex's full-sidebar directive.** The desktop sidebar shows every flag-gated destination,
not a curated 3. The spec's other locked structure (one-primary-action per screen, the 3-tier
disclosure architecture, the jargon glossary, "keep the soul") is unaffected and still governs.

---

## 2. Content measures

This section replaces **all** existing width caps. That includes the global cap and every per-page cap
layered on top of it:

| Cap being removed | Where | Current value |
|---|---|---|
| Global content cap | `main.main` | `max-width: 940px` |
| Admin | admin pages | `760px` |
| Activity | activity page | `760px` |
| Settings | settings pages | `660px` |
| Mining | mining pages | `640px` |
| Wallet inner | wallet-detail inner column | `640px` |
| Send | send flow | `680px` |

**All of these must be deleted, not layered under the new system.** A leftover per-page cap sitting
inside a new, wider lane silently re-creates the exact skinny-strip-in-a-void problem this document
exists to fix — the page will look fixed in a screenshot of the outer chrome and still fail visual QA
once someone looks at the actual content column. Every page in §5 must be checked for a stale cap when
its wave lands.

### 2.1 The two measures

Only two content widths exist anywhere in the app. There is no third "medium" measure and no per-page
bespoke number.

| Token | Value | `≥1600px` | Used for |
|---|---|---|---|
| `--measure-reading` | `780px` | *(no change)* | Calm, single-decision, single-hero pages: Home, Send, Receive, Settings, admin config forms, mining onboarding, wizards. |
| `--measure-data` | `1180px` | `1320px` | Dense, multi-row, tabular pages: Explorer, block/tx/address detail, mempool, activity, admin tables, wallet-detail tx list, mining dashboard. |

`--measure-reading` is a **hard cap at every tier** — it never widens at `1600px`. A reading page
having more room to breathe is a wash of margin, not a wider paragraph; reading measure exists
specifically so growing the viewport doesn't grow the line length past what's comfortable.
`--measure-data` is the one measure allowed to widen further at the largest tier, because a data table
genuinely benefits from an extra column's worth of room on a 1600px+ display.

### 2.2 Utilities and tokens (`app.css`)

New utility classes:

| Utility | Behavior |
|---|---|
| `.lane-reading` | `max-width: var(--measure-reading)`, centered. |
| `.lane-data` | `max-width: var(--measure-data)`, centered. |
| `.page-grid` | Asymmetric `grid-template-columns: minmax(0, 1fr) var(--rail-w)`; collapses to a single column below `1160px`. |
| `.quiet-rail` | The secondary-column treatment used inside `.page-grid` — metadata typography, cool tones (see §3). |
| `.full-bleed` | Explicitly opts a section out of both measures (e.g. `ChainStrip`, fee-band viz) — for the handful of elements that are supposed to run edge-to-edge inside an otherwise measured page. |

New tokens:

| Token | Value | Purpose |
|---|---|---|
| `--sidebar-w` | `236px` | `HWSidebar` width, `901–1599px`. |
| `--sidebar-w-wide` | `248px` | `HWSidebar` width, `≥1600px`. |
| `--rail-w` | `280px` | Width of the quiet secondary column in `.page-grid`. |
| `--lane-gutter` | `56px` | Gap between the primary column and the quiet rail, and general lane-to-chrome breathing room. |

### 2.3 Media query convention

Mobile stays the authority it already is: `@media (max-width: 900px)`. Nothing above that line is
allowed to touch it. The two new tiers are addressed **exclusively** via:

- `@media (min-width: 901px)` — laptop tier and up.
- `@media (min-width: 1160px)` — desktop tier and up.
- `@media (min-width: 1600px)` — wide-desktop tier.

Using exclusive min-widths (901, not 900) is deliberate: it guarantees no viewport width satisfies two
breakpoint rules simultaneously, which is a named regression risk (see §7) if it drifts.

---

## 3. Recurring patterns

Two shapes cover almost every page in the app. New pages should default to one of these two rather
than invent a third.

### 3.1 Reading pages

An asymmetric layout: a hero column carrying the page's one decision or one number, plus a 280px quiet
rail carrying supporting metadata. The rail is explicitly *not* a second content column — it never gets
a second hero, never gets a `btn-primary`, and its typography stays in `--t-label` / `--t-micro` with
cool tones (per the manifesto's warm-money / cool-metadata split). If a rail element starts competing
visually with the hero, it has drifted out of "quiet rail" and belongs a tap down instead (Details /
subpage), not louder in the rail.

### 3.2 Data pages

Hairline lists that gain columns as width increases — **never** tile grids. The manifesto's
"sales-floor" ban (a grid of equal-weight cards competing for attention) holds exactly as hard on
desktop as it did on mobile; more width is not license to switch a list to a card grid. Dense clusters
(UTXO panels, health duty breakdowns, admin metrics) live inside bordered "instrument panels" floating
in generous whitespace — the same calm-surface / density-panel split the manifesto already establishes
for mobile, just with more air around the panels on desktop.

### 3.3 The constant

**One hero, one action, on every screen, at every tier.** This is inherited unchanged from the
manifesto and the redesign spec. Nothing in this document licenses a second hero number or a second
primary button anywhere. Widening the viewport widens the margin and the rail, not the hero.

---

## 4. Per-page specs

### Home
- **Lane:** reading.
- **Hero column:** `BurialRings` + the Fraunces balance + the Send/Receive button pair (the one
  sanctioned two-primary-button exception) + recent activity.
- **Quiet rail:** multi-horizon deltas (1d / 30d / 1yr / all), epoch/sync status, wallets-at-a-glance,
  the backup nudge.

### Wallet list
- **Lane:** data.
- **Layout:** a single hairline list gaining columns at width — name + type, balance (sats-first),
  m-of-n, last activity, sync ring.
- **Action:** one "Add wallet" primary.

### Wallet detail — single-sig
- **Top:** reading — balance hero + Send primary.
- **Rail:** quiet — type, addresses, backup status.
- **Below the fold:** full-width transaction list at data measure, with columns (date, counterparty,
  amount, fee, confirmations).

### Wallet detail — multisig
- Same split as single-sig, with the rail leading with a smaller `QuorumArc` plus the cosigner roster.
- When a PSBT is pending, a full-width pending-PSBT band renders **above** the reading/data split,
  spanning the page.

### Send
- **Lane:** reading — an active-step column at roughly 720px.
- **Persistent running-summary rail:** amount, fee, fiat, recipient, remaining balance, visible across
  every step of the flow rather than only at review.
- **Fee options:** render 3-up at desktop width (unchanged content, wider layout).
- **Review:** the slide-to-send gesture is unchanged (manifesto §5 friction ladder governs this, not
  this document).

### Tx detail
- **Lane:** data.
- **`TxFlowDiagram`:** keeps its existing `1fr auto 1fr` side-by-side layout and its existing 900px
  stack breakpoint — the wider lane simply gives that layout more room to not feel cramped; the
  breakpoint logic itself is untouched.
- **New at `≥1160px`:** a quiet metadata rail — confirmations, block, size/vsize, fee rate, RBF/CPFP
  status.

### Explorer home
- **Full-width:** `ChainStrip` (a `.full-bleed` element per §2.2).
- **Below it, a 2/3 + 1/3 split:** a recent-blocks list on the left with richer columns (height, time,
  tx count, size, fees, miner) and a rail on the right (`FeeWeather` panel, mempool summary, search).

### Block detail
- **Hero:** height + epoch ring.
- **Left:** transaction list.
- **Rail:** hash, merkle root, size, weight, fees, miner, timestamp.

### Address
- **Hero:** balance.
- **Left:** transaction history.
- **Rail:** received/sent totals, tx count, QR, first/last seen.

### Mempool
- **Full-width:** fee-band visualization.
- **Below it:** projected blocks, side-by-side.
- **Hero:** current fee estimate.

### Mining
- **Hero:** hashrate/status.
- **Left:** worker hairline list.
- **Rail:** template/pool status, block-found history, payout note.
- **Onboarding:** stays a calm reading-measure column — this is a wizard, not a dashboard, even inside
  the mining section.

### Admin
- **Nav:** a page-local 200px vertical sub-nav replaces today's 12-toggle horizontal bar. Every route
  currently reachable through the toggle bar must remain reachable through the sub-nav — this is a
  navigation-chrome swap, not a route removal.
- **Dashboard:** a 2-column grid of bordered instrument panels.
- **Users / Invites / Logs / Activity:** full-width tables.
- **Config forms:** stay at reading measure — a form is a form regardless of which section it lives in.

### Activity
- **Lane:** data.
- **List:** columns for time, wallet, amount, status.
- **Optional:** a quiet filter rail.

### Settings
- **Nav:** a page-local left section nav — Display, Security, Notifications, Health, Advanced.
- **Content:** reading measure.
- **Health:** its duty breakdown renders as an instrument panel, consistent with §3.2's density-cluster
  treatment.

---

## 5. Waves

Three waves, sequenced so the shell lands first and Alex's highest-pain surfaces land second.

### Wave 1 — shell (ship alone)
- `app.css` tokens and utilities from §2.
- Remove the 940px global cap and every per-page cap listed in §2.
- Route → lane mapping added in `(app)/+layout.svelte`.
- New `HWSidebar` component, extending `HWRail` — the compact rail's existing CSS carries over
  verbatim, unchanged.
- The collapse toggle (§1.2).
- **QA gate:** mobile `<900px` must be byte-identical to pre-wave behavior. This is the wave's
  acceptance criterion, not a nice-to-have.

### Wave 2 — Alex's pain first
- Tx detail rail.
- Explorer home, block, address.
- Wallet detail, both single-sig and multisig.
- Admin sub-nav + tables.
- Settings section nav.

### Wave 3 — remainder
- Home quiet rail.
- Send summary rail.
- Mining.
- Mempool.
- Activity columns.
- Wallet list columns.

Wave 1 must ship and stabilize before Wave 2 begins — every subsequent page-level pass depends on the
tokens, utilities, and `HWSidebar` that Wave 1 establishes. Waves 2 and 3 can proceed in parallel with
each other once Wave 1 is settled, since they touch disjoint route trees.

---

## 6. Regression risks

- **`TxFlowDiagram` center alignment** — re-test 1-in/1-out, many-in/many-out, and coinbase tx shapes
  once the surrounding lane widens; the diagram's own breakpoint is unchanged but its container isn't.
- **Leftover width caps** — any per-page cap not removed in Wave 1 silently re-creates the skinny-strip
  bug inside the new lane. Audit every page touched in Waves 2–3 for a stale cap before calling it done.
- **Admin sub-nav route preservation** — every route reachable via today's 12-toggle bar must remain
  reachable via the new 200px sub-nav; treat any dropped route as a P0 regression, not a cleanup.
- **Sticky sidebar overflow + popover z-index** — the Notifications and Account popovers anchor off
  sidebar rows; verify they layer correctly above sticky content and don't clip against the sidebar's
  own `overflow` boundary.
- **Light-theme AA for the active nav pill** — the `--accent-muted` fill + `--accent-bright` text
  combination in §1.1 needs a contrast check against the light-mode token set, not just dark.
- **Canvas/SVG components at wider containers** — `ChainStrip`, `ValueFlowBar`, `EpochDial` and similar
  draw-based components may carry intrinsic-width assumptions baked in from the mobile-only era; verify
  they scale rather than clip or stay pinned to a small fixed width inside a now-wider lane.
- **`localStorage` SSR guard** — the sidebar collapse read (§1.2) must not run before hydration; this is
  the same class of bug as the known Svelte 5 effect/onMount ordering hazard elsewhere in the app.
- **Exact-boundary overlap** — use exclusive min-widths (901/1160/1600) everywhere, per §2.3; an
  inclusive boundary that overlaps the mobile `max-width: 900px` rule is the easiest way to silently
  reintroduce a two-tiers-active-at-once bug.
- **Concurrent-session staging discipline** — this doc and its beads may land alongside other
  in-flight work on the same branch; stage explicit paths per commit rather than broad adds.

---

## 7. Manifesto appendix

The following section is appended to `docs/DESIGN-MANIFESTO.md` verbatim (see that file for the live
copy):

> ## 9. Desktop widening rules
>
> 1. **The field widens, the hero stays singular.** Surplus width becomes margin and quiet secondary
>    columns — never a second `--t-hero` number, never a second `.btn-primary`.
> 2. **Secondary columns whisper.** A quiet rail carries metadata in `--t-label` / `--t-micro` and cool
>    tones; anything that starts competing with the hero belongs one tap down instead.
> 3. **Reading lanes cap; data lanes fill.** Two measures only — roughly 780px for reading, 1180px/
>    1320px for data. Calm, single-decision screens never exceed reading measure. Dense screens fill
>    the data measure and stack rows; they never tile into cards.
> 4. **Asymmetry over symmetry.** Offset grids — hero plus rail, two-thirds plus one-third — read as
>    editorial. A centered pair of equal-weight cards is the sales-floor tile in disguise, just with
>    the count changed from many to two.
> 5. **The rail grew; it did not become a dashboard.** The sidebar is the icon rail with its labels
>    revealed and air added around it — nothing more. Active nav remains the single accent touch it
>    always was; no nested widgets, no embedded search, no promotional content in the sidebar.
> 6. **Density stays in bordered glass.** Every dense cluster — tables, UTXO panels, metric grids —
>    lives inside one instrument panel floating in whitespace. Density loose on a calm surface is the
>    failure mode this whole document exists to prevent.

---

## 8. Relationship to other docs

- `docs/DESIGN-MANIFESTO.md` — color, type, motion, friction-ladder doctrine. Unchanged by this
  document except for the §9 appendix above.
- `docs/UX-REDESIGN-SPEC.md` — information architecture. Superseded only at §2.7 (nav collapse to 3
  destinations); everything else in that spec still governs.
- Epic and wave beads tracking this work point back to this document as canonical (see the epic
  description in the tracker).
