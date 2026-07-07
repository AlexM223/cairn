// Key-origin helpers shared by the wallet wizard and the file-round-trip
// signers.
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
//
// The parsing half (parseKeyOriginInput and friends) exists because the fix
// for that dead end is capturing the key origin AT IMPORT TIME (cairn-alw8):
// many wallets export keys in descriptor form — `[73c5da0a/84'/0'/0']zpub…`,
// possibly wrapped in wpkh(…) with a /<0;1>/* suffix — so the wizard accepts
// that whole string in the key field and pulls the origin out of it. This
// module is importable from both client (wizard) and server (createWallet).

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

// ------------------------------------------------- key-origin input parsing

/**
 * Normalize a master fingerprint to 8 lowercase hex characters. Returns null
 * for anything else — including the all-zero "00000000" placeholder some
 * exports (and Cairn's own ColdCard parser) use for "unknown": storing zeros
 * as if they were real would send hardware signers hunting for a key that
 * doesn't exist, which is worse than honestly having none.
 */
export function normalizeFingerprint(raw: unknown): string | null {
	const v = String(raw ?? '').trim().toLowerCase();
	if (!/^[0-9a-f]{8}$/.test(v)) return null;
	if (v === '00000000') return null;
	return v;
}

const MAX_CHILD_INDEX = 0x80000000; // 2^31 — hardened flag boundary

/**
 * Normalize a derivation path to canonical `m/84'/0'/0'` form. Accepts `h`/`H`
 * hardened markers, an optional leading `m/` (or bare `m`), and tolerates
 * surrounding whitespace. Returns null for anything that doesn't parse — a
 * malformed path embedded in a PSBT would break signing later, so it's
 * rejected up front instead of stored.
 */
export function normalizeOriginPath(raw: unknown): string | null {
	let v = String(raw ?? '').trim();
	if (!v) return null;
	if (v === 'm') return null; // the master key itself is not an account origin
	v = v.replace(/^m\//i, '');
	const out: string[] = [];
	for (const part of v.split('/')) {
		const m = /^(\d+)(['hH])?$/.exec(part.trim());
		if (!m) return null;
		const n = parseInt(m[1], 10);
		if (!Number.isInteger(n) || n >= MAX_CHILD_INDEX) return null;
		out.push(m[2] ? `${n}'` : String(n));
	}
	return out.length ? `m/${out.join('/')}` : null;
}

export interface ParsedKeyOriginInput {
	/** The bare extended key, with any wrapper/origin/suffix stripped. */
	xpub: string;
	/** 8 lowercase hex chars, or null when absent/unusable. */
	fingerprint: string | null;
	/** Canonical `m/84'/0'/0'` form, or null when absent/unusable. */
	path: string | null;
}

/**
 * Pull an extended public key and (when present) its key origin out of the
 * many shapes wallets export keys in:
 *
 *   zpub6rFR7y4…                                        (bare key)
 *   [73c5da0a/84'/0'/0']zpub6rFR7y4…                    (key-origin form)
 *   [73c5da0a/84h/0h/0h]xpub6CatW…/0/*                  (h-hardened + suffix)
 *   wpkh([73c5da0a/84'/0'/0']xpub…/<0;1>/*)#checksum    (full descriptor)
 *
 * Lenient by design: an unusable fingerprint or path simply comes back null —
 * the xpub itself is still returned and gets real validation downstream
 * (parseXpub). Callers that collected the origin from a trusted source
 * (device read, ColdCard export) should pass it explicitly instead.
 */
export function parseKeyOriginInput(raw: string): ParsedKeyOriginInput {
	let s = String(raw ?? '').trim();
	// Descriptor checksum: `…#8yg7wpms`.
	s = s.replace(/#[a-z0-9]{8}$/i, '').trim();
	// Unwrap script-function forms, innermost-first: wpkh(…), sh(wpkh(…)), tr(…).
	for (let m = /^[a-z]+\((.*)\)$/i.exec(s); m; m = /^[a-z]+\((.*)\)$/i.exec(s)) {
		s = m[1].trim();
	}

	let fingerprint: string | null = null;
	let path: string | null = null;
	const origin = /^\[([^\]]*)\]/.exec(s);
	if (origin) {
		s = s.slice(origin[0].length).trim();
		const inner = origin[1].trim();
		const slash = inner.indexOf('/');
		fingerprint = normalizeFingerprint(slash === -1 ? inner : inner.slice(0, slash));
		if (slash !== -1) path = normalizeOriginPath(inner.slice(slash + 1));
	}

	// Drop any derivation suffix after the key: /0/*, /<0;1>/*, /0/5 …
	s = s.replace(/\/.*$/, '').trim();

	return { xpub: s, fingerprint, path };
}
