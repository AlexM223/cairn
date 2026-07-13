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
