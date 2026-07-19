// The create step's top-level gate (cairn-gt05.2, spec §2.3): a zero-balance
// wallet gets a real empty state ("This wallet is empty. Add bitcoin before you
// can send.") with one primary Receive CTA — never the old bare "0" wall.
// Pure decision logic, unit-tested in createGate.test.ts.

export type SendCreateGate =
	/** Render the normal amount + recipient form. */
	| 'form'
	/** Wallet is empty (0 spendable, nothing maturing) — show the empty state. */
	| 'empty'
	/** 0 spendable but a coinbase reward is still maturing — say so. */
	| 'maturing';

export function sendCreateGate(p: {
	/** True once the streamed live scan has settled (resolved or degraded). */
	liveLoaded: boolean;
	/** Scan error text, if the node couldn't be reached — the form + its own
	 *  error banner stay up in that case (we don't KNOW the wallet is empty). */
	scanError: string | null;
	/** Confirmed spendable sats; null while unknown. */
	confirmed: number | null;
	/** Sats held back as an immature coinbase (mining reward). */
	maturingTotal: number;
	/** Resuming a saved draft — the wallet had funds when it was built; never
	 *  wall off the resume path. */
	resuming: boolean;
}): SendCreateGate {
	if (p.resuming) return 'form';
	if (!p.liveLoaded || p.scanError !== null) return 'form';
	if (p.confirmed === null || p.confirmed > 0) return 'form';
	return p.maturingTotal > 0 ? 'maturing' : 'empty';
}
