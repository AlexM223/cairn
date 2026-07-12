# Explorer Punch List -- 2026-07-12

Block-explorer elevation plan, 2026-07-12, produced by the research/audit session for the UX orchestrator (companion to docs/UX-PUNCHLIST-2026-07-12.md). Cross-checked against the existing beads backlog before filing -- see the dedup note at the end for what's already tracked, what's flagged instead of filed, and what's genuinely new.

Note: this audit pass seeded one throwaway non-admin user (id=20, `explorer-audit@local.test`) into the local dev DB (`C:/dev/cairn/data/cairn.db`) plus a seed script under the scratchpad, both left for cleanup -- flagged separately, not part of this doc's findings.

---

# Block-Explorer Elevation Plan — Heartwood

## Coverage & method
- **Code audit:** read every explorer route (`index`, `tx`, `block`, `address`, `mempool`, `mempool/blocks`, `difficulty`), the feature-flag registry + `requireFeature` gate, and all 9 wallet→explorer link sites.
- **Visual audit (browser, tab-4 @ localhost:5173, throwaway user `explorer-audit@local.test`):** captured **desktop + mobile** of the explorer index, the tx-detail Core-RPC state, home, and sign-in.
- **Two hard limitations to note:** (1) this dev instance has **no chain backend** ("Can't reach the Bitcoin network"), so live-data views rendered as **error / Core-RPC-required / empty** states — which is exactly the required error-state coverage, but I did not see rich populated block/tx/address data render; (2) the built-in Browser pane is **shared with other agents and unstable**, and full `navigate()` drops the httpOnly session cookie, so I moved via in-app clicks where possible. Pages I did **not** see rendered (mempool, difficulty, block-detail, address-detail, mempool/blocks viz) are assessed from code and are **marked [code]** below.
- **Cleanup note:** I inserted one throwaway non-admin user (`id=20`, `explorer-audit@local.test`) into `C:/dev/cairn/data/cairn.db` and left a seed script at `…/scratchpad/seed-audit-user.mjs`. Delete the row/script when convenient.

The headline: this explorer is **already purpose-built, not bolted-on** — the "timechain/rings/grove/burial-rings" metaphor is cohesive, every page has plain-language `HowItWorks` panels and `Term` tooltips, SWR + streaming + skeletons are wired, and mobile CSS exists on every page. The elevation work is about **degradation, consolidation, seamless wallet↔explorer hand-off, and a few first-class patterns** it's missing — not a rebuild.

---

## Part 1 — What makes best-in-class explorers feel first-class

**mempool.space** (the bar):
- **Forward-looking projected blocks on the homepage** — the signature move. A row of "upcoming blocks" (green, left of the dashed line) beside confirmed blocks (right), each showing median fee-rate + tx count, recomputed every ~2s. This *is* why people open an explorer (fee-checking), and it's front-and-center.
- **Transaction page:** explicit **confirmation count**, an **ETA** for unconfirmed ("~10 min" / "In N blocks"), an **Accelerate** button next to the ETA, clear **RBF** treatment, and **fiat** alongside BTC on every amount/fee.
- **Plain-language docs** surfaced (FAQ/RBF explainers linked inline).

**blockstream.info:** clean, dense, tabular; strong address pages with received/sent/balance; less hand-holding, more data — the "reference" feel.

**Consumer-wallet hand-off (BlueWallet / Muun):** a transaction row is a **friendly line** (direction icon + amount + relative time + confirm status), and tapping it opens an in-app **detail sheet** first; "View on block explorer" is a secondary action that deep-links to the txid. The hand-off is one tap, always available, and the explorer is a *confirmation-of-truth* layer, not the primary surface. Amounts are shown in fiat + BTC everywhere.

**The through-line:** first-class = (a) forward fee visibility up front, (b) plain-language status ("what does this mean for me right now"), (c) fiat, (d) a frictionless, always-working tap from a wallet row to explorer detail and back.

Sources: [mempool.space](https://mempool.space/), [mempool.space/rbf](https://mempool.space/rbf), [mempool FAQ](https://mempool.space/docs/faq), [mempool blocks concept](https://typefully.com/teemupleb/mempoolspace-a-guide-to-bitcoin-2gj3658).

---

## Part 2 — Internal inventory

**Pages** (all under `src/routes/(app)/explorer/`):
| Route | Purpose | Backend need |
|---|---|---|
| `+page.svelte` | Timechain overview: search, tip-height hero, difficulty-epoch "chain strip", latest "rings", pending row | Electrum/Esplora (SWR snapshot) |
| `tx/[txid]/+page.svelte` | Tx detail: BurialRings depth, RBF timeline, CPFP badges, in/out flows, raw hex | **Bitcoin Core RPC** |
| `block/[id]/+page.svelte` | Block detail: depth pill, locator strip, header disclosure, tx list (25/pg) | **Bitcoin Core RPC** |
| `address/[address]/+page.svelte` | Balance hero, QR, stats, running-balance history table, load-more | Electrum/Esplora |
| `mempool/+page.svelte` | Waiting-room: projected rings, fee tiers, fee distribution, 2h backlog trend | Electrum + mempool.space-compatible for rich bits |
| `mempool/blocks/+page.svelte` | **Projected-blocks treemap viz** (keyboard-navigable, fee legend) | mempool.space-compatible |
| `difficulty/+page.svelte` | Difficulty "thermostat": projected adjustment, epoch progress, halving countdown, retarget history | Electrum + rich bits |

**Feature flag:** a single `explorer` flag (`src/lib/server/featureFlags/registry.ts:111`) gates the **whole section** via `explorer/+layout.server.ts` → `requireFeature` (403 with a user message on any `/explorer/*`). **It defaults OFF on genuinely fresh installs** (`explorerDefaultMigration.ts` — UX Wave A "declutter") but stays ON for any existing install.

**Wallet→explorer link sites (9):** `RecentActivity.svelte:25`, `activity/+page.svelte:340,342`, `wallets/[id]/+page.svelte:797,1099,1120`, `wallets/[id]/send/+page.svelte:721`, `wallets/multisig/[id]/+page.svelte:752`, `wallets/multisig/[id]/send/+page.svelte:729`, `wallets/multisig/stateless/+page.svelte:880`, `NotificationPanel.svelte:119`, plus home `+page.svelte:446` (tip block). Nav + home tour + home mempool strip correctly guard on `flags.explorer !== false`; **the 9 link sites above do not** (see F1).

---

## Part 3 — Prioritized punch list

### P0 — Confusing/broken for non-technical users

**P0-1 · Wallet→explorer links leak & dead-end when explorer is off (the biggest "bolted-on" tell).**
`explorer` defaults **OFF** for new installs, yet the wallet's most natural next click still points into `/explorer/*`, which 403s. Verified in code: `RecentActivity.svelte:25`, `activity/+page.svelte:340-345`, `wallets/[id]/+page.svelte:797/1099/1120` (+ multisig twins), both send-success pages (`…/send/+page.svelte:721`, `multisig/stateless:880`), and `NotificationPanel.svelte:119` all render unconditional `<a href="/explorer/...">`. The home page already models the fix (`+page.svelte:253,441` guard on `flags.explorer`).
- **Fix:** thread `flags.explorer` into these components; when off, render the txid/address as **plain copyable mono text** (reuse `CopyText.svelte`) instead of a link. Cheap, and it's what separates "native" from "bolted-on."
- **Also decide the policy tension:** defaulting the explorer off while the wallet constantly links into it is self-defeating. Recommend either (a) keep a **minimal always-on tx/address read path** for links originating in the wallet, or (b) guard every link site. (a) is more seamless.

**P0-2 · Every wallet tx link dead-ends on Electrum-only backends (verified).**
tx- and block-detail **require Bitcoin Core RPC**; on an Electrum/Esplora-only Umbrel (the documented common case) they show *"Transaction detail needs a Bitcoin Core node."* So a user who taps a tx in Recent Activity, the activity feed, or the "View in explorer" button after sending lands on a node-config notice they (as non-admin) can't act on. Files: `tx/[txid]/+page.svelte:590-601`, `block/[id]/+page.svelte:164-167`, `CoreRpcRequiredNotice.svelte`.
- **Fix (structural):** give tx/block detail an **Electrum/Esplora fallback path** for the core facts (status, confirmations, in/out, fee) so a link from the user's own wallet always resolves to *something*, reserving the Core-RPC notice for the rich extras (raw hex, full mempool projection). This is the single highest-leverage seamlessness fix. If a full fallback is too large, at minimum: when the txid came from the user's own wallet, render the wallet's known facts inline rather than the bare notice.

**P0-3 · Triple "can't reach" banner pile-up (verified, desktop + mobile).**
On the index in an unreachable state, three near-identical messages stack: shell **"Can't reach the Bitcoin network"** (`(app)/+layout.svelte`) + **"First sync — Can't reach your node — still trying"** SyncBanner + in-explorer **"Can't reach chain data sources / Retry"** (`explorer/+page.svelte:386-392`). On **mobile these three fill the entire first screen** — reads as alarming/broken to a newcomer, and says the same thing thrice.
- **Fix:** on `/explorer/*`, suppress the redundant shell + sync banners when the explorer's own chain-data error is showing (or consolidate all three into one state with a single Retry). Copy-cheap; structurally just a conditional.

### P1 — Friction

**P1-1 · Empty hero skeleton + dangling poetry (verified).**
When `tipHeight` is null the hero shows a **skeleton box that never resolves** followed by "**blocks · not one removed**" — half-loaded and cryptic (no number precedes "not one removed"). `explorer/+page.svelte:396-403`.
- **Fix:** in the unreachable/`showError` state, replace the skeleton hero with an explicit "Chain data unavailable" hero rather than a perpetual skeleton.

**P1-2 · Empty-state copy contradicts the error banner (verified, copy-only).**
Banner says "Can't reach chain data sources," but the Latest-rings empty state says **"Nothing found at this height range"** — because `chainError` is null on the snapshot path even when the SWR refresh failed (`explorer/+page.svelte:485-491` keys off `chainError`, not `syncFailed`).
- **Fix:** thread `syncFailed/showError` into the empty state so it reads "Chain data is unavailable right now."

**P1-3 · No fiat anywhere (structural).**
tx/block/address amounts and fees are BTC-only ("0.00042 BTC fee"). Best-in-class shows fiat alongside. The app already has portfolio/fiat plumbing.
- **Fix:** optional fiat on amounts + fees in `tx`, `address`, `block`.

**P1-4 · Unconfirmed tx has no "speed it up" path.**
The tx page shows burial label + a fee-outlook sentence but **no explicit "N/6 confirmations" count** and **no bump CTA**, despite a `fee_bumping` feature existing. mempool.space puts Accelerate next to the ETA. `tx/[txid]/+page.svelte:184-251`.
- **Fix:** for an unconfirmed tx the user owns, add a "Speed this up" link into the RBF/CPFP send flow; add an explicit confirmations count next to the glyph.

**P1-5 · Forward-looking projected blocks are two clicks deep (structural).**
The index shows only *past* rings + one dashed "pending" row; the mempool.space-style **projected next blocks** (the thing users open an explorer to check) live at `/explorer/mempool → "Visualize"`. The excellent treemap in `mempool/blocks/+page.svelte` is buried.
- **Fix:** surface a compact **projected-next-rings strip on the index** (fed by the same `mempoolBlocks` snapshot already loaded), linking into the full viz. Biggest single "feels first-class" upgrade.

**P1-6 · Mobile: shell/sync chrome pushes the hero down even in the happy state.**
Beyond P0-3's error case, the two shell banners + eyebrow consume the first mobile screen before the tip-height hero.
- **Fix:** collapse shell network + sync status into one compact chip on mobile.

### P2 — Polish

- **P2-1 (verified, copy):** tx not-found **`<title>` says "Transaction not found"** while the body shows "needs a Bitcoin Core node." `tx/[txid]/+page.svelte:140` — make the title match the Core-RPC state.
- **P2-2 (verified):** the `CoreRpcRequiredNotice` **dead-ends non-admins** — no "Back to explorer"/"Search again" button; the only escape is the tiny "‹ Explorer" link scrolled off-top. Add a back/secondary action for non-admins. `CoreRpcRequiredNotice.svelte`.
- **P2-3 (verified, partial):** live **search-as-you-type gave no suggestion** for a full valid address and no "couldn't check" feedback (backend was down; `/api/search` likely errored silently). Add a graceful dropdown state ("checking…"/"couldn't reach — press Enter to try"). `explorer/+page.svelte:180-200,322-333`. *(Environment-limited observation.)*
- **P2-4 (structural):** address **history is a dense 5-col spreadsheet** (`address/+page.svelte:306-391`), cramped on mobile. Muun/BlueWallet use friendly direction+amount+time rows — reuse the `RecentActivity`/BurialRings row grammar for mobile.
- **P2-5 (copy):** the **"ring" metaphor** risks losing first-timers ("ring 441 forming", "no rings yet", "six rings under the bark"). The `HowItWorks` panels explain it but are **collapsed by default**. Either pair "ring" with "block" once in the index hero, or **default the index `HowItWorks` expanded on first visit** (remember dismissal) — cheapest trust-builder for newcomers. `HowItWorks id="explorer"` (`explorer/+page.svelte:561-573`).
- **P2-6:** `mempool` and `difficulty` **[code]** degrade well (explicit "needs a mempool.space-compatible backend" notes), but those degrade-notes are engineer-worded; soften to user language ("Live fee projections aren't available on this instance's data source").

---

## Feature-flag behavior — summary
- **Enforcement is solid:** one `explorer` flag, one layout `requireFeature` guard covering all sub-routes (403 + logged). Nav, home tour tiles, and the home mempool/next-block strip all hide correctly on `flags.explorer !== false`.
- **The leak:** the **9 wallet→explorer link sites do not degrade** (P0-1). With the flag off (the fresh-install default), they become 403 dead links. This is the main flag-related defect and the main seamlessness defect at once.
- **Recommendation:** treat "explorer off" as "explorer *chrome* off, tx/address *lookups from my own wallet* still resolve" — i.e., don't let a decluttering default break the wallet's own hand-off.

## Wallet↔explorer seamlessness — summary
Today the hand-off is a **hard full-page link into a section that may be flag-disabled (P0-1) or backend-disabled (P0-2)**, with no in-wallet detail sheet as a fallback (unlike Muun/BlueWallet). The three highest-impact moves, in order: **(1)** guarantee a tx/address link from the user's own wallet always resolves (Electrum fallback + flag-aware degradation), **(2)** consolidate the triple error state, **(3)** bring forward-looking fee projection onto the index. Do those and the explorer stops feeling like a separate app and starts feeling like the wallet's own truth layer.

**Cheap copy-only wins to batch first:** P0-3 banner consolidation text, P1-2 empty-state wording, P2-1 title, P2-5 gloss/expand-by-default, P2-6 degrade-note wording. **Structural tracks:** P0-1 (flag-aware links), P0-2 (Electrum fallback for tx/block), P1-3 (fiat), P1-4 (bump CTA), P1-5 (index projected-blocks strip), P2-4 (mobile address history).

---

## Dedup note (br cross-check, 2026-07-12)

This report was checked against the existing beads backlog (`br search`/`br show`) before filing new issues. Today's earlier audit passes (labels `audit-2026-07-12`, `beads-audit-2026-07-12`, `qa-2026-07-12`, `clickpath-audit`) already filed beads covering most of the overlap between this Explorer plan and the parallel UX-Elevation Blueprint. Below is the reconciliation; only genuinely-new findings got new beads (filed in this pass, tag `ux-elevation-explorer`).

**Already covered by existing open beads (no new bead filed):**
- **P0-1** (wallet→explorer links leak when the flag is off) -- covered by **cairn-o90e** (link sites flag-gated, partially merged, two files deferred) and **cairn-5yz3.3** (no tx-detail fallback survives when explorer is off). Same defect, already tracked and partly fixed.
- **P0-3** (triple "can't reach" banner pile-up) -- covered by **cairn-7zjo** (two stacked red error banners on Home) and **cairn-obg6** (Explorer no-chain dead end / raw placeholder + jargon). Recommend implementing together per cairn-obg6's own note.
- **P1-1 / P1-2** (dangling skeleton hero + empty-state copy contradicting the error banner) -- same root cause as **cairn-obg6** above; fold into that bead rather than filing separately.
- **P1-3** (no fiat on tx/block/address) -- covered by **cairn-vnfs** ("Fiat equivalents across wallet, send, and tx surfaces"), already partly shipped (dashboard/wallets/RecentActivity); wallet-detail + activity + tx/block/address explicitly named as remaining work in its own comment thread.
- **P2-5** (ring metaphor risks losing newcomers) -- overlaps **cairn-vxbk** ("Unexplained jargon on auth + nav surfaces ... TIMECHAIN/rings metaphor unlabeled"); vxbk is broader (auth+nav) but already scopes in the rings metaphor. Not re-filed; note in vxbk if the HowItWorks-default-expanded idea isn't already in scope.

**Flagged, not filed as a bead (conflicts with a settled architecture decision):**
- **P0-2** (Electrum fallback for tx/block on Core-RPC-only backends) -- the `cairn-zoz8` epic (Esplora removal) explicitly decided this must be an "honestly-labeled removal/CTA, never a silent degrade," and **cairn-zoz8.9** already shipped the `CoreRpcRequiredNotice` component for exactly this state (closed 2026-07-10). Proposing an Electrum-data fallback here would reverse that product decision -- flagging for Alex rather than filing a contradicting bead.

**Genuinely new -- beads filed this pass (see IDs in the commit/report):**
- **P1-5** -- forward-looking projected-blocks strip is buried two clicks deep on the Explorer index (mempool.space's signature move); no existing bead.
- **P1-4** -- unconfirmed tx detail page has no explicit confirmation count and no speed-up/accelerate CTA; no existing bead.
- **P2-2** -- `CoreRpcRequiredNotice` (already shipped via zoz8.9) dead-ends non-admin users with no back/secondary action; a gap in the shipped component, not covered by zoz8.9's closure notes.
- **P2-1 / P1-6 / P2-3 / P2-6** (tx-not-found title mismatch, mobile shell-chrome crowding the happy-path hero, silent search-as-you-type failure, engineer-worded mempool/difficulty degrade notes) -- bundled into one small copy/polish bead since none had an existing match and each alone is too small to track separately.
