<script lang="ts">
	// Heartwood mobile top bar (<=900px, tab pages + mining, cairn-5e2k): mark +
	// wordmark on the left; on the right an at-tip dial pill placeholder (or a
	// search icon on Explorer, per spec) and the avatar menu. Everything that
	// left the primary nav (spec §2.7, cairn-gt05.4) — Explorer, Mining, Health,
	// Settings, Notifications — lives behind the avatar menu; the tab row below
	// shows only the three primaries.
	//
	// Notifications (cairn-vjjc4 lineage): the desktop HWSidebar mounts its own
	// NotificationPanel, display:none'd below 900px — so this bar mounts a
	// second, external-mode instance anchored to the avatar. That's safe to
	// duplicate: liveClient.ts is a refcounted singleton over one shared
	// EventSource, so two mounted panels don't open two SSE connections, just
	// one extra (idempotent) initial /api/notifications fetch. Only one is ever
	// visible at a time (complementary CSS breakpoints + aria-hidden). The
	// unread badge rides on the avatar itself.
	import NotificationPanel from '$lib/components/NotificationPanel.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { notifUnread } from '$lib/live/notifUnread.svelte';
	import { viewport } from '$lib/viewport.svelte';
	import type { AccountMenuLink } from '$lib/nav';

	let {
		variant = 'dial',
		user,
		operatorName = null,
		menuEntries
	}: {
		variant?: 'dial' | 'search';
		user: { displayName: string; email: string; isAdmin: boolean };
		operatorName?: string | null;
		menuEntries: AccountMenuLink[];
	} = $props();

	// Heartwood mark, detail="simple" — inlined (shared HeartwoodMark component
	// is a parallel lane; consolidation is a later cleanup pass).
	const MARK_RINGS = (
		[
			[44, 2.4, 0.95],
			[36, 1.2, 0.6],
			[27.5, 1.9, 0.85],
			[18.5, 1.2, 0.6],
			[10.5, 1.7, 0.8]
		] as const
	).map(([r, w, o]) => {
		const t = r / 45;
		return { cx: 49 + t * 2, cy: 45 + t * 7, rx: r, ry: r * 0.955, w, o };
	});

	let menuOpen = $state(false);
	let menuWrap = $state<HTMLDivElement | null>(null);
	let notifOpen = $state(false);
	let avatarEl = $state<HTMLButtonElement | null>(null);

	function onDocClick(e: MouseEvent) {
		if (menuOpen && menuWrap && !menuWrap.contains(e.target as Node)) menuOpen = false;
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
	}

	function openNotifications(e: MouseEvent) {
		// stopPropagation so the panel's document click handler doesn't close it
		// on the same click that opened it.
		e.stopPropagation();
		menuOpen = false;
		notifOpen = true;
	}

	const accountLabel = $derived(
		notifUnread.count > 0
			? `Account menu (${notifUnread.count} unread notification${notifUnread.count === 1 ? '' : 's'})`
			: 'Account menu'
	);
</script>

<svelte:window onclick={onDocClick} onkeydown={onKeydown} />

<!-- aria-hidden above 900px: the desktop rail owns nav/account chrome there and
     this bar is display:none — the explicit attribute keeps the a11y tree to
     exactly one nav/account surface per breakpoint (spec §2.7). -->
<header class="topbar" aria-hidden={viewport.isMobile ? undefined : 'true'}>
	<a href="/" class="brand" aria-label="Home">
		<svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true">
			{#each MARK_RINGS as ring (ring.rx)}
				<ellipse
					cx={ring.cx}
					cy={ring.cy}
					rx={ring.rx}
					ry={ring.ry}
					fill="none"
					stroke="var(--accent)"
					stroke-width={ring.w}
					opacity={ring.o}
				/>
			{/each}
			<circle cx="49.3" cy="46" r="4" fill="var(--accent-core)" />
		</svg>
		<span class="wordmark">Heartwood</span>
	</a>

	<div class="right">
		{#if variant === 'search'}
			<a href="/explorer" class="search-btn" aria-label="Search the chain">
				<svg
					width="17"
					height="17"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					aria-hidden="true"
				>
					<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3" />
				</svg>
			</a>
		{:else}
			<!-- At-tip dial pill placeholder: static glyph only, no invented sync
			     copy — the Node lane (cairn-koy4.8) wires the live height. -->
			<span class="tip-pill" aria-hidden="true">
				<svg width="16" height="16" viewBox="0 0 34 34" class="tip-dial">
					<circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--border-subtle)" stroke-width="2.4" />
					<circle
						cx="17"
						cy="17"
						r="13.5"
						fill="none"
						stroke="var(--accent)"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-dasharray="27.5 57.3"
						transform="rotate(-90 17 17)"
					/>
					<circle cx="27.8" cy="10.7" r="2.6" fill="var(--accent-glow)" class="tip-dot" />
					<circle cx="17" cy="17" r="2" fill="var(--accent-core)" />
				</svg>
			</span>
		{/if}

		<!-- Gear icon → /settings (docs/UX-SIMPLIFICATION-SPEC.md §2.3, decision
		     3): always present in the mobile top bar, top-right, alongside the
		     avatar — mirrors the desktop rail's gear at the rail bottom. -->
		<a href="/settings" class="settings-btn" aria-label="Settings" title="Settings">
			<Icon name="settings" size={17} strokeWidth={1.6} />
		</a>

		<div class="menu-wrap" bind:this={menuWrap}>
			<button
				type="button"
				class="avatar"
				bind:this={avatarEl}
				aria-haspopup="true"
				aria-expanded={menuOpen}
				aria-label={accountLabel}
				onclick={() => (menuOpen = !menuOpen)}
			>
				{user.displayName.slice(0, 1).toUpperCase()}
				{#if notifUnread.count > 0}
					<span class="avatar-badge" aria-hidden="true"
						>{notifUnread.count > 99 ? '99+' : notifUnread.count}</span
					>
				{/if}
			</button>
			{#if menuOpen}
				<div class="menu" role="menu">
					<div class="menu-user">
						<div class="menu-name truncate">{user.displayName}</div>
						<div class="menu-email truncate">{user.email}</div>
					</div>
					<!-- Account menu order (spec §2.3, decision 3): Notifications, Activity,
					     Health, Settings, Terms, Sign out. Notifications opens an in-place
					     panel (not a navigation) so it's rendered here rather than via
					     accountMenuLinks(), which supplies the navigable middle. -->
					<button
						type="button"
						class="menu-item"
						role="menuitem"
						aria-label={notifUnread.count > 0
							? `Notifications, ${notifUnread.count} unread`
							: 'Notifications'}
						onclick={openNotifications}
					>
						Notifications
						{#if notifUnread.count > 0}
							<span class="menu-count" aria-hidden="true"
								>{notifUnread.count > 99 ? '99+' : notifUnread.count}</span
							>
						{/if}
					</button>
					{#each menuEntries as entry (entry.href)}
						<a
							href={entry.href}
							class="menu-item"
							role="menuitem"
							onclick={() => (menuOpen = false)}
						>
							{entry.label}
						</a>
					{/each}
					<a href="/terms" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
						Terms
					</a>
					{#if operatorName}
						<a
							href="/terms"
							class="menu-note truncate"
							onclick={() => (menuOpen = false)}
							title="Operated by {operatorName}"
						>
							operated by <strong>{operatorName}</strong>
						</a>
					{/if}
					<div class="menu-sep" role="separator"></div>
					<form method="POST" action="/logout">
						<button class="menu-item menu-signout" role="menuitem">Sign out</button>
					</form>
				</div>
			{/if}
			<NotificationPanel variant="external" anchor={avatarEl} bind:open={notifOpen} />
		</div>
	</div>
</header>

<style>
	.topbar {
		display: none;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
	}

	.wordmark {
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.search-btn {
		position: relative;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-icon-btn);
		border: 1px solid var(--border-control);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	/* Gear → /settings (spec §2.3): same icon-button treatment as .search-btn,
	   always present next to the avatar. */
	.settings-btn {
		position: relative;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-icon-btn);
		border: 1px solid var(--border-control);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.tip-pill {
		display: flex;
		align-items: center;
		padding: 6px 7px;
		background: rgba(255, 255, 255, 0.025);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-status-pill);
	}

	.tip-dial {
		overflow: visible;
		display: block;
	}

	.tip-dot {
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.menu-wrap {
		position: relative;
	}

	.avatar {
		position: relative;
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 50%;
		background: linear-gradient(135deg, var(--accent-dim), var(--accent));
		display: flex;
		align-items: center;
		justify-content: center;
		font: 600 12.5px var(--font-ui);
		color: var(--on-accent);
		cursor: pointer;
		padding: 0;
	}

	/* Unread badge on the avatar (spec §2.7): the old bell's badge treatment,
	   carried onto the account trigger now that the bell left the chrome. */
	.avatar-badge {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--bg);
		border: 1px solid var(--bg);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 13px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* Touch-target batch (cairn-uxdev batch 2, item 3): the visual avatar stays
	   30x30, but an invisible ::after extends the actual hit area to ~44x44 on
	   mobile, where this bar is shown (.topbar is display:none above 900px). */
	@media (max-width: 900px) {
		.avatar::after {
			content: '';
			position: absolute;
			inset: -7px;
		}

		/* Same invisible-hit-area treatment for the 32x32 Explorer search icon
		   (cairn-amyl): -6px => 44x44 effective, visual unchanged. */
		.search-btn::after {
			content: '';
			position: absolute;
			inset: -6px;
		}

		/* Same treatment for the 32x32 gear icon (cairn-6c91u.1). */
		.settings-btn::after {
			content: '';
			position: absolute;
			inset: -6px;
		}
	}

	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		width: 216px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-control);
		border-radius: 12px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		padding: 6px;
		z-index: 50;
	}

	.menu-user {
		padding: 8px 10px 9px;
		border-bottom: 1px solid var(--hairline);
		margin-bottom: 4px;
	}

	.menu-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.menu-email {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: none;
		background: none;
		border-radius: 8px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.menu-item:hover {
		background: rgba(255, 255, 255, 0.03);
		color: var(--text);
	}

	.menu-count {
		display: inline-block;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		margin-left: 6px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--bg);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 15px;
		text-align: center;
		font-variant-numeric: tabular-nums;
		vertical-align: 1px;
	}

	.menu-sep {
		height: 1px;
		margin: 4px 6px;
		background: var(--hairline);
	}

	.menu-note {
		display: block;
		padding: 6px 10px 7px;
		font-size: 11px;
		color: var(--text-muted);
	}

	.menu-note strong {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.menu-signout {
		color: var(--text-muted);
	}

	.menu-signout:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	@media (max-width: 900px) {
		.topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 16px 18px;
		}
	}
</style>
