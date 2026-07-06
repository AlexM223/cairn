// Key-origin presence check shared by the file-round-trip signers.
//
// Cairn's PSBT builder (src/lib/server/bitcoin/psbt.ts) only attaches
// bip32Derivation when the wallet has a recorded master fingerprint — a bare
// xpub import produces PSBTs without it. Hardware signers match inputs to
// their own keys via that key-origin data, so a ColdCard / SeedSigner /
// Passport handed such a PSBT will refuse to (or be unable to) sign. The
// connected signers (Ledger, Trezor) already fail fast in their drivers; the
// air-gapped flows have no driver step before the physical round trip, so
// their UI uses this check to warn *before* the user walks an SD card or a
// QR dance to a predictable dead end.

import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';

/**
 * True iff the PSBT parses, has inputs, and every input carries at least one
 * key-origin entry (bip32Derivation, or tapBip32Derivation for taproot).
 * False means a signing device cannot identify the inputs as its own —
 * callers should steer the user to the generic file method.
 */
export function psbtHasKeyOrigin(unsignedPsbtBase64: string): boolean {
	let tx: Transaction;
	try {
		tx = Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch {
		return false;
	}
	if (tx.inputsLength === 0) return false;
	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		const legacy = input.bip32Derivation?.length ?? 0;
		const taproot = input.tapBip32Derivation?.length ?? 0;
		if (legacy + taproot === 0) return false;
	}
	return true;
}
