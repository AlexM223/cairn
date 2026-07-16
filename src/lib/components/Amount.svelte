<script lang="ts">
	// Shared amount display (bead cairn-vnfs — non-send surfaces; ordering
	// flipped by cairn-6ppq). Per DESIGN-MANIFESTO.md §3 (MUST): BTC/sats is
	// the primary line BY DEFAULT, fiat — when a price is available — is a
	// muted secondary line beneath (or, for the compact `inline` size, in
	// parentheses after). Fiat only becomes primary when the user has
	// explicitly opted into fiat-primary display via Settings -> Display
	// (see `fiatPrimaryPref` in `$lib/price`, and `isFiatPrimary` in
	// `$lib/format` for the decision itself). When no price is available
	// (feed unset, fetch failed, still loading) it degrades to a clean BTC-only
	// look — same typography slot, no broken/empty fiat line — so the page never
	// looks unfinished.
	//
	// By default this subscribes to the shared, auto-refreshing `$lib/price`
	// store, so most call sites need nothing more than an amount and a size.
	// Pages that keep their own privacy-gated price (e.g. the dashboard's
	// existing show/hide-fiat toggle) can pass `price` explicitly — including
	// `null` to force the BTC-only look regardless of what the store has.
	//
	// Regardless of what a call site passes, the Settings -> Display "Fiat
	// display: Hidden" toggle (`fiatVisible`, cairn-r494) always wins: this is
	// the single central place that setting is enforced, so no call site —
	// present or future — can leak a dollar figure by forgetting to gate
	// itself. See `resolveAmountPrice` in `$lib/format` for the precedence.
	import { btcUsd, fiatPrimaryPref, fiatVisible } from '$lib/price';
	import { formatBtc, formatSats, formatFiat, btcToFiat, isFiatPrimary, resolveAmountPrice } from '$lib/format';

	let {
		sats,
		btc,
		size = 'row',
		direction = 'neutral',
		sign = false,
		trim = true,
		align,
		price
	}: {
		/** Amount in satoshis. Provide this OR `btc`, not both. */
		sats?: number;
		/** Amount in whole BTC. Ignored if `sats` is given. */
		btc?: number;
		/** hero = page-level total, row = list/table row, inline = compact detail line. */
		size?: 'hero' | 'row' | 'inline';
		/** Tints the primary readout: sage for incoming, neutral rows-text for outgoing. */
		direction?: 'in' | 'out' | 'neutral';
		/** Prefix +/− per `direction` (tx rows); off by default (plain balances). */
		sign?: boolean;
		/** Trim trailing BTC zeros (passed through to formatBtc). */
		trim?: boolean;
		/** Text alignment of the stacked lines. Defaults to 'end' for row/inline
		 *  (numeric-column convention), 'start' for hero. */
		align?: 'start' | 'end';
		/** Explicit price override. Omit to use the shared auto-refreshing store;
		 *  pass `null` to force the BTC-only look regardless of the store. */
		price?: number | null;
	} = $props();

	const satsValue = $derived(sats ?? Math.round((btc ?? 0) * 1e8));
	const btcValue = $derived(satsValue / 1e8);
	const effectivePrice = $derived(resolveAmountPrice($fiatVisible, price, $btcUsd));
	const fiatValue = $derived(
		effectivePrice != null ? btcToFiat(Math.abs(btcValue), effectivePrice) : null
	);
	const prefix = $derived(sign ? (satsValue > 0 ? '+' : satsValue < 0 ? '−' : '') : '');
	const btcText = $derived(`${prefix}${formatBtc(Math.abs(satsValue), { trim })} BTC`);
	const fiatText = $derived(fiatValue != null ? `${prefix}${formatFiat(fiatValue)}` : null);
	// Sats-first by default (DESIGN-MANIFESTO.md §3 MUST); fiat only takes the
	// primary slot when the user has explicitly chosen fiat-primary display.
	const fiatPrimary = $derived(isFiatPrimary($fiatPrimaryPref, fiatText));
	const primaryText = $derived(fiatPrimary ? fiatText : btcText);
	const secondaryRaw = $derived(fiatPrimary ? btcText : fiatText);
	const secondaryText = $derived(
		secondaryRaw != null && size === 'inline' ? `(${secondaryRaw})` : secondaryRaw
	);
	const resolvedAlign = $derived(align ?? (size === 'hero' ? 'start' : 'end'));
</script>

<span
	class="hw-amount size-{size} dir-{direction} align-{resolvedAlign}"
	title="{formatSats(satsValue)} sats"
>
	{#if fiatText != null}
		<span class="line primary">{primaryText}</span>
		<span class="line secondary">{secondaryText}</span>
	{:else}
		<span class="line primary btc-only">{btcText}</span>
	{/if}
</span>

<style>
	.hw-amount {
		display: inline-flex;
		flex-direction: column;
		gap: 2px;
		font-variant-numeric: tabular-nums;
		min-width: 0;
	}

	.hw-amount.align-start {
		align-items: flex-start;
		text-align: left;
	}

	.hw-amount.align-end {
		align-items: flex-end;
		text-align: right;
	}

	.line {
		white-space: nowrap;
	}

	.line.primary {
		font-family: var(--font-serif);
		font-weight: 600;
	}

	.line.secondary {
		font-family: var(--font-ui);
		font-weight: 500;
		color: var(--text-muted);
	}

	/* --- hero: page-level total balance ---
	   Weight matches --t-hero-weight (~440, DESIGN-MANIFESTO.md §3) — /600
	   reads too heavy on the Fraunces variable serif for one calm numeral.
	   Scoped to .size-hero only: .line.primary's base weight (600) still
	   governs size-row/size-inline, which are out of this pass's scope
	   (those surfaces span Home/Activity/Explorer, not just wallet/send). */
	.size-hero .line.primary {
		font-size: clamp(40px, 6.5vw, 72px);
		font-weight: var(--t-hero-weight);
		line-height: 0.95;
		letter-spacing: -0.015em;
		color: var(--text-hero);
	}

	.size-hero .line.secondary {
		font-size: 15px;
		margin-top: 6px;
	}

	@media (max-width: 900px) {
		.size-hero .line.primary {
			font-size: clamp(34px, 11vw, 48px);
		}

		.size-hero .line.secondary {
			font-size: 12.5px;
			margin-top: 4px;
		}
	}

	/* --- row: list/table row balance --- */
	.size-row .line.primary {
		font-size: 15.5px;
		color: var(--text-rows);
	}

	.size-row .line.secondary {
		font-size: 11px;
	}

	@media (max-width: 900px) {
		.size-row .line.primary {
			font-size: 13.5px;
		}

		.size-row .line.secondary {
			font-size: 10px;
		}
	}

	/* --- inline: compact single-purpose readout (e.g. detail rows) --- */
	.size-inline {
		flex-direction: row;
		align-items: baseline;
		gap: 6px;
	}

	.size-inline .line.primary {
		font-size: 13.5px;
		color: var(--text-rows);
	}

	.size-inline .line.secondary {
		font-size: 11.5px;
	}

	/* --- direction tints the primary readout only; the secondary BTC line
	   stays muted regardless, matching the existing tx-row convention where
	   the sats/meta line never carries the sage/attention tint. --- */
	.dir-in .line.primary {
		color: var(--sage);
	}

	.dir-out .line.primary {
		color: var(--text-rows);
	}
</style>
