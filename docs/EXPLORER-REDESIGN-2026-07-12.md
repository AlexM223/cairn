# Explorer Redesign — Synthesis & Build Plan (2026-07-12)

Directive: Alex. Design inputs: two deep-reasoner passes (experiential "The Heartwood" vision; data/degradation blueprint). This doc is the build authority.

## Identity

The explorer renders the timechain as a living cross-section grown by YOUR node: mempool = rising sap, the next block = a ring visibly forming (conic-gradient arc driven by seconds-since-last-block, sealing with a one-shot copper bloom on the SSE new-block event), recent blocks = fresh sapwood rows fading into heartwood, deep history = the existing ChainStrip.

Discipline rule: metaphor lives in atmosphere + confirmations; plain language governs all structure/controls.

Provenance line woven everywhere it is TRUE: "Grown and verified by your own node."

## Cardinal rules

1. Absence must read as absence: never render unknown data as 0 (the "0 tx" bug class). Unknown = "—".
2. Trust copy is derived from config, not from what rendered:
   - "Verified by your Bitcoin Core node" ONLY when Core RPC configured + reachable.
   - "Served by your Electrum server" for custom Electrum (never "verified").
   - "Using the public default server" on public fallback — NEVER "your node".
   - "Not connected to a node yet" when never configured.
3. All new chain work goes into the background snapshot refresh, never into a `load()` — explorer loads stay synchronous-SWR (instant paint from snapshot).
4. No whole-block tx fan-outs: block-level superlatives come from `getblockstats` aggregates; "largest txs" = largest within the fetched 25-tx page, labelled as such.
5. Motion is calm and CSS-only, honoring `prefers-reduced-motion`.

## Root cause of "0 tx" (headline bug)

`getRecentBlocks` (`src/lib/server/chain/index.ts:624-645`) is Electrum-headers-only and HARDCODES `txCount:0, size:0, weight:0`. Block detail asks Core; the list never did. Fix = Wave 1.

## WAVE 1 — data layer (the "no more false 0" release; sequential, land first)

- **U1**: Widen `BlockSummary.txCount`/`size`/`weight` to `number|null` (`types.ts:79-81`); grep ALL consumers. Make `getRecentBlocks` Core-aware: keep Electrum header baseline, when Core present fan out `getblockstats(hash,[txs,total_size,total_weight,total_out,totalfee,subsidy,feerate_percentiles])` per block, concurrency cap 12, Electrum-only leaves null. Render null as "—" (`+page.svelte:598,562,599`); add `total_out` + fullness to the row model.
- **U2**: Bounded immutable LRU `blockStatsCache` keyed by block hash in `chain/cache.ts` (mirror `rawTxCache`), cache-forever, count-evicted.
- **U3**: Fix double fee-histogram fetch per refresh (`chainSync.ts:85` AND `index.ts:1263-1270` both call `getFeeHistogram` — fetch once, pass into `projectBlocksFromHistogram`); add 30-60s TTL caches for `getFeeHistogram` + `getMempoolSummary` in `cache.ts` (mirror `cachedFeeEstimates`; reset in `resetChainCaches`).
- **U4**: `doRefresh` persists enriched blocks; steady state = only the new tip block triggers a fresh `getblockstats` (others hit the immutable cache). `PersistedChainData.blocks` absorbs the widened type via the JSON blob — no schema change.

## WAVE 2 — parallel surface tracks (after Wave 1)

- **T-A "Forming ring" (index)**: conic-gradient arc, `--growth = min(1, secsSinceLastBlock/600)`; SSE new-block → seal + one-shot bloom + tip-counter roll; dashed pending vocabulary from `RingStub`. Label: "forming now · ~{nextFee} sat/vB to make it".
- **T-B NodeTrust**: new `chain/nodeTrust.ts` deriving `{source, label, server, connected, tipHeight, syncPhase, provisionedBy}` from `getChainConfig().mode` + `coreRpcConfigured()` + `getNodeInfo()` + `getSyncStatus()`; streamed (never blocks paint); chip near every explorer hero + node-health popover (last block seen, sync phase, source line, "Nothing here came from a third party" only when true). Honesty matrix per Cardinal rule 2 — structurally impossible to claim "your node" in public mode.
- **T-C Rich block rows (index)**: `RingBar` fullness sliver (weight/4M WU, tinted cool sage→warm copper by median fee), fee range "0.4–222 sat/vB", "~N BTC moved" (`total_out`), pool chip, "Yours" sage pip. Pool ID = new `chain/pools.ts` + vendored `known-pools.json` (mempool.space pools-v2 schema, static asset, quarterly refresh documented), coinbase via `getrawtransaction(tx[0],2,blockhash)`, label "Likely <Pool>", unknown → nothing (never wrong). "Yours" pip needs a bounded viewer-scoped ownership rollup (extend `ownership.server.ts` txid index: intersect viewer's txid set with block txids; privacy boundary preserved).
- **T-D Mempool alive**: split panels for per-source degradation (Electrum-only shows histogram+projection, `CoreRpcRequiredNotice` only in the summary panel); FeeWeather ridge viz (fee-rate spectrum, vsize mass, next-block fee marker, smooth morph on refresh; bar-chart fallback for reduced-motion/degraded); breathing counters; "your pending txs" sage band (wallet snapshot pending txids × projected fee ladder — never claims location inside the anonymized histogram); progressive loading: instant snapshot paint, skeleton sized to last magnitude only when snapshot is null.
- **T-E Copy pass (ships with any track)**: "Older rings"→"Load older blocks"; "Latest rings"→"Latest blocks"; "Rings below N"→"Blocks below N"; KEEP `BurialRings` confirmation copy ("buried 3 rings deep"/"sealed") and hero "blocks · not one removed"; `HowItWorks` rewritten (public-ledger + growth-ring framing + "your node keeps a full copy" + search understands heights/hashes/txids/addresses).

## WAVE 3 — depth (after Wave 2)

- Block detail: value-flow stacked bar (largest N outputs proportional + long tail + sage coinbase segment from `getblockstats` aggregates), "largest passages" (top txs in fetched page, tagged whale/consolidation/batch), "Yours in this ring" callout, in-hero RingBar.
- Tx detail: CSS-only Sankey-lite inputs→outputs with fee sliver "→ the miner"; keep RBF timeline/CPFP/fee outlook.
- Address: balance-over-time sparkline (cumulative series; omit if unavailable), ownership hero banner, type chip.
- Search: persistent pill in explorer sub-nav on all explorer pages, centered+larger on index, placeholder "Paste a block, transaction, or address — your node will find it".
- Light "Daylight grove" theme (token pairs: warm parchment base, umber text, AA-darkened copper/sage; tokenize stray hexes `#cbbfb3`/`#17120f`).
- Mobile 375px: spine collapses to horizontal strip, RingBar sliver replaces size column, FeeWeather compact ridge, existing ≤900px blocks extended not rebuilt.

## Perf budget (hard constraints)

- Index/mempool `load()`: 0 chain calls (snapshot only).
- Steady-state refresh ≈5 RPC (single-flighted, 20s throttle).
- Block detail page: ≤25 tx RPCs + stats (immutable-cached).
- Event loop: no new sync-SQLite scans on request paths; immutable caches in-memory Maps, not DB reads.

## Notes

- Mempool "slow" report: architecture is already instant-by-design; profiling report (separate) to confirm client-side vs refresh-path cost. U3 removes one Electrum round-trip per refresh regardless.
- Visual research was DOM-based (screenshot pipeline down environment-wide today); a visual pass against mempool.space/blockstream/blockchain.com is a follow-up when pixels return.
- Differentiators vs the field: one continuous growth story (vs widget grids), the forming-ring birth moment, viewer-private "Yours" everywhere, and honest provenance no third-party explorer can claim.
