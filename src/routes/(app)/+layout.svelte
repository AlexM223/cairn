<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, children } = $props();

	const nav = $derived([
		{ href: '/', label: 'Dashboard', icon: 'dashboard' },
		{ href: '/explorer', label: 'Explorer', icon: 'blocks' },
		{ href: '/wallets', label: 'Wallets', icon: 'wallet' },
		{ href: '/activity', label: 'Activity', icon: 'activity' },
		{ href: '/settings', label: 'Settings', icon: 'settings' },
		...(data.user.isAdmin ? [{ href: '/admin', label: 'Admin', icon: 'shield' }] : [])
	]);

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<div class="shell">
	<aside class="sidebar">
		<a href="/" class="brand" aria-label="Cairn home">
			<Logo size={22} wordmark />
		</a>

		<nav class="nav">
			{#each nav as item (item.href)}
				<a href={item.href} class="nav-item" class:active={isActive(item.href)}>
					<Icon name={item.icon} size={17} />
					<span>{item.label}</span>
				</a>
			{/each}
		</nav>

		<div class="sidebar-foot">
			<div class="user-chip">
				<div class="avatar">{data.user.displayName.slice(0, 1).toUpperCase()}</div>
				<div class="user-meta">
					<div class="user-name truncate">{data.user.displayName}</div>
					<div class="user-email truncate">{data.user.email}</div>
				</div>
				<form method="POST" action="/logout">
					<button class="logout-btn" title="Sign out" aria-label="Sign out">
						<Icon name="logout" size={15} />
					</button>
				</form>
			</div>
		</div>
	</aside>

	<main class="main">
		{@render children()}
	</main>
</div>

<style>
	.shell {
		display: flex;
		min-height: 100vh;
	}

	.sidebar {
		width: 216px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border-subtle);
		background: var(--bg);
		position: sticky;
		top: 0;
		height: 100vh;
	}

	.brand {
		display: flex;
		align-items: center;
		padding: 20px 20px 16px;
	}

	.nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px;
		flex: 1;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 11px;
		border-radius: var(--radius-control);
		color: var(--text-secondary);
		font-size: 13.5px;
		font-weight: 500;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.nav-item:hover {
		color: var(--text);
		background: var(--surface);
	}

	.nav-item.active {
		color: var(--accent);
		background: var(--accent-muted);
	}

	.sidebar-foot {
		padding: 12px 10px;
		border-top: 1px solid var(--border-subtle);
	}

	.user-chip {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 6px 8px;
		border-radius: var(--radius-control);
	}

	.avatar {
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12.5px;
		font-weight: 600;
	}

	.user-meta {
		flex: 1;
		min-width: 0;
	}

	.user-name {
		font-size: 12.5px;
		font-weight: 500;
	}

	.user-email {
		font-size: 11px;
		color: var(--text-muted);
	}

	.logout-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		border-radius: var(--radius-chip);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.logout-btn:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	.main {
		flex: 1;
		min-width: 0;
		padding: 28px 32px 64px;
		max-width: 1200px;
	}

	@media (max-width: 768px) {
		.shell {
			flex-direction: column;
		}

		.sidebar {
			width: 100%;
			height: auto;
			position: static;
			border-right: none;
			border-bottom: 1px solid var(--border-subtle);
		}

		.brand {
			padding: 14px 16px 8px;
		}

		.nav {
			flex-direction: row;
			overflow-x: auto;
			padding: 4px 10px 10px;
		}

		.nav-item {
			padding: 7px 12px;
			white-space: nowrap;
		}

		.sidebar-foot {
			display: none;
		}

		.main {
			padding: 20px 16px 48px;
		}
	}
</style>
