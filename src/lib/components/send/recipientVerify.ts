// R2 — stake-triggered recipient verification (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md,
// finding F4: warnings habituate within two exposures, so any extra check must stay RARE
// and reserved for genuinely unusual sends; finding F5: bech32 checksums catch typos, not
// wrong-pastes, so recognition-based address comparison is the real defense).
//
// Pure decision logic only — no UI, no fetches. SendReviewCard consumes this to decide
// whether to show the "verify the last 4 characters" micro-step; the send pages compute
// the inputs (known addresses, wallet balance) from data they already load.

/**
 * Flat sats floor: any send at or above this is "big enough to hurt" regardless of the
 * wallet's size — protects a wallet whose balance is still streaming in (balanceSats is
 * null) and a wallet so large that 10% of it would be an absurd bar. 100,000 sats is
 * roughly a week's discretionary spend at typical 2026 prices — high enough that routine
 * small/test sends never trip it, low enough that a life-meaningful mis-send does.
 */
export const STAKE_FLAT_THRESHOLD_SATS = 100_000;

/**
 * Relative floor: a send at/above this share of the wallet's OWN spendable balance is
 * high-stakes for that wallet even if it's under the flat floor above — a 90,000-sat send
 * from a 100,000-sat wallet is nearly the whole stack. Deliberately much lower than R1's
 * 50%-of-balance "that's most of this wallet's balance" note (amountInput.ts isHighSpend)
 * — R2 is a recognition aid triggered by *stakes*, not a balance-drain warning, so it
 * should catch a meaningfully large first-send well before it reaches "most of the wallet".
 */
export const STAKE_BALANCE_FRACTION = 0.1;

/** True when `amountSats` clears either the flat or the balance-relative stake floor. */
export function isHighStakeAmount(amountSats: number, balanceSats: number | null): boolean {
	if (amountSats <= 0) return false;
	if (amountSats >= STAKE_FLAT_THRESHOLD_SATS) return true;
	if (balanceSats != null && balanceSats > 0 && amountSats >= balanceSats * STAKE_BALANCE_FRACTION) {
		return true;
	}
	return false;
}

/** True when `address` is NOT in `knownAddresses` (prior completed sends + saved contacts). */
export function isFirstSendToAddress(
	address: string,
	knownAddresses: ReadonlySet<string> | readonly string[]
): boolean {
	const set = knownAddresses instanceof Set ? knownAddresses : new Set(knownAddresses);
	return !set.has(address);
}

export interface ShouldVerifyArgs {
	address: string;
	amountSats: number;
	/** This wallet's spendable balance; null while unknown/streaming (the flat floor still applies). */
	balanceSats: number | null;
	/** Addresses this wallet has already paid (broadcast history) or saved as a contact. */
	knownAddresses: ReadonlySet<string> | readonly string[];
	/**
	 * Batch sends (multiple recipients) never trigger — there is no single "the recipient" to
	 * spot-check, and forcing a per-row micro-step would turn a rare aid into a routine ritual
	 * (the exact habituation failure mode F4 warns against).
	 */
	isBatch: boolean;
}

/**
 * The single gate SendReviewCard calls: stake-triggered AND first-send AND single-recipient.
 * Both (a) and (b) must hold — routine repeat sends, saved contacts, and small test sends all
 * skip the micro-step, keeping it rare by construction rather than by tuning after the fact.
 */
export function shouldVerifyRecipient(args: ShouldVerifyArgs): boolean {
	if (args.isBatch) return false;
	if (!isFirstSendToAddress(args.address, args.knownAddresses)) return false;
	return isHighStakeAmount(args.amountSats, args.balanceSats);
}

/** Last 4 characters of an address, case-folded — what the micro-step asks the user to retype. */
export function addressTail(address: string, chars = 4): string {
	return address.slice(-chars).toLowerCase();
}

/** Case/whitespace-insensitive match against `addressTail` — a recognition check, not a
 *  strict-case crypto verification, so we forgive case/whitespace the way a human retyping
 *  4 characters naturally would. */
export function matchesAddressTail(input: string, address: string, chars = 4): boolean {
	return input.trim().toLowerCase() === addressTail(address, chars);
}
