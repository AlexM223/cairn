<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatBtc, formatSats, timeAgo } from '$lib/format';
	import { SCRIPT_TYPE_LABELS, walletTypeLabel } from './labels';

	let { data } = $props();

	// One list, two flavors. Single-sig wallets and multisig wallets are merged
	// into a single grid — the card head tells them apart (a script-type badge and
	// device kind for single-sig, a quorum badge for multisig).
	const items = $derived([
		...data.wallets.map((w) => ({
			kind: 'single' as const,
			id: w.id,
			href: `/wallets/${w.id}`,
			name: w.name,
			scriptType: w.scriptType,
			deviceType: w.deviceType,
			balance: w.balance,
			unconfirmed: w.unconfirmed,
			lastActivity: w.lastActivity,
			unreachable: data.errors[w.id] !== undefined,
			error: data.errors[w.id]
		})),
		...data.multisigs.map((m) => ({
			kind: 'multisig' as const,
			id: m.id,
			href: `/wallets/multisig/${m.id}`,
			name: m.name,
			threshold: m.threshold,
			totalKeys: m.totalKeys,
			balance: m.balance,
			unconfirmed: m.unconfirmed,
			lastActivity: m.lastActivity,
			unreachable: data.multisigErrors[m.id] !== undefined,
			error: data.multisigErrors[m.id]
		}))
	]);
</script>

<svelte:head>
	<title>Wallets — Cairn</title>
</svelte:head>

<div class="head row">
	<h1 class="page-title grow">Wallets</h1>
	{#if items.length > 0}
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Add wallet
		</a>
	{/if}
</div>

{#if items.length === 0}
	<div class="card onboard fade-in">
		<div class="onboard-icon">
			<Icon name="wallet" size={26} />
		</div>
		<h2 class="onboard-title">Bring your first wallet</h2>
		<p class="onboard-copy">
			Add a wallet with a single key, or a multisig wallet that needs several keys to spend. Cairn
			only ever sees <em>public</em> keys — it tracks your balance and history, and you sign every
			spend on your own device. Nothing here can move your bitcoin on its own.
		</p>
		<a href="/wallets/new" class="btn btn-primary">
			<Icon name="plus" size={15} />
			Add your first wallet
		</a>
	</div>
{:else}
	<div class="grid fade-in">
		{#each items as item (item.kind + '-' + item.id)}
			<a
				href={item.href}
				class="card card-pad wallet-card"
				class:multisig-card={item.kind === 'multisig'}
			>
				<div class="row" style="gap: 10px">
					{#if item.kind === 'multisig'}
						<span class="multisig-icon"><Icon name="shield" size={13} /></span>
					{/if}
					<span class="wallet-name grow truncate">{item.name}</span>
					{#if item.kind === 'multisig'}
						<span class="badge badge-accent">{item.threshold} of {item.totalKeys}</span>
					{:else}
						<span class="badge badge-neutral">{SCRIPT_TYPE_LABELS[item.scriptType]}</span>
					{/if}
				</div>
				<span class="wallet-kind">
					{item.kind === 'multisig' ? 'Multisig wallet' : walletTypeLabel(item.deviceType)}
				</span>

				{#if item.unreachable}
					<div class="balance">
						<span class="hero-number wallet-btc muted-balance">—</span>
					</div>
					<div class="row" style="gap: 8px; flex-wrap: wrap">
						<span class="badge badge-warning" title={item.error}>
							<Icon name="alert-triangle" size={12} />
							unreachable
						</span>
					</div>
				{:else}
					<div class="balance">
						<span class="hero-number wallet-btc" title="{formatSats(item.balance)} sats">
							{formatBtc(item.balance)}
						</span>
						<span class="unit">BTC</span>
					</div>
					{#if item.unconfirmed !== 0}
						<div class="row" style="gap: 8px; flex-wrap: wrap">
							<span class="badge badge-warning">
								{item.unconfirmed > 0 ? '+' : ''}{formatSats(item.unconfirmed)} sats pending
							</span>
						</div>
					{/if}
				{/if}

				<span class="hint activity">
					<Icon name="clock" size={12} />
					{#if item.unreachable}
						balance unavailable — check connection
					{:else if item.lastActivity}
						last activity {timeAgo(item.lastActivity)}
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

	.multisig-card {
		border-color: rgba(232, 147, 90, 0.25);
	}

	.multisig-icon {
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

	.wallet-name {
		font-size: 14.5px;
		font-weight: 600;
	}

	.wallet-kind {
		font-size: 11.5px;
		color: var(--text-muted);
		margin-top: -4px;
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
		max-width: 420px;
	}

	.onboard-copy em {
		font-style: normal;
		color: var(--text);
		font-weight: 500;
	}
</style>
