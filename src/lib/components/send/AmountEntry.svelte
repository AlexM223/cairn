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
	import { btcUsd, fiatPrimaryPref } from '$lib/price';
	import { unitPref, setUnitPref } from '$lib/units';
	import { formatBtc, formatSats, formatFiat } from '$lib/format';
	import { SATS_PER_BTC, sanitizeDecimal, textToSats, isHighSpend, nextUnit } from './amountInput';

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

	// Fiat only ever participates in the unit cycle when the user has
	// explicitly opted into fiat-primary display (Settings -> Display,
	// `fiatPrimaryPref` in $lib/price, cairn-nb8e) -- sats-first doctrine
	// (DESIGN-MANIFESTO.md §3): BTC/sats is the default hero, fiat is opt-in
	// secondary, never a denomination sprung on the user just because a price
	// happened to load.
	const fiatEligible = $derived(price != null && $fiatPrimaryPref);

	// Three-way denomination cycle: BTC -> sats -> (USD, only when fiat-primary
	// is on) -> BTC. `sats` (the bound prop) is always the canonical amount;
	// entryUnit only changes how `text` is rendered/parsed. Cycling never
	// recomputes `sats` from `text` — it re-renders `text` FROM the existing
	// `sats`, so no precision drift. Starts from the shared BTC/sats
	// preference (`$lib/units`, same `hw.unit` Settings writes) so this field
	// never disagrees with the rest of the app about which Bitcoin
	// denomination the user prefers (cairn-nb8e).
	let entryUnit = $state<'btc' | 'sats' | 'fiat'>($unitPref);
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

	// Before the user types, prefer fiat entry once a price is available --
	// but only for users who opted into fiat-primary display. Never overrides
	// a unit the user chose or text typed.
	$effect(() => {
		if (userTouched || compact) return;
		if (fiatEligible && entryUnit === 'btc' && sats <= 0) {
			entryUnit = 'fiat';
		}
	});

	// If the price feed drops, or fiat-primary gets turned off, mid-session
	// while entering in fiat, fall back to the user's BTC/sats preference so
	// entry never blocks on a missing rate or shows a denomination the user
	// no longer has enabled.
	$effect(() => {
		if (!fiatEligible && entryUnit === 'fiat') {
			entryUnit = $unitPref;
			text = satsToText(sats, $unitPref, null);
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
	// through BTC -> sats -> (USD, fiat-primary users only) -> BTC never
	// drifts the amount. Landing on BTC or sats writes back to the shared
	// `hw.unit` preference (`$lib/units`) so this field's cycle stays in sync
	// with Settings and every other BTC/sats surface (cairn-nb8e) — landing
	// on fiat leaves that preference untouched since it only ever tracks the
	// Bitcoin denomination, not fiat.
	function cycleUnit() {
		userTouched = true;
		entryUnit = nextUnit(entryUnit, fiatEligible);
		if (entryUnit !== 'fiat') setUnitPref(entryUnit);
		text = satsToText(sats, entryUnit, price);
		lastSats = sats;
	}

	const overBalance = $derived(spendableSats != null && sats > spendableSats);

	// R1 unit-slip guard (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md): a calm
	// amber note — never red, never blocking — when the typed amount is a
	// large share (>50%) of what this wallet can spend. Only meaningful below
	// the over-balance case above, so the two notes never compete for the
	// same line; see isHighSpend's own doc comment for the exact band.
	const highSpend = $derived(isHighSpend(sats, spendableSats));

	// The live secondary line under the number always keeps BOTH other
	// denominations visible (R1: "never let an amount exist on screen in only
	// one unit while editing" — the sats<->BTC swap is a 100,000,000x slip,
	// and a further slip if fiat is misread as BTC or vice versa).
	const secondaryLine = $derived.by(() => {
		if (price == null) {
			// No price loaded — nothing to convert to fiat, so just show the
			// other Bitcoin-denominated unit.
			return entryUnit === 'sats' ? `${formatBtc(sats)} BTC` : `${formatSats(sats)} sats`;
		}
		const fiatText = formatFiat((sats / SATS_PER_BTC) * price);
		const btcText = `${formatBtc(sats)} BTC`;
		const satsText = `${formatSats(sats)} sats`;
		if (entryUnit === 'sats') return `≈ ${btcText} · ${fiatText}`;
		if (entryUnit === 'fiat') return `≈ ${btcText} · ${satsText}`;
		return `≈ ${satsText} · ${fiatText}`;
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
		<!-- Compact rows are BTC-only entry (no unit cycle), so the field
		     itself already shows BTC — the conversion line's job here is just
		     the sats equivalent (R1: never show only one denomination). -->
		<p class="field-line tabular muted">{formatSats(sats)} sats</p>
		{#if highSpend}
			<p class="field-line attention high-spend">That's most of this wallet's balance.</p>
		{/if}
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
				<span class="unit-cycle-label">{unitLabel(nextUnit(entryUnit, fiatEligible))}</span>
			</button>
		</div>

		{#if overBalance}
			<p class="hero-sub attention">That's more than this wallet holds.</p>
		{:else if sats > 0}
			<p class="hero-sub tabular">{secondaryLine}</p>
			{#if highSpend}
				<p class="hero-sub attention high-spend">That's most of this wallet's balance.</p>
			{/if}
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

	/* The >50%-of-balance note (R1) appears/disappears reactively as the user
	   types — a quiet fade instead of a hard pop-in keeps it from reading as
	   an alarm (manifesto: animate process, never alarm). It stacks below the
	   conversion line rather than replacing it, so both stay legible. */
	.hero-sub.high-spend,
	.field-line.attention.high-spend {
		animation: attention-fade-in 150ms var(--ease) both;
	}

	@keyframes attention-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
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
