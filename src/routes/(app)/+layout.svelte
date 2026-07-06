<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NotificationPanel from '$lib/components/NotificationPanel.svelte';
	import AnnouncementBanner from '$lib/components/AnnouncementBanner.svelte';

	let { data, children } = $props();

	// A feature the user has no access to at all is absent from the nav (not shown
	// disabled) — same pattern as the admin-only Admin entry. The server-side gate
	// (requireFeature) is the real boundary; hiding the link is the courtesy.
	const flags = $derived(data.flags ?? {});
	const nav = $derived([
		{ href: '/', label: 'Dashboard', icon: 'dashboard' },
		...(flags.explorer !== false ? [{ href: '/explorer', label: 'Explorer', icon: 'blocks' }] : []),
		{ href: '/wallets', label: 'Wallets', icon: 'wallet' },
		{ href: '/activity', label: 'Activity', icon: 'activity' },
		{ href: '/settings', label: 'Settings', icon: 'settings' },
		...(data.user.isAdmin ? [{ href: '/admin', label: 'Admin', icon: 'shield' }] : [])
	]);

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	// Persistent "back up your wallet(s)" banner. A lost config can mean lost
	// funds, so it shows until resolved (server-tracked), dismissible only for the
	// current session so it returns on the next visit until backups are done.
	const unbacked = $derived(data.unbackedWallets ?? []);
	let backupDismissed = $state(false);
	$effect(() => {
		backupDismissed = sessionStorage.getItem('cairn.backup.banner.dismissed') === '1';
	});
	function dismissBackupBanner() {
		backupDismissed = true;
		sessionStorage.setItem('cairn.backup.banner.dismissed', '1');
	}

	// Separate, gentler 90-day periodic reminder for users whose backups have
	// gone stale. Dismissal is SERVER-side (persists across browsers, lapses
	// after another 90 days), so it hits a small POST endpoint rather than
	// sessionStorage. Hidden optimistically the moment the user dismisses.
	const showReminder = $derived(data.showBackupReminder ?? false);
	let reminderDismissed = $state(false);
	async function dismissBackupReminder() {
		reminderDismissed = true;
		try {
			await fetch('/api/backup-reminder/dismiss', { method: 'POST' });
		} catch {
			// Best-effort: it's just a nudge. It'll reappear next load if this
			// failed, which is the safe direction for a backup reminder.
		}
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
			<a href="/terms" class="terms-link">Terms</a>
			<div class="user-chip">
				<div class="avatar">{data.user.displayName.slice(0, 1).toUpperCase()}</div>
				<div class="user-meta">
					<div class="user-name truncate">{data.user.displayName}</div>
					<div class="user-email truncate">{data.user.email}</div>
				</div>
				<NotificationPanel />
				<form method="POST" action="/logout">
					<button class="logout-btn" title="Sign out" aria-label="Sign out">
						<Icon name="logout" size={15} />
					</button>
				</form>
			</div>
		</div>
	</aside>

	<main class="main">
		{#each data.announcements ?? [] as announcement (announcement.id)}
			<!-- Instance-wide admin announcements, above the backup nudges (an urgent
			     maintenance notice outranks a routine reminder). Server already
			     filtered by flag, expiry and this user's dismissals. -->
			<AnnouncementBanner {announcement} />
		{/each}
		{#if unbacked.length > 0 && !backupDismissed}
			<div class="backup-banner" role="status">
				<Icon name="alert-triangle" size={16} />
				<span class="grow">
					{#if unbacked.length === 1}
						<strong>{unbacked[0].name}</strong> isn't backed up.
						<a href={unbacked[0].href}>Download its config</a> — without it, a lost server can mean
						lost funds.
					{:else}
						<strong>{unbacked.length} wallets</strong> aren't backed up.
						<a href={unbacked[0].href}>Start with {unbacked[0].name}</a> — a lost config can mean
						permanently lost funds.
					{/if}
				</span>
				<button
					type="button"
					class="backup-banner-dismiss"
					aria-label="Dismiss for now"
					onclick={dismissBackupBanner}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		{/if}
		{#if showReminder && !reminderDismissed && !(unbacked.length > 0 && !backupDismissed)}
			<div class="reminder-banner" role="status">
				<Icon name="clock" size={16} />
				<span class="grow">
					It's been a while since you downloaded your wallet backups.
					<a href="/wallets">Want updated copies?</a>
				</span>
				<button
					type="button"
					class="backup-banner-dismiss"
					aria-label="Dismiss"
					onclick={dismissBackupReminder}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		{/if}
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

	.terms-link {
		display: block;
		font-size: 11.5px;
		color: var(--text-muted);
		padding: 2px 6px 8px;
	}

	.terms-link:hover {
		color: var(--accent);
	}

	.user-chip {
		display: flex;
		align-items: center;
		gap: 6px;
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

	.backup-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		background: var(--warning-muted);
		border: 1px solid rgba(232, 201, 90, 0.3);
		border-radius: var(--radius-control);
	}

	.backup-banner :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
	}

	.backup-banner strong {
		color: var(--text);
	}

	.backup-banner a {
		color: var(--accent);
		font-weight: 500;
	}

	/* Gentler than the (warning-tinted) unbacked banner: a soft surface fill,
	   since backups here already exist and just want refreshing. */
	.reminder-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.reminder-banner :global(svg) {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.reminder-banner a {
		color: var(--accent);
		font-weight: 500;
	}

	.backup-banner-dismiss {
		display: flex;
		align-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		flex-shrink: 0;
	}

	.backup-banner-dismiss:hover {
		color: var(--text);
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
			/* Edge-fade scroll cue (cairn-peoj / cairn-ei6): off-screen items
			   (Settings, Activity) otherwise had no affordance beyond a thin
			   scrollbar. The bg-colored covers are pinned to the content (local) and
			   the fades to the element (scroll), so a fade shows at an edge only
			   while there is more to scroll that way — and disappears once that end
			   is reached, leaving the end items crisp. */
			background:
				linear-gradient(to right, var(--bg) 40%, transparent) 0 0 / 30px 100% no-repeat local,
				linear-gradient(to left, var(--bg) 40%, transparent) 100% 0 / 30px 100% no-repeat local,
				linear-gradient(
						to right,
						color-mix(in srgb, var(--text) 16%, transparent),
						transparent
					)
					0 0 / 22px 100% no-repeat scroll,
				linear-gradient(
						to left,
						color-mix(in srgb, var(--text) 16%, transparent),
						transparent
					)
					100% 0 / 22px 100% no-repeat scroll;
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
