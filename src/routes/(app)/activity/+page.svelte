<script lang="ts">
	import { onMount } from 'svelte';
	import { onWalletEvent, debounced } from '$lib/live/walletEvents';
	import { subscribe as liveSubscribe } from '$lib/live/liveClient';
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BurialRings, { burialRingsLabel } from '$lib/components/heartwood/BurialRings.svelte';
	import RingStub from '$lib/components/heartwood/RingStub.svelte';
	import { timeAgo, formatNumber, truncateMiddle } from '$lib/format';

	// Mirrors the server's ActivityEvent (kept local so this client component
	// never imports a $lib/server module).
	type ActivityEvent = {
		id: number;
		type: string;
		level: 'info' | 'success' | 'warn' | 'error';
		message: string;
		detail: Record<string, unknown> | null;
		createdAt: string;
		scope: 'you' | 'instance';
	};

	let { data } = $props();

	// With the explorer feature flag off, /explorer/** 403s server-side — so
	// block links below degrade to a non-interactive summary instead of a dead
	// link. Tx links are the one exception (cairn-5yz3.3): /explorer/tx/[txid]
	// is exempt from the flag (it's tx detail, not chain browsing, and the
	// only tx-detail surface in the app), so those always stay live links.
	const explorerEnabled = $derived(data.flags?.explorer !== false);

	// Server load provides the first paint; a manual/auto refresh replaces it.
	// `fetched` stays null until the first client refresh, so navigating back to
	// this page still shows fresh server data.
	let fetched = $state<ActivityEvent[] | null>(null);
	const events = $derived(fetched ?? data.events);
	let refreshing = $state(false);
	let onlyAlerts = $state(false);

	// ------------------------------------------------------------ 5f filters
	// The spec's three toggles. "Wallets" = your bitcoin moving and the wallets/
	// keys/signing around it; "Node" = instance-wide chain/server events (rare in
	// this personal feed — the operational firehose lives in Admin → Activity).
	// Account-security events show under All.
	type Filter = 'all' | 'wallets' | 'node';
	let filter = $state<Filter>('all');

	const WALLET_TYPES = new Set([
		'tx_received',
		'tx_confirmed',
		'tx_replaced',
		'tx_large',
		'broadcast',
		'wallet_added',
		'wallet_created',
		'key_reuse',
		'backup_downloaded',
		'backup_missing',
		'backup_stale',
		'signing_started',
		'sign_session_waiting',
		'key_health_due',
		'contact_request',
		'contact_accepted'
	]);
	const NODE_TYPES = new Set([
		'new_block',
		'network_up',
		'network_down',
		'electrum_switched',
		'scan_complete'
	]);

	function inFilter(e: ActivityEvent): boolean {
		if (filter === 'wallets') return WALLET_TYPES.has(e.type);
		if (filter === 'node') return NODE_TYPES.has(e.type) || e.scope === 'instance';
		return true;
	}

	const shown = $derived(
		events.filter(
			(e) => inFilter(e) && (!onlyAlerts || e.level === 'warn' || e.level === 'error')
		)
	);

	// ------------------------------------------------------- hero + day groups
	const heroSub = $derived.by(() => {
		if (shown.length === 0) return '';
		const oldest = new Date(shown[shown.length - 1].createdAt).getTime();
		const days = Math.max(1, Math.ceil((Date.now() - oldest) / 86_400_000));
		const span =
			days === 1 ? 'today' : days === 2 ? 'in the last two days' : `in the last ${days} days`;
		const noisy = shown.some((e) => e.level === 'warn' || e.level === 'error');
		return `event${shown.length === 1 ? '' : 's'} ${span}${noisy ? '' : ' · all quiet'}`;
	});

	function dayLabel(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const today = new Date();
		const at = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
		const diff = Math.round((t0 - at) / 86_400_000);
		if (diff <= 0) return 'Today';
		if (diff === 1) return 'Yesterday';
		return d
			.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
			.toUpperCase();
	}

	const grouped = $derived.by(() => {
		const groups: { label: string; items: ActivityEvent[] }[] = [];
		for (const e of shown) {
			const label = dayLabel(e.createdAt);
			const last = groups[groups.length - 1];
			if (last && last.label === label) last.items.push(e);
			else groups.push({ label, items: [e] });
		}
		return groups;
	});

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const res = await fetch('/api/activity?limit=200');
			if (res.ok) {
				const body = (await res.json()) as { events: ActivityEvent[] };
				fetched = body.events;
			}
		} catch {
			// Transient fetch failure — keep the last good list, try again next tick.
		} finally {
			refreshing = false;
		}
	}

	// Live feed (Wave 2, LIVE-UPDATES-DESIGN.md §4.3/§5): the feed is not a
	// first-class stream — it re-derives its view from the `wallet` and
	// `notification` frames it already receives (§2 note: no `activity` topic). The
	// 10s poll is removed; instead a wallet payment or any notification nudges a
	// debounced re-fetch of the same /api/activity list the poll refreshed.
	// Debounced ~800ms so a block firing several frames at once = one re-fetch.
	onMount(() => {
		const kick = debounced(() => void refresh());
		const offWallet = onWalletEvent(() => kick());
		const offNotify = liveSubscribe('notification', () => kick());
		// Return-to-tab safety net: SSE frames that arrived while the tab was
		// backgrounded aren't replayed (§1.2 — no replay buffer), so a foreground
		// re-fetch reconciles anything missed. Cheap: one /api/activity read.
		const onVisible = () => {
			if (!document.hidden) kick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			kick.cancel();
			offWallet();
			offNotify();
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	// ---------------------------------------------------------- row rendering
	// Which glyph a row leads with (5f): burial rings for money moving, a ring
	// stub for new blocks, a clock for PSBTs waiting on signatures, and quiet
	// stroke icons for everything else.
	const SECURITY_TYPES = new Set([
		'security_new_passkey',
		'security_password_changed',
		'security_new_device',
		'security_failed_login',
		'account_recovery',
		'account_recovery_codes_set',
		'account_recovery_phrase_set',
		'admin_break_glass'
	]);

	type Marker =
		| { kind: 'rings'; confirmations: number; direction: 'in' | 'out' }
		| { kind: 'block' }
		| { kind: 'clock' }
		| { kind: 'icon'; name: string };

	function markerFor(e: ActivityEvent): Marker {
		switch (e.type) {
			case 'tx_received':
			case 'tx_large':
				return { kind: 'rings', confirmations: 0, direction: 'in' };
			case 'tx_confirmed':
				return { kind: 'rings', confirmations: confirmations(e) ?? 6, direction: 'in' };
			case 'tx_replaced':
				// Cancelled inbound (cairn-a2p1): a plain glyph, never the burial rings —
				// no payment landed. The row's warn level already tints it amber.
				return { kind: 'icon', name: 'x' };
			case 'broadcast':
				return { kind: 'rings', confirmations: 0, direction: 'out' };
			case 'new_block':
				return { kind: 'block' };
			case 'signing_started':
			case 'sign_session_waiting':
				return { kind: 'clock' };
			case 'wallet_added':
			case 'wallet_created':
				return { kind: 'icon', name: 'wallet' };
			case 'backup_downloaded':
			case 'backup_missing':
			case 'backup_stale':
				return { kind: 'icon', name: 'shield' };
			case 'network_up':
			case 'network_down':
			case 'electrum_switched':
				return { kind: 'icon', name: 'server' };
			case 'scan_complete':
				return { kind: 'icon', name: 'refresh' };
			default:
				return SECURITY_TYPES.has(e.type)
					? { kind: 'icon', name: 'key' }
					: { kind: 'icon', name: 'info' };
		}
	}

	function ago(iso: string): string {
		const secs = Math.floor(new Date(iso).getTime() / 1000);
		return Number.isFinite(secs) ? timeAgo(secs) : '';
	}
	function fullTime(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	function num(v: unknown): number | null {
		return typeof v === 'number' && Number.isFinite(v) ? v : null;
	}
	function txid(e: ActivityEvent): string | null {
		const v = e.detail?.txid;
		return typeof v === 'string' ? v : null;
	}
	function height(e: ActivityEvent): number | null {
		return num(e.detail?.height);
	}
	// Mirrors NotificationPanel.svelte's linkFor(): an explicit detail.link wins
	// — notify() merges payload.link into the persisted detail JSON under "link"
	// (cairn-ay45q) — with a txid → explorer link fallback for older rows. Only
	// same-origin relative paths are honoured, and non-tx explorer links are
	// suppressed when the explorer flag is off (cairn-5yz3.3: tx detail is
	// exempt from the flag).
	function linkFor(e: ActivityEvent): string | null {
		const raw = e.detail?.link;
		if (typeof raw === 'string' && raw.startsWith('/')) {
			const isTxLink = /^\/explorer\/tx\//.test(raw);
			if (!explorerEnabled && raw.startsWith('/explorer/') && !isTxLink) return null;
			return raw;
		}
		const t = txid(e);
		if (t) return `/explorer/tx/${t}`;
		return null;
	}
	function amountSats(e: ActivityEvent): number | null {
		return num(e.detail?.amountSats);
	}
	function confirmations(e: ActivityEvent): number | null {
		return num(e.detail?.confirmations);
	}
	/** "2/3" quorum badge for a PSBT waiting on signatures. */
	function quorum(e: ActivityEvent): string | null {
		const collected = num(e.detail?.collected);
		const required = num(e.detail?.required);
		return collected !== null && required !== null ? `${collected}/${required}` : null;
	}

	/** The quiet meta line under the row title, in the brand language. */
	function metaFor(e: ActivityEvent): string {
		const parts: string[] = [];
		if (e.type === 'tx_received' || e.type === 'tx_large' || e.type === 'broadcast') {
			parts.push(burialRingsLabel(0));
		} else if (e.type === 'tx_confirmed') {
			parts.push(burialRingsLabel(confirmations(e) ?? 6));
		}
		parts.push(ago(e.createdAt));
		return parts.join(' · ');
	}
</script>

<svelte:head>
	<title>Activity — Heartwood</title>
</svelte:head>

<div class="activity">
	<GroveField volume="whisper" />
	<div class="activity-body">
		<!-- Desktop (>=1160px): the feed fills the data measure with a quiet filter
		     rail on the right (docs/DESKTOP-LAYOUT-DESIGN.md §4 Activity). The inline
		     toggles/controls are hidden at >=1160 and mirrored in the rail; below
		     1160 the rail is display:none and the inline filters render exactly as
		     before — mobile/laptop untouched. -->
		<div class="activity-layout">
		<div class="activity-main">
		<!-- eyebrow + filter toggles (5f header row) -->
		<div class="head fade-in">
			<span class="eyebrow">Activity</span>
			<div class="toggles" role="group" aria-label="Filter activity">
				{#each [{ v: 'all', l: 'All' }, { v: 'wallets', l: 'Wallets' }, { v: 'node', l: 'Node' }] as opt (opt.v)}
					<button
						type="button"
						class="toggle"
						class:active={filter === opt.v}
						aria-pressed={filter === opt.v}
						onclick={() => (filter = opt.v as Filter)}
					>
						{opt.l}
					</button>
				{/each}
			</div>
		</div>

		<!-- hero event count -->
		<div class="hero fade-in">
			<span class="hero-number hero-count">{formatNumber(shown.length)}</span>
			{#if heroSub}<span class="hero-sub">{heroSub}</span>{/if}
		</div>

		<!-- quiet controls: alerts filter, refresh -->
		<div class="controls fade-in">
			<button
				type="button"
				class="ctrl"
				class:on={onlyAlerts}
				onclick={() => (onlyAlerts = !onlyAlerts)}
				title="Show only warnings and errors"
				aria-pressed={onlyAlerts}
			>
				Needs a look
			</button>
			<button type="button" class="ctrl" onclick={refresh} disabled={refreshing}>
				{#if refreshing}<span class="spinner"></span>{:else}<Icon name="refresh" size={13} />{/if}
				Refresh
			</button>
		</div>

		{#if shown.length === 0}
			<div class="empty fade-in">
				<span class="empty-title">
					{#if filter === 'node'}
						Nothing from the node in your feed
					{:else if onlyAlerts}
						Nothing needs a look
					{:else}
						Nothing here yet
					{/if}
				</span>
				<span class="empty-copy">
					{#if filter === 'node'}
						Chain and server events live in the admin activity log. Your feed stays about your
						bitcoin.
					{:else}
						Your activity appears here as you receive payments, download backups, and sign
						transactions.
					{/if}
				</span>
			</div>
		{:else}
			{#each grouped as group (group.label)}
				<div class="day fade-in">{group.label}</div>
				<ul class="feed">
					{#each group.items as e (e.id)}
						{@const marker = markerFor(e)}
						{@const sats = amountSats(e)}
						{@const q = quorum(e)}
						{@const href = linkFor(e)}
						<li class="event" class:attention={e.level === 'warn' || e.level === 'error'}>
							<span class="marker" aria-hidden="true">
								{#if marker.kind === 'rings'}
									<BurialRings
										confirmations={marker.confirmations}
										direction={marker.direction}
										size={30}
									/>
								{:else if marker.kind === 'block'}
									<RingStub state="tip" size={17} />
								{:else if marker.kind === 'clock'}
									<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--accent)" stroke-width="1.6">
										<circle cx="10" cy="10" r="7" />
										<path d="M10 6 V10 L13 12" stroke-linecap="round" />
									</svg>
								{:else}
									<Icon name={marker.name} size={16} />
								{/if}
							</span>
							<div class="body">
								{#if href && !txid(e)}
									<a class="message" {href}>{e.message}</a>
								{:else}
									<div class="message">{e.message}</div>
								{/if}
								<div class="meta">
									<span>{metaFor(e)}</span>
									{#if txid(e)}
										<a class="mono link" href={href ?? `/explorer/tx/${txid(e)}`}>
											{truncateMiddle(txid(e)!, 6, 6)}
										</a>
										<CopyText value={txid(e)!} display="copy" mono={false} />
									{:else if height(e)}
										<svelte:element
											this={explorerEnabled ? 'a' : 'span'}
											class="mono link"
											href={explorerEnabled ? `/explorer/block/${height(e)}` : undefined}
										>
											ring segment {formatNumber(height(e)!)}
										</svelte:element>
									{/if}
								</div>
							</div>
							{#if sats !== null}
								<span class="amount">
									<Amount
										sats={marker.kind === 'rings' && marker.direction === 'out' ? -Math.abs(sats) : Math.abs(sats)}
										size="row"
										sign
										direction={marker.kind === 'rings' && marker.direction === 'in' ? 'in' : 'out'}
									/>
								</span>
							{:else if q}
								<span class="quorum-badge">{q}</span>
							{:else if SECURITY_TYPES.has(e.type)}
								<span class="you-badge">You</span>
							{:else}
								<time class="when" title={fullTime(e.createdAt)}>{ago(e.createdAt)}</time>
							{/if}
						</li>
					{/each}
				</ul>
			{/each}
		{/if}
		</div>

		<!-- =============================================== quiet filter rail -->
		<aside class="activity-rail quiet-rail" aria-label="Filter activity">
			<div class="rail-group">
				<span class="rail-eyebrow">Show</span>
				<div class="rail-toggles" role="group" aria-label="Filter activity">
					{#each [{ v: 'all', l: 'All' }, { v: 'wallets', l: 'Wallets' }, { v: 'node', l: 'Node' }] as opt (opt.v)}
						<button
							type="button"
							class="rail-toggle"
							class:active={filter === opt.v}
							aria-pressed={filter === opt.v}
							onclick={() => (filter = opt.v as Filter)}
						>
							{opt.l}
						</button>
					{/each}
				</div>
			</div>
			<div class="rail-group">
				<span class="rail-eyebrow">Controls</span>
				<button
					type="button"
					class="rail-ctrl"
					class:on={onlyAlerts}
					onclick={() => (onlyAlerts = !onlyAlerts)}
					aria-pressed={onlyAlerts}
				>
					Needs a look
				</button>
				<button type="button" class="rail-ctrl" onclick={refresh} disabled={refreshing}>
					{#if refreshing}<span class="spinner"></span>{:else}<Icon name="refresh" size={13} />{/if}
					Refresh
				</button>
			</div>
		</aside>
		</div>
	</div>
</div>

<style>
	/* Whisper-volume grove bleeds to the shell's padding edges; the content fills
	   the data lane the layout caps <main> to (the old 760px cap is removed per
	   docs/DESKTOP-LAYOUT-DESIGN.md §2). */
	.activity {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.activity-body {
		position: relative;
		z-index: 1;
	}

	/* --- desktop filter rail (>=1160px) — hidden by default so mobile/laptop
	   keep the inline filters and the single-column feed unchanged. --- */
	.activity-rail {
		display: none;
	}

	@media (min-width: 1160px) {
		.activity-layout {
			display: grid;
			grid-template-columns: minmax(0, 1fr) var(--rail-w);
			gap: var(--lane-gutter);
			align-items: start;
		}

		.activity-main {
			min-width: 0;
		}

		/* Filters move into the rail on desktop — hide the inline copies. */
		.activity-main .toggles,
		.activity-main .controls {
			display: none;
		}

		.activity-rail {
			display: flex;
			flex-direction: column;
			gap: 26px;
			position: sticky;
			top: 24px;
		}

		.rail-group {
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			gap: 10px;
		}

		.rail-eyebrow {
			font-size: 10.5px;
			font-weight: 600;
			letter-spacing: 0.12em;
			text-transform: uppercase;
			color: var(--eyebrow-path);
		}

		.rail-toggles {
			display: flex;
			flex-direction: column;
			align-self: stretch;
			gap: 2px;
		}

		.rail-toggle {
			background: none;
			border: none;
			padding: 7px 12px;
			border-radius: var(--radius-badge);
			font-family: var(--font-ui);
			font-size: 13px;
			font-weight: 500;
			color: var(--eyebrow-path);
			text-align: left;
			cursor: pointer;
			transition:
				color 120ms var(--ease),
				background 120ms var(--ease);
		}

		.rail-toggle:hover {
			color: var(--text-secondary);
		}

		.rail-toggle.active {
			font-weight: 600;
			color: var(--accent-bright);
			background: rgba(103, 150, 201, 0.1);
		}

		.rail-ctrl {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			background: none;
			border: none;
			padding: 0;
			font-family: var(--font-ui);
			font-size: 12.5px;
			color: var(--text-faint);
			cursor: pointer;
			white-space: nowrap;
			transition: color 120ms var(--ease);
		}

		.rail-ctrl:hover:not(:disabled) {
			color: var(--text-secondary);
		}

		.rail-ctrl:disabled {
			cursor: default;
		}

		.rail-ctrl.on {
			color: var(--attention);
		}

		.rail-ctrl .spinner {
			width: 12px;
			height: 12px;
			border-width: 1.5px;
		}

		/* Rows gain a wider gutter and an aligned trailing column at data measure
		   so amounts/times line up down the feed. */
		.event {
			gap: 20px;
		}

		.amount,
		.when {
			min-width: 150px;
			text-align: right;
		}
	}

	/* --- header: eyebrow + toggle grammar --- */
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.toggles {
		display: flex;
		gap: 2px;
	}

	.toggle {
		background: none;
		border: none;
		padding: 4px 12px;
		border-radius: 14px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		color: var(--eyebrow-path);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.toggle:hover {
		color: var(--text-secondary);
	}

	.toggle.active {
		font-weight: 600;
		color: var(--accent-bright);
		background: rgba(103, 150, 201, 0.1);
	}

	/* --- hero --- */
	.hero {
		display: flex;
		align-items: baseline;
		gap: 14px;
		margin-top: 18px;
	}

	.hero-count {
		font-size: 56px;
		line-height: 0.95;
		color: var(--text-hero);
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	/* --- quiet controls --- */
	.controls {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 16px;
		margin-top: 26px;
	}

	.ctrl {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 0;
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--text-faint);
		cursor: pointer;
		white-space: nowrap;
		transition: color 120ms var(--ease);
	}

	.ctrl:hover:not(:disabled) {
		color: var(--text-secondary);
	}

	.ctrl:disabled {
		cursor: default;
	}

	.ctrl.on {
		color: var(--attention);
	}

	.ctrl .spinner {
		width: 12px;
		height: 12px;
		border-width: 1.5px;
	}

	/* --- day groups + hairline rows --- */
	.day {
		margin-top: 34px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.day:first-of-type {
		margin-top: 30px;
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.event {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.feed:last-of-type .event:last-child {
		border-bottom: none;
	}

	.marker {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		flex-shrink: 0;
		color: var(--text-secondary);
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.message {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
		line-height: 1.45;
	}

	a.message {
		text-decoration: none;
	}

	a.message:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.event.attention .message {
		color: var(--attention);
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 1px;
		font-size: 12px;
		color: var(--text-faint);
	}

	.link {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.link:hover {
		color: var(--accent);
	}

	/* --- right-hand column: amount / quorum / YOU / time --- */
	.amount {
		flex-shrink: 0;
		font-family: var(--font-serif);
		font-size: 16px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text-value);
	}

	.quorum-badge {
		flex-shrink: 0;
		font-size: 10.5px;
		font-weight: 600;
		color: var(--accent-bright);
		background: rgba(103, 150, 201, 0.12);
		padding: 4px 9px;
		border-radius: var(--radius-badge);
	}

	.you-badge {
		flex-shrink: 0;
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-secondary);
		background: rgba(255, 255, 255, 0.04);
		padding: 3px 7px;
		border-radius: 4px;
	}

	.when {
		flex-shrink: 0;
		font-size: 12px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* --- empty state --- */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 64px 24px;
		text-align: center;
	}

	.empty-title {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.empty-copy {
		font-size: 13px;
		color: var(--text-muted);
		max-width: 44ch;
		line-height: 1.55;
	}

	/* ============================================== mobile (8g, ≤900px) */
	@media (max-width: 900px) {
		.activity {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.head {
			justify-content: center;
		}

		/* The shell's tab row carries navigation; the page keeps its own filter
		   toggles centered under it, and the eyebrow steps back. */
		.eyebrow {
			display: none;
		}

		.toggle {
			font-size: 12.5px;
			padding: 6px 13px;
			border-radius: 15px;
		}

		.hero {
			flex-direction: column;
			align-items: center;
			gap: 8px;
			margin-top: 22px;
			text-align: center;
		}

		.hero-count {
			font-size: 44px;
			line-height: 1;
		}

		.hero-sub {
			font-size: 12px;
		}

		.controls {
			justify-content: center;
			margin-top: 20px;
		}

		.day {
			margin-top: 28px;
			font-size: 10px;
		}

		.message {
			font-size: 13px;
		}

		.meta {
			font-size: 10.5px;
		}

		.amount {
			font-size: 14px;
		}
	}
</style>
