import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	parseBlockHeader,
	blockHash,
	bitsToTarget,
	meetsTarget,
	merkleRootFromProof,
	verifyTxInclusion,
	MAX_256_BIT_VALUE
} from './spv';

// ── Independent reference merkle implementation (Node crypto, not the module's
// noble hashing) so the branch-pairing/byte-order logic is checked against a
// second, separately-written implementation rather than only against itself.
function refSha256d(b: Buffer): Buffer {
	return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}
function refRev(hex: string): Buffer {
	return Buffer.from(hex, 'hex').reverse();
}
/** Full merkle root (display hex) of a list of display-order txids. */
function refRoot(txids: string[]): string {
	let level = txids.map(refRev); // internal order
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]); // duplicate last
		const next: Buffer[] = [];
		for (let i = 0; i < level.length; i += 2) next.push(refSha256d(Buffer.concat([level[i], level[i + 1]])));
		level = next;
	}
	return Buffer.from(level[0]).reverse().toString('hex');
}
/** The Electrum-style merkle branch (display hex siblings) for one leaf index. */
function refBranch(txids: string[], index: number): string[] {
	let level = txids.map(refRev);
	let idx = index;
	const branch: string[] = [];
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]);
		const sib = idx ^ 1;
		branch.push(Buffer.from(level[sib]).reverse().toString('hex')); // display order
		idx >>= 1;
		const next: Buffer[] = [];
		for (let i = 0; i < level.length; i += 2) next.push(refSha256d(Buffer.concat([level[i], level[i + 1]])));
		level = next;
	}
	return branch;
}
function synthTxids(n: number): string[] {
	// Deterministic pseudo-txids — just distinct 32-byte hex strings.
	return Array.from({ length: n }, (_, i) =>
		Buffer.from(createHash('sha256').update(`leaf-${i}`).digest()).toString('hex')
	);
}

// ── Header encoder + miner (cairn-8kbw), independent of parseBlockHeader —
// lets these tests build genuinely PoW-valid synthetic headers at a chosen
// (loose) target instead of only ever using the one real mainnet fixture.
interface HeaderFields {
	version: number;
	prevHash: string;
	merkleRoot: string;
	time: number;
	bits: number;
	nonce: number;
}
function encodeHeader(f: HeaderFields): string {
	const buf = Buffer.alloc(80);
	buf.writeInt32LE(f.version, 0);
	Buffer.from(f.prevHash, 'hex').reverse().copy(buf, 4);
	Buffer.from(f.merkleRoot, 'hex').reverse().copy(buf, 36);
	buf.writeUInt32LE(f.time, 68);
	buf.writeUInt32LE(f.bits, 72);
	buf.writeUInt32LE(f.nonce, 76);
	return buf.toString('hex');
}
/** Mine a real nonce so the header satisfies its own `bits`. Cheap for any of
 *  the loose ("regtest-style") targets used below. */
function mineHeader(fields: Omit<HeaderFields, 'nonce'>): string {
	for (let nonce = 0; nonce < 500_000; nonce++) {
		const hex = encodeHeader({ ...fields, nonce });
		if (meetsTarget(blockHash(hex), fields.bits)) return hex;
	}
	throw new Error('mining did not converge — target too tight for a test fixture');
}
/** A single-tx block's header: merkle root IS the (sole) txid, empty branch. */
function mineSingleTxHeader(bits: number, txid: string, time: number): string {
	return mineHeader({ version: 1, prevHash: '00'.repeat(32), merkleRoot: txid, time, bits });
}
function txidFor(seed: string): string {
	return createHash('sha256').update(seed).digest('hex');
}

// Regtest's real genesis `bits`: an intentionally huge/easy target. Used to
// pin down that the absurd-exponent ceiling clamp does NOT also reject
// legitimately loose regtest/testnet-style difficulty (cairn-8kbw explicitly
// requires regtest/testnet keep working — no hardcoded mainnet powLimit).
const REGTEST_BITS = 0x207fffff;

// Real mainnet fixtures — canonical, independently checkable on any block explorer.
//
// Block #1: a single-transaction block, so its merkle root IS the coinbase txid
// (empty merkle branch). Exercises header parsing, block-hash/PoW math.
const BLOCK1 = {
	header:
		'010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299',
	hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048',
	merkleRoot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
	bits: 0x1d00ffff
};

describe('parseBlockHeader / blockHash', () => {
	it('parses an 80-byte header into display-order fields', () => {
		const h = parseBlockHeader(BLOCK1.header);
		expect(h.merkleRoot).toBe(BLOCK1.merkleRoot);
		expect(h.bits).toBe(BLOCK1.bits);
		expect(h.version).toBe(1);
		// Block 1's previous block is the genesis block.
		expect(h.prevHash).toBe('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
	});

	it('computes the canonical block hash', () => {
		expect(blockHash(BLOCK1.header)).toBe(BLOCK1.hash);
	});

	it('rejects a header that is not 80 bytes', () => {
		expect(() => parseBlockHeader('00'.repeat(79))).toThrow();
	});
});

describe('proof-of-work target math', () => {
	it('expands difficulty-1 bits and confirms the block hash meets target', () => {
		// Difficulty-1 target: 0x00000000ffff0000...0000
		const target = bitsToTarget(0x1d00ffff);
		expect(target.toString(16)).toBe('ffff0000000000000000000000000000000000000000000000000000');
		expect(meetsTarget(BLOCK1.hash, BLOCK1.bits)).toBe(true);
	});

	it('rejects a hash above target', () => {
		// A hash numerically larger than the difficulty-1 target fails PoW.
		expect(meetsTarget('ff'.repeat(32), 0x1d00ffff)).toBe(false);
	});
});

describe('merkleRootFromProof', () => {
	it('returns the txid itself for a single-tx block (empty branch)', () => {
		expect(merkleRootFromProof(BLOCK1.merkleRoot, [], 0)).toBe(BLOCK1.merkleRoot);
	});

	// Cross-check every leaf of trees of several sizes (including odd counts, which
	// exercise Bitcoin's last-node duplication) against the independent reference.
	for (const n of [2, 3, 4, 5, 7, 8, 13]) {
		it(`reconstructs the root for every leaf of a ${n}-tx block`, () => {
			const txids = synthTxids(n);
			const root = refRoot(txids);
			for (let pos = 0; pos < n; pos++) {
				expect(merkleRootFromProof(txids[pos], refBranch(txids, pos), pos)).toBe(root);
			}
		});
	}
});

describe('verifyTxInclusion', () => {
	// Block 1 is single-tx: its real header carries valid PoW and a merkle root
	// equal to the coinbase txid, so { txid: merkleRoot, branch: [] } is a genuine,
	// fully self-consistent inclusion proof. (The branch-hashing math for multi-tx
	// blocks is covered exhaustively by the merkleRootFromProof cross-checks above;
	// a synthetic multi-leaf root can't be spliced into a real header without
	// invalidating its proof-of-work.)
	const good = {
		txid: BLOCK1.merkleRoot,
		height: 1,
		proof: { merkle: [] as string[], pos: 0 },
		headerHex: BLOCK1.header,
		tipHeight: 900_000
	};

	it('accepts a valid confirmed tx with real PoW + matching merkle root', () => {
		expect(verifyTxInclusion(good)).toEqual({ ok: true });
	});

	it('rejects an unconfirmed (mempool) tx that cannot be proven', () => {
		expect(verifyTxInclusion({ ...good, height: 0 })).toMatchObject({
			ok: false,
			reason: 'unconfirmed'
		});
	});

	it('rejects a height beyond the known chain tip', () => {
		expect(verifyTxInclusion({ ...good, height: 999_999 })).toMatchObject({
			ok: false,
			reason: 'height_above_tip'
		});
	});

	it('rejects a forged txid that does not match the block merkle root', () => {
		expect(verifyTxInclusion({ ...good, txid: 'de'.repeat(32) })).toMatchObject({
			ok: false,
			reason: 'merkle_mismatch'
		});
	});

	it('rejects a header that does not satisfy its own proof-of-work', () => {
		// Zero the nonce so the header no longer hashes below its target.
		const broken = BLOCK1.header.slice(0, -8) + '00000000';
		expect(verifyTxInclusion({ ...good, headerHex: broken })).toMatchObject({
			ok: false,
			reason: 'insufficient_pow'
		});
	});

	// cairn-qowa: 'bad_header' and 'bad_proof' were the two of the six verdict
	// branches with no test — a malformed header or branch from a hostile/buggy
	// Electrum server must produce its own reason code, never a crash and never
	// a pass. Every InclusionResult reason is now pinned.
	it("rejects a header that isn't 80 bytes with reason 'bad_header'", () => {
		expect(verifyTxInclusion({ ...good, headerHex: '00'.repeat(79) })).toMatchObject({
			ok: false,
			reason: 'bad_header'
		});
		// Garbage that isn't even hex is the same verdict, not a throw.
		expect(verifyTxInclusion({ ...good, headerHex: 'not-hex-at-all' })).toMatchObject({
			ok: false,
			reason: 'bad_header'
		});
	});

	it("rejects an unusable merkle branch with reason 'bad_proof'", () => {
		// A negative position can never index a merkle tree — the proof itself is
		// malformed, distinct from a well-formed proof that mismatches the root.
		expect(
			verifyTxInclusion({ ...good, proof: { merkle: [], pos: -1 } })
		).toMatchObject({ ok: false, reason: 'bad_proof' });
		// Non-hex sibling hashes are equally unusable.
		expect(
			verifyTxInclusion({ ...good, proof: { merkle: ['zz'.repeat(32)], pos: 0 } })
		).toMatchObject({ ok: false, reason: 'bad_proof' });
	});
});

// cairn-8kbw: the header's own `bits` field alone only proves internal
// self-consistency (a hostile Electrum server can invent a trivially-easy
// target and mine it in milliseconds). These tests cover the two independent
// hardenings: an outright ceiling on absurd-exponent target encodings, and the
// optional maxTarget parameter callers use to enforce a real difficulty floor.
describe('absurd-target rejection (bits encoding a target >= 2^256)', () => {
	// exponent 0x24 (36): shift = 8*(36-3) = 264 bits, so even a mantissa of 1
	// alone pushes the target's top bit past 2^256's, i.e. every possible
	// 256-bit hash would trivially "satisfy" it — not a real difficulty at all.
	const ABSURD_BITS = 0x24000001;

	it('bitsToTarget expands past MAX_256_BIT_VALUE for an absurd exponent', () => {
		expect(bitsToTarget(ABSURD_BITS)).toBeGreaterThan(MAX_256_BIT_VALUE);
	});

	it('meetsTarget rejects ANY hash — including an all-zero, minimal one — against an absurd target', () => {
		expect(meetsTarget('00'.repeat(32), ABSURD_BITS)).toBe(false);
		expect(meetsTarget('ff'.repeat(32), ABSURD_BITS)).toBe(false);
	});

	it("verifyTxInclusion rejects a header with an absurd-exponent bits as 'insufficient_pow'", () => {
		// Splice BLOCK1's real, otherwise-untouched header to carry the absurd
		// bits value (little-endian uint32 at header byte offset 72).
		const bitsLE = Buffer.alloc(4);
		bitsLE.writeUInt32LE(ABSURD_BITS, 0);
		const absurdHeader = BLOCK1.header.slice(0, 144) + bitsLE.toString('hex') + BLOCK1.header.slice(152);
		expect(
			verifyTxInclusion({
				txid: BLOCK1.merkleRoot,
				height: 1,
				proof: { merkle: [], pos: 0 },
				headerHex: absurdHeader,
				tipHeight: 900_000
			})
		).toMatchObject({
			ok: false,
			reason: 'insufficient_pow'
		});
	});
});

describe('weak_target rejection via verifyTxInclusion({ maxTarget })', () => {
	// A genuinely PoW-valid, regtest-style header (real mining work, just at an
	// intentionally loose difficulty) — self-consistent, so the base PoW check
	// alone passes it; only a caller-supplied maxTarget can catch it as "too
	// weak to trust as a real confirmation" (e.g. cairn-8kbw's cache-derived
	// difficulty floor).
	const txid = txidFor('weak-target-fixture');
	const headerHex = mineSingleTxHeader(REGTEST_BITS, txid, 1_700_000_001);
	const proof = { txid, height: 500, proof: { merkle: [] as string[], pos: 0 }, headerHex, tipHeight: 900_000 };

	it('passes with no maxTarget supplied (self-consistency only)', () => {
		expect(verifyTxInclusion(proof)).toEqual({ ok: true });
	});

	it('passes when maxTarget is looser than (or equal to) the header target', () => {
		const target = bitsToTarget(REGTEST_BITS);
		expect(verifyTxInclusion({ ...proof, maxTarget: target })).toEqual({ ok: true });
		expect(verifyTxInclusion({ ...proof, maxTarget: target * 100n })).toEqual({ ok: true });
	});

	it('rejects with weak_target when maxTarget is tighter than the header target', () => {
		expect(verifyTxInclusion({ ...proof, maxTarget: 1n })).toMatchObject({
			ok: false,
			reason: 'weak_target'
		});
	});
});

describe('regtest-style huge-target header (cairn-8kbw edge case: must keep working)', () => {
	it('a genuinely mined, real-PoW regtest-difficulty header passes full verification', () => {
		const txid = txidFor('regtest-full-pass');
		const headerHex = mineSingleTxHeader(REGTEST_BITS, txid, 1_700_000_002);
		expect(
			verifyTxInclusion({
				txid,
				height: 42,
				proof: { merkle: [], pos: 0 },
				headerHex,
				tipHeight: 1000
			})
		).toEqual({ ok: true });
	});
});
