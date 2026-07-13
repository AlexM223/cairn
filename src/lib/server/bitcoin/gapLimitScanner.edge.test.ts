// Edge-case / boundary tests for the gap-limit discovery engine (cairn-es7a):
// scanChainAddresses' stopping/trim logic, runGapScan's two-chain
// orchestration, and ScanCache's TTL/prime/failure-isolation behavior.
//
// Deliberately a SEPARATE file from gapLimitScanner.test.ts (which pins only
// the collectScanTxs Electrum-only-fallback regression, QA finding F4) so
// neither suite's mock setup has to accommodate the other's needs.
//
// Address-generation strategy: scanChainAddresses calls addressToScripthash()
// on whatever address deriveAt() returns, using the REAL xpub.ts derivation —
// so deriveAt must hand back real, decodable Bitcoin addresses (a fake string
// like "addr-0" throws). Fixtures below derive real BIP84 addresses from a
// public doc-vector zpub (same one used throughout the send-boundary suites)
// and precompute an address->index lookup so the mocked Electrum layer can
// answer get_history/get_balance/listunspent by matching on scripthash.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { batchRequestMock, getTxMock, getTxHexMock, getBlockTimeAtHeightMock } = vi.hoisted(() => ({
	batchRequestMock: vi.fn(),
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn(),
	getBlockTimeAtHeightMock: vi.fn()
}));

vi.mock('../chain/index', () => ({
	getChain: () => ({
		electrum: { batchRequest: batchRequestMock },
		getTx: getTxMock,
		getTxHex: getTxHexMock,
		getBlockTimeAtHeight: getBlockTimeAtHeightMock
	})
}));

import { scanChainAddresses, runGapScan, ScanCache } from './gapLimitScanner';
import { parseXpub, deriveAddress, addressToScripthash } from './xpub';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const parsed = parseXpub(ZPUB);

function addrAt(chain: 0 | 1, index: number): string {
	return deriveAddress(parsed, chain, index).address;
}

/** Wire batchRequest to answer get_history/get_balance for every address
 *  scanChainAddresses could derive on ONE chain within [0, precompute) —
 *  `usedIndices` are reported as having one confirmed history entry + a
 *  nonzero confirmed balance; everything else is reported unused/empty. */
function wireElectrum(chain: 0 | 1, usedIndices: Set<number>, precompute: number): void {
	const shToIndex = new Map<string, number>();
	for (let i = 0; i < precompute; i++) {
		shToIndex.set(addressToScripthash(addrAt(chain, i)), i);
	}
	batchRequestMock.mockImplementation(async (reqs: { method: string; params: string[] }[]) =>
		reqs.map((r) => {
			const idx = shToIndex.get(r.params[0]);
			const used = idx !== undefined && usedIndices.has(idx);
			if (r.method === 'blockchain.scripthash.get_history') {
				return used ? [{ tx_hash: (idx as number).toString(16).padStart(64, '0'), height: 100 }] : [];
			}
			return used ? { confirmed: 10_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
		})
	);
}

/** Two-chain variant for runGapScan tests. */
function wireElectrumBoth(usedByChain: { 0: Set<number>; 1: Set<number> }, precompute: number): void {
	const shToInfo = new Map<string, { chain: 0 | 1; index: number }>();
	for (const chain of [0, 1] as const) {
		for (let i = 0; i < precompute; i++) {
			shToInfo.set(addressToScripthash(addrAt(chain, i)), { chain, index: i });
		}
	}
	batchRequestMock.mockImplementation(async (reqs: { method: string; params: string[] }[]) =>
		reqs.map((r) => {
			const info = shToInfo.get(r.params[0]);
			const used = info !== undefined && usedByChain[info.chain].has(info.index);
			if (r.method === 'blockchain.scripthash.get_history') {
				return used ? [{ tx_hash: `${info!.chain}${info!.index}`.padStart(64, '0'), height: 100 }] : [];
			}
			return used ? { confirmed: 10_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
		})
	);
}

beforeEach(() => {
	batchRequestMock.mockReset();
	// collectScanTxs's tx-detail fetch is irrelevant to these discovery/cache
	// tests (a "used" address here only needs used=true — its actual tx
	// content is covered by gapLimitScanner.test.ts's F4 regression suite), so
	// both of collectScanTxs' backends reject cleanly and it degrades to an
	// empty tx list rather than fabricating anything.
	getTxMock.mockReset().mockRejectedValue(new Error('not stubbed in this test'));
	getTxHexMock.mockReset().mockRejectedValue(new Error('not stubbed in this test'));
	getBlockTimeAtHeightMock.mockReset().mockResolvedValue(null);
});

describe('scanChainAddresses — gap-limit stopping and trim boundaries (cairn-es7a)', () => {
	it('a zero-address wallet (nothing ever used) scans exactly one lookahead batch, all unused, no crash', async () => {
		wireElectrum(0, new Set(), 20);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out).toHaveLength(20); // BATCH_SIZE === GAP_LIMIT === 20
		expect(out.every((a) => !a.used)).toBe(true);
		expect(out.map((a) => a.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
	});

	it('exactly GAP_LIMIT (20) consecutive unused addresses after one used address stops the scan at that boundary', async () => {
		// index 0 used; indices 1..20 (20 consecutive) unused. Window trims to
		// lastUsed(0) + GAP_LIMIT(20) = 20, so index 20 is the last one kept.
		wireElectrum(0, new Set([0]), 60);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out.map((a) => a.index)).toEqual(Array.from({ length: 21 }, (_, i) => i));
		expect(out[0].used).toBe(true);
		expect(out.slice(1).every((a) => !a.used)).toBe(true);
	});

	it('a used address one past the first lookahead window (index 19) extends the scan window to 39', async () => {
		wireElectrum(0, new Set([19]), 80);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out[out.length - 1].index).toBe(39); // lastUsed(19) + GAP_LIMIT(20)
		expect(out.find((a) => a.index === 19)!.used).toBe(true);
	});

	it('a used address exactly at index 20 is UNREACHABLE when 0-19 are all unused — gap-limit exhausts within batch 1 first', async () => {
		// BUG-adjacent but NOT a bug: BATCH_SIZE === GAP_LIMIT === 20, so 20
		// consecutive unused addresses (indices 0-19) exhaust the gap limit
		// exactly at the end of the first batch — the scan stops there and never
		// even derives batch 2. An isolated used address at index 20 can never be
		// discovered by this algorithm; this is the correct, spec-faithful BIP44
		// behavior (a real gap of 20 unused addresses is defined as the point
		// discovery gives up), documented here as a boundary pin so a future
		// change to BATCH_SIZE/GAP_LIMIT's relationship doesn't silently alter it.
		wireElectrum(0, new Set([20]), 60);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out).toHaveLength(20); // stopped after the first all-unused batch
		expect(out.every((a) => !a.used)).toBe(true);
		expect(out.some((a) => a.index === 20)).toBe(false); // never even derived
	});

	it('a used address landing exactly on a BATCH_SIZE (20) multiple IS discovered when an earlier used address keeps the gap window open', async () => {
		// With index 0 also used, consecutiveUnused only reaches 19 (not 20) by
		// the end of batch 1, so batch 2 (indices 20-39) is derived and index 20
		// is found — extending the window to lastUsed(20) + GAP_LIMIT(20) = 40.
		wireElectrum(0, new Set([0, 20]), 60);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out.some((a) => a.index === 20 && a.used)).toBe(true);
		expect(out[out.length - 1].index).toBe(40);
	});

	it('HARD_CAP (400) truncates the scan even when spaced-out usage would otherwise keep the gap window open forever', async () => {
		// Usage every 15 indices (< GAP_LIMIT) never lets consecutiveUnused reach
		// 20, so gap-limit alone would never stop the scan — only the HARD_CAP
		// bound on the outer loop (index < 400) can terminate it. This is the
		// realistic way to actually reach the HARD_CAP boundary: an isolated
		// used index near 400 is unreachable by this algorithm (gap-limit would
		// have already stopped the scan after the very first all-unused batch).
		const used = new Set<number>();
		for (let i = 0; i <= 390; i += 15) used.add(i);
		wireElectrum(0, used, 400);
		const out = await scanChainAddresses((i) => ({ address: addrAt(0, i) }), 'interactive');
		expect(out).toHaveLength(400);
		expect(Math.max(...out.map((a) => a.index))).toBe(399);
		expect(out.find((a) => a.index === 390)!.used).toBe(true);
	}, 20_000);
});

describe('runGapScan — two-chain orchestration (cairn-es7a)', () => {
	it('a never-used wallet returns one unused lookahead batch per chain, zero balances, empty tx list', async () => {
		wireElectrumBoth({ 0: new Set(), 1: new Set() }, 20);
		const result = await runGapScan((chain, i) => ({ address: addrAt(chain, i), chain }), 'interactive');
		expect(result.addresses).toHaveLength(40); // 20 receive + 20 change
		expect(result.addresses.every((a) => !a.used)).toBe(true);
		expect(result.confirmed).toBe(0);
		expect(result.unconfirmed).toBe(0);
		expect(result.txs).toEqual([]);
	});

	it('usage on the change chain only extends that chain\'s window, independent of the receive chain', async () => {
		wireElectrumBoth({ 0: new Set(), 1: new Set([5]) }, 40);
		const result = await runGapScan((chain, i) => ({ address: addrAt(chain, i), chain }), 'interactive');
		const receive = result.addresses.filter((a) => a.chain === 0);
		const change = result.addresses.filter((a) => a.chain === 1);
		expect(receive).toHaveLength(20); // untouched, still just the lookahead batch
		expect(change).toHaveLength(26); // lastUsed(5) + GAP_LIMIT(20) = 25 -> 26 entries (0..25)
		expect(change.find((a) => a.index === 5)!.used).toBe(true);
	});

	it('confirmed/unconfirmed totals sum sats from exactly the used addresses across both chains', async () => {
		wireElectrumBoth({ 0: new Set([0]), 1: new Set() }, 20);
		const result = await runGapScan((chain, i) => ({ address: addrAt(chain, i), chain }), 'interactive');
		expect(result.confirmed).toBe(10_000);
		expect(result.unconfirmed).toBe(0);
	});
});

describe('ScanCache — TTL, prime, and failure isolation (cairn-es7a)', () => {
	it('serves a cached result to a second fetch() within the TTL — only one underlying scan runs', async () => {
		const cache = new ScanCache<number>(60_000);
		let calls = 0;
		const scan = async () => {
			calls++;
			return 42;
		};
		const first = await cache.fetch('k', scan);
		const second = await cache.fetch('k', scan);
		expect(first).toBe(42);
		expect(second).toBe(42);
		expect(calls).toBe(1);
	});

	it('re-scans once the TTL has expired', async () => {
		vi.useFakeTimers();
		try {
			const cache = new ScanCache<number>(1_000);
			let calls = 0;
			const scan = async () => {
				calls++;
				return calls;
			};
			const first = await cache.fetch('k', scan);
			vi.advanceTimersByTime(1_001);
			const second = await cache.fetch('k', scan);
			expect(first).toBe(1);
			expect(second).toBe(2);
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('forceRefresh bypasses a still-fresh cache-hit read but still writes the new result', async () => {
		const cache = new ScanCache<number>(60_000);
		let calls = 0;
		const scan = async () => {
			calls++;
			return calls;
		};
		await cache.fetch('k', scan);
		const forced = await cache.fetch('k', scan, { forceRefresh: true });
		expect(forced).toBe(2);
		expect(calls).toBe(2);
		// A subsequent normal fetch reads the freshly-forced value, not a third scan.
		const after = await cache.fetch('k', scan);
		expect(after).toBe(2);
		expect(calls).toBe(2);
	});

	it('prime() fills only an empty/expired slot — it never clobbers a still-fresh live entry', async () => {
		const cache = new ScanCache<string>(60_000);
		await cache.fetch('k', async () => 'live');
		cache.prime('k', 'seed'); // no-op: 'k' is still fresh
		expect(await cache.fetch('k', async () => 'should-not-run')).toBe('live');

		cache.prime('other', 'seed-other'); // empty slot -> fills
		expect(await cache.fetch('other', async () => 'should-not-run-either')).toBe('seed-other');
	});

	it('prime() DOES fill an expired slot', async () => {
		vi.useFakeTimers();
		try {
			const cache = new ScanCache<string>(1_000);
			await cache.fetch('k', async () => 'stale-live');
			vi.advanceTimersByTime(1_001);
			cache.prime('k', 'fresh-seed');
			expect(await cache.fetch('k', async () => 'should-not-run')).toBe('fresh-seed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a rejected scan is never cached — the next fetch() retries rather than replaying the rejection', async () => {
		const cache = new ScanCache<number>(60_000);
		let calls = 0;
		const failThenSucceed = async () => {
			calls++;
			if (calls === 1) throw new Error('transient chain failure');
			return calls;
		};
		await expect(cache.fetch('k', failThenSucceed)).rejects.toThrow('transient chain failure');
		const second = await cache.fetch('k', failThenSucceed);
		expect(second).toBe(2);
		expect(calls).toBe(2);
	});

	it('delete() removes one cached entry; clear() removes all of them', async () => {
		const cache = new ScanCache<number>(60_000);
		let calls = 0;
		const scan = async () => {
			calls++;
			return calls;
		};
		await cache.fetch('a', scan);
		await cache.fetch('b', scan);
		cache.delete('a');
		await cache.fetch('a', scan); // re-scans
		expect(calls).toBe(3);
		cache.clear();
		await cache.fetch('b', scan); // re-scans after clear too
		expect(calls).toBe(4);
	});
});
