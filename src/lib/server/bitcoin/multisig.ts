// M-of-N multisig ("multisig") foundations: BIP-67 sorted-multisig address
// derivation, BIP-380 output descriptors, and the descriptor checksum.
//
// Multisigs are sortedmulti in one of three script forms:
//   - p2wsh       wsh(sortedmulti(M, ...))      bc1q… (the recommended default;
//                 BIP-48 script-type 2' convention)
//   - p2sh-p2wsh  sh(wsh(sortedmulti(M, ...)))  3…    (wrapped segwit; BIP-48
//                 script-type 1')
//   - p2sh        sh(sortedmulti(M, ...))       3…    (legacy; BIP-48
//                 script-type 1' as well — BIP-48 gives BOTH p2sh forms the
//                 same 1' suffix, and only p2wsh gets 2'. That affects path
//                 GUIDANCE only; derivation always uses the paths the user's
//                 keys actually carry.)
// Taproot multisig (tr() descriptors) is deliberately NOT supported: on-chain
// key-path multisig needs MuSig2 and script-path needs FROST or huge leaf
// trees, and hardware/coordinator support for either is still immature —
// there is no interoperable tr() multisig convention to target yet.
//
// BIP-67 (lexicographic pubkey order inside the multisig script) makes the
// address a function of the key SET, not the key order, so cosigner order
// never matters — in the config, the descriptor, or across tools. The sort
// happens on the derived child pubkeys, identically for all three script
// forms. One user typically holds all N keys; nothing here ever touches
// private material.
//
// Portability: descriptor export is the interchange target. Sparrow imports
// descriptors directly and recent Electrum versions do too (classic Electrum
// multisig setup instead wants SLIP-132 Zpub cosigner keys — Zpub/Ypub are
// accepted on input and canonicalized to xpub, but no Electrum-specific JSON
// exporter lives here). The emitted format is byte-compatible with Bastion's
// (proven against Sparrow/Electrum/Core imports): `[fp/48h/0h/0h/2h]xpub/0/*`
// key origins, lowercase fingerprint, h-hardened markers, origin bracket
// omitted when the key has no origin path.
//
// PSBT construction for multisig spends is a later integration; the
// bip32Derivation ingredients it will need come from multisigKeyDerivations().

import { p2ms, p2wsh, p2sh, NETWORK } from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import type { HDKey } from '@scure/bip32';
import { parseXpub } from './xpub';

/** One cosigner key. The xpub is the BIP-48 account-level key; fingerprint and
 *  path describe its origin from the master seed (what signers match on). */
export interface MultisigKeyDescriptor {
	/** Account xpub. SLIP-132 (ypub/zpub/Ypub/Zpub) accepted, canonicalized to xpub on export. */
	xpub: string;
	/** Master key fingerprint, 8 hex chars ("00000000" when unknown). */
	fingerprint: string;
	/** Account origin path, e.g. "m/48'/0'/0'/2'" (BIP-48 wsh); "m" when unknown. */
	path: string;
	name?: string;
}

/** The three supported multisig script forms. Absent on a config = 'p2wsh'. */
export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

export interface MultisigConfig {
	/** Signatures required to spend (M of keys.length). */
	threshold: number;
	keys: MultisigKeyDescriptor[];
	/** Script form of every address this multisig derives. Absent = 'p2wsh'. */
	scriptType?: MultisigScriptType;
}

export interface MultisigAddress {
	address: string;
	/**
	 * The p2ms script the address commits to via sha256 → witness program.
	 * Present for the wsh forms (p2wsh, p2sh-p2wsh); absent for legacy p2sh,
	 * where the p2ms script is the redeemScript instead.
	 */
	witnessScript?: Uint8Array;
	/**
	 * PSBT redeemScript for the sh forms: the p2ms script itself (p2sh) or the
	 * wsh program script OP_0 <sha256(witnessScript)> (p2sh-p2wsh). Absent for
	 * native p2wsh.
	 */
	redeemScript?: Uint8Array;
	/** BIP-67 order — exactly the order the pubkeys appear in the p2ms script. */
	sortedPubkeys: Uint8Array[];
}

/** Per-key material for a future PSBT's bip32Derivation field:
 *  `[pubkey, { fingerprint, path }]` in the shape btc-signer expects. */
export interface MultisigKeyDerivation {
	/** Compressed child pubkey at <chain>/<index> — a witness-script participant. */
	pubkey: Uint8Array;
	/** Master fingerprint as a number (parseInt(fp, 16) >>> 0). */
	fingerprint: number;
	/** Full path from the master: origin indexes + [chain, index], hardened offsets applied. */
	path: number[];
}

export class MultisigError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'invalid_config'
			| 'invalid_key'
			| 'invalid_descriptor'
			| 'unsupported_descriptor'
			| 'derivation_failed'
	) {
		super(message);
		this.name = 'MultisigError';
	}
}

/** P2WSH CHECKMULTISIG key ceiling every wallet UI enforces (standardness). */
export const MAX_MULTISIG_KEYS = 15;

const HARDENED = 0x80000000;
const b58check = createBase58check(sha256);

// ------------------------------------------------------------- key handling

/** SLIP-132 multisig public prefixes, rewritten to standard xpub bytes before
 *  parsing (parseXpub already handles ypub/zpub; these two it does not). */
const SLIP132_MULTISIG_VERSIONS = new Set([
	0x0295b43f, // Ypub (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub (p2wsh multisig)
]);
const XPUB_VERSION = 0x0488b21e;

/** Rewrite a SLIP-132 multisig prefix (Ypub/Zpub) to standard xpub bytes.
 *  Anything else — including invalid input — is returned unchanged so
 *  parseXpub produces the descriptive error. */
function toStandardXpub(input: string): string {
	const trimmed = input.trim();
	let raw: Uint8Array;
	try {
		raw = b58check.decode(trimmed);
	} catch {
		return trimmed;
	}
	if (raw.length !== 78) return trimmed;
	const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
	if (!SLIP132_MULTISIG_VERSIONS.has(version)) return trimmed;
	const out = new Uint8Array(raw);
	out[0] = (XPUB_VERSION >>> 24) & 0xff;
	out[1] = (XPUB_VERSION >>> 16) & 0xff;
	out[2] = (XPUB_VERSION >>> 8) & 0xff;
	out[3] = XPUB_VERSION & 0xff;
	return b58check.encode(out);
}

/** Canonical xpub string (SLIP-132 ypub/zpub/Ypub/Zpub aliases normalized to
 *  standard xpub form) for equality comparison across storage contexts, or
 *  null when the input is not a parseable extended public key. */
export function canonicalXpub(input: string): string | null {
	try {
		return parseXpub(toStandardXpub(input)).hdkey.publicExtendedKey;
	} catch {
		return null;
	}
}

// --------------------------------------------------------------- path utils

/** "m/48'/0'/0'/2'" (h/H/’ markers accepted, leading m/ optional) → index
 *  array with hardened offsets applied; "m" (or "") → []. Throws on nonsense. */
function parsePath(path: string): number[] {
	const stripped = path.trim().replace(/^m\/?/i, '');
	if (stripped === '') return [];
	return stripped.split('/').map((p) => {
		const hardened = /['’hH]$/.test(p);
		const digits = hardened ? p.slice(0, -1) : p;
		if (!/^\d+$/.test(digits)) throw new MultisigError(`Bad path segment "${p}"`, 'invalid_key');
		const n = parseInt(digits, 10);
		if (n >= HARDENED) throw new MultisigError(`Path segment out of range "${p}"`, 'invalid_key');
		return hardened ? n + HARDENED : n;
	});
}

function formatPath(indexes: number[], marker: string): string {
	return indexes.map((i) => (i >= HARDENED ? `${i - HARDENED}${marker}` : `${i}`)).join('/');
}

/** Index array → the codebase's KeyOrigin convention: "m/48'/0'/0'/2'"; [] → "m". */
function formatPathTick(indexes: number[]): string {
	return indexes.length ? `m/${formatPath(indexes, "'")}` : 'm';
}

// --------------------------------------------------------------- validation

interface ResolvedKey {
	label: string;
	hdkey: HDKey;
	/** Canonical xpub string (SLIP-132 prefixes normalized away). */
	xpub: string;
	/** Lowercase 8-hex master fingerprint. */
	fingerprint: string;
	pathIndexes: number[];
}

function resolveKey(key: MultisigKeyDescriptor, i: number): ResolvedKey {
	const label = key.name?.trim() || `key ${i + 1}`;
	let hdkey: HDKey;
	try {
		hdkey = parseXpub(toStandardXpub(key.xpub)).hdkey;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new MultisigError(`${label}: ${msg}`, 'invalid_key');
	}
	if (!/^[0-9a-fA-F]{8}$/.test(key.fingerprint)) {
		throw new MultisigError(
			`${label}: fingerprint must be 8 hex characters (got "${key.fingerprint}")`,
			'invalid_key'
		);
	}
	let pathIndexes: number[];
	try {
		pathIndexes = parsePath(key.path);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new MultisigError(`${label}: ${msg}`, 'invalid_key');
	}
	return {
		label,
		hdkey,
		xpub: hdkey.publicExtendedKey,
		fingerprint: key.fingerprint.toLowerCase(),
		pathIndexes
	};
}

/** Resolve (and validate) a config's script form; absent means p2wsh.
 *  Taproot multisig is rejected by name: MuSig2 (key path) and FROST (script
 *  path) tooling is not mature or interoperable enough to build multisigs on. */
function multisigScriptType(config: MultisigConfig): MultisigScriptType {
	const st = config.scriptType ?? 'p2wsh';
	if (st === 'p2wsh' || st === 'p2sh-p2wsh' || st === 'p2sh') return st;
	throw new MultisigError(
		`Multisig script type "${st}" is not supported — use p2wsh, p2sh-p2wsh, or p2sh (taproot multisig is not supported).`,
		'invalid_config'
	);
}

// ------------------------------------------------ cosigner path acceptance
//
// The checks below run at ACCEPTANCE time only — multisig creation and config
// import — never at derivation/export time. A recorded origin path is metadata
// (the address math derives from the xpub alone and never reads it), so an
// already-stored wallet with an odd path must keep deriving, exporting, and
// spending; blocking those operations would strand funds over a label. What
// acceptance must stop is NEW records being created with a lying path, because
// that path flows into descriptors, PSBTs, and hardware-wallet displays where
// every OTHER tool trusts it (cairn-1kc3.1/.3/.5).

/** Single-sig BIP purposes — never valid on a multisig cosigner key. */
const SINGLE_SIG_PURPOSES = new Map<number, string>([
	[44, 'BIP-44 legacy single-sig'],
	[49, 'BIP-49 wrapped-segwit single-sig'],
	[84, 'BIP-84 native-segwit single-sig'],
	[86, 'BIP-86 taproot single-sig']
]);

/** BIP-48 script-type suffix (4th component) per script form: only p2wsh gets
 *  2'; BOTH p2sh forms share 1' (see file header). */
const BIP48_SUFFIX: Record<MultisigScriptType, number> = {
	p2wsh: 2,
	'p2sh-p2wsh': 1,
	p2sh: 1
};

/** Hardened-marker-stripped value of one path component. */
const unhardened = (i: number): number => (i >= HARDENED ? i - HARDENED : i);

/**
 * Validate one cosigner's declared origin path for acceptance into a multisig.
 *
 * Accepted:
 *   - "m" / "" — unknown origin (the watch-only convention), and Caravan's
 *     masked depth-preserving all-zeros paths ("m/0/0/0/0")
 *   - m/45'/… — BIP-45, the collaborative-custody purpose; its structure
 *     (purpose'/cosigner_index/change/address_index) has no coin-type or
 *     script-type field, so nothing further to cross-check
 *   - m/48'/coin'/account'/script'… — BIP-48, where coin must be 0 (mainnet is
 *     the only network Cairn tracks, cairn-1kc3.5) and script must match the
 *     multisig's script form (cairn-1kc3.1)
 *
 * Everything else is rejected (cairn-1kc3.3) — single-sig purposes above all:
 * a single-sig path recorded on a multisig key makes from-seed recovery derive
 * the wrong key in every path-trusting tool, and leaks the existence of a
 * single-sig wallet into every export a cosigner receives.
 */
export function validateCosignerKeyPath(
	path: string,
	scriptType: MultisigScriptType | undefined,
	label: string
): void {
	let indexes: number[];
	try {
		indexes = parsePath(path);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new MultisigError(`${label}: ${msg}`, 'invalid_key');
	}
	// No purpose claim to validate: unknown origin, or a masked all-zeros path.
	if (indexes.length === 0 || indexes.every((i) => i === 0)) return;

	const shown = path.trim();
	if (indexes[0] === 45 + HARDENED) return;

	if (indexes[0] === 48 + HARDENED) {
		if (indexes.length < 4) {
			throw new MultisigError(
				`${label}: the path "${shown}" is incomplete — a BIP-48 multisig path has four levels, like m/48'/0'/0'/2'.`,
				'invalid_key'
			);
		}
		const coin = unhardened(indexes[1]);
		if (coin !== 0) {
			throw new MultisigError(
				`${label}: the path "${shown}" is for a different network (coin type ${coin}) — Cairn tracks mainnet Bitcoin, which uses coin type 0.`,
				'invalid_key'
			);
		}
		const st = scriptType ?? 'p2wsh';
		const suffix = unhardened(indexes[3]);
		if (suffix !== BIP48_SUFFIX[st]) {
			throw new MultisigError(
				`${label}: the path "${shown}" declares BIP-48 script type ${suffix}' but this multisig is ${st}, which uses …/${BIP48_SUFFIX[st]}' — re-export this key at the right path for this wallet type.`,
				'invalid_key'
			);
		}
		return;
	}

	const purpose = unhardened(indexes[0]);
	const singleSig = SINGLE_SIG_PURPOSES.get(purpose);
	if (singleSig) {
		throw new MultisigError(
			`${label}: the path "${shown}" is a ${singleSig} path — a multisig cosigner key must come from a multisig path (m/45', or m/48'/0'/0'/2' for this wallet's script type).`,
			'invalid_key'
		);
	}
	if (purpose === 45 || purpose === 48) {
		throw new MultisigError(
			`${label}: the path "${shown}" leaves purpose ${purpose} unhardened — multisig paths harden it (m/${purpose}'/…).`,
			'invalid_key'
		);
	}
	throw new MultisigError(
		`${label}: the path "${shown}" is not a multisig derivation path — expected purpose 45' or 48' (like m/48'/0'/0'/2').`,
		'invalid_key'
	);
}

/** Whole-config acceptance gate: every key's declared path validated against
 *  the config's script form. Called by createMultisig and the import parsers. */
export function validateMultisigKeyPaths(config: MultisigConfig): void {
	const scriptType = multisigScriptType(config);
	(config.keys ?? []).forEach((key, i) => {
		validateCosignerKeyPath(key.path, scriptType, key.name?.trim() || `key ${i + 1}`);
	});
}

/**
 * The multisig purpose a key's path declares: 45, 48, or null when it carries
 * no purpose claim at all (unknown origin "m", a masked all-zeros path, or an
 * unparseable path — run validateCosignerKeyPath first for real errors).
 * Vault-mode enforcement branches on this (cairn-1kc3.6).
 */
export function cosignerPathPurpose(path: string): 45 | 48 | null {
	let indexes: number[];
	try {
		indexes = parsePath(path);
	} catch {
		return null;
	}
	if (indexes.length === 0 || indexes.every((i) => i === 0)) return null;
	if (indexes[0] === 45 + HARDENED) return 45;
	if (indexes[0] === 48 + HARDENED) return 48;
	return null;
}

/** Full config validation: threshold bounds, key count, parseability, and
 *  distinctness (compared on the CANONICAL xpub, so a Zpub alias of an
 *  already-listed xpub is still a duplicate). */
function resolveMultisig(config: MultisigConfig): ResolvedKey[] {
	multisigScriptType(config); // reject unknown script forms everywhere, early
	const keys = config.keys ?? [];
	if (keys.length === 0) {
		throw new MultisigError('A multisig needs at least one key.', 'invalid_config');
	}
	if (keys.length > MAX_MULTISIG_KEYS) {
		throw new MultisigError(
			`A multisig supports at most ${MAX_MULTISIG_KEYS} keys (got ${keys.length}).`,
			'invalid_config'
		);
	}
	if (
		!Number.isInteger(config.threshold) ||
		config.threshold < 1 ||
		config.threshold > keys.length
	) {
		throw new MultisigError(
			`Threshold must be a whole number between 1 and ${keys.length} (got ${config.threshold}).`,
			'invalid_config'
		);
	}
	const resolved = keys.map(resolveKey);
	const seen = new Map<string, string>();
	for (const k of resolved) {
		const prior = seen.get(k.xpub);
		if (prior) {
			throw new MultisigError(
				`${prior} and ${k.label} are the same extended key — every cosigner must be distinct.`,
				'invalid_config'
			);
		}
		seen.set(k.xpub, k.label);
	}
	return resolved;
}

// --------------------------------------------------------------- derivation

/** Lexicographic byte order — the BIP-67 sort. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

function childPubkeys(
	resolved: ResolvedKey[],
	chain: 0 | 1,
	index: number
): { key: ResolvedKey; pubkey: Uint8Array }[] {
	if (chain !== 0 && chain !== 1) {
		throw new MultisigError(`Invalid chain ${chain} (0 = receive, 1 = change).`, 'derivation_failed');
	}
	if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
		throw new MultisigError(`Invalid derivation index: ${index}`, 'derivation_failed');
	}
	return resolved.map((key) => {
		const pubkey = key.hdkey.deriveChild(chain).deriveChild(index).publicKey;
		if (!pubkey) throw new MultisigError(`Key derivation failed for ${key.label}.`, 'derivation_failed');
		return { key, pubkey };
	});
}

/**
 * Derive the multisig's address at <chain>/<index>: each cosigner's child pubkey,
 * BIP-67 sorted, then the p2ms script wrapped per the config's scriptType —
 * p2wsh (default), p2sh(p2wsh(...)), or legacy p2sh. Key input order is
 * irrelevant by construction — the sort happens here, per address, exactly as
 * sortedmulti specifies, identically for every script form. Validates the
 * whole config on every call (cheap, and address derivation is the operation
 * where a bad config costs real money).
 *
 * The returned scripts are exactly what PSBT construction needs per form:
 * witnessScript for the wsh forms, redeemScript for the sh forms (both for
 * p2sh-p2wsh).
 */
export function deriveMultisigAddress(config: MultisigConfig, chain: 0 | 1, index: number): MultisigAddress {
	const resolved = resolveMultisig(config);
	const scriptType = multisigScriptType(config);
	const sorted = childPubkeys(resolved, chain, index)
		.map((c) => c.pubkey)
		.sort(compareBytes);
	const ms = p2ms(config.threshold, sorted);

	if (scriptType === 'p2wsh') {
		const payment = p2wsh(ms, NETWORK);
		if (!payment.address || !payment.witnessScript) {
			throw new MultisigError('Address construction failed.', 'derivation_failed');
		}
		return {
			address: payment.address,
			witnessScript: payment.witnessScript,
			sortedPubkeys: sorted
		};
	}
	if (scriptType === 'p2sh-p2wsh') {
		const payment = p2sh(p2wsh(ms, NETWORK), NETWORK);
		if (!payment.address || !payment.redeemScript || !payment.witnessScript) {
			throw new MultisigError('Address construction failed.', 'derivation_failed');
		}
		return {
			address: payment.address,
			witnessScript: payment.witnessScript,
			redeemScript: payment.redeemScript,
			sortedPubkeys: sorted
		};
	}
	// Legacy p2sh: the p2ms script IS the redeemScript; no witness data at all.
	const payment = p2sh(ms, NETWORK);
	if (!payment.address || !payment.redeemScript) {
		throw new MultisigError('Address construction failed.', 'derivation_failed');
	}
	return { address: payment.address, redeemScript: payment.redeemScript, sortedPubkeys: sorted };
}

/**
 * Per-key bip32Derivation material at <chain>/<index>, sorted by pubkey to
 * match the witness-script order. For an origin-less key (path "m") the path
 * is just [chain, index] under whatever fingerprint the config carries —
 * signers that match on master fingerprint need real origins to find keys.
 */
export function multisigKeyDerivations(
	config: MultisigConfig,
	chain: 0 | 1,
	index: number
): MultisigKeyDerivation[] {
	const resolved = resolveMultisig(config);
	return childPubkeys(resolved, chain, index)
		.map(({ key, pubkey }) => ({
			pubkey,
			fingerprint: parseInt(key.fingerprint, 16) >>> 0,
			path: [...key.pathIndexes, chain, index]
		}))
		.sort((a, b) => compareBytes(a.pubkey, b.pubkey));
}

/** First receive address (0/0) — the wizard shows it so the user can
 *  cross-check against another descriptor tool BEFORE any funds move. */
export function multisigTestAddress(config: MultisigConfig): string {
	return deriveMultisigAddress(config, 0, 0).address;
}

// ---------------------------------------------------- BIP-380 checksum

// Port of Bitcoin Core's DescriptorChecksum (script/descriptor.cpp). The
// PolyMod state needs 40 bits, hence BigInt. Verified against the published
// vectors (see multisig.test.ts) and byte-compatible with Bastion's
// Core-verified port.
const INPUT_CHARSET =
	"0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'; // bech32

function polymod(c: bigint, val: number): bigint {
	const c0 = Number(c >> 35n);
	c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
	if (c0 & 1) c ^= 0xf5dee51989n;
	if (c0 & 2) c ^= 0xa9fdca3312n;
	if (c0 & 4) c ^= 0x1bab10e32dn;
	if (c0 & 8) c ^= 0x3706b1677an;
	if (c0 & 16) c ^= 0x644d626ffdn;
	return c;
}

/** The 8-char BIP-380 checksum of a descriptor BODY (no "#suffix" included).
 *  Throws on characters outside the descriptor charset. */
export function descriptorChecksum(s: string): string {
	let c = 1n;
	let cls = 0;
	let clscount = 0;
	for (const ch of s) {
		const pos = INPUT_CHARSET.indexOf(ch);
		if (pos < 0) {
			throw new MultisigError(
				`Descriptor contains a character outside the BIP-380 charset: "${ch}"`,
				'invalid_descriptor'
			);
		}
		c = polymod(c, pos & 31);
		cls = cls * 3 + (pos >> 5);
		if (++clscount === 3) {
			c = polymod(c, cls);
			cls = 0;
			clscount = 0;
		}
	}
	if (clscount > 0) c = polymod(c, cls);
	for (let j = 0; j < 8; j++) c = polymod(c, 0);
	c ^= 1n;
	let out = '';
	for (let j = 0; j < 8; j++) {
		out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
	}
	return out;
}

// -------------------------------------------------------------- descriptors

/**
 * Export the multisig as a checksummed output descriptor, wrapped per the
 * config's scriptType:
 *   p2wsh       `wsh(sortedmulti(M,[fp/48h/0h/0h/2h]xpub/0/*,...))#checksum`
 *   p2sh-p2wsh  `sh(wsh(sortedmulti(...)))#checksum`
 *   p2sh        `sh(sortedmulti(...))#checksum`
 * chain 0 (default) is the receive branch (/0/*), chain 1 the change branch
 * (/1/*). Keys are emitted in config order — sortedmulti sorts the DERIVED
 * pubkeys per address, so descriptor key order does not affect addresses.
 * SLIP-132 keys are emitted in canonical xpub form; a key with no origin path
 * ("m") is emitted bare (no [origin] bracket), losing its fingerprint — same
 * convention as Bastion/Core.
 */
export function multisigToDescriptor(config: MultisigConfig, opts: { chain?: 0 | 1 } = {}): string {
	const resolved = resolveMultisig(config);
	const scriptType = multisigScriptType(config);
	const chain = opts.chain ?? 0;
	if (chain !== 0 && chain !== 1) {
		throw new MultisigError(`Invalid chain ${chain} (0 = receive, 1 = change).`, 'invalid_config');
	}
	const keyExprs = resolved.map((k) => {
		const origin = k.pathIndexes.length ? `[${k.fingerprint}/${formatPath(k.pathIndexes, 'h')}]` : '';
		return `${origin}${k.xpub}/${chain}/*`;
	});
	const inner = `sortedmulti(${config.threshold},${keyExprs.join(',')})`;
	const body =
		scriptType === 'p2wsh'
			? `wsh(${inner})`
			: scriptType === 'p2sh-p2wsh'
				? `sh(wsh(${inner}))`
				: `sh(${inner})`;
	return `${body}#${descriptorChecksum(body)}`;
}

/** `[fp/path]xpub/0/*` (origin optional, suffix optional) → MultisigKeyDescriptor. */
function parseKeyExpression(expr: string, i: number): MultisigKeyDescriptor {
	let rest = expr.trim();
	let fingerprint = '00000000'; // watch-only placeholder when no origin is given
	let pathIndexes: number[] = [];
	if (rest.startsWith('[')) {
		const close = rest.indexOf(']');
		if (close < 0) {
			throw new MultisigError(`Key ${i + 1}: unterminated key-origin bracket.`, 'invalid_descriptor');
		}
		const origin = rest.slice(1, close);
		rest = rest.slice(close + 1);
		const slash = origin.indexOf('/');
		const fp = slash < 0 ? origin : origin.slice(0, slash);
		if (!/^[0-9a-fA-F]{8}$/.test(fp)) {
			throw new MultisigError(
				`Key ${i + 1}: master fingerprint must be 8 hex characters (got "${fp}").`,
				'invalid_descriptor'
			);
		}
		fingerprint = fp.toLowerCase();
		if (slash >= 0) {
			try {
				pathIndexes = parsePath(origin.slice(slash + 1));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new MultisigError(`Key ${i + 1}: ${msg}`, 'invalid_descriptor');
			}
		}
	}
	// The xpub is the run up to the branch suffix. A ranged suffix must be a
	// receive/change wildcard (or Core's <0;1> multipath); absent is tolerated —
	// the config's chain/index derivation supplies the branches either way.
	const slash = rest.indexOf('/');
	const xpub = (slash < 0 ? rest : rest.slice(0, slash)).trim();
	const suffix = slash < 0 ? '' : rest.slice(slash);
	if (suffix !== '' && !/^\/(?:0|1|<0;1>)\/\*$/.test(suffix)) {
		throw new MultisigError(
			`Key ${i + 1}: expected a /0/* or /1/* derivation suffix (got "${suffix}").`,
			'invalid_descriptor'
		);
	}
	if (!xpub) {
		throw new MultisigError(`Key ${i + 1}: missing extended public key.`, 'invalid_descriptor');
	}
	return { xpub, fingerprint, path: formatPathTick(pathIndexes) };
}

/**
 * Parse a sortedmulti output descriptor (checksum optional, verified when
 * present; h / ' / ’ hardened markers; key origins optional) into a
 * MultisigConfig. All three multisig script forms are accepted:
 *   wsh(sortedmulti(…))      → scriptType 'p2wsh'
 *   sh(wsh(sortedmulti(…)))  → scriptType 'p2sh-p2wsh'
 *   sh(sortedmulti(…))       → scriptType 'p2sh'
 * Names are not part of a descriptor and come back empty.
 * Rejections are deliberate product boundaries, not parser gaps:
 *   - multi(…)      unsorted keys make the address depend on key order;
 *                    re-export as sortedmulti (every modern wallet supports it)
 *   - tr(…)         taproot multisig — MuSig2/FROST tooling is not mature or
 *                    interoperable enough to build multisigs on (see file header)
 *   - anything else  not a multisig multisig
 */
export function parseDescriptor(desc: string): MultisigConfig {
	let s = desc.trim();

	const hash = s.indexOf('#');
	if (hash >= 0) {
		const body = s.slice(0, hash);
		const given = s.slice(hash + 1).trim();
		if (!/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(given)) {
			throw new MultisigError(
				'Malformed descriptor checksum (expected 8 bech32 characters after "#").',
				'invalid_descriptor'
			);
		}
		const expected = descriptorChecksum(body);
		if (given !== expected) {
			throw new MultisigError(
				`Descriptor checksum does not match (got #${given}, expected #${expected}) — the descriptor was mistyped or corrupted.`,
				'invalid_descriptor'
			);
		}
		s = body;
	}

	const lower = s.toLowerCase();
	if (lower.startsWith('tr(')) {
		throw new MultisigError(
			'Taproot multisig (tr(...)) is not supported — on-chain taproot multisig needs MuSig2 or FROST, which signing devices and coordinators do not interoperably support yet. Use a wsh(sortedmulti(...)) descriptor instead.',
			'unsupported_descriptor'
		);
	}

	let scriptType: MultisigScriptType;
	let inner: string;
	if (lower.startsWith('sh(wsh(') && s.endsWith('))')) {
		scriptType = 'p2sh-p2wsh';
		inner = s.slice(7, -2);
	} else if (lower.startsWith('wsh(') && s.endsWith(')')) {
		scriptType = 'p2wsh';
		inner = s.slice(4, -1);
	} else if (lower.startsWith('sh(') && s.endsWith(')')) {
		scriptType = 'p2sh';
		inner = s.slice(3, -1);
	} else {
		throw new MultisigError(
			'Only wsh(sortedmulti(...)), sh(wsh(sortedmulti(...))) and sh(sortedmulti(...)) descriptors are supported.',
			'unsupported_descriptor'
		);
	}
	const innerLower = inner.toLowerCase();
	if (innerLower.startsWith('multi(')) {
		throw new MultisigError(
			'This descriptor uses multi() — unsorted keys, where the address depends on key order. Re-export it as sortedmulti() (BIP-67), which every modern multisig wallet supports.',
			'unsupported_descriptor'
		);
	}
	if (!innerLower.startsWith('sortedmulti(') || !inner.endsWith(')')) {
		throw new MultisigError(
			'Only wsh(sortedmulti(...)), sh(wsh(sortedmulti(...))) and sh(sortedmulti(...)) descriptors are supported.',
			'unsupported_descriptor'
		);
	}

	const args = inner.slice('sortedmulti('.length, -1).split(',');
	if (args.length < 2) {
		throw new MultisigError(
			'sortedmulti() needs a threshold and at least one key.',
			'invalid_descriptor'
		);
	}
	const thresholdStr = args[0].trim();
	if (!/^\d+$/.test(thresholdStr)) {
		throw new MultisigError(
			`sortedmulti() threshold "${thresholdStr}" is not a whole number.`,
			'invalid_descriptor'
		);
	}

	const config: MultisigConfig = {
		threshold: parseInt(thresholdStr, 10),
		keys: args.slice(1).map((expr, i) => parseKeyExpression(expr, i)),
		scriptType
	};
	resolveMultisig(config); // threshold/key-count bounds, parseability, duplicates
	return config;
}
