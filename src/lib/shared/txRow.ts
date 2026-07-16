// Pure helpers for the wallet-detail transaction row (single-sig and
// multisig detail pages share this exact row shape). Kept isomorphic and
// testable rather than inline template conditionals, matching this repo's
// convention for anything with real decision logic (see coinbase.ts,
// speedUp.ts).

/** The row fields these helpers need — satisfied by both WalletTx and
 *  MultisigTx (see $lib/types and multisigScan.ts). */
export interface TxRowAmounts {
	/** Net change to THIS wallet: sum of our own outputs minus our own
	 *  inputs. The single authoritative "what this tx means for this
	 *  wallet" figure (positive = received, negative = sent). */
	delta: number;
	/** The WHOLE transaction's network fee (every input minus every output,
	 *  not just this wallet's share — see gapLimitScanner's txDeltaFromRaw).
	 *  null when it couldn't be resolved (some prevout wasn't decorated). */
	fee: number | null;
}

/**
 * Whether the row should break out its "network fee" meta line (cairn-jcwb).
 *
 * The fee is the SENDER's cost on an incoming (delta >= 0) transaction — it
 * says nothing about what this wallet received, and displaying it right next
 * to "Received" reads as a second, competing amount on the same row (see
 * DESIGN-MANIFESTO/UX-REDESIGN-SPEC's "one hero number, never a competing
 * figure" rule, applied here at row scope). On an outgoing (delta < 0)
 * transaction the fee genuinely came out of this wallet, alongside the
 * recipient amount, so it's worth surfacing as a labeled secondary detail.
 */
export function shouldShowNetworkFee(tx: TxRowAmounts): boolean {
	return tx.fee != null && tx.delta < 0;
}
