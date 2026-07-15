export const SATS_PER_BTC = 100_000_000;

export type EntryUnit = 'btc' | 'sats' | 'fiat';

/**
 * Strip a decimal-entry field down to digits plus at most one decimal point,
 * dropping letters, commas, and any extra dots. Used to keep the BTC/fiat
 * amount inputs numeric as the user types — the sats input already strips to
 * digits on its own (cairn-wi8a).
 */
export function sanitizeDecimal(t: string): string {
	let seenDot = false;
	let out = '';
	for (const ch of t) {
		if (ch >= '0' && ch <= '9') out += ch;
		else if (ch === '.' && !seenDot) {
			out += ch;
			seenDot = true;
		}
	}
	return out;
}

/**
 * Parse typed text into canonical sats for the given entry unit. Non-numeric
 * or non-positive input yields 0. Commas are treated as (removable) grouping
 * separators. Fiat requires a positive price.
 */
export function textToSats(t: string, unit: EntryUnit, p: number | null): number {
	const n = Number(t.replace(/,/g, ''));
	if (!Number.isFinite(n) || n <= 0) return 0;
	if (unit === 'fiat') {
		if (p == null || p <= 0) return 0;
		return Math.round((n / p) * SATS_PER_BTC);
	}
	if (unit === 'sats') return Math.round(n);
	return Math.round(n * SATS_PER_BTC);
}

/**
 * R1 unit-slip guard (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md, F5 + F2):
 * a calm, non-blocking signal that the entered amount is a LARGE share of
 * what the wallet can actually spend — not an error, just worth noticing
 * before review. Deliberately separate from (and only meaningful below) the
 * existing >=100% "That's more than this wallet holds" over-balance guard
 * (which also owns the exactly-full-balance case): this only fires strictly
 * between 50% and 100% of spendable, so the two notes never show at once.
 * `spendableSats == null` (balance still streaming in) or `<= 0` never
 * triggers it — a guard with no known denominator can't be "most of" it.
 */
export function isHighSpend(sats: number, spendableSats: number | null): boolean {
	if (spendableSats == null || spendableSats <= 0) return false;
	if (sats <= 0 || sats >= spendableSats) return false;
	return sats > spendableSats * 0.5;
}
