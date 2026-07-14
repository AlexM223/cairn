// Extended-public-key parsing, address derivation and address <-> script helpers.
// Pure functions, no network access. Mainnet only.

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createBase58check, bech32, bech32m } from '@scure/base';
import type { ScriptType } from '$lib/types';

const b58check = createBase58check(sha256);

/** SLIP-132 mainnet public version bytes -> script type. */
const PUBLIC_VERSIONS: Record<number, ScriptType> = {
	0x0488b21e: 'p2pkh', // xpub (BIP44)
	0x049d7cb2: 'p2sh-p2wpkh', // ypub (BIP49)
	0x04b24746: 'p2wpkh' // zpub (BIP84)
};

/** SLIP-132 mainnet private version bytes (rejected with a helpful error). */
const PRIVATE_VERSIONS = new Set([0x0488ade4 /* xprv */, 0x049d7878 /* yprv */, 0x04b2430c /* zprv */]);

/** Common testnet version bytes (rejected — mainnet only). */
const TESTNET_VERSIONS = new Set([
	0x043587cf, // tpub
	0x04358394, // tprv
	0x044a5262, // upub
	0x044a4e28, // uprv
	0x045f1cf6, // vpub
	0x045f18bc // vprv
]);

/** Standard BIP32 mainnet xpub version bytes. */
const XPUB_VERSION = 0x0488b21e;

export interface ParsedXpub {
	scriptType: ScriptType;
	/** Account-level HD public key (watch-only, no private key). */
	hdkey: HDKey;
	/** Fingerprint of the account key itself, 8 hex chars. */
	fingerprint: string;
	/**
	 * BIP-32 depth of the key (the 5th byte of the serialized payload): 0 = the
	 * seed's MASTER key, higher values = successively deeper derivations (a BIP-44/
	 * 49/84 account is depth 3, a BIP-48 multisig account depth 4). parseXpub itself
	 * stays lenient — it returns depth rather than judging it — so low-level parsing/
	 * comparison/export paths keep working with any depth; ACCEPTANCE gates that
	 * import a key "as an account" use this to reject a depth-0 master, whose watch
	 * surface is the entire seed rather than the single account the user expects
	 * (cairn-b9iv).
	 */
	depth: number;
}

function hash160(data: Uint8Array): Uint8Array {
	return ripemd160(sha256(data));
}

// --------------------------------------------------- derivation memoization (cairn-8ubd)
//
// Address derivation is elliptic-curve heavy — every deriveChild is a secp256k1
// point op (parent-pubkey decompression + point multiply/add), and a CPU profile of
// the mixed-load harness put ~70% of non-idle server CPU inside this math (modular
// inverse / sqrt / point add), recomputed on every hot scan/watch pass. These three
// caches make repeat derivation of the SAME key free without changing a single
// derived value: derivation is a deterministic pure function of (key, change, index),
// so a cached result never goes stale, and every cache key is scoped to one exact key
// so nothing can leak across wallets.

/** Bounded cache of parsed extended keys, keyed on the trimmed input STRING. parseXpub
 *  is pure, so a cached ParsedXpub is always valid; its HDKey is immutable (deriveChild
 *  returns fresh nodes), so sharing one instance across callers is safe. Caching removes
 *  the base58 decode + EC point-decompress cost on repeat parses AND stabilizes the
 *  HDKey identity the two caches below key on. Failures are never cached. Insertion-order
 *  (FIFO) eviction — a Map iterates in insertion order. */
const PARSE_CACHE_MAX = 512;
const parseCache = new Map<string, ParsedXpub>();

/** Per-account change-node cache: account HDKey → [receive node, change node]. Keyed on
 *  the account HDKey's object identity (WeakMap, collected with the key), so it can only
 *  ever serve the node derived from that exact immutable parent — no cross-wallet leak.
 *  Halves a fresh gap-limit scan's CKDpub ops: the change node (m/<change>) used to be
 *  re-derived once per index and is now derived once per chain. Persists across requests
 *  because parseXpub hands back the same cached account HDKey. */
const changeNodeCache = new WeakMap<HDKey, [HDKey | undefined, HDKey | undefined]>();

function changeNode(account: HDKey, change: 0 | 1): HDKey {
	let slot = changeNodeCache.get(account);
	if (!slot) {
		slot = [undefined, undefined];
		changeNodeCache.set(account, slot);
	}
	let node = slot[change];
	if (!node) {
		node = account.deriveChild(change);
		slot[change] = node;
	}
	return node;
}

/** Stable address-cache key PREFIX for a parsed key: `<scriptType>|<canonical xpub>`.
 *  scriptType is included so a ypub (p2sh-p2wpkh) and a zpub (p2wpkh) that normalize to
 *  the SAME underlying xpub bytes — and therefore the same publicExtendedKey — never
 *  collide into one address (their script forms derive different addresses). Memoized per
 *  HDKey so the base58 re-encode of publicExtendedKey isn't paid on every derivation. */
const keyPrefixCache = new WeakMap<HDKey, string>();

function addrKeyPrefix(parsed: ParsedXpub): string {
	let pfx = keyPrefixCache.get(parsed.hdkey);
	if (pfx === undefined) {
		pfx = parsed.scriptType + '|' + parsed.hdkey.publicExtendedKey;
		keyPrefixCache.set(parsed.hdkey, pfx);
	}
	return pfx;
}

/** Bounded cache of fully-derived addresses, keyed on `<scriptType>|<xpub>|<change>|<index>`
 *  (see addrKeyPrefix for why scriptType is in the key). A warm wallet's repeat scan then
 *  does zero EC work — the dominant win for the mixed-load cliff, where the same wallet is
 *  re-scanned on every send GET. Stores only the address string; the trivial path label is
 *  reconstructed on read, so callers never share a mutable object. FIFO eviction; the cap
 *  covers the warm address set (~40-80 addresses) of hundreds of active wallets at once. */
const ADDR_CACHE_MAX = 20_000;
const addrCache = new Map<string, string>();

function cachePut<V>(cache: Map<string, V>, max: number, key: string, value: V): void {
	if (cache.size >= max) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

/**
 * Parse an xpub / ypub / zpub (SLIP-132, mainnet). ypub/zpub are normalized by
 * swapping the version bytes to standard xpub bytes before handing the key to
 * @scure/bip32; the original prefix determines the script type.
 * Throws a descriptive Error on anything invalid.
 */
export function parseXpub(input: string): ParsedXpub {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Empty extended key');

	const cached = parseCache.get(trimmed);
	if (cached) return cached;

	let raw: Uint8Array;
	try {
		raw = b58check.decode(trimmed);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/checksum/i.test(msg)) throw new Error('Invalid checksum');
		throw new Error('Invalid base58 encoding');
	}
	if (raw.length !== 78) {
		throw new Error(`Invalid extended key length (expected 78 bytes, got ${raw.length})`);
	}

	const version =
		((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;

	if (PRIVATE_VERSIONS.has(version)) {
		throw new Error('This is a private extended key — import the public (xpub/ypub/zpub) version instead');
	}
	if (TESTNET_VERSIONS.has(version)) {
		throw new Error('Testnet extended keys are not supported (mainnet only)');
	}
	const scriptType = PUBLIC_VERSIONS[version];
	if (!scriptType) {
		throw new Error('Unrecognized extended key prefix');
	}

	// Normalize SLIP-132 version bytes to standard xpub bytes so HDKey accepts it.
	const normalized = new Uint8Array(raw);
	normalized[0] = (XPUB_VERSION >>> 24) & 0xff;
	normalized[1] = (XPUB_VERSION >>> 16) & 0xff;
	normalized[2] = (XPUB_VERSION >>> 8) & 0xff;
	normalized[3] = XPUB_VERSION & 0xff;

	let hdkey: HDKey;
	try {
		hdkey = HDKey.fromExtendedKey(b58check.encode(normalized));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Invalid extended key: ${msg}`);
	}
	if (!hdkey.publicKey) throw new Error('Extended key has no public key');

	const fingerprint = (hdkey.fingerprint >>> 0).toString(16).padStart(8, '0');
	const result: ParsedXpub = { scriptType, hdkey, fingerprint, depth: hdkey.depth };
	cachePut(parseCache, PARSE_CACHE_MAX, trimmed, result);
	return result;
}

/**
 * Derive the address at m/<change>/<index> relative to the account xpub.
 * Path label is relative to the account key, e.g. "m/0/12".
 */
export function deriveAddress(
	parsed: ParsedXpub,
	change: 0 | 1,
	index: number
): { address: string; path: string } {
	if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
		throw new Error(`Invalid derivation index: ${index}`);
	}
	const path = `m/${change}/${index}`;

	// Warm path: a previously derived address for this exact (key, change, index) — no EC.
	const cacheKey = addrKeyPrefix(parsed) + '|' + change + '|' + index;
	const cachedAddr = addrCache.get(cacheKey);
	if (cachedAddr !== undefined) return { address: cachedAddr, path };

	const child = changeNode(parsed.hdkey, change).deriveChild(index);
	const pubkey = child.publicKey;
	if (!pubkey) throw new Error('Derived key has no public key');

	const pkh = hash160(pubkey);
	let address: string;
	switch (parsed.scriptType) {
		case 'p2pkh': {
			const payload = new Uint8Array(21);
			payload[0] = 0x00;
			payload.set(pkh, 1);
			address = b58check.encode(payload);
			break;
		}
		case 'p2sh-p2wpkh': {
			// redeemScript = OP_0 PUSH20 <pubkey hash>
			const redeem = new Uint8Array(22);
			redeem[0] = 0x00;
			redeem[1] = 0x14;
			redeem.set(pkh, 2);
			const payload = new Uint8Array(21);
			payload[0] = 0x05;
			payload.set(hash160(redeem), 1);
			address = b58check.encode(payload);
			break;
		}
		case 'p2wpkh': {
			const words = [0, ...bech32.toWords(pkh)];
			address = bech32.encode('bc', words);
			break;
		}
		default:
			throw new Error(`Unsupported script type: ${parsed.scriptType}`);
	}
	cachePut(addrCache, ADDR_CACHE_MAX, cacheKey, address);
	return { address, path };
}

/**
 * Decode a mainnet address to its scriptPubKey bytes.
 * Supports base58check P2PKH ("1…") / P2SH ("3…") and bech32/bech32m
 * segwit v0 ("bc1q…") / v1 ("bc1p…"). Throws on invalid input.
 */
export function addressToScriptPubKey(address: string): Uint8Array {
	const addr = address.trim();
	if (!addr) throw new Error('Empty address');

	if (/^bc1/i.test(addr)) {
		// bech32 requires all-lower or all-upper; the decoder enforces the rest.
		let version: number;
		let program: Uint8Array;
		try {
			const dec = bech32.decode(addr as `bc1${string}`);
			if (dec.prefix !== 'bc') throw new Error('Wrong network prefix');
			version = dec.words[0];
			if (version !== 0) throw new Error('Segwit v1+ must use bech32m');
			program = bech32.fromWords(dec.words.slice(1));
		} catch {
			// Not valid bech32 (or not v0) — try bech32m for segwit v1+.
			let dec;
			try {
				dec = bech32m.decode(addr as `bc1${string}`);
			} catch {
				throw new Error('Invalid bech32 address');
			}
			if (dec.prefix !== 'bc') throw new Error('Invalid address: wrong network prefix');
			version = dec.words[0];
			if (version < 1 || version > 16) throw new Error('Invalid segwit version');
			program = bech32m.fromWords(dec.words.slice(1));
		}

		if (version === 0) {
			if (program.length !== 20 && program.length !== 32) {
				throw new Error('Invalid segwit v0 program length');
			}
		} else {
			if (program.length < 2 || program.length > 40) {
				throw new Error('Invalid segwit program length');
			}
			if (version === 1 && program.length !== 32) {
				throw new Error('Invalid taproot program length');
			}
		}

		const script = new Uint8Array(2 + program.length);
		script[0] = version === 0 ? 0x00 : 0x50 + version; // OP_0 / OP_1..OP_16
		script[1] = program.length;
		script.set(program, 2);
		return script;
	}

	let payload: Uint8Array;
	try {
		payload = b58check.decode(addr);
	} catch {
		throw new Error('Invalid address encoding');
	}
	if (payload.length !== 21) throw new Error('Invalid address payload length');
	const version = payload[0];
	const h = payload.subarray(1);

	if (version === 0x00) {
		// P2PKH: OP_DUP OP_HASH160 PUSH20 <h> OP_EQUALVERIFY OP_CHECKSIG
		const script = new Uint8Array(25);
		script[0] = 0x76;
		script[1] = 0xa9;
		script[2] = 0x14;
		script.set(h, 3);
		script[23] = 0x88;
		script[24] = 0xac;
		return script;
	}
	if (version === 0x05) {
		// P2SH: OP_HASH160 PUSH20 <h> OP_EQUAL
		const script = new Uint8Array(23);
		script[0] = 0xa9;
		script[1] = 0x14;
		script.set(h, 2);
		script[22] = 0x87;
		return script;
	}
	throw new Error('Unknown address version byte (mainnet only)');
}

/** Human-readable bech32 prefixes the explorer accepts, across every network. */
const EXPLORER_BECH32_PREFIXES = new Set(['bc', 'tb', 'bcrt']);

/** base58check version bytes the explorer accepts (P2PKH / P2SH, all networks). */
const EXPLORER_BASE58_VERSIONS = new Set([
	0x00, // mainnet P2PKH
	0x05, // mainnet P2SH
	0x6f, // testnet/regtest P2PKH
	0xc4 // testnet/regtest P2SH
]);

/**
 * Network-agnostic structural validity check for the block explorer.
 *
 * Unlike {@link addressToScriptPubKey}/{@link isValidAddress} (mainnet only, by
 * design — wallet code relies on that strictness), this accepts addresses on
 * mainnet, testnet/signet AND regtest. The explorer only ever forwards the
 * address string to the Electrum server (as a scripthash lookup), so a
 * checksum-validated, network-agnostic gate is all that's needed to unblock
 * bcrt1/tb1 lookups.
 *
 * Accepts:
 *   - bech32/bech32m with HRP 'bc' | 'tb' | 'bcrt'; witness v0 program of 20 or
 *     32 bytes, v1 of exactly 32 bytes (taproot), v2..v16 of 2-40 bytes. Rejects
 *     v0 encoded as bech32m and v1+ encoded as bech32 (BIP-350 mixing), and
 *     mixed-case (the @scure decoder enforces the latter).
 *   - base58check P2PKH/P2SH with a 21-byte payload and a version byte of
 *     0x00/0x05 (mainnet) or 0x6f/0xc4 (testnet+regtest).
 */
export function isExplorerAddress(s: string): boolean {
	const addr = s.trim();
	if (!addr) return false;

	if (/^(bc|tb|bcrt)1/i.test(addr)) {
		let version: number;
		let program: Uint8Array;
		try {
			const dec = bech32.decode(addr as `${string}1${string}`);
			if (!EXPLORER_BECH32_PREFIXES.has(dec.prefix)) return false;
			version = dec.words[0];
			if (version !== 0) return false; // v1+ must use bech32m
			program = bech32.fromWords(dec.words.slice(1));
		} catch {
			// Not valid plain bech32 (or not v0) — try bech32m for segwit v1+.
			let dec;
			try {
				dec = bech32m.decode(addr as `${string}1${string}`);
			} catch {
				return false;
			}
			if (!EXPLORER_BECH32_PREFIXES.has(dec.prefix)) return false;
			version = dec.words[0];
			if (version < 1 || version > 16) return false;
			program = bech32m.fromWords(dec.words.slice(1));
		}

		if (version === 0) {
			return program.length === 20 || program.length === 32;
		}
		if (version === 1) {
			return program.length === 32; // taproot
		}
		return program.length >= 2 && program.length <= 40;
	}

	let payload: Uint8Array;
	try {
		payload = b58check.decode(addr);
	} catch {
		return false;
	}
	if (payload.length !== 21) return false;
	return EXPLORER_BASE58_VERSIONS.has(payload[0]);
}

/**
 * The scriptPubKey of an address, as lowercase hex.
 *
 * Used to attribute on-chain transaction outputs/inputs to a wallet by SCRIPT
 * rather than by address string. The script is network-independent (a P2WPKH is
 * `0014<hash>` whether the address reads `bc1…` or `bcrt1…`), so this matches
 * correctly even when the explorer reports a different network's encoding than
 * Cairn's mainnet-only derivation produces — which is why the balance (computed
 * from the same script via the scripthash) is right while a naive address-string
 * comparison would miss every match.
 */
export function scriptPubKeyHex(address: string): string {
	return bytesToHex(addressToScriptPubKey(address));
}

/**
 * Electrum scripthash: sha256(scriptPubKey) with the byte order reversed, hex-encoded.
 */
export function addressToScripthash(address: string): string {
	const script = addressToScriptPubKey(address);
	const hash = sha256(script);
	hash.reverse();
	return bytesToHex(hash);
}

export function isValidAddress(s: string): boolean {
	try {
		addressToScriptPubKey(s);
		return true;
	} catch {
		return false;
	}
}

export function isValidXpub(s: string): boolean {
	try {
		parseXpub(s);
		return true;
	} catch {
		return false;
	}
}
