# Handoff: Heartwood v2 — consumer-grade self-hosted Bitcoin app

> **Heartwood** is a self-hosted Bitcoin command center (block explorer + wallets + multisig + hardware signing + PSBT), shipped as a Docker container for **Umbrel and Start9** nodes. Tagline: *"Your bitcoin. Your rules."*
>
> This package is the **v2 visual + UX design**: a consumer-grade treatment (Strike / River polish) that replaces the v1 admin-dashboard look, plus the **ring signature system** that makes the app unmistakable in a node-app store. Product scope, backend/data spec, and per-route content remain as documented in the earlier `design_handoff_heartwood` package (`original-brief.md` there) — this package supersedes it **visually**.

---

## About the design files

Files in `source/` are **design references authored in HTML** ("Design Component" prototypes that need the bundled `support.js` runtime). To view: keep the `source/` folder intact and open `Heartwood App - Signature.dc.html` in a browser (internet needed for Google Fonts). **They are not production code.**

**Your task:** recreate the canonical screens pixel-accurately in the target codebase's own stack and patterns. If no front-end exists yet, a React + TypeScript SPA talking to the backend over JSON/WebSocket is the natural fit. Canvas pieces (chain strip, first-sync wood) should become real components (`<canvas>` + rAF, or WebGL if you prefer).

### The main file is an exploration history — build ONLY the canonical set

`Heartwood App - Signature.dc.html` contains six numbered sections (newest at top). The **canonical design** is:

| What | Section ids | Status |
|---|---|---|
| Desktop Home | `2a` | ✅ canonical |
| Desktop pages (Send, Sign, Receive, Wallet, Explorer, Activity, Node, Settings, Login) | `5a`–`5i` | ✅ canonical |
| Sent moment (post-broadcast) | `4a` | ✅ canonical |
| First sync (IBD) | `1a` | ✅ canonical |
| Mobile Home | `2b` | ✅ canonical |
| Mobile Send / Sign / Receive / Wallet / Explorer / Sent | `6a`–`6f` | ✅ canonical |
| Signature component states | `1c` (kit) + `4c` (microstates) | ✅ spec reference |
| Turn 3 pages, `4b`, `1b` | — | ❌ superseded explorations — do **not** implement |

`Heartwood Timechain.dc.html` is the full-chain "dendrochronology" experience — a brand/marketing piece and the eventual explorer chain-overview deep-dive. Implement after the app itself.

## Fidelity

**High-fidelity.** Colors, type, spacing, radii, copy, and motion are final. Match pixel-accurately. All numbers shown (block height 956,237, ring 475, balances) are July-2026 mock data — compute live values in production; formulas below.

---

## The grammar (the rules that make it feel right)

1. **One number owns each page.** 86 px Source Serif hero on desktop (54–64 px centered on mobile). Everything else defers to it.
2. **Breadcrumbs live in the eyebrow.** One 11 px tracked-caps line above the hero: `WALLETS / COLD STORAGE · 2-OF-3`. Dimmer segments (`#6B6058`) are the path; the current node is `#8F8379`.
3. **Pill hardware.** All primary actions are 52 px pills, radius 26 (44–50 px secondary). Copper fill for the one primary act; ghost (1 px `#3A2F27` border) for the rest.
4. **Hairlines, not boxes.** Lists are rows separated by 1 px `#1D1712`. No cards, no nested containers, no left-accent borders. The only "filled" surfaces: inputs (`#17120F`) and the chain-strip canvas.
5. **Unboxed data.** Charts and the chain strip bleed to the content width with no frame; labels sit under them in 11.5 px `#6B6058`.
6. **Air, not glow.** Page background `#100D0B`. No radial auras on app pages. The only glows: the copper drop-shadows baked into the ring components and primary-pill shadow.
7. **The ring does functional work.** Confirmations, node status, block rows, sync, quorum — all drawn as rings (components below). Never decorative.

**Brand language (use in copy, everywhere):** "buried 3 rings deep" (not "3 confirmations") · "sealed" (6+ conf) · "no rings yet" (mempool) · "Latest rings" (recent blocks) · "New ring segment · 956,237" (new block event) · "next ring ≈ 12 sat/vB" · "Ring 475 forming — 653 of 2,016" · "Watch it get buried" (view tx CTA) · "at tip" (synced).

---

## Design tokens

### Color
| Token | Hex | Use |
|---|---|---|
| `bg/page` | `#100D0B` | App + mobile background (deeper than v1) |
| `bg/deep` | `#0A0807` | Canvas/desk behind frames |
| `bg/input` | `#17120F` | Inputs, bar-track fills |
| `bg/strip` | `#14100C` | Chain-strip canvas base |
| `hairline` | `#1D1712` | Row separators, quiet borders, rail border |
| `border/control` | `#2A2320` | Icon-button borders, back circles |
| `border/input` | `#2E2621` | Input rest border |
| `border/ghost` | `#3A2F27` | Ghost-pill border (hover → `#E8935A`) |
| `copper` | `#E8935A` | Primary fill, ring strokes, links, active accents |
| `copper/hover` | `#EFA06B` | Primary pill hover |
| `copper/pressed` | `#D9884F` | Primary pill pressed |
| `copper/bright` | `#F4B486` | Active text, tip heights, dial arc labels |
| `copper/glow` | `#F6C89A` / `#FBE1C6` | Pulsing tips, sweep strokes |
| `copper/core` | `#FFE9CE` | Ring-core dots |
| `copper/dim` | `#7A5238` / `#5E3F2C` | Past block stubs, pending dashes |
| `text/primary` | `#EDE4DB` | Titles (Inter) |
| `text/hero` | `#F1E7DD` | Serif numbers |
| `text/row` | `#E5DBD1` | Row titles (15 px) |
| `text/value` | `#CBBFB3` / `#D8CCC1` | Values |
| `text/secondary` | `#A99C90` | Hero sub-lines |
| `text/muted` | `#8B7F75` | Meta, eyebrow pill text |
| `text/faint` | `#7A6E63` / `#6B6058` / `#5E554D` | Sub-meta, captions, footnotes |
| `eyebrow` | `#8F8379` | Tracked-caps eyebrows |
| `text/on-copper` | `#1A1210` | Text on copper |
| `text/ghost-label` | `#E8C6A8` | Ghost-pill labels |
| `sage` | `#8AA06E` | Received, connected, valid (bg tint `rgba(138,160,110,.1)`) |
| `attention` | `#D8B27A` | Stale-key / backup nudges (amber-copper, never red) |
| Copper tints | `rgba(232,147,90,.1)` bg · `.12` badge bg · `.25` pill shadow | |

### Typography
- **Inter** 400/500/600/700 — everything except numbers.
- **Source Serif 4** 400/600/700 — *numbers that matter only*, always `font-variant-numeric: tabular-nums`; heroes get `letter-spacing:-.015em`.
- **Mono** `ui-monospace, Menlo` — addresses, txids, fingerprints, hostnames.

| Role | Spec |
|---|---|
| Desktop hero | Serif 600 · 86/0.92 (unit: Serif 400 · 34 `#8F8379`) |
| Mobile hero | Serif 600 · 54–64 centered (unit 21–23) |
| Secondary hero (activity count, sign amount) | Serif 600 · 44–56 |
| Hero sub-line | Inter 400 · 15 `#A99C90` (13–13.5 mobile) |
| Eyebrow | Inter 600 · 11 · tracking .22em · caps (10/.2em mobile) |
| Section title | Inter 600 · 17 |
| Row title | Inter 500 · 14.5–15 `#E5DBD1` |
| Row meta | Inter 400 · 12–12.5 `#7A6E63` |
| Row amount | Serif 600 · 15.5–16.5, sign colors: `+` sage, `−` `#CBBFB3` |
| Pill label | Inter 600 · 15 (13.5 secondary) |
| Caption under data | Inter 400 · 11.5 `#6B6058` |
| Chart/filter toggle | Inter 500/600 · 13; active `#F4B486` on `rgba(232,147,90,.1)` radius 14; inactive `#6B6058` |

### Layout & spacing
- **Desktop screen:** 1280×832 reference. 68 px icon rail (right hairline) → content column `max-width: 940px` centered, padding `54px 52px 44px`. Narrow pages (Activity, Settings, Node rows) use 760 px.
- **Rail:** rings mark 26 px top; 40×40 icon buttons (radius 11, active: copper tint bg + `#F4B486`); spacer; 38 px epoch dial; 30 px avatar (gradient `135deg #B5673A→#E8935A`).
- **Rhythm:** eyebrow → hero `18px` → sub `16px` → pills `28–30px` → first section `40–46px`; rows `15–17px` vertical padding; two-column grids `1.5fr 1fr` with `64px` gap.
- **Mobile:** 390×844 inside device frame. **Top clearance 58 px** (below status bar/island), **bottom nav padding-bottom 28 px** (clears home indicator). Content gutter 20 px. Flow pages (send/sign/receive/sent): back circle (34 px, `#2A2320` border) + centered eyebrow, **no tab bar**. Tab pages: 2b-style header + 4-tab bar (Home · Explorer · Wallets · Activity; active `#F4B486`).
- **Radius:** pills 26 · toggles 14 · status pills 16–20 · icon buttons 10–11 · strip canvas 10–12 · badges 4–5. Rows: none.

### Elevation
- Primary pill: `0 4px 20px rgba(232,147,90,.25)` (hover `.32`, larger).
- Screen frame (marketing only): `0 24px 70px rgba(0,0,0,.5)`.
- Toast/modal: `0 10px 32px` / `0 16px 48px rgba(0,0,0,.45–.5)`.
- Focus: border `#E8935A` + `0 0 0 3px rgba(232,147,90,.12)`.

---

## Signature components

### 1 · Burial rings (confirmation glyph) — `1c`, rows everywhere
30–34 px svg, viewBox 32. Center dot r2.4 + one thin ring per confirmation, alternating opacity outward (~.85/.55/.32). **Mempool:** dot + one dashed ring (`stroke-dasharray:3.5 4`) pulsing (hwPulse 2.4 s). **1–5 conf:** that many rings, sage `#8AA06E` for incoming, copper for outgoing. **Sealed (6+):** six rings — the glyph literally becomes the logo mark. Row meta strings: "no rings yet" / "buried 3 rings deep" / "sealed · six rings deep".

### 2 · Epoch dial (node status) — rail, status pills, node page
Concentric rings (r5, r9 faint copper) + track ring `#2E2620` + progress arc = **forming-ring progress** (`(height − N·2016)/2016` of circumference, `stroke-linecap:round`, rotate −90°) + pulsing tip dot `#F6C89A` at arc end + core dot `#FFE9CE`. States: **at tip** (copper arc + tip pulse) · **syncing** (dimmer `#B5673A` arc, % label) · **behind** (arc `#7A5238` + amber `!`). Sizes: 16 px (status pill), 38 px (rail), 96 px (node hero). The arc **sweeps once** when a block lands.
**Status pill** (top-right of most desktop pages): 16 px dial + `at tip · 956,237` — Inter 500 12 `#8B7F75`, height number `#CFC3B8`, bg `rgba(255,255,255,.025)`, hairline border, radius 20.

### 3 · Ring stubs (block rows) — explorer, activity
15–17 px svg: two partial arcs (r4 inner ~300°, r7.5 outer ~320°, both rotate −90°). **Tip:** inner `#F4B486` + glow, outer copper .7, core dot `#F6C89A`. **Past:** both `#7A5238`, fading with age. **Pending:** single dashed circle `#5E3F2C`.

### 4 · Chain strip (the timechain, linearized) — explorer hero, block locator
Canvas, bg `#14100C`, vertical warm gradient. **One vertical line per difficulty epoch** (475 as of mock), x ∝ cumulative epoch duration (widths to scale — 2009 wide, 2013 tight). Line alpha `0.07+0.14·n(i)` (+0.26 for ~13% "pop" rings), copper; **halving epochs** (idx 104/208/312/416) cream `#FBE1C6` with a small triangle marker at top; **sapwood** (last 8 epochs) overlaid `rgba(246,200,154,.05)`; genesis dot (glowing, left); **now edge** = 2 px copper line at right + DOM-overlaid pulsing dot. Under-labels: `2009 · genesis` / `475 rings · one per difficulty epoch · widths to scale` / `now`. Locator variant (block detail): 56–64 px tall + vertical cream marker at the block's x. Epoch-duration data: derive from real difficulty-adjustment timestamps (the prototype anchors: epochs 0/16/28/50/70/85/104/124/140/155/180/208/240/270/300/313/341/342/343/352/380/410/417/445/474 ↔ dates 2009-01-03 … 2026-07-01, ±14% noise within spans).

### 5 · Quorum arc (multisig) — sign pages
Small ring split into m equal arcs (dasharray = circumference/m − gap): collected = copper (glow), active = cream pulsing, remaining = `#2E2620`. Desktop 5b: 26 px glyph beside "Signatures · 1 of 2 collected". Mobile 6b: 20 px inside the eyebrow.

### 6 · The mark
`HeartwoodMark.dc.html`: concentric rings, eccentric pith (up-left), alternating stroke weights; tones copper/cream/ink; detail full (8 rings) / simple (5) / min (3, favicon). Recreate as an svg component.

---

## Screens — desktop (1280×832 reference)

Every page: rail (active item set) + content column + eyebrow/status-pill header + hero, per the grammar. Exact values live in the bundled source at the given id.

### Home — `2a` · `/`
Eyebrow `TOTAL BALANCE` + eye toggle (hides balance → `•.••` + "balance hidden"). Hero `3.8412 BTC` · sub `≈ $412,905 · 384,126,180 sats` + sage chip `▲ 2.4% today`. Pills: **Send** (copper) / **Receive** (ghost) / scan (52 px circle). **Chart:** "Balance over time" + 24h/7d/30d text toggles; 190 px unboxed area chart — copper 2 px line, gradient fill `rgba(232,147,90,.28)→0`, draw-in on mount, pulsing end dot; each range has its own path + delta chip copy (`▲ 6.1% this week`, `▲ 11.8% this month`). Below, grid 1.5fr/1fr: **Activity** (3 rows, burial rings, "View all") | **Wallets** (rows: name + quorum badge, serif balance, chevron; "+ New") + **Next block** footer (fee `≈ 12 sat/vB`, 3-segment mempool bar `#E8935A/#B5673A/#5E3F2C`, "mempool 148 vMB · 41,200 tx").

### Send — `5a` · `/send`
Eyebrow `COLD STORAGE / SEND · 2.6180 AVAILABLE`. Hero = amount being typed `0.2500 BTC` + 36 px circular unit-swap button; sub `≈ $26,875 · 25,000,000 sats`. `TO`: hairline underline field, mono 15, copy + scan icons; validation line below in sage (`✓ Valid native SegWit · first time sending here`). `FEE`: text toggles `Low · 4 / Medium · 12 / High · 28` (+ right caption `sat/vB · next ring ≈ 10 min`). CTA `Review send →` + note "2 of 3 devices will sign — collect signatures over days if you like." Errors (insufficient funds, dust, fee sanity) replace the validation line in `#D8B27A`.

### Sign — `5b` · `/send` (signatures)
Eyebrow `COLD STORAGE / SEND / SIGN`. Hero = amount; sub `to bc1q… · fee 12 sat/vB · draft saved on your node`. Grid: **Signatures** (quorum arc + "1 of 2 collected"; key rows: name + mono fingerprint → status: `✓ Signed · 2m ago` copper / **Sign now** pill / `Not needed` at 55% opacity) + trust line "Approval happens on the device's own screen. Heartwood never sees a key." | **Verify on device** (hairline k/v: To, Amount, Fee, Change + sage `BACK TO YOU` badge) + `Export PSBT` ghost / `Finish later` text. PSBT drafts are resumable across sessions.

### Receive — `5c` · `/receive`
Eyebrow `COLD STORAGE / RECEIVE`. Grid: 300 px QR (light modules `#E4D8CC` on page bg — use a real QR lib) | right: title "A fresh address, every time.", address mono 15 (grouped 4s) over a hairline, **Copy** pill + **Rotate** ghost, privacy note ending "…you'll watch it get buried, ring by ring."

### Wallet — `5d` · `/wallets/:id`
Eyebrow `WALLETS / COLD STORAGE · 2-OF-3 · NATIVE SEGWIT`. Hero = balance; sub `≈ $281,437 · 3 UTXOs · last activity 24m ago`; Send/Receive pills. **Chart** (148 px, same component; for cold storage the curve reads as steps — deposits). Grid: **Transactions** (rows with burial rings, meta `Jul 5 · 3 rings deep`, serif amounts; header links `All · Addresses · Sending 1`) | **Keys** (rows: device name → mono fingerprint; stale key = copper dot + `6 mo since signed` in `#D8B27A`; "Export config"; footnote "2 of 3 required to spend. Rotate the Jade key soon…").

### Explorer — `5e` · `/explorer`
Eyebrow `THE TIMECHAIN` + search pill (44 px, right). Hero = tip height `956,237` + "blocks · not one removed"; sub `ring 475 forming — 653 of 2,016 · next ring ≈ 12 sat/vB · mempool 148 vMB · difficulty +2.1% in ≈ 9 days`. **Chain strip** 120 px + labels. **Latest rings:** rows `stub · height (serif, tip #F4B486) · time + miner · tx count · size`, plus a **pending** row (dashed stub, "projected ≈ 2 min · 12 sat/vB floor"). Block detail (`/explorer/block/:h`) follows turn-3 `3f` content in this grammar: hero `Block 956,237` + sage pill `⊙ 6 rings deep`, hash mono + copy, inline serif stats, **locator strip**, tx rows.

### Activity — `5f` · `/activity`
Eyebrow `ACTIVITY` + filter toggles `All / Wallets / Node`. Hero = event count `6` + "events in the last two days · all quiet". Day groups (`TODAY`, `YESTERDAY` eyebrows) of rows: burial rings for tx, clock icon + `2/3` badge for PSBT, ring stub for new blocks, key icon + `YOU` badge for account events.

### Node — `5g` · `/node`
Eyebrow `YOUR NODE · UMBREL-NODE.LOCAL` + sage `Healthy` pill. Hero = height + "at the tip"; sub `ring 475 forming — 653 of 2,016 laid · closes ≈ Jul 15 · every block verified here, on your metal`. Two-column hairline k/v rows: Backend (`Electrum · yours` + sage dot) · Peers (`9 · 3 over Tor`) · Storage (4 px copper-gradient bar, `612 GB / 1 TB`) · Uptime · Version (+ `✓ current`) · Config backup (amber `12 days old` + copper **Back up** link). Footer: `Users · Invites · Logs · Agreement — Instance settings →` and faint `Factory reset…` (type-RESET confirm per v1 spec).

### Settings — `5h` · `/settings`
Eyebrow `SETTINGS` + status pill. Profile row (56 px avatar, name, `satoshi@node.local · admin`, Edit ghost). Hairline rows: Units (BTC/sats toggle) · Fiat display · Notifications · Passkeys · Recovery (`✓ phrase + 8 codes` sage) · Contacts · About (`1.4.2 · MIT · not a custodian`). Chevrons `#5E554D`.

### Login — `5i` · `/login`
Centered 360 px column, no rail: mark 60 → "Heartwood" 24 → tagline → **pill-shaped inputs** (52 px, radius 26, `#17120F`/`#2E2621`, eye reveal) → **Sign in** copper pill → **Sign in with passkey** ghost → `New node? Create the first account →` copper → footer `Self-hosted · No custodian · Connected to your node`. Signup/recover/legal reuse this centered pattern.

### Sent — `4a` · after broadcast
Send breadcrumb + stepper (`Amount · Review · Sign · Broadcast` — Broadcast lit) at top; centered: **ring-sweep moment** — two cream rings sweep out from a glowing core (2.4 s ease-out, delays 0.2 s/1 s, once), dashed mempool ring keeps pulsing; `0.2500 BTC is on its way`; sub `From Cold Storage · in the mempool, waiting for its first ring · 12 sat/vB · ≈ 10 min`; txid pill + copy; **Watch it get buried** (copper) / **Done** (ghost); footnote "We'll nudge you at the first ring — and at six, when the wood closes." (This page keeps its soft radial aura — the one allowed glow moment.)

### First sync — `1a` · IBD
Pre-auth full screen (`#1A1614`): header mark + `umbrel-node.local` pill. Left: 480 px canvas — **the wood grows** as the node verifies: disc expands, one ring hardens per epoch passed (flash on completion), halving rings land cream, bark = bright verifying frontier with a rotating scan highlight, glowing core. Right column: eyebrow `FIRST SYNC · INITIAL BLOCK DOWNLOAD`, live serif height `of 956,237`, progress hairline + `N of 475 rings laid` / `%`, **"Verifying 2017 — SegWit summer"** context card (year notes for 2009–2026 are in the source), explainer copy, `9 peers · ≈ 3 h 40 m remaining`, "You can close this. Syncing continues on the node." On completion: sage `SYNCED · FOLLOWING THE TIP` state + one full sweep.

---

## Screens — mobile (390×844)

Patterns from `2b` + `6a`–`6f`; measurements in Layout above. Home `2b`: avatar / `at tip · 956,237` dial pill / scan · centered balance 54 + chip · Send/Receive pills · edge-to-edge sparkline · Activity rows · tab bar. Send `6a`: centered 62 px amount, hairline TO, fee toggles, full-width Review pill. Sign `6b`: quorum arc in eyebrow (`SIGN ⊙ 1 OF 2`), key rows with **Sign now**, compact verify k/v, Export/Finish-later. Receive `6c`: 248 px QR, address, Copy+Rotate pills. Wallet `6d`: balance 54, pills, 104 px chart, tx rows. Explorer `6e`: height 48, 80 px chain strip, latest-rings rows, tab bar (Explorer active). Sent `6f`: the 4a moment with stacked full-width pills. Activity/Settings mobile: apply the same list grammar (not mocked).

## Microstates — `4c`
- **Pills:** hover = `#EFA06B` + bigger glow; pressed = `#D9884F` + `scale(.97)`; 120 ms ease-out both ways; disabled = `#2A2320` bg / `#6B6058` text, no shadow.
- **Input focus:** copper border + 3 px `rgba(232,147,90,.12)` ring; 1.5 px copper caret blinking 1.1 s step-end.
- **Toast:** pill `#201A16`/`#2A2320`, sage check + message + mono detail; slides up 8 px with fade, holds 2.4 s, never stacks.
- **Modal:** only for irreversible acts (broadcast, factory reset). 18 px radius, title + consequence copy ("Once it takes a ring, there is no undo."), Cancel text-button + copper confirm.
- **Loading:** ring-arc spinner (copper arc on `#2A2320` track, 1.2 s linear spin, core dot) — never a generic spinner; skeletons = warm shimmer `#17120F→#241C15→#17120F`, 1.6 s linear.

## Motion reference
| Name | Spec | Use |
|---|---|---|
| hwPulse | opacity .45↔1 · 2.4–2.6 s ease-in-out ∞ | tips, live dots, dashed mempool rings |
| hwBlink | opacity 1↔.28 · 2.4 s ∞ | status dots |
| hwSweepOnce | scale .18→1 + fade · 2.4 s ease-out · once | sent moment, ring-close |
| hwGrow | dashoffset→0 · 1.8 s ease-out | chart line draw-in on mount |
| hwShimmer | bg-position 200%→−200% · 1.6 s linear ∞ | skeletons |
| hwSpin | 360° · 1.2 s linear ∞ | ring-arc spinner |
| hwBreathe | scale 1↔1.05 · 9 s ∞ | first-sync / sent aura only |
Respect `prefers-reduced-motion` (v1 used a `data-motion="false"` root flag → `animation-play-state:paused`).

## State & live data
- **Node:** tip height `h`; epoch index `N = floor(h/2016)`; forming-ring number `N+1`; progress `h − N·2016` of 2016; close ETA `blocksLeft × 10 min`. Drives dial, status pills, explorer hero, node page. New block: dial/strip tip pulse + activity "New ring segment".
- **Confirmations per tx:** `h − txBlock + 1` → burial glyph + meta string (cap visual at 6 = sealed).
- **Home/Wallet:** balance (+ hide toggle, persisted), fiat rate, chart range (24h/7d/30d) + per-range delta.
- **Send:** amount/unit, address validation, fee tier (live tiers), PSBT draft + per-key signature status (resumable, stored on node).
- **Sync:** progress %, current height, mapped year + note, rings laid, ETA, peers → synced state.
- Poll/WebSocket: tip, fees, mempool, peers. Node data comes from the user's own backend — no third-party APIs.

## Route coverage (all ~45 routes → these patterns)
Signup/Recover/Legal/Error → `5i` centered · First sync → `1a` · Home → `2a` (empty state: v1 brief + this grammar) · Send review/broadcast/sent → `5a`/`5b`/`4a` · Stateless signer + signing methods → `5b` · Wallet list/wizards → `2a` rows + `5a` steps · Wallet detail → `5d` · Explorer home/mempool/difficulty/tx/address → `5e` (+ `3f`-content block detail) · Activity → `5f` · Admin ×8 → `5g` rows + `5f` feed · Settings/notifications/contacts/recovery-setup → `5h`. Full per-route content: v1 `original-brief.md`.

## Assets
- **Fonts:** Inter + Source Serif 4 (Google Fonts in prototype — **self-host** for offline nodes).
- **Icons:** all inline stroke SVGs, `stroke="currentColor"`, ~1.6 weight. Lucide equivalents: layout-grid, wallet/credit-card, activity, sliders-horizontal, server, search, arrow-up/down, copy, eye, key-round, scan-line, chevron-right/left, check, clock. Explorer icon = three concentric circles (custom, branded).
- **Logo:** rebuild from `HeartwoodMark.dc.html` (svg, no rasters).
- **QR:** real library, modules `#E4D8CC` on the page background.
- No raster images anywhere.

## Files
```
design_handoff_heartwood_v2/
├── README.md                                ← this spec
└── source/                                  ← open the app file in a browser to view
    ├── Heartwood App - Signature.dc.html    ← ALL screens (ids 2a/2b, 5a–5i, 4a, 1a, 6a–6f, 1c, 4c)
    ├── HWRail.dc.html                       ← desktop nav rail component
    ├── HeartwoodMark.dc.html                ← the rings logo component
    ├── Heartwood Timechain.dc.html          ← full-chain dendrochronology experience (phase 2)
    ├── ios-frame.jsx                        ← iPhone frame used by mobile mocks (viewing only)
    └── support.js                           ← prototype runtime (viewing only — do not ship)
```
*Product/backend spec, per-route content, v1 tokens: see the earlier `design_handoff_heartwood` package.*
