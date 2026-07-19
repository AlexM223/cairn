<script lang="ts">
	// Heartwood mobile text-tab row (<=900px, tab pages): the toggle grammar —
	// active slate-blue-bright on an accent tint, inactive path-tone text pills.
	// Shows the same three primaries as the desktop rail (spec §2.7).
	import { page } from '$app/state';
	import { isNavActive } from '$lib/nav';
	import { viewport } from '$lib/viewport.svelte';

	let { tabs }: { tabs: { href: string; label: string }[] } = $props();

	function isActive(href: string): boolean {
		return isNavActive(href, page.url.pathname);
	}
</script>

<!-- Labeled "Main" (not "Sections"): at any breakpoint exactly ONE nav landmark
     is exposed, and it is always the main nav — this row on mobile, the rail on
     desktop, where this row is display:none AND aria-hidden (spec §2.7
     duplicate-landmark fix). -->
<nav class="tab-row" aria-label="Main" aria-hidden={viewport.isMobile ? undefined : 'true'}>
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
		/* min-height keeps the tap target >=44px on touch without enlarging the
		   text pill's visual weight (cairn-amyl). */
		display: inline-flex;
		align-items: center;
		min-height: 44px;
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
		background: var(--accent-muted);
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
