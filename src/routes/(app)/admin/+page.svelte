<script lang="ts">
	import EpochDial from '$lib/components/heartwood/EpochDial.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { formatNumber, formatBytes } from '$lib/format';
	import { CHAIN_DOWN } from '$lib/chainStatusCopy';
	import { deriveHealth } from '$lib/health';

	let { data } = $props();

	const notice = $derived(data.updateNotice ?? null);

	// Node info is synchronous (cairn-j412): `data.node` is built in load()
	// from the same cheap, already-fresh signals Explorer/Home read (the
	// background-synced chain snapshot + the in-memory transport-health
	// signal) — no live per-request Electrum round-trip, so there is nothing
	// that can leave this page stuck on a loading skeleton forever the way the
	// old streamed-promise round-trip could. `nodeLoading` stays true only for
	// the genuinely transient window right after a fresh install/boot, before
	// the first background sync has landed and before any connection attempt
	// (success or failure) has been recorded.
	const node = $derived(data.node);
	const nodeLoading = $derived(!node.connected && node.error === undefined);
	const connected = $derived(node.connected);

	// Forming-ring math (spec 5g): N = floor(h/2016); ring N+1 is forming;
	// progress = laid/2016; close ETA = blocks left × 10 min. Lives one tap
	// down in Node → Details now (Phase 3) — chain internals leave the surface.
	const tip = $derived(node.tipHeight);
	const ringNumber = $derived(tip !== null ? Math.floor(tip / 2016) + 1 : null);
	const ringLaid = $derived(tip !== null ? tip % 2016 : 0);
	const ringProgress = $derived(ringLaid / 2016);
	const ringCloses = $derived.by(() => {
		if (tip === null) return null;
		const eta = new Date(Date.now() + (2016 - ringLaid) * 10 * 60_000);
		return eta.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	});

	// Uptime in the roundest sensible unit (a dev metric — Details only).
	const uptime = $derived.by(() => {
		const s = data.uptimeSeconds;
		if (s >= 172_800) return `${Math.floor(s / 86_400)} days`;
		if (s >= 7_200) return `${Math.floor(s / 3_600)} hours`;
		if (s >= 120) return `${Math.floor(s / 60)} minutes`;
		return 'just started';
	});

	// Storage: how full the volume the database lives on is.
	const disk = $derived.by(() => {
		const { diskTotalBytes, diskFreeBytes } = data.storage;
		if (diskTotalBytes === null || diskFreeBytes === null || diskTotalBytes <= 0) return null;
		const used = diskTotalBytes - diskFreeBytes;
		return { used, total: diskTotalBytes, pct: Math.min(100, (used / diskTotalBytes) * 100) };
	});

	// Config-backup recency — stale past 30 days (matches the backup page's
	// staleness threshold).
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

	// Wallet backups — the funds-risk duty, promoted to row two (spec §2.6a).
	// Same unbacked-wallet list the (app) layout load already threads for its
	// banner nudge and Home's Health line: no new plumbing, one shared signal.
	const unbacked = $derived(data.unbackedWallets ?? []);

	// THE Health object (spec §2.6b): the same deriveHealth() Home's line and
	// the layout banners read, here fed the full admin-altitude inputs. The
	// headline and the four duty rows below all render from this one object.
	const health = $derived(
		deriveHealth({
			chainHealthy: nodeLoading ? null : connected,
			unbackedCount: unbacked.length,
			configBackupStale: backupStale,
			storagePctFull: disk?.pct ?? null,
			users: { total: data.stats.users, admins: data.stats.admins }
		})
	);

	// Which duty Details panels are expanded (real buttons + aria-expanded —
	// internals live one tap down, never on the surface).
	let open = $state<Record<string, boolean>>({});
	function toggleRow(key: string) {
		open[key] = !open[key];
	}
</script>

<svelte:head>
	<title>Health — Heartwood</title>
</svelte:head>

<!-- ONE status headline (spec §2.6a). The dot is never the only signal — the
     text label beside it carries the verdict (no hue-only status). -->
<div class="headline fade-in" class:attn={!health.ok} role="status">
	<span class="headline-dot" aria-hidden="true"></span>
	<span class="headline-text">{health.headline}</span>
</div>

<!-- The four monitored duties: Node / Backups / Storage / Users. Plain
     language on the surface; internals behind each Details expander. -->
<div class="duties fade-in">
	<!-- Node -->
	<div class="duty">
		<div class="duty-row">
			<span class="duty-name">Node</span>
			{#if nodeLoading}
				<span class="duty-state muted">Checking connection…</span>
			{:else if connected}
				<span class="duty-state"><span class="mini-dot sage"></span>Connected · at the tip</span>
			{:else}
				<span class="duty-state attn"><span class="mini-dot amber"></span>{CHAIN_DOWN}</span>
			{/if}
			<button
				type="button"
				class="duty-details"
				aria-expanded={!!open.node}
				aria-controls="node-details"
				onclick={() => toggleRow('node')}
			>
				Details <span class="chev" class:down={open.node}><Icon name="chevron-right" size={13} /></span>
			</button>
		</div>
		{#if open.node}
			<div class="duty-panel fade-in" id="node-details">
				{#if !connected && !nodeLoading}
					<p class="panel-attn">
						{node.error ?? `${CHAIN_DOWN}.`}
						<a href="/admin/settings#node-connection">Check the connection →</a>
					</p>
				{/if}
				<div class="panel-flex">
					<div class="panel-grid">
						<div class="pkv">
							<span class="pk">Block height</span>
							<span class="pv tabular">{tip !== null ? formatNumber(tip) : '—'}</span>
						</div>
						<div class="pkv">
							<span class="pk">Difficulty period</span>
							<span class="pv tabular">
								{#if tip !== null}
									{formatNumber(ringNumber!)} forming — {formatNumber(ringLaid)} of 2,016 blocks
									{#if ringCloses}· closes ≈ {ringCloses}{/if}
								{:else}
									—
								{/if}
							</span>
						</div>
						<div class="pkv">
							<span class="pk">Backend</span>
							<span class="pv">Electrum · {node.mode === 'public' ? 'public servers' : 'yours'}</span>
						</div>
						<div class="pkv">
							<span class="pk">Server</span>
							<span class="pv mono">{node.server}</span>
						</div>
						<div class="pkv">
							<span class="pk">Uptime</span>
							<span class="pv tabular">{uptime}</span>
						</div>
						<div class="pkv">
							<span class="pk">Version</span>
							<span class="pv tabular">{data.version}</span>
							{#if notice}
								<a
									class="version-note amber-note"
									href={notice.releaseUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									{notice.latestVersion} available
								</a>
							{:else}
								<span class="version-note sage-note">current</span>
							{/if}
						</div>
					</div>
					<div class="panel-dial" aria-hidden="true">
						<EpochDial
							state={connected ? 'at-tip' : 'behind'}
							progress={ringProgress}
							size={64}
							pulseKey={tip}
						/>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Backups — promoted to row two (spec §2.6a): the amber duty with its
	     inline action. Wallet backups (funds risk) outrank the instance
	     config backup (rebuild convenience); both live in Details. -->
	<div class="duty">
		<div class="duty-row">
			<span class="duty-name">Backups</span>
			{#if unbacked.length > 0}
				<span class="duty-state attn">
					<span class="mini-dot amber"></span>
					{unbacked.length === 1 ? '1 wallet not backed up' : `${unbacked.length} wallets not backed up`}
				</span>
				<a class="duty-cta" href={unbacked[0].href}>Back up now</a>
			{:else if backupStale}
				<span class="duty-state attn">
					<span class="mini-dot amber"></span>
					Config backup {backupLabel}
				</span>
				<a class="duty-cta" href="/admin/backup">Back up now</a>
			{:else}
				<span class="duty-state"><span class="mini-dot sage"></span>All backed up</span>
			{/if}
			<button
				type="button"
				class="duty-details"
				aria-expanded={!!open.backups}
				aria-controls="backups-details"
				onclick={() => toggleRow('backups')}
			>
				Details <span class="chev" class:down={open.backups}><Icon name="chevron-right" size={13} /></span>
			</button>
		</div>
		{#if open.backups}
			<div class="duty-panel fade-in" id="backups-details">
				<div class="panel-grid">
					<div class="pkv">
						<span class="pk">Wallet backups</span>
						{#if unbacked.length === 0}
							<span class="pv">Every wallet has a saved backup file.</span>
						{:else}
							<span class="pv attn-text">
								{#each unbacked as w, i (w.kind + w.id)}{#if i > 0}, {/if}<a href={w.href}>{w.name}</a>{/each}
								— download each wallet's backup from its page.
							</span>
						{/if}
					</div>
					<div class="pkv">
						<span class="pk">Instance config backup</span>
						<span class="pv" class:attn-text={backupStale}>{backupLabel}</span>
						<a class="row-action" href="/admin/backup">Back up ›</a>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Storage -->
	<div class="duty">
		<div class="duty-row">
			<span class="duty-name">Storage</span>
			{#if disk}
				<span class="duty-state" class:attn={health.storage.status === 'attention'}>
					{#if health.storage.status === 'attention'}<span class="mini-dot amber"></span>{/if}
					{Math.round(disk.pct)}% full · {formatBytes(disk.used)} / {formatBytes(disk.total)}
				</span>
			{:else}
				<span class="duty-state muted">
					Database {data.storage.dbBytes !== null ? formatBytes(data.storage.dbBytes) : '—'}
				</span>
			{/if}
			<button
				type="button"
				class="duty-details"
				aria-expanded={!!open.storage}
				aria-controls="storage-details"
				onclick={() => toggleRow('storage')}
			>
				Details <span class="chev" class:down={open.storage}><Icon name="chevron-right" size={13} /></span>
			</button>
		</div>
		{#if open.storage}
			<div class="duty-panel fade-in" id="storage-details">
				{#if disk}
					<div class="bar" role="img" aria-label="Disk {Math.round(disk.pct)}% full">
						<span class="fill" style="width: {disk.pct}%"></span>
					</div>
				{/if}
				<div class="panel-grid">
					<div class="pkv">
						<span class="pk">Database</span>
						<span class="pv tabular">
							{data.storage.dbBytes !== null ? formatBytes(data.storage.dbBytes) : '—'}
						</span>
					</div>
					{#if disk}
						<div class="pkv">
							<span class="pk">Disk</span>
							<span class="pv tabular">{formatBytes(disk.used)} used of {formatBytes(disk.total)}</span>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Users -->
	<div class="duty">
		<div class="duty-row">
			<span class="duty-name">Users</span>
			<span class="duty-state tabular">
				{#if isTeam}
					{formatNumber(data.stats.users)} user{data.stats.users === 1 ? '' : 's'} ·
					{data.stats.admins} admin{data.stats.admins === 1 ? '' : 's'} ·
					{formatNumber(data.stats.wallets)} wallet{data.stats.wallets === 1 ? '' : 's'}
				{:else}
					1 admin (you) · {formatNumber(data.stats.wallets)} wallet{data.stats.wallets === 1
						? ''
						: 's'}
				{/if}
			</span>
			{#if isTeam}
				<a class="duty-details" href="/admin/users">Manage <span class="chev"><Icon name="chevron-right" size={13} /></span></a>
			{/if}
		</div>
	</div>
</div>

<!-- Rare admin destinations (spec §2.6a): the old tab strip's occasional
     sections collapse behind these quiet links — the routes all still work. -->
<div class="instance fade-in">
	<span class="foot-links">
		<a class="foot-cta" href="/admin/settings">Instance settings →</a>
		· <a href="/admin/settings#registration">Registration: <span class="cap">{data.registrationMode}</span></a>
		· <a href="/admin/backup">Backup schedule</a>
		· <a href="/admin/feature-flags">Feature flags</a>
		· <a href="/admin/notifications">Notification delivery</a>
		· <a href="/admin/announcements">Announcements</a>
		· <a href="/admin/referral-settings">Referrals</a>
		· <a href="/admin/logs">Logs</a>
		· <a href="/admin/mining">Mining</a>
		· <a href="/terms" target="_blank" rel="noopener">Agreement</a>
	</span>
	<!-- Bottom of page, muted red, confirm-gated: the reset flow itself (typed
	     confirmation) lives on its own settings subsection. -->
	<a class="foot-reset" href="/admin/settings#factory-reset">Factory reset…</a>
</div>

<style>
	/* --- status headline --- */
	.headline {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.headline-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--sage);
	}

	.headline.attn .headline-dot {
		background: var(--attention);
	}

	/* --- duty rows --- */
	.duties {
		margin-top: 26px;
		display: flex;
		flex-direction: column;
	}

	.duty {
		border-bottom: 1px solid var(--hairline);
	}

	.duty-row {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 17px 0;
	}

	.duty-name {
		width: 90px;
		flex-shrink: 0;
		font-size: 13.5px;
		color: var(--text-faint);
	}

	.duty-state {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.duty-state.attn {
		color: var(--attention);
	}

	.duty-state.muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	.duty-state.tabular {
		font-variant-numeric: tabular-nums;
	}

	.mini-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.mini-dot.sage {
		background: var(--sage);
	}

	.mini-dot.amber {
		background: var(--attention);
	}

	/* Inline duty action ("Back up now") — the one actionable nudge. */
	.duty-cta {
		flex-shrink: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		border: 1px solid var(--accent-border);
		border-radius: 16px;
		padding: 5px 13px;
	}

	.duty-cta:hover {
		color: var(--accent-hover);
		border-color: var(--accent-border-strong);
	}

	/* Details / Manage — quiet, keyboard-operable. */
	.duty-details {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		flex-shrink: 0;
		border: none;
		background: none;
		cursor: pointer;
		font-family: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
		padding: 6px 4px;
	}

	.duty-details:hover {
		color: var(--text-secondary);
	}

	.chev {
		display: inline-flex;
		color: var(--text-faint);
		transition: transform 120ms var(--ease);
	}

	.chev.down {
		transform: rotate(90deg);
	}

	/* --- expanded panels (internals one tap down) --- */
	.duty-panel {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 2px 0 18px 106px;
	}

	.panel-flex {
		display: flex;
		align-items: flex-start;
		gap: 28px;
	}

	.panel-grid {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.pkv {
		display: flex;
		align-items: baseline;
		gap: 14px;
		padding: 8px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.pkv:last-child {
		border-bottom: none;
	}

	.pk {
		width: 150px;
		flex-shrink: 0;
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.pv {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-rows);
		min-width: 0;
	}

	.pv.tabular {
		font-variant-numeric: tabular-nums;
	}

	.pv.mono {
		font-family: var(--font-mono);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pv.attn-text,
	.panel-attn {
		color: var(--attention);
	}

	.pv.attn-text a {
		color: var(--attention);
		text-decoration: underline;
	}

	.panel-attn {
		font-size: 13px;
		line-height: 1.5;
		margin: 0;
	}

	.panel-attn a {
		color: var(--accent);
	}

	.panel-dial {
		flex-shrink: 0;
	}

	.row-action {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--accent);
		flex-shrink: 0;
	}

	.row-action:hover {
		color: var(--accent-hover);
	}

	.version-note {
		font-size: 12px;
		font-weight: 500;
	}

	.sage-note {
		color: var(--sage);
	}

	.amber-note {
		color: var(--attention);
	}

	.cap {
		text-transform: capitalize;
	}

	/* storage bar */
	.bar {
		height: 4px;
		border-radius: 2px;
		background: var(--bg-input);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent-dim), var(--accent));
	}

	/* --- instance links + the faint irreversible thing --- */
	.instance {
		margin-top: 34px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}

	.foot-links {
		font-size: 12.5px;
		line-height: 2;
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

	/* Deliberately quiet but honestly red — destructive is the only red on the
	   page (manifesto §2 semantics). The reset flow itself (typed confirmation)
	   is gated behind its settings subsection. */
	.foot-reset {
		flex-shrink: 0;
		font-size: 12px;
		color: var(--error);
		opacity: 0.72;
	}

	.foot-reset:hover {
		opacity: 1;
		color: var(--error);
	}

	/* ============================================== mobile (≤900px) */
	@media (max-width: 900px) {
		.headline {
			justify-content: center;
			font-size: 16.5px;
			margin-top: 0;
		}

		.duties {
			margin-top: 18px;
		}

		.duty-row {
			flex-wrap: wrap;
			gap: 8px 12px;
			padding: 14px 0;
		}

		.duty-name {
			width: 72px;
			font-size: 12.5px;
		}

		.duty-state {
			font-size: 13px;
			flex-basis: 0;
		}

		.duty-panel {
			padding-left: 0;
		}

		.panel-flex {
			flex-direction: column-reverse;
			gap: 14px;
		}

		.pk {
			width: 118px;
		}

		.instance {
			flex-direction: column;
			align-items: center;
			gap: 14px;
			text-align: center;
		}
	}
</style>
