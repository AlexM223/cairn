// Tests for cairn-8kbw's self-calibrating difficulty floor: the address
// watcher's rolling cache of recently observed live chain tips
// (addressWatcher.ts's tipCache/acceptHeaderIntoCache/spvVerifyConfirmed).
//
// spv.test.ts already exhaustively covers the pure PoW/target/merkle math
// (bitsToTarget, meetsTarget, verifyTxInclusion's maxTarget gate) against real
// mainnet fixtures and mined synthetic headers. This file is scoped to the
// orchestration layer on top of it: which headers the watcher's cache accepts
// off the live Electrum header stream, and how a confirmation proof is judged
// against that cache (exact-hash anchor for an observed height, the 4x
// difficulty floor for any other height, and failing closed on a cold cache).
//
// './bitcoin/spv' is intentionally NOT mocked here — the whole point of these
// tests is the real interaction between the cache and the real crypto, so
// every header below is a genuine, freshly mined 80-byte header that satisfies
// its own declared `bits` (never a fake stand-in).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---- minimal from-scratch header encoder + miner (independent of spv.ts's
// decoder, matching spv.test.ts's existing pattern of a second implementation
// rather than reusing the module under test to build its own fixtures). ----

function sha256d(b: Buffer): Buffer {
	return createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
}

interface HeaderFields {
	version: number;
	prevHash: string; // display-order hex
	merkleRoot: string; // display-order hex
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

function refBitsToTarget(bits: number): bigint {
	const exponent = bits >>> 24;
	const mantissa = BigInt(bits & 0x007fffff);
	if (exponent <= 3) return mantissa >> BigInt(8 * (3 - exponent));
	return mantissa << BigInt(8 * (exponent - 3));
}

function refDisplayHash(headerHex: string): string {
	return Buffer.from(sha256d(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');
}

/** Mine a real nonce so the header satisfies its own `bits`. Cheap for any of
 *  the loose ("regtest-style") targets used throughout this file. */
function mineHeader(fields: Omit<HeaderFields, 'nonce'>): string {
	const target = refBitsToTarget(fields.bits);
	for (let nonce = 0; nonce < 500_000; nonce++) {
		const hex = encodeHeader({ ...fields, nonce });
		if (BigInt('0x' + refDisplayHash(hex)) <= target) return hex;
	}
	throw new Error('mining did not converge — target too tight for a test fixture');
}

// Regtest's real genesis `bits` (0x207fffff): an intentionally huge/easy
// target, per cairn-8kbw's requirement that the self-calibrating floor must
// not hardcode a mainnet powLimit and must keep regtest/testnet working.
const REGTEST_BITS = 0x207fffff;
// A tighter but still trivially mineable target, used as a "harder" cached tip
// so a 4x-looser header can be told apart from it. One exponent step below
// REGTEST_BITS (0x1f vs 0x20) is a 256x difficulty gap — comfortably past the
// 4x floor — while still averaging only ~1000 mining attempts in a test.
const HARDER_BITS = 0x1f7fffff;

function singleTxHeader(bits: number, txid: string, opts: Partial<HeaderFields> = {}): string {
	return mineHeader({
		version: 1,
		prevHash: '00'.repeat(32),
		merkleRoot: txid, // single-tx block: merkle root IS the coinbase txid
		time: Math.floor(Date.now() / 1000),
		bits,
		...opts
	});
}

function randomTxid(seed: string): string {
	return createHash('sha256').update(seed).digest('hex');
}

// ---- fakes --------------------------------------------------------------

const electrum = {
	getMerkleProof: vi.fn(async () => ({ merkle: [] as string[], pos: 0 })),
	getBlockHeader: vi.fn(async (_height: number) => '00'.repeat(80))
};
const fakeChain = {
	electrum,
	getTip: vi.fn(async () => ({ height: 0, hash: '' }))
};
vi.mock('./chain/index', () => ({
	getChain: () => fakeChain
}));

import { _internals } from './addressWatcher';
const { state, acceptHeaderIntoCache, spvVerifyConfirmed, maxCachedTarget, DIFFICULTY_FLOOR_FACTOR } =
	_internals;

beforeEach(() => {
	state.tipCache.clear();
	state.tipHeight = 0;
	electrum.getMerkleProof.mockReset().mockResolvedValue({ merkle: [], pos: 0 });
	electrum.getBlockHeader.mockReset();
});

describe('acceptHeaderIntoCache', () => {
	it('accepts a real regtest-style huge-target header into an empty cache', () => {
		const hex = singleTxHeader(REGTEST_BITS, randomTxid('h1'), { time: 1000 });
		acceptHeaderIntoCache({ height: 100, hex });
		expect(state.tipCache.has(100)).toBe(true);
		expect(state.tipCache.get(100)!.target).toBe(refBitsToTarget(REGTEST_BITS));
	});

	it('rejects a header that fails its own declared PoW target', () => {
		// Mine a genuinely valid header, then corrupt the nonce so the resulting
		// hash no longer satisfies the (tight) target it claims.
		const good = singleTxHeader(HARDER_BITS, randomTxid('h2'), { time: 1000 });
		const corrupted = good.slice(0, -8) + '00000000';
		acceptHeaderIntoCache({ height: 200, hex: corrupted });
		expect(state.tipCache.has(200)).toBe(false);
	});

	it('rejects a subsequent tip whose target is more than 4x looser than the cached max', () => {
		acceptHeaderIntoCache({ height: 300, hex: singleTxHeader(HARDER_BITS, randomTxid('h3'), { time: 1000 }) });
		const priorMax = maxCachedTarget();

		// REGTEST_BITS' target is 256x looser than HARDER_BITS' — far past the 4x
		// floor — so this "tip" must be rejected, not admitted.
		expect(refBitsToTarget(REGTEST_BITS) > priorMax * DIFFICULTY_FLOOR_FACTOR).toBe(true);
		acceptHeaderIntoCache({ height: 301, hex: singleTxHeader(REGTEST_BITS, randomTxid('h4'), { time: 1001 }) });
		expect(state.tipCache.has(301)).toBe(false);
		// The rejection must not have disturbed the existing entry.
		expect(state.tipCache.has(300)).toBe(true);
	});

	it('accepts a subsequent tip within the 4x floor of the cached max', () => {
		acceptHeaderIntoCache({ height: 400, hex: singleTxHeader(HARDER_BITS, randomTxid('h5'), { time: 1000 }) });
		const priorMax = maxCachedTarget();
		// A target exactly at the 4x boundary (well inside "<=") must be admitted.
		const boundaryBits = HARDER_BITS; // same difficulty is trivially within 4x
		acceptHeaderIntoCache({ height: 401, hex: singleTxHeader(boundaryBits, randomTxid('h6'), { time: 1001 }) });
		expect(state.tipCache.has(401)).toBe(true);
		expect(maxCachedTarget()).toBeGreaterThanOrEqual(priorMax);
	});

	it('prunes down to the newest TIP_CACHE_SIZE entries', () => {
		const size = _internals.TIP_CACHE_SIZE;
		for (let i = 0; i < size + 5; i++) {
			acceptHeaderIntoCache({
				height: 1000 + i,
				hex: singleTxHeader(REGTEST_BITS, randomTxid(`prune-${i}`), { time: 2000 + i })
			});
		}
		expect(state.tipCache.size).toBe(size);
		// The oldest 5 heights were evicted; the newest are retained.
		expect(state.tipCache.has(1000)).toBe(false);
		expect(state.tipCache.has(1000 + size + 4)).toBe(true);
	});
});

describe('spvVerifyConfirmed — cache-anchored confirmation', () => {
	it('defers (fails closed) on a cold cache with no observed tips yet', async () => {
		expect(state.tipCache.size).toBe(0);
		const txid = randomTxid('cold');
		electrum.getBlockHeader.mockResolvedValue(singleTxHeader(REGTEST_BITS, txid, { time: 5000 }));
		const ok = await spvVerifyConfirmed(txid, 500);
		expect(ok).toBe(false);
	});

	it('accepts a proof at a height the watcher itself observed, matching hash', async () => {
		const txid = randomTxid('anchor-accept');
		const hex = singleTxHeader(REGTEST_BITS, txid, { time: 6000 });
		acceptHeaderIntoCache({ height: 600, hex });
		electrum.getBlockHeader.mockResolvedValue(hex);
		const ok = await spvVerifyConfirmed(txid, 600);
		expect(ok).toBe(true);
	});

	it('rejects a proof at an observed height whose header hash does not match the cached one', async () => {
		const cachedTxid = randomTxid('anchor-cached');
		acceptHeaderIntoCache({ height: 700, hex: singleTxHeader(REGTEST_BITS, cachedTxid, { time: 7000 }) });

		// Electrum now serves a DIFFERENT (also validly-mined) header for the same
		// height — exactly what a forging/hostile server, or an un-rolled-forward
		// reorg, would look like.
		const forgedTxid = randomTxid('anchor-forged');
		const forgedHex = singleTxHeader(REGTEST_BITS, forgedTxid, { time: 7001 });
		electrum.getBlockHeader.mockResolvedValue(forgedHex);

		const ok = await spvVerifyConfirmed(forgedTxid, 700);
		expect(ok).toBe(false);
		// Fail closed, not blacklisted: the cache entry is untouched so a later,
		// legitimate retry at this height can still succeed.
		expect(state.tipCache.get(700)!.hash).not.toBe(refDisplayHash(forgedHex));
	});

	it('accepts a proof at a non-observed height whose target clears the 4x floor', async () => {
		acceptHeaderIntoCache({ height: 800, hex: singleTxHeader(HARDER_BITS, randomTxid('floor-anchor'), { time: 8000 }) });
		const txid = randomTxid('floor-accept');
		// Same difficulty as the cached tip — trivially within the 4x floor.
		const hex = singleTxHeader(HARDER_BITS, txid, { time: 8001 });
		electrum.getBlockHeader.mockResolvedValue(hex);
		const ok = await spvVerifyConfirmed(txid, 801); // not the cached height
		expect(ok).toBe(true);
	});

	it('rejects a proof at a non-observed height whose target is weaker than the 4x floor', async () => {
		acceptHeaderIntoCache({ height: 900, hex: singleTxHeader(HARDER_BITS, randomTxid('floor-anchor-2'), { time: 9000 }) });
		const txid = randomTxid('floor-reject');
		// REGTEST_BITS is 256x looser than HARDER_BITS — a server offering this as
		// "proof" for an unobserved height is exactly the forgery this guards
		// against: real PoW, just not at anywhere near the calibrated difficulty.
		const hex = singleTxHeader(REGTEST_BITS, txid, { time: 9001 });
		electrum.getBlockHeader.mockResolvedValue(hex);
		const ok = await spvVerifyConfirmed(txid, 901);
		expect(ok).toBe(false);
	});
});
