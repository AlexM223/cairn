// Whether to OFFER the "Speed up" (RBF/CPFP) control for an unconfirmed
// inflow. Pure and shared between server (the explorer tx-detail "Speed this
// up" CTA index, ownership.server.ts) and client (the wallet/multisig detail
// pages' inline Speed up button + form) so the three call sites can never
// drift apart on when a broken control would be offered.
//
// cairn-iare: CPFP needs the stuck parent's own network fee to price the
// child (feeBump.ts's cpfpChildFee); when Core can't resolve it (some prevout
// wasn't decorated — see toTxDetailFromCore in chain/index.ts), the parent's
// fee genuinely CANNOT be computed, and executeCpfpDraft's CpfpError
// 'parent_fee_unknown' fires deterministically every time — a retry doesn't
// help, because the same lookup runs again at submit time with the same
// input. Previously the UI offered the button + rate input anyway and only
// surfaced this as a form-error after a failed submit, leaving the broken
// controls sitting right next to their own "can't be computed" apology.
// RBF replacement never reads the parent's fee, so it's unaffected.

/** The subset of `UnconfirmedInflow` (transactions.ts) this predicate needs. */
export interface SpeedUpEligibility {
	action: 'rbf' | 'cpfp';
	parentFeeUnknown: boolean;
}

/** True when the Speed up affordance (button, rate input, or a deep-linked
 *  form) should be offered for this unconfirmed inflow. False only for the
 *  deterministically-impossible case above — a transient lookup failure
 *  leaves `parentFeeUnknown` false (see transactions.ts) and still offers
 *  the control, since a submit-time retry there has a fair shot. */
export function canOfferSpeedUp(inflow: SpeedUpEligibility): boolean {
	return inflow.action !== 'cpfp' || !inflow.parentFeeUnknown;
}
