// Pure logic behind the shared FeeRate component (UX-REDESIGN-SPEC.md §2.5,
// cairn-gt05.4): pair a raw sat/vB fee rate with a plain-language confirmation
// time — the Mempool page's proven "raw + plain" pattern, given one owner.
// Extracted from the component so the rate→time mapping is unit-testable.

import { formatFeeRate } from '$lib/format';

/** Current fee-estimate tiers, as served in chain snapshots (`chain.fees`). */
export interface FeeEstimates {
	fastest: number;
	halfHour: number;
	hour: number;
	economy: number;
}

/**
 * Compact plain-language confirmation time for a fee rate measured against the
 * current estimates — the "≈ next block" half of "~1 sat/vB · ≈ next block".
 * Null when either side is unknown (Cardinal rule: never a fake time), and for
 * non-finite/negative rates, which are data errors rather than cheap fees.
 */
export function feeRatePlainTime(
	rate: number | null | undefined,
	estimates: FeeEstimates | null | undefined
): string | null {
	if (rate == null || !Number.isFinite(rate) || rate < 0 || estimates == null) return null;
	if (rate >= estimates.fastest) return '≈ next block';
	if (rate >= estimates.halfHour) return '≈ 30 min';
	if (rate >= estimates.hour) return '≈ 1 hour';
	if (rate >= estimates.economy) return 'a few hours';
	return 'a long wait';
}

/**
 * Splits a rate (or a min–max range) into number + unit display parts so call
 * sites can style them independently ("2.5" + "sat/vB"). Null when there is
 * nothing honest to show — the component renders a plain dash then, with no
 * gloss (a tooltip explaining a unit that isn't on screen would be noise).
 */
export function feeRateParts(
	rate: number | null | undefined,
	range: [number, number] | null | undefined
): { num: string; unit: string } | null {
	if (range != null) return { num: `${range[0]}–${range[1]}`, unit: 'sat/vB' };
	if (rate == null) return null;
	const text = formatFeeRate(rate);
	if (!text.endsWith(' sat/vB')) return null; // "—" for null/unknown
	return { num: text.slice(0, -' sat/vB'.length), unit: 'sat/vB' };
}
