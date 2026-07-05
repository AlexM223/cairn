<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';
	import { SCRIPT_TYPE_LABELS } from './labels';

	let { data } = $props();
</script>

<svelte:head>
	<title>Wallets — Cairn</title>
</svelte:head>

<div class="head row">
	<h1 class="page-title grow">Wallets</h1>
	{#if data.wallets.length > 0}
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Add wallet
		</a>
	{/if}
</div>

{#if data.wallets.length === 0 && data.vaults.length === 0}
	<div class="card onboard fade-in">
		<div class="onboard-icon">
			<Icon name="wallet" size={26} />
		</div>
		<h2 class="onboard-title">Bring your first wallet</h2>
		<p class="onboard-copy">
			Cairn watches your wallet from the outside. Paste an extended <em>public</em> key — an
			xpub, ypub or zpub — and it derives your addresses, finds your history and keeps your
			balance in view. No private keys, no seed words, nothing that can spend.
		</p>
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Import a wallet
		</a>
		<a href="/vaults/new" class="onboard-alt">
			Or protect savings with several keys — create a vault
			<Icon name="arrow-right" size={13} />
		</a>
	</div>
{:else if data.wallets.length === 0}
	<div class="card onboard fade-in" style="margin-bottom: 24px">
		<div class="onboard-icon">
			<Icon name="wallet" size={26} />
		</div>
		<h2 class="onboard-title">Bring your first wallet</h2>
		<p class="onboard-copy">
			Cairn watches your wallet from the outside. Paste an extended <em>public</em> key and it
			keeps balances and history in view — nothing that can spend.
		</p>
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Import a wallet
		</a>
	</div>
{:else}
	<div class="grid fade-in">
		{#each data.wallets as wallet (wallet.id)}
			{@const unreachable = data.errors[wallet.id] !== undefined}
			<a href="/wallets/{wallet.id}" class="card card-pad wallet-card">
				<div class="row" style="gap: 10px">
					<span class="wallet-name grow truncate">{wallet.name}</span>
					<span class="badge badge-neutral">{SCRIPT_TYPE_LABELS[wallet.scriptType]}</span>
				</div>

				{#if unreachable}
					<div class="balance">
						<span class="hero-number wallet-btc muted-balance">—</span>
					</div>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<span class="badge badge-warning" title={data.errors[wallet.id]}>
							<Icon name="alert-triangle" size={12} />
							unreachable
						</span>
					</div>
				{:else}
					<div class="balance">
						<span class="hero-number wallet-btc" title="{formatSats(wallet.balance)} sats">
							{formatBtc(wallet.balance)}
						</span>
						<span class="unit">BTC</span>
					</div>
					{#if wallet.unconfirmed !== 0}
						<div class="row" style="gap: 8px; flex-wrap: wrap">
							<span class="badge badge-warning">
								{wallet.unconfirmed > 0 ? '+' : ''}{formatSats(wallet.unconfirmed)} sats pending
							</span>
						</div>
					{/if}
				{/if}

				<span class="hint activity">
					<Icon name="clock" size={12} />
					{#if unreachable}
						balance unavailable — check connection
					{:else if wallet.lastActivity}
						last activity {timeAgo(wallet.lastActivity)}
					{:else}
						no activity
					{/if}
				</span>
			</a>
		{/each}
	</div>
{/if}

{#if data.vaults.length > 0}
	<div class="head row vault-head">
		<h2 class="section-title grow">Vaults</h2>
		<a href="/vaults/new" class="btn btn-secondary btn-sm">
			<Icon name="plus" size={14} />
			New vault
		</a>
	</div>
	<div class="grid fade-in">
		{#each data.vaults as vault (vault.id)}
			{@const unreachable = data.vaultErrors[vault.id] !== undefined}
			<a href="/vaults/{vault.id}" class="card card-pad wallet-card vault-card">
				<div class="row" style="gap: 10px">
					<span class="vault-icon"><Icon name="shield" size={13} /></span>
					<span class="wallet-name grow truncate">{vault.name}</span>
					<span class="badge badge-accent">{vault.threshold} of {vault.totalKeys}</span>
				</div>

				{#if unreachable}
					<div class="balance">
						<span class="hero-number wallet-btc muted-balance">—</span>
					</div>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<span class="badge badge-warning" title={data.vaultErrors[vault.id]}>
							<Icon name="alert-triangle" size={12} />
							unreachable
						</span>
					</div>
				{:else}
					<div class="balance">
						<span class="hero-number wallet-btc" title="{formatSats(vault.balance)} sats">
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
				</span>
			</a>
		{/each}
	</div>
{/if}

<style>
	.head {
		gap: 16px;
		margin-bottom: 22px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 14px;
	}

	.wallet-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: inherit;
		transition: border-color 120ms var(--ease);
	}

	.wallet-card:hover {
		border-color: var(--border);
	}

	.wallet-name {
		font-size: 14.5px;
		font-weight: 600;
	}

	.balance {
		display: flex;
		align-items: baseline;
		gap: 7px;
		margin-top: 2px;
	}

	.wallet-btc {
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
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-top: auto;
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

	.onboard-alt {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	.onboard-alt:hover {
		color: var(--accent);
	}

	/* --- vaults section --- */

	.vault-head {
		margin-top: 26px;
	}

	.section-title {
		font-family: var(--font-serif);
		font-size: 18px;
		font-weight: 600;
	}

	.vault-card {
		border-color: rgba(232, 147, 90, 0.25);
	}

	.vault-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
		flex-shrink: 0;
	}
</style>
