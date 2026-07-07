// Multisig export artifacts: the ColdCard multisig registration file (also
// accepted by Passport, Keystone, and SeedSigner) and the plain-text
// descriptor backup. Both are pure functions of the multisig row — no network,
// no clock — so exports are byte-deterministic and testable exactly.

import { HDKey } from '@scure/bip32';
import {
	parseDescriptor,
	multisigToDescriptor,
	validateCosignerKeyPath,
	MultisigError,
	MAX_MULTISIG_KEYS
} from './bitcoin/multisig';
import { toMultisigConfig, type MultisigRow, type MultisigScriptType } from './wallets/multisig';
import { parseXpub } from './bitcoin/xpub';

/** ColdCard `Format:` values per script type. */
const FORMAT_LABEL: Record<MultisigScriptType, string> = {
	p2wsh: 'P2WSH',
	'p2sh-p2wsh': 'P2SH-P2WSH',
	p2sh: 'P2SH'
};

/**
 * ColdCard registration names must be printable ASCII and at most 20 chars.
 * Anything else is stripped rather than mangled; an empty result falls back
 * to a generic name so the file always imports.
 */
export function coldcardName(name: string): string {
	const ascii = name
		.split('')
		.filter((ch) => ch >= ' ' && ch <= '~')
		.join('')
		.trim()
		.slice(0, 20)
		.trim();
	return ascii || 'Cairn multisig';
}

/** Canonical (SLIP-132 normalized) xpubs in the multisig's stored key order,
 *  obtained by round-tripping through the descriptor library — the same
 *  normalization every other export path uses. */
function canonicalXpubs(multisig: MultisigRow): string[] {
	return parseDescriptor(multisigToDescriptor(toMultisigConfig(multisig))).keys.map((k) => k.xpub);
}

/**
 * The ColdCard multisig setup file:
 *
 *   # Cairn multisig setup file
 *   Name: My multisig
 *   Policy: 2 of 3
 *   Format: P2WSH
 *   Derivation: m/48'/0'/0'/2'
 *
 *   A1B2C3D4: xpub...
 *   B2C3D4E5: xpub...
 *
 * When every key shares one origin path a single global `Derivation:` line is
 * emitted (the common case); otherwise each key gets its own `Derivation:`
 * line directly above its `XFP: xpub` line. Keys with an unknown path ("m")
 * get no Derivation line. Fingerprints are uppercase per the format.
 */
export function coldcardRegistration(multisig: MultisigRow): string {
	const xpubs = canonicalXpubs(multisig);
	const paths = multisig.keys.map((k) => k.path.trim());
	const uniform = paths.every((p) => p === paths[0]) && paths[0] !== 'm' && paths[0] !== '';

	const lines: string[] = [
		'# Cairn multisig setup file',
		`Name: ${coldcardName(multisig.name)}`,
		`Policy: ${multisig.threshold} of ${multisig.keys.length}`,
		`Format: ${FORMAT_LABEL[multisig.scriptType]}`
	];
	if (uniform) lines.push(`Derivation: ${paths[0]}`);
	lines.push('');

	multisig.keys.forEach((key, i) => {
		if (!uniform && key.path !== 'm' && key.path.trim() !== '') {
			lines.push(`Derivation: ${key.path}`);
		}
		lines.push(`${key.fingerprint.toUpperCase()}: ${xpubs[i]}`);
	});

	return lines.join('\n') + '\n';
}

/** Normalize a derivation path to apostrophe hardening — Caravan's importer
 *  rejects h-notation (`48h`) even though descriptors prefer it. */
function apostrophePath(path: string): string {
	return path.replace(/(\d+)[hH’]/g, "$1'");
}

/** Caravan's masked derivation for unknown-path keys: "m" plus one "/0" per
 *  level of the xpub's actual depth — downstream consumers need plausible
 *  depth, and bare "m" trips them up. */
function maskedPath(canonicalXpub: string): string {
	const depth = HDKey.fromExtendedKey(canonicalXpub).depth;
	return 'm' + '/0'.repeat(depth);
}

/**
 * Caravan-compatible JSON wallet config (also Unchained's format; Sparrow
 * imports it directly): quorum, address type, and one entry per key with
 * name/path/xpub/xfp. This is the "restore this multisig anywhere" file — the
 * friendliest of the three backup formats.
 *
 * Round-trip contract (see the Caravan parity study): BOTH quorum fields
 * emitted; uuid = the receive descriptor's checksum (what Caravan itself sets
 * on descriptor import — omitting it triggers its "undefined" re-export
 * quirk); NO client field (Caravan's own unknown-client shape fails its
 * re-import); NO per-key method; canonical xpubs only; apostrophe-hardened
 * paths; masked "m/0/…" depth-preserving paths for unknown origins.
 */
export function caravanExport(multisig: MultisigRow): string {
	const xpubs = canonicalXpubs(multisig);
	const receiveDescriptor = multisigToDescriptor(toMultisigConfig(multisig));
	const uuid = receiveDescriptor.slice(receiveDescriptor.lastIndexOf('#') + 1);
	return (
		JSON.stringify(
			{
				name: multisig.name,
				uuid,
				addressType: FORMAT_LABEL[multisig.scriptType],
				network: 'mainnet',
				quorum: {
					requiredSigners: multisig.threshold,
					totalSigners: multisig.keys.length
				},
				extendedPublicKeys: multisig.keys.map((k, i) => {
					const path = k.path.trim();
					return {
						name: k.name,
						bip32Path:
							path === '' || path === 'm' ? maskedPath(xpubs[i]) : apostrophePath(path),
						xpub: xpubs[i],
						xfp: k.fingerprint
					};
				}),
				// The wallet's real receive cursor so a backup→restore round-trip
				// resumes handing out fresh addresses instead of reusing 0.. again
				// (cairn-u161).
				startingAddressIndex: multisig.receiveCursor
			},
			null,
			2
		) + '\n'
	);
}

// ------------------------------------------------------------ Caravan import

/** What a parsed Caravan/Unchained wallet config yields for the wizard. */
export interface CaravanImport {
	name: string;
	scriptType: MultisigScriptType;
	threshold: number;
	totalKeys: number;
	keys: { name: string; xpub: string; fingerprint: string; path: string }[];
	/** Receive cursor to resume from (Caravan's startingAddressIndex), so a
	 *  backup→restore round-trip doesn't reissue already-used addresses
	 *  (cairn-u161). 0 when the file omits it. */
	startingAddressIndex: number;
}

const ADDRESS_TYPE_TO_SCRIPT: Record<string, MultisigScriptType> = {
	P2WSH: 'p2wsh',
	'P2SH-P2WSH': 'p2sh-p2wsh',
	P2SH: 'p2sh'
};

/** True when a blob contains extended PRIVATE key material (xprv/yprv/zprv/
 *  tprv and SLIP-132 variants). Checked on whole pasted/uploaded imports so a
 *  private key is refused loudly before any parsing. */
export function containsPrivateKeyMaterial(text: string): boolean {
	return /[xyztuv]prv/i.test(text);
}

export const PRIVATE_KEY_REFUSAL =
	"That contains a PRIVATE key. Never paste it anywhere — anyone who sees it can spend your bitcoin. Export the public key instead (look for 'xpub' in your wallet).";

/**
 * Parse a Caravan wallet-config JSON (also Unchained's format, and the shape
 * Cairn's own "Download backup (JSON)" emits — export → import round-trips).
 * Unknown extra fields are tolerated; xfp normalizes to lowercase with the
 * '00000000' placeholder when missing; a non-mainnet network is rejected
 * because Cairn derives mainnet addresses. Throws MultisigError with a
 * user-presentable message on anything unusable.
 */
/** Upper bound on a pasted/uploaded wallet config. A real Caravan/Cairn config
 *  is a few KB; 1 MB is generous headroom while still rejecting an adversarially
 *  large blob before it is buffered and JSON.parsed synchronously (cairn-973j). */
const MAX_IMPORT_BYTES = 1_000_000;

export function parseCaravanImport(text: string): CaravanImport {
	if (text.length > MAX_IMPORT_BYTES) {
		throw new MultisigError(
			'That file is too large to be a wallet configuration.',
			'invalid_descriptor'
		);
	}
	if (containsPrivateKeyMaterial(text)) {
		throw new MultisigError(PRIVATE_KEY_REFUSAL, 'invalid_key');
	}

	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new MultisigError(
			"That doesn't look like a wallet file — expected Caravan/Unchained JSON or a descriptor.",
			'invalid_descriptor'
		);
	}
	if (typeof doc !== 'object' || doc === null) {
		throw new MultisigError('The wallet file is empty or malformed.', 'invalid_descriptor');
	}
	const root = doc as Record<string, unknown>;

	const network = typeof root.network === 'string' ? root.network.toLowerCase() : null;
	if (network && network !== 'mainnet') {
		throw new MultisigError(
			`This wallet file was built for ${root.network} — Cairn tracks mainnet Bitcoin, so its addresses would never match.`,
			'unsupported_descriptor'
		);
	}

	const addressType = typeof root.addressType === 'string' ? root.addressType.toUpperCase() : '';
	const scriptType = ADDRESS_TYPE_TO_SCRIPT[addressType];
	if (!scriptType) {
		throw new MultisigError(
			`Unknown address type "${root.addressType}" — expected P2WSH, P2SH-P2WSH or P2SH.`,
			'unsupported_descriptor'
		);
	}

	const quorum = (root.quorum ?? {}) as Record<string, unknown>;
	const threshold = Number(quorum.requiredSigners);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new MultisigError(
			'The wallet file has no usable quorum (quorum.requiredSigners).',
			'invalid_descriptor'
		);
	}

	const rawKeys = root.extendedPublicKeys;
	if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
		throw new MultisigError(
			'The wallet file lists no extended public keys.',
			'invalid_descriptor'
		);
	}
	// Bound the key count BEFORE any per-key work: a malformed/malicious file
	// with thousands of entries must be rejected up front, not after mapping
	// them all (the same MAX_MULTISIG_KEYS limit is enforced again at creation).
	if (rawKeys.length > MAX_MULTISIG_KEYS) {
		throw new MultisigError(
			`The wallet file lists ${rawKeys.length} keys — a multisig supports at most ${MAX_MULTISIG_KEYS}.`,
			'invalid_descriptor'
		);
	}
	const seenXpubs = new Set<string>();
	const keys = rawKeys.map((entry, i) => {
		const k = (entry ?? {}) as Record<string, unknown>;
		const xpub = typeof k.xpub === 'string' ? k.xpub.trim() : '';
		if (!xpub) {
			throw new MultisigError(`Key ${i + 1} in the wallet file has no xpub.`, 'invalid_descriptor');
		}
		// Validate each key inline (cairn-xxjf) so a garbage or wrong-network key
		// (e.g. a tpub in a "mainnet" file) fails HERE with specific per-key
		// attribution, not later during address derivation with a generic error.
		try {
			parseXpub(xpub);
		} catch (e) {
			throw new MultisigError(
				`Key ${i + 1}: ${e instanceof Error ? e.message : 'invalid extended key'}`,
				'invalid_key'
			);
		}
		// Reject a duplicate xpub up front too, matching resolveMultisig's
		// "every cosigner must be distinct" rule (cairn-xxjf).
		if (seenXpubs.has(xpub)) {
			throw new MultisigError(
				`Key ${i + 1} repeats an earlier cosigner's xpub — every key in a multisig must be distinct.`,
				'invalid_key'
			);
		}
		seenXpubs.add(xpub);
		const xfp = typeof k.xfp === 'string' ? k.xfp.trim() : '';
		const path =
			typeof k.bip32Path === 'string' && k.bip32Path.trim() ? k.bip32Path.trim() : 'm';
		// Path hygiene with per-key attribution (cairn-1kc3.1/.3/.5): a declared
		// single-sig path, a BIP-48 script-type suffix contradicting the file's
		// addressType, or a non-mainnet coin type fails HERE, at import preview,
		// naming the offending key — not later at creation with a generic error.
		// (Unknown "m" and Caravan's masked all-zeros paths pass untouched, and
		// BIP-45 m/45' paths have no script/coin fields to check.)
		validateCosignerKeyPath(path, scriptType, `Key ${i + 1}`);
		return {
			name: typeof k.name === 'string' && k.name.trim() ? k.name.trim() : `Key ${i + 1}`,
			xpub,
			fingerprint: /^[0-9a-fA-F]{8}$/.test(xfp) ? xfp.toLowerCase() : '00000000',
			path
		};
	});

	const totalSigners = Number(quorum.totalSigners);
	if (Number.isInteger(totalSigners) && totalSigners > 0 && totalSigners !== keys.length) {
		throw new MultisigError(
			`The wallet file says ${totalSigners} total keys but lists ${keys.length} — it looks corrupted.`,
			'invalid_descriptor'
		);
	}
	if (threshold > keys.length) {
		throw new MultisigError(
			`The wallet file requires ${threshold} signatures but lists only ${keys.length} keys.`,
			'invalid_descriptor'
		);
	}

	// startingAddressIndex is optional; accept a non-negative integer, else 0.
	const rawStart = Number(root.startingAddressIndex);
	const startingAddressIndex = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 0;

	return {
		name: typeof root.name === 'string' ? root.name.trim() : '',
		scriptType,
		threshold,
		totalKeys: keys.length,
		keys,
		startingAddressIndex
	};
}

/**
 * Plain-text descriptor backup: both branches, checksummed, with just enough
 * prose that whoever finds the file years from now knows what it is and what
 * it can (and cannot) do.
 */
export function descriptorBackup(multisig: MultisigRow): string {
	const config = toMultisigConfig(multisig);
	const receive = multisigToDescriptor(config, { chain: 0 });
	const change = multisigToDescriptor(config, { chain: 1 });
	return [
		`Cairn multisig backup — "${multisig.name}"`,
		`${multisig.threshold}-of-${multisig.keys.length} multisig, ${FORMAT_LABEL[multisig.scriptType]} (sortedmulti)`,
		'',
		'These output descriptors describe the multisig completely: any descriptor',
		'wallet (Sparrow, Bitcoin Core, recent Electrum) can import them to watch',
		'balances and rebuild every address. They contain only PUBLIC keys —',
		'they cannot spend. Spending still requires signatures from',
		`${multisig.threshold} of the ${multisig.keys.length} keys.`,
		'',
		'Receive (external) descriptor:',
		receive,
		'',
		'Change (internal) descriptor:',
		change,
		''
	].join('\n');
}
