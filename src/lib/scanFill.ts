// Pure "what does a scanned/pasted destination write into a recipient row"
// decision, shared by every send destination field (RecipientCombobox.svelte
// for single-sig, and the multisig send page's plain address input) — see
// QR-SCAN-DESIGN.md Wave 3 and send-affordances-progress.md.
//
// Split out as a plain module (not inlined in a .svelte file) so it's
// unit-testable: this repo's vitest config has no Svelte plugin, so only
// plain .ts modules get real test coverage (same reasoning as
// qrScannerLogic.ts).
import { parseBip21 } from './bip21';

export interface ScanFillResult {
	/** Always set — the address to write into the field. */
	address: string;
	/**
	 * Sats to prefill into the amount field, or `null` when the fill should
	 * leave the amount untouched. Null in two cases: the scanned/pasted text
	 * carried no BIP21 `amount=`, OR the row already has non-empty amount
	 * text. The second case is deliberate — a scan/paste must never clobber
	 * an amount the user already typed (see send-affordances-progress.md's
	 * amount-autofill decision). The caller decides whether/how to apply a
	 * non-null value (e.g. skip it in "Max" mode, convert units).
	 */
	amountSats: number | null;
}

/**
 * Resolve a scanned/pasted destination string (bare address or `bitcoin:`
 * BIP21 URI) into what a recipient row should show. Returns `null` when the
 * text isn't a recognized address/payment at all (caller keeps whatever it
 * had, or — for a raw clipboard paste — may fall back to writing the raw
 * text so the existing address-shape hint can explain why it's invalid).
 */
export function resolveScanFill(rawText: string, currentAmountText: string): ScanFillResult | null {
	const payment = parseBip21(rawText);
	if (!payment) return null;

	const amountSats =
		payment.amountSats !== undefined && payment.amountSats > 0 && currentAmountText.trim().length === 0
			? payment.amountSats
			: null;

	return { address: payment.address, amountSats };
}
