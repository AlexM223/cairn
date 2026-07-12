// Pure copy + fee-speed maps shared by the send redesign (cairn-krwp).
// No UI, no server contract — just the strings and the tier→ETA mapping so
// FeeSpeedPicker and SendReviewCard read from one source of truth.
import type { FeeEstimates } from '$lib/types';

/** The three named speeds shown as the primary fee control. Custom lives
 *  behind the Advanced disclosure and is not in this list. `tier` maps each
 *  speed onto a FeeEstimates field. */
export const FEE_SPEEDS = [
	{ key: 'priority', name: 'Priority', eta: 'about 10 minutes', tier: 'fastest' },
	{ key: 'standard', name: 'Standard', eta: 'about 30 minutes', tier: 'halfHour' },
	{ key: 'economy', name: 'Economy', eta: 'an hour or more', tier: 'economy' }
] as const satisfies ReadonlyArray<{
	key: string;
	name: string;
	eta: string;
	tier: keyof FeeEstimates;
}>;

export type FeeSpeedKey = (typeof FEE_SPEEDS)[number]['key'];
export type FeeChoiceKey = FeeSpeedKey | 'custom';

/** Plain-language arrival estimate for the chosen fee tier. Custom can't be
 *  pinned to a duration, so it reads as a mempool-dependent time. */
export function arrivalWords(choice: FeeChoiceKey): string {
	switch (choice) {
		case 'priority':
			return 'about 10 minutes';
		case 'standard':
			return 'about 30 minutes';
		case 'economy':
			return 'an hour or more';
		default:
			return 'a time that depends on the mempool';
	}
}

/** The one plain-language summary sentence at the top of the review card.
 *  Single vs batch vs multisig variants — multisig replaces the arrival tail
 *  with the signature-collection context (arrival is dominated by signing
 *  time, which lands in the fee line instead). */
export function summarySentence(p: {
	amountText: string;
	recipientText: string;
	arrivalWords: string;
	isBatch: boolean;
	recipientCount: number;
	multisig: { threshold: number; keysTotal: number } | null;
}): string {
	const lead = p.isBatch
		? `You're sending ${p.amountText} across ${p.recipientCount} recipients.`
		: `You're sending ${p.amountText} to ${p.recipientText}.`;
	if (p.multisig) {
		return `${lead} This payment needs ${p.multisig.threshold} of ${p.multisig.keysTotal} signatures before it's sent.`;
	}
	return `${lead} It should arrive in ${p.arrivalWords}.`;
}
