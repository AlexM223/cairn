// Pure "Total in" helper for the tx-detail page, kept out of the .svelte file so
// its honesty rule is unit-testable in isolation (mirrors txTitle.ts).

/**
 * Sum of a transaction's input values, with an honesty flag. "Total in" is only
 * truthful when EVERY prevout value resolved: an unconfirmed (mempool) tx has
 * none, so each input row shows "—", and summing them to 0 would falsely imply
 * the tx spends nothing (cairn-zmym). Any unknown input ⇒ `known: false`, and the
 * caller renders "—" instead of "0.00 BTC" — matching how the fee already
 * degrades honestly on the same page.
 */
export function txTotalIn(vin: Array<{ value: number | null }>): { known: boolean; sats: number } {
	const known = vin.length > 0 && vin.every((v) => v.value !== null);
	const sats = vin.reduce((sum, v) => sum + (v.value ?? 0), 0);
	return { known, sats };
}
