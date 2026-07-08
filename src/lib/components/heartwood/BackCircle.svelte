<script lang="ts">
	// Heartwood 32px back circle for flow pages. Pass an explicit href when the
	// flow knows its destination (e.g. back to the wallet); with no href it
	// falls back to browser history. Callers compose the full flow-header row
	// (circle + centered eyebrow + 32px spacer) themselves.
	//
	// The href branch navigates via goto(..., { replaceState: true }) rather
	// than a plain <a> so it replaces the current history entry instead of
	// pushing a new one. Otherwise a flow page (href back to a hub) followed
	// by the hub's own history.back() creates an infinite back-forth loop
	// (cairn-y7ac).
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';

	let { href = null, label = 'Back' }: { href?: string | null; label?: string } = $props();
</script>

{#if href}
	<button
		type="button"
		class="back-circle"
		aria-label={label}
		title={label}
		onclick={() => goto(href, { replaceState: true })}
	>
		<Icon name="chevron-left" size={16} />
	</button>
{:else}
	<button
		type="button"
		class="back-circle"
		aria-label={label}
		title={label}
		onclick={() => history.back()}
	>
		<Icon name="chevron-left" size={16} />
	</button>
{/if}

<style>
	.back-circle {
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border-control);
		border-radius: 50%;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.back-circle:hover {
		color: var(--text);
		border-color: var(--border-ghost);
	}
</style>
