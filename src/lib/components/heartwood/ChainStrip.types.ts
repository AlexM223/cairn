// ChainEpoch lives in its own plain .ts module (not inside ChainStrip.svelte's
// <script module> block) so that server-side consumers — chainEpochs.ts in
// particular — can import the type through vanilla tsc's ambient `*.svelte`
// module declaration, which only knows about a Svelte file's default
// (component) export and can't see named `<script module>` exports. Only
// svelte-check's language-service plugin resolves those; plain `tsc --noEmit`
// reports a TS2614 false positive on them (cairn-dgnl). ChainStrip.svelte
// re-exports this type so its own existing import surface is unchanged.

/**
 * One difficulty epoch on the strip. `xStart`/`xEnd` are 0..1 fractions
 * of the total cumulative-duration-weighted width — the CALLER computes
 * these from real retarget timestamps (the Explorer lane owns that
 * pipeline); this component just draws the fractions it's given.
 */
export type ChainEpoch = {
	index: number;
	xStart: number;
	xEnd: number;
	/** Line alpha, spec formula 0.07 + 0.14·n(i) (+0.26 for pop rings). */
	alpha: number;
	/** Halving-boundary epoch (multiples of 104): cream + top triangle. */
	isHalving: boolean;
	/** Last ~8 epochs: the sapwood zone gets a soft warm tint. */
	isSapwood: boolean;
};
