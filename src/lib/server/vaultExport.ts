// Vault export artifacts: the ColdCard multisig registration file (also
// accepted by Passport, Keystone, and SeedSigner) and the plain-text
// descriptor backup. Both are pure functions of the vault row — no network,
// no clock — so exports are byte-deterministic and testable exactly.

import { HDKey } from '@scure/bip32';
import { parseDescriptor, vaultToDescriptor, VaultError } from './bitcoin/multisig';
import { toVaultConfig, type VaultRow, type VaultScriptType } from './vaults';

/** ColdCard `Format:` values per script type. */
const FORMAT_LABEL: Record<VaultScriptType, string> = {
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
	return ascii || 'Cairn vault';
}

/** Canonical (SLIP-132 normalized) xpubs in the vault's stored key order,
 *  obtained by round-tripping through the descriptor library — the same
 *  normalization every other export path uses. */
function canonicalXpubs(vault: VaultRow): string[] {
	return parseDescriptor(vaultToDescriptor(toVaultConfig(vault))).keys.map((k) => k.xpub);
}

/**
 * The ColdCard multisig setup file:
 *
 *   # Cairn multisig setup file
 *   Name: My vault
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
export function coldcardRegistration(vault: VaultRow): string {
	const xpubs = canonicalXpubs(vault);
	const paths = vault.keys.map((k) => k.path.trim());
	const uniform = paths.every((p) => p === paths[0]) && paths[0] !== 'm' && paths[0] !== '';

	const lines: string[] = [
		'# Cairn multisig setup file',
		`Name: ${coldcardName(vault.name)}`,
		`Policy: ${vault.threshold} of ${vault.keys.length}`,
		`Format: ${FORMAT_LABEL[vault.scriptType]}`
	];
	if (uniform) lines.push(`Derivation: ${paths[0]}`);
	lines.push('');

	vault.keys.forEach((key, i) => {
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
 * name/path/xpub/xfp. This is the "restore this vault anywhere" file — the
 * friendliest of the three backup formats.
 *
 * Round-trip contract (see the Caravan parity study): BOTH quorum fields
 * emitted; uuid = the receive descriptor's checksum (what Caravan itself sets
 * on descriptor import — omitting it triggers its "undefined" re-export
 * quirk); NO client field (Caravan's own unknown-client shape fails its
 * re-import); NO per-key method; canonical xpubs only; apostrophe-hardened
 * paths; masked "m/0/…" depth-preserving paths for unknown origins.
 */
export function caravanExport(vault: VaultRow): string {
	const xpubs = canonicalXpubs(vault);
	const receiveDescriptor = vaultToDescriptor(toVaultConfig(vault));
	const uuid = receiveDescriptor.slice(receiveDescriptor.lastIndexOf('#') + 1);
	return (
		JSON.stringify(
			{
				name: vault.name,
				uuid,
				addressType: FORMAT_LABEL[vault.scriptType],
				network: 'mainnet',
				quorum: {
					requiredSigners: vault.threshold,
					totalSigners: vault.keys.length
				},
				extendedPublicKeys: vault.keys.map((k, i) => {
					const path = k.path.trim();
					return {
						name: k.name,
						bip32Path:
							path === '' || path === 'm' ? maskedPath(xpubs[i]) : apostrophePath(path),
						xpub: xpubs[i],
						xfp: k.fingerprint
					};
				}),
				startingAddressIndex: 0
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
	scriptType: VaultScriptType;
	threshold: number;
	totalKeys: number;
	keys: { name: string; xpub: string; fingerprint: string; path: string }[];
}

const ADDRESS_TYPE_TO_SCRIPT: Record<string, VaultScriptType> = {
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
 * because Cairn derives mainnet addresses. Throws VaultError with a
 * user-presentable message on anything unusable.
 */
export function parseCaravanImport(text: string): CaravanImport {
	if (containsPrivateKeyMaterial(text)) {
		throw new VaultError(PRIVATE_KEY_REFUSAL, 'invalid_key');
	}

	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new VaultError(
			"That doesn't look like a wallet file — expected Caravan/Unchained JSON or a descriptor.",
			'invalid_descriptor'
		);
	}
	if (typeof doc !== 'object' || doc === null) {
		throw new VaultError('The wallet file is empty or malformed.', 'invalid_descriptor');
	}
	const root = doc as Record<string, unknown>;

	const network = typeof root.network === 'string' ? root.network.toLowerCase() : null;
	if (network && network !== 'mainnet') {
		throw new VaultError(
			`This wallet file was built for ${root.network} — Cairn tracks mainnet Bitcoin, so its addresses would never match.`,
			'unsupported_descriptor'
		);
	}

	const addressType = typeof root.addressType === 'string' ? root.addressType.toUpperCase() : '';
	const scriptType = ADDRESS_TYPE_TO_SCRIPT[addressType];
	if (!scriptType) {
		throw new VaultError(
			`Unknown address type "${root.addressType}" — expected P2WSH, P2SH-P2WSH or P2SH.`,
			'unsupported_descriptor'
		);
	}

	const quorum = (root.quorum ?? {}) as Record<string, unknown>;
	const threshold = Number(quorum.requiredSigners);
	if (!Number.isInteger(threshold) || threshold < 1) {
		throw new VaultError(
			'The wallet file has no usable quorum (quorum.requiredSigners).',
			'invalid_descriptor'
		);
	}

	const rawKeys = root.extendedPublicKeys;
	if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
		throw new VaultError(
			'The wallet file lists no extended public keys.',
			'invalid_descriptor'
		);
	}
	const keys = rawKeys.map((entry, i) => {
		const k = (entry ?? {}) as Record<string, unknown>;
		const xpub = typeof k.xpub === 'string' ? k.xpub.trim() : '';
		if (!xpub) {
			throw new VaultError(`Key ${i + 1} in the wallet file has no xpub.`, 'invalid_descriptor');
		}
		const xfp = typeof k.xfp === 'string' ? k.xfp.trim() : '';
		return {
			name: typeof k.name === 'string' && k.name.trim() ? k.name.trim() : `Key ${i + 1}`,
			xpub,
			fingerprint: /^[0-9a-fA-F]{8}$/.test(xfp) ? xfp.toLowerCase() : '00000000',
			path: typeof k.bip32Path === 'string' && k.bip32Path.trim() ? k.bip32Path.trim() : 'm'
		};
	});

	const totalSigners = Number(quorum.totalSigners);
	if (Number.isInteger(totalSigners) && totalSigners > 0 && totalSigners !== keys.length) {
		throw new VaultError(
			`The wallet file says ${totalSigners} total keys but lists ${keys.length} — it looks corrupted.`,
			'invalid_descriptor'
		);
	}
	if (threshold > keys.length) {
		throw new VaultError(
			`The wallet file requires ${threshold} signatures but lists only ${keys.length} keys.`,
			'invalid_descriptor'
		);
	}

	return {
		name: typeof root.name === 'string' ? root.name.trim() : '',
		scriptType,
		threshold,
		totalKeys: keys.length,
		keys
	};
}

/**
 * Plain-text descriptor backup: both branches, checksummed, with just enough
 * prose that whoever finds the file years from now knows what it is and what
 * it can (and cannot) do.
 */
export function descriptorBackup(vault: VaultRow): string {
	const config = toVaultConfig(vault);
	const receive = vaultToDescriptor(config, { chain: 0 });
	const change = vaultToDescriptor(config, { chain: 1 });
	return [
		`Cairn vault backup — "${vault.name}"`,
		`${vault.threshold}-of-${vault.keys.length} multisig, ${FORMAT_LABEL[vault.scriptType]} (sortedmulti)`,
		'',
		'These output descriptors describe the vault completely: any descriptor',
		'wallet (Sparrow, Bitcoin Core, recent Electrum) can import them to watch',
		'balances and rebuild every address. They contain only PUBLIC keys —',
		'they cannot spend. Spending still requires signatures from',
		`${vault.threshold} of the ${vault.keys.length} keys.`,
		'',
		'Receive (external) descriptor:',
		receive,
		'',
		'Change (internal) descriptor:',
		change,
		''
	].join('\n');
}
