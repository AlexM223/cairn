<script lang="ts">
	import { formatBtc } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';

	type Slice = {
		key: string;
		kind: 'wallet' | 'multisig';
		id: number;
		name: string;
		href: string;
		balance: number;
	};

	let { slices, total }: { slices: Slice[]; total: number } = $props();

	const PALETTE = [
		'#e8935a',
		'#d9a441',
		'#c77d43',
		'#e0b978',
		'#b5613a',
		'#caa06a',
		'#a8562e',
		'#e8c07a'
	];

	const colorFor = (i: number) => PALETTE[i % PALETTE.length];

	// Segments shown in the bar: skip zero-balance (they'd be invisible).
	// Preserve original index so bar and legend colors stay in sync.
	const barSegments = $derived(
		slices.map((s, i) => ({ slice: s, index: i })).filter((e) => e.slice.balance > 0)
	);

	const pct = (balance: number) => (total > 0 ? (balance / total) * 100 : 0);
</script>

{#if total === 0}
	<p class="empty">No confirmed balance to allocate yet.</p>
{:else}
	<div class="allocation">
		<div class="bar">
			{#each barSegments as { slice, index } (slice.key)}
				<a
					class="segment"
					href={slice.href}
					style="width: {pct(slice.balance)}%; background: {colorFor(index)};"
					title="{slice.name} — {formatBtc(slice.balance)} BTC ({pct(slice.balance).toFixed(1)}%)"
				>
					<span class="segment-label">{slice.name}</span>
				</a>
			{/each}
		</div>

		<ul class="legend">
			{#each slices as slice, i (slice.key)}
				<li>
					<a class="legend-row" href={slice.href}>
						<span class="swatch" style="background: {colorFor(i)};"></span>
						<span class="name">
							{#if slice.kind === 'multisig'}
								<Icon name="shield" size={12} />
							{/if}
							<span class="name-text">{slice.name}</span>
						</span>
						<span class="balance tabular">{formatBtc(slice.balance)} BTC</span>
						<span class="pct tabular">{pct(slice.balance).toFixed(1)}%</span>
					</a>
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.allocation {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.empty {
		margin: 0;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.9rem;
	}

	.bar {
		display: flex;
		width: 100%;
		height: 16px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--surface);
		gap: 1px;
	}

	.segment {
		display: block;
		height: 100%;
		min-width: 2px;
		position: relative;
		transition:
			opacity 0.18s var(--ease),
			transform 0.18s var(--ease);
		transform-origin: center;
	}

	.segment:first-child {
		border-top-left-radius: 999px;
		border-bottom-left-radius: 999px;
	}

	.segment:last-child {
		border-top-right-radius: 999px;
		border-bottom-right-radius: 999px;
	}

	.segment:hover,
	.segment:focus-visible {
		opacity: 0.85;
		transform: scaleY(1.18);
		outline: none;
		z-index: 1;
	}

	.segment-label {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		white-space: nowrap;
		padding: 3px 8px;
		border-radius: var(--radius-chip);
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 0.72rem;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s var(--ease);
	}

	.segment:hover .segment-label,
	.segment:focus-visible .segment-label {
		opacity: 1;
	}

	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.legend-row {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: center;
		gap: 10px;
		padding: 6px 8px;
		border-radius: var(--radius-control);
		text-decoration: none;
		color: var(--text);
		transition: background 0.15s var(--ease);
	}

	.legend-row:hover,
	.legend-row:focus-visible {
		background: var(--surface);
		outline: none;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.name {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		color: var(--text);
		font-family: var(--font-ui);
		font-size: 0.88rem;
	}

	.name :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.name-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.balance {
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 0.84rem;
	}

	.pct {
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.84rem;
		min-width: 3.2em;
		text-align: right;
	}
</style>
