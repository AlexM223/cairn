<script lang="ts">
	// Heartwood mobile text-tab row (<=900px, tab pages): the toggle grammar —
	// active copper-bright on a copper tint, inactive path-tone text pills.
	import { page } from '$app/state';

	let { tabs }: { tabs: { href: string; label: string }[] } = $props();

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<nav class="tab-row" aria-label="Sections">
	{#each tabs as tab (tab.href)}
		<a
			href={tab.href}
			class="tab"
			class:active={isActive(tab.href)}
			aria-current={isActive(tab.href) ? 'page' : undefined}
		>
			{tab.label}
		</a>
	{/each}
</nav>

<style>
	.tab-row {
		display: none;
	}

	.tab {
		padding: 6px 13px;
		border-radius: var(--radius-toggle);
		font-size: 12.5px;
		font-weight: 500;
		white-space: nowrap;
		color: var(--eyebrow-path);
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.tab:hover {
		color: var(--text-secondary);
	}

	.tab.active {
		color: var(--accent-bright);
		background: rgba(232, 147, 90, 0.1);
	}

	@media (max-width: 900px) {
		.tab-row {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 0 18px 12px;
			overflow-x: auto;
		}
	}
</style>
