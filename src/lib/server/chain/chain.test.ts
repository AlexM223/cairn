// Regression tests for cairn-a0nb: the ChainService facade (chain/index.ts) had
// zero test coverage. Pins down the facade's mapping/normalization logic. With
// Esplora fully removed (cairn-zoz8.16) the explorer runs purely on the
// operator's own Electrum server (getTip, getRecentBlocks, getFeeEstimates,
// getDifficultyInfo/History, getHashrate, getAddressInfo/getAddressTxs,
// getFeeHistogram) and Bitcoin Core RPC (getTx, getBlock, getBlockTxs,
// getMempoolSummary, getCpfpInfo). Both are stubbed here — no sockets, no RPC.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { scriptPubKeyHex, addressToScripthash } from '../bitcoin/xpub';

// Keep the ChainService constructor side-effect free: no Electrum sockets, no
// activity-feed wiring, no package-relay probing.
vi.mock('../electrum/pool', () => ({
	ElectrumPool: class {
		server = 'stub:50001';
		close(): void {}
		on(): void {}
		setMaxListeners(): void {}
	}
}));
vi.mock('../chainEvents', () => ({
	wireChainEvents: vi.fn(),
	resetConnectionState: vi.fn()
}));
vi.mock('../packageRelay', () => ({ resetPackageRelaySupport: vi.fn() }));
vi.mock('../activity', () => ({ recordActivity: vi.fn() }));

import { ChainService, testCoreRpc, coreRpcUrlError } from './index';
import { CoreRpcError } from '../bitcoinCore/client';
import {
	resetChainCaches,
	invalidateTipCache,
	clearRawTxCache,
	rawTxCacheSize,
	getCachedBlockStats,
	cacheBlockStats,
	blockStatsCacheSize,
	clearBlockStatsCache,
	clearHeaderCache,
	clearMerklePosCache
} from './cache';
import type { BlockStats } from './index';

// ---- fixtures -----------------------------------------------------------------

const TIP_HEIGHT = 868_000;

const CFG = {
	mode: 'custom',
	electrumHost: '127.0.0.1',
	electrumPort: 50001,
	electrumTls: false,
	electrumTlsInsecure: false,
	socks5Host: null,
	socks5Port: null,
	electrumPoolSize: 1
};

const WATCHED_SCRIPT = '0014' + 'bb'.repeat(20);

/** Block identity referenced by the Bitcoin Core block tests below. */
const BLOCK = {
	id: 'b'.repeat(64),
	height: 867_990
};

/** Compact target for difficulty exactly 1 (the genesis block's nBits). */
const GENESIS_BITS = 0x1d00ffff;

/** Build an 80-byte Bitcoin block header, hex-encoded, matching the field layout
 *  chain/index.ts's decodeBlockHeader expects (version/prevhash/merkleroot/time/
 *  bits/nonce, hashes stored little-endian internally). */
function buildHeader(opts: {
	time: number;
	bits: number;
	version?: number;
	prevHash?: string;
	merkleRoot?: string;
	nonce?: number;
}): string {
	const buf = Buffer.alloc(80);
	buf.writeInt32LE(opts.version ?? 0x20000000, 0);
	Buffer.from(opts.prevHash ?? '00'.repeat(32), 'hex')
		.reverse()
		.copy(buf, 4);
	Buffer.from(opts.merkleRoot ?? '11'.repeat(32), 'hex')
		.reverse()
		.copy(buf, 36);
	buf.writeUInt32LE(opts.time, 68);
	buf.writeUInt32LE(opts.bits, 72);
	buf.writeUInt32LE(opts.nonce ?? 0, 76);
	return buf.toString('hex');
}

/** Double-sha256 of the header, byte-reversed — an independent re-derivation of
 *  chain/index.ts's blockHashFromHeader, so the expected value isn't just an echo
 *  of the code under test. */
function headerHash(hex: string): string {
	const hash = sha256(sha256(hexToBytes(hex)));
	return bytesToHex(Uint8Array.from(hash).reverse());
}

/** Independent re-derivation of chain/index.ts's bitsToDifficulty (Bitcoin Core's
 *  GetDifficulty), used to compute expected values for the difficulty tests below
 *  without just re-running the implementation under test. */
function diffFromBits(bits: number): number {
	const exponent = bits >>> 24;
	const mantissa = bits & 0x007fffff;
	return (0xffff / mantissa) * Math.pow(2, 8 * (0x1d - exponent));
}

interface ElectrumStub {
	headersSubscribe: ReturnType<typeof vi.fn>;
	getBlockHeader: ReturnType<typeof vi.fn>;
	estimateFee: ReturnType<typeof vi.fn>;
	getBalance: ReturnType<typeof vi.fn>;
	getHistory: ReturnType<typeof vi.fn>;
	getTransaction: ReturnType<typeof vi.fn>;
	getMerkleProof: ReturnType<typeof vi.fn>;
}

/** Install stubbed Electrum methods onto a ChainService's pooled facade
 *  (readonly is TS-only) — mirrors the existing withElectrum pattern already used
 *  for getTxHex/getFeeHistogram below. */
function withElectrum(svc: ChainService, patch: Partial<ElectrumStub>): void {
	Object.assign(svc.electrum, patch);
}

/** A ChainService with no Bitcoin Core RPC configured — the Electrum-only
 *  baseline. Electrum methods are stubbed per-test via withElectrum. */
function makeService(): ChainService {
	return new ChainService(CFG as unknown as ConstructorParameters<typeof ChainService>[0]);
}

afterEach(() => {
	vi.unstubAllGlobals();
	// The tip/fee TTL caches are module-level and outlive a single service, so
	// clear them between tests to keep cases isolated (cairn-vknb.5).
	resetChainCaches();
	// Same for the raw-tx LRU (cairn perf: send-flow prev-tx fetch) — otherwise
	// a txid reused across tests would silently short-circuit on a stale entry.
	clearRawTxCache();
	// And the immutable block-stats LRU (cairn-6efi.1, U2), so a hash reused
	// across cases doesn't short-circuit a fresh enrichment fetch.
	clearBlockStatsCache();
	// The block-context header + merkle-pos caches (tx block context), same reason.
	clearHeaderCache();
	clearMerklePosCache();
});

// ---- tip (electrum-backed, cairn-zoz8.5) -----------------------------------------

// getTip now derives height+hash from headersSubscribe (the same source
// getNodeInfo already used), not a third-party HTTP explorer API.
describe('getTip', () => {
	function withHeader(height: number, hex: string): { svc: ChainService; headersSubscribe: ReturnType<typeof vi.fn> } {
		const svc = makeService();
		const headersSubscribe = vi.fn(async () => ({ height, hex }));
		withElectrum(svc, { headersSubscribe });
		return { svc, headersSubscribe };
	}

	it('derives height+hash from electrum headersSubscribe', async () => {
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const { svc, headersSubscribe } = withHeader(TIP_HEIGHT, hex);

		await expect(svc.getTip()).resolves.toEqual({ height: TIP_HEIGHT, hash: headerHash(hex) });
		expect(headersSubscribe).toHaveBeenCalledTimes(1);
	});

	it('serves a second lookup from the TTL cache without re-hitting electrum', async () => {
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const { svc, headersSubscribe } = withHeader(TIP_HEIGHT, hex);

		await svc.getTip();
		await svc.getTip();

		// One navigation (or several tabs) shares a single Electrum round-trip.
		expect(headersSubscribe).toHaveBeenCalledTimes(1);
	});

	it('re-fetches after invalidateTipCache (the new-block signal)', async () => {
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const { svc, headersSubscribe } = withHeader(TIP_HEIGHT, hex);

		await svc.getTip();
		invalidateTipCache(); // fired from the chainEvents 'header' handler on a new block
		await svc.getTip();

		expect(headersSubscribe).toHaveBeenCalledTimes(2);
	});
});

// ---- recent blocks (electrum-backed, cairn-zoz8.5) -------------------------------

describe('getRecentBlocks', () => {
	it('fetches `limit` headers ending at fromHeight, newest first, decoding only what a bare header carries', async () => {
		const svc = makeService();
		const headersByHeight = new Map<number, string>();
		for (let h = 800; h <= 805; h++) {
			headersByHeight.set(h, buildHeader({ time: 1_700_000_000 + h, bits: GENESIS_BITS }));
		}
		const getBlockHeader = vi.fn(async (h: number) => {
			const hex = headersByHeight.get(h);
			if (!hex) throw new Error(`no header stubbed for height ${h}`);
			return hex;
		});
		withElectrum(svc, { getBlockHeader });

		const blocks = await svc.getRecentBlocks(3, 805);

		expect(blocks.map((b) => b.height)).toEqual([805, 804, 803]);
		expect(getBlockHeader).toHaveBeenCalledTimes(3);
		expect(blocks[0].hash).toBe(headerHash(headersByHeight.get(805)!));
		expect(blocks[0].time).toBe(1_700_000_000 + 805);
		// tx_count/size/weight/fee stats aren't derivable from a bare header alone,
		// and with no Core RPC configured they stay NULL — never a false 0 (Cardinal
		// rule). Core enrichment fills them when configured (cairn-6efi.1, U1).
		expect(blocks[0]).toMatchObject({
			txCount: null,
			size: null,
			weight: null,
			medianFee: null,
			feeRange: null,
			total_out: null,
			fullness: null
		});
	});

	it('derives fromHeight from the current tip when omitted', async () => {
		const svc = makeService();
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const headersSubscribe = vi.fn(async () => ({ height: 5, hex }));
		const getBlockHeader = vi.fn(async () => hex);
		withElectrum(svc, { headersSubscribe, getBlockHeader });

		const blocks = await svc.getRecentBlocks(2);
		expect(blocks.map((b) => b.height)).toEqual([5, 4]);
	});

	it('clamps the count near genesis instead of requesting a negative height', async () => {
		const svc = makeService();
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const getBlockHeader = vi.fn(async () => hex);
		withElectrum(svc, { getBlockHeader });

		const blocks = await svc.getRecentBlocks(10, 1);
		expect(blocks.map((b) => b.height)).toEqual([1, 0]);
		expect(getBlockHeader).toHaveBeenCalledTimes(2);
	});

	// ---- Core-RPC enrichment (cairn-6efi.1, U1) --------------------------------
	it('enriches every row via getblockstats when Bitcoin Core is configured', async () => {
		const core = makeCoreStub();
		const svc = makeCoreService(core);
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		withElectrum(svc, { getBlockHeader: vi.fn(async () => hex) });
		core.getBlockStats.mockResolvedValue({
			txs: 2_500,
			total_size: 1_312_000,
			total_weight: 3_993_000,
			total_out: 1_234_567_890,
			totalfee: 5_000_000,
			subsidy: 312_500_000,
			feerate_percentiles: [1, 5, 12, 40, 220]
		});

		const blocks = await svc.getRecentBlocks(2, 805);

		// One getblockstats per block, requested by HASH with the row-model field list.
		expect(core.getBlockStats).toHaveBeenCalledTimes(2);
		expect(core.getBlockStats).toHaveBeenCalledWith(
			headerHash(hex),
			expect.arrayContaining(['txs', 'total_size', 'total_weight', 'total_out', 'feerate_percentiles'])
		);
		expect(blocks[0]).toMatchObject({
			txCount: 2_500,
			size: 1_312_000,
			weight: 3_993_000,
			total_out: 1_234_567_890,
			medianFee: 12, // feerate_percentiles[2]
			feeRange: [1, 220], // [p0, p4]
			fullness: 3_993_000 / 4_000_000
		});
	});

	it('degrades a single failed block to the null baseline instead of throwing (pruned node)', async () => {
		const core = makeCoreStub();
		const svc = makeCoreService(core);
		const headersByHeight = new Map<number, string>();
		for (let h = 804; h <= 805; h++) {
			headersByHeight.set(h, buildHeader({ time: 1_700_000_000 + h, bits: GENESIS_BITS, nonce: h }));
		}
		withElectrum(svc, { getBlockHeader: vi.fn(async (h: number) => headersByHeight.get(h)!) });
		const prunedHash = headerHash(headersByHeight.get(804)!);
		core.getBlockStats.mockImplementation(async (hash: string) => {
			if (hash === prunedHash) throw new Error('getblockstats: Block not available (pruned data)');
			return {
				txs: 10,
				total_size: 2_000,
				total_weight: 8_000,
				total_out: 99,
				feerate_percentiles: [1, 2, 3, 4, 5]
			};
		});

		// Must not throw even though one block's stats fail.
		const blocks = await svc.getRecentBlocks(2, 805); // [805, 804]

		expect(blocks.map((b) => b.height)).toEqual([805, 804]);
		expect(blocks[0].txCount).toBe(10); // enriched
		expect(blocks[1]).toMatchObject({
			txCount: null,
			size: null,
			weight: null,
			total_out: null,
			medianFee: null,
			feeRange: null,
			fullness: null
		});
	});

	it('serves already-seen block stats from the immutable cache on the next refresh (cairn-6efi.1, U2)', async () => {
		const core = makeCoreStub();
		const svc = makeCoreService(core);
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		withElectrum(svc, { getBlockHeader: vi.fn(async () => hex) });
		core.getBlockStats.mockResolvedValue({
			txs: 42,
			total_size: 1000,
			total_weight: 4000,
			total_out: 7,
			feerate_percentiles: [1, 2, 3, 4, 5]
		});

		// First pass fetches getblockstats once (one block).
		await svc.getRecentBlocks(1, 805);
		expect(core.getBlockStats).toHaveBeenCalledTimes(1);

		// Second pass over the SAME block hash is a pure cache hit — no new RPC.
		const again = await svc.getRecentBlocks(1, 805);
		expect(core.getBlockStats).toHaveBeenCalledTimes(1);
		expect(again[0].txCount).toBe(42);
	});
});

describe('blockStatsCache (immutable LRU, cairn-6efi.1 U2)', () => {
	const mk = (txCount: number): BlockStats => ({
		txCount,
		size: 1000,
		weight: 4000,
		total_out: 7,
		medianFee: 3,
		feeRange: [1, 5]
	});

	it('returns cached stats unchanged (buried-block immutability)', () => {
		cacheBlockStats('h1', mk(11));
		expect(getCachedBlockStats('h1')).toMatchObject({ txCount: 11 });
		// A confirmed block's stats never change; a re-cache under a fresh hash is a
		// different block, and the original entry is untouched.
		cacheBlockStats('h2', mk(22));
		expect(getCachedBlockStats('h1')).toMatchObject({ txCount: 11 });
		expect(getCachedBlockStats('h2')).toMatchObject({ txCount: 22 });
	});

	it('evicts the least-recently-used entry past the count bound', () => {
		// Fill well past the 300 cap; the earliest inserted keys must be evicted.
		for (let i = 0; i < 350; i++) cacheBlockStats(`blk-${i}`, mk(i));
		expect(blockStatsCacheSize()).toBe(300);
		expect(getCachedBlockStats('blk-0')).toBeUndefined(); // evicted
		expect(getCachedBlockStats('blk-349')).toMatchObject({ txCount: 349 }); // newest kept
	});

	it('a read refreshes recency so a hot entry survives eviction', () => {
		for (let i = 0; i < 300; i++) cacheBlockStats(`k-${i}`, mk(i));
		// Touch the oldest so it is no longer the LRU victim.
		expect(getCachedBlockStats('k-0')).toBeDefined();
		cacheBlockStats('k-new', mk(999)); // forces one eviction
		expect(getCachedBlockStats('k-0')).toBeDefined(); // survived
		expect(getCachedBlockStats('k-1')).toBeUndefined(); // evicted instead
	});
});

// ---- getTxHex (raw hex via Electrum) ----------------------------------------------

// getTxHex fetches raw hex from the operator's own Electrum server via
// blockchain.transaction.get(txid, verbose=false) (cairn-zoz8.4), which returns
// the raw serialization for both confirmed and mempool txids on a full-indexing
// backend (ElectrumX/Fulcrum/electrs).
describe('getTxHex (Electrum raw-hex path)', () => {
	// Plausible raw serializations; getTxHex passes them through untouched (no decode).
	const CONFIRMED_TX_HEX = '02000000000101' + 'ab'.repeat(100) + '00000000';
	const MEMPOOL_TX_HEX = '02000000000101' + 'cd'.repeat(80) + '00000000';

	/** Install a getTransaction stub on the pooled Electrum client (readonly is TS-only). */
	function withElectrum(svc: ChainService, getTransaction: ReturnType<typeof vi.fn>): void {
		Object.assign(svc.electrum, { getTransaction });
	}

	it('returns a confirmed tx hex via getTransaction(txid, false)', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'f'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);
		// verbose=false so the server returns raw hex rather than a decoded object.
		expect(getTransaction).toHaveBeenCalledWith(txid, false);
	});

	it('returns an unconfirmed (mempool) tx hex the same way', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => MEMPOOL_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'a'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(MEMPOOL_TX_HEX);
		expect(getTransaction).toHaveBeenCalledWith(txid, false);
	});

	it('throws when the Electrum server has no such tx', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => {
			throw new Error('Electrum error: No such mempool or blockchain transaction');
		});
		withElectrum(svc, getTransaction);

		await expect(svc.getTxHex('b'.repeat(64))).rejects.toThrow(
			/No such mempool or blockchain transaction/
		);
	});

	// ---- cross-build raw-tx LRU (cairn perf: send-flow prev-tx fetch) --------------
	//
	// psbt.ts's constructPsbt fetches nonWitnessUtxo for its selected inputs via
	// this exact method (params.fetchRawTx wraps getChain().getTxHex). A user who
	// rebuilds a draft (adjusting amount/fee) re-requests the same selected
	// coins' previous transactions — this cache is what makes that free the
	// second time, mirroring getTip's TTL-cache test above but with no
	// expiry (confirmed tx bytes never change).

	it('serves a second lookup for the same txid from the LRU without re-hitting electrum', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'c'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);

		// The second "build" pays zero additional Electrum round-trips.
		expect(getTransaction).toHaveBeenCalledTimes(1);
	});

	it('keys the cache by txid, so a different txid always misses', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async (txid: string) =>
			txid === 'c'.repeat(64) ? CONFIRMED_TX_HEX : MEMPOOL_TX_HEX
		);
		withElectrum(svc, getTransaction);

		await svc.getTxHex('c'.repeat(64));
		await svc.getTxHex('d'.repeat(64));

		expect(getTransaction).toHaveBeenCalledTimes(2);
	});

	it('clearRawTxCache forces the next lookup to re-hit electrum', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'c'.repeat(64);
		await svc.getTxHex(txid);
		clearRawTxCache();
		await svc.getTxHex(txid);

		expect(getTransaction).toHaveBeenCalledTimes(2);
	});

	it('does not cache a failed fetch', async () => {
		const svc = makeService();
		let calls = 0;
		const getTransaction = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error('Electrum error: timeout');
			return CONFIRMED_TX_HEX;
		});
		withElectrum(svc, getTransaction);

		const txid = 'c'.repeat(64);
		await expect(svc.getTxHex(txid)).rejects.toThrow(/timeout/);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);
		expect(getTransaction).toHaveBeenCalledTimes(2);
	});

	it('bounds cache growth at the LRU cap', async () => {
		const svc = makeService();
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		// One over the 200-entry cap (cache.ts RAW_TX_CACHE_MAX) — the oldest
		// entry must be evicted rather than the map growing unbounded.
		for (let i = 0; i < 201; i++) {
			await svc.getTxHex(i.toString(16).padStart(64, '0'));
		}
		expect(rawTxCacheSize()).toBe(200);
	});
});

// ---- fee estimates (electrum-backed, cairn-zoz8.1) --------------------------------

// getFeeEstimates reads blockchain.estimatefee at 4 targets from the operator's
// own Electrum server (cairn-zoz8.1).
describe('getFeeEstimates', () => {
	function withFees(byTarget: Record<number, number>): {
		svc: ChainService;
		estimateFee: ReturnType<typeof vi.fn>;
	} {
		const svc = makeService();
		const estimateFee = vi.fn(async (n: number) => byTarget[n]);
		withElectrum(svc, { estimateFee });
		return { svc, estimateFee };
	}

	it('converts BTC/kvB to sat/vB for each of the 4 targets (1/3/6/144 blocks)', async () => {
		const { svc, estimateFee } = withFees({ 1: 0.0003, 3: 0.0002, 6: 0.0001, 144: 0.00005 });

		await expect(svc.getFeeEstimates()).resolves.toEqual({
			fastest: 30, // 0.0003 BTC/kvB * 1e5 = 30 sat/vB
			halfHour: 20,
			hour: 10,
			economy: 5
		});
		expect(estimateFee).toHaveBeenCalledWith(1);
		expect(estimateFee).toHaveBeenCalledWith(3);
		expect(estimateFee).toHaveBeenCalledWith(6);
		expect(estimateFee).toHaveBeenCalledWith(144);
	});

	it('carries a -1 ("no estimate") target forward from the next-longer target', async () => {
		// target 3 has no estimate → inherits target 6's rate; target 144 has no
		// estimate and nothing longer exists → floors at 1 sat/vB.
		const { svc } = withFees({ 1: 0.0003, 3: -1, 6: 0.0001, 144: -1 });

		await expect(svc.getFeeEstimates()).resolves.toEqual({
			fastest: 30,
			halfHour: 10, // inherited from hour
			hour: 10,
			economy: 1
		});
	});

	it('floors a real but sub-1-sat/vB estimate at 1 sat/vB', async () => {
		const { svc } = withFees({ 1: 0.0003, 3: 0.0002, 6: 0.0001, 144: 0.000001 }); // 0.1 sat/vB

		await expect(svc.getFeeEstimates()).resolves.toMatchObject({ economy: 1 });
	});

	it('TTL-caches so a second call does not re-hit the server', async () => {
		const { svc, estimateFee } = withFees({ 1: 0.0003, 3: 0.0002, 6: 0.0001, 144: 0.00005 });

		await svc.getFeeEstimates();
		await svc.getFeeEstimates();

		expect(estimateFee).toHaveBeenCalledTimes(4); // 4 targets, one round of calls
	});
});

// ---- difficulty (electrum-backed, cairn-zoz8.3) -----------------------------------

describe('getDifficultyInfo', () => {
	// tip 868,000 falls in the epoch starting at 866,880 (Math.floor(868000/2016)*2016).
	const EPOCH_START_HEIGHT = 866_880;
	const T1 = 1_700_000_000; // epoch-start block time
	const T2 = 1_700_672_000; // tip block time — exactly 600s/block over 1,120 intervals

	it('derives epoch state, avg pace, and the retarget projection from two header fetches', async () => {
		const svc = makeService();
		const tipHex = buildHeader({ time: T2, bits: GENESIS_BITS }); // difficulty 1
		const startHex = buildHeader({ time: T1, bits: 0x1b0404cb });
		const headersSubscribe = vi.fn(async () => ({ height: TIP_HEIGHT, hex: tipHex }));
		const getBlockHeader = vi.fn(async (h: number) => {
			expect(h).toBe(EPOCH_START_HEIGHT);
			return startHex;
		});
		withElectrum(svc, { headersSubscribe, getBlockHeader });

		const info = await svc.getDifficultyInfo();

		expect(info.currentDifficulty).toBeCloseTo(1, 6);
		expect(info.tipHeight).toBe(TIP_HEIGHT);
		expect(info.epochStartHeight).toBe(EPOCH_START_HEIGHT);
		expect(info.nextRetargetHeight).toBe(868_896);
		expect(info.blocksIntoEpoch).toBe(1121);
		expect(info.blocksRemaining).toBe(896);
		expect(info.progressPercent).toBeCloseTo((1121 / 2016) * 100, 6);
		expect(info.avgBlockTimeSeconds).toBe(600);
		expect(info.projectedChangePercent).toBeCloseTo(0, 6);
		expect(info.estimatedRetargetDate).toBe(1_701_209_600);
	});

	it('falls back to base epoch state (no projection) when the epoch-start header fetch fails', async () => {
		const svc = makeService();
		const tipHex = buildHeader({ time: T2, bits: GENESIS_BITS });
		const headersSubscribe = vi.fn(async () => ({ height: TIP_HEIGHT, hex: tipHex }));
		const getBlockHeader = vi.fn(async () => {
			throw new Error('electrum: header not found');
		});
		withElectrum(svc, { headersSubscribe, getBlockHeader });

		const info = await svc.getDifficultyInfo();

		expect(info.currentDifficulty).toBeCloseTo(1, 6);
		expect(info.tipHeight).toBe(TIP_HEIGHT);
		expect(info.avgBlockTimeSeconds).toBeNull();
		expect(info.projectedChangePercent).toBeNull();
		expect(info.estimatedRetargetDate).toBeNull();
	});
});

describe('getDifficultyHistory', () => {
	it('fetches epoch-boundary headers oldest-first and computes changePercent between consecutive epochs', async () => {
		const svc = makeService();
		const tipHex = buildHeader({ time: 1_700_672_000, bits: GENESIS_BITS });
		const BITS_A = 0x1d00ffff;
		const BITS_B = 0x1c00ffff;
		const BITS_C = 0x1b00ffff;
		const headersByHeight = new Map<number, string>([
			[862_848, buildHeader({ time: 1_699_000_000, bits: BITS_A })],
			[864_864, buildHeader({ time: 1_699_500_000, bits: BITS_B })],
			[866_880, buildHeader({ time: 1_700_000_000, bits: BITS_C })]
		]);
		const headersSubscribe = vi.fn(async () => ({ height: TIP_HEIGHT, hex: tipHex }));
		const getBlockHeader = vi.fn(async (h: number) => {
			const hex = headersByHeight.get(h);
			if (!hex) throw new Error(`unstubbed height ${h}`);
			return hex;
		});
		withElectrum(svc, { headersSubscribe, getBlockHeader });

		const history = await svc.getDifficultyHistory(3);

		expect(history).not.toBeNull();
		expect(history!.map((h) => h.height)).toEqual([862_848, 864_864, 866_880]);
		expect(history![0].changePercent).toBeNull(); // oldest sample has no predecessor

		const dA = diffFromBits(BITS_A);
		const dB = diffFromBits(BITS_B);
		const dC = diffFromBits(BITS_C);
		expect(history![0].difficulty).toBeCloseTo(dA, 6);
		expect(history![1].changePercent).toBeCloseTo(((dB - dA) / dA) * 100, 6);
		expect(history![2].changePercent).toBeCloseTo(((dC - dB) / dB) * 100, 6);
	});

	it('returns null when the tip header fetch fails', async () => {
		const svc = makeService();
		const headersSubscribe = vi.fn(async () => {
			throw new Error('electrum down');
		});
		withElectrum(svc, { headersSubscribe });

		await expect(svc.getDifficultyHistory(3)).resolves.toBeNull();
	});
});

describe('getHashrate', () => {
	it('derives hashrate from the tip header difficulty (difficulty * 2^32 / 600)', async () => {
		const svc = makeService();
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS }); // difficulty 1
		const headersSubscribe = vi.fn(async () => ({ height: TIP_HEIGHT, hex }));
		withElectrum(svc, { headersSubscribe });

		await expect(svc.getHashrate()).resolves.toBeCloseTo((1 * 2 ** 32) / 600, 6);
	});

	it('returns null when the tip header is unavailable', async () => {
		const svc = makeService();
		const headersSubscribe = vi.fn(async () => {
			throw new Error('electrum down');
		});
		withElectrum(svc, { headersSubscribe });

		await expect(svc.getHashrate()).resolves.toBeNull();
	});
});

// ---- address lookup (electrum scripthash protocol, cairn-zoz8.6) -----------------

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // BIP-173 p2wpkh test vector
const SCRIPTHASH = addressToScripthash(ADDRESS);
const OUR_SCRIPT = scriptPubKeyHex(ADDRESS);
const OTHER_SCRIPT = '0014' + 'aa'.repeat(20);

describe('getAddressInfo', () => {
	it('derives balance/tx-count/used from get_balance + get_history; lifetime totals are null (no Electrum equivalent)', async () => {
		const svc = makeService();
		const getBalance = vi.fn(async (sh: string) => {
			expect(sh).toBe(SCRIPTHASH);
			return { confirmed: 400_000, unconfirmed: 25_000 };
		});
		const getHistory = vi.fn(async (sh: string) => {
			expect(sh).toBe(SCRIPTHASH);
			return [
				{ tx_hash: 'a'.repeat(64), height: 800_000 },
				{ tx_hash: 'b'.repeat(64), height: 0 }
			];
		});
		withElectrum(svc, { getBalance, getHistory });

		await expect(svc.getAddressInfo(ADDRESS)).resolves.toEqual({
			address: ADDRESS,
			scriptType: 'p2wpkh',
			confirmedBalance: 400_000,
			unconfirmedBalance: 25_000,
			txCount: 2,
			// Lifetime funded/spent sums have no Electrum equivalent
			// without walking every historical tx — null signals "unknown" rather
			// than a misleading 0 (the Explorer address page hides these when null).
			totalReceived: null,
			totalSent: null,
			used: true
		});
	});

	it('reports an unused address (empty history) with used:false', async () => {
		const svc = makeService();
		withElectrum(svc, {
			getBalance: vi.fn(async () => ({ confirmed: 0, unconfirmed: 0 })),
			getHistory: vi.fn(async () => [])
		});

		await expect(svc.getAddressInfo(ADDRESS)).resolves.toMatchObject({ txCount: 0, used: false });
	});

	it('surfaces a friendly error when the server rejects an over-large history', async () => {
		const svc = makeService();
		withElectrum(svc, {
			getBalance: vi.fn(async () => ({ confirmed: 0, unconfirmed: 0 })),
			getHistory: vi.fn(async () => {
				throw new Error('history too large');
			})
		});

		await expect(svc.getAddressInfo(ADDRESS)).rejects.toThrow(/too much history/i);
	});
});

describe('getAddressTxs', () => {
	// TX1: confirmed, address receives 150k funded by an external 200k prevout
	// (change 48,590 elsewhere) → fee 1,410, delta +150,000. TX2: mempool, spends
	// TX1's output onward → fee 1,000, delta -150,000.
	const TX1 = 'a'.repeat(64);
	const TX2 = 'b'.repeat(64);
	const PREV = 'c'.repeat(64);

	function withHistoryAndTxs(): {
		svc: ChainService;
		getHistory: ReturnType<typeof vi.fn>;
		getTransaction: ReturnType<typeof vi.fn>;
	} {
		const svc = makeService();
		const history = [
			{ tx_hash: TX2, height: 0 },
			{ tx_hash: TX1, height: 800_000 }
		];
		const txs: Record<string, unknown> = {
			[PREV]: {
				vin: [],
				vout: [
					{ value: 0.0001, scriptPubKey: { hex: OTHER_SCRIPT } },
					{ value: 0.002, scriptPubKey: { hex: OTHER_SCRIPT } } // funds TX1's input
				]
			},
			[TX1]: {
				vin: [{ txid: PREV, vout: 1 }],
				vout: [
					{ value: 0.0015, scriptPubKey: { hex: OUR_SCRIPT } },
					{ value: 0.0004859, scriptPubKey: { hex: OTHER_SCRIPT } }
				],
				blocktime: 1_750_000_000
			},
			[TX2]: {
				vin: [{ txid: TX1, vout: 0 }],
				vout: [{ value: 0.00149, scriptPubKey: { hex: OTHER_SCRIPT } }]
			}
		};
		const getHistory = vi.fn(async () => history);
		const getTransaction = vi.fn(async (txid: string) => txs[txid]);
		withElectrum(svc, { getHistory, getTransaction });
		return { svc, getHistory, getTransaction };
	}

	it('lists newest-first (mempool on top), hydrating delta/fee/time from verbose txs and their prevouts', async () => {
		const { svc, getHistory, getTransaction } = withHistoryAndTxs();

		const result = await svc.getAddressTxs(ADDRESS);

		expect(getHistory).toHaveBeenCalledTimes(1);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ txid: TX2, height: 0, time: null, delta: -150_000, fee: 1_000 });
		expect(result[1]).toMatchObject({
			txid: TX1,
			height: 800_000,
			time: 1_750_000_000,
			delta: 150_000,
			fee: 1_410
		});
		expect(getTransaction).toHaveBeenCalledWith(TX2, true);
	});

	it('pages via afterTxid by slicing the (already-fetched) history list client-side', async () => {
		const { svc } = withHistoryAndTxs();

		const rest = await svc.getAddressTxs(ADDRESS, TX2); // everything after the newest (mempool) entry
		expect(rest.map((t) => t.txid)).toEqual([TX1]);
	});

	it('surfaces a friendly error when the server rejects an over-large history', async () => {
		const svc = makeService();
		withElectrum(svc, {
			getHistory: vi.fn(async () => {
				throw new Error('server.Error: history too large');
			})
		});

		await expect(svc.getAddressTxs(ADDRESS)).rejects.toThrow(/too much history/i);
	});
});

// ---- fee histogram (electrum-backed, cairn-zoz8.2) ----------------------------------

// getFeeHistogram reads mempool.get_fee_histogram from the operator's own Electrum
// connection (cairn-zoz8.2). Stub the pooled Electrum facade (readonly is TS-only)
// so the facade's passthrough + empty→null collapse is exercised without a socket.
describe('getFeeHistogram (electrum-backed)', () => {
	function withElectrumHistogram(result: unknown): {
		svc: ChainService;
		getFeeHistogram: ReturnType<typeof vi.fn>;
	} {
		const svc = makeService();
		const getFeeHistogram = vi.fn(async () => result);
		Object.assign(svc, { electrum: { getFeeHistogram } });
		return { svc, getFeeHistogram };
	}

	it('passes the mempool.get_fee_histogram pairs through, highest fee first', async () => {
		const histogram: [number, number][] = [
			[120, 15_000],
			[50, 32_000],
			[10, 210_000],
			[1, 90_000]
		];
		const { svc, getFeeHistogram } = withElectrumHistogram(histogram);

		await expect(svc.getFeeHistogram()).resolves.toEqual(histogram);
		expect(getFeeHistogram).toHaveBeenCalledTimes(1);
	});

	it('collapses an empty mempool histogram to null', async () => {
		const { svc } = withElectrumHistogram([]);
		await expect(svc.getFeeHistogram()).resolves.toBeNull();
	});

	// ---- 30s TTL caches + single-fetch projection (cairn-6efi.1, U3) -----------
	it('serves a second getFeeHistogram from the TTL cache (one electrum round-trip)', async () => {
		const svc = makeService();
		const getFeeHistogram = vi.fn(async () => [[20, 1000]] as [number, number][]);
		Object.assign(svc, { electrum: { getFeeHistogram } });

		const a = await svc.getFeeHistogram();
		const b = await svc.getFeeHistogram();
		expect(getFeeHistogram).toHaveBeenCalledTimes(1); // second is a cache hit
		expect(a).toEqual(b);
	});

	it('serves a second getMempoolSummary from the TTL cache (one Core round-trip)', async () => {
		const core = makeCoreStub();
		core.getMempoolInfo.mockResolvedValue({
			size: 5,
			bytes: 2000,
			usage: 0,
			total_fee: 0.001,
			mempoolminfee: 0
		});
		const svc = makeCoreService(core);

		await svc.getMempoolSummary();
		await svc.getMempoolSummary();
		expect(core.getMempoolInfo).toHaveBeenCalledTimes(1);
	});

	it('getMempoolBlocks(sharedHistogram) projects from the passed value without re-fetching', async () => {
		const svc = makeService();
		const getFeeHistogram = vi.fn(async () => null);
		Object.assign(svc, { electrum: { getFeeHistogram } });

		const projected = await svc.getMempoolBlocks([
			[100, 1_000_000],
			[10, 500_000]
		]);
		// The shared histogram was used directly — no internal histogram fetch.
		expect(getFeeHistogram).not.toHaveBeenCalled();
		expect(projected).not.toBeNull();
	});
});

// ---- Bitcoin Core RPC path ---------------------------------------------------------
//
// getTx/getBlock/getBlockTxs/getMempoolSummary/getCpfpInfo source from the operator's
// own Core node (the sole source of this rich detail). These tests pin the Core→app
// mapping — especially the BTC→sats unit conversions (Core reports values as BTC
// floats), confirmations→height, and per-output gettxout spent-ness.

interface CoreStub {
	call: ReturnType<typeof vi.fn>;
	getBlockHash: ReturnType<typeof vi.fn>;
	getBlock: ReturnType<typeof vi.fn>;
	getBlockStats: ReturnType<typeof vi.fn>;
	getRawTransaction: ReturnType<typeof vi.fn>;
	getTxOut: ReturnType<typeof vi.fn>;
	getMempoolInfo: ReturnType<typeof vi.fn>;
	getMempoolEntry: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

/** A confirmed 1-in/2-out segwit tx as Bitcoin Core `getrawtransaction verbosity=2`
 *  returns it — values in BTC, prevout present on the input. */
const CORE_TX = {
	txid: 'f'.repeat(64),
	version: 2,
	size: 222,
	vsize: 141,
	weight: 561,
	locktime: 0,
	vin: [
		{
			txid: 'e'.repeat(64),
			vout: 1,
			scriptSig: { hex: '' },
			sequence: 0xfffffffd, // BIP125 opt-in
			txinwitness: ['02abcd'],
			prevout: {
				generated: false,
				height: TIP_HEIGHT - 100,
				value: 0.002, // 200,000 sats
				scriptPubKey: {
					hex: '0014' + 'aa'.repeat(20),
					address: 'bc1qsender',
					type: 'witness_v0_keyhash'
				}
			}
		}
	],
	vout: [
		{
			value: 0.0015, // 150,000 sats
			n: 0,
			scriptPubKey: { hex: WATCHED_SCRIPT, address: 'bc1qreceiver', type: 'witness_v0_keyhash' }
		},
		{
			value: 0.0004859, // 48,590 sats
			n: 1,
			scriptPubKey: { hex: '0014' + 'cc'.repeat(20), address: 'bc1qchange', type: 'witness_v0_keyhash' }
		}
	],
	confirmations: 11,
	blockhash: 'd'.repeat(64),
	blocktime: 1_750_000_000,
	time: 1_750_000_000
};

function makeCoreStub(): CoreStub {
	return {
		call: vi.fn(async (method: string) => {
			if (method === 'getrawtransaction') return CORE_TX;
			if (method === 'getmempoolancestors') return [];
			if (method === 'getmempooldescendants') return [];
			throw new Error(`unstubbed core.call ${method}`);
		}),
		getBlockHash: vi.fn(async () => BLOCK.id),
		getBlock: vi.fn(),
		getBlockStats: vi.fn(),
		getRawTransaction: vi.fn(async () => CORE_TX),
		// n=0 spent (null), n=1 unspent (object). include_mempool passed through.
		getTxOut: vi.fn(async (_txid: string, n: number) => (n === 0 ? null : { value: 0.0004859 })),
		getMempoolInfo: vi.fn(),
		getMempoolEntry: vi.fn(),
		close: vi.fn()
	};
}

/** A ChainService wired to a stubbed Core client, with a tip header stub so
 *  getTip() (used for confirmations→height) resolves. */
function makeCoreService(core: CoreStub): ChainService {
	const svc = new ChainService(CFG as unknown as ConstructorParameters<typeof ChainService>[0]);
	const tipHex = buildHeader({ time: 1_750_000_000, bits: GENESIS_BITS });
	Object.assign(svc, { core });
	Object.assign(svc.electrum, {
		headersSubscribe: vi.fn(async () => ({ height: TIP_HEIGHT, hex: tipHex }))
	});
	return svc;
}

describe('getTx via Bitcoin Core', () => {
	it('maps getrawtransaction verbosity=2: BTC→sats values, fee from prevout−vout, confirmations→height', async () => {
		const core = makeCoreStub();
		const svc = makeCoreService(core);

		const tx = await svc.getTx(CORE_TX.txid);

		expect(core.call).toHaveBeenCalledWith('getrawtransaction', [CORE_TX.txid, 2]);
		expect(tx.confirmed).toBe(true);
		// height derived from tip − confirmations + 1 = 868000 − 11 + 1 = 867990.
		expect(tx.blockHeight).toBe(TIP_HEIGHT - 10);
		expect(tx.confirmations).toBe(11);
		expect(tx.blockHash).toBe('d'.repeat(64));
		expect(tx.blockTime).toBe(1_750_000_000);

		// vout values converted BTC→sats.
		expect(tx.vout[0].value).toBe(150_000);
		expect(tx.vout[0].address).toBe('bc1qreceiver');
		expect(tx.vout[0].scriptPubKey).toBe(WATCHED_SCRIPT);
		expect(tx.vout[1].value).toBe(48_590);

		// vin prevout: value BTC→sats, address + prev scriptPubKey.
		expect(tx.vin[0]).toMatchObject({
			txid: 'e'.repeat(64),
			vout: 1,
			address: 'bc1qsender',
			value: 200_000,
			prevScriptPubKey: '0014' + 'aa'.repeat(20),
			coinbase: false
		});

		// fee = Σprevout(200000) − Σvout(150000+48590) = 1410; feeRate = 1410/141 = 10.
		expect(tx.fee).toBe(1_410);
		expect(tx.feeRate).toBe(10);
		expect(tx.vsize).toBe(141);
		expect(tx.segwit).toBe(true);
		expect(tx.rbf).toBe(true);

		// per-output spent-ness from gettxout: n=0 null→spent, n=1 object→unspent.
		expect(tx.vout[0].spent).toBe(true);
		expect(tx.vout[1].spent).toBe(false);
		expect(core.getTxOut).toHaveBeenCalledWith(CORE_TX.txid, 0, true);
		expect(core.getTxOut).toHaveBeenCalledWith(CORE_TX.txid, 1, true);
	});

	it('reports a mempool tx (no confirmations) with null block fields', async () => {
		const core = makeCoreStub();
		core.call.mockImplementation(async (method: string) => {
			if (method === 'getrawtransaction') {
				const { confirmations: _c, blockhash: _b, blocktime: _t, ...rest } = CORE_TX;
				return rest;
			}
			throw new Error(`unstubbed ${method}`);
		});
		const svc = makeCoreService(core);

		const tx = await svc.getTx(CORE_TX.txid);
		expect(tx.confirmed).toBe(false);
		expect(tx.confirmations).toBe(0);
		expect(tx.blockHeight).toBeNull();
		expect(tx.blockHash).toBeNull();
		expect(tx.blockTime).toBeNull();
	});

	it('degrades spent-ness to null when a gettxout call fails', async () => {
		const core = makeCoreStub();
		core.getTxOut.mockRejectedValue(new Error('gettxout failed'));
		const svc = makeCoreService(core);

		const tx = await svc.getTx(CORE_TX.txid); // must not throw
		expect(tx.vout.map((v) => v.spent)).toEqual([null, null]);
	});

	// A Core node without -txindex reports code -5 for BOTH "genuinely no such tx"
	// and "confirmed tx exists but isn't in the mempool/wallet and Core has no
	// index to find it". With Esplora removed there is no fallback index, so either
	// case surfaces as not-found (an operator who wants arbitrary historical tx
	// lookups runs Core with -txindex).
	it('throws a not-found error for a Core -5/-8 so search can fall through', async () => {
		const core = makeCoreStub();
		core.call.mockRejectedValue(new CoreRpcError(-5, 'getrawtransaction', 'No such tx. Use -txindex.'));
		const svc = makeCoreService(core);

		await expect(svc.getTx(CORE_TX.txid)).rejects.toThrow(/not found/i);
	});
});

describe('getBlock via Bitcoin Core', () => {
	const CORE_BLOCK = {
		hash: BLOCK.id,
		height: BLOCK.height,
		version: 0x20000000,
		merkleroot: 'e'.repeat(64),
		time: 1_750_000_000,
		nonce: 12_345,
		bits: '1b0404cb', // Core returns nBits as a hex string already
		difficulty: 9.5e13,
		nTx: 3_000,
		previousblockhash: 'a'.repeat(64),
		size: 1_500_000,
		weight: 3_990_000,
		confirmations: 11,
		tx: []
	};

	it('maps getblock + getblockstats: fee percentiles → medianFee/feeRange, totalfee/subsidy already sats', async () => {
		const core = makeCoreStub();
		core.getBlock.mockResolvedValue(CORE_BLOCK);
		core.getBlockStats.mockResolvedValue({
			feerate_percentiles: [1, 5, 12.345, 40, 100.129], // [10,25,50,75,90] sat/vB
			totalfee: 12_345_678, // sats (Core getblockstats fee amounts are in sats)
			subsidy: 312_500_000 // sats
		});
		const svc = makeCoreService(core);

		const block = await svc.getBlock(BLOCK.height);

		expect(core.getBlockHash).toHaveBeenCalledWith(BLOCK.height);
		expect(block.hash).toBe(BLOCK.id);
		expect(block.txCount).toBe(3_000);
		expect(block.bits).toBe('1b0404cb'); // passthrough, no toString(16)
		expect(block.prevHash).toBe('a'.repeat(64));
		expect(block.merkleRoot).toBe('e'.repeat(64));
		// median = 50th pct; feeRange = [10th, 90th]; rounded 2dp.
		expect(block.medianFee).toBe(12.35);
		expect(block.feeRange).toEqual([1, 100.13]);
		expect(block.totalFees).toBe(12_345_678);
		expect(block.reward).toBe(312_500_000 + 12_345_678); // subsidy + fees
		expect(block.miner).toBeUndefined();
	});

	it('degrades fee/reward to null when getblockstats is unavailable', async () => {
		const core = makeCoreStub();
		core.getBlock.mockResolvedValue(CORE_BLOCK);
		core.getBlockStats.mockRejectedValue(new Error('getblockstats disabled'));
		const svc = makeCoreService(core);

		const block = await svc.getBlock(BLOCK.id);
		expect(block.medianFee).toBeNull();
		expect(block.feeRange).toBeNull();
		expect(block.totalFees).toBeNull();
		expect(block.reward).toBeNull();
	});

	it('getBlockTxs slices the page, sets total=nTx, and marks txs confirmed in the block', async () => {
		const core = makeCoreStub();
		const txids = Array.from({ length: 60 }, (_, i) => String(i).padStart(64, '0'));
		core.getBlock.mockResolvedValue({ ...CORE_BLOCK, tx: txids, nTx: 60 });
		// getrawtransaction with blockhash for each txid in the page.
		core.call.mockImplementation(async (method: string) => {
			if (method === 'getrawtransaction') return CORE_TX;
			throw new Error(`unstubbed ${method}`);
		});
		const svc = makeCoreService(core);

		const res = await svc.getBlockTxs(BLOCK.id, 1); // page 1 → txids[25..49]
		expect(res.total).toBe(60);
		expect(res.txs).toHaveLength(25);
		// tx confirmed in the block; height from the block context, not per-tx guess.
		expect(res.txs[0].confirmed).toBe(true);
		expect(res.txs[0].blockHeight).toBe(BLOCK.height);
		expect(res.txs[0].blockHash).toBe(BLOCK.id);
		// verbosity 2 + blockhash resolves txs without txindex.
		expect(core.call).toHaveBeenCalledWith('getrawtransaction', [txids[25], 2, BLOCK.id]);
	});
});

describe('getMempoolSummary via Bitcoin Core', () => {
	it('maps getmempoolinfo: size→txCount, bytes→vsize, total_fee BTC→sats', async () => {
		const core = makeCoreStub();
		core.getMempoolInfo.mockResolvedValue({
			size: 4_200,
			bytes: 8_500_000,
			usage: 20_000_000,
			total_fee: 0.0512, // BTC → 5,120,000 sats
			mempoolminfee: 0.00001
		});
		const svc = makeCoreService(core);

		await expect(svc.getMempoolSummary()).resolves.toEqual({
			txCount: 4_200,
			vsize: 8_500_000,
			totalFees: 5_120_000
		});
	});
});

describe('getCpfpInfo via Bitcoin Core', () => {
	it('derives effective fee rate (BTC→sats) and ancestor/descendant txids from the mempool graph', async () => {
		const core = makeCoreStub();
		core.getMempoolEntry.mockResolvedValue({
			fees: { base: 0.00001, ancestor: 0.00003, descendant: 0.00001 },
			ancestorsize: 600, // 0.00003 BTC = 3000 sats over 600 vB → 5 sat/vB
			descendantsize: 300,
			ancestorcount: 2,
			descendantcount: 1
		});
		core.call.mockImplementation(async (method: string) => {
			if (method === 'getmempoolancestors') return ['a'.repeat(64)];
			if (method === 'getmempooldescendants') return [];
			throw new Error(`unstubbed ${method}`);
		});
		const svc = makeCoreService(core);

		const cpfp = await svc.getCpfpInfo(CORE_TX.txid);
		expect(cpfp).not.toBeNull();
		// max(ancestorRate 5, descendantRate 1000sats/300=3.33) = 5 sat/vB.
		expect(cpfp!.effectiveFeeRate).toBe(5);
		expect(cpfp!.ancestors).toEqual(['a'.repeat(64)]);
		expect(cpfp!.descendants).toEqual([]);
	});

	it('returns null for a tx not in the mempool (getmempoolentry code -5)', async () => {
		const core = makeCoreStub();
		core.getMempoolEntry.mockRejectedValue(
			new CoreRpcError(-5, 'getmempoolentry', 'Transaction not in mempool')
		);
		const svc = makeCoreService(core);

		await expect(svc.getCpfpInfo(CORE_TX.txid)).resolves.toBeNull();
	});
});

describe('getMempoolBlocks projection from the Electrum fee histogram', () => {
	it('packs 1 MvB blocks highest-fee-first with per-block fee range and rounded totals', async () => {
		const svc = makeCoreService(makeCoreStub());
		// 1.2 MvB at 100 sat/vB, 0.5 MvB at 10 sat/vB → block 1 fills 1 MvB from the
		// 100-rate bucket; block 2 gets the 0.2 MvB tail at 100 plus 0.5 MvB at 10.
		Object.assign(svc.electrum, {
			getFeeHistogram: vi.fn(async () => [
				[100, 1_200_000],
				[10, 500_000]
			])
		});

		const blocks = await svc.getMempoolBlocks();
		expect(blocks).not.toBeNull();
		expect(blocks!.length).toBe(2);
		expect(blocks![0].vsize).toBe(1_000_000);
		expect(blocks![0].feeRange).toEqual([100, 100]);
		expect(blocks![0].totalFees).toBe(100 * 1_000_000); // 100 sat/vB × 1e6 vB
		// block 2: 0.2M @100 + 0.5M @10 → range [10,100], vsize 700000.
		expect(blocks![1].vsize).toBe(700_000);
		expect(blocks![1].feeRange).toEqual([10, 100]);
	});

	it('returns null when the mempool histogram is empty', async () => {
		const svc = makeCoreService(makeCoreStub());
		Object.assign(svc.electrum, { getFeeHistogram: vi.fn(async () => []) });
		await expect(svc.getMempoolBlocks()).resolves.toBeNull();
	});
});

// ---- post-Esplora-removal regressions (cairn-zoz8.16) ------------------------------
//
// With no Core RPC configured, the Core-backed methods must fail with an honest
// "needs Core RPC" error — NEVER silently reach out to a third-party HTTP host
// (the whole point of the removal). getTxRbfInfo is now unconditionally null.

describe('no Core RPC configured (Esplora removed)', () => {
	// getBlock / getBlockTxs / getMempoolSummary stay Core-only (a bare Electrum header
	// carries none of that detail). getTx is the exception: it now degrades to the
	// full-indexing Electrum fallback (docs/TX-BLOCK-CONTEXT-DESIGN.md §2, covered by
	// the "getTx via Electrum fallback" describe) instead of throwing, so it is
	// deliberately not asserted here.
	it('getBlock/getMempoolSummary throw a clear "needs Core RPC" error without any fetch', async () => {
		const fetchSpy = vi.fn(async () => {
			throw new Error('no external fetch should ever happen here');
		});
		vi.stubGlobal('fetch', fetchSpy);
		const svc = makeService(); // CFG has no coreRpcUrl → core is null

		await expect(svc.getBlock('a'.repeat(64))).rejects.toThrow(/Bitcoin Core RPC/);
		await expect(svc.getMempoolSummary()).rejects.toThrow(/Bitcoin Core RPC/);
		// No chain method dialed any host — there is no Esplora fallback to leak to.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('getBlockTxs throws a clear "needs Core RPC" error', async () => {
		const svc = makeService();
		await expect(svc.getBlockTxs('a'.repeat(64))).rejects.toThrow(/Bitcoin Core RPC/);
	});

	it('getCpfpInfo returns null when Core RPC is not configured', async () => {
		const svc = makeService();
		await expect(svc.getCpfpInfo('a'.repeat(64))).resolves.toBeNull();
	});

	it('getTxRbfInfo always returns null (no Core-based RBF watcher yet, cairn-zoz8.13)', async () => {
		const withCore = makeCoreService(makeCoreStub());
		await expect(withCore.getTxRbfInfo('a'.repeat(64))).resolves.toBeNull();
		const noCore = makeService();
		await expect(noCore.getTxRbfInfo('a'.repeat(64))).resolves.toBeNull();
	});

	it('getBtcUsdPrice is the one remaining external call (public price source)', async () => {
		const fetchSpy = vi.fn(async () =>
			new Response(JSON.stringify({ USD: 65_000 }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchSpy);
		const svc = makeService();
		await expect(svc.getBtcUsdPrice()).resolves.toBe(65_000);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain('/v1/prices');
	});
});

// ---- testCoreRpc (admin settings "Test connection" — qa-findings-R8.md X3) ------

describe('testCoreRpc', () => {
	it('reports ok with the chain + tip height on success', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ result: { blocks: 868_123, chain: 'main' }, error: null }), {
					status: 200
				})
			)
		);
		const res = await testCoreRpc({ url: 'http://127.0.0.1:8332', user: 'u', pass: 'p' });
		expect(res).toEqual({ ok: true, blockHeight: 868_123, chain: 'main' });
	});

	it('wraps a transport failure (ECONNREFUSED) in house-standard "what happened + what to do" copy, keeping the raw detail', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('fetch failed', {
					cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19999'), {
						code: 'ECONNREFUSED'
					})
				});
			})
		);
		const res = await testCoreRpc({ url: 'http://127.0.0.1:19999', user: 'bogus', pass: 'bogus' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/^Couldn't connect to Bitcoin Core:/);
		expect(res.error).toContain('Check the RPC URL');
		// The raw diagnosable detail (qa-findings-R8.md X3's own evidence) is kept
		// verbatim, never the only thing an admin sees.
		expect(res.error).toContain('ECONNREFUSED');
	});

	it('wraps a 401 Unauthorized failure the same way', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('Unauthorized', { status: 401 }))
		);
		const res = await testCoreRpc({ url: 'http://127.0.0.1:8332', user: 'wrong', pass: 'wrong' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/^Couldn't connect to Bitcoin Core:/);
		expect(res.error).toContain('401 Unauthorized');
	});

	// cairn-mf9i — a relative/invalid URL used to reach global fetch and throw a
	// SvelteKit-internal "use event.fetch" error, leaked verbatim to the admin.
	it('rejects a relative/invalid URL with plain copy BEFORE any fetch (cairn-mf9i)', async () => {
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		const res = await testCoreRpc({ url: 'not-a-url', user: 'u', pass: 'p' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/doesn't look like a valid URL/i);
		// No SvelteKit internals / docs link.
		expect(res.error).not.toMatch(/event\.fetch|svelte\.dev|relative URL/i);
		// The URL never even reached fetch.
		expect(spy).not.toHaveBeenCalled();
	});

	it('rejects a non-http(s) scheme up front (cairn-mf9i)', async () => {
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		const res = await testCoreRpc({ url: 'ftp://example.com', user: 'u', pass: 'p' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/doesn't look like a valid URL/i);
		expect(spy).not.toHaveBeenCalled();
	});

	// cairn-i9u6 — the 8s AbortController firing used to leak "This operation was
	// aborted (20)" (Node ABORT_ERR), meaningless to an operator.
	it('maps an abort/timeout to plain "no response" copy (cairn-i9u6)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw Object.assign(new Error('This operation was aborted'), { code: 20 });
			})
		);
		const res = await testCoreRpc({ url: 'http://10.255.255.1:8332', user: 'u', pass: 'p' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/No response from the node after 8 seconds/i);
		// The raw abort/errno text is gone.
		expect(res.error).not.toMatch(/aborted|\(20\)/i);
	});

	// cairn-ymcg — a 403 with an empty body used to render "HTTP 403: ." with no
	// rpcallowip hint and a misleading "check username/password".
	it('maps HTTP 403 to an rpcallowip hint, no dangling punctuation (cairn-ymcg)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 403 }))
		);
		const res = await testCoreRpc({ url: 'http://192.168.50.146:8332', user: 'u', pass: 'p' });
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/rpcallowip/);
		expect(res.error).toMatch(/HTTP 403/);
		// No dangling "HTTP 403: ." artifact, and no misdirecting credential hint.
		expect(res.error).not.toContain('HTTP 403: .');
		expect(res.error).not.toContain('HTTP 403: ');
		expect(res.error).not.toMatch(/username\/password/i);
	});

	it('trims an empty response body so no "HTTP NNN: ." dangling colon renders (cairn-ymcg)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 502 }))
		);
		const res = await testCoreRpc({ url: 'http://127.0.0.1:8332', user: 'u', pass: 'p' });
		expect(res.ok).toBe(false);
		expect(res.error).toContain('HTTP 502');
		// The dangling ": ." from an empty body is gone at the transport layer.
		expect(res.error).not.toContain('HTTP 502:');
	});
});

// ---- coreRpcUrlError (URL validation guard, cairn-mf9i) ------------------------

describe('coreRpcUrlError', () => {
	it('accepts absolute http and https URLs', () => {
		expect(coreRpcUrlError('http://127.0.0.1:8332')).toBeNull();
		expect(coreRpcUrlError('https://node.local:8332')).toBeNull();
	});

	it('rejects a relative/non-URL string with plain copy', () => {
		expect(coreRpcUrlError('not-a-url')).toMatch(/valid URL/i);
	});

	it('rejects a non-http(s) scheme', () => {
		expect(coreRpcUrlError('ftp://example.com')).toMatch(/valid URL/i);
	});
});

// ---- getTx Electrum-only fallback (docs/TX-BLOCK-CONTEXT-DESIGN.md §2) --------------
//
// With Esplora removed and NO Core RPC configured, getTx falls back to the operator's
// own full-indexing Electrum server (electrs / Fulcrum), whose verbose tx is Core's
// getrawtransaction-verbose shape exactly — no prevout, so fee/input values degrade to
// null, but the tx renders (unlocking the tx page + its block-context section).

/** A confirmed 1-in/2-out segwit tx as Electrum verbose (=Core getrawtransaction
 *  verbose, verbosity 1): decoded, but NO prevout on the input. */
const ELECTRUM_VERBOSE_TX = {
	txid: 'f'.repeat(64),
	version: 2,
	size: 222,
	vsize: 141,
	weight: 561,
	locktime: 0,
	vin: [
		{
			txid: 'e'.repeat(64),
			vout: 1,
			scriptSig: { hex: '' },
			sequence: 0xfffffffd,
			txinwitness: ['02abcd']
			// no prevout at this verbosity
		}
	],
	vout: [
		{ value: 0.0015, n: 0, scriptPubKey: { hex: WATCHED_SCRIPT, address: 'bc1qreceiver', type: 'witness_v0_keyhash' } },
		{ value: 0.0004859, n: 1, scriptPubKey: { hex: '0014' + 'cc'.repeat(20), address: 'bc1qchange', type: 'witness_v0_keyhash' } }
	],
	confirmations: 98,
	blockhash: 'd'.repeat(64),
	blocktime: 1_750_000_000,
	time: 1_750_000_000
};

describe('getTx via Electrum fallback (no Core)', () => {
	it('decodes a verbose Electrum tx to a TxDetail with null fee (no prevout) and confirmations→height', async () => {
		const svc = makeService();
		const tipHex = buildHeader({ time: 1_750_000_000, bits: GENESIS_BITS });
		const getTransaction = vi.fn(async () => ELECTRUM_VERBOSE_TX);
		withElectrum(svc, {
			getTransaction,
			headersSubscribe: vi.fn(async () => ({ height: TIP_HEIGHT, hex: tipHex }))
		});

		const tx = await svc.getTx(ELECTRUM_VERBOSE_TX.txid);

		// verbose=true requested from Electrum.
		expect(getTransaction).toHaveBeenCalledWith(ELECTRUM_VERBOSE_TX.txid, true);
		expect(tx.confirmed).toBe(true);
		expect(tx.confirmations).toBe(98);
		expect(tx.blockHeight).toBe(TIP_HEIGHT - 97); // tip − 98 + 1
		expect(tx.blockHash).toBe('d'.repeat(64));
		// No prevout ⇒ fee + input value/address are null (degraded, not fabricated).
		expect(tx.fee).toBeNull();
		expect(tx.feeRate).toBeNull();
		expect(tx.vin[0].value).toBeNull();
		expect(tx.vin[0].address).toBeNull();
		// Outputs still decode fully (BTC→sats).
		expect(tx.vout[0].value).toBe(150_000);
		expect(tx.vout[0].address).toBe('bc1qreceiver');
		// vsize present ⇒ block-context summary can still name the size.
		expect(tx.vsize).toBe(141);
	});

	it('maps an electrs "No such … transaction" to a not-found error', async () => {
		const svc = makeService();
		withElectrum(svc, {
			getTransaction: vi.fn(async () => {
				throw new Error('No such mempool or blockchain transaction. Use gettransaction for wallet transactions.');
			})
		});

		await expect(svc.getTx(ELECTRUM_VERBOSE_TX.txid)).rejects.toThrow(/not found/i);
	});

	it('propagates a non-not-found Electrum error unchanged (real outage ≠ not-found)', async () => {
		const svc = makeService();
		withElectrum(svc, {
			getTransaction: vi.fn(async () => {
				throw new Error('read ECONNRESET');
			})
		});

		await expect(svc.getTx(ELECTRUM_VERBOSE_TX.txid)).rejects.toThrow(/ECONNRESET/);
	});
});

// ---- getTxBlockContext tiering (docs/TX-BLOCK-CONTEXT-DESIGN.md §3, §9) -------------

const BLOCK_CTX_TIP = 948_294; // tip so a 98-conf tx lands on height 948,197

/** Wire an Electrum-only service for block-context: tip, per-height headers (each a
 *  distinct timestamp so neighbour dates differ), the verbose tx, and a merkle proof. */
function makeBlockCtxElectrum(opts: {
	svc: ChainService;
	tip?: number;
	tx?: unknown;
	merkle?: { pos: number; merkle: string[] } | null;
	headerFor?: (h: number) => string | null;
}): void {
	const tip = opts.tip ?? BLOCK_CTX_TIP;
	const tipHex = buildHeader({ time: 1_750_000_000, bits: GENESIS_BITS });
	const getBlockHeader = vi.fn(async (h: number) => {
		const hex = opts.headerFor
			? opts.headerFor(h)
			: buildHeader({ time: 1_750_000_000 + h, bits: GENESIS_BITS, nonce: h });
		if (hex === null) throw new Error(`no header for height ${h}`);
		return hex;
	});
	withElectrum(opts.svc, {
		headersSubscribe: vi.fn(async () => ({ height: tip, hex: tipHex })),
		getTransaction: vi.fn(async () => opts.tx ?? ELECTRUM_VERBOSE_TX),
		getBlockHeader,
		getMerkleProof:
			opts.merkle === null
				? vi.fn(async () => {
						throw new Error('get_merkle not supported');
					})
				: vi.fn(async () => opts.merkle ?? { pos: 42, merkle: ['a', 'b', 'c'] })
	});
}

describe('getTxBlockContext', () => {
	it('basic tier (Electrum only): 3 neighbours with dates, exact position, null block stats', async () => {
		const svc = makeService();
		makeBlockCtxElectrum({ svc, merkle: { pos: 42, merkle: ['a', 'b', 'c', 'd'] } });

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);

		expect(ctx.richness).toBe('basic');
		expect(ctx.confirmed).toBe(true);
		expect(ctx.height).toBe(948_197);
		expect(ctx.confirmations).toBe(98);
		expect(ctx.tipHeight).toBe(BLOCK_CTX_TIP);
		// neighbours ascending, current flagged, each with a real date.
		expect(ctx.neighbors.map((n) => n.height)).toEqual([948_196, 948_197, 948_198]);
		expect(ctx.neighbors.find((n) => n.isCurrent)?.height).toBe(948_197);
		expect(ctx.neighbors.every((n) => n.time !== null && n.hash !== null)).toBe(true);
		// exact position from the merkle proof; denominator is the depth estimate.
		expect(ctx.position).toBe(42);
		expect(ctx.positionEstimated).toBe(true);
		expect(ctx.positionTotal).toBe(2 ** 4); // 2 ** merkle.length
		// no Core ⇒ per-block stats stay null.
		expect(ctx.neighbors.every((n) => n.txCount === null && n.size === null && n.fullness === null)).toBe(true);
	});

	it('full tier (+Core): per-block txCount/size/fullness and the exact position denominator', async () => {
		const core = makeCoreStub();
		const svc = makeCoreService(core);
		makeBlockCtxElectrum({ svc, merkle: { pos: 42, merkle: ['a', 'b', 'c'] } });
		core.getBlockStats.mockResolvedValue({
			txs: 2_500,
			total_size: 1_312_000,
			total_weight: 3_600_000,
			feerate_percentiles: [1, 2, 3, 4, 5]
		});

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);

		expect(ctx.richness).toBe('full');
		const current = ctx.neighbors.find((n) => n.isCurrent)!;
		expect(current.txCount).toBe(2_500);
		expect(current.size).toBe(1_312_000);
		expect(current.fullness).toBeCloseTo(3_600_000 / 4_000_000, 6);
		// exact denominator from Core replaces the merkle-depth estimate.
		expect(ctx.positionTotal).toBe(2_500);
		expect(ctx.positionEstimated).toBe(false);
	});

	it('tip failure ⇒ richness "none" (honest connecting state, no fake data)', async () => {
		const svc = makeService();
		withElectrum(svc, {
			headersSubscribe: vi.fn(async () => {
				throw new Error('electrum unreachable');
			})
		});

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		expect(ctx.richness).toBe('none');
		expect(ctx.height).toBeNull();
		expect(ctx.neighbors).toEqual([]);
	});

	it('a single neighbour header failure degrades only that entry (time/hash null)', async () => {
		const svc = makeService();
		makeBlockCtxElectrum({
			svc,
			// the previous block's header fails; the others resolve.
			headerFor: (h) => (h === 948_196 ? null : buildHeader({ time: 1_750_000_000 + h, bits: GENESIS_BITS, nonce: h }))
		});

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		const prev = ctx.neighbors.find((n) => n.height === 948_196)!;
		expect(prev.time).toBeNull();
		expect(prev.hash).toBeNull();
		// the rest are intact.
		expect(ctx.neighbors.find((n) => n.isCurrent)?.time).not.toBeNull();
	});

	it('unconfirmed (mempool) tx ⇒ confirmed:false, no neighbours, basic tier', async () => {
		const svc = makeService();
		const { confirmations: _c, blockhash: _b, blocktime: _t, ...mempoolTx } = ELECTRUM_VERBOSE_TX;
		makeBlockCtxElectrum({ svc, tx: mempoolTx });

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		expect(ctx.richness).toBe('basic');
		expect(ctx.confirmed).toBe(false);
		expect(ctx.confirmations).toBe(0);
		expect(ctx.height).toBeNull();
		expect(ctx.neighbors).toEqual([]);
	});

	it('tx at the tip ⇒ 2-block row (no next block)', async () => {
		const svc = makeService();
		// 1 confirmation ⇒ height == tip == 948,294.
		const atTipTx = { ...ELECTRUM_VERBOSE_TX, confirmations: 1 };
		makeBlockCtxElectrum({ svc, tx: atTipTx });

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		expect(ctx.height).toBe(BLOCK_CTX_TIP);
		expect(ctx.neighbors.map((n) => n.height)).toEqual([BLOCK_CTX_TIP - 1, BLOCK_CTX_TIP]);
		expect(ctx.confirmations).toBe(1);
	});

	it('genesis tx ⇒ no previous block (row starts at height 0)', async () => {
		const svc = makeService();
		// confirmations == tip + 1 ⇒ height 0.
		const genesisTx = { ...ELECTRUM_VERBOSE_TX, confirmations: BLOCK_CTX_TIP + 1 };
		makeBlockCtxElectrum({ svc, tx: genesisTx });

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		expect(ctx.height).toBe(0);
		expect(ctx.neighbors.map((n) => n.height)).toEqual([0, 1]);
	});

	it('merkle proof unsupported ⇒ position null, block row still renders', async () => {
		const svc = makeService();
		makeBlockCtxElectrum({ svc, merkle: null });

		const ctx = await svc.getTxBlockContext(ELECTRUM_VERBOSE_TX.txid);
		expect(ctx.position).toBeNull();
		expect(ctx.positionTotal).toBeNull();
		// the three-block row is unaffected.
		expect(ctx.neighbors.map((n) => n.height)).toEqual([948_196, 948_197, 948_198]);
		expect(ctx.richness).toBe('basic');
	});
});
