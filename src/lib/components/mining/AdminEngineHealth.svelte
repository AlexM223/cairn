<script lang="ts">
	/**
	 * AdminEngineHealth — the stratum engine's own vitals (status, Core RPC
	 * link, uptime, bind/port, template freshness, fatal errors) plus the
	 * start/stop/restart controls (cairn-vn43.10).
	 *
	 * Core-unconfigured is treated as its own empty state (reuses the shared
	 * CoreRpcRequiredNotice — the solo engine cannot build a block template
	 * without a Core RPC connection, same "no honest source, so it's off"
	 * doctrine every other RPC-gated feature uses). A stopped-but-configured
	 * engine gets its own calm "not running" card with a single Start action,
	 * per the manifesto's one-sentence-plus-one-action empty-state rule.
	 */
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import CoreRpcRequiredNotice from '$lib/components/CoreRpcRequiredNotice.svelte';
	import { agoLabel, bindLabel, formatUptime, type AdminMiningEngineView } from './adminMiningView';

	let {
		engine,
		error = null
	}: {
		engine: AdminMiningEngineView;
		/** Server action error (fail()'s message) surfaced from the last submit. */
		error?: string | null;
	} = $props();

	let busy = $state<'startStop' | 'restart' | null>(null);

	const coreConfigured = $derived(engine.coreRpc !== 'unconfigured' && engine.status !== 'core_missing');
	const running = $derived(engine.status === 'running');
</script>

<section class="hw-section engine-health">
	<div class="section-head">
		<span class="hw-title">Engine</span>
		<p class="hint">The Stratum server this instance runs for its own users to mine against.</p>
	</div>

	{#if error}
		<p class="error-line" role="alert">{error}</p>
	{/if}

	{#if !coreConfigured}
		<CoreRpcRequiredNotice feature="Solo mining" isAdmin={true} />
	{:else if !running}
		<div class="empty-state stopped-card">
			<span class="empty-title">The mining engine isn't running.</span>
			<p>Start it to accept connections from your users' miners.</p>
			<form
				method="POST"
				action="?/startStop"
				use:enhance={() => {
					busy = 'startStop';
					return async ({ update }) => {
						busy = null;
						await update();
					};
				}}
			>
				<button class="btn btn-primary" disabled={busy !== null}>
					{#if busy === 'startStop'}<span class="spinner"></span>{/if}
					<Icon name="zap" size={14} /> Start mining engine
				</button>
			</form>
		</div>
	{:else}
		<div class="stat-grid">
			<div class="stat">
				<span class="stat-k">Status</span>
				<span class="stat-v"><span class="dot-badge sage"></span>Running</span>
			</div>
			<div class="stat">
				<span class="stat-k">Core RPC</span>
				<span class="stat-v">
					<span class="dot-badge" class:sage={engine.coreRpc === 'ok'} class:amber={engine.coreRpc === 'down'}
					></span>
					{engine.coreRpc === 'ok' ? 'Connected' : 'Unreachable'}
				</span>
			</div>
			<div class="stat">
				<span class="stat-k">Uptime</span>
				<span class="stat-v tabular">{formatUptime(engine.uptimeSec)}</span>
			</div>
			<div class="stat">
				<span class="stat-k">Listening on</span>
				<span class="stat-v mono tabular">port {engine.stratumPort}</span>
			</div>
			<div class="stat">
				<span class="stat-k">Network exposure</span>
				<span class="stat-v">{bindLabel(engine.bind)}</span>
			</div>
			<div class="stat">
				<span class="stat-k">Last block template</span>
				<span class="stat-v tabular">{agoLabel(engine.lastTemplateAgoSec)}</span>
			</div>
		</div>

		{#if engine.fatalErrors.length > 0}
			<div class="fatal-errors" role="alert">
				<span class="fatal-title"><Icon name="alert-triangle" size={14} /> Fatal errors</span>
				<ul>
					{#each engine.fatalErrors as msg, i (i)}
						<li>{msg}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="actions">
			<form
				method="POST"
				action="?/startStop"
				use:enhance={() => {
					busy = 'startStop';
					return async ({ update }) => {
						busy = null;
						await update();
					};
				}}
			>
				<button class="btn btn-secondary btn-sm" disabled={busy !== null}>
					{#if busy === 'startStop'}<span class="spinner"></span>{/if}
					Stop
				</button>
			</form>
			<form
				method="POST"
				action="?/restart"
				use:enhance={() => {
					busy = 'restart';
					return async ({ update }) => {
						busy = null;
						await update();
					};
				}}
			>
				<button class="btn btn-secondary btn-sm" disabled={busy !== null}>
					{#if busy === 'restart'}<span class="spinner"></span>{/if}
					<Icon name="refresh" size={13} /> Restart
				</button>
			</form>
		</div>
	{/if}
</section>

<style>
	.engine-health {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.error-line {
		font-size: 13px;
		color: var(--error);
	}

	.stopped-card {
		gap: 10px;
	}

	.stopped-card p {
		margin: 0;
		color: var(--text-muted);
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 16px 24px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.stat-k {
		font-size: 12px;
		color: var(--text-faint);
	}

	.stat-v {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 14px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.stat-v.tabular {
		font-variant-numeric: tabular-nums;
	}

	.stat-v.mono {
		font-family: var(--font-mono);
		font-size: 13px;
	}

	.dot-badge {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--text-faint);
	}

	.dot-badge.sage {
		background: var(--sage);
	}

	.dot-badge.amber {
		background: var(--attention);
	}

	.fatal-errors {
		border: 1px solid var(--error-muted);
		border-radius: var(--radius-card);
		background: rgba(224, 96, 76, 0.08);
		padding: 12px 14px;
	}

	.fatal-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--error);
	}

	.fatal-errors ul {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.actions {
		display: flex;
		gap: 10px;
	}

	.actions form button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
</style>
