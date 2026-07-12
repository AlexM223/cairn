<script lang="ts">
	import { formatBtc } from '$lib/format';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';

	type Slice = {
		key: string;
		kind: 'wallet' | 'multisig';
		id: number;
		name: string;
		href: string;
		balance: number;
	};

	let { slices, total }: { slices: Slice[]; total: number } = $props();

	// Copper-family shades only — the allocation strip is a quiet texture, not
	// a pie chart.
	const PALETTE = ['#e8935a', '#b5673a', '#7a5238', '#d8b27a', '#5e3f2c', '#caa06a'];

	const colorFor = (i: number) => PALETTE[i % PALETTE.length];

	// Segments shown in the strip: skip zero-balance (they'd be invisible).
	// Preserve original index so strip and row swatches stay in sync.
	const barSegments = $derived(
		slices.map((s, i) => ({ slice: s, index: i })).filter((e) => e.slice.balance > 0)
	);

	const pct = (balance: number) => (total > 0 ? (balance / total) * 100 : 0);
</script>

{#if slices.length === 0}
	<p class="empty">No wallets yet.</p>
{:else}
	<div class="allocation">
		{#if total > 0}
			<div class="bar" aria-hidden="true">
				{#each barSegments as { slice, index } (slice.key)}
					<span
						class="segment"
						style="width: {pct(slice.balance)}%; background: {colorFor(index)};"
						title="{slice.name} — {formatBtc(slice.balance)} BTC ({pct(slice.balance).toFixed(
							1
						)}%)"
					></span>
				{/each}
			</div>
		{/if}

		<ul class="rows">
			{#each slices as slice, i (slice.key)}
				<li>
					<a class="wallet-row" href={slice.href}>
						<span class="swatch" style="background: {colorFor(i)};"></span>
						<span class="name">
							{#if slice.kind === 'multisig'}
								<Icon name="shield" size={12} />
							{/if}
							<span class="name-text truncate">{slice.name}</span>
						</span>
						<Amount sats={slice.balance} size="row" />
						<span class="pct tabular">
							{total > 0 ? `${pct(slice.balance).toFixed(0)}%` : '—'}
						</span>
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
		gap: 12px;
	}

	.empty {
		margin: 0;
		padding: 1.25rem 0;
		color: var(--text-muted);
		font-family: var(--font-ui);
		font-size: 0.875rem;
		text-align: center;
	}

	/* Thin allocation strip — texture above the rows, not a chart. */
	.bar {
		display: flex;
		width: 100%;
		height: 5px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--bg-input);
		gap: 1px;
	}

	.segment {
		display: block;
		height: 100%;
		min-width: 2px;
	}

	/* Hairline wallet rows. */
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.rows li {
		border-bottom: 1px solid var(--hairline);
	}

	.rows li:last-child {
		border-bottom: none;
	}

	.wallet-row {
		display: grid;
		grid-template-columns: auto 1fr auto auto;
		align-items: center;
		gap: 10px;
		padding: 13px 2px;
		text-decoration: none;
		color: var(--text-rows);
		transition: background 0.15s var(--ease);
	}

	.wallet-row:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.wallet-row:hover .name-text {
		color: var(--accent-bright);
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.name :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.name-text {
		transition: color 0.15s var(--ease);
	}

	.pct {
		font-family: var(--font-ui);
		font-size: 11.5px;
		color: var(--text-faint);
		min-width: 2.8em;
		text-align: right;
	}

	@media (max-width: 900px) {
		.wallet-row {
			padding: 12px 0;
		}

		.name {
			font-size: 13px;
		}
	}
</style>
