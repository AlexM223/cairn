<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { navigating } from '$app/stores';
	import Icon from '$lib/components/Icon.svelte';
	import AnnouncementBanner from '$lib/components/AnnouncementBanner.svelte';
	import SyncBanner from '$lib/components/heartwood/SyncBanner.svelte';
	import ChainHealthBanner from '$lib/components/heartwood/ChainHealthBanner.svelte';
	import HWSidebar from '$lib/components/heartwood/HWSidebar.svelte';
	import MobileTopBar from '$lib/components/heartwood/MobileTopBar.svelte';
	import MobileTabRow from '$lib/components/heartwood/MobileTabRow.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import NavProgress from '$lib/components/heartwood/NavProgress.svelte';
	import { maybeRedirectToSecure } from '$lib/secureRedirect';
	import { primaryNav, accountMenuLinks } from '$lib/nav';
	import { deriveHealth } from '$lib/health';
	import { chainHealth as liveChainHealth } from '$lib/live/chainHealth.svelte';

	let { data, children } = $props();

	// THE shared Health object (UX redesign Phase 3, cairn-gt05.3, spec §2.6b):
	// the exact deriveHealth() Home's health line and the admin Health page
	// call, fed this layout's altitude of inputs — live chain-transport health
	// (falling back to the SSR seed before hydration's first nudge lands) and
	// the unbacked-wallet list this load already threads. The banners below
	// render FROM this object's duty statuses — ChainHealthBanner is the node
	// duty's voice, the backup nudge is the backups duty's voice — so banner,
	// Home line, and Health page can never tell different stories about the
	// same signal (one truth, three altitudes).
	const layoutHealth = $derived(
		deriveHealth({
			chainHealthy: (liveChainHealth.health ?? data.chainHealth ?? null)?.healthy ?? null,
			unbackedCount: data.unbackedWallets?.length ?? 0
		})
	);

	// Returning users who already accepted the self-signed cert land on the
	// secure address automatically (cairn-6uff); everyone else stays put and
	// keeps the guided SecureContextHelp flow. No-op on secure contexts.
	onMount(() => {
		void maybeRedirectToSecure(data.httpsPort ?? null);
	});

	// Primary nav (docs/UX-SIMPLIFICATION-SPEC.md §2, cairn-6c91u.1): dynamic
	// 2-4 destinations — Home/Wallets always, Mining/Explorer iff their
	// instance flag resolves true (the same predicate requireFeature() uses) —
	// the same set on the desktop rail and the mobile tab row. Everything else
	// — Health, Settings, Notifications, Activity — reaches the app through
	// the gear icon (always present, → /settings) and the account menu. A
	// feature the user has no access to is absent from that menu (not shown
	// disabled); the server-side gate (requireFeature / admin auth) is the
	// real boundary, hiding the link is the courtesy.
	const flags = $derived(data.flags ?? {});
	const nav = $derived(primaryNav({ flags }));
	const tabs = $derived(nav.map(({ href, label }) => ({ href, label })));
	const menuEntries = $derived(accountMenuLinks({ isAdmin: data.user.isAdmin, flags }));

	// Heartwood mobile shell, tab vs flow (verified against src/routes/(app)):
	// - Tab pages (top bar + text-tab row): `/`, `/explorer/**` (block/tx/address
	//   details are still explorer browsing and keep the search top bar),
	//   `/wallets` and `/vaults` exactly (top-level lists), `/activity`,
	//   `/mining/**` (cairn-6c91u.1: Mining joined the dynamic primary nav, so
	//   it now gets the full tab-page treatment — top bar AND the bottom tab
	//   row — instead of the old bespoke top-bar-only special case).
	// - Flow pages (back-circle header): everything else — wallet/vault detail,
	//   send/sign wizards, `/settings/**`, `/admin/**`, `/recovery-setup`.
	// `/vaults` currently exists only as empty scaffolding dirs; it mirrors the
	// wallets tree (list → [id] → send), so it's classified the same way.
	function isTabRoute(pathname: string): boolean {
		if (pathname === '/' || pathname === '/wallets' || pathname === '/vaults') return true;
		if (pathname === '/activity') return true;
		if (pathname === '/mining' || pathname.startsWith('/mining/')) return true;
		return pathname === '/explorer' || pathname.startsWith('/explorer/');
	}
	const isTab = $derived(isTabRoute(page.url.pathname));
	const isExplorer = $derived(
		page.url.pathname === '/explorer' || page.url.pathname.startsWith('/explorer/')
	);

	// Route → content lane (docs/DESKTOP-LAYOUT-DESIGN.md §2/§4). Two measures
	// only: `reading` (calm, single-decision, forms, wizards, send flows) caps
	// narrow; `data` (dense, tabular — explorer/activity/admin/wallets/mining)
	// fills wide. Applied as a class on <main>; on mobile both measures exceed
	// the viewport so the class is inert (the <900 shell is untouched). Pages
	// keep their own internal caps until each page's later wave lands — this
	// only sets the outer lane.
	function laneFor(pathname: string): 'reading' | 'data' {
		// Reading first — these win over the broader `/wallets` data catch below.
		if (pathname === '/' || pathname === '/recovery-setup') return 'reading';
		if (pathname.startsWith('/settings')) return 'reading';
		if (pathname.endsWith('/send')) return 'reading'; // send flows
		if (
			pathname === '/wallets/new' ||
			pathname.startsWith('/wallets/multisig/new') ||
			pathname.startsWith('/wallets/multisig/stateless')
		)
			return 'reading'; // wallet-creation wizards
		// Data lanes.
		if (pathname.startsWith('/explorer')) return 'data';
		if (pathname === '/activity') return 'data';
		if (pathname.startsWith('/admin')) return 'data';
		if (pathname.startsWith('/wallets') || pathname.startsWith('/vaults')) return 'data';
		if (pathname.startsWith('/mining')) return 'data';
		// Fallback: tab (list) pages read as data, flow (back-circle) pages as reading.
		return isTabRoute(pathname) ? 'data' : 'reading';
	}
	const lane = $derived(laneFor(page.url.pathname));

	// Persistent "back up your wallet(s)" banner — decaying + polymorphic +
	// state-driven cadence (cairn-gt05.5, docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-
	// SPEC.md Spec A). The server (getDueBackupNudge, src/lib/server/backups.ts)
	// owns WHEN this is due — a widening decay schedule instead of "every
	// session" — and WHICH copy variant to show, so a never-dismissing user
	// still only sees it on the decayed cadence, not every visit. This
	// component's dismiss is a SESSION-ONLY hide-for-now on top of that; it does
	// not reset the server-side decay clock.
	const nudge = $derived(data.backupNudge);
	let backupDismissed = $state(false);
	$effect(() => {
		backupDismissed = sessionStorage.getItem('cairn.backup.banner.dismissed') === '1';
	});
	function dismissBackupBanner() {
		backupDismissed = true;
		sessionStorage.setItem('cairn.backup.banner.dismissed', '1');
	}

	// Polymorphic copy, keyed by the variantId the server selects (calm
	// rotation V1..V5 by shown_count, or an escalated E-FUNDED / E-MULTI variant
	// for one showing after a stakes-raising event) — kept here, next to the
	// styling, per the spec. `{name}` / `{unbackedCount}` are interpolated by
	// the render below rather than baked into these templates so the strings
	// stay simple data, not markup.
	interface NudgeInterp {
		name: string;
		unbackedCount: number;
	}
	const BACKUP_NUDGE_COPY: Record<string, { text: (n: NudgeInterp) => string; cta: (n: NudgeInterp) => string }> = {
		V1: {
			text: (n) => `${n.name} lives only on this server right now. Download its backup so you can always get it back.`,
			cta: () => 'Download backup'
		},
		V2: {
			text: (n) =>
				`One thing left for ${n.name}: save its backup. Without it, losing this server means losing access to the funds.`,
			cta: () => 'Save it now'
		},
		V3: {
			text: (n) =>
				`Still no backup for ${n.name}. It takes a minute, and it's the one copy that protects your bitcoin.`,
			cta: () => 'Download backup'
		},
		V4: {
			text: (n) =>
				`A copy of ${n.name}'s setup only exists here. Keep one somewhere safe — a phone, a drive, a printout.`,
			cta: () => 'Get the backup'
		},
		V5: {
			text: (n) => `${n.name} still isn't backed up. Whenever you're ready, the file's right here.`,
			cta: () => 'Download backup'
		},
		'E-FUNDED': {
			text: (n) => `${n.name} now holds bitcoin and still has no backup. Save it now so a lost server can't cost you.`,
			cta: (n) => `Back up ${n.name}`
		},
		'E-MULTI': {
			text: (n) => `${n.unbackedCount} wallets still need backups. Start with ${n.name} — each one's setup exists only here.`,
			cta: (n) => `Start with ${n.name}`
		}
	};
	const nudgeCopy = $derived(nudge ? (BACKUP_NUDGE_COPY[nudge.variantId] ?? BACKUP_NUDGE_COPY.V1) : null);
	const nudgeText = $derived(
		nudge && nudgeCopy ? nudgeCopy.text({ name: nudge.name, unbackedCount: nudge.unbackedCount }) : ''
	);
	const nudgeCta = $derived(
		nudge && nudgeCopy ? nudgeCopy.cta({ name: nudge.name, unbackedCount: nudge.unbackedCount }) : ''
	);

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
	<HWSidebar navItems={nav} {menuEntries} user={data.user} operatorName={data.operatorName ?? null} />

	<div class="content">
		<NavProgress />
		{#if isTab}
			<MobileTopBar
				variant={isExplorer ? 'search' : 'dial'}
				user={data.user}
				operatorName={data.operatorName ?? null}
				{menuEntries}
			/>
			<MobileTabRow {tabs} />
		{:else}
			<!-- Flow pages: back circle only. The centered eyebrow + spacer row is
			     composed by each flow page as its lane lands (cairn-koy4.5/6). -->
			<div class="mobile-flow-header">
				<BackCircle />
			</div>
		{/if}

		<main class="main lane-{lane}" aria-busy={$navigating ? 'true' : 'false'}>
			<!-- Instance-wide chain-transport health (cairn-hy8z). Always mounted;
			     renders nothing until the Electrum pool / SOCKS5 proxy is unhealthy,
			     then warns that balances may be stale and (for admins) links to the
			     connection settings. Polls /api/chain-health, a cheap in-memory read. -->
			<ChainHealthBanner
				isAdmin={data.user.isAdmin}
				hasSnapshot={data.hasChainSnapshot ?? false}
				initialHealth={data.chainHealth ?? null}
			/>
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
			{#if nudge && !backupDismissed && layoutHealth.backups.status === 'attention'}
				<!-- The backups duty's banner voice: getDueBackupNudge() still owns
				     WHEN it's due (the gt05.5 decaying cadence and variant copy are
				     unchanged); the Health object's backups status is the WHETHER —
				     the same amber verdict Home's line and the Health page show. -->
				<div class="backup-banner" role="status">
					<Icon name="alert-triangle" size={16} />
					<span class="grow">
						{nudgeText}
						<a href={nudge.href}>{nudgeCta}</a>
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
			{#if showReminder && !reminderDismissed && !(nudge && !backupDismissed)}
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

	/* Content column. The global 940px cap is gone (cairn-md1k.1); the centered
	   lane is now set per route by the .lane-reading / .lane-data class applied
	   above (docs/DESKTOP-LAYOUT-DESIGN.md §2). On mobile both measures exceed
	   the viewport, so the lane classes are inert and the column stays full-width
	   as before. */
	.main {
		flex: 1;
		width: 100%;
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
