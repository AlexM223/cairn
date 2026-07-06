// Parse a ColdCard "Generic JSON" wallet export for a SINGLE-SIG wallet
// (Advanced/Tools → Export Wallet → Generic JSON → coldcard-export.json on the
// microSD card). Sibling to the multisig wizard's parseColdcardExport, which
// reads the multisig sub-accounts (bip48_1/bip48_2). Single-sig keys live under
// the flat bip44 (legacy), bip49 (nested segwit), bip84 (native segwit) and
// bip86 (taproot) sections instead — a different, simpler shape, so this is a
// separate, clearly-named parser rather than a branch of the multisig one.
//
// The export's real structure, confirmed against ColdCard firmware
// (shared/export.py generate_generic_export):
//
//   {
//     "chain":   "BTC",
//     "xfp":     "0F056943",              // master fingerprint (top level)
//     "account": 0,
//     "xpub":    "xpub…",                 // the master xpub
//     "bip44":   { "name": "p2pkh",       "xfp": "…", "deriv": "m/44h/0h/0h",
//                  "xpub": "xpub…", "desc": "…", "first": "1…" },
//     "bip49":   { "name": "p2sh-p2wpkh", "xfp": "…", "deriv": "m/49h/0h/0h",
//                  "xpub": "xpub…", "_pub": "ypub…", "desc": "…", "first": "3…" },
//     "bip84":   { "name": "p2wpkh",      "xfp": "…", "deriv": "m/84h/0h/0h",
//                  "xpub": "xpub…", "_pub": "zpub…", "desc": "…", "first": "bc1…" },
//     "bip86":   { … taproot, on firmware that exports it … },
//     "bip48_1": { … }, "bip48_2": { … }  // multisig — handled by the other parser
//   }
//
// We take the classic `xpub` (never `_pub`): Cairn canonicalizes everything to
// the standard xpub prefix downstream, and the SLIP-132 `_pub` is only a
// labeling convention.

import type { ScriptType } from '$lib/types';

export interface ColdcardKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

const NOT_EXPORT_MSG =
	"That file doesn't look like the ColdCard wallet export. On the ColdCard choose " +
	'Advanced/Tools → Export Wallet → Generic JSON, then upload coldcard-export.json from the microSD card.';

/** Cairn ScriptType → the export's single-sig section key + default path. */
const SECTION: Record<ScriptType, { key: string; label: string; defaultPath: string }> = {
	p2pkh: { key: 'bip44', label: 'Legacy', defaultPath: "m/44'/0'/0'" },
	'p2sh-p2wpkh': { key: 'bip49', label: 'Nested SegWit', defaultPath: "m/49'/0'/0'" },
	p2wpkh: { key: 'bip84', label: 'Native SegWit', defaultPath: "m/84'/0'/0'" },
	p2tr: { key: 'bip86', label: 'Taproot', defaultPath: "m/86'/0'/0'" }
};

/** ColdCard writes hardened elements as `h` (m/84h/0h/0h); normalize to `'`. */
function normalizePath(deriv: string): string {
	return deriv.trim().replace(/h/gi, "'");
}

/**
 * Extract the single-sig account key for `scriptType` from a ColdCard Generic
 * JSON export. Returns { xpub, fingerprint, path } — the same shape the wizard
 * stores. The master fingerprint comes from the section's own `xfp` when
 * present, else the top-level `xfp`; anything non-hex becomes the "00000000"
 * placeholder (a key with no fingerprint on record still signs via the file
 * fallback).
 */
export function parseColdcardSingleSigExport(text: string, scriptType: ScriptType): ColdcardKey {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new Error(NOT_EXPORT_MSG);
	}
	if (typeof doc !== 'object' || doc === null) throw new Error(NOT_EXPORT_MSG);
	const root = doc as Record<string, unknown>;

	const { key: section, label, defaultPath } = SECTION[scriptType];
	const node = root[section];
	if (typeof node !== 'object' || node === null) {
		// bip86 in particular is absent on older ColdCard firmware — give the user
		// the concrete reason rather than the generic "not an export" message.
		throw new Error(
			`This ColdCard export has no ${label} (${section}) key. ` +
				(scriptType === 'p2tr'
					? 'Taproot single-sig export needs current ColdCard firmware — update it, or choose a different address type.'
					: 'Make sure the ColdCard firmware is current and you chose Generic JSON (single-sig).')
		);
	}
	const entry = node as Record<string, unknown>;

	// Prefer the classic xpub; Cairn normalizes SLIP-132 downstream, so never _pub.
	const xpub = typeof entry.xpub === 'string' ? entry.xpub : null;
	if (!xpub) throw new Error(NOT_EXPORT_MSG);

	const rawFp =
		typeof entry.xfp === 'string' ? entry.xfp : typeof root.xfp === 'string' ? root.xfp : '';
	const fingerprint = /^[0-9a-fA-F]{8}$/.test(rawFp) ? rawFp.toLowerCase() : '00000000';

	const path =
		typeof entry.deriv === 'string' && entry.deriv.trim()
			? normalizePath(entry.deriv)
			: defaultPath;

	return { xpub, fingerprint, path };
}
