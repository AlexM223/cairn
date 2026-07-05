<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';

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

	// Server load provides the first paint; a manual/auto refresh replaces it.
	// `fetched` stays null until the first client refresh, so navigating back to
	// this page still shows fresh server data.
	let fetched = $state<ActivityEvent[] | null>(null);
	const events = $derived(fetched ?? data.events);
	let auto = $state(false);
	let refreshing = $state(false);
	let onlyAlerts = $state(false);

	const shown = $derived(
		onlyAlerts ? events.filter((e) => e.level === 'warn' || e.level === 'error') : events
	);

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

	$effect(() => {
		if (!auto) return;
		const t = setInterval(refresh, 10_000);
		return () => clearInterval(t);
	});

	const ICON: Record<string, string> = {
		network_up: 'server',
		network_down: 'server',
		new_block: 'blocks',
		broadcast: 'arrow-up-right',
		signing_started: 'shield',
		electrum_switched: 'refresh',
		scan_complete: 'refresh',
		wallet_added: 'wallet',
		wallet_created: 'shield'
	};
	const iconFor = (type: string) => ICON[type] ?? 'info';

	function ago(iso: string): string {
		const secs = Math.floor(new Date(iso).getTime() / 1000);
		return Number.isFinite(secs) ? timeAgo(secs) : '';
	}
	function fullTime(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}

	function txid(e: ActivityEvent): string | null {
		const v = e.detail?.txid;
		return typeof v === 'string' ? v : null;
	}
	function height(e: ActivityEvent): number | null {
		const v = e.detail?.height;
		return typeof v === 'number' ? v : null;
	}
</script>

<svelte:head>
	<title>Activity — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<div class="grow">
		<h1 class="page-title">Activity</h1>
		<p class="text-muted sub">
			What your instance has been doing — network, blocks, and your own wallet activity. Newest
			first.
		</p>
	</div>
	<div class="controls">
		<button
			class="btn btn-ghost btn-sm"
			class:active={onlyAlerts}
			onclick={() => (onlyAlerts = !onlyAlerts)}
			title="Show only warnings and errors"
		>
			<Icon name="alert-triangle" size={14} />
			Alerts
		</button>
		<label class="auto" title="Refresh every 10 seconds">
			<input type="checkbox" bind:checked={auto} />
			Auto-refresh
		</label>
		<button class="btn btn-secondary btn-sm" onclick={refresh} disabled={refreshing}>
			{#if refreshing}
				<span class="spinner"></span>
			{:else}
				<Icon name="refresh" size={14} />
			{/if}
			Refresh
		</button>
	</div>
</div>

<div class="card fade-in">
	{#if shown.length === 0}
		<div class="empty-state">
			<Icon name="activity" size={22} />
			<span class="empty-title">Nothing here yet</span>
			<span>Events appear as your instance connects, sees new blocks, and you use your wallets.</span>
		</div>
	{:else}
		<ul class="feed">
			{#each shown as e (e.id)}
				<li class="event level-{e.level}">
					<span class="marker" aria-hidden="true">
						<Icon name={iconFor(e.type)} size={15} />
					</span>
					<div class="body">
						<div class="message">{e.message}</div>
						<div class="meta">
							<span class="scope" class:instance={e.scope === 'instance'}>
								{e.scope === 'instance' ? 'Instance' : 'You'}
							</span>
							{#if txid(e)}
								<a class="mono link" href="/explorer/tx/{txid(e)}">{txid(e)!.slice(0, 16)}…</a>
							{:else if height(e)}
								<a class="mono link" href="/explorer/block/{height(e)}">block {height(e)}</a>
							{/if}
						</div>
					</div>
					<time class="when" title={fullTime(e.createdAt)}>{ago(e.createdAt)}</time>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.head {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: 16px;
	}

	.sub {
		margin-top: 4px;
		font-size: 13px;
		max-width: 60ch;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn-ghost.active {
		color: var(--warning);
		background: var(--warning-muted);
	}

	.auto {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		cursor: pointer;
		white-space: nowrap;
	}

	.auto input {
		accent-color: var(--accent);
		cursor: pointer;
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.event {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 18px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.event:last-child {
		border-bottom: none;
	}

	.marker {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--surface-elevated);
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

	.body {
		flex: 1;
		min-width: 0;
	}

	.message {
		font-size: 13.5px;
		color: var(--text);
		line-height: 1.45;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 3px;
	}

	.scope {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
		background: var(--surface-elevated);
		border-radius: var(--radius-chip);
		padding: 1px 6px;
	}

	.scope.instance {
		color: var(--accent);
		background: var(--accent-muted);
	}

	.link {
		font-size: 12px;
	}

	.when {
		flex-shrink: 0;
		font-size: 12px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		margin-top: 2px;
	}

	@media (max-width: 640px) {
		.head {
			flex-direction: column;
		}
		.controls {
			flex-wrap: wrap;
		}
	}
</style>
