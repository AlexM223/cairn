<script lang="ts">
	// Bidirectional fiat⇄BTC amount entry (cairn-krwp). Owns the entry unit and
	// the raw typed text internally; emits canonical **sats** to the page, which
	// stores only sats and never thinks about display units.
	//
	// Model: the typed TEXT is the source of truth for entry. `sats` is computed
	// from it on every keystroke (at the live price when in fiat) and pushed to
	// the bound value. External writes to `sats` (resume seeding, a scanned BIP21
	// amount, etc.) reseed the text once. A passive price refresh does NOT rewrite
	// what the user typed — the number they entered stays put and the sats already
	// committed on their last keystroke are what will be sent (no silent drift).
	//
	// Compact (batch-row) mode is BTC-only: no swap, sats shown as the secondary
	// line — one fewer per-row unit to reason about.
	import Icon from '$lib/components/Icon.svelte';
	import { btcUsd } from '$lib/price';
	import { formatBtc, formatSats, formatFiat } from '$lib/format';
	import { SATS_PER_BTC, sanitizeDecimal, textToSats } from './amountInput';

	let {
		sats = $bindable(0),
		compact = false,
		autofocus = false,
		spendableSats = null,
		ariaLabel = undefined
	}: {
		sats?: number;
		compact?: boolean;
		autofocus?: boolean;
		spendableSats?: number | null;
		ariaLabel?: string;
	} = $props();

	// Price feed. Compact rows never use fiat, so the price is forced null there,
	// which also hides the swap and makes the secondary line show sats.
	const price = $derived(compact ? null : $btcUsd);

	// Three-way denomination cycle: BTC -> sats -> USD -> BTC. `sats` (the
	// bound prop) is always the canonical amount; entryUnit only changes how
	// `text` is rendered/parsed. Cycling never recomputes `sats` from `text` —
	// it re-renders `text` FROM the existing `sats`, so no precision drift.
	let entryUnit = $state<'btc' | 'sats' | 'fiat'>('btc');
	let text = $state('');
	// The sats value the current `text` represents — lets the reseed effect tell
	// an external sats change apart from our own keystroke-driven write.
	let lastSats = -1;
	let userTouched = false;

	function satsToText(s: number, unit: 'btc' | 'sats' | 'fiat', p: number | null): string {
		if (s <= 0) return '';
		if (unit === 'fiat') {
			if (p == null || p <= 0) return '';
			return ((s / SATS_PER_BTC) * p).toFixed(2);
		}
		if (unit === 'sats') return formatSats(s);
		return formatBtc(s, { trim: true });
	}

	// Cycle order skips fiat entirely when no price is known (nothing to
	// convert against), so BTC<->sats keeps working offline.
	function nextUnit(u: 'btc' | 'sats' | 'fiat', hasPrice: boolean): 'btc' | 'sats' | 'fiat' {
		const cycle: Array<'btc' | 'sats' | 'fiat'> = hasPrice
			? ['btc', 'sats', 'fiat']
			: ['btc', 'sats'];
		const i = cycle.indexOf(u);
		return cycle[(i + 1) % cycle.length];
	}

	const unitLabel = (u: 'btc' | 'sats' | 'fiat') =>
		u === 'btc' ? 'BTC' : u === 'sats' ? 'sats' : 'USD';

	// Reseed the text from an EXTERNAL sats change (resume seed, scanned amount,
	// consolidation clears it to 0). Our own keystrokes set lastSats first, so
	// this skips them and never fights active typing.
	$effect(() => {
		if (sats !== lastSats) {
			text = satsToText(sats, entryUnit, price);
			lastSats = sats;
		}
	});

	// Before the user types, prefer fiat entry once a price is available (the
	// consumer-app default). Never overrides a unit the user chose or text typed.
	$effect(() => {
		if (userTouched || compact) return;
		if (price != null && entryUnit === 'btc' && sats <= 0) {
			entryUnit = 'fiat';
		}
	});

	// If the price feed drops mid-session while entering in fiat, fall back to
	// BTC so entry never blocks on a missing rate.
	$effect(() => {
		if (price == null && entryUnit === 'fiat') {
			entryUnit = 'btc';
			text = satsToText(sats, 'btc', null);
			lastSats = sats;
		}
	});

	function handleInput() {
		userTouched = true;
		if (entryUnit === 'sats') {
			// Integers only, live thousands-separator formatting (e.g. "1,860").
			const digits = text.replace(/[^\d]/g, '');
			const n = digits === '' ? 0 : parseInt(digits, 10);
			text = n > 0 ? formatSats(n) : '';
			lastSats = n;
			sats = n;
			return;
		}
		// BTC/fiat: keep the field numeric (digits + one decimal point) so letters
		// and stray separators can't be typed or pasted in (cairn-wi8a). The sats
		// branch above already strips to digits.
		const cleaned = sanitizeDecimal(text);
		if (cleaned !== text) text = cleaned;
		const s = textToSats(cleaned, entryUnit, price);
		lastSats = s;
		sats = s;
	}

	// Cycles the DISPLAY denomination only — re-renders `text` from the
	// existing canonical `sats`, never recomputes `sats` itself, so cycling
	// through BTC -> sats -> USD -> BTC never drifts the amount.
	function cycleUnit() {
		userTouched = true;
		entryUnit = nextUnit(entryUnit, price != null);
		text = satsToText(sats, entryUnit, price);
		lastSats = sats;
	}

	const overBalance = $derived(spendableSats != null && sats > spendableSats);

	// The live secondary line under the number always keeps a fiat (and, in
	// sats mode, a BTC) equivalent visible so the other denominations never
	// disappear just because you're typing in one of them.
	const secondaryLine = $derived.by(() => {
		if (price == null) {
			return entryUnit === 'sats' ? `${formatBtc(sats)} BTC` : `${formatSats(sats)} sats`;
		}
		const fiatText = formatFiat((sats / SATS_PER_BTC) * price);
		if (entryUnit === 'sats') return `≈ ${formatBtc(sats)} BTC · ${fiatText}`;
		if (entryUnit === 'fiat') return `≈ ${formatBtc(sats)} BTC`;
		return `≈ ${fiatText}`;
	});
</script>

{#if compact}
	<div class="amount-input">
		<input
			class="batch-amount tabular"
			inputmode="decimal"
			placeholder="0.00000000"
			bind:value={text}
			oninput={handleInput}
			aria-label={ariaLabel ?? 'Amount in BTC'}
			aria-invalid={overBalance}
		/>
		<span class="unit-inline">BTC</span>
	</div>
	{#if overBalance}
		<p class="field-line attention">That's more than this wallet holds.</p>
	{:else if sats > 0}
		<p class="field-line tabular muted">{formatSats(sats)} sats</p>
	{/if}
{:else}
	<div class="amount-hero">
		<div class="hero-line">
			{#if entryUnit === 'fiat'}<span class="hero-unit lead">$</span>{/if}
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="hero-input"
				inputmode={entryUnit === 'sats' ? 'numeric' : 'decimal'}
				placeholder={entryUnit === 'fiat' ? '0.00' : entryUnit === 'sats' ? '0' : '0.00000000'}
				bind:value={text}
				oninput={handleInput}
				{autofocus}
				aria-label={ariaLabel ??
					`Amount in ${entryUnit === 'fiat' ? 'dollars' : entryUnit === 'sats' ? 'satoshis' : 'BTC'}`}
				aria-invalid={overBalance}
				style:width="{Math.max(4, (text || '0.00').length + 0.5)}ch"
			/>
			{#if entryUnit === 'btc'}<span class="hero-unit">BTC</span>{/if}
			{#if entryUnit === 'sats'}<span class="hero-unit">sats</span>{/if}
			<button
				type="button"
				class="unit-cycle"
				onclick={cycleUnit}
				aria-label="Change amount unit"
				title="Change amount unit"
			>
				<Icon name="swap-horizontal" size={13} />
				<span class="unit-cycle-label">{unitLabel(nextUnit(entryUnit, price != null))}</span>
			</button>
		</div>

		{#if overBalance}
			<p class="hero-sub attention">That's more than this wallet holds.</p>
		{:else if sats > 0}
			<p class="hero-sub tabular">{secondaryLine}</p>
		{:else if spendableSats != null}
			<p class="hero-sub">{formatBtc(spendableSats)} BTC spendable</p>
		{:else}
			<p class="hero-sub">Type an amount</p>
		{/if}

		{#if price != null}
			<p class="rate-anchor">1 BTC = {formatFiat(price)}</p>
		{/if}
	</div>
{/if}

<style>
	.amount-hero {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.hero-line {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
	}

	.hero-input {
		background: transparent;
		border: none;
		outline: none;
		padding: 0;
		max-width: 100%;
		min-width: 4ch;
		font-family: var(--font-serif);
		font-weight: var(--t-hero-weight);
		font-size: 86px;
		line-height: 0.92;
		letter-spacing: -0.015em;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.hero-input::placeholder {
		color: var(--text-faint);
	}

	.hero-input[aria-invalid='true'] {
		color: var(--attention);
	}

	.hero-unit {
		font-family: var(--font-serif);
		font-weight: 400;
		font-size: 34px;
		color: var(--eyebrow);
	}

	.hero-unit.lead {
		margin-right: -6px;
	}

	.unit-cycle {
		align-self: center;
		position: relative;
		display: flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
		height: 30px;
		padding: 0 10px 0 8px;
		border: 1px solid var(--border-control);
		border-radius: 15px;
		background: transparent;
		color: var(--text-secondary);
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	/* Invisible tap-area expansion to a >=44px touch target without enlarging
	   the 30px visual pill (cairn-amyl): -7px top/bottom => 30 + 14 = 44px. */
	.unit-cycle::before {
		content: '';
		position: absolute;
		inset: -7px 0;
	}

	.unit-cycle:hover {
		color: var(--accent);
		border-color: var(--border-ghost);
	}

	.unit-cycle-label {
		white-space: nowrap;
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	.hero-sub.attention {
		color: var(--attention);
	}

	.rate-anchor {
		font-size: 12px;
		color: var(--text-muted);
	}

	/* ---- compact (batch row) ---- */
	.amount-input {
		display: flex;
		align-items: baseline;
		gap: 8px;
		border-bottom: 1px solid var(--border-subtle);
		padding-bottom: 6px;
	}

	.batch-amount {
		flex: 1;
		min-width: 0;
		background: transparent;
		border: none;
		outline: none;
		padding: 4px 0;
		font-family: var(--font-serif);
		font-weight: var(--t-hero-weight);
		font-size: 20px;
		font-variant-numeric: tabular-nums;
		color: var(--text-hero);
		caret-color: var(--accent);
	}

	.batch-amount::placeholder {
		color: var(--text-faint);
	}

	.batch-amount[aria-invalid='true'] {
		color: var(--attention);
	}

	.unit-inline {
		padding: 2px 4px;
		font-family: var(--font-ui);
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.field-line {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.field-line.attention {
		color: var(--attention);
	}

	.field-line.muted {
		color: var(--text-muted);
	}
</style>
