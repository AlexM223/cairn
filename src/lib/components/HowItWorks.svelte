<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	// Collapsible per-page explainer. Open/closed state persists per panel id
	// so a reader who closed it stays uninterrupted on return visits.
	let {
		id,
		title = 'How does this work?',
		children
	}: { id: string; title?: string; children: Snippet } = $props();

	const storageKey = $derived(`cairn.explain.${id}`);
	let open = $state(false);

	$effect(() => {
		open = localStorage.getItem(storageKey) === 'open';
	});

	function toggle() {
		open = !open;
		localStorage.setItem(storageKey, open ? 'open' : 'closed');
	}
</script>

<div class="how" class:open>
	<button class="how-toggle" onclick={toggle} aria-expanded={open}>
		<Icon name="info" size={15} />
		<span>{title}</span>
		<span class="chev" class:rotated={open}><Icon name="chevron-down" size={14} /></span>
	</button>
	{#if open}
		<div class="how-body fade-in">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.how {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		background: var(--accent-muted);
		border-color: rgba(232, 147, 90, 0.25);
		margin-bottom: 18px;
	}

	.how-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: none;
		color: var(--accent);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 10px 14px;
		cursor: pointer;
		text-align: left;
	}

	.chev {
		margin-left: auto;
		display: inline-flex;
		transition: transform 150ms var(--ease);
	}

	.chev.rotated {
		transform: rotate(180deg);
	}

	.how-body {
		padding: 2px 14px 12px 37px;
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.how-body :global(p) {
		margin: 0 0 8px;
	}

	.how-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.how-body :global(strong) {
		color: var(--text);
		font-weight: 500;
	}
</style>
