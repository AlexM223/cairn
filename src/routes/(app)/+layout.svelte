<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { navigating } from '$app/stores';
	import Icon from '$lib/components/Icon.svelte';
	import AnnouncementBanner from '$lib/components/AnnouncementBanner.svelte';
	import SyncBanner from '$lib/components/heartwood/SyncBanner.svelte';
	import ChainHealthBanner from '$lib/components/heartwood/ChainHealthBanner.svelte';
	import HWRail from '$lib/components/heartwood/HWRail.svelte';
	import MobileTopBar from '$lib/components/heartwood/MobileTopBar.svelte';
	import MobileTabRow from '$lib/components/heartwood/MobileTabRow.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import NavProgress from '$lib/components/heartwood/NavProgress.svelte';
	import { maybeRedirectToSecure } from '$lib/secureRedirect';

	let { data, children } = $props();

	// Returning users who already accepted the self-signed cert land on the
	// secure address automatically (cairn-6uff); everyone else stays put and
	// keeps the guided SecureContextHelp flow. No-op on secure contexts.
	onMount(() => {
		void maybeRedirectToSecure(data.httpsPort ?? null);
	});

	// A feature the user has no access to at all is absent from the nav (not shown
	// disabled) — same pattern as the admin-only Node entry. The server-side gate
	// (requireFeature) is the real boundary; hiding the link is the courtesy.
	const flags = $derived(data.flags ?? {});
	const nav = $derived([
		{ href: '/', label: 'Home', icon: 'dashboard' },
		...(flags.explorer !== false ? [{ href: '/explorer', label: 'Explorer', icon: 'explorer' }] : []),
		{ href: '/wallets', label: 'Wallets', icon: 'wallet' },
		{ href: '/activity', label: 'Activity', icon: 'activity' },
		...(data.user.isAdmin ? [{ href: '/admin', label: 'Node', icon: 'server' }] : []),
		{ href: '/settings', label: 'Settings', icon: 'settings' }
	]);

	// Mobile tab row shows only the four tab destinations — Node & Settings are
	// reached through the avatar menu on mobile (Heartwood responsive spec).
	const tabs = $derived(
		nav
			.filter((item) => item.href !== '/settings' && item.href !== '/admin')
			.map(({ href, label }) => ({ href, label }))
	);

	// Heartwood mobile shell, tab vs flow (verified against src/routes/(app)):
	// - Tab pages (top bar + text-tab row): `/`, `/explorer/**` (block/tx/address
	//   details are still explorer browsing and keep the search top bar),
	//   `/wallets` and `/vaults` exactly (top-level lists), `/activity`.
	// - Flow pages (back-circle header): everything else — wallet/vault detail,
	//   send/sign wizards, `/settings/**`, `/admin/**`, `/recovery-setup`.
	// `/vaults` currently exists only as empty scaffolding dirs; it mirrors the
	// wallets tree (list → [id] → send), so it's classified the same way.
	function isTabRoute(pathname: string): boolean {
		if (pathname === '/' || pathname === '/wallets' || pathname === '/vaults') return true;
		if (pathname === '/activity') return true;
		return pathname === '/explorer' || pathname.startsWith('/explorer/');
	}
	const isTab = $derived(isTabRoute(page.url.pathname));
	const isExplorer = $derived(
		page.url.pathname === '/explorer' || page.url.pathname.startsWith('/explorer/')
	);

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
	<HWRail navItems={nav} user={data.user} operatorName={data.operatorName ?? null} />

	<div class="content">
		<NavProgress />
		{#if isTab}
			<MobileTopBar
				variant={isExplorer ? 'search' : 'dial'}
				user={data.user}
				operatorName={data.operatorName ?? null}
			/>
			<MobileTabRow {tabs} />
		{:else}
			<!-- Flow pages: back circle only. The centered eyebrow + spacer row is
			     composed by each flow page as its lane lands (cairn-koy4.5/6). -->
			<div class="mobile-flow-header">
				<BackCircle />
			</div>
		{/if}

		<main class="main" aria-busy={$navigating ? 'true' : 'false'}>
			<!-- Instance-wide chain-transport health (cairn-hy8z). Always mounted;
			     renders nothing until the Electrum pool / SOCKS5 proxy is unhealthy,
			     then warns that balances may be stale and (for admins) links to the
			     connection settings. Polls /api/chain-health, a cheap in-memory read. -->
			<ChainHealthBanner isAdmin={data.user.isAdmin} hasSnapshot={data.hasChainSnapshot ?? false} />
			{#if !data.firstSyncComplete && !data.hasChainSnapshot}
				<!-- Non-blocking first-sync indicator (cairn-2zxt.1). Shown until the
				     chain-history cache exists; polls /api/sync for live detail and
				     removes itself when the count reaches the tip. Never blocks the
				     page — the app under it is fully usable while this counts.
				     Suppressed once a persisted chain snapshot exists (cairn-6efi QA
				     P2-a, ported from explorer/heartwood-wave2) — a "0% first sync"
				     banner stacked above pages already showing real snapshot data
				     reads as a contradiction; the history walk keeps running in the
				     background regardless. -->
				<SyncBanner />
			{/if}
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
</div>

<style>
	.shell {
		display: flex;
		min-height: 100vh;
	}

	.content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/* Heartwood desktop content column: max-width 940 centered. (Dense pages —
	   Activity/Node/Settings — narrow further to 760 in their own lanes.) */
	.main {
		flex: 1;
		width: 100%;
		max-width: 940px;
		margin: 0 auto;
		padding: 54px 52px 44px;
	}

	.mobile-flow-header {
		display: none;
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
		border: 1px solid var(--warning-border);
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
		position: relative;
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

	/* Touch-target fix (cairn-amyl, flagged in its 2026-07-14 QA comment): the
	   visual icon stays 18x18, but an invisible ::after extends the actual hit
	   area to ~44x44, matching the MobileTopBar avatar/search-icon pattern. */
	.backup-banner-dismiss::after {
		content: '';
		position: absolute;
		inset: -13px;
	}

	@media (max-width: 900px) {
		.main {
			padding: 20px 18px 48px;
		}

		.mobile-flow-header {
			display: flex;
			align-items: center;
			padding: 16px 18px 0;
		}
	}
</style>
