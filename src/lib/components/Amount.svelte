<script lang="ts">
	// Shared amount display (bead cairn-vnfs — non-send surfaces). Per the UX
	// research spec's fiat display rule: fiat is prominent/primary whenever a
	// price is available, BTC is the small secondary line beneath (or, for the
	// compact `inline` size, in parentheses after). When no price is available
	// (feed unset, fetch failed, still loading) it degrades to a clean BTC-only
	// look — same typography slot, no broken/empty fiat line — so the page never
	// looks unfinished.
	//
	// By default this subscribes to the shared, auto-refreshing `$lib/price`
	// store, so most call sites need nothing more than an amount and a size.
	// Pages that keep their own privacy-gated price (e.g. the dashboard's
	// existing show/hide-fiat toggle) can pass `price` explicitly — including
	// `null` to force the BTC-only look regardless of what the store has.
	import { btcUsd } from '$lib/price';
	import { formatBtc, formatSats, formatFiat, btcToFiat } from '$lib/format';

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
	const effectivePrice = $derived(price === undefined ? $btcUsd : price);
	const fiatValue = $derived(
		effectivePrice != null ? btcToFiat(Math.abs(btcValue), effectivePrice) : null
	);
	const prefix = $derived(sign ? (satsValue > 0 ? '+' : satsValue < 0 ? '−' : '') : '');
	const btcText = $derived(`${prefix}${formatBtc(Math.abs(satsValue), { trim })} BTC`);
	const fiatText = $derived(fiatValue != null ? `${prefix}${formatFiat(fiatValue)}` : null);
	const secondaryText = $derived(size === 'inline' ? `(${btcText})` : btcText);
	const resolvedAlign = $derived(align ?? (size === 'hero' ? 'start' : 'end'));
</script>

<span
	class="hw-amount size-{size} dir-{direction} align-{resolvedAlign}"
	title="{formatSats(satsValue)} sats"
>
	{#if fiatText != null}
		<span class="line primary">{fiatText}</span>
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

	/* --- hero: page-level total balance --- */
	.size-hero .line.primary {
		font-size: clamp(40px, 6.5vw, 72px);
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
