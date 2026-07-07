# Handoff: The Wood — Heartwood's sync experience & live chain visualizer

> One canvas experience, two jobs. During initial block download it is the **first-sync screen** ("counting the rings" — the wood grows as your node verifies history). Once synced, the same engine becomes a permanent **visualizer page**: a live, ambient, full-screen portrait of the timechain that node owners leave running on a second screen or wall display. It is Heartwood's signature moment — the thing people screenshot and share from a store full of gray dashboards.
>
> Companion to `design_handoff_heartwood_v3` (the app). This package specs the visualizer as its own deliverable.

---

## About the design files

`source/` contains **HTML design references** (Design Component prototypes needing the bundled `support.js`; open in a browser with the folder intact; internet needed for Google Fonts). **Not production code** — recreate in the app's stack as a real `<canvas>` (2D is sufficient) + rAF component.

- `Heartwood App - Signature.dc.html` → section id **`1a`** is the built first-sync screen (growing wood, live counter, year notes, synced state). This is hi-fi and canonical.
- `Heartwood Timechain.dc.html` → the full **interactive reading instrument** (hover needle + epoch reading, loupe, halving scars, landmark labels, personal marks, core-sample strip, live edge). The visualizer mode inherits its interactions; this file is the reference for all of them, fully working.
- `HeartwoodMark.dc.html` → the rings logo (HUD masthead).

## Fidelity

**High-fidelity** for the sync screen (`1a`) and for every interaction demonstrated in the Timechain file. The visualizer page composition below recombines those two proven pieces; where this README states a value, it is final. Mock numbers (height 956,237, ring 475) are July-2026 fiction — compute live.

---

## The concept

The chain is a tree seen in cross-section. **One ring per difficulty epoch** (2016 blocks ≈ two weeks) — 475 of them as of the mocks — with ring widths **to scale with real epoch duration**: 2009's slow seasons are wide open wood at the core, 2013's ASIC race is a tight band, the 2021 Great Migration is a visibly swollen ring. Genesis is a glowing core. The bark is now. A new ring is forming at the edge, block by block. Nothing is ever removed.

- **Sync mode:** the disc *grows* as the node verifies history — you literally watch 17 years harden onto your disk.
- **Visualizer mode:** the finished disc lives — breathing core, pulsing tip, a ripple per block, a full sweep when a ring closes — and can be *read* like a dendrochronologist reads wood.

## Placement & routes

- `/sync` — shown automatically during IBD / initial wallet scan (pre-auth capable). On completion it **morphs in place** into the visualizer (one sweep, HUD swap) — the sync screen is the visualizer being born; do not hard-navigate away.
- `/visualizer` (nav label: **The Wood**) — permanent page, reachable from the Explorer ("Open the wood →") and the Node page.
- `?kiosk=1` — wall-display mode: HUD always minimal (see below), cursor hidden, no hover affordances, slightly larger type. This is the "put it next to your Umbrel" mode.
- Fullscreen toggle (⤢, top-right, uses the Fullscreen API) on the normal route.

---

## Layout

Full-viewport, background `#0A0807` (deeper than the app's `#100D0B` — this page is the void itself; the wood provides the tree, so no grove field here).

### Sync mode (`1a`, 1280×832 reference — scales fluidly)
- Header row (padding 24 30): rings mark 24 + "Heartwood" Inter 600/16 · right: host pill `⏺ umbrel-node.local` (mono 11, sage blinking dot).
- Center, two columns (gap 64): **480 px canvas** (the growing wood, breathing aura `hwBreathe` 9 s behind it) | **400 px info column**:
  - Eyebrow `FIRST SYNC · INITIAL BLOCK DOWNLOAD` (Inter 600/10.5, .2em, `#B39A88`)
  - Live height — Source Serif 600/46, `#F1E7DD`, tabular — `of 956,237` (Inter 400/13 `#7A6E63`)
  - 3 px progress hairline (copper gradient) · under it `N of 475 rings laid` | `61.0% verified` (11.5 `#8B7F75`)
  - **Year card** (the soul of it): `Verifying 2017` (Inter 600/13.5 `#EDE4DB`) + the year note (12/1.6 `#D8B27A`) on `#201A16`/`#2A2320` r9 — the one boxed element, earned.
  - Explainer (12.5/1.7 `#8B7F75`): "Your node is checking every block since January 2009 on its own hardware — nothing trusted, everything verified. A ring hardens onto the disk for each difficulty epoch passed."
  - Meta `9 peers · ≈ 3 h 40 m remaining` · footnote "You can close this. Syncing continues on the node."
- Footer center: `Self-hosted · No custodian · Verified on your own hardware` (11 `#5E554D`).

### Synced / visualizer mode
- The wood centers and scales up (radius = `min(vw,vh)/2 − 92px` margin for labels).
- **HUD** (fades to 0 after 8 s idle along with the cursor; any pointer movement restores; kiosk keeps only ①+② permanently):
  1. Top-left: mark 24 + `THE TIMECHAIN` eyebrow.
  2. Bottom-left: live height (Serif 600/46) + `ring 475 forming — 653 of 2,016 · closes ≈ Jul 15` + sage live dot.
  3. Top-right: layer chips `Halvings · Landmarks · Your marks` (toggle grammar) + ⤢ fullscreen.
  4. Bottom-right hint: `hover to read · widths to scale — a tight ring is a fast fortnight` (10.5 `#5E554D`).
- **Reading panel** (non-kiosk): hovering the wood shows a floating card near the cursor (bg `rgba(12,9,7,.92)`, hairline copper border, r10): `Ring 342 · Jun 20 – Jul 3, 2021` + rows Blocks / Laid down in / Reward + a note line (specials override width classifier — see tables). Exactly as proven in the Timechain file's side panel; condensed to a card here.

---

## The rendering algorithm (canonical, from the working prototypes)

**Data model.** For each epoch `i` (0…N−1): `b0 = i·2016`, `dur` = real epoch duration in days (derive from the node's own block headers: last-header timestamp − first-header timestamp per 2016-block epoch; the prototypes approximate with anchor dates ±14% in-span noise — anchors at epochs 0/16/28/50/70/85/104/124/140/155/180/208/240/270/300/313/341/342/343/352/380/410/417/445/474 ↔ 2009-01-03…2026-07-01). Per-epoch stable random `n(i) ∈ [0,1)` (seeded — same seed every load so the wood is *your* wood, identical every time).

**Geometry.** `R = min(W,H)/2 − margin`; `coreR = 0.045·R`. Cumulative radii `B[i]`: widths ∝ `dur`, normalized so `Σ = R − coreR`. Organic wobble field (evaluated per angle θ, per base radius B):
`wob(θ,B) = t·(0.020R·cosθ + 0.058R·sinθ + 0.014R·sin(2θ+1.2+1.6t) + 0.006R·sin(3θ−0.5−2.2t))` where `t = B/R` — the k=1 term drifts rings down-right so the **pith sits above-left of center** (brand rule: never a target). Draw with y scaled ×0.965 (slight ellipse). Rings are `B[i] + wob(θ, B[i])` polylines (~90–150 segments).

**Paint order (static layer, cached offscreen; rebuild only on resize / ring events / layer toggles):**
1. Backdrop radial `#141009 → #0D0A08 → #080605` + faint copper aura around the disc (`rgba(232,147,90,.06) → 0` at 1.45R).
2. Wood disc: fill radial `#3B2B1F → #281B12 → #150E0A` (centered on pith).
3. ~14 medullary rays, pith→rim, `rgba(232,147,90,.05)`, 1 px.
4. Grain zones: every 5 epochs, a band-wide stroke alternating `rgba(246,200,154,.012–.03)` / `rgba(0,0,0,.03–.09)`.
5. Sapwood: outer 8 epochs overlaid `rgba(246,200,154,.05)` (recent history is young wood).
6. Ring boundaries, i = 1…N: alpha `0.06 + 0.13·n(i)` (+0.28 for the ~13% of rings with `n>0.87` — "pop" rings), width `(0.55+0.6·n)·dpr`. **Halving epochs (104/208/312/416): cream `rgba(251,225,198,.8)`, 1.5 px, soft copper glow** — plus a small healed **fire-scar wedge** at their assigned angle (dark fill `rgba(10,6,4,.92)`, cream edge) with a `2012 · 50 → 25` two-line label (halo-stroked text).
7. Bark: 5 px near-black crust ring + the newest completed ring bold copper `.9` with glow.
8. Vignette, then landmark/mark pins + labels (layer-gated).
9. Genesis label near core: `genesis · Jan 3, 2009` (10 px `#B39A88`/`#6B6058`).

**Live layer (every frame, composited over the cache):**
- Core: radial glow `rgba(255,238,216,…)` pulsing `0.82+0.18·sin(1.6t)` + 2.6 px white-warm dot.
- **Forming ring**: partial arc at `B[N]+6px`, from −90° clockwise, sweep = `(h − N·2016)/2016 · 360°`, `#F6C89A` .75 with glow; **tip dot** at the arc end, pulsing; on each new block the tip flares (+2.6 px, 900 ms decay) and emits a 30 px ripple ring.
- **Ring close** (block 2016 of the epoch): the arc hardens into a boundary (append epoch, rebuild cache) + one full **sweep** (cream ring expanding core→bark, 4.4 s ease-out) — same motion as the logo.
- Sync mode extras: disc radius = `radius(h)` so the wood grows; **frontier** = bright verifying edge with a rotating 46° scan highlight (`t·1.4` rad/s); each completed epoch flashes its ring cream for 700 ms; halving rings visibly "land."
- Hover (visualizer, non-kiosk): thin needle pith→rim through the cursor (`rgba(246,200,154,.32)`), hovered ring highlighted cream with glow, dot where needle crosses it. Inverse mapping: `θ = atan2(dy/0.965, dx)`, `r −= wob(θ, min(r,R))`, binary-search `B`.

**Performance:** dpr cap 2; static layer offscreen; pause rAF on `document.hidden`; `prefers-reduced-motion` → render once, no pulses/ripples (live height still updates via DOM). Target: composite frame < 2 ms; full cache rebuild < 25 ms (452+ rings × 100 segments).

---

## Content tables

**Year notes** (sync mode "Verifying {year} — …"; switch when the verified height crosses each year):
| Year | Note |
|---|---|
| 2009 | the difficulty is 1 — CPUs whirring in bedrooms |
| 2010 | pizza summer — 10,000 BTC for two pies |
| 2011 | first bubble, first crash, first survival |
| 2012 | the first halving lands in November |
| 2013 | ASICs arrive — the rings tighten |
| 2014 | Gox winter — the chain keeps time anyway |
| 2015 | quiet, steady wood |
| 2016 | the second halving |
| 2017 | SegWit summer |
| 2018 | the long thaw |
| 2019 | steady rings, growing hashrate |
| 2020 | the third halving, weeks after a global shutdown |
| 2021 | the Great Migration — hashrate crosses oceans |
| 2022 | leverage burns off; the chain doesn’t notice |
| 2023 | ordinals fill the blocks |
| 2024 | the fourth halving |
| 2025 | tight, steady rings |
| 2026 | almost caught up — your history now |

**Landmarks layer** (pins: glowing 2.6 px dot at `blockRadius(b)` at a fixed angle, halo-stroked label + sub): Pizza Day `57,043 · May 22, 2010` · SegWit locks in `481,824 · Aug 2017` · The Great Migration `~689,000 · Jun 2021` · Taproot `709,632 · Nov 2021`. **Halvings layer:** scars + labels at 210,000 / 420,000 / 630,000 / 840,000. **Your marks layer** (copper diamonds): the user's own wallet events — wallet created, first deposit, key rotated — pulled from wallet metadata; labels `Cold Storage · first deposit — Feb 2023` style. Assigned angles must avoid the borer/label collisions — reuse the prototype's angle sets.

**Reading card** (hover): title `Ring {i+1} · {date range}`; rows `Blocks a–b` / `Laid down in X.X days` / `Reward {50|25|12.5|6.25|3.125} BTC / block`; note = special (below) else width classifier: `<11.5d` "A tight ring — difficulty racing to keep up with new hashrate." · `>16d` "A wide ring — a slow season on the network." · else "A steady season, close to the ten-minute heartbeat."
**Specials** (by epoch): 0 genesis+headline quote · 28 pizza · 104/208/312/416 halvings · 239 SegWit · 341–342 Great Migration ("The chain doesn't blink.") · 352 Taproot. Forming ring: "The outer edge is still sapwood — soft, live, unfinished. It hardens as the chain buries it."

**Copy bank:** `Count the rings.` · `Every block leaves a ring.` · `{N} rings — one per difficulty epoch` · `genesis at the core · the bark is now` · sync synced-state: `SYNCED · FOLLOWING THE TIP` + "Every ring verified on your own metal. The wood is yours now."

---

## Tokens (subset)

Background `#0A0807` · wood fills `#3B2B1F/#281B12/#150E0A` · ring stroke `#E8935A` · cream `#FBE1C6` · tip `#F6C89A` · core `#FFE9CE` · eyebrow `#B39A88`/`#8F8379` · text `#F1E7DD` (serif) `#EDE4DB` `#A99C90` `#8B7F75` `#7A6E63` `#6B6058` `#5E554D` · note `#D8B27A` · sage `#8AA06E` · card `#201A16`/`#2A2320`. Type: Inter + Source Serif 4 (tabular), mono for hostnames. Motion: hwPulse 2.4–2.6 s · hwBlink 2.4 s · hwBreathe 9 s · sweep 4.4 s ease-out · flash 700 ms · tip flare 900 ms.

## State & data

- Sync: verified height (from node), % = h/tip, rings laid = `⌊h/2016⌋`, ETA from recent verify rate, peer count, year lookup. Phase `sync → synced` (morph, never navigate).
- Live: tip height via WebSocket/poll; forming progress `h − N·2016`; close ETA `blocksLeft × 10 min`; new-block and ring-close events drive the live layer.
- Epoch durations: computed once from headers, cached; append on ring close.
- Layers + kiosk + fullscreen persisted per device (localStorage).
- All data from the user's own node. No third-party APIs.

## Files
```
design_handoff_heartwood_visualizer/
├── README.md                                ← this spec
└── source/
    ├── Heartwood App - Signature.dc.html    ← section 1a = the built sync screen
    ├── Heartwood Timechain.dc.html          ← the interactions, fully working (hover reading, layers, live edge, core sample)
    ├── HeartwoodMark.dc.html                ← the rings logo
    └── support.js                           ← prototype runtime (viewing only)
```
Phase 2 (already designed, in the Timechain file): the **core sample** — drill the trunk, read the straightened strip as a scrubbable timeline with two-way highlighting — and the **loupe**. Both slot into the visualizer page unchanged when you're ready.
