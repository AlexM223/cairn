<script lang="ts">
	// Named-speed fee control (cairn-krwp). Three plain-language speeds are the
	// primary control; the raw sat/vB custom rate lives behind an Advanced
	// disclosure. Emits the effective sat/vB `feeRate` the page hands to build()
	// — the exact same number the old page-local derivation produced, so the
	// draft→sign→broadcast plumbing is untouched.
	//
	// Deliberately shows arrival words + sat/vB, NOT a money cost per speed: the
	// per-speed fee in money needs the built PSBT's vsize (server-side coin
	// selection), so the real fee-as-money lands on the Review card instead.
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import Term from '$lib/components/Term.svelte';
	import { formatFeeRate } from '$lib/format';
	import { FEE_SPEEDS, FEE_RATE_TERM_TIP, type FeeChoiceKey } from './sendCopy';
	import { resolveFeeRate, belowFloorMessage } from './feeChoice';
	import type { FeeEstimates } from '$lib/types';

	let {
		fees,
		feeRate = $bindable(1),
		choice = $bindable('standard'),
		loading = false,
		note = undefined,
		vsize = null,
		onuserchange = undefined
	}: {
		fees: FeeEstimates | null;
		feeRate?: number;
		choice?: FeeChoiceKey;
		loading?: boolean;
		note?: string;
		/** The built draft's virtual size (review step, cairn-gt05.2): when
		 *  known, each speed shows its estimated COST as money (the Venmo read)
		 *  and the raw sat/vB demotes to muted micro-text, glossed once below.
		 *  Null (create-time / unknown) keeps the original rate-only display. */
		vsize?: number | null;
		/** Fired on a genuine USER interaction (speed tap / custom-rate edit) —
		 *  never on mount or on a live-estimate refresh. The review card uses
		 *  this to know a fee change was asked for (rebuild gate, gt05.2). */
		onuserchange?: () => void;
	} = $props();

	/** Estimated total fee for a speed at `rate`, when the draft's size is known. */
	function estimatedFeeSats(rate: number | null): number | null {
		if (rate == null || vsize == null || vsize <= 0) return null;
		return Math.max(1, Math.round(rate * vsize));
	}

	// Custom sat/vB box. Seeded from the live half-hour estimate until the user
	// edits it (the customFeeTouched guard, carried in from the old page code).
	let customFee = $state('5');
	let customFeeTouched = false;
	let advancedOpen = $state(false);

	$effect(() => {
		if (customFeeTouched) return;
		const h = fees?.halfHour;
		if (h != null) customFee = String(h);
	});

	// Custom always reveals the Advanced panel so the active input is visible.
	$effect(() => {
		if (choice === 'custom') advancedOpen = true;
	});

	// The effective rate + below-floor explanation are pure functions (feeChoice.ts,
	// unit-tested there): the named tier's live value, or the Custom box clamped up
	// to the node's own relay floor (cairn-eacw.5) — sub-1 honored on a capable
	// node, clamped to 1 with an explanation on an incapable/unknown one.
	const effectiveRate = $derived(resolveFeeRate(choice, customFee, fees));
	const belowFloorNote = $derived(belowFloorMessage(choice, customFee, fees));

	// Push the derived rate into the bound value the page reads in build().
	$effect(() => {
		feeRate = effectiveRate;
	});

	// Fee-typo warning: the effective rate drastically above the live fast tier
	// is almost always a mistyped custom rate. Moved in from the page — purely a
	// function of the rate vs fees.fastest. Non-blocking.
	const feeWarning = $derived.by(() => {
		const fast = fees?.fastest;
		if (fast == null || fast <= 0) return null;
		if (effectiveRate <= 50 || effectiveRate <= fast * 3) return null;
		const multiple = effectiveRate / fast;
		return {
			fast,
			multipleLabel: multiple >= 10 ? String(Math.round(multiple)) : multiple.toFixed(1)
		};
	});

	function selectSpeed(key: FeeChoiceKey) {
		choice = key;
		onuserchange?.();
	}

	function onCustomInput() {
		customFeeTouched = true;
		choice = 'custom';
		onuserchange?.();
	}
</script>

<div class="fee-picker" role="group" aria-label="How fast should this send?">
	<div class="fee-head">
		<span class="sec-label">Fee</span>
		{#if loading}
			<span class="fee-caption"><span class="skeleton">Loading live fee estimates…</span></span>
		{:else if !fees}
			<span class="fee-caption">Live fee estimates unavailable</span>
		{/if}
	</div>

	<div class="speed-rows">
		{#each FEE_SPEEDS as speed (speed.key)}
			{@const rate = fees?.[speed.tier] ?? null}
			<button
				type="button"
				class="speed-row"
				class:active={choice === speed.key}
				aria-pressed={choice === speed.key}
				onclick={() => selectSpeed(speed.key)}
			>
				<span class="speed-main">
					<span class="speed-name">{speed.name}</span>
					<span class="speed-eta">{speed.eta}</span>
				</span>
				<span class="speed-right">
					{#if estimatedFeeSats(rate) != null}
						<span class="speed-cost"><Amount sats={estimatedFeeSats(rate)!} size="inline" /></span>
						<span class="speed-rate micro tabular">{formatFeeRate(rate!)}</span>
					{:else if rate != null}
						<span class="speed-rate tabular">{formatFeeRate(rate)}</span>
					{:else if loading}
						<span class="speed-rate tabular"><span class="skeleton">0 sat/vB</span></span>
					{:else}
						<span class="speed-rate tabular">—</span>
					{/if}
				</span>
			</button>
		{/each}
	</div>

	{#if vsize != null && vsize > 0}
		<p class="fee-caption">
			Rates are shown in <Term tip={FEE_RATE_TERM_TIP}>sat/vB</Term> — the plain cost beside each speed
			is what this payment would actually pay.
		</p>
	{/if}

	<button
		type="button"
		class="advanced-toggle"
		aria-expanded={advancedOpen}
		aria-controls="fee-advanced"
		onclick={() => (advancedOpen = !advancedOpen)}
	>
		<Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={14} />
		<span>Advanced — set a custom fee rate</span>
	</button>

	{#if advancedOpen}
		<div class="fee-advanced fade-in" id="fee-advanced">
			<button
				type="button"
				class="speed-row custom-row"
				class:active={choice === 'custom'}
				aria-pressed={choice === 'custom'}
				onclick={() => selectSpeed('custom')}
			>
				<span class="speed-main">
					<span class="speed-name">Custom</span>
					<span class="speed-eta">depends on the mempool</span>
				</span>
			</button>
			<div class="custom-fee">
				<input
					class="custom-fee-input tabular"
					inputmode="decimal"
					bind:value={customFee}
					oninput={onCustomInput}
					aria-label="Custom fee rate in sat/vB"
				/>
				<span class="unit-sm">sat/vB</span>
			</div>
			{#if belowFloorNote}
				<p class="fee-caption">{belowFloorNote}</p>
			{/if}
			{#if !fees && !loading}
				<p class="fee-caption">
					Live fee estimates are unavailable — set a custom sat/vB rate above.
				</p>
			{/if}
		</div>
	{/if}

	{#if note}
		<p class="fee-caption">{note}</p>
	{/if}

	{#if feeWarning}
		<div class="attention-panel" role="alert">
			<Icon name="alert-triangle" size={16} />
			<div>
				<strong
					>That's {feeWarning.multipleLabel}× the current fast rate ({formatFeeRate(
						feeWarning.fast
					)}).</strong
				>
				If this is a typo, the extra fee is gone the moment you broadcast — miners keep it and there
				is no refund. Double-check the number before continuing.
			</div>
		</div>
	{/if}
</div>

<style>
	.fee-picker {
		display: flex;
		flex-direction: column;
		gap: 12px;
		border-top: 1px solid var(--hairline);
		padding-top: 18px;
	}

	.fee-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.sec-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.speed-rows {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.speed-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-icon-btn);
		padding: 11px 14px;
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.speed-row:hover {
		border-color: var(--border-ghost);
	}

	.speed-row.active {
		border-color: var(--accent);
		background: rgba(103, 150, 201, 0.1);
	}

	.speed-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.speed-name {
		font-size: 14.5px;
		font-weight: 600;
		color: var(--text-rows);
	}

	.speed-row.active .speed-name {
		color: var(--accent-bright);
	}

	.speed-eta {
		font-size: 12px;
		color: var(--text-muted);
	}

	.speed-right {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		flex-shrink: 0;
	}

	.speed-cost {
		font-size: 13.5px;
		color: var(--text-rows);
	}

	.speed-rate {
		font-size: 12.5px;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	/* Demoted raw rate (review mode): micro, muted — the money is the read. */
	.speed-rate.micro {
		font-size: 10.5px;
		color: var(--text-muted);
	}

	.advanced-toggle {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		padding: 2px 0;
		cursor: pointer;
	}

	.advanced-toggle:hover {
		color: var(--accent);
	}

	.fee-advanced {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.custom-row {
		cursor: pointer;
	}

	.custom-fee {
		display: flex;
		align-items: baseline;
		gap: 8px;
		max-width: 180px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 4px;
	}

	.custom-fee-input {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: var(--t-hero-weight);
		font-size: 17px;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.unit-sm {
		font-size: 11px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.fee-caption {
		font-size: 11.5px;
		color: var(--eyebrow-path);
		line-height: 1.5;
	}

	.attention-panel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-icon-btn);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text);
	}

	.attention-panel :global(svg) {
		color: var(--attention);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.attention-panel strong {
		display: block;
	}
</style>
