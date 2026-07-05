<script lang="ts">
	// In-app notification bell + dropdown panel (Unit 2, §2.1 of
	// docs/NOTIFICATION-PLAN.md). Lives in the (app) sidebar next to the user
	// chip. Shows an unread badge, and on click drops a panel listing recent
	// notifications with the same level-based icon/colour treatment the
	// /activity page uses. A live SSE stream (/api/notifications/stream) keeps
	// the badge fresh without polling; the panel list is fetched on open.
	//
	// Read model is instance-wide (a single events.read_at column) — see the API
	// route. "Mark all read" clears every visible unread row for this user.

	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';
	import { onMount } from 'svelte';

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

	let unread = $state(0);
	let items = $state<Notification[]>([]);
	let open = $state(false);
	let loading = $state(false);
	let panelEl = $state<HTMLDivElement | null>(null);

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
		admin_new_signup: 'users',
		admin_invite_used: 'ticket',
		admin_server_health: 'server',
		security_failed_login: 'shield',
		security_new_passkey: 'shield'
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

	// A notification's deep link: an explicit detail.link wins (that's what
	// notify(payload.link) stores), otherwise fall back to a txid → explorer link
	// like the activity page does. Only same-origin relative paths are honoured.
	function linkFor(n: Notification): string | null {
		const raw = n.detail?.link;
		if (typeof raw === 'string' && raw.startsWith('/')) return raw;
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
				unread = body.unread;
			}
		} catch {
			// Transient — keep whatever we last had.
		} finally {
			loading = false;
		}
	}

	async function toggle() {
		open = !open;
		if (open) await load();
	}

	async function markAllRead() {
		// Optimistic: clear locally, then persist. A failure re-syncs on next open.
		unread = 0;
		items = items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }));
		try {
			const res = await fetch('/api/notifications', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ all: true })
			});
			if (res.ok) {
				const body = (await res.json()) as { unread: number };
				unread = body.unread;
			}
		} catch {
			// Best-effort — the badge re-derives on the next load.
		}
	}

	function onDocClick(e: MouseEvent) {
		if (!open) return;
		if (panelEl && !panelEl.contains(e.target as Node)) open = false;
	}

	onMount(() => {
		// Prime the badge, then subscribe to the live push. EventSource handles
		// reconnects; SSR-safe because onMount only runs in the browser.
		void load();

		let source: EventSource | null = null;
		if (typeof EventSource !== 'undefined') {
			source = new EventSource('/api/notifications/stream');
			source.addEventListener('notification', (ev: MessageEvent) => {
				try {
					const data = JSON.parse(ev.data as string) as { unread?: unknown };
					if (typeof data.unread === 'number') unread = data.unread;
				} catch {
					// Ignore a malformed frame.
				}
				// If the panel is open, refresh the list too so new rows appear.
				if (open) void load();
			});
		}

		document.addEventListener('click', onDocClick);
		return () => {
			source?.close();
			document.removeEventListener('click', onDocClick);
		};
	});
</script>

<div class="notif" bind:this={panelEl}>
	<button
		type="button"
		class="bell"
		class:has-unread={unread > 0}
		aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
		aria-haspopup="true"
		aria-expanded={open}
		onclick={toggle}
	>
		<Icon name="activity" size={17} />
		{#if unread > 0}
			<span class="badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
		{/if}
	</button>

	{#if open}
		<div class="panel" role="dialog" aria-label="Notifications">
			<div class="panel-head">
				<span class="panel-title">Notifications</span>
				{#if unread > 0}
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
					<ul class="list">
						{#each items as n (n.id)}
							{@const href = linkFor(n)}
							<li class="row level-{n.level}" class:unread={n.readAt === null}>
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
											<span class="dot" aria-label="Unread"></span>
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
											<span class="dot" aria-label="Unread"></span>
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

	.badge {
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

	.panel {
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

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		border-bottom: 1px solid var(--border-subtle);
	}

	.row:last-child {
		border-bottom: none;
	}

	.row.unread {
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
	}

	.row-when {
		font-size: 11px;
		color: var(--text-muted);
		margin-top: 2px;
		font-variant-numeric: tabular-nums;
	}

	.dot {
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
