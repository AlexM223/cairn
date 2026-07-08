// SPV (Simplified Payment Verification) primitives — merkle-proof + proof-of-work
// checks used to independently verify that a transaction really is confirmed in a
// block before Cairn trusts an Electrum server's history enough to raise a
// user-facing payment notification (cairn-7zj6).
//
// Without this, a hostile or buggy Electrum server can invent a txid and Cairn
// would fire a "payment received" alert for a transaction that never existed.
// With it, the server must produce (a) a block header that actually satisfies its
// own stated proof-of-work target and (b) a merkle branch linking our txid to
// that header's merkle root. Forging either would require real mining work at the
// current network difficulty — the standard SPV security assumption.
//
// This module is pure and framework-free (no DB, no network) so it is fully unit
// testable against known mainnet blocks. The network fetch of the header and the
// merkle branch lives in the Electrum client; the caller wires the two together.
//
// Byte-order note: Electrum returns txids and merkle-branch hashes as
// DISPLAY-order hex (big-endian, the reverse of Bitcoin's internal little-endian
// wire order). All hashing here is done in internal order and the results are
// reversed back to display order, so every string this module accepts or returns
// is display-order hex — directly comparable to what Electrum and block explorers
// show.

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils.js';

function sha256d(b: Uint8Array): Uint8Array {
	return sha256(sha256(b));
}

/** A fresh reversed copy (never mutates the input). */
function reversed(b: Uint8Array): Uint8Array {
	return Uint8Array.from(b).reverse();
}

export interface BlockHeader {
	version: number;
	/** Previous block hash, display-order hex. */
	prevHash: string;
	/** Merkle root, display-order hex. */
	merkleRoot: string;
	time: number;
	/** Compact difficulty target ("bits"), as a uint32. */
	bits: number;
	nonce: number;
}

/** Parse an 80-byte block header (hex) into its fields. Throws on wrong length. */
export function parseBlockHeader(headerHex: string): BlockHeader {
	const b = hexToBytes(headerHex.trim());
	if (b.length !== 80) {
		throw new Error(`block header must be 80 bytes, got ${b.length}`);
	}
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	return {
		version: view.getInt32(0, true),
		prevHash: bytesToHex(reversed(b.slice(4, 36))),
		merkleRoot: bytesToHex(reversed(b.slice(36, 68))),
		time: view.getUint32(68, true),
		bits: view.getUint32(72, true),
		nonce: view.getUint32(76, true)
	};
}

/** The block hash (double-SHA256 of the 80-byte header), display-order hex. */
export function blockHash(headerHex: string): string {
	return bytesToHex(reversed(sha256d(hexToBytes(headerHex.trim()))));
}

/**
 * The largest value a 256-bit hash can ever take (2^256 − 1). A compact "bits"
 * encoding can name an exponent up to 255, which expands to a target far beyond
 * this — at which point EVERY possible hash "meets" it, i.e. the field no longer
 * expresses a real difficulty at all. Any such encoding is rejected outright
 * (cairn-8kbw) rather than treated as an astronomically easy-but-valid target.
 */
export const MAX_256_BIT_VALUE = (1n << 256n) - 1n;

/**
 * Expand the compact "bits" encoding into the full 256-bit difficulty target.
 * target = mantissa · 256^(exponent−3), matching Bitcoin Core's `CompactToBig`.
 */
export function bitsToTarget(bits: number): bigint {
	const exponent = bits >>> 24;
	const mantissa = BigInt(bits & 0x007fffff);
	if (exponent <= 3) return mantissa >> BigInt(8 * (3 - exponent));
	return mantissa << BigInt(8 * (exponent - 3));
}

/** True when a block hash (display-order hex) satisfies the target encoded in `bits`. */
export function meetsTarget(blockHashDisplayHex: string, bits: number): boolean {
	const target = bitsToTarget(bits);
	// Reject a zero/negative target (unsatisfiable) and an absurd-exponent
	// encoding whose target exceeds every possible 256-bit hash (trivially
	// "satisfied" by anything, i.e. no real proof-of-work at all).
	if (target <= 0n || target > MAX_256_BIT_VALUE) return false;
	const value = BigInt('0x' + blockHashDisplayHex.trim());
	return value <= target;
}

/**
 * Recompute a block's merkle root from a transaction and its merkle branch.
 * `txid` and each `branch` hash are display-order hex (Electrum's get_merkle
 * form); `pos` is the transaction's index within the block. Returns the merkle
 * root as display-order hex, comparable to parseBlockHeader().merkleRoot.
 */
export function merkleRootFromProof(txid: string, branch: string[], pos: number): string {
	if (!Number.isInteger(pos) || pos < 0) throw new Error(`invalid merkle position ${pos}`);
	let acc = reversed(hexToBytes(txid.trim())); // → internal order
	let index = pos;
	for (const sibHex of branch) {
		const sib = reversed(hexToBytes(sibHex.trim()));
		// A sibling on the left (odd index) is concatenated before us; on the right,
		// after us. Bitcoin duplicates the last hash for odd rows, which Electrum
		// already folds into the branch it returns, so we never special-case it.
		const pair = (index & 1) === 1 ? concatBytes(sib, acc) : concatBytes(acc, sib);
		acc = sha256d(pair);
		index >>= 1;
	}
	return bytesToHex(reversed(acc)); // → display order
}

export interface MerkleProof {
	/** Sibling hashes bottom-to-top, display-order hex (Electrum's `merkle`). */
	merkle: string[];
	/** The transaction's index within its block (Electrum's `pos`). */
	pos: number;
}

export interface InclusionResult {
	ok: boolean;
	/** Machine-readable reason when ok === false (for logs). */
	reason?: string;
}

/**
 * Verify that `txid` is really included in a confirmed block, given the block's
 * 80-byte header and a merkle branch for the tx. Checks, in order:
 *   1. the tx is actually confirmed (height > 0) and not beyond the known tip;
 *   2. the header satisfies its own proof-of-work target (forging it needs real
 *      mining work — this is what makes the branch trustworthy);
 *   3. (optional, via `maxTarget`) the header's target isn't merely
 *      self-consistent but also plausible against real network difficulty — see
 *      the `maxTarget` doc below;
 *   4. the merkle branch reconstructs exactly the header's merkle root.
 * Returns { ok: true } only when all held checks hold.
 */
export function verifyTxInclusion(params: {
	txid: string;
	height: number;
	proof: MerkleProof;
	headerHex: string;
	tipHeight: number;
	/**
	 * Upper bound (inclusive) on the header's expanded target, independent of
	 * the header's own `bits` field. Checking a header's hash against its own
	 * `bits` (step 2 above) only proves internal self-consistency — a hostile
	 * server can set `bits` to a trivially easy target and mine it in
	 * milliseconds. Callers that track real chain difficulty (e.g. a rolling
	 * cache of recently observed tip headers) should pass the loosest target
	 * they're willing to accept here to make that forgery cost real mining work
	 * (cairn-8kbw). Omit to skip this check (self-consistency only).
	 */
	maxTarget?: bigint;
}): InclusionResult {
	const { txid, height, proof, headerHex, tipHeight, maxTarget } = params;

	if (!Number.isInteger(height) || height <= 0) return { ok: false, reason: 'unconfirmed' };
	if (Number.isInteger(tipHeight) && tipHeight > 0 && height > tipHeight) {
		return { ok: false, reason: 'height_above_tip' };
	}

	let header: BlockHeader;
	try {
		header = parseBlockHeader(headerHex);
	} catch {
		return { ok: false, reason: 'bad_header' };
	}

	if (!meetsTarget(blockHash(headerHex), header.bits)) {
		return { ok: false, reason: 'insufficient_pow' };
	}

	if (maxTarget !== undefined && bitsToTarget(header.bits) > maxTarget) {
		return { ok: false, reason: 'weak_target' };
	}

	let root: string;
	try {
		root = merkleRootFromProof(txid, proof.merkle, proof.pos);
	} catch {
		return { ok: false, reason: 'bad_proof' };
	}
	if (root.toLowerCase() !== header.merkleRoot.toLowerCase()) {
		return { ok: false, reason: 'merkle_mismatch' };
	}

	return { ok: true };
}
