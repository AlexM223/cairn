// House error-copy standard applied to broadcast rejections (UX-PLAN §5.3
// item 4): every broadcast failure must say what happened (the node's own
// reason, kept verbatim — never hidden), that nothing was sent, and — when
// the reason is one of a handful of well-known cases — a concrete next step.
// Shared between the single-sig (transactions.ts) and multisig
// (multisigTransactions.ts) broadcast paths, which both surface the same
// class of Electrum/Bitcoin Core rejection.

/**
 * Turn a raw Electrum/Bitcoin Core rejection reason into the full
 * user-facing sentence. `raw` is kept verbatim in the message (an operator
 * or an advanced user may recognize node phrasing the hint doesn't cover),
 * it's just never the ONLY thing the user sees.
 */
export function friendlyBroadcastRejection(raw: string): string {
	const hint = rejectionHint(raw);
	return `The Bitcoin network rejected this transaction: ${raw}. Nothing was sent.${hint ? ` ${hint}` : ''}`;
}

/** A short, specific next step for the handful of rejection reasons common
 *  enough to name — `null` when nothing more specific than "nothing was
 *  sent" can honestly be said. */
function rejectionHint(raw: string): string | null {
	const r = raw.toLowerCase();
	if (r.includes('dust')) {
		return 'The amount is below the dust limit — send a little more.';
	}
	if (r.includes('min relay fee') || r.includes('insufficient fee') || r.includes('fee not met')) {
		return 'The fee rate is too low for the network to relay it right now — try again with a higher fee.';
	}
	if (r.includes('already in mempool') || r.includes('txn-already-in-mempool')) {
		return "This transaction is already waiting to confirm — there's no need to resend it.";
	}
	if (r.includes('missingorspent') || r.includes('already spent') || r.includes('conflict')) {
		return 'One of the coins it spends looks like it was already spent elsewhere — refresh and try again.';
	}
	if (r.includes('non-final') || r.includes('non-bip68-final')) {
		return "This transaction isn't valid to broadcast yet — try again in a moment.";
	}
	return null;
}
