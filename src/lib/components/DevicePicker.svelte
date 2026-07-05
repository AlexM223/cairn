<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { WalletDeviceType } from '$lib/types';

	// A grid of signing-device tiles for single-sig wallets. Whichever device
	// the user picks is saved on the wallet and routes the send flow's Sign
	// step. Deliberately offers a universal "Other / file" fallback so there is
	// always a valid choice — a wallet is never a dead-end viewer.
	let {
		selected = $bindable(null),
		compact = false
	}: {
		/** null = nothing picked yet. 'file' is the universal fallback. */
		selected?: WalletDeviceType | null;
		/** Tighter tiles for inline use inside the send flow. */
		compact?: boolean;
	} = $props();

	const OPTIONS: { key: WalletDeviceType; title: string; desc: string; icon: string }[] = [
		{ key: 'trezor', title: 'Trezor', desc: 'Plug in over USB — sign with one click.', icon: 'shield' },
		{ key: 'ledger', title: 'Ledger', desc: 'Plug in over USB — sign with one click.', icon: 'shield' },
		{ key: 'coldcard', title: 'ColdCard', desc: 'Air-gapped over a microSD card.', icon: 'shield' },
		{ key: 'bitbox02', title: 'BitBox02', desc: 'Plug in over USB — confirm on the device.', icon: 'shield' },
		{ key: 'jade', title: 'Jade', desc: 'Plug in over USB (Chrome/Edge).', icon: 'shield' },
		{
			key: 'qr',
			title: 'Air-gapped QR',
			desc: 'Camera QR — SeedSigner, Passport, Keystone.',
			icon: 'qr'
		},
		{
			key: 'file',
			title: 'Other / file',
			desc: 'Any PSBT wallet — Sparrow, Electrum, BlueWallet.',
			icon: 'wallet'
		}
	];
</script>

<div class="device-grid" class:compact role="radiogroup" aria-label="Signing device">
	{#each OPTIONS as opt (opt.key)}
		<button
			type="button"
			class="device-opt"
			class:selected={selected === opt.key}
			role="radio"
			aria-checked={selected === opt.key}
			onclick={() => (selected = opt.key)}
		>
			<span class="opt-icon"><Icon name={opt.icon} size={compact ? 15 : 17} /></span>
			<span class="opt-body">
				<span class="opt-title">{opt.title}</span>
				<span class="opt-desc">{opt.desc}</span>
			</span>
			{#if selected === opt.key}
				<span class="opt-check"><Icon name="check" size={15} /></span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.device-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 8px;
	}

	.device-opt {
		display: flex;
		align-items: center;
		gap: 11px;
		text-align: left;
		padding: 12px 14px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		color: inherit;
		font: inherit;
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.compact .device-opt {
		padding: 9px 11px;
	}

	.device-opt:hover {
		border-color: var(--accent);
	}

	.device-opt.selected {
		border-color: var(--accent);
		background: var(--accent-muted);
	}

	.opt-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.device-opt.selected .opt-icon {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.opt-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 0;
	}

	.opt-title {
		font-size: 13.5px;
		font-weight: 600;
	}

	.opt-desc {
		font-size: 11.5px;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.opt-check {
		display: flex;
		color: var(--accent);
		flex-shrink: 0;
	}
</style>
