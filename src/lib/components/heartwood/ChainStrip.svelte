<script module lang="ts">
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

	// Deterministic pseudo-random 0..1 per index — the mock must look the
	// same on every render (no Math.random()).
	function n(i: number, salt = 0): number {
		const x = Math.sin(i * 127.1 + salt * 311.7 + 74.7) * 43758.5453123;
		return x - Math.floor(x);
	}

	/**
	 * Fabricates a plausible-looking epoch set for demos/tests: early epochs
	 * wide (2009's slow retargets), shrinking monotonically with ±14% noise;
	 * halvings at every multiple of 104; last 8 epochs marked sapwood.
	 */
	export function mockChainEpochs(count = 475): ChainEpoch[] {
		const weights: number[] = [];
		for (let i = 0; i < count; i++) {
			const base = 1 + 4.5 * Math.exp(-i / 30); // 2009 wide → 2013+ tight
			const noise = 0.86 + 0.28 * n(i, 1); // ±14% in-span noise
			weights.push(base * noise);
		}
		const totalW = weights.reduce((a, b) => a + b, 0);
		let acc = 0;
		return weights.map((w, i) => {
			const xStart = acc / totalW;
			acc += w;
			const xEnd = acc / totalW;
			const pop = n(i, 2) < 0.13 ? 0.26 : 0; // ~13% pop rings
			return {
				index: i,
				xStart,
				xEnd,
				alpha: Math.min(0.07 + 0.14 * n(i, 0) + pop, 1),
				isHalving: i > 0 && i % 104 === 0,
				isSapwood: i >= count - 8
			};
		});
	}
</script>

<script lang="ts">
	/**
	 * ChainStrip — the timechain, linearized. One vertical line per
	 * difficulty epoch on the #111716 strip canvas, x proportional to
	 * cumulative epoch duration ("widths to scale — 2009 wide, 2013 tight").
	 *
	 * Pure presentational: no fetching, no chain math. Feed it `epochs`
	 * (real data from the Explorer lane, or `mockChainEpochs()` for demos).
	 *
	 * Each epoch is drawn at the MIDPOINT of its xStart/xEnd span.
	 *
	 * Captions are deliberately NOT rendered here — different pages want
	 * different caption text ("2009 · genesis" / "475 rings · one per
	 * difficulty epoch · widths to scale" / "now"). Callers render their own
	 * caption row below the strip (11.5px, var(--text-faint), flex
	 * space-between).
	 */
	let {
		epochs,
		mode = 'full',
		highlightIndex = undefined,
		height = 120
	}: {
		epochs: ChainEpoch[];
		/** 'full' = the explorer hero strip; 'locator' = block-detail variant. */
		mode?: 'full' | 'locator';
		/** Locator mode: epoch index to mark with the cream locator triangle. */
		highlightIndex?: number;
		/** Canvas px height — 120 full/desktop, 56–64 locator, 68 mobile. */
		height?: number;
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let wrap: HTMLDivElement | undefined = $state();
	let cssWidth = $state(0);

	// Track the container's width so the strip redraws crisply on resize.
	$effect(() => {
		if (!wrap) return;
		const ro = new ResizeObserver((entries) => {
			cssWidth = entries[0].contentRect.width;
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	function drawTriangle(ctx: CanvasRenderingContext2D, x: number, color: string) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(x - 3, 1);
		ctx.lineTo(x + 3, 1);
		ctx.lineTo(x, 6.5);
		ctx.closePath();
		ctx.fill();
	}

	// Redraws on any prop or size change (all reads below are tracked).
	$effect(() => {
		const w = cssWidth;
		const h = height;
		const eps = epochs;
		const m = mode;
		const hl = highlightIndex;
		if (!canvas || w <= 0 || h <= 0) return;

		const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Base: --bg-strip + a subtle cool vertical gradient (--border mirror
		// fading to --bg-deep).
		ctx.fillStyle = '#111716';
		ctx.fillRect(0, 0, w, h);
		const g = ctx.createLinearGradient(0, 0, 0, h);
		g.addColorStop(0, 'rgba(43, 51, 49, 0.22)');
		g.addColorStop(0.5, 'rgba(43, 51, 49, 0.06)');
		g.addColorStop(1, 'rgba(9, 13, 12, 0.3)');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);

		const padY = 8;

		// Sapwood tint: one rect over the combined span of the last epochs,
		// under the lines.
		const sap = eps.filter((e) => e.isSapwood);
		if (sap.length > 0) {
			const x0 = sap[0].xStart * w;
			const x1 = sap[sap.length - 1].xEnd * w;
			ctx.fillStyle = 'rgba(182, 210, 234, 0.05)';
			ctx.fillRect(x0, 0, x1 - x0, h);
		}

		// One line per epoch at the midpoint of its span.
		for (const e of eps) {
			const x = ((e.xStart + e.xEnd) / 2) * w;
			const isHl = m === 'locator' && hl === e.index;
			if (isHl) {
				// Locator: cream marker at the block's epoch.
				ctx.globalAlpha = 1;
				ctx.strokeStyle = '#d4e5f4';
				ctx.lineWidth = 1.4;
				ctx.beginPath();
				ctx.moveTo(x, padY);
				ctx.lineTo(x, h - padY);
				ctx.stroke();
				drawTriangle(ctx, x, '#d4e5f4');
				continue;
			}
			// Locator mode deemphasizes everything else (incl. halvings).
			if (m === 'full' && e.isHalving) {
				ctx.globalAlpha = Math.min(e.alpha + 0.3, 0.9);
				ctx.strokeStyle = '#d4e5f4';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x, padY);
				ctx.lineTo(x, h - padY);
				ctx.stroke();
				ctx.globalAlpha = 0.85;
				drawTriangle(ctx, x, '#d4e5f4');
				continue;
			}
			ctx.globalAlpha = m === 'locator' ? e.alpha * 0.6 : e.alpha;
			ctx.strokeStyle = '#6796c9';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, padY);
			ctx.lineTo(x, h - padY);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;

		// Genesis dot at the left edge.
		ctx.fillStyle = '#6796c9';
		ctx.beginPath();
		ctx.arc(4, h / 2, 2.2, 0, Math.PI * 2);
		ctx.fill();

		// "Now" edge: 2px solid slate-blue at the right edge. The pulsing dot is
		// DOM (below) — canvas pixels can't animate independently.
		ctx.fillRect(w - 2, 0, 2, h);
	});
</script>

<div class="strip-wrap" bind:this={wrap} role="img" aria-label="Timechain — one ring per difficulty epoch">
	<canvas bind:this={canvas} class="strip" style="height: {height}px"></canvas>
	<span class="now-dot" style="left: {Math.max(cssWidth - 3.5, 0)}px; top: {height / 2}px"></span>
</div>

<style>
	.strip-wrap {
		position: relative;
		width: 100%;
	}

	.strip {
		display: block;
		width: 100%;
		border-radius: var(--radius-strip);
	}

	.now-dot {
		position: absolute;
		width: 5px;
		height: 5px;
		margin-top: -2.5px;
		border-radius: 50%;
		background: var(--accent-glow);
		box-shadow: 0 0 6px rgba(182, 210, 234, 0.7);
		pointer-events: none;
		animation: hwPulse 2.4s ease-in-out infinite;
	}
</style>
