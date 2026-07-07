<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatNumber } from '$lib/format';

	let { data } = $props();

	// A newer release exists (cairn-ivae.2). Dismissal is per-version and local
	// to this browser (localStorage) — a NEWER release than the dismissed one
	// brings the notice back. $effect so SSR (no localStorage) renders nothing
	// and hydration reveals it, same pattern as the layout's backup banner.
	const notice = $derived(data.updateNotice ?? null);
	let updateDismissed = $state(true);
	$effect(() => {
		updateDismissed = notice
			? localStorage.getItem('cairn.update.dismissed') === notice.latestVersion
			: true;
	});
	function dismissUpdate() {
		updateDismissed = true;
		if (notice) localStorage.setItem('cairn.update.dismissed', notice.latestVersion);
	}
</script>

<svelte:head>
	<title>Admin — Cairn</title>
</svelte:head>

{#if notice && !updateDismissed}
	<div class="update-banner fade-in" role="status">
		<Icon name="info" size={16} />
		<span class="grow">
			<strong>Cairn {notice.latestVersion} is available</strong> — you're running
			{notice.currentVersion}. Update through your app store (Umbrel/Docker) when convenient.
			<a href={notice.releaseUrl} target="_blank" rel="noopener noreferrer">Release notes</a>
		</span>
		<button
			type="button"
			class="update-banner-dismiss"
			aria-label="Dismiss until the next release"
			onclick={dismissUpdate}
		>
			<Icon name="x" size={14} />
		</button>
	</div>
{/if}

<div class="grid fade-in">
	<div class="card card-pad stat">
		<span class="overline">Users</span>
		<span class="hero-number stat-value">{formatNumber(data.stats.users)}</span>
		<span class="hint">{data.stats.admins} admin{data.stats.admins === 1 ? '' : 's'}</span>
	</div>

	<div class="card card-pad stat">
		<span class="overline">Wallets</span>
		<span class="hero-number stat-value">{formatNumber(data.stats.wallets)}</span>
		<span class="hint">imported across all users</span>
	</div>

	<div class="card card-pad stat">
		<span class="overline">Active invites</span>
		<span class="hero-number stat-value">{formatNumber(data.stats.activeInvites)}</span>
		<a class="hint" href="/admin/invites">manage invites</a>
	</div>

	<div class="card card-pad stat">
		<span class="overline">Registration</span>
		<span class="stat-mode">{data.registrationMode}</span>
		<a class="hint" href="/admin/settings">change</a>
	</div>
</div>

<div class="card card-pad node-card fade-in">
	<div class="row" style="gap: 10px">
		<Icon name="server" size={18} />
		<span class="card-title grow">Node connection</span>
		{#if data.node.connected}
			<span class="badge badge-success"><span class="dot"></span>Connected</span>
		{:else}
			<span class="badge badge-error">Disconnected</span>
		{/if}
	</div>

	<div class="node-rows">
		<div class="node-row">
			<span class="node-label">Mode</span>
			<span>{data.node.mode === 'public' ? 'Public servers' : 'Custom'}</span>
		</div>
		<div class="node-row">
			<span class="node-label">Electrum server</span>
			<span class="mono">{data.node.server}</span>
		</div>
		<div class="node-row">
			<span class="node-label">Chain tip</span>
			<span class="tabular">
				{data.node.tipHeight ? formatNumber(data.node.tipHeight) : '—'}
			</span>
		</div>
		{#if data.node.error}
			<div class="node-row">
				<span class="node-label">Error</span>
				<span style="color: var(--error)">{data.node.error}</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.update-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 14px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		background: var(--accent-muted);
		border: 1px solid var(--accent-muted);
		border-radius: var(--radius-control);
	}

	.update-banner :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	.update-banner strong {
		color: var(--text);
	}

	.update-banner a {
		color: var(--accent);
		font-weight: 500;
	}

	.update-banner-dismiss {
		display: flex;
		align-items: center;
		background: none;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		padding: 2px;
		flex-shrink: 0;
	}

	.update-banner-dismiss:hover {
		color: var(--text);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 14px;
		margin-bottom: 14px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.stat-value {
		font-size: 32px;
	}

	.stat-mode {
		font-size: 20px;
		font-weight: 600;
		text-transform: capitalize;
		font-family: var(--font-serif);
	}

	.node-card {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.node-rows {
		display: flex;
		flex-direction: column;
	}

	.node-row {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		padding: 9px 0;
		border-bottom: 1px solid var(--border-subtle);
		font-size: 13.5px;
	}

	.node-row:last-child {
		border-bottom: none;
	}

	.node-label {
		color: var(--text-muted);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
</style>
