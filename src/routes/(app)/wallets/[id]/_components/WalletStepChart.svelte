<script lang="ts">
	/**
	 * WalletStepChart — the Heartwood wallet detail's 148px "stepped" balance
	 * chart (spec 5d/8e): deposits and spends read as steps, not a smoothed
	 * line. Unboxed per the grammar — it bleeds to content width with a
	 * caption underneath, no frame.
	 *
	 * Built from the wallet's confirmed transaction deltas: the series walks
	 * from zero to the current confirmed balance, one horizontal tread per
	 * quiet stretch, one vertical riser per transaction. Height is a prop so
	 * mobile can drop to the 88px variant.
	 *
	 * Local to the wallet pages on purpose — Home's BalanceChart (a smoothed
	 * portfolio line) is a different component owned by a different lane.
	 */
	let {
		txs,
		confirmed,
		height = 148
	}: {
		/** Wallet scan txs — only confirmed ones (height > 0) are charted. */
		txs: { time: number; height: number; delta: number }[];
		/** Current confirmed balance in sats (anchors the series' end). */
		confirmed: number;
		height?: number;
	} = $props();

	let width = $state(0);

	const PAD_TOP = 10;
	const PAD_BOTTOM = 4;
	const END_GUTTER = 14; // room for the pulsing end dot

	const series = $derived.by(() => {
		const conf = txs
			.filter((t) => t.height > 0 && t.time > 0)
			.toSorted((a, b) => a.time - b.time || a.height - b.height);
		if (conf.length === 0) return null;
		// Walk deltas forward, then shift so the walk ends exactly at the
		// scanner's confirmed balance (deltas already include fees, so the
		// shift is normally zero — it just absorbs rounding/scan drift).
		let run = 0;
		const raw = conf.map((t) => ({ time: t.time, value: (run += t.delta) }));
		const shift = confirmed - run;
		return raw.map((p) => ({ time: p.time, value: p.value + shift }));
	});

	const geometry = $derived.by(() => {
		const s = series;
		if (!s || width < 60) return null;
		const w = width - END_GUTTER;
		const h = height;
		const t0 = s[0].time;
		const t1 = Math.max(Math.floor(Date.now() / 1000), s[s.length - 1].time);
		const tSpan = Math.max(1, t1 - t0);
		const values = s.map((p) => p.value);
		const vMax = Math.max(...values, confirmed, 1);
		const vMin = Math.min(...values, 0);
		const vSpan = Math.max(1, vMax - vMin);
		const x = (t: number) => ((t - t0) / tSpan) * w;
		const y = (v: number) => PAD_TOP + (1 - (v - vMin) / vSpan) * (h - PAD_TOP - PAD_BOTTOM);

		// Step path: tread at the previous value up to each tx, then a riser.
		const zeroY = y(Math.max(0, vMin));
		let d = `M 0 ${zeroY.toFixed(1)}`;
		let prevY = zeroY;
		for (const p of s) {
			const px = x(p.time);
			const py = y(p.value);
			d += ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
			prevY = py;
		}
		const endX = w;
		d += ` L ${endX.toFixed(1)} ${prevY.toFixed(1)}`;
		const fill = `${d} L ${endX.toFixed(1)} ${h} L 0 ${h} Z`;
		return { line: d, fill, endX, endY: prevY };
	});

	// One gradient id per instance so two charts on a page don't collide.
	const gradId = `hw-step-grad-${Math.random().toString(36).slice(2, 8)}`;
</script>

{#if series && series.length > 0}
	<div class="step-chart" style:height="{height}px" bind:clientWidth={width}>
		{#if geometry}
			<svg {width} {height} aria-hidden="true">
				<defs>
					<linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="rgba(232, 147, 90, 0.16)" />
						<stop offset="100%" stop-color="rgba(232, 147, 90, 0)" />
					</linearGradient>
				</defs>
				<path d={geometry.fill} fill="url(#{gradId})" />
				<path
					class="line"
					d={geometry.line}
					fill="none"
					stroke="var(--accent)"
					stroke-width="2"
					stroke-linejoin="round"
					pathLength="1"
				/>
				<circle class="end-dot" cx={geometry.endX} cy={geometry.endY} r="3.5" fill="var(--accent-glow)" />
			</svg>
		{/if}
	</div>
{/if}

<style>
	.step-chart {
		width: 100%;
		overflow: hidden;
	}

	svg {
		display: block;
		overflow: visible;
	}

	/* Draw-in on mount (spec hwGrow: dashoffset → 0, 1.8s ease-out). */
	.line {
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		animation: hwGrow 1.8s var(--ease) forwards;
	}

	.end-dot {
		animation: hwPulse 2.4s ease-in-out infinite;
	}
</style>
