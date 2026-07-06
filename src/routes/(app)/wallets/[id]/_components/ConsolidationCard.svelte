<!--
	Consolidation suggestion for wallets holding high-mass coins (coins born in
	enormous batch payouts, e.g. mining-pool payout runs). Hardware wallets read
	each coin's full parent transaction while signing, so these coins are slow —
	minutes each. Sweeping them to the wallet's own address once replaces them
	with one fast coin, making every future spend quick.

	Purely advisory: fetched lazily on mount, invisible when the mass endpoint
	is unavailable or no high-mass coins exist, dismissible per coin-set (a new
	high-mass coin changes the set hash, so the card comes back).
-->
<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatSats } from '$lib/format';
	import type { FeeEstimates } from '$lib/types';
	import {
		fetchUtxoMass,
		utxoSetHash,
		MASS_NOT_FEES_TIP,
		type UtxoMass
	} from './signingMass';

	let {
		walletId,
		scriptType,
		receiveAddress
	}: {
		walletId: number;
		/** Wallet script type — sizes the per-input estimate for the fee guess. */
		scriptType: string;
		/** The wallet's own next receive address (prefills the consolidation send). */
		receiveAddress: string | null;
	} = $props();

	// Conservative per-input virtual sizes (vB) by script type, for the rough
	// cost estimate only — the real fee is computed (and shown) by the builder
	// before anything is signed. Unknown types fall back to the legacy worst case.
	const INPUT_VSIZE: Record<string, number> = {
		p2pkh: 148,
		'p2sh-p2wpkh': 91,
		p2wpkh: 68,
		p2tr: 58
	};
	const OUTPUT_AND_OVERHEAD_VSIZE = 54; // one output (~43) + tx overhead (~11)

	let masses = $state<UtxoMass[] | null>(null);
	let normalFeeRate = $state<number | null>(null);
	let dismissedHash = $state<string | null>(null);
	let loaded = $state(false);

	// Lazy, once, client-only. Both fetches are best-effort: no mass data means
	// no card; no fee data just drops the cost line.
	$effect(() => {
		if (loaded) return;
		loaded = true;
		try {
			dismissedHash = localStorage.getItem(`cairn.consolidate.dismissed.${walletId}`);
		} catch {
			dismissedHash = null;
		}
		void fetchUtxoMass(walletId).then((m) => (masses = m));
		void fetch('/api/mempool/fees')
			.then(async (res) => {
				if (!res.ok) return;
				const fees = (await res.json()) as Partial<FeeEstimates>;
				if (typeof fees.halfHour === 'number' && fees.halfHour > 0) {
					normalFeeRate = fees.halfHour;
				}
			})
			.catch(() => {});
	});

	const heavy = $derived((masses ?? []).filter((m) => m.tier === 'high'));
	const heavyKeys = $derived(heavy.map((m) => `${m.txid}:${m.vout}`));
	const setHash = $derived(heavyKeys.length > 0 ? utxoSetHash(heavyKeys) : null);
	const show = $derived(heavy.length > 0 && setHash !== null && setHash !== dismissedHash);

	// Rough consolidation cost: N heavy inputs + one output back to yourself,
	// at today's normal tier. Labelled an estimate — the builder shows the
	// exact fee on Review before anything is signed.
	const estimatedFeeSats = $derived.by(() => {
		if (normalFeeRate === null) return null;
		const inVsize = INPUT_VSIZE[scriptType] ?? INPUT_VSIZE.p2pkh;
		return Math.ceil((heavy.length * inVsize + OUTPUT_AND_OVERHEAD_VSIZE) * normalFeeRate);
	});

	const consolidateHref = $derived.by(() => {
		const params = new URLSearchParams();
		params.set('consolidate', heavyKeys.join(','));
		if (receiveAddress) params.set('to', receiveAddress);
		return `/wallets/${walletId}/send?${params.toString()}`;
	});

	function dismiss() {
		if (setHash === null) return;
		dismissedHash = setHash;
		try {
			localStorage.setItem(`cairn.consolidate.dismissed.${walletId}`, setHash);
		} catch {
			/* storage blocked — the in-memory dismissal still hides it this visit */
		}
	}
</script>

{#if show}
	<section class="card card-pad consolidate-card fade-in" aria-label="Consolidation suggestion">
		<div class="consolidate-head">
			<Icon name="clock" size={15} />
			<span class="card-title grow">Make future sends faster</span>
			<button type="button" class="consolidate-dismiss" aria-label="Dismiss" onclick={dismiss}>
				<Icon name="x" size={14} />
			</button>
		</div>
		<p class="consolidate-body">
			{heavy.length} of your coins came from large batch payouts and will be
			<Term tip={MASS_NOT_FEES_TIP}>slow to sign</Term>. Sending them to yourself once makes every
			future spend fast.
		</p>
		<p class="hint">
			{#if estimatedFeeSats !== null}
				Rough cost: ~{formatSats(estimatedFeeSats)} sats in network fees at today's normal rate —
				an estimate; you'll see the exact fee before signing.
			{:else}
				Costs one ordinary network fee — you'll see the exact amount before signing.
			{/if}
			The one-time slow signing happens now, instead of on every future send.
		</p>
		<div class="consolidate-actions">
			<a class="btn btn-secondary btn-sm" href={consolidateHref}>
				<Icon name="zap" size={14} />
				Consolidate now
			</a>
		</div>
	</section>
{/if}

<style>
	.consolidate-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-bottom: 18px;
	}

	.consolidate-head {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--warning);
	}

	.consolidate-head .card-title {
		color: var(--text);
	}

	.consolidate-dismiss {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
		background: none;
		border: none;
		border-radius: var(--radius-chip);
		color: var(--text-muted);
		cursor: pointer;
	}

	.consolidate-dismiss:hover {
		color: var(--text);
		background: var(--bg);
	}

	.consolidate-body {
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.consolidate-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
