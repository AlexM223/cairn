export type AddressShape = 'empty' | 'mainnet' | 'testnet' | 'unknown';

// Mainnet only — the authoritative check still happens server-side, this is a
// pre-flight shape hint. bech32/bech32m (bc1...) plus legacy P2PKH (1...) and
// P2SH (3...). bech32 is valid all-uppercase too (the QR-code form).
const MAINNET_RE = /^(bc1|BC1|[13])[a-zA-HJ-NP-Z0-9]{6,90}$/;

// Test networks. bech32: testnet/signet (tb1...) and regtest (bcrt1...).
const TESTNET_BECH32_RE = /^(tb1|TB1|bcrt1|BCRT1)[a-zA-HJ-NP-Z0-9]{6,90}$/;
// Legacy: testnet/signet/regtest P2PKH (m.../n...) and P2SH (2...). Base58
// alphabet (no 0 O I l), plausible address length so short garbage that merely
// starts with m/n/2 isn't mistaken for a real test-network address.
const TESTNET_LEGACY_RE = /^[mn2][a-km-zA-HJ-NP-Z1-9]{24,42}$/;

/**
 * Classify what a recipient string *looks* like, so the send form can give a
 * distinct wrong-network message instead of lumping a valid testnet/regtest
 * address in with random garbage (cairn-a8n7). This is a shape hint only; the
 * server does the authoritative validation.
 */
export function classifyRecipientAddress(input: string): AddressShape {
	const a = input.trim();
	if (a.length === 0) return 'empty';
	if (MAINNET_RE.test(a)) return 'mainnet';
	if (TESTNET_BECH32_RE.test(a) || TESTNET_LEGACY_RE.test(a)) return 'testnet';
	return 'unknown';
}

/** True only for well-shaped mainnet addresses (unchanged legacy contract). */
export const looksLikeAddress = (a: string) => classifyRecipientAddress(a) === 'mainnet';
