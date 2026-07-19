// Extended-public-key parsing, address derivation and address <-> script helpers.
// Pure functions, no I/O. Address ENCODING (deriveAddress) and DECODING
// (addressToScriptPubKey / isValidAddress) are network-aware (cairn-xqnn7),
// exactly like extended-key PREFIX validation (parseXpub, cairn-10ox): every
// one of these accepts an explicit `network` argument and otherwise defaults
// to whatever the configured chain backend is set to (see `setDefaultNetwork`
// below), so callers that don't pass one explicitly still encode/validate
// against the right network without every call site having to import
// settings.ts. Before cairn-xqnn7 this file derived/accepted mainnet `bc1…`
// addresses ONLY, regardless of the instance's configured network — that's
// what made a regtest/testnet instance render unusable receive addresses and
// reject legitimate same-network send destinations.

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createBase58check, bech32, bech32m } from '@scure/base';
import type { ChainNetwork, ScriptType } from '$lib/types';

const b58check = createBase58check(sha256);

/** SLIP-132 mainnet public version bytes -> script type. */
const PUBLIC_VERSIONS: Record<number, ScriptType> = {
	0x0488b21e: 'p2pkh', // xpub (BIP44)
	0x049d7cb2: 'p2sh-p2wpkh', // ypub (BIP49)
	0x04b24746: 'p2wpkh' // zpub (BIP84)
};

/** SLIP-132 mainnet private version bytes (rejected with a helpful error). */
const PRIVATE_VERSIONS = new Set([0x0488ade4 /* xprv */, 0x049d7878 /* yprv */, 0x04b2430c /* zprv */]);

/**
 * SLIP-132 testnet/regtest public version bytes -> script type. Bitcoin has no
 * separate regtest version-byte namespace — regtest reuses the testnet bytes —
 * so this single table covers both networks (mirrored by isTestnetLike below).
 */
const TESTNET_PUBLIC_VERSIONS: Record<number, ScriptType> = {
	0x043587cf: 'p2pkh', // tpub
	0x044a5262: 'p2sh-p2wpkh', // upub
	0x045f1cf6: 'p2wpkh' // vpub
};

/** SLIP-132 testnet/regtest private version bytes (rejected with a helpful error). */
const TESTNET_PRIVATE_VERSIONS = new Set([0x04358394 /* tprv */, 0x044a4e28 /* uprv */, 0x045f18bc /* vprv */]);

/** Networks that share the testnet SLIP-132 version-byte namespace. */
function isTestnetLike(network: ChainNetwork): boolean {
	return network === 'testnet' || network === 'regtest';
}

/**
 * Address-level (NOT extended-key) network parameters: the bech32 HRP and
 * base58check version bytes a network's OWN addresses use — as opposed to the
 * SLIP-132 xpub/ypub/zpub version-byte tables above, which describe extended
 * KEYS. Regtest has no separate address namespace of its own either — it
 * reuses testnet's base58/WIF version bytes, same as it reuses testnet's
 * SLIP-132 extended-key bytes — so only the bech32 HRP (`bcrt` vs `tb`)
 * distinguishes a regtest address from a testnet one. Exported so multisig.ts
 * can build the same network parameters for @scure/btc-signer's payment
 * builders (p2wsh/p2sh) instead of keeping its own copy that could drift.
 */
export function networkParams(network: ChainNetwork): {
	bech32: string;
	pubKeyHash: number;
	scriptHash: number;
	wif: number;
} {
	if (network === 'mainnet') return { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };
	if (network === 'testnet') return { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
	return { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef }; // regtest
}

/** Plain-language network name for user-facing copy — never raw terms like
 *  "HRP" or "version bytes" (per docs/DESIGN-MANIFESTO.md). Mirrors the
 *  existing send-flow wording ("this wallet uses regular Bitcoin (mainnet)"). */
export function networkLabel(network: ChainNetwork): string {
	if (network === 'mainnet') return 'regular Bitcoin (mainnet)';
	if (network === 'testnet') return 'a test network (testnet)';
	return 'a test network (regtest)';
}

/** Standard BIP32 mainnet xpub version bytes. */
const XPUB_VERSION = 0x0488b21e;

/**
 * The network parseXpub validates against when a caller doesn't pass one
 * explicitly, kept in sync with the configured chain backend (cairn-10ox) by
 * {@link setDefaultNetwork} — called once whenever the backend is (re)configured
 * (see chain/index.ts's ChainService constructor). Defaults to 'mainnet' so any
 * call site that hasn't been migrated, and every existing test, keeps its
 * original mainnet-only behavior.
 */
let defaultNetwork: ChainNetwork = 'mainnet';

/** Sync parseXpub's default network with the currently configured chain backend. */
export function setDefaultNetwork(network: ChainNetwork): void {
	defaultNetwork = network;
}

/** The network parseXpub currently defaults to (test/inspection helper). */
export function getDefaultNetwork(): ChainNetwork {
	return defaultNetwork;
}

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
 * Parse an xpub / ypub / zpub (SLIP-132). Accepts mainnet OR testnet/regtest
 * version bytes depending on `network` (default: {@link getDefaultNetwork}, kept
 * in sync with the configured chain backend — cairn-10ox); a key whose prefix
 * belongs to the OTHER network family is always rejected, in both directions —
 * this is a Bitcoin-correctness boundary, not just UX friction; a mainnet
 * backend must never accept a testnet/regtest key and vice versa. ypub/zpub
 * (or their testnet upub/vpub counterparts) are normalized by swapping the
 * version bytes to standard xpub bytes before handing the key to @scure/bip32;
 * the original prefix determines the script type. Throws a descriptive Error
 * on anything invalid.
 */
export function parseXpub(input: string, network: ChainNetwork = defaultNetwork): ParsedXpub {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Empty extended key');

	// The network is part of the cache key: the SAME string must be free to
	// parse differently (accept vs reject) depending on which network it's
	// validated against — e.g. a regtest admin later switching to mainnet must
	// not have a stale "accepted" result served back for a tpub (cairn-10ox).
	const cacheKey = network + '|' + trimmed;
	const cached = parseCache.get(cacheKey);
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

	if (PRIVATE_VERSIONS.has(version) || TESTNET_PRIVATE_VERSIONS.has(version)) {
		throw new Error('This is a private extended key — import the public (xpub/ypub/zpub) version instead');
	}

	const testnetBackend = isTestnetLike(network);
	let scriptType: ScriptType | undefined;
	if (testnetBackend) {
		if (PUBLIC_VERSIONS[version]) {
			throw new Error(
				`Mainnet extended keys are not supported on a ${network} backend — import the testnet/regtest (tpub/upub/vpub) version instead`
			);
		}
		scriptType = TESTNET_PUBLIC_VERSIONS[version];
	} else {
		if (TESTNET_PUBLIC_VERSIONS[version]) {
			throw new Error('Testnet/regtest extended keys are not supported on a mainnet backend');
		}
		scriptType = PUBLIC_VERSIONS[version];
	}
	if (!scriptType) {
		throw new Error('Unrecognized extended key prefix');
	}

	// Normalize SLIP-132 version bytes to standard xpub bytes so HDKey accepts it.
	// This is purely an internal representation for @scure/bip32 — it does not
	// change which network the ORIGINAL prefix was validated against above, and
	// address derivation stays mainnet-encoded regardless (see file header).
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
	cachePut(parseCache, PARSE_CACHE_MAX, cacheKey, result);
	return result;
}

/**
 * Derive the address at m/<change>/<index> relative to the account xpub.
 * Path label is relative to the account key, e.g. "m/0/12". `network`
 * (cairn-xqnn7) controls the address ENCODING only — bech32 HRP and
 * base58check version byte — never which key/pubkey is derived; it defaults
 * to {@link getDefaultNetwork}, kept in sync with the configured chain
 * backend, so existing callers that don't pass one explicitly now render the
 * instance's actual network instead of always mainnet.
 */
export function deriveAddress(
	parsed: ParsedXpub,
	change: 0 | 1,
	index: number,
	network: ChainNetwork = defaultNetwork
): { address: string; path: string } {
	if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
		throw new Error(`Invalid derivation index: ${index}`);
	}
	const path = `m/${change}/${index}`;
	const net = networkParams(network);

	// Warm path: a previously derived address for this exact (key, change, index,
	// network) — no EC. `network` is part of the key so the SAME xpub never serves
	// a cached mainnet address back for a regtest lookup or vice versa.
	const cacheKey = network + '|' + addrKeyPrefix(parsed) + '|' + change + '|' + index;
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
			payload[0] = net.pubKeyHash;
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
			payload[0] = net.scriptHash;
			payload.set(hash160(redeem), 1);
			address = b58check.encode(payload);
			break;
		}
		case 'p2wpkh': {
			const words = [0, ...bech32.toWords(pkh)];
			address = bech32.encode(net.bech32, words);
			break;
		}
		default:
			throw new Error(`Unsupported script type: ${parsed.scriptType}`);
	}
	cachePut(addrCache, ADDR_CACHE_MAX, cacheKey, address);
	return { address, path };
}

/**
 * Decode an address to its scriptPubKey bytes, validating it against `network`
 * (cairn-xqnn7; default: {@link getDefaultNetwork}, kept in sync with the
 * configured chain backend). Supports base58check P2PKH ("1…"/"m…"/"n…") /
 * P2SH ("3…"/"2…") and bech32/bech32m segwit v0 ("bc1q…"/"tb1q…"/"bcrt1q…") /
 * v1 ("bc1p…"/…). An address whose HRP or version byte belongs to a DIFFERENT
 * network throws a plain-language network-mismatch error rather than being
 * silently rejected as merely "invalid" — this is what lets the send flow and
 * wallet import tell a user "this address is for a different network" instead
 * of a generic parse failure.
 */
export function addressToScriptPubKey(address: string, network: ChainNetwork = defaultNetwork): Uint8Array {
	const addr = address.trim();
	if (!addr) throw new Error('Empty address');
	const net = networkParams(network);
	const mismatch = () =>
		new Error(`This address doesn't match this wallet's network — this wallet uses ${networkLabel(network)}.`);

	// Bech32/bech32m addresses across ALL networks share the same shape
	// (`<hrp>1...`); every known Bitcoin HRP is checked here so a wrong-network
	// bech32 address is recognized as such (mismatch()) rather than falling
	// through to the base58 branch and failing with a confusing decode error.
	if (/^(bc|tb|bcrt)1/i.test(addr)) {
		let version: number;
		let program: Uint8Array;
		let prefix: string;
		try {
			const dec = bech32.decode(addr as `${string}1${string}`);
			prefix = dec.prefix;
			version = dec.words[0];
			if (version !== 0) throw new Error('Segwit v1+ must use bech32m');
			program = bech32.fromWords(dec.words.slice(1));
		} catch {
			// Not valid bech32 (or not v0) — try bech32m for segwit v1+.
			let dec;
			try {
				dec = bech32m.decode(addr as `${string}1${string}`);
			} catch {
				throw new Error('Invalid bech32 address');
			}
			prefix = dec.prefix;
			version = dec.words[0];
			if (version < 1 || version > 16) throw new Error('Invalid segwit version');
			program = bech32m.fromWords(dec.words.slice(1));
		}
		if (prefix !== net.bech32) throw mismatch();

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

	if (version === net.pubKeyHash) {
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
	if (version === net.scriptHash) {
		// P2SH: OP_HASH160 PUSH20 <h> OP_EQUAL
		const script = new Uint8Array(23);
		script[0] = 0xa9;
		script[1] = 0x14;
		script.set(h, 2);
		script[22] = 0x87;
		return script;
	}
	// A recognized base58 version byte for a DIFFERENT network (e.g. a mainnet
	// "1…"/"3…" address decoded against a regtest wallet) is a network
	// mismatch, not a generically "unknown" address.
	const other = network === 'mainnet' ? networkParams('regtest') : networkParams('mainnet');
	if (version === other.pubKeyHash || version === other.scriptHash) throw mismatch();
	throw new Error('Unknown address version byte');
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
 * rather than by address string — the script itself is network-independent (a
 * P2WPKH is `0014<hash>` whether the address reads `bc1…` or `bcrt1…`), but
 * `network` (cairn-xqnn7; default: {@link getDefaultNetwork}) still gates which
 * address STRINGS are accepted here, so a foreign-network address can't be
 * silently matched in — see {@link addressToScriptPubKey}.
 */
export function scriptPubKeyHex(address: string, network: ChainNetwork = defaultNetwork): string {
	return bytesToHex(addressToScriptPubKey(address, network));
}

/**
 * Electrum scripthash: sha256(scriptPubKey) with the byte order reversed, hex-encoded.
 */
export function addressToScripthash(address: string, network: ChainNetwork = defaultNetwork): string {
	const script = addressToScriptPubKey(address, network);
	const hash = sha256(script);
	hash.reverse();
	return bytesToHex(hash);
}

export function isValidAddress(s: string, network: ChainNetwork = defaultNetwork): boolean {
	try {
		addressToScriptPubKey(s, network);
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
