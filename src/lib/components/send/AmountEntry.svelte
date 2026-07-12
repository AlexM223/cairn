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

	const SATS_PER_BTC = 100_000_000;

	// Price feed. Compact rows never use fiat, so the price is forced null there,
	// which also hides the swap and makes the secondary line show sats.
	const price = $derived(compact ? null : $btcUsd);

	let entryUnit = $state<'fiat' | 'btc'>('btc');
	let text = $state('');
	// The sats value the current `text` represents — lets the reseed effect tell
	// an external sats change apart from our own keystroke-driven write.
	let lastSats = -1;
	let userTouched = false;

	function textToSats(t: string, unit: 'fiat' | 'btc', p: number | null): number {
		const n = Number(t);
		if (!Number.isFinite(n) || n <= 0) return 0;
		if (unit === 'fiat') {
			if (p == null || p <= 0) return 0;
			return Math.round((n / p) * SATS_PER_BTC);
		}
		return Math.round(n * SATS_PER_BTC);
	}

	function satsToText(s: number, unit: 'fiat' | 'btc', p: number | null): string {
		if (s <= 0) return '';
		if (unit === 'fiat') {
			if (p == null || p <= 0) return '';
			return ((s / SATS_PER_BTC) * p).toFixed(2);
		}
		return formatBtc(s, { trim: true });
	}

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
		const s = textToSats(text, entryUnit, price);
		lastSats = s;
		sats = s;
	}

	function swap() {
		if (price == null) return;
		userTouched = true;
		entryUnit = entryUnit === 'fiat' ? 'btc' : 'fiat';
		text = satsToText(sats, entryUnit, price);
		lastSats = sats;
	}

	const overBalance = $derived(spendableSats != null && sats > spendableSats);

	// The live secondary line under the number: the OTHER currency when a price
	// is known, else the sats value (as the pre-fiat page showed).
	const secondaryLine = $derived.by(() => {
		if (price == null) return `${formatSats(sats)} sats`;
		if (entryUnit === 'fiat') return `≈ ${formatBtc(sats)} BTC`;
		return `≈ ${formatFiat((sats / SATS_PER_BTC) * price)}`;
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
				inputmode="decimal"
				placeholder={entryUnit === 'fiat' ? '0.00' : '0.00000000'}
				bind:value={text}
				oninput={handleInput}
				{autofocus}
				aria-label={ariaLabel ?? `Amount in ${entryUnit === 'fiat' ? 'dollars' : 'BTC'}`}
				aria-invalid={overBalance}
				style:width="{Math.max(4, (text || '0.00').length + 0.5)}ch"
			/>
			{#if entryUnit === 'btc'}<span class="hero-unit">BTC</span>{/if}
			{#if price != null}
				<button
					type="button"
					class="unit-swap"
					onclick={swap}
					aria-label="Switch entry currency"
					title="Switch entry currency"
				>
					<Icon name="refresh" size={14} />
				</button>
			{/if}
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
		font-weight: 600;
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

	.unit-swap {
		align-self: center;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		flex-shrink: 0;
		border: 1px solid var(--border-control);
		border-radius: 50%;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.unit-swap:hover {
		color: var(--accent);
		border-color: var(--border-ghost);
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
		font-weight: 600;
		font-size: 20px;
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
