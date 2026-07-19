# Transaction Block Context — Design

BlueWallet-style block visualization on the transaction detail page: the block the
tx landed in, its neighbours in a row with dates, the tx's position inside the
block, a plain-language confirmation summary, and a confirmation badge. Every block
taps through to the explorer's block detail page.

Status: design. Target page: `src/routes/(app)/explorer/tx/[txid]/+page.svelte`
(the canonical tx-detail page — the wallet detail page's tx rows already link
straight to it, and it already renders the "involves your wallet" ownership badges,
so this *is* the wallet's transaction-detail view).

---

## 1. Progressive-enhancement tiers (data-source rule)

This feature is **not** Core-RPC-only. It degrades across three tiers driven by
which backend answers. The response carries an explicit `richness` field and every
enrichment-only field is nullable.

| Tier | Condition | What renders |
|------|-----------|--------------|
| `none` | Neither Electrum nor Core answered (transient) | "Connecting to your node…" placeholder + retry. No fake data, **no external API fallback.** |
| `basic` | Electrum reachable (typical Umbrel, no Core) | Confirmation count + badge, block height, **all three block dates**, **exact tx position**, plain-language summary (size/fee clauses dropped if unknown). Block graphic drawn without size/fullness. |
| `full` | Core RPC also reachable | Everything in `basic` **plus** per-block tx-count / size / fullness, exact block total for proportional position fill, and block size in the summary. |

**Per-item source selection (the "richest source wins where they overlap" rule):**

| Data item | basic (Electrum) | full (Core) | Chosen source |
|-----------|------------------|-------------|---------------|
| Confirmations | `tip − height + 1` (tip from `headers.subscribe`) | same | Electrum tip (already cached) — **never cached, always fresh** |
| Block height | `tip − confirmations + 1` (from verbose tx) | from tx | Electrum |
| Neighbour hash + timestamp | `blockchain.block.header(h)` → `decodeBlockHeader` | `getblockheader` | **Electrum** (cheap, no Core dependency) |
| Tx position (`pos`) | `blockchain.transaction.get_merkle(txid,h)` → `.pos` | — | **Electrum** even when Core is present (a merkle proof is far cheaper than `getblock` v1) |
| Block tx-count / size / fullness | — | `getblockstats(hash,[txs,total_size,total_weight])` | Core only |
| Position total (denominator) | estimate `2^merkle.length` (nTx ≈ from proof depth) | exact `getblockstats.txs` | Core exact, else Electrum estimate |

Rationale for **not** using `getblock verbosity=1`: it returns the block's entire
txid array (often 3,000+ hashes, ~200 KB) purely to locate one index. Electrum's
merkle proof returns `pos` directly in a few hundred bytes and is exact. So position
comes from Electrum in *every* tier; Core is used only for the cheap `getblockstats`
aggregate. This keeps the cost of the feature to a handful of small round-trips.

---

## 2. Companion change (required for basic tier) — `getTxViaElectrum`

Today `ChainService.getTx` is Core/esplora-gated (`src/lib/server/chain/index.ts`
~L1021): on a pure-Electrum Umbrel it throws and the tx page renders
`CoreRpcRequiredNotice` — so at basic tier there would be no page to host the
section. Fix is small and high-leverage because a full-indexing Electrum server
(electrs / Fulcrum) returns Core's **exact** `getrawtransaction verbose` JSON, which
already matches the `CoreRawTx` interface and maps through the existing
`toTxDetailFromCore`.

Add, as the final fallback inside `getTx` (after core, after esplora):

```ts
// Electrum-only fallback: a full-indexing server decodes any confirmed/mempool tx
// via blockchain.transaction.get(txid, true) — Core's verbose shape exactly. No
// prevout, so fee + input addresses/values degrade to null (same as older-Core
// verbose=true path); everything block-context needs (blockhash/blocktime/
// confirmations/size/vsize) is present.
try {
  const raw = (await this.electrum.getTransaction(txid, true)) as CoreRawTx;
  const tip = await this.getTip().then((t) => t.height).catch(() => null);
  return toTxDetailFromCore(raw, { tipHeight: tip });
} catch (e) {
  if (/no such mempool or blockchain transaction|not found/i.test(String(e)))
    throw notFound(txid);   // reuse existing not-found signalling
  throw e;
}
```

This unlocks the tx page (and therefore this feature) for Electrum-only deploys with
near-zero new mapping code. The `feeRate`/`fee` being null there is handled by the
summary copy (clauses dropped). Covered by the existing `getTx` not-found tests plus
one new case (see §9).

---

## 3. Server: `getTxBlockContext`

New method on `ChainService` (`src/lib/server/chain/index.ts`). Never throws — always
resolves to a `BlockContext` (returns `richness: 'none'` on total failure so the UI
shows the honest connecting state).

```
getTxBlockContext(txid): Promise<BlockContext>
  1. tip = await getTip()                          // cached; failure ⇒ richness 'none'
  2. verbose = await electrum.getTransaction(txid, true)   // confirmations, blockhash, blocktime
        - if unconfirmed (confirmations 0 / no blockhash) ⇒ { richness:'basic', confirmed:false, … }
  3. height = tip.height − confirmations + 1
  4. neighbours: for h in clamp([height-1, height, height+1], 0..tip.height):
        decodeBlockHeader(await electrum.getBlockHeader(h)) → { height, hash, time }
        (each wrapped in its own catch → that neighbour degrades to time:null)
  5. position:
        proof = await electrum.getMerkleProof(txid, height)   // → { pos, merkle }
        pos = proof.pos;  estTotal = 2 ** proof.merkle.length  // basic-tier denominator
  6. if this.core (full tier): for each neighbour, getBlockStats(hash,[txs,total_size,total_weight])
        → txCount, size, fullness; center block's exact txs becomes positionTotal
        (served from the existing immutable blockStatsCache; steady state only the
         tip block ever hits Core)
  7. confirmations = max(1, tip.height − height + 1)          // recomputed fresh
  return BlockContext{…}
```

All Electrum primitives already exist on `ElectrumPool`: `getTransaction`,
`getBlockHeader`, `getMerkleProof`, and `getTip` (via `headersSubscribe`). No new
transport code.

### Delivery to the page

Stream it through the **existing** `loadTxDetails` in
`src/routes/(app)/explorer/tx/[txid]/+page.server.ts` (it already streams
fees/rbf/cpfp/rawHex and never rejects). Add `blockContext: chain.getTxBlockContext(tx.txid).catch(() => nullCtx)`
to the streamed bundle. No client fetch, one code path, paints after first paint like
the other supplementary details.

Also expose a standalone endpoint for reuse from the wallet detail page (Phase 2,
optional) and manual QA:

`GET /api/tx/[txid]/block-context` → `BlockContext` (200 always; `requireUser`;
reuses `getTxBlockContext`). File: `src/routes/api/tx/[txid]/block-context/+server.ts`.

### Caching

| Datum | Strategy |
|-------|----------|
| Neighbour header (hash, time) | Immutable by **hash** once buried; cache by height with a short TTL only for heights within 6 of tip (reorg window). Reuse the `chain/cache.ts` LRU idiom. |
| Merkle `pos` | Immutable per (txid, height); cache by txid. A reorg changes height ⇒ key miss ⇒ refetch. |
| `getblockstats` | **Already** immutable-cached by hash (`getCachedBlockStats`/`cacheBlockStats`) — reuse as-is. |
| Confirmations / tip | **Never cache.** Always `tip − height + 1` from the live (10-min-ceiling, header-event-invalidated) tip cache. |

Cost at steady state: a warm buried tx re-render is one live tip read + cache hits;
a cold view is ~3 header fetches + 1 merkle proof (+ up to 3 cached-or-fresh
`getblockstats` on Core). No `getblock` v1, no whole-block fan-out.

---

## 4. Data contract

Add to `src/lib/types.ts`:

```ts
export type BlockContextRichness = 'none' | 'basic' | 'full';

export interface BlockContextNeighbor {
  height: number;
  hash: string | null;       // null if header unavailable
  time: number | null;       // unix seconds (block timestamp)
  txCount: number | null;    // full tier only
  size: number | null;       // bytes, full tier only
  fullness: number | null;   // 0..1 (weight ÷ 4M), full tier only
  isCurrent: boolean;        // the block containing this tx
}

export interface BlockContext {
  richness: BlockContextRichness;
  confirmed: boolean;
  height: number | null;            // center block height
  confirmations: number | null;     // tip-relative, always fresh
  tipHeight: number | null;
  position: number | null;          // 0-based tx index within its block (from merkle pos)
  positionTotal: number | null;     // block tx count (full: exact; basic: est or null)
  positionEstimated: boolean;       // true when positionTotal came from merkle-depth estimate
  neighbors: BlockContextNeighbor[]; // ascending height, 1–3 entries
  // Tx-level facts echoed for the summary (may be null at basic tier):
  vsize: number | null;             // vB
  fee: number | null;               // sats
  feeRate: number | null;           // sat/vB
  coreConfigured: boolean;          // drives the quiet admin-only "connect Core" hint
}
```

---

## 5. UI: component breakdown

New section on the tx page, placed **directly under the existing `.status` row**
(which owns the burial glyph + "in block N" line) and above `.metrics`.

### `BlockContext.svelte`  (new — `src/lib/components/heartwood/`)
Props: `ctx: BlockContext | null` (null ⇒ streaming), `isAdmin: boolean`.
Renders, top to bottom:
1. **Confirmation badge** (req 4) — pill. `≥6` → green (`var(--sage)`/success bg)
   reading **"6+ confirmations"**; `1–5` → neutral/amber "N confirmation(s)";
   unconfirmed → amber "Unconfirmed". Paired with a small `BurialRings` glyph so it
   stays on-brand. *(Deviation from the pure "buried N rings deep" house copy is
   intentional — Alex specified the literal "6+ confirmations" green badge for this
   element.)*
2. **Three-block row** (req 1, 2) — `MiniBlock` ×(1–3), ascending height, current
   block centered/emphasized. Under each block: its date (`formatDateTime` short /
   `timeAgo`). Wrapped in an `overflow-x:auto` rail so it never breaks the page on
   narrow screens.
3. **Plain-language summary** (req 3) — one sentence from `blockContext.ts` (below).

### `MiniBlock.svelte`  (new)
Props: `neighbor: BlockContextNeighbor`, `position`, `positionTotal`,
`positionEstimated`, `richness`. Renders an `<a href="/explorer/block/{height}">`
(req 5) wrapping a rounded-square SVG block:
- **full tier**: square filled proportionally to `fullness`; interior drawn as a
  small cell grid; the tx's cell (`position/positionTotal`) highlighted in accent.
- **basic tier** (no size/total): fixed rounded square with a single highlighted pip
  at the fractional `position/estTotal`, labelled `#{position}` — reads as intentional,
  not broken.
- current block: accent border + subtle glow; neighbours: hairline border, muted.
- height label inside/above (`formatNumber`); date caption below.

### `blockContext.ts`  (new util — same folder, testable, pure)
`summaryLine(ctx): string` builds req 3, dropping unknown clauses:
- confirmed, full: `"Confirmed 97 blocks ago on block 948,197. With a size of 110 vB
  and a fee rate of 2 sat/vB, paying a 224 sat fee."`
- confirmed, basic (no vsize/fee): `"Confirmed 97 blocks ago on block 948,197."`
- 1 conf: `"Confirmed in the latest block, 948,197."`
- unconfirmed: `"Waiting in the mempool — not in a block yet."`
Also `confirmationBadge(ctx): { label, tone }`.

### Reuse (exact files)
- `src/lib/components/heartwood/BurialRings.svelte` — confirmation glyph + `burialRingsLabel`.
- `src/lib/format.ts` — `formatNumber`, `formatBytes`, `formatFeeRate`, `formatSats`,
  `timeAgo`, `formatDateTime`.
- `src/lib/components/Term.svelte` — tooltips on jargon (vB, fee rate).
- CSS tokens already in use on the tx page: `--sage`, `--sage-muted`, `--accent`,
  `--accent-bright`, `--hairline`, `--text-*`, `--radius-status-pill`, `--radius-badge`,
  `--success-border`. Theming is token-driven ⇒ light/dark handled for free
  (`explorer/block/[id]` and `explorer/tx/[txid]` are the styling reference).

### Mobile (375 px)
Block rail: each `MiniBlock` ~92 px, `gap:12px`, `overflow-x:auto` with
`scroll-snap`; current block scrolled into view on mount. Summary wraps to 2–3 lines.
Badge stays inline. Matches the `@media (max-width:900px)` block already on the page.

---

## 6. Honest degrade decisions

- **NEITHER backend** (`richness:'none'`): render a compact "Connecting to your node…"
  placeholder with a spinner and a Retry (re-invalidate `cairn:tx`). No Core nag here —
  the cause is transient reachability, not missing Core.
- **basic tier**: the section is fully functional-looking (dates + position + badge +
  summary). **No prominent "connect a Bitcoin Core node" notice** — that would make a
  perfectly good Umbrel-Electrum deploy feel broken, violating the brief. The only Core
  affordance is a *quiet, admin-only* one-liner under the disclosure: "Block sizes and
  exact block contents need a Bitcoin Core node — configure it in admin settings."
  Non-admins never see it.
- **Tapping a neighbour at basic tier**: still links to `/explorer/block/{height}`.
  That page is Core-gated and will show its own `CoreRpcRequiredNotice` — honest and
  consistent with the rest of the explorer. Documented, accepted.
- Never invent a fallback to a third-party API (the Esplora-removal cardinal rule).

---

## 7. Edge-case table

| Case | Handling |
|------|----------|
| Unconfirmed tx (mempool) | `confirmed:false`; no block row; render mempool/"forming" state + summary "Waiting in the mempool — not in a block yet." Reuse `BurialRings` mempool (0-conf) glyph. |
| Tx just confirmed (1 conf, height == tip) | No next block; row = `[height-1, height]`. Summary "Confirmed in the latest block, N." |
| Tx at tip generally (`height == tipHeight`) | `neighbors` omits `height+1` (clamped). 2-block row. |
| Genesis block (height 0) | No `height-1`; row = `[0, 1]`. `getBlockHeader(0)` works via Electrum. |
| Coinbase tx | `position == 0` (first tx). Marked "block reward" in the cell tooltip. |
| Reorg while viewing | Confirmations recomputed from live tip each render; if `height > tip` (racey) clamp to tip and re-derive. Cached `pos` keyed by (txid,height) misses on the new height ⇒ refetch. |
| Merkle proof unsupported / fails | `position:null` ⇒ block row renders without the position marker; summary drops the position clause. Never blocks the rest. |
| A neighbour header fetch fails | That neighbour → `time:null`, hash:null; its cell shows height only, no date. Others unaffected. |
| Very large block (basic tier) | `positionTotal` estimated from merkle depth (`positionEstimated:true`); marker placed fractionally, `#pos` label authoritative. |
| Electrum-only, tx not found | `getTxViaElectrum` maps electrs "No such… transaction" → existing not-found ⇒ page's not-found state. |
| Tip unavailable | `getTip` fails ⇒ `richness:'none'` connecting state. |

---

## 8. File change list

**New**
- `src/lib/components/heartwood/BlockContext.svelte` — section (badge + row + summary).
- `src/lib/components/heartwood/MiniBlock.svelte` — one tappable block glyph.
- `src/lib/components/heartwood/blockContext.ts` — pure copy/badge helpers.
- `src/lib/components/heartwood/blockContext.test.ts` — summary/badge unit tests.
- `src/routes/api/tx/[txid]/block-context/+server.ts` — standalone endpoint (reuse from wallet page / QA).

**Modified**
- `src/lib/types.ts` — add `BlockContext*` types (§4).
- `src/lib/server/chain/index.ts` —
  - add `getTxBlockContext(txid)` (§3);
  - add the `getTxViaElectrum` fallback inside `getTx` (§2).
- `src/lib/server/chain/cache.ts` — add header-by-height (reorg-windowed) + merkle-pos
  caches (mirror existing `blockStatsCache` idiom).
- `src/routes/(app)/explorer/tx/[txid]/+page.server.ts` — stream `blockContext` inside
  `loadTxDetails` result.
- `src/routes/(app)/explorer/tx/[txid]/+page.svelte` — mount `<BlockContext ctx={…}
  isAdmin={data.isAdmin} />` under `.status`; wire the streamed value like `details`.

**Tests**
- `src/lib/server/chain/blockContext.test.ts` — `getTxBlockContext` tiering
  (Electrum-only ⇒ basic; +Core ⇒ full; tip-fail ⇒ none) with a mocked pool/core.
- `src/routes/(app)/explorer/tx/[txid]/page.server.test.ts` — extend for the streamed
  field + the Electrum-only `getTx` path.

---

## 9. Test plan

**Unit (pure)**
- `blockContext.summaryLine`: full / basic / 1-conf / unconfirmed / missing-fee / missing-vsize.
- `confirmationBadge`: 0, 1, 5, 6, 100 → correct label + tone (green at ≥6).
- `MiniBlock` position math: pos 0 (coinbase), mid, last; estimated vs exact total.

**Service (mocked ElectrumPool + CoreRpcClient)**
- Electrum-only: `richness:'basic'`, 3 neighbours with dates, exact `pos`, null size/txCount.
- +Core: `richness:'full'`, txCount/size/fullness populated, exact `positionTotal`.
- Tip failure ⇒ `richness:'none'`. Neighbour header failure ⇒ that entry `time:null`.
- Unconfirmed ⇒ `confirmed:false`, no neighbours.
- Genesis / at-tip clamping (1–2 neighbours).
- `getTxViaElectrum`: verbose electrs tx maps to a TxDetail with null fee (no prevout);
  not-found string ⇒ not-found error.

**Manual / browser QA** (per repo rule — built-in browser, screenshots incl. 375×812)
- Regtest with Core: confirmed owned tx → full-tier row, position dot, summary, tap a
  neighbour → block page.
- Regtest Electrum-only (unset `core_rpc_url`): same tx → basic tier still looks
  intentional (dates + position + badge), no Core nag for non-admin, quiet hint for admin.
- Mempool tx → pending state, no row.
- Tip block tx → 2-block row. Genesis (regtest block 0/1) → clamp.
- Light + dark theme; mobile rail scroll/snap.

---

## 10. Copy (Cairn UX philosophy)

Plain language, no exposed internals beyond what Alex's own sample uses (vB, sat/vB
are acceptable, wrapped in `Term` tooltips). Examples:
- Summary: "Confirmed 97 blocks ago on block 948,197. With a size of 110 vB and a fee
  rate of 2 sat/vB, paying a 224 sat fee."
- Badge: "6+ confirmations" (green) — with tooltip "Six blocks deep is the customary
  point at which a payment is treated as settled."
- Neighbour tap hint (title): "Open block 948,197 in the explorer."
- Pending: "Waiting in the mempool — not in a block yet."
- Admin-only Core hint: "Block sizes and exact block contents need a Bitcoin Core node."
