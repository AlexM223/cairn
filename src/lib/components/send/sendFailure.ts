// Retry-safety copy for every send/broadcast failure surface (cairn-gt05.7).
//
// The rules, from the bead:
//  - Every failure states the FUND STATE in plain words: nothing left the
//    wallet, and trying again is safe. Never a bare "failed".
//  - Non-accusatory: name WHOSE layer failed ("this is the connection to your
//    node — not your bitcoin, and not something you did"), never imply user
//    error.
//  - Transient vs needs-a-change framing, with one concrete next step.
//  - The draft is always preserved by the caller (the send page never dumps the
//    user back to an empty create screen on failure) — this module only owns
//    the words.
//
// Pure copy, no UI, no fetches — unit-tested in sendFailure.test.ts. Uses the
// EXISTING error/attention surfaces only (Banner variant="error", .form-error);
// no new color taxonomy (that decision is parked).

export type SendFailureKind =
	/** The node relayed our request but the Bitcoin network refused the tx. */
	| 'broadcast-rejected'
	/** Could not reach Heartwood / the node to broadcast at all. */
	| 'broadcast-unreachable'
	/** The server reported a broadcast error (message passed through). */
	| 'broadcast-error'
	/** Could not reach Heartwood to attach a signed transaction. */
	| 'attach-unreachable'
	/** The signed transaction was refused (guard mismatch / bad signature). */
	| 'attach-rejected';

export interface SendFailureCopy {
	/** What happened, one sentence. */
	headline: string;
	/** The fund-state sentence — always present, always plain. */
	fundState: string;
	/** Whose layer failed, non-accusatory. Null when the headline already says. */
	layer: string | null;
	/** The one concrete next step. */
	nextStep: string;
	/** True = transient (retry as-is is the fix); false = needs a change first. */
	transient: boolean;
}

/** The load-bearing sentence every failure surface must carry. */
export const FUNDS_SAFE =
	'This payment was not sent. Nothing left your wallet — your draft is saved, and you can safely try again.';

const CONNECTION_LAYER =
	'This is the connection to your node — not your bitcoin, and not something you did.';

export function sendFailureCopy(
	kind: SendFailureKind,
	serverMessage?: string | null
): SendFailureCopy {
	switch (kind) {
		case 'broadcast-rejected':
			return {
				headline: serverMessage?.trim() || 'The network refused this transaction.',
				fundState: FUNDS_SAFE,
				layer:
					"That verdict came from the Bitcoin network's rules — not your bitcoin, and not something you did.",
				nextStep:
					'This draft usually needs a change before the network will take it — rebuild it with a fresh fee, or re-sign it, and send again.',
				transient: false
			};
		case 'broadcast-unreachable':
			return {
				headline: 'Could not reach your node to broadcast.',
				fundState: FUNDS_SAFE,
				layer: CONNECTION_LAYER,
				nextStep:
					'Check that your node is running, then press send again — retrying the same draft is safe and can never pay twice.',
				transient: true
			};
		case 'broadcast-error':
			return {
				headline: serverMessage?.trim() || 'Broadcast failed.',
				fundState: FUNDS_SAFE,
				layer: null,
				nextStep: 'The draft is unchanged — you can safely try again.',
				transient: true
			};
		case 'attach-unreachable':
			return {
				headline: 'Could not reach Heartwood to attach the signed transaction.',
				fundState: FUNDS_SAFE,
				layer: CONNECTION_LAYER,
				nextStep:
					'Your signature is still on your device or in the file — attach it again once the connection is back.',
				transient: true
			};
		case 'attach-rejected':
			return {
				headline: serverMessage?.trim() || 'That signed transaction could not be attached.',
				fundState: FUNDS_SAFE,
				layer: null,
				nextStep:
					'Sign the draft again from this page and bring the fresh signature back — the draft you reviewed is unchanged.',
				transient: false
			};
	}
}

/** One-string form for surfaces that render a single text node (.form-error). */
export function sendFailureText(kind: SendFailureKind, serverMessage?: string | null): string {
	const c = sendFailureCopy(kind, serverMessage);
	return [c.headline, c.fundState, c.layer, c.nextStep].filter(Boolean).join(' ');
}
