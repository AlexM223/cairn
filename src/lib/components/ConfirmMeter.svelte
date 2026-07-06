<script lang="ts">
	// Confirmation depth as a filled 6-segment meter. Six confirmations is the
	// customary threshold for treating a payment as settled.
	let { confirmations }: { confirmations: number } = $props();

	const filled = $derived(Math.min(confirmations, 6));
</script>

<span
	class="meter"
	title={confirmations === 0
		? 'Unconfirmed — waiting in the mempool'
		: `${confirmations.toLocaleString('en-US')} confirmation${confirmations === 1 ? '' : 's'} — each block mined on top makes this transaction harder to reverse`}
>
	{#each Array(6) as _, i (i)}
		<span class="seg" class:filled={i < filled}></span>
	{/each}
	<span class="meter-label tabular">
		{confirmations >= 6 ? '6+' : confirmations}
	</span>
</span>

<style>
	.meter {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		cursor: help;
	}

	.seg {
		width: 12px;
		height: 6px;
		border-radius: 2px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
	}

	.seg.filled {
		background: var(--success);
		border-color: var(--success);
	}

	.meter-label {
		margin-left: 5px;
		font-size: 12px;
		color: var(--text-secondary);
	}
</style>
