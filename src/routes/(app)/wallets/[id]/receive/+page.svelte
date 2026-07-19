<!--
	/wallets/[id]/receive — the canonical Receive surface (cairn-gt05.2, spec
	§2.4). A Tier-2 subpage: QR hero, "A fresh address, every time.", Copy,
	Advanced › — the exact ReceivePanel the wallet-detail Receive tab embeds.
-->
<script lang="ts">
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ReceivePanel from '../_components/ReceivePanel.svelte';

	let { data, form } = $props();

	// A successful rotate returns the fresh address via form; the snapshot's
	// address is the resting state.
	const receive = $derived(form?.receive ?? data.receive ?? null);
</script>

<svelte:head>
	<title>Receive · {data.wallet.name} · Heartwood</title>
</svelte:head>

<div class="receive-page hw-page fade-in">
	<GroveField volume="present" />
	<div class="hw-content">
		<div class="eyebrow-row">
			<EyebrowBreadcrumb path={['Wallets', data.wallet.name]} current="Receive" />
		</div>

		<a class="back-link" href={`/wallets/${data.wallet.id}`}>
			<Icon name="chevron-left" size={14} /> Back to {data.wallet.name}
		</a>

		<section class="receive-wrap" aria-label="Receive bitcoin">
			<ReceivePanel
				{receive}
				serverError={form?.receiveError ?? null}
				neverFunded={data.neverFunded}
			/>
		</section>
	</div>
</div>

<style>
	.hw-page {
		position: relative;
	}

	.hw-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		max-width: var(--measure-reading);
	}

	.eyebrow-row {
		margin-bottom: 14px;
	}

	.back-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		margin-bottom: 28px;
	}

	.back-link:hover {
		color: var(--accent);
	}

	.back-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.receive-wrap {
		display: flex;
		flex-direction: column;
	}
</style>
