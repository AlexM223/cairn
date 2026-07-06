<script lang="ts">
	// Sub-navigation for the Explorer hub pages. Detail pages (block/tx/address)
	// intentionally don't render this — they're destinations, not sections.
	let { active }: { active: 'overview' | 'mempool' | 'blocks' | 'difficulty' } = $props();

	const tabs = [
		{ key: 'overview', href: '/explorer', label: 'Overview' },
		{ key: 'mempool', href: '/explorer/mempool', label: 'Mempool' },
		{ key: 'blocks', href: '/explorer/mempool/blocks', label: 'Next blocks' },
		{ key: 'difficulty', href: '/explorer/difficulty', label: 'Difficulty' }
	] as const;
</script>

<nav class="explorer-nav" aria-label="Explorer sections">
	{#each tabs as tab (tab.key)}
		<a href={tab.href} class="tab" class:active={active === tab.key}>{tab.label}</a>
	{/each}
</nav>

<style>
	.explorer-nav {
		display: flex;
		gap: 2px;
		margin-bottom: 18px;
		border-bottom: 1px solid var(--border-subtle);
		overflow-x: auto;
	}

	.tab {
		padding: 8px 14px;
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-secondary);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		white-space: nowrap;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.tab:hover {
		color: var(--text);
	}

	.tab.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>
