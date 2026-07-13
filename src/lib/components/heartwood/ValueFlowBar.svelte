<script lang="ts">
	/**
	 * ValueFlowBar — the block-detail value-flow bar (Wave 3, cairn-6efi.7). A
	 * single horizontal bar split into three NON-overlapping economic quantities
	 * for the block, all from `getblockstats` aggregates (no per-tx fan-out):
	 *
	 *   - transferred (value moved between parties = total_out)  → neutral
	 *   - subsidy     (newly minted bitcoin)                     → sage
	 *   - fees        (paid to the miner)                        → copper
	 *
	 * The caller passes a {@link ValueFlow} (or null). When null — the underlying
	 * aggregates are unavailable (Electrum-only baseline) — this renders NOTHING
	 * (Cardinal rule: absence reads as absence, never a false empty/zero bar).
	 *
	 * Segment widths are values, not animation: correct with motion disabled. The
	 * only motion is a calm one-shot grow-in, honored off under prefers-reduced.
	 */
	import { formatBtc, formatSats } from '$lib/format';

	/** Structural mirror of blockDepth.ts's ValueFlow — kept local so this
	 *  presentational component carries no import into the route tree. Any
	 *  ValueFlow the block page computes satisfies this shape. */
	interface ValueFlowSegment {
		key: 'transferred' | 'subsidy' | 'fees';
		sats: number;
		fraction: number;
	}
	interface ValueFlow {
		segments: ValueFlowSegment[];
		total: number;
		transferred: number;
		subsidy: number;
		fees: number;
	}

	let { flow }: { flow: ValueFlow | null } = $props();

	const META: Record<
		'transferred' | 'subsidy' | 'fees',
		{ label: string; cls: string; tip: string }
	> = {
		transferred: {
			label: 'Moved',
			cls: 'transferred',
			tip: 'Value carried between parties — the sum of every non-coinbase output in this block.'
		},
		subsidy: {
			label: 'New coins',
			cls: 'subsidy',
			tip: 'Newly minted bitcoin — the block subsidy, the only way new supply enters existence, halving every 210,000 blocks.'
		},
		fees: {
			label: 'Fees',
			cls: 'fees',
			tip: 'Transaction fees paid to the miner on top of the subsidy — the network’s long-term security budget as the subsidy shrinks.'
		}
	};

	// Below this fraction a segment is too thin to hold its own label — it still
	// draws its colour sliver, but the legend below carries every number so
	// nothing is ever hidden.
	const MIN_LABEL_FRACTION = 0.08;
</script>

{#if flow}
	<div class="vflow">
		<div class="bar" role="img" aria-label="Value flow: {formatBtc(flow.transferred)} BTC moved, {formatBtc(flow.subsidy)} BTC new coins, {formatSats(flow.fees)} sats fees">
			{#each flow.segments as seg (seg.key)}
				{#if seg.sats > 0}
					<span
						class="seg {META[seg.key].cls}"
						style:--frac="{seg.fraction * 100}%"
						title="{META[seg.key].label}: {formatBtc(seg.sats)} BTC"
					>
						{#if seg.fraction >= MIN_LABEL_FRACTION}
							<span class="seg-label">{META[seg.key].label}</span>
						{/if}
					</span>
				{/if}
			{/each}
		</div>
		<div class="legend">
			{#each flow.segments as seg (seg.key)}
				<span class="key">
					<span class="dot {META[seg.key].cls}" aria-hidden="true"></span>
					<span class="key-label" title={META[seg.key].tip}>{META[seg.key].label}</span>
					<span class="key-val tabular" title="{formatSats(seg.sats)} sats">
						{seg.key === 'fees' && seg.sats < 100_000_000
							? `${formatSats(seg.sats)} sats`
							: `${formatBtc(seg.sats)} BTC`}
					</span>
				</span>
			{/each}
		</div>
	</div>
{/if}

<style>
	.vflow {
		margin-top: 26px;
	}

	.bar {
		display: flex;
		width: 100%;
		height: 30px;
		border-radius: var(--radius-badge);
		overflow: hidden;
		background: var(--accent-dim-2);
	}

	.seg {
		display: flex;
		align-items: center;
		padding: 0 9px;
		width: var(--frac);
		min-width: 2px;
		overflow: hidden;
		white-space: nowrap;
		/* Calm one-shot grow-in; the final width IS the datum, so a reduced-motion
		   viewer just sees the correct static bar. */
		animation: grow 520ms var(--ease) both;
		transform-origin: left center;
	}

	.seg.transferred {
		background: color-mix(in oklab, var(--text-secondary) 55%, var(--panel, #241d19));
	}

	.seg.subsidy {
		background: var(--sage);
	}

	.seg.fees {
		background: var(--accent);
	}

	.seg-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--on-accent);
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.seg.transferred .seg-label {
		color: var(--text-hero);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin-top: 12px;
	}

	.key {
		display: inline-flex;
		align-items: baseline;
		gap: 7px;
		font-size: 12.5px;
	}

	.dot {
		align-self: center;
		width: 9px;
		height: 9px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.dot.transferred {
		background: color-mix(in oklab, var(--text-secondary) 55%, var(--panel, #241d19));
	}

	.dot.subsidy {
		background: var(--sage);
	}

	.dot.fees {
		background: var(--accent);
	}

	.key-label {
		color: var(--text-muted);
	}

	.key-val {
		font-family: var(--font-serif);
		font-weight: 600;
		color: var(--text-rows);
	}

	@keyframes grow {
		from {
			transform: scaleX(0.6);
			opacity: 0.3;
		}
		to {
			transform: scaleX(1);
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.seg {
			animation: none;
		}
	}

	@media (max-width: 900px) {
		.vflow {
			margin-top: 20px;
		}

		.bar {
			height: 26px;
		}

		.legend {
			gap: 12px;
		}
	}
</style>
