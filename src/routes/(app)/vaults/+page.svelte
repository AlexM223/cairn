<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';
	import { VAULT_SCRIPT_LABELS } from './labels';

	let { data } = $props();
</script>

<svelte:head>
	<title>Vaults — Cairn</title>
</svelte:head>

<div class="head row">
	<h1 class="page-title grow">Vaults</h1>
	{#if data.vaults.length > 0}
		<a href="/vaults/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			New vault
		</a>
	{/if}
</div>

{#if data.vaults.length === 0}
	<div class="card onboard fade-in">
		<div class="onboard-icon">
			<Icon name="shield" size={26} />
		</div>
		<h2 class="onboard-title">Protect your savings with a vault</h2>
		<p class="onboard-copy">
			A vault is bitcoin that needs <em>several</em> of your keys to move — a stolen key spends
			nothing, a lost key loses nothing. Cairn walks you through it one key at a time, and only
			ever sees public keys.
		</p>
		<a href="/vaults/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Create a vault
		</a>
	</div>
{:else}
	<div class="grid fade-in">
		{#each data.vaults as vault (vault.id)}
			{@const unreachable = data.errors[vault.id] !== undefined}
			<a href="/vaults/{vault.id}" class="card card-pad vault-card">
				<div class="row" style="gap: 10px">
					<span class="vault-icon"><Icon name="shield" size={14} /></span>
					<span class="vault-name grow truncate">{vault.name}</span>
					<span class="badge badge-accent">{vault.threshold} of {vault.totalKeys}</span>
				</div>

				{#if unreachable}
					<div class="balance">
						<span class="hero-number vault-btc muted-balance">—</span>
					</div>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<span class="badge badge-warning" title={data.errors[vault.id]}>
							<Icon name="alert-triangle" size={12} />
							unreachable
						</span>
					</div>
				{:else}
					<div class="balance">
						<span class="hero-number vault-btc" title="{formatSats(vault.balance)} sats">
							{formatBtc(vault.balance)}
						</span>
						<span class="unit">BTC</span>
					</div>
					{#if vault.unconfirmed !== 0}
						<div class="row" style="gap: 8px; flex-wrap: wrap">
							<span class="badge badge-warning">
								{vault.unconfirmed > 0 ? '+' : ''}{formatSats(vault.unconfirmed)} sats pending
							</span>
						</div>
					{/if}
				{/if}

				<span class="hint activity">
					<Icon name="clock" size={12} />
					{#if unreachable}
						balance unavailable — check connection
					{:else if vault.lastActivity}
						last activity {timeAgo(vault.lastActivity)}
					{:else}
						no activity
					{/if}
					<span class="grow"></span>
					<span class="script-hint">{VAULT_SCRIPT_LABELS[vault.scriptType]}</span>
				</span>
			</a>
		{/each}
	</div>
{/if}

<!-- The stateless (Caravan-style) escape hatch — secondary but not buried. -->
<p class="stateless-link hint">
	Have a config file?
	<a href="/vaults/stateless">Use the stateless signer</a> — balance, spending, and signatures
	straight from a descriptor or Caravan JSON, with nothing saved.
</p>

<style>
	.stateless-link {
		margin-top: 26px;
		text-align: center;
	}

	.stateless-link a {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.head {
		gap: 16px;
		margin-bottom: 22px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 14px;
	}

	.vault-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: inherit;
		transition: border-color 120ms var(--ease);
	}

	.vault-card:hover {
		border-color: var(--border);
	}

	.vault-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		flex-shrink: 0;
	}

	.vault-name {
		font-size: 14.5px;
		font-weight: 600;
	}

	.balance {
		display: flex;
		align-items: baseline;
		gap: 7px;
		margin-top: 2px;
	}

	.vault-btc {
		font-size: 28px;
	}

	.muted-balance {
		color: var(--text-muted);
	}

	.unit {
		font-size: 12px;
		color: var(--text-muted);
	}

	.activity {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: auto;
	}

	.script-hint {
		font-size: 11px;
	}

	/* --- onboarding empty state --- */

	.onboard {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		padding: 56px 32px;
		text-align: center;
		max-width: 520px;
		margin: 40px auto 0;
	}

	.onboard-icon {
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.onboard-title {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 560;
		letter-spacing: -0.01em;
	}

	.onboard-copy {
		color: var(--text-secondary);
		font-size: 13.5px;
		line-height: 1.65;
		max-width: 400px;
	}

	.onboard-copy em {
		font-style: normal;
		color: var(--text);
		font-weight: 500;
	}
</style>
