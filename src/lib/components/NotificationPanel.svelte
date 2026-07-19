<script lang="ts">
	// In-app notification bell + dropdown panel (Unit 2, §2.1 of
	// docs/NOTIFICATION-PLAN.md). Lives in the (app) sidebar next to the user
	// chip. Shows an unread badge, and on click drops a panel listing recent
	// notifications with the same level-based icon/colour treatment the
	// /activity page uses. The `notification` topic on the single /api/live SSE
	// stream keeps the badge fresh without polling; the panel list is fetched on open.
	//
	// Read model is instance-wide (a single events.read_at column) — see the API
	// route. "Mark all read" clears every visible unread row for this user.

	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';
	import { subscribe } from '$lib/live/liveClient';
	import { notifUnread } from '$lib/live/notifUnread.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	// Nav rewrite (cairn-gt05.4, spec §2.7): the standalone bell left the shell
	// chrome — the unread badge lives on the account avatar (via the shared
	// notifUnread cell) and the panel opens from the account menu's
	// "Notifications" entry. `variant="external"` renders NO trigger of its own:
	// the parent binds `open` and passes the avatar as `anchor` so the top-layer
	// panel pins to it. The legacy `variant="bell"` trigger is kept intact for
	// any future standalone mount.

	// Mirrors the server's ActivityEvent (kept local so this client component
	// never imports a $lib/server module), plus the readAt field.
	type Notification = {
		id: number;
		type: string;
		level: 'info' | 'success' | 'warn' | 'error';
		message: string;
		detail: Record<string, unknown> | null;
		createdAt: string;
		scope: 'you' | 'instance';
		readAt: string | null;
	};

	let {
		variant = 'bell',
		anchor = null,
		open = $bindable(false)
	}: {
		/** 'bell' renders the classic bell trigger; 'external' renders none. */
		variant?: 'bell' | 'external';
		/** Element the top-layer panel pins to in external mode (the avatar). */
		anchor?: HTMLElement | null;
		/** Bindable in external mode so the account menu can open the panel. */
		open?: boolean;
	} = $props();

	let items = $state<Notification[]>([]);
	let loading = $state(false);
	let panelEl = $state<HTMLDivElement | null>(null);
	let bellEl = $state<HTMLButtonElement | null>(null);
	let popEl = $state<HTMLDivElement | null>(null);

	// The sidebar is position:sticky — a stacking context — so no z-index can
	// lift the panel above main-content stacking contexts (.fade-in animates a
	// transform, which is enough to paint over it; cairn-k391). The Popover API
	// puts the panel in the browser TOP LAYER, above everything, ending the
	// z-index war outright. Feature-detected: without it (old browsers) the
	// absolute-positioned fallback below still works, it just isn't top-layer.
	const canPopover =
		typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

	/** Pin the top-layer panel to the bell: same left edge, opening upward from
	 *  the desktop sidebar's bottom-anchored bell, or downward from the mobile
	 *  top bar's top-anchored one (cairn-vjjc4) — same @900px breakpoint the
	 *  rest of the mobile shell (HWSidebar/MobileTopBar) switches on. */
	function positionPanel() {
		const trigger = variant === 'external' ? anchor : bellEl;
		if (!popEl || !trigger) return;
		const rect = trigger.getBoundingClientRect();
		// Clamp so the 320px panel never leaves the viewport on narrow screens.
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - 320 - 8));
		popEl.style.left = `${left}px`;
		if (window.innerWidth <= 900) {
			popEl.style.top = `${rect.bottom + 8}px`;
			popEl.style.bottom = 'auto';
		} else {
			popEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
			popEl.style.top = 'auto';
		}
	}

	$effect(() => {
		if (!open || !popEl || !canPopover) return;
		positionPanel();
		try {
			popEl.showPopover();
		} catch {
			// Already shown, or the browser refused — the panel still renders.
		}
		window.addEventListener('resize', positionPanel);
		return () => window.removeEventListener('resize', positionPanel);
	});

	// Same event-type → icon map the /activity page uses, extended with the
	// notification event types (Unit 8). Unknown types fall back by level below.
	const ICON: Record<string, string> = {
		network_up: 'server',
		network_down: 'server',
		new_block: 'blocks',
		broadcast: 'arrow-up-right',
		signing_started: 'shield',
		electrum_switched: 'refresh',
		scan_complete: 'refresh',
		wallet_added: 'wallet',
		wallet_created: 'shield',
		tx_received: 'arrow-down-left',
		tx_confirmed: 'check',
		tx_large: 'zap',
		key_health_due: 'shield',
		backup_missing: 'alert-triangle',
		backup_stale: 'clock',
		sign_session_waiting: 'clock',
		sign_session_complete: 'check',
		admin_new_signup: 'users',
		admin_invite_used: 'ticket',
		admin_restore: 'alert-triangle',
		admin_server_health: 'server',
		admin_user_disabled: 'users',
		admin_settings_changed: 'settings',
		admin_recovery_code_minted: 'shield',
		security_failed_login: 'shield',
		security_new_passkey: 'shield',
		security_password_changed: 'shield',
		security_new_device: 'eye'
	};
	function iconFor(n: Notification): string {
		if (ICON[n.type]) return ICON[n.type];
		if (n.level === 'warn' || n.level === 'error') return 'alert-triangle';
		return 'info';
	}

	function ago(iso: string): string {
		const secs = Math.floor(new Date(iso).getTime() / 1000);
		return Number.isFinite(secs) ? timeAgo(secs) : '';
	}

	// A notification's deep link: an explicit detail.link wins — notify() in
	// notifications.ts merges payload.link into the persisted detail JSON under
	// the "link" key (cairn-ay45q), so this reads that back out. Older rows
	// written before that fix have no detail.link at all; for those, fall back
	// to a txid → explorer link like the activity page does. Only same-origin
	// relative paths are honoured.
	// With the explorer feature flag off, /explorer/** 403s server-side EXCEPT
	// /explorer/tx/[txid] (cairn-5yz3.3 — tx detail is exempt from the flag, it's
	// not chain browsing, and it's the only tx-detail surface in the app). So
	// only non-tx explorer links (block/address/mempool) get suppressed here.
	function linkFor(n: Notification): string | null {
		const explorerEnabled = page.data.flags?.explorer !== false;
		const raw = n.detail?.link;
		if (typeof raw === 'string' && raw.startsWith('/')) {
			const isTxLink = /^\/explorer\/tx\//.test(raw);
			if (!explorerEnabled && raw.startsWith('/explorer/') && !isTxLink) return null;
			return raw;
		}
		const txid = n.detail?.txid;
		if (typeof txid === 'string') return `/explorer/tx/${txid}`;
		return null;
	}

	async function load() {
		if (loading) return;
		loading = true;
		try {
			const res = await fetch('/api/notifications?limit=30');
			if (res.ok) {
				const body = (await res.json()) as { notifications: Notification[]; unread: number };
				items = body.notifications;
				notifUnread.count = body.unread;
			}
		} catch {
			// Transient — keep whatever we last had.
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
	}

	// Fetch the list whenever the panel opens, whichever trigger opened it (the
	// bell's toggle or the account menu's Notifications entry).
	$effect(() => {
		if (open) void load();
	});

	async function markAllRead() {
		// Optimistic: clear locally, then persist. A failure re-syncs on next open.
		notifUnread.count = 0;
		items = items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }));
		try {
			const res = await fetch('/api/notifications', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ all: true })
			});
			if (res.ok) {
				const body = (await res.json()) as { unread: number };
				notifUnread.count = body.unread;
			}
		} catch {
			// Best-effort — the badge re-derives on the next load.
		}
	}

	function onDocClick(e: MouseEvent) {
		if (!open) return;
		// The popover is still a DOM descendant of .notif (top layer doesn't
		// reparent), so one containment check covers bell + panel in both modes.
		// (External openers — the account menu's Notifications entry — call
		// stopPropagation so their opening click never reaches this handler.)
		if (panelEl && !panelEl.contains(e.target as Node)) open = false;
	}

	function onDocKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}

	onMount(() => {
		// Prime the badge, then subscribe to the live `notification` topic on the
		// single multiplexed /api/live stream (docs/LIVE-UPDATES-DESIGN.md §5 —
		// transport swap only, behaviour identical). liveClient owns the one
		// EventSource plus all the visibility/staleness reconnect hardening this
		// panel needs (it's mounted once in the persistent sidebar for the whole
		// session, so its subscription must survive mobile app-switching). SSR-safe:
		// subscribe() no-ops off the browser, but onMount only runs client-side.
		void load();

		const unsubscribeStream = subscribe('notification', (ev) => {
			try {
				const data = JSON.parse(ev.data as string) as { unread?: unknown };
				if (typeof data.unread === 'number') notifUnread.count = data.unread;
			} catch {
				// Ignore a malformed frame.
			}
			// If the panel is open, refresh the list too so new rows appear.
			if (open) void load();
		});

		document.addEventListener('click', onDocClick);
		document.addEventListener('keydown', onDocKeydown);
		return () => {
			unsubscribeStream();
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onDocKeydown);
		};
	});
</script>

<div class="notif" bind:this={panelEl}>
	{#if variant === 'bell'}
		<button
			type="button"
			class="bell"
			bind:this={bellEl}
			class:has-unread={notifUnread.count > 0}
			aria-label={notifUnread.count > 0
				? `Notifications (${notifUnread.count} unread)`
				: 'Notifications'}
			aria-haspopup="true"
			aria-expanded={open}
			onclick={toggle}
		>
			<Icon name="activity" size={17} />
			{#if notifUnread.count > 0}
				<span class="notif-badge" aria-hidden="true"
					>{notifUnread.count > 99 ? '99+' : notifUnread.count}</span
				>
			{/if}
		</button>
	{/if}

	{#if open}
		<div class="notif-panel" role="dialog" aria-label="Notifications" bind:this={popEl} popover="manual">
			<div class="panel-head">
				<span class="panel-title">Notifications</span>
				{#if notifUnread.count > 0}
					<button type="button" class="mark-read" onclick={markAllRead}>Mark all read</button>
				{/if}
			</div>

			<div class="panel-body">
				{#if loading && items.length === 0}
					<div class="panel-empty">
						<span class="spinner"></span>
						<span>Loading…</span>
					</div>
				{:else if items.length === 0}
					<div class="panel-empty">
						<Icon name="activity" size={20} />
						<span>Nothing here yet</span>
					</div>
				{:else}
					<ul class="notif-list">
						{#each items as n (n.id)}
							{@const href = linkFor(n)}
							<li class="notif-row level-{n.level}" class:unread={n.readAt === null}>
								{#if href}
									<a {href} class="row-inner" onclick={() => (open = false)}>
										<span class="marker" aria-hidden="true">
											<Icon name={iconFor(n)} size={14} />
										</span>
										<div class="row-body">
											<div class="row-msg">{n.message}</div>
											<div class="row-when">{ago(n.createdAt)}</div>
										</div>
										{#if n.readAt === null}
											<span class="notif-dot" aria-label="Unread"></span>
										{/if}
									</a>
								{:else}
									<div class="row-inner">
										<span class="marker" aria-hidden="true">
											<Icon name={iconFor(n)} size={14} />
										</span>
										<div class="row-body">
											<div class="row-msg">{n.message}</div>
											<div class="row-when">{ago(n.createdAt)}</div>
										</div>
										{#if n.readAt === null}
											<span class="notif-dot" aria-label="Unread"></span>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<a href="/activity" class="panel-foot" onclick={() => (open = false)}>View all activity</a>
		</div>
	{/if}
</div>

<style>
	.notif {
		position: relative;
	}

	.bell {
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		width: 30px;
		height: 30px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		border-radius: var(--radius-control);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.bell:hover,
	.bell[aria-expanded='true'] {
		color: var(--text);
		background: var(--surface);
	}

	.bell.has-unread {
		color: var(--accent);
	}

	.notif-badge {
		position: absolute;
		top: -2px;
		right: -2px;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: 8px;
		background: var(--accent);
		color: var(--bg);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 15px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.notif-panel {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		width: 320px;
		max-width: calc(100vw - 32px);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
		z-index: 40;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		/* Reset the UA popover defaults (margin:auto, padding, inherited colors)
		   so the panel looks identical whether it renders as a top-layer popover
		   or the absolute-positioned fallback. */
		margin: 0;
		padding: 0;
		color: inherit;
	}

	/* Top-layer (cairn-k391): once showPopover() promotes the panel, its
	   left/bottom are set inline by positionPanel() in VIEWPORT coordinates
	   (getBoundingClientRect + innerHeight), so it must be position:fixed. We also
	   null out the UA inset:0 (top/right) that would otherwise stretch it. */
	.notif-panel:popover-open {
		position: fixed;
		top: auto;
		right: auto;
	}

	/* Mobile entry point (cairn-vjjc4): the sidebar's bell lives at the bottom
	   of the screen and opens upward (the default above), but below 900px the
	   bell moves into the top bar (MobileTopBar), so the panel needs to open
	   downward instead or it renders off the top of the viewport. Covers both
	   the CSS fallback (this rule) and the popover/positionPanel() path above,
	   which switches on the same breakpoint. Also widen the bell's tap target
	   to ~44px on touch, matching MobileTopBar's avatar/search-icon pattern. */
	@media (max-width: 900px) {
		.notif-panel {
			bottom: auto;
			top: calc(100% + 8px);
		}

		.bell::after {
			content: '';
			position: absolute;
			inset: -7px;
		}
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.panel-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.mark-read {
		border: none;
		background: none;
		color: var(--accent);
		font-size: 11.5px;
		font-weight: 500;
		cursor: pointer;
		padding: 0;
	}

	.mark-read:hover {
		text-decoration: underline;
	}

	.panel-body {
		max-height: 360px;
		overflow-y: auto;
	}

	.panel-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 28px 16px;
		color: var(--text-muted);
		font-size: 12.5px;
	}

	.notif-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.notif-row {
		border-bottom: 1px solid var(--border-subtle);
	}

	.notif-row:last-child {
		border-bottom: none;
	}

	.notif-row.unread {
		background: var(--accent-muted);
	}

	.row-inner {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		color: inherit;
	}

	a.row-inner:hover {
		background: var(--surface);
	}

	.marker {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--surface);
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.level-success .marker {
		background: var(--success-muted);
		color: var(--success);
	}
	.level-warn .marker {
		background: var(--warning-muted);
		color: var(--warning);
	}
	.level-error .marker {
		background: var(--error-muted);
		color: var(--error);
	}

	.row-body {
		flex: 1;
		min-width: 0;
	}

	.row-msg {
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--text);
		/* Messages are title + " — " + body (can run 150+ chars). Clamp to two
		   lines so a long body can't wrap into a ragged block inside the fixed
		   320px panel. .row-body's min-width:0 is the flex prerequisite for this.
		   The -webkit-box combo is the portable line-clamp idiom (Chrome/Edge/
		   Safari/Firefox); the standard `line-clamp` is defined alongside it for
		   forward-compat. */
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	.row-when {
		font-size: 11px;
		color: var(--text-muted);
		margin-top: 2px;
		font-variant-numeric: tabular-nums;
	}

	.notif-dot {
		width: 7px;
		height: 7px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent);
		margin-top: 6px;
	}

	.panel-foot {
		display: block;
		text-align: center;
		padding: 9px 14px;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		border-top: 1px solid var(--border-subtle);
	}

	.panel-foot:hover {
		background: var(--surface);
	}
</style>
