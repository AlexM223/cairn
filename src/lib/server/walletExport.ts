// Single-sig wallet export artifacts: the plain-text output-descriptor backup.
// Pure functions of the wallet row (xpub, script type, key origin) — no
// network, no clock — so the descriptor is byte-deterministic and testable.
// Mirrors multisigExport.ts (descriptorBackup) for the single-sig case.
//
// PRIVACY BOUNDARY (cairn-fdlf.3): these artifacts embed the wallet's
// SINGLE-SIG derivation path (e.g. m/84'/0'/0'), which reveals the account
// structure of the user's personal wallet. They are OWNER-facing backups
// only — never feed them into any cosigner/contact/sharing surface. What a
// cosigner may receive is defined in multisigShares.ts
// (redactMultisigKeysForViewer's standing-rule comment): multisig-purpose
// (45'/48') path data only, single-sig paths never by default.

import { descriptorChecksum } from './bitcoin/multisig';
import { DEFAULT_ORIGIN_PATH } from './bitcoin/psbt';
import type { ScriptType } from '$lib/types';

/**
 * Filename-safe slug for a Content-Disposition `filename="..."` value: lowercase,
 * each run of non-[a-z0-9] collapsed to one '-', leading/trailing dashes trimmed,
 * capped at 48 chars, with a fallback when nothing usable survives. This is a
 * security boundary, not just cosmetics: neutralizing quotes, CRLF, path
 * separators and unicode is what stops a wallet name from breaking out of the
 * header (Content-Disposition header injection). It lives here once — every
 * wallet-export route imports it — so the sanitizer can't silently diverge in a
 * single copy and reopen the injection path (cairn-i5h3).
 */
export function filenameSlug(name: string, fallback = 'wallet'): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || fallback
	);
}

/** Descriptor wrapper per script type: how the account key expression is
 *  wrapped into a scriptPubKey descriptor.
 *   p2pkh        pkh(KEY)          1…      (legacy)
 *   p2sh-p2wpkh  sh(wpkh(KEY))     3…      (wrapped segwit)
 *   p2wpkh       wpkh(KEY)         bc1q…   (native segwit, the common default)
 *   p2tr         tr(KEY)           bc1p…   (taproot) */
function wrap(scriptType: ScriptType, key: string): string {
	switch (scriptType) {
		case 'p2pkh':
			return `pkh(${key})`;
		case 'p2sh-p2wpkh':
			return `sh(wpkh(${key}))`;
		case 'p2wpkh':
			return `wpkh(${key})`;
		case 'p2tr':
			return `tr(${key})`;
	}
}

/** Plain-English label for the backup header. */
const SCRIPT_LABEL: Record<ScriptType, string> = {
	p2pkh: 'Legacy (P2PKH)',
	'p2sh-p2wpkh': 'Wrapped SegWit (P2SH-P2WPKH)',
	p2wpkh: 'Native SegWit (P2WPKH)',
	p2tr: 'Taproot (P2TR)'
};

/** Normalize an origin path to descriptor `h`-hardening (`m/84'/0'/0'` →
 *  `84h/0h/0h`, leading `m/` stripped) — the same convention every other
 *  descriptor in the codebase emits. */
function originPath(path: string): string {
	return path
		.trim()
		.replace(/^m\//i, '')
		.replace(/[’']/g, 'h')
		.replace(/H/g, 'h');
}

export interface WalletDescriptorInput {
	name: string;
	xpub: string;
	scriptType: ScriptType;
	/** Master key fingerprint (8 hex), or null when the origin isn't known. */
	masterFingerprint: string | null;
	/** Account origin path (e.g. "m/84'/0'/0'"), or null → the script-type default. */
	derivationPath: string | null;
}

/**
 * Build the receive (/0/*) and change (/1/*) output descriptors for a single-sig
 * wallet, each with its BIP-380 checksum. When the key origin (fingerprint) is
 * known, the `[fp/path]` prefix is included so hardware signers can match the
 * key; otherwise the key expression is emitted bare (still valid, just origin-
 * less), matching how the rest of the codebase handles unknown origins.
 */
export function walletDescriptors(input: WalletDescriptorInput): {
	receive: string;
	change: string;
} {
	const path = originPath(input.derivationPath ?? DEFAULT_ORIGIN_PATH[input.scriptType]);
	const origin = input.masterFingerprint ? `[${input.masterFingerprint.toLowerCase()}/${path}]` : '';
	const build = (chain: 0 | 1): string => {
		const body = wrap(input.scriptType, `${origin}${input.xpub}/${chain}/*`);
		return `${body}#${descriptorChecksum(body)}`;
	};
	return { receive: build(0), change: build(1) };
}

/**
 * Plain-text descriptor backup for a single-sig wallet: both branches,
 * checksummed, with enough prose that whoever finds the file later knows what
 * it is and what it can (and cannot) do. Mirrors the multisig descriptorBackup.
 */
export function walletDescriptorBackup(input: WalletDescriptorInput): string {
	const { receive, change } = walletDescriptors(input);
	return [
		`Heartwood wallet backup — "${input.name}"`,
		`Single-key wallet, ${SCRIPT_LABEL[input.scriptType]}`,
		'',
		'These output descriptors describe the wallet completely: any descriptor',
		'wallet (Sparrow, Bitcoin Core, recent Electrum) can import them to watch',
		'balances and rebuild every address. They contain only your PUBLIC key —',
		'they cannot spend. Spending still requires signing on your own device.',
		'',
		'Receive (external) descriptor:',
		receive,
		'',
		'Change (internal) descriptor:',
		change,
		''
	].join('\n');
}
