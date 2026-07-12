// Pure text formatters for the two send-flow spots that need a *string* rather
// than a rendered component (the CTA button label and the review summary
// sentence's amount slot). Every VISUAL money readout goes through
// Amount.svelte; this is the single place we format money as plain text.
import { formatBtc, formatFiat } from '$lib/format';

const SATS_PER_BTC = 100_000_000;

/** A sats amount as money text when a price is known, else BTC text.
 *  btcUsd != null → "$250.42"; else → "0.0031 BTC". */
export function moneyOrBtc(sats: number, btcUsd: number | null): string {
	if (btcUsd != null) {
		return formatFiat((sats / SATS_PER_BTC) * btcUsd);
	}
	return `${formatBtc(sats)} BTC`;
}

/** The primary send/broadcast button label, carrying the total that leaves the
 *  wallet so "did the fee come out of my amount or on top?" is never a question.
 *  review → "Send $250.42"  ·  confirm → "Broadcast — $250.42". */
export function sendCtaLabel(
	totalSats: number,
	btcUsd: number | null,
	mode: 'review' | 'confirm'
): string {
	const money = moneyOrBtc(totalSats, btcUsd);
	return mode === 'review' ? `Send ${money}` : `Broadcast — ${money}`;
}
