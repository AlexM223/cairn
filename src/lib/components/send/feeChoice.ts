// Pure fee-choice resolution shared by FeeSpeedPicker (cairn-eacw.5). Kept out
// of the .svelte component so the clamp + node-floor logic can be unit-tested
// the same way amountInput.ts / sendCopy.ts are — the component just binds these.
import { formatFeeRate } from '$lib/format';
import type { FeeEstimates } from '$lib/types';
import type { FeeChoiceKey } from './sendCopy';

/**
 * The node's own relay floor (sat/vB) carried in the live estimates payload
 * (cairn-eacw.3/.5) — the minimum fee this node will actually relay. A capable
 * node reports a sub-1 value; when the estimates are missing or the field is
 * absent (older payload, unknown/incapable node) this is 1 sat/vB, the
 * historical network-wide default. A non-positive or non-finite value is treated
 * as the same 1 fallback so the floor can never collapse to zero.
 */
export function nodeFloorFrom(fees: FeeEstimates | null): number {
	const f = fees?.minFeeRate;
	return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : 1;
}

/**
 * The effective sat/vB rate the page hands to build(): the chosen named tier's
 * live value, falling back to the custom box when that tier is unavailable;
 * Custom is clamped UP to the node relay floor (never a hardcoded 1), so a
 * genuinely sub-1 fee is honored on a node that relays it, and a sub-1 entry on
 * an incapable node lands exactly on the 1 sat/vB floor. An empty/zero/NaN custom
 * box falls back to the floor itself.
 */
export function resolveFeeRate(
	choice: FeeChoiceKey,
	customFee: string,
	fees: FeeEstimates | null
): number {
	const floor = nodeFloorFrom(fees);
	const fallback = Number(customFee) || floor;
	if (choice === 'priority') return fees?.fastest ?? fallback;
	if (choice === 'standard') return fees?.halfHour ?? fallback;
	if (choice === 'economy') return fees?.economy ?? fallback;
	return Math.max(floor, fallback);
}

/**
 * Plain-language explanation shown when the typed Custom rate sits below the
 * node's floor and is therefore being clamped up — null when there's nothing to
 * explain (not on Custom, or the entry is empty/at/above the floor). Distinguishes
 * an incapable/unknown node (floor exactly 1 — "doesn't relay below 1 sat/vB")
 * from a node with a specific sub-1 or elevated floor.
 */
export function belowFloorMessage(
	choice: FeeChoiceKey,
	customFee: string,
	fees: FeeEstimates | null
): string | null {
	if (choice !== 'custom') return null;
	const floor = nodeFloorFrom(fees);
	const typed = Number(customFee);
	if (!Number.isFinite(typed) || typed <= 0 || typed >= floor) return null;
	if (floor === 1) {
		return "Your Bitcoin node doesn't relay fees below 1 sat/vB, so this will use 1 sat/vB.";
	}
	return `Your node relays down to ${formatFeeRate(floor)} — this will use that minimum.`;
}
