<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	const tabs = [
		{ href: '/admin', label: 'Overview' },
		{ href: '/admin/activity', label: 'Activity' },
		{ href: '/admin/users', label: 'Users' },
		{ href: '/admin/invites', label: 'Invites' },
		{ href: '/admin/settings', label: 'Settings' },
		{ href: '/admin/feature-flags', label: 'Feature flags' },
		{ href: '/admin/notifications', label: 'Notifications' },
		{ href: '/admin/logs', label: 'Logs' },
		{ href: '/admin/backup', label: 'Backup' }
	];

	function isActive(href: string): boolean {
		if (href === '/admin') return page.url.pathname === '/admin';
		return page.url.pathname.startsWith(href);
	}
</script>

<div class="admin-head">
	<h1 class="page-title">Admin</h1>
	<nav class="tabs">
		{#each tabs as tab (tab.href)}
			<a href={tab.href} class="tab" class:active={isActive(tab.href)}>{tab.label}</a>
		{/each}
	</nav>
</div>

{@render children()}

<style>
	.admin-head {
		margin-bottom: 24px;
	}

	.tabs {
		display: flex;
		gap: 2px;
		margin-top: 14px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.tab {
		padding: 8px 14px;
		font-size: 13.5px;
		font-weight: 500;
		color: var(--text-secondary);
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
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
