# Handoff: Heartwood v3 — consumer-grade self-hosted Bitcoin web app, wearing the grove

> **Heartwood** is a self-hosted Bitcoin command center (block explorer + wallets + multisig + hardware signing + PSBT), shipped as a Docker container for **Umbrel and Start9** nodes. It is a **responsive web app** — one codebase, desktop and phone widths. Tagline: *"Your bitcoin. Your rules."*
>
> v3 = the v2 consumer-grade design (Strike/River polish + the ring signature system) **plus the grove field** — a background layer that fuses the brand's tree and space: you're standing inside the trunk, so growth rings read as vast faint orbits crossing the void, with glowing dust between them. This package **supersedes `design_handoff_heartwood_v2`**. Product scope and backend/data spec remain as documented in the original `design_handoff_heartwood` package (`original-brief.md`).

---

## About the design files

Files in `source/` are **design references authored in HTML** ("Design Component" prototypes that need the bundled `support.js` runtime). To view: keep `source/` intact and open `Heartwood App - Signature.dc.html` in a browser (internet needed for Google Fonts). **They are not production code.**

**Your task:** recreate the canonical screens pixel-accurately in the target codebase's own stack (a React + TypeScript SPA over JSON/WebSocket is the natural fit if none exists). Canvas pieces (chain strip, first-sync wood) become real `<canvas>` + rAF components.

### The main file is an exploration history — build ONLY the canonical set

`Heartwood App - Signature.dc.html` contains eight numbered sections (newest at top). Canonical:

| What | Section ids | Status |
|---|---|---|
| Desktop Home (with grove field) | `7a` | ✅ canonical (`2a` = same page, field-less base) |
| Desktop pages — Send, Sign, Receive, Wallet, Explorer, Activity, Node, Settings, Login (all field-applied in place) | `5a`–`5i` | ✅ canonical |
| Sent moment (post-broadcast) | `4a` | ✅ canonical |
| First sync (IBD) | `1a` | ✅ canonical |
| **Mobile web** — Home, Send, Sign, Receive, Wallet, Explorer, Activity, Node, Settings, Login, Sent | `8a`–`8k` | ✅ canonical |
| Grove intensity reference | `7b` | ✅ spec reference |
| Signature component states / microstates | `1c` + `4c` | ✅ spec reference |
| Turn 3 pages, `4b`, `1b`, and the iOS-framed mobiles (`2b`, `6a`–`6f`) | — | ❌ superseded explorations — do **not** implement (`2b`/`6x` were native-app styled; the product is a web app → use `8a`–`8k`) |

`Heartwood Timechain.dc.html` is the full-chain "dendrochronology" experience — brand piece and eventual explorer deep-dive. Phase 2.

## Fidelity

**High-fidelity.** Colors, type, spacing, radii, copy, motion, and the grove recipes are final. All numbers (height 956,237, ring 475, balances) are July-2026 mock data — compute live values; formulas below.

---

## The grammar (the rules that make it feel right)

1. **One number owns each page.** 86 px Source Serif hero on desktop; 42–52 px centered on mobile web.
2. **Breadcrumbs live in the eyebrow.** One 11 px tracked-caps line above the hero: `WALLETS / COLD STORAGE · 2-OF-3` (path segments `#6B6058`, current `#8F8379`).
3. **Pill hardware.** Primary actions are 52 px pills radius 26 (46–50 px on mobile), copper fill for the one primary act, ghost (1 px `#3A2F27`) for the rest.
4. **Hairlines, not boxes.** Lists are rows split by 1 px `#1D1712`. No cards, no nested containers. Filled surfaces: inputs (`#17120F`) and the chain-strip canvas only.
5. **Unboxed data.** Charts and the chain strip bleed to content width; captions under them in 11.5 px `#6B6058`.
6. **Depth comes from the grove, not glow.** Page bg `#100D0B` + the grove field at the page's volume (below). No radial aura washes except the Grove-volume warm wood tint.
7. **The ring does functional work.** Confirmations, node status, block rows, sync, quorum — all rings. Never decorative.

**Brand language:** "buried 3 rings deep" (never "3 confirmations") · "sealed" (6+) · "no rings yet" (mempool) · "Latest rings" · "New ring segment · 956,237" · "next ring ≈ 12 sat/vB" · "Ring 475 forming — 653 of 2,016" · "Watch it get buried" · "at tip".

---

## The grove field

**Concept:** the viewer stands inside the heartwood. Growth rings, seen from within, are enormous arcs sweeping in from an off-screen pith (top-left); a few dust motes glow between them (the space element). It is **pure background** — content never changes.

**Implementation:** a stack of CSS `radial-gradient` layers on the page container (zero extra DOM; exact stacks are inline in the source screens). Each ring = `radial-gradient(circle at <pith>, transparent Npx, rgba(232,147,90,α) N+1px, transparent N+4px)`; each dust mote = a 2–2.5 px dot gradient; Grove volume adds a warm wood wash `radial-gradient(circle at -18% -28%, rgba(59,43,31,.45), rgba(40,27,18,.2) 46%, transparent 74%)` as the bottom layer. An SVG layer is equally fine (see `7a`) and allows 2–3 motes to pulse (`hwPulse`, 4.4–6 s, staggered) — optional, respect reduced-motion.

**Geometry:** desktop pith `-380px,-320px`, ring radii ~700→2060 px, ~8 rings; mobile pith `-160px,-140px`, radii ~260→690 px, ~5 rings. Every 4th–5th ring is a brighter cream "epoch ring" (`#FBE1C6`).

**Three volumes** (reference board: `7b`):

| Volume | Rings α | Cream ring α | Dust | Extra | Used on |
|---|---|---|---|---|---|
| **Whisper** | .032–.038 | .05 | 2 motes ≤ .2 | — | Activity, Node, Settings (dense pages) |
| **Present** | .045–.065 | .08 | 3–4 motes .18–.32 | — | Home, Send, Sign, Receive, Wallet, Explorer |
| **Grove** | .07–.1 | .13 | 4 motes .22–.4 | warm wood wash | Login, Sent, First-sync (emotional pages) |

Rule of thumb: the field should be **felt, never read** — if you can count rings at reading distance on a data page, it's too loud.

---

## Responsive behavior (this is a web app)

- **≥ ~900 px:** 68 px icon rail (rings mark → Home/Explorer/Wallets/Activity/Node/Settings icons → epoch dial → avatar) + content column `max-width 940px` centered, padding `54px 52px 44px` (760 px column for Activity/Node/Settings).
- **≤ ~900 px** (screens `8a`–`8k`, 390 px reference): the rail collapses into —
  - **Tab pages** (Home, Explorer, Wallets, Activity): top bar `padding 16px 18px` — rings mark 22 + "Heartwood" 14/600 left, at-tip dial pill right (Explorer swaps the pill for a search icon) — then a **text-tab row** (the toggle grammar: active `#F4B486` on `rgba(232,147,90,.1)` radius 15, inactive `#6B6058`, 12.5 px, `padding 6px 13px`). Node & Settings are reached via the avatar/menu.
  - **Flow pages** (Send, Sign, Receive, Wallet detail, Sent): 32 px back circle (border `#2A2320`) + centered tracked eyebrow + 32 px spacer. No tabs.
  - Content gutter 20 → 18 px; heroes center; pills go full-width (h 46–52); rows keep the hairline grammar at ~1 px smaller type; the chain strip and charts run edge-to-edge or gutter-to-gutter.
  - No native chrome: no status bar, no home-indicator padding, no bottom tab bar.

---

## Design tokens

### Color
| Token | Hex | Use |
|---|---|---|
| `bg/page` | `#100D0B` | App background, both widths |
| `bg/deep` | `#0A0807` | Canvas/desk behind frames |
| `bg/input` | `#17120F` | Inputs, bar tracks |
| `bg/strip` | `#14100C` | Chain-strip canvas base |
| `hairline` | `#1D1712` | Row separators, quiet borders |
| `border/control` | `#2A2320` | Icon buttons, back circles |
| `border/input` | `#2E2621` | Input rest |
| `border/ghost` | `#3A2F27` | Ghost pill (hover → `#E8935A`) |
| `copper` | `#E8935A` | Primary fill, ring strokes, links, grove rings |
| `copper/hover` `pressed` | `#EFA06B` / `#D9884F` | Pill states |
| `copper/bright` | `#F4B486` | Active text, tip heights |
| `copper/glow` | `#F6C89A` / `#FBE1C6` | Tips, sweeps, grove dust + epoch rings |
| `copper/core` | `#FFE9CE` | Ring-core dots |
| `copper/dim` | `#7A5238` / `#5E3F2C` | Past stubs, pending dashes |
| `wood wash` | `rgba(59,43,31,.45)→rgba(40,27,18,.2)` | Grove-volume tint |
| `text/primary` | `#EDE4DB` · hero `#F1E7DD` · rows `#E5DBD1` | |
| `text/value` | `#CBBFB3` / `#D8CCC1` | |
| `text/secondary` | `#A99C90` · muted `#8B7F75` · faint `#7A6E63`/`#6B6058`/`#5E554D` | |
| `eyebrow` | `#8F8379` | |
| `text/on-copper` | `#1A1210` · ghost label `#E8C6A8` | |
| `sage` | `#8AA06E` (bg tint `rgba(138,160,110,.1)`) | Received, connected, valid |
| `attention` | `#D8B27A` | Stale-key/backup nudges — never red |

### Typography
- **Inter** 400/500/600/700 — everything except numbers.
- **Source Serif 4** 400/600/700 — numbers that matter only; always `font-variant-numeric:tabular-nums`; heroes `letter-spacing:-.015em`.
- **Mono** `ui-monospace, Menlo` — addresses, txids, fingerprints, hostnames.

| Role | Desktop | Mobile web |
|---|---|---|
| Hero number | Serif 600 · 86/0.92 (unit 34) | Serif 600 · 42–52 centered (unit 17–20) |
| Secondary hero | Serif 600 · 44–56 | Serif 600 · 30–38 |
| Hero sub | Inter 400 · 15 `#A99C90` | 11.5–12.5 |
| Eyebrow | Inter 600 · 11 · .22em caps | 10 · .2em |
| Section title | Inter 600 · 17 | 14.5 |
| Row title / meta / amount | 500·14.5–15 / 400·12–12.5 / Serif 600·15.5–16.5 | 500·13 / 400·10.5–11 / Serif 600·13.5–14 |
| Pill label | Inter 600 · 15 | 14–14.5 |
| Toggles | 13; active `#F4B486` on copper tint r14 | 12–12.5 r15 |
| Captions under data | 11.5 `#6B6058` | 9.5–10.5 |

### Layout, radius, elevation
- Rhythm (desktop): eyebrow → hero 18 → sub 16 → pills 28–30 → first section 40–46; rows 15–17 py; grids `1.5fr 1fr` gap 64.
- Radius: pills 26 (mobile 23–24) · toggles 14–15 · status pills 16–20 · icon buttons 10–11 · strip canvas 10–12 · badges 4–5 · mobile screen container 18. Rows: none.
- Elevation: primary pill `0 4px 20px rgba(232,147,90,.25)`; toast/modal `0 10px 32px`/`0 16px 48px rgba(0,0,0,.45–.5)`; focus = copper border + `0 0 0 3px rgba(232,147,90,.12)`.

---

## Signature components

### Burial rings (confirmations)
26–34 px svg: center dot r2.4 + one thin ring per confirmation, alternating opacity outward (~.85/.55/.32). Mempool: dot + dashed ring (`3.5 4`) pulsing. 1–5 conf: that many rings — sage incoming, copper outgoing. **Sealed (6+):** six rings — the glyph becomes the logo. Meta strings: "no rings yet" / "buried 3 rings deep" / "sealed · six rings deep".

### Epoch dial (node status)
Inner rings (r5, r9 faint) + track `#2E2620` + progress arc = forming-ring progress (`(h − N·2016)/2016`, linecap round, rotate −90°) + pulsing tip `#F6C89A` + core `#FFE9CE`. States: at-tip (copper + pulse) / syncing (dim `#B5673A` + %) / behind (arc `#7A5238` + amber !). Sizes 14–16 (pills), 38 (rail), 72–96 (node page). Sweeps once per new block.
**At-tip pill:** dial 14–16 px + `at tip · 956,237` (mobile drops the words, keeps the number), Inter 500 11–12 `#8B7F75`/number `#CFC3B8`, bg `rgba(255,255,255,.025)`, hairline border, radius 16–20.

### Ring stubs (block rows)
14–17 px: two partial arcs (r4 ~300°, r7.5 ~320°, rotate −90°). Tip = `#F4B486` + glow + core dot; past = `#7A5238` fading; pending = dashed `#5E3F2C` circle.

### Chain strip (the timechain, linearized)
Canvas on `#14100C` + warm vertical gradient. One vertical line per difficulty epoch (475), x ∝ cumulative epoch duration (widths to scale — 2009 wide, 2013 tight). Line alpha `0.07+0.14·n(i)` (+.26 for ~13% pop rings); halving epochs (104/208/312/416) cream + top triangle; sapwood zone (last 8) `rgba(246,200,154,.05)`; genesis dot left; now-edge 2 px copper line + DOM pulsing dot. Labels: `2009 · genesis` / `475 rings · one per difficulty epoch · widths to scale` / `now`. Locator variant: 56–64 px + cream marker at the block's x. Epoch durations derive from real retarget timestamps (prototype anchors: epochs 0/16/28/50/70/85/104/124/140/155/180/208/240/270/300/313/341/342/343/352/380/410/417/445/474 ↔ 2009-01-03…2026-07-01, ±14% in-span noise).

### Quorum arc (multisig)
Ring split into m arcs (dasharray = C/m − gap): collected copper (glow), active cream pulsing, remaining `#2E2620`. 26 px beside "Signatures · 1 of 2 collected" (desktop), 18–20 px in the eyebrow (mobile).

### The mark
`HeartwoodMark.dc.html`: concentric rings, eccentric pith (up-left), alternating weights; tones copper/cream/ink; detail full (8) / simple (5) / min (3, favicon).

---

## Screens — desktop (1280×832 reference; exact values at the ids)

Every page: rail + content column + eyebrow/at-tip header + hero + grove field at its volume.

- **Home `7a`** *(Present)* — `TOTAL BALANCE` + eye toggle (hide → `•.••`/"balance hidden"); hero `3.8412 BTC`; sub fiat/sats + sage `▲ 2.4% today`; Send/Receive/scan pills; **the chart**: 190 px unboxed area, copper 2 px line, gradient fill, draw-in on mount, pulsing end dot, 24h/7d/30d toggles with per-range paths + delta chips; below `1.5fr/1fr`: Activity rows (burial rings) | Wallet rows + Next-block footer (fee, 3-segment mempool bar `#E8935A/#B5673A/#5E3F2C`).
- **Send `5a`** *(Present)* — eyebrow `COLD STORAGE / SEND · 2.6180 AVAILABLE`; hero = typed amount + unit-swap circle; `TO` hairline field (mono 15, copy/scan) + sage validation line; `FEE` text toggles `Low·4 / Medium·12 / High·28` + `next ring ≈ 10 min`; `Review send →` + multisig note. Errors replace the validation line in `#D8B27A`.
- **Sign `5b`** *(Present)* — hero amount; grid: Signatures (quorum arc, key rows → `✓ Signed`/`Sign now` pill/`Not needed` 55%) + "Heartwood never sees a key" | Verify-on-device k/v (To/Amount/Fee/Change + `BACK TO YOU` sage badge) + Export PSBT / Finish later. Drafts resumable.
- **Receive `5c`** *(Present)* — 300 px QR (`#E4D8CC` modules, real QR lib) | "A fresh address, every time.", address mono over hairline, Copy + Rotate, privacy note.
- **Wallet `5d`** *(Present)* — hero balance; Send/Receive; 148 px stepped chart (deposits read as steps); grid: tx rows w/ burial rings | Keys rows (stale = copper dot + `6 mo since signed` amber) + Export config.
- **Explorer `5e`** *(Present)* — search pill 44; hero tip height + "blocks · not one removed"; live sub-line; 120 px chain strip + labels; **Latest rings** rows + dashed pending row. Block detail = `Block 956,237` + sage `⊙ 6 rings deep` pill, hash+copy, inline serif stats, locator strip, tx rows.
- **Activity `5f`** *(Whisper)* — filter toggles All/Wallets/Node; hero event count; day-grouped rows (burial rings, clock+`2/3` PSBT, ring stub for blocks, `YOU` badge).
- **Node `5g`** *(Whisper)* — sage `Healthy`; hero height + "at the tip"; k/v rows ×2 cols: Backend/Peers/Storage-bar/Uptime/Version/Config-backup (amber + `Back up`); footer instance links + faint `Factory reset…`.
- **Settings `5h`** *(Whisper)* — profile row; Units BTC/sats toggle; Fiat/Notifications/Passkeys/Recovery(✓ sage)/Contacts/About rows.
- **Login `5i`** *(Grove)* — centered 360: mark 60, wordmark, tagline, pill inputs (52/r26), Sign in, passkey ghost, first-account link, footer strip. Signup/recover/legal reuse.
- **Sent `4a`** *(Grove)* — send stepper with Broadcast lit; **ring-sweep moment** (two cream sweeps 2.4 s ease-out, .2 s/1 s delays, once; dashed mempool ring pulsing); `0.2500 BTC is on its way`; From/mempool/fee sub; txid pill; `Watch it get buried` / `Done`; "nudge at first ring — and at six."
- **First sync `1a`** *(Grove by nature)* — the wood grows as the node verifies: rings harden per epoch (flash), halvings land cream, scanning frontier, live counter, "Verifying 2017 — SegWit summer" year notes, ETA/peers, synced state + sweep.

## Screens — mobile web (`8a`–`8k`, 390×760 reference)

Same pages, responsive rules above: **8a Home** (tabs, centered 48 hero, full-width pills, edge sparkline, 2 activity rows, next-block footer) · **8b Send** (52 amount, hairline TO, fee toggles, Review pill) · **8c Sign** (quorum in eyebrow, key rows, compact k/v) · **8d Receive** (228 QR, Copy/Rotate) · **8e Wallet** (48 hero, pills, 88 chart, rows + stale-key line) · **8f Explorer** (tabs, 42 hero, 68 px live strip, ring rows, network footer) · **8g Activity** (tabs, count hero, day groups) · **8h Node** (72 dial, k/v rows) · **8i Settings** (profile + rows) · **8j Login** (Grove, centered) · **8k Sent** (Grove, sweep + stacked pills).

## Microstates (`4c`)
Pills: hover `#EFA06B` + bigger glow, pressed `#D9884F` + `scale(.97)`, 120 ms ease-out; disabled `#2A2320`/`#6B6058`, no shadow. Input focus: copper border + 3 px ring + blinking 1.5 px copper caret (1.1 s step-end). Toast: `#201A16`/`#2A2320` pill, sage check + message + mono detail, up-8px fade, 2.4 s, never stacks. Modal: irreversible acts only ("Once it takes a ring, there is no undo."), Cancel text + copper confirm. Loading: ring-arc spinner (copper on `#2A2320`, 1.2 s linear, core dot) — never generic; skeletons shimmer `#17120F→#241C15→#17120F` 1.6 s.

## Motion reference
| Name | Spec | Use |
|---|---|---|
| hwPulse | opacity .45↔1 · 2.4–2.6 s ∞ (4.4–6 s for grove dust) | tips, live dots, dashed rings, dust |
| hwBlink | opacity 1↔.28 · 2.4 s ∞ | status dots |
| hwSweepOnce | scale .18→1 + fade · 2.4 s ease-out · once | sent moment, ring close |
| hwGrow | dashoffset→0 · 1.8 s ease-out | chart draw-in |
| hwShimmer | bg-pos 200%→−200% · 1.6 s ∞ | skeletons |
| hwSpin | 360° · 1.2 s linear ∞ | ring spinner |
| hwBreathe | scale 1↔1.05 · 9 s ∞ | first-sync aura only |
Respect `prefers-reduced-motion` (prototype: `data-motion="false"` → `animation-play-state:paused`).

## State & live data
- Node: tip `h`; `N = floor(h/2016)`; forming ring `N+1`; progress `h − N·2016` of 2016; close ETA `blocksLeft × 10 min` → dial, pills, explorer/node heroes. New block → dial/strip tip pulse + "New ring segment" event.
- Confirmations: `h − txBlock + 1` → burial glyph + string (visual cap 6 = sealed).
- Home/Wallet: balance (+ persisted hide toggle), fiat rate, chart range + delta.
- Send: amount/unit, validation, live fee tiers, PSBT draft + per-key status (resumable, on node).
- Sync: %, height, year note, rings laid, ETA, peers → synced.
- Poll/WebSocket from the user's own backend; no third-party APIs.

## Route coverage (~45 routes → these patterns)
Signup/Recover/Legal/Error → `5i`/`8j` · First sync → `1a` · Home → `7a`/`8a` · Send review/broadcast/sent → `5a`/`5b`/`4a` (+ `8b`/`8c`/`8k`) · Stateless signer + signing methods → `5b` · Wallet list/wizards → `7a` rows + `5a` steps · Wallet detail → `5d`/`8e` · Explorer home/mempool/difficulty/tx/address → `5e`/`8f` · Activity → `5f`/`8g` · Admin ×8 → `5g` rows + `5f` feed · Settings/notifications/contacts/recovery-setup → `5h`/`8i`. Full per-route content: v1 `original-brief.md`.

## Assets
- **Fonts:** Inter + Source Serif 4 (self-host for offline nodes).
- **Icons:** inline stroke SVGs, `currentColor`, ~1.6 weight (Lucide: layout-grid, wallet, activity, sliders-horizontal, server, search, arrow-up/down, copy, eye, key-round, scan-line, chevrons, check, clock). Explorer icon = three concentric circles (custom).
- **Logo:** rebuild from `HeartwoodMark.dc.html`. **QR:** real library, `#E4D8CC` modules. No raster images.

## Files
```
design_handoff_heartwood_v3/
├── README.md                                ← this spec
└── source/                                  ← open the app file in a browser to view
    ├── Heartwood App - Signature.dc.html    ← all screens (7a, 5a–5i, 4a, 1a, 8a–8k + reference boards)
    ├── HWRail.dc.html                       ← desktop nav rail component
    ├── HeartwoodMark.dc.html                ← the rings logo component
    ├── Heartwood Timechain.dc.html          ← full-chain dendrochronology experience (phase 2)
    ├── ios-frame.jsx                        ← used only by superseded turn-6 mocks (ignore)
    └── support.js                           ← prototype runtime (viewing only — do not ship)
```
*Product/backend spec + per-route content: `design_handoff_heartwood` (v1). This package supersedes v2.*
