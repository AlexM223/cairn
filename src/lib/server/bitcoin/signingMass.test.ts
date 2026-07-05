import { describe, it, expect, beforeEach } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
	parentVsizeFromRawTx,
	classifyParent,
	tierForVsize,
	estimateSigningSeconds,
	quorumSecondsRange,
	computeSigningMass,
	signingMassFromFetchedParents,
	preferLowMassOrder,
	classifyAndCacheParent,
	getCachedParentMass,
	parentMassCacheSize,
	clearParentMassCache,
	rememberWalletMassProfile,
	getUserMassProfile,
	sampleLikelySpend,
	TYPICAL_SPEND_PROFILE,
	TIER_MEDIUM_VSIZE,
	TIER_HIGH_VSIZE,
	PARENT_MASS_CACHE_MAX,
	SIGNER_DEVICES
} from './signingMass';

// Real addresses so scriptPubKeys have realistic sizes.
const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // 31 vB/output
const P2PKH = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'; // 34 vB/output

/**
 * A synthetic parent transaction with `count` outputs — REAL serialized
 * bytes, real txid, built with @scure exactly like the PSBT builders' test
 * funding txs. `salt` varies the first output's value so loops can mint
 * distinct txids.
 */
function parentTx(count: number, address = P2WPKH, salt = 0): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	for (let i = 0; i < count; i++) {
		tx.addOutputAddress(address, BigInt(1_000 + (i === 0 ? salt : 0)), NETWORK);
	}
	return { hex: tx.hex, txid: tx.id };
}

// The three archetypes from the brief: an F2Pool-class payout, a
// Foundry-class payout (p2pkh outputs, the upper end of its size range), and
// a plain P2P send.
const F2POOL_LIKE = parentTx(3_000);
const FOUNDRY_LIKE = parentTx(250, P2PKH);
const P2P_LIKE = parentTx(2);

beforeEach(() => clearParentMassCache());

describe('parentVsizeFromRawTx / classifyParent', () => {
	it('computes vsize = byte length for non-witness parents', () => {
		// weight = base*3 + total; without witnesses base === total, so vsize
		// is exactly the serialized byte count.
		for (const p of [F2POOL_LIKE, FOUNDRY_LIKE, P2P_LIKE]) {
			expect(parentVsizeFromRawTx(p.hex)).toBe(p.hex.length / 2);
		}
	});

	it('accepts bytes as well as hex', () => {
		expect(parentVsizeFromRawTx(hexToBytes(P2P_LIKE.hex))).toBe(P2P_LIKE.hex.length / 2);
	});

	it('classifies output-count sources per the pool-stat thresholds', () => {
		expect(classifyParent(F2POOL_LIKE.hex)).toMatchObject({ outputCount: 3_000, source: 'pool-batch' });
		expect(classifyParent(FOUNDRY_LIKE.hex)).toMatchObject({ outputCount: 250, source: 'pool-batch' });
		expect(classifyParent(parentTx(30).hex)).toMatchObject({ outputCount: 30, source: 'batch' });
		expect(classifyParent(P2P_LIKE.hex)).toMatchObject({ outputCount: 2, source: 'p2p' });
		expect(classifyParent(parentTx(10).hex)).toMatchObject({ outputCount: 10, source: 'unknown' });
	});

	it('throws on garbage', () => {
		expect(() => classifyParent('deadbeef')).toThrow();
	});
});

describe('tierForVsize', () => {
	it('places the pool archetypes in the documented tiers', () => {
		// P2P → low, Foundry-class → medium, F2Pool/ViaBTC-class → high.
		expect(tierForVsize(classifyParent(P2P_LIKE.hex).vsize)).toBe('low');
		expect(tierForVsize(classifyParent(FOUNDRY_LIKE.hex).vsize)).toBe('medium');
		expect(tierForVsize(classifyParent(F2POOL_LIKE.hex).vsize)).toBe('high');
		// ViaBTC-class: ~1500 p2wpkh outputs ≈ 47k vB.
		expect(tierForVsize(1_500 * 31)).toBe('high');
	});

	it('honors the exported boundaries', () => {
		expect(tierForVsize(TIER_MEDIUM_VSIZE - 1)).toBe('low');
		expect(tierForVsize(TIER_MEDIUM_VSIZE)).toBe('medium');
		expect(tierForVsize(TIER_HIGH_VSIZE)).toBe('medium');
		expect(tierForVsize(TIER_HIGH_VSIZE + 1)).toBe('high');
	});
});

describe('estimateSigningSeconds', () => {
	const base = { totalParentVsize: 100_000, inputCount: 2 };

	it('is slowest on trezor for heavy parents', () => {
		const t = estimateSigningSeconds({ ...base, device: 'trezor' });
		const l = estimateSigningSeconds({ ...base, device: 'ledger' });
		const c = estimateSigningSeconds({ ...base, device: 'coldcard' });
		expect(t.secondsHi).toBeGreaterThan(l.secondsHi);
		expect(l.secondsHi).toBeGreaterThan(c.secondsHi);
		expect(t.secondsLo).toBeLessThanOrEqual(t.secondsHi);
	});

	it('grows with parent mass and input count', () => {
		const small = estimateSigningSeconds({ totalParentVsize: 400, inputCount: 1, device: 'trezor' });
		const heavy = estimateSigningSeconds({ totalParentVsize: 150_000, inputCount: 1, device: 'trezor' });
		expect(heavy.secondsHi).toBeGreaterThan(small.secondsHi * 5);
		const manyInputs = estimateSigningSeconds({ totalParentVsize: 400, inputCount: 20, device: 'trezor' });
		expect(manyInputs.secondsHi).toBeGreaterThan(small.secondsHi);
	});

	it('scales the total by the quorum M — every signer processes the full mass', () => {
		const one = estimateSigningSeconds({ ...base, device: 'trezor' });
		const three = estimateSigningSeconds({ ...base, threshold: 3, totalKeys: 5, device: 'trezor' });
		// totalKeys also adds per-input work, so 3-of-5 is at LEAST 3× single-sig.
		expect(three.secondsHi).toBeGreaterThanOrEqual(one.secondsHi * 3);
		expect(three.secondsLo).toBeGreaterThanOrEqual(one.secondsLo * 3);
	});

	it('charges more per input as N grows (bigger scripts to parse)', () => {
		const n3 = estimateSigningSeconds({ ...base, threshold: 2, totalKeys: 3, device: 'trezor' });
		const n15 = estimateSigningSeconds({ ...base, threshold: 2, totalKeys: 15, device: 'trezor' });
		expect(n15.secondsHi).toBeGreaterThan(n3.secondsHi);
	});

	it('quorumSecondsRange brackets across devices', () => {
		const range = quorumSecondsRange({ ...base, threshold: 2, totalKeys: 3 });
		for (const device of SIGNER_DEVICES) {
			const est = estimateSigningSeconds({ ...base, threshold: 2, totalKeys: 3, device });
			expect(range.lo).toBeLessThanOrEqual(est.secondsLo);
			expect(range.hi).toBeGreaterThanOrEqual(est.secondsHi);
		}
	});
});

describe('computeSigningMass', () => {
	it('sums unique-parent vsizes and reports all three devices per signer', () => {
		const mass = computeSigningMass({ parentVsizes: [200, 150], inputCount: 2 });
		expect(mass.totalParentVsize).toBe(350);
		expect(mass.tier).toBe('low');
		expect(mass.splitSuggested).toBe(false);
		expect(mass.warnLevel).toBe('none');
		expect(mass.perDevice.map((d) => d.device).sort()).toEqual(['coldcard', 'ledger', 'trezor']);
		for (const d of mass.perDevice) {
			expect(d.secondsLo).toBeGreaterThanOrEqual(1);
			expect(d.secondsLo).toBeLessThanOrEqual(d.secondsHi);
		}
		expect(mass.totalSeconds.lo).toBeLessThanOrEqual(mass.totalSeconds.hi);
	});

	it('suggests splitting only when MORE THAN ONE heavy parent contributes', () => {
		// Divisible mass: two heavy parents can go to separate transactions.
		expect(computeSigningMass({ parentVsizes: [25_000, 25_000], inputCount: 2 }).splitSuggested).toBe(true);
		// Indivisible: one giant parent weighs on any split the same way.
		expect(computeSigningMass({ parentVsizes: [50_000], inputCount: 1 }).splitSuggested).toBe(false);
		expect(computeSigningMass({ parentVsizes: [50_000, 300], inputCount: 2 }).splitSuggested).toBe(false);
		// Not high tier → no suggestion even with two mid parents.
		expect(computeSigningMass({ parentVsizes: [9_000, 9_000], inputCount: 2 }).splitSuggested).toBe(false);
	});

	it('goes red on single-device (Trezor) timeout risk even at quorum 1', () => {
		// ~200k vB parent: worst-case Trezor stream far past the 90 s risk line.
		const mass = computeSigningMass({ parentVsizes: [200_000], inputCount: 1 });
		expect(mass.tier).toBe('high');
		expect(mass.warnLevel).toBe('red');
		expect(mass.totalSeconds.hi).toBeLessThan(1_800); // red came from timeout risk, not total
	});

	it('goes amber when the whole ceremony passes 10 minutes without timeout risk', () => {
		// 60k vB / 2 inputs is safe per signer (~56 s worst-case on Trezor) but
		// a 12-of-12 ceremony multiplies it past the 600 s amber line.
		const mass = computeSigningMass({
			parentVsizes: [60_000],
			inputCount: 2,
			threshold: 12,
			totalKeys: 12
		});
		expect(mass.warnLevel).toBe('amber');
		expect(mass.totalSeconds.hi).toBeGreaterThan(600);
		expect(mass.totalSeconds.hi).toBeLessThanOrEqual(1_800);
	});

	it('applies the quorum to totalSeconds', () => {
		const single = computeSigningMass({ parentVsizes: [10_000], inputCount: 1 });
		const multisig = computeSigningMass({ parentVsizes: [10_000], inputCount: 1, threshold: 3, totalKeys: 5 });
		expect(multisig.totalSeconds.hi).toBeGreaterThanOrEqual(single.totalSeconds.hi * 3);
		// Per-device stays per-signer: quorum must NOT be baked into it.
		const singleTrezor = single.perDevice.find((d) => d.device === 'trezor')!;
		const multisigTrezor = multisig.perDevice.find((d) => d.device === 'trezor')!;
		expect(multisigTrezor.secondsHi).toBeLessThan(singleTrezor.secondsHi * 3);
	});
});

describe('parent mass cache', () => {
	it('caches classifications by txid', () => {
		expect(getCachedParentMass(P2P_LIKE.txid)).toBeUndefined();
		const c = classifyAndCacheParent(P2P_LIKE.txid, P2P_LIKE.hex);
		expect(getCachedParentMass(P2P_LIKE.txid)).toEqual(c);
		expect(parentMassCacheSize()).toBe(1);
	});

	it('bounds the cache and keeps recently-used entries', () => {
		const first = parentTx(1, P2WPKH, 0);
		classifyAndCacheParent(first.txid, first.hex);
		for (let i = 1; i < PARENT_MASS_CACHE_MAX; i++) {
			const p = parentTx(1, P2WPKH, i);
			classifyAndCacheParent(p.txid, p.hex);
		}
		expect(parentMassCacheSize()).toBe(PARENT_MASS_CACHE_MAX);
		// Touch the oldest entry, then overflow: the untouched second-oldest
		// should be evicted, not the refreshed one.
		expect(getCachedParentMass(first.txid)).toBeDefined();
		const overflow = parentTx(1, P2WPKH, PARENT_MASS_CACHE_MAX);
		classifyAndCacheParent(overflow.txid, overflow.hex);
		expect(parentMassCacheSize()).toBe(PARENT_MASS_CACHE_MAX);
		expect(getCachedParentMass(first.txid)).toBeDefined();
		expect(getCachedParentMass(parentTx(1, P2WPKH, 1).txid)).toBeUndefined();
	});
});

describe('signingMassFromFetchedParents', () => {
	const parents = new Map<string, Uint8Array>([
		[F2POOL_LIKE.txid, hexToBytes(F2POOL_LIKE.hex)],
		[P2P_LIKE.txid, hexToBytes(P2P_LIKE.hex)]
	]);

	it('computes mass over unique parents while counting every input', () => {
		const mass = signingMassFromFetchedParents(
			[{ txid: P2P_LIKE.txid }, { txid: P2P_LIKE.txid }, { txid: F2POOL_LIKE.txid }],
			parents
		);
		expect(mass).toBeDefined();
		// Shared parent counted once in the vsize total.
		expect(mass!.totalParentVsize).toBe(
			parentVsizeFromRawTx(P2P_LIKE.hex) + parentVsizeFromRawTx(F2POOL_LIKE.hex)
		);
		expect(mass!.tier).toBe('high');
	});

	it('omits the block entirely when any parent is missing — no false confidence', () => {
		expect(
			signingMassFromFetchedParents([{ txid: P2P_LIKE.txid }, { txid: 'ff'.repeat(32) }], parents)
		).toBeUndefined();
		expect(signingMassFromFetchedParents([{ txid: 'ff'.repeat(32) }], new Map())).toBeUndefined();
	});

	it('degrades to absent (never throws) on an unparseable parent', () => {
		const corrupt = new Map([[P2P_LIKE.txid, hexToBytes('deadbeef')]]);
		expect(signingMassFromFetchedParents([{ txid: P2P_LIKE.txid }], corrupt)).toBeUndefined();
	});

	it('applies multisig quorum parameters', () => {
		const single = signingMassFromFetchedParents([{ txid: F2POOL_LIKE.txid }], parents)!;
		const multisig = signingMassFromFetchedParents([{ txid: F2POOL_LIKE.txid }], parents, {
			threshold: 2,
			totalKeys: 3
		})!;
		expect(multisig.totalSeconds.hi).toBeGreaterThanOrEqual(single.totalSeconds.hi * 2);
	});
});

describe('preferLowMassOrder', () => {
	const utxos = [
		{ txid: F2POOL_LIKE.txid, vout: 0 },
		{ txid: P2P_LIKE.txid, vout: 0 }
	];

	it('preserves order when nothing is cached (stable, no fetching)', () => {
		expect(preferLowMassOrder(utxos).map((u) => u.txid)).toEqual(utxos.map((u) => u.txid));
	});

	it('moves coins with known-light parents ahead of known-heavy ones', () => {
		classifyAndCacheParent(F2POOL_LIKE.txid, F2POOL_LIKE.hex);
		classifyAndCacheParent(P2P_LIKE.txid, P2P_LIKE.hex);
		expect(preferLowMassOrder(utxos).map((u) => u.txid)).toEqual([P2P_LIKE.txid, F2POOL_LIKE.txid]);
	});

	it('slots unknown parents between known-light and known-heavy', () => {
		classifyAndCacheParent(F2POOL_LIKE.txid, F2POOL_LIKE.hex);
		classifyAndCacheParent(P2P_LIKE.txid, P2P_LIKE.hex);
		const unknown = { txid: 'ee'.repeat(32), vout: 0 };
		const order = preferLowMassOrder([utxos[0], unknown, utxos[1]]).map((u) => u.txid);
		expect(order).toEqual([P2P_LIKE.txid, unknown.txid, F2POOL_LIKE.txid]);
	});
});

describe('wallet mass profiles + likely-spend sampling', () => {
	it('remembers profiles per user and aggregates across wallets', () => {
		rememberWalletMassProfile(1, 10, [{ txid: 'a'.repeat(64), value: 5_000, parentVsize: 300 }]);
		rememberWalletMassProfile(1, 11, [{ txid: 'b'.repeat(64), value: 9_000, parentVsize: 90_000 }]);
		rememberWalletMassProfile(2, 12, [{ txid: 'c'.repeat(64), value: 1_000, parentVsize: 100 }]);
		expect(getUserMassProfile(1)).toHaveLength(2);
		expect(getUserMassProfile(2)).toHaveLength(1);
		expect(getUserMassProfile(3)).toEqual([]);
	});

	it('samples the top coins by value and dedupes shared parents', () => {
		const shared = 'd'.repeat(64);
		const entries = [
			{ txid: shared, value: 100_000, parentVsize: 40_000 },
			{ txid: shared, value: 90_000, parentVsize: 40_000 }, // same parent, counted once
			{ txid: 'e'.repeat(64), value: 80_000, parentVsize: 200 },
			{ txid: 'f'.repeat(64), value: 10, parentVsize: 150_000 } // dust — outside top 3
		];
		const spend = sampleLikelySpend(entries, 3);
		expect(spend.inputCount).toBe(3);
		expect(spend.totalParentVsize).toBe(40_000 + 200);
	});

	it('has a plausible typical fallback: a few P2P-parent inputs, low tier', () => {
		expect(tierForVsize(TYPICAL_SPEND_PROFILE.totalParentVsize)).toBe('low');
		expect(TYPICAL_SPEND_PROFILE.inputCount).toBeGreaterThan(0);
	});
});
