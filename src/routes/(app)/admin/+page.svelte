<script lang="ts">
	import EpochDial from '$lib/components/heartwood/EpochDial.svelte';
	import { formatNumber, formatBytes } from '$lib/format';

	let { data } = $props();

	const notice = $derived(data.updateNotice ?? null);

	// Node info is STREAMED (cairn-2zxt.3): the page chrome + every setting-derived
	// row paint instantly; the health pill, tip height, and backend rows fill in
	// when the Electrum round-trip resolves. loadNodeInfo never rejects.
	type NodeData = Awaited<(typeof data)['node']>;
	let node = $state<NodeData | null>(null);
	$effect(() => {
		const promise = data.node;
		let stale = false;
		void promise.then((n) => {
			if (!stale) node = n;
		});
		return () => {
			stale = true;
		};
	});
	const nodeLoading = $derived(node === null);
	const connected = $derived(node !== null && node.connected && node.tipHeight !== null);

	// Forming-ring math (spec 5g): N = floor(h/2016); ring N+1 is forming;
	// progress = laid/2016; close ETA = blocks left × 10 min.
	const tip = $derived(node?.tipHeight ?? null);
	const ringNumber = $derived(tip !== null ? Math.floor(tip / 2016) + 1 : null);
	const ringLaid = $derived(tip !== null ? tip % 2016 : 0);
	const ringProgress = $derived(ringLaid / 2016);
	const ringCloses = $derived.by(() => {
		if (tip === null) return null;
		const eta = new Date(Date.now() + (2016 - ringLaid) * 10 * 60_000);
		return eta.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	});

	// Uptime in the roundest sensible unit.
	const uptime = $derived.by(() => {
		const s = data.uptimeSeconds;
		if (s >= 172_800) return `${Math.floor(s / 86_400)} days`;
		if (s >= 7_200) return `${Math.floor(s / 3_600)} hours`;
		if (s >= 120) return `${Math.floor(s / 60)} minutes`;
		return 'just started';
	});

	// Storage bar: how full the volume the database lives on is.
	const disk = $derived.by(() => {
		const { diskTotalBytes, diskFreeBytes } = data.storage;
		if (diskTotalBytes === null || diskFreeBytes === null || diskTotalBytes <= 0) return null;
		const used = diskTotalBytes - diskFreeBytes;
		return { used, total: diskTotalBytes, pct: Math.min(100, (used / diskTotalBytes) * 100) };
	});

	// Config-backup recency — the amber "Back up" nudge past 30 days (matches
	// the backup page's staleness threshold).
	const STALE_DAYS = 30;
	const backupAge = $derived.by(() => {
		if (!data.lastInstanceBackupAt) return null;
		const t = Date.parse(data.lastInstanceBackupAt);
		return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
	});
	const backupStale = $derived(backupAge === null || backupAge > STALE_DAYS);
	const backupLabel = $derived(
		backupAge === null
			? 'never backed up'
			: backupAge === 0
				? 'today'
				: backupAge === 1
					? '1 day old'
					: `${backupAge} days old`
	);

	const isTeam = $derived(data.instanceMode === 'team');
</script>

<svelte:head>
	<title>Node — Heartwood</title>
</svelte:head>

<!-- status pill row (the layout renders the NODE eyebrow above the tabs) -->
<div class="status-row fade-in">
	{#if nodeLoading}
		<span class="status checking"><span class="dot blink"></span>Checking connection…</span>
	{:else if connected}
		<span class="status healthy"><span class="dot blink"></span>Healthy</span>
	{:else}
		<span class="status behind"><span class="dot"></span>Can't reach chain data</span>
	{/if}
</div>

<!-- hero: tip height + large epoch dial -->
<div class="hero fade-in">
	<div class="hero-main">
		{#if nodeLoading}
			<div class="hero-row">
				<span class="hero-number hero-height skeleton" aria-hidden="true">000,000</span>
				<span class="hero-sub">at the tip</span>
			</div>
			<div class="hero-ring skeleton skeleton-line" aria-hidden="true">ring 000 forming — 0,000 of 2,016 laid</div>
		{:else if tip !== null}
			<div class="hero-row">
				<span class="hero-number hero-height">{formatNumber(tip)}</span>
				<span class="hero-sub">at the tip</span>
			</div>
			<div class="hero-ring">
				ring {formatNumber(ringNumber!)} forming — {formatNumber(ringLaid)} of 2,016 laid
				{#if ringCloses}· closes ≈ {ringCloses}{/if}
			</div>
		{:else}
			<div class="hero-row">
				<span class="hero-number hero-height dim">—</span>
			</div>
			<div class="hero-ring attention-text">
				{node?.error ?? 'No connection to the configured chain sources.'}
				<a href="/admin/settings">Check the connection →</a>
			</div>
		{/if}
	</div>
	<div class="hero-dial" aria-hidden={tip === null}>
		<EpochDial
			state={connected ? 'at-tip' : 'behind'}
			progress={ringProgress}
			size={84}
			pulseKey={tip}
		/>
	</div>
</div>

<!-- k/v rows, two columns (5g) -->
<div class="kv-grid fade-in">
	<div class="kv">
		<span class="k">Backend</span>
		{#if node}
			<span class="v">Electrum · {node.mode === 'public' ? 'public servers' : 'yours'}</span>
			<span class="dot-badge" class:sage={connected} class:amber={!connected}></span>
		{:else}
			<span class="v skeleton" aria-hidden="true">Electrum · public servers</span>
		{/if}
	</div>
	<div class="kv">
		<span class="k">Server</span>
		{#if node}
			<span class="v mono server">{node.server}</span>
		{:else}
			<span class="v mono server skeleton" aria-hidden="true">host.example:50002</span>
		{/if}
	</div>
	<div class="kv">
		<span class="k">Users</span>
		<span class="v tabular">
			{formatNumber(data.stats.users)} · {data.stats.admins} admin{data.stats.admins === 1
				? ''
				: 's'}
		</span>
	</div>
	<div class="kv">
		<span class="k">Wallets</span>
		<span class="v tabular">{formatNumber(data.stats.wallets)} imported</span>
	</div>
	{#if disk}
		<div class="kv storage">
			<span class="k">Storage</span>
			<div class="bar" role="img" aria-label="Disk {Math.round(disk.pct)}% full">
				<span class="fill" style="width: {disk.pct}%"></span>
			</div>
			<span class="v tabular small">{formatBytes(disk.used)} / {formatBytes(disk.total)}</span>
		</div>
	{:else}
		<div class="kv">
			<span class="k">Database</span>
			<span class="v tabular">
				{data.storage.dbBytes !== null ? formatBytes(data.storage.dbBytes) : '—'}
			</span>
		</div>
	{/if}
	<div class="kv">
		<span class="k">Uptime</span>
		<span class="v tabular">{uptime}</span>
	</div>
	<div class="kv">
		<span class="k">Version</span>
		<span class="v tabular">{data.version}</span>
		{#if notice}
			<a
				class="version-note amber-note"
				href={notice.releaseUrl}
				target="_blank"
				rel="noopener noreferrer"
			>
				<span class="dot-badge amber"></span>{notice.latestVersion} available
			</a>
		{:else}
			<span class="version-note sage-note">
				<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2">
					<path d="M4 10.5 L8.5 15 L16 5.5" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
				current
			</span>
		{/if}
	</div>
	<div class="kv">
		<span class="k">Registration</span>
		<span class="v cap">{data.registrationMode}</span>
		<a class="row-action" href="/admin/settings">Change</a>
	</div>
	<div class="kv">
		<span class="k">Config backup</span>
		{#if backupStale}
			<span class="v stale"><span class="dot-badge amber"></span>{backupLabel}</span>
			<a class="row-action" href="/admin/backup">Back up</a>
		{:else}
			<span class="v fresh"><span class="dot-badge sage"></span>{backupLabel}</span>
		{/if}
	</div>
	{#if isTeam}
		<div class="kv">
			<span class="k">Active invites</span>
			<span class="v tabular">{formatNumber(data.stats.activeInvites)}</span>
			<a class="row-action" href="/admin/invites">Manage</a>
		</div>
	{/if}
</div>

<!-- footer: instance links + the faint irreversible thing -->
<div class="foot fade-in">
	<span class="foot-links">
		{#if isTeam}<a href="/admin/users">Users</a> · <a href="/admin/invites">Invites</a> · {/if}<a
			href="/admin/logs">Logs</a
		>
		· <a href="/terms" target="_blank" rel="noopener">Agreement</a> —
		<a class="foot-cta" href="/admin/settings">Instance settings →</a>
	</span>
	<a class="foot-reset" href="/admin/settings">Factory reset…</a>
</div>

<style>
	.status-row {
		display: flex;
		justify-content: flex-end;
		/* Tucks up beside the layout's tab row rhythm. */
		margin-top: -6px;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		font-weight: 500;
		border-radius: 20px;
		padding: 7px 14px;
	}

	.status.healthy {
		color: var(--sage);
		background: rgba(138, 160, 110, 0.08);
		border: 1px solid rgba(138, 160, 110, 0.25);
	}

	.status.behind {
		color: var(--attention);
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
	}

	.status.checking {
		color: var(--text-muted);
		background: var(--bg-input);
		border: 1px solid var(--hairline);
	}

	/* Constrain the streamed-in hero sub-line skeleton to its text width rather
	   than the full column. */
	.hero-ring.skeleton-line {
		display: inline-block;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}

	.dot.blink {
		animation: hwBlink 2.4s ease-in-out infinite;
	}

	/* --- hero --- */
	.hero {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 32px;
		margin-top: 14px;
	}

	.hero-main {
		min-width: 0;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 14px;
	}

	.hero-height {
		font-size: 72px;
		line-height: 0.92;
		color: var(--text-hero);
	}

	.hero-height.dim {
		color: var(--text-faint);
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hero-ring {
		margin-top: 16px;
		font-size: 15px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.attention-text {
		color: var(--attention);
		font-size: 13.5px;
		line-height: 1.5;
	}

	.attention-text a {
		color: var(--accent);
	}

	.hero-dial {
		flex-shrink: 0;
	}

	/* --- k/v grid --- */
	.kv-grid {
		margin-top: 44px;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0 64px;
	}

	.kv {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.k {
		flex: 1;
		font-size: 13.5px;
		color: var(--text-faint);
	}

	.v {
		font-size: 14px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.v.small {
		font-size: 13px;
		color: #cbbfb3; /* spec value tone */
	}

	.v.cap {
		text-transform: capitalize;
	}

	.v.mono {
		font-size: 12.5px;
	}

	.server {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 220px;
	}

	.v.stale {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--attention);
	}

	.v.fresh {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--sage);
	}

	.dot-badge {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot-badge.sage {
		background: var(--sage);
	}

	.dot-badge.amber {
		background: var(--accent);
	}

	.row-action {
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
	}

	.row-action:hover {
		color: var(--accent-hover);
	}

	.version-note {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
	}

	.sage-note {
		color: var(--sage);
	}

	.amber-note {
		color: var(--attention);
	}

	.amber-note:hover {
		color: var(--accent-bright);
	}

	/* storage bar row: label | bar | numbers */
	.kv.storage .k {
		flex: none;
		width: 90px;
	}

	.bar {
		flex: 1;
		height: 4px;
		border-radius: 2px;
		background: var(--bg-input);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, #b5673a, var(--accent));
	}

	/* --- footer --- */
	.foot {
		margin-top: 34px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}

	.foot-links {
		font-size: 12.5px;
		color: var(--eyebrow-path);
	}

	.foot-links a {
		color: var(--eyebrow-path);
	}

	.foot-links a:hover {
		color: var(--text-secondary);
	}

	.foot-links a.foot-cta {
		color: var(--accent);
	}

	.foot-links a.foot-cta:hover {
		color: var(--accent-hover);
	}

	/* Deliberately faint — reads only when looked for. The reset flow itself
	   (typed confirmation) lives on the settings page. */
	.foot-reset {
		font-size: 12px;
		color: var(--text-faint);
	}

	.foot-reset:hover {
		color: var(--text-muted);
	}

	/* ============================================== mobile (8h, ≤900px) */
	@media (max-width: 900px) {
		.status-row {
			justify-content: center;
			margin-top: 0;
		}

		.hero {
			flex-direction: column-reverse;
			align-items: center;
			gap: 18px;
			margin-top: 22px;
			text-align: center;
		}

		.hero-dial :global(svg) {
			width: 72px;
			height: 72px;
		}

		.hero-height {
			font-size: 44px;
			line-height: 1;
		}

		.hero-sub {
			font-size: 12.5px;
		}

		.hero-ring {
			margin-top: 10px;
			font-size: 12px;
		}

		.kv-grid {
			grid-template-columns: 1fr;
			gap: 0;
			margin-top: 30px;
		}

		.foot {
			flex-direction: column;
			align-items: center;
			gap: 10px;
			text-align: center;
		}
	}
</style>
