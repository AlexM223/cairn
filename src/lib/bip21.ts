// BIP21 payment-URI parsing (`bitcoin:<address>?amount=&label=&message=`).
//
// This is the one genuinely new piece of logic the QR-scanning design needs
// (see QR-SCAN-DESIGN.md §1.7/§5): a scanned address QR from another wallet is
// usually a BIP21 URI, not a bare address, and nothing in the repo parsed one
// before this. Pure and dependency-free — the client only ever shape-gates;
// authoritative address validation stays server-side
// (`src/lib/server/bitcoin/xpub.ts`'s `isValidAddress`, which a client
// component may not import).
//
// Also accepts a BARE address (no `bitcoin:` scheme) as a degenerate payment
// with no amount/label/message, using the same shape the rest of the app
// already treats as address-like (`send/+page.svelte:180`'s `looksLikeAddress`
// regex, duplicated here since that file isn't an importable module).

export interface Bip21Payment {
	address: string;
	amountSats?: number;
	label?: string;
	message?: string;
}

// Mirrors `looksLikeAddress` in send/+page.svelte:180 — a client shape-gate
// only (legacy P2PKH/P2SH `1`/`3`, or bech32/bech32m `bc1`/`BC1`, all-caps
// allowed since that's how a QR's alphanumeric mode encodes it). Not
// authoritative; the server re-validates whatever this accepts.
const BARE_ADDRESS_RE = /^(bc1|BC1|[13])[a-zA-HJ-NP-Z0-9]{6,90}$/;

const SCHEME_RE = /^bitcoin:/i;

/**
 * Parse a scanned/pasted string as a BIP21 payment URI, or as a bare address.
 * Returns `null` for anything else (junk, an unrelated URI, empty input).
 *
 * Ignores `pj=` (payjoin) and BIP70 `r=` — no payjoin/BIP70 machinery exists
 * in this repo, so those params are neither surfaced nor required.
 */
export function parseBip21(raw: string): Bip21Payment | null {
	const text = raw.trim();
	if (!text) return null;

	if (!SCHEME_RE.test(text)) {
		// Not a `bitcoin:` URI — accept it only if it's a bare address.
		return BARE_ADDRESS_RE.test(text) ? { address: text } : null;
	}

	// Strip the scheme. `bitcoin:` is an opaque-path scheme (no `//`
	// authority), so what remains is `<address>[?query]` — but tolerate a
	// stray `//` some generators mistakenly include.
	let rest = text.slice(text.indexOf(':') + 1);
	if (rest.startsWith('//')) rest = rest.slice(2);

	const qIndex = rest.indexOf('?');
	const addressPart = qIndex === -1 ? rest : rest.slice(0, qIndex);
	const query = qIndex === -1 ? '' : rest.slice(qIndex + 1);

	let address: string;
	try {
		address = decodeURIComponent(addressPart);
	} catch {
		return null; // malformed percent-encoding
	}
	if (!BARE_ADDRESS_RE.test(address)) return null;

	const result: Bip21Payment = { address };

	if (query) {
		// Param KEYS are looked up case-insensitively: some wallets emit an
		// all-uppercase BIP21 URI so it fits a QR's alphanumeric encoding mode,
		// which uppercases the param names too (`AMOUNT=`, `LABEL=`). Values
		// are left exactly as URLSearchParams decodes them (it already turns
		// `+` into a space and unescapes `%XX`).
		const parsed = new URLSearchParams(query);
		const byLowerKey = new Map<string, string>();
		for (const [k, v] of parsed) {
			if (!byLowerKey.has(k.toLowerCase())) byLowerKey.set(k.toLowerCase(), v);
		}

		const amountStr = byLowerKey.get('amount');
		if (amountStr !== undefined) {
			const sats = btcStringToSats(amountStr);
			if (sats !== null) result.amountSats = sats;
		}

		const label = byLowerKey.get('label');
		if (label) result.label = label;

		const message = byLowerKey.get('message');
		if (message) result.message = message;
	}

	return result;
}

/**
 * Convert a decimal BTC amount string (as found in a BIP21 `amount=` param)
 * to an integer satoshi count. String-based (not `parseFloat`) to avoid
 * floating-point drift on the fraction. Returns null for anything that isn't
 * a plain non-negative decimal, or that specifies sub-satoshi precision.
 */
function btcStringToSats(amount: string): number | null {
	if (!/^\d+(\.\d+)?$/.test(amount)) return null;
	const [whole, frac = ''] = amount.split('.');
	if (frac.length > 8) return null; // more precision than a satoshi allows
	const fracPadded = frac.padEnd(8, '0');
	const sats = Number(whole) * 1e8 + Number(fracPadded);
	return Number.isSafeInteger(sats) ? sats : null;
}
