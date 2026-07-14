<script lang="ts">
	// One tappable block in the tx-detail context row (docs/TX-BLOCK-CONTEXT-DESIGN.md
	// §5 "MiniBlock.svelte"). A rounded-square glyph inside an <a> to the block page.
	//   - current block: accent border + glow, and the tx's position marker inside.
	//   - full tier: interior fills proportionally to block fullness, position drawn
	//     as a highlighted cell in a coarse grid.
	//   - basic tier: a single highlighted pip at the fractional position, #pos label.
	//   - neighbours: muted hairline border, height + date only.
	import type { BlockContextNeighbor, BlockContextRichness } from '$lib/types';
	import { formatNumber, timeAgo, formatDateTime } from '$lib/format';

	let {
		neighbor,
		position = null,
		positionTotal = null,
		positionEstimated = false,
		richness,
		coinbase = false
	}: {
		neighbor: BlockContextNeighbor;
		position?: number | null;
		positionTotal?: number | null;
		positionEstimated?: boolean;
		richness: BlockContextRichness;
		/** The viewed tx is this block's coinbase (position 0) — tooltip nuance. */
		coinbase?: boolean;
	} = $props();

	const isCurrent = $derived(neighbor.isCurrent);
	const full = $derived(richness === 'full');

	// Fullness fill height (0..1) — only meaningful at the full tier.
	const fillFrac = $derived(full && neighbor.fullness != null ? Math.min(1, Math.max(0, neighbor.fullness)) : null);

	// Coarse position grid: map the tx's fractional position into a GRID×GRID cell so
	// the marker reads as "roughly here in the block" without pretending per-tx detail.
	const GRID = 5;
	const cell = $derived.by(() => {
		if (!isCurrent || position == null) return null;
		const total = positionTotal != null && positionTotal > 0 ? positionTotal : null;
		// Fraction through the block; with no denominator, pin to the very start.
		const frac = total ? Math.min(0.999, Math.max(0, position / total)) : 0;
		const idx = Math.min(GRID * GRID - 1, Math.floor(frac * GRID * GRID));
		return { col: idx % GRID, row: Math.floor(idx / GRID) };
	});

	const CELL = 100 / GRID; // cell edge in the 0..100 viewBox

	const title = $derived(
		`Open block ${formatNumber(neighbor.height)} in the explorer.` +
			(isCurrent && position != null
				? coinbase
					? ' This is the block reward (first transaction).'
					: ` Your transaction is #${formatNumber(position)} in this block.`
				: '')
	);
</script>

<a class="mini" class:current={isCurrent} href="/explorer/block/{neighbor.height}" {title}>
	<span class="height tabular">{formatNumber(neighbor.height)}</span>

	<svg class="glyph" viewBox="0 0 100 100" role="img" aria-hidden="true">
		<!-- fullness fill (full tier, current or neighbour) -->
		{#if fillFrac !== null}
			<rect
				class="fill"
				x="0"
				y={100 - fillFrac * 100}
				width="100"
				height={fillFrac * 100}
				rx="0"
			/>
		{/if}

		<!-- position grid cell (current block only) -->
		{#if cell}
			{#if full}
				<!-- faint grid lines to read the highlighted cell as "a spot in the block" -->
				{#each Array(GRID - 1) as _, i (i)}
					<line class="grid" x1={(i + 1) * CELL} y1="0" x2={(i + 1) * CELL} y2="100" />
					<line class="grid" x1="0" y1={(i + 1) * CELL} x2="100" y2={(i + 1) * CELL} />
				{/each}
			{/if}
			<rect
				class="pos"
				x={cell.col * CELL + 1}
				y={cell.row * CELL + 1}
				width={CELL - 2}
				height={CELL - 2}
				rx="2"
			/>
		{/if}

		<!-- block outline drawn last so it sits above the fill/grid -->
		<rect class="frame" x="1.5" y="1.5" width="97" height="97" rx="12" />
	</svg>

	{#if isCurrent && position != null}
		<!-- The #pos index is exact (from the merkle proof) even when the block's total
		     tx count — and thus the marker's grid cell — is only an estimate. -->
		<span class="pos-label tabular">#{formatNumber(position)}</span>
	{/if}

	<span class="date" title={neighbor.time != null ? formatDateTime(neighbor.time) : undefined}>
		{neighbor.time != null ? timeAgo(neighbor.time) : '—'}
	</span>
</a>

<style>
	.mini {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		width: 92px;
		scroll-snap-align: center;
		text-decoration: none;
		padding: 4px 2px;
		border-radius: var(--radius-badge);
	}

	.mini:hover .frame {
		stroke: var(--accent-bright);
	}

	.height {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
		letter-spacing: 0.01em;
	}

	.mini.current .height {
		color: var(--sage);
	}

	.glyph {
		width: 60px;
		height: 60px;
		display: block;
		overflow: visible;
	}

	.frame {
		fill: none;
		stroke: var(--hairline);
		stroke-width: 2;
		transition: stroke 150ms var(--ease);
	}

	.mini.current .frame {
		stroke: var(--sage);
		stroke-width: 2.5;
		filter: drop-shadow(0 0 5px color-mix(in srgb, var(--sage) 45%, transparent));
	}

	.fill {
		fill: color-mix(in srgb, var(--sage) 16%, transparent);
	}

	.grid {
		stroke: var(--hairline);
		stroke-width: 0.75;
		opacity: 0.5;
	}

	.pos {
		fill: var(--accent);
	}

	.mini.current .pos {
		fill: var(--accent-bright);
	}

	.pos-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		line-height: 1;
	}

	.date {
		font-size: 11px;
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
