// Regression tests for cairn-a0nb: the ChainService facade (chain/index.ts) had
// zero test coverage. Pins down the facade's mapping/normalization logic. getTx
// and getBlock still run against a stubbed Esplora backend (toTxDetail —
// confirmations from the tip, vout scriptPubKey passthrough, fee-rate/segwit/RBF
// derivation — and the outspends degrade-to-null path). The chain views migrated
// off esplora onto the operator's own Electrum server (cairn-zoz8.1/.3/.5/.6) —
// getTip, getRecentBlocks, getFeeEstimates, getDifficultyInfo/History, getHashrate,
// getAddressInfo/getAddressTxs — run against a stubbed Electrum pool instead.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { EsploraBlock, EsploraTx } from './esplora';
import { scriptPubKeyHex, addressToScripthash } from '../bitcoin/xpub';

// Keep the ChainService constructor side-effect free: no Electrum sockets, no
// activity-feed wiring, no package-relay probing. The esplora client itself is
// replaced per-test with a stub object.
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

import { ChainService, testCoreRpc } from './index';
import { CoreRpcError } from '../bitcoinCore/client';
import { resetChainCaches, invalidateTipCache, clearRawTxCache, rawTxCacheSize } from './cache';

// ---- fixtures -----------------------------------------------------------------

const TIP_HEIGHT = 868_000;
const TIP_HASH = 't'.repeat(64);

const CFG = {
	mode: 'custom',
	electrumHost: '127.0.0.1',
	electrumPort: 50001,
	electrumTls: false,
	electrumTlsInsecure: false,
	socks5Host: null,
	socks5Port: null,
	electrumPoolSize: 1,
	esploraUrl: 'http://esplora.test'
};

const WATCHED_SCRIPT = '0014' + 'bb'.repeat(20);

/** Confirmed 2-in/2-out-shaped segwit tx, 10 blocks deep, RBF-signalled. */
const ESPLORA_TX: EsploraTx = {
	txid: 'f'.repeat(64),
	version: 2,
	locktime: 0,
	vin: [
		{
			txid: 'e'.repeat(64),
			vout: 1,
			is_coinbase: false,
			prevout: {
				scriptpubkey: '0014' + 'aa'.repeat(20),
				scriptpubkey_type: 'v0_p2wpkh',
				scriptpubkey_address: 'bc1qsender',
				value: 200_000
			},
			sequence: 0xfffffffd, // < 0xfffffffe → BIP125 opt-in
			witness: ['02abcd']
		}
	],
	vout: [
		{
			scriptpubkey: WATCHED_SCRIPT,
			scriptpubkey_type: 'v0_p2wpkh',
			scriptpubkey_address: 'bc1qreceiver',
			value: 150_000
		},
		{
			scriptpubkey: '0014' + 'cc'.repeat(20),
			scriptpubkey_type: 'v0_p2wpkh',
			scriptpubkey_address: 'bc1qchange',
			value: 48_590
		}
	],
	size: 222,
	weight: 561, // vsize = ceil(561/4) = 141; < size*4 → segwit
	fee: 1_410, // 1410 / 141 = 10 sat/vB exactly
	status: {
		confirmed: true,
		block_height: TIP_HEIGHT - 10,
		block_hash: 'd'.repeat(64),
		block_time: 1_750_000_000
	}
};

const BLOCK: EsploraBlock = {
	id: 'b'.repeat(64),
	height: 867_990,
	version: 0x20000000,
	timestamp: 1_750_000_000,
	tx_count: 3_000,
	size: 1_500_000,
	weight: 3_990_000,
	merkle_root: 'e'.repeat(64),
	previousblockhash: 'a'.repeat(64),
	nonce: 12_345,
	bits: 0x1b0404cb,
	difficulty: 9.5e13
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
}

/** Install stubbed Electrum methods onto a ChainService's pooled facade
 *  (readonly is TS-only) — mirrors the existing withElectrum pattern already used
 *  for getTxHex/getFeeHistogram below. */
function withElectrum(svc: ChainService, patch: Partial<ElectrumStub>): void {
	Object.assign(svc.electrum, patch);
}

interface EsploraStub {
	getTipHeight: ReturnType<typeof vi.fn>;
	getTipHash: ReturnType<typeof vi.fn>;
	getTx: ReturnType<typeof vi.fn>;
	getTxHex: ReturnType<typeof vi.fn>;
	getTxOutspends: ReturnType<typeof vi.fn>;
	getAddress: ReturnType<typeof vi.fn>;
	getAddressTxs: ReturnType<typeof vi.fn>;
	getBlockByHash: ReturnType<typeof vi.fn>;
	getBlockHashAtHeight: ReturnType<typeof vi.fn>;
	getBlocks: ReturnType<typeof vi.fn>;
	getFeeEstimates: ReturnType<typeof vi.fn>;
}

function makeEsploraStub(): EsploraStub {
	return {
		getTipHeight: vi.fn(async () => TIP_HEIGHT),
		getTipHash: vi.fn(async () => TIP_HASH),
		getTx: vi.fn(async () => ESPLORA_TX),
		// Present only so a regression back to the esplora raw-hex path would show
		// up as an unexpected call (getTxHex now goes through Electrum — cairn-zoz8.4).
		getTxHex: vi.fn(async () => 'esplora-should-not-be-called'),
		getTxOutspends: vi.fn(async () => [{ spent: true }, { spent: false }]),
		getAddress: vi.fn(),
		getAddressTxs: vi.fn(),
		getBlockByHash: vi.fn(async () => BLOCK),
		getBlockHashAtHeight: vi.fn(async () => BLOCK.id),
		getBlocks: vi.fn(async () => []),
		getFeeEstimates: vi.fn()
	};
}

/** A ChainService whose esplora client is the given stub (readonly is TS-only). */
function makeService(stub: EsploraStub): ChainService {
	const svc = new ChainService(CFG as unknown as ConstructorParameters<typeof ChainService>[0]);
	Object.assign(svc, { esplora: stub });
	return svc;
}

afterEach(() => {
	vi.unstubAllGlobals();
	// The tip/fee TTL caches are module-level and outlive a single service, so
	// clear them between tests to keep cases isolated (cairn-vknb.5).
	resetChainCaches();
	// Same for the raw-tx LRU (cairn perf: send-flow prev-tx fetch) — otherwise
	// a txid reused across tests would silently short-circuit on a stale entry.
	clearRawTxCache();
});

// ---- tip (electrum-backed, cairn-zoz8.5) -----------------------------------------

// getTip now derives height+hash from headersSubscribe (the same source
// getNodeInfo already used) instead of a third-party esplora HTTP API.
describe('getTip', () => {
	function withHeader(height: number, hex: string): { svc: ChainService; headersSubscribe: ReturnType<typeof vi.fn> } {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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
		// tx_count/size/weight/fee stats aren't derivable from a bare header alone
		// (cairn-zoz8.10 enriches these via Bitcoin Core RPC when configured).
		expect(blocks[0]).toMatchObject({
			txCount: 0,
			size: 0,
			weight: 0,
			medianFee: null,
			feeRange: null
		});
	});

	it('derives fromHeight from the current tip when omitted', async () => {
		const svc = makeService(makeEsploraStub());
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const headersSubscribe = vi.fn(async () => ({ height: 5, hex }));
		const getBlockHeader = vi.fn(async () => hex);
		withElectrum(svc, { headersSubscribe, getBlockHeader });

		const blocks = await svc.getRecentBlocks(2);
		expect(blocks.map((b) => b.height)).toEqual([5, 4]);
	});

	it('clamps the count near genesis instead of requesting a negative height', async () => {
		const svc = makeService(makeEsploraStub());
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS });
		const getBlockHeader = vi.fn(async () => hex);
		withElectrum(svc, { getBlockHeader });

		const blocks = await svc.getRecentBlocks(10, 1);
		expect(blocks.map((b) => b.height)).toEqual([1, 0]);
		expect(getBlockHeader).toHaveBeenCalledTimes(2);
	});
});

// ---- getTx / toTxDetail -----------------------------------------------------------

describe('getTx (toTxDetail mapping)', () => {
	it('maps a confirmed tx: confirmations from tip, scriptPubKey passthrough, fee math', async () => {
		const stub = makeEsploraStub();
		const svc = makeService(stub);

		const tx = await svc.getTx(ESPLORA_TX.txid);

		expect(stub.getTx).toHaveBeenCalledWith(ESPLORA_TX.txid);
		// tip 868000, block 867990 → 868000 - 867990 + 1 = 11
		expect(tx.confirmed).toBe(true);
		expect(tx.blockHeight).toBe(TIP_HEIGHT - 10);
		expect(tx.confirmations).toBe(11);
		expect(tx.blockHash).toBe('d'.repeat(64));
		expect(tx.blockTime).toBe(1_750_000_000);

		// vout: scriptPubKey passes through untouched, spent-ness from outspends.
		expect(tx.vout).toHaveLength(2);
		expect(tx.vout[0].scriptPubKey).toBe(WATCHED_SCRIPT);
		expect(tx.vout[0].address).toBe('bc1qreceiver');
		expect(tx.vout[0].value).toBe(150_000);
		expect(tx.vout[0].spent).toBe(true);
		expect(tx.vout[1].spent).toBe(false);

		// vin: prevout mapping.
		expect(tx.vin[0]).toMatchObject({
			txid: 'e'.repeat(64),
			vout: 1,
			address: 'bc1qsender',
			value: 200_000,
			prevScriptPubKey: '0014' + 'aa'.repeat(20),
			coinbase: false
		});

		// Derived numbers: vsize = ceil(weight/4), feeRate = fee/vsize (2dp).
		expect(tx.vsize).toBe(141);
		expect(tx.fee).toBe(1_410);
		expect(tx.feeRate).toBe(10);
		expect(tx.segwit).toBe(true); // weight 561 < size*4 = 888
		expect(tx.rbf).toBe(true); // sequence 0xfffffffd
	});

	it('reports an unconfirmed tx with 0 confirmations and null block fields', async () => {
		const stub = makeEsploraStub();
		stub.getTx.mockResolvedValue({ ...ESPLORA_TX, status: { confirmed: false } });
		const svc = makeService(stub);

		const tx = await svc.getTx(ESPLORA_TX.txid);

		expect(tx.confirmed).toBe(false);
		expect(tx.confirmations).toBe(0);
		expect(tx.blockHeight).toBeNull();
		expect(tx.blockHash).toBeNull();
		expect(tx.blockTime).toBeNull();
	});

	it('degrades output spent-ness to null when the outspends lookup fails', async () => {
		const stub = makeEsploraStub();
		stub.getTxOutspends.mockRejectedValue(new Error('outspends endpoint down'));
		const svc = makeService(stub);

		const tx = await svc.getTx(ESPLORA_TX.txid); // must not throw
		expect(tx.vout.map((v) => v.spent)).toEqual([null, null]);
		// The rest of the detail is intact.
		expect(tx.confirmations).toBe(11);
		expect(tx.vout[0].scriptPubKey).toBe(WATCHED_SCRIPT);
	});

	it('fetches tx, tip, and outspends concurrently — not outspends after the others (cairn-daej)', async () => {
		const stub = makeEsploraStub();
		// Gate tx/tipHeight behind a manual latch. If outspends were still a
		// sequential await after their Promise.all, it would NOT be called until
		// after this latch releases; a concurrent Promise.all invokes all three
		// synchronously, so getTxOutspends is called while tx/tip are still pending.
		let releaseTx!: () => void;
		const txGate = new Promise<void>((r) => (releaseTx = r));
		stub.getTx.mockImplementation(async () => {
			await txGate;
			return ESPLORA_TX;
		});
		const svc = makeService(stub);

		const pending = svc.getTx(ESPLORA_TX.txid);
		// Let microtasks drain so the Promise.all has kicked off every fetch.
		await Promise.resolve();
		expect(stub.getTxOutspends).toHaveBeenCalledTimes(1); // already in flight
		expect(stub.getTipHeight).toHaveBeenCalledTimes(1);

		releaseTx();
		const tx = await pending;
		expect(tx.vout[0].spent).toBe(true);
		expect(tx.vout[1].spent).toBe(false);
	});
});

// ---- getTxHex (raw hex via Electrum) ----------------------------------------------

// getTxHex no longer touches esplora (cairn-zoz8.4): it fetches raw hex from the
// operator's own Electrum server via blockchain.transaction.get(txid, verbose=false),
// which returns the raw serialization for both confirmed and mempool txids on a
// full-indexing backend (ElectrumX/Fulcrum/electrs).
describe('getTxHex (Electrum raw-hex path)', () => {
	// Plausible raw serializations; getTxHex passes them through untouched (no decode).
	const CONFIRMED_TX_HEX = '02000000000101' + 'ab'.repeat(100) + '00000000';
	const MEMPOOL_TX_HEX = '02000000000101' + 'cd'.repeat(80) + '00000000';

	/** Install a getTransaction stub on the pooled Electrum client (readonly is TS-only). */
	function withElectrum(svc: ChainService, getTransaction: ReturnType<typeof vi.fn>): void {
		Object.assign(svc.electrum, { getTransaction });
	}

	it('returns a confirmed tx hex via getTransaction(txid, false), without touching esplora', async () => {
		const stub = makeEsploraStub();
		const svc = makeService(stub);
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'f'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);
		// verbose=false so the server returns raw hex rather than a decoded object.
		expect(getTransaction).toHaveBeenCalledWith(txid, false);
		// The esplora client must not be consulted for raw hex any more.
		expect(stub.getTxHex).not.toHaveBeenCalled();
	});

	it('returns an unconfirmed (mempool) tx hex the same way', async () => {
		const svc = makeService(makeEsploraStub());
		const getTransaction = vi.fn(async () => MEMPOOL_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'a'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(MEMPOOL_TX_HEX);
		expect(getTransaction).toHaveBeenCalledWith(txid, false);
	});

	it('throws when the Electrum server has no such tx (contract parity with the old esplora path)', async () => {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'c'.repeat(64);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);
		await expect(svc.getTxHex(txid)).resolves.toBe(CONFIRMED_TX_HEX);

		// The second "build" pays zero additional Electrum round-trips.
		expect(getTransaction).toHaveBeenCalledTimes(1);
	});

	it('keys the cache by txid, so a different txid always misses', async () => {
		const svc = makeService(makeEsploraStub());
		const getTransaction = vi.fn(async (txid: string) =>
			txid === 'c'.repeat(64) ? CONFIRMED_TX_HEX : MEMPOOL_TX_HEX
		);
		withElectrum(svc, getTransaction);

		await svc.getTxHex('c'.repeat(64));
		await svc.getTxHex('d'.repeat(64));

		expect(getTransaction).toHaveBeenCalledTimes(2);
	});

	it('clearRawTxCache forces the next lookup to re-hit electrum', async () => {
		const svc = makeService(makeEsploraStub());
		const getTransaction = vi.fn(async () => CONFIRMED_TX_HEX);
		withElectrum(svc, getTransaction);

		const txid = 'c'.repeat(64);
		await svc.getTxHex(txid);
		clearRawTxCache();
		await svc.getTxHex(txid);

		expect(getTransaction).toHaveBeenCalledTimes(2);
	});

	it('does not cache a failed fetch', async () => {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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

// getFeeEstimates now reads blockchain.estimatefee at 4 targets from the
// operator's own Electrum server instead of a third-party esplora HTTP API.
describe('getFeeEstimates', () => {
	function withFees(byTarget: Record<number, number>): {
		svc: ChainService;
		estimateFee: ReturnType<typeof vi.fn>;
	} {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
		const headersSubscribe = vi.fn(async () => {
			throw new Error('electrum down');
		});
		withElectrum(svc, { headersSubscribe });

		await expect(svc.getDifficultyHistory(3)).resolves.toBeNull();
	});
});

describe('getHashrate', () => {
	it('derives hashrate from the tip header difficulty (difficulty * 2^32 / 600)', async () => {
		const svc = makeService(makeEsploraStub());
		const hex = buildHeader({ time: 1_700_000_000, bits: GENESIS_BITS }); // difficulty 1
		const headersSubscribe = vi.fn(async () => ({ height: TIP_HEIGHT, hex }));
		withElectrum(svc, { headersSubscribe });

		await expect(svc.getHashrate()).resolves.toBeCloseTo((1 * 2 ** 32) / 600, 6);
	});

	it('returns null when the tip header is unavailable', async () => {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
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
			// Esplora's lifetime funded/spent sums have no Electrum equivalent
			// without walking every historical tx — null signals "unknown" rather
			// than a misleading 0 (the Explorer address page hides these when null).
			totalReceived: null,
			totalSent: null,
			used: true
		});
	});

	it('reports an unused address (empty history) with used:false', async () => {
		const svc = makeService(makeEsploraStub());
		withElectrum(svc, {
			getBalance: vi.fn(async () => ({ confirmed: 0, unconfirmed: 0 })),
			getHistory: vi.fn(async () => [])
		});

		await expect(svc.getAddressInfo(ADDRESS)).resolves.toMatchObject({ txCount: 0, used: false });
	});

	it('surfaces a friendly error when the server rejects an over-large history', async () => {
		const svc = makeService(makeEsploraStub());
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
	// (change 48,590 elsewhere) → fee 1,410, delta +150,000 (mirrors the old
	// esplora-backed fixture's numbers). TX2: mempool, spends TX1's output onward
	// → fee 1,000, delta -150,000.
	const TX1 = 'a'.repeat(64);
	const TX2 = 'b'.repeat(64);
	const PREV = 'c'.repeat(64);

	function withHistoryAndTxs(): {
		svc: ChainService;
		getHistory: ReturnType<typeof vi.fn>;
		getTransaction: ReturnType<typeof vi.fn>;
	} {
		const svc = makeService(makeEsploraStub());
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
		const svc = makeService(makeEsploraStub());
		withElectrum(svc, {
			getHistory: vi.fn(async () => {
				throw new Error('server.Error: history too large');
			})
		});

		await expect(svc.getAddressTxs(ADDRESS)).rejects.toThrow(/too much history/i);
	});
});

// ---- block lookup -----------------------------------------------------------------

describe('block lookup', () => {
	it('getBlock resolves a height to a hash and merges /v1 extras (rounded fees, miner)', async () => {
		const stub = makeEsploraStub();
		stub.getBlocks.mockResolvedValue([
			{
				...BLOCK,
				extras: {
					medianFee: 12.345,
					feeRange: [1, 2, 100.129],
					totalFees: 12_345_678,
					reward: 325_000_000,
					pool: { name: 'Foundry USA' }
				}
			}
		]);
		const svc = makeService(stub);

		const block = await svc.getBlock(BLOCK.height);

		expect(stub.getBlockHashAtHeight).toHaveBeenCalledWith(BLOCK.height);
		expect(stub.getBlockByHash).toHaveBeenCalledWith(BLOCK.id);
		expect(block.hash).toBe(BLOCK.id);
		expect(block.height).toBe(BLOCK.height);
		expect(block.prevHash).toBe('a'.repeat(64));
		expect(block.merkleRoot).toBe(BLOCK.merkle_root);
		expect(block.bits).toBe('1b0404cb'); // hex rendering of the compact target
		expect(block.txCount).toBe(3_000);
		// extras: fees rounded to 2dp, feeRange collapsed to [min, max], miner name.
		expect(block.medianFee).toBe(12.35);
		expect(block.feeRange).toEqual([1, 100.13]);
		expect(block.miner).toBe('Foundry USA');
		expect(block.totalFees).toBe(12_345_678);
		expect(block.reward).toBe(325_000_000);
	});

	it('getBlock still succeeds without extras when the summaries endpoint fails', async () => {
		const stub = makeEsploraStub();
		stub.getBlocks.mockRejectedValue(new Error('v1/blocks down'));
		const svc = makeService(stub);

		const block = await svc.getBlock(BLOCK.id); // by hash this time

		expect(stub.getBlockHashAtHeight).not.toHaveBeenCalled();
		expect(block.hash).toBe(BLOCK.id);
		expect(block.medianFee).toBeNull();
		expect(block.feeRange).toBeNull();
		expect(block.miner).toBeUndefined();
		expect(block.totalFees).toBeNull();
		expect(block.reward).toBeNull();
	});
});

// ---- fee histogram (electrum-backed, cairn-zoz8.2) ----------------------------------

// getFeeHistogram now reads mempool.get_fee_histogram from the operator's own
// Electrum connection instead of the esplora /mempool response. Stub the pooled
// Electrum facade (readonly is TS-only) so the facade's passthrough + empty→null
// collapse is exercised without a socket.
describe('getFeeHistogram (electrum-backed)', () => {
	function withElectrumHistogram(result: unknown): {
		svc: ChainService;
		getFeeHistogram: ReturnType<typeof vi.fn>;
		getMempool: ReturnType<typeof vi.fn>;
	} {
		const stub = makeEsploraStub();
		const getMempool = vi.fn();
		Object.assign(stub, { getMempool });
		const svc = makeService(stub);
		const getFeeHistogram = vi.fn(async () => result);
		Object.assign(svc, { electrum: { getFeeHistogram } });
		return { svc, getFeeHistogram, getMempool };
	}

	it('passes the mempool.get_fee_histogram pairs through, highest fee first', async () => {
		const histogram: [number, number][] = [
			[120, 15_000],
			[50, 32_000],
			[10, 210_000],
			[1, 90_000]
		];
		const { svc, getFeeHistogram, getMempool } = withElectrumHistogram(histogram);

		await expect(svc.getFeeHistogram()).resolves.toEqual(histogram);
		expect(getFeeHistogram).toHaveBeenCalledTimes(1);
		// The esplora /mempool response is no longer the source of this chart.
		expect(getMempool).not.toHaveBeenCalled();
	});

	it('collapses an empty mempool histogram to null', async () => {
		const { svc } = withElectrumHistogram([]);
		await expect(svc.getFeeHistogram()).resolves.toBeNull();
	});
});

// ---- Bitcoin Core RPC path (Esplora removal Wave 2) --------------------------------
//
// When a Core RPC backend is configured, getTx/getBlock/getBlockTxs/getMempoolSummary/
// getCpfpInfo source from the operator's own node instead of Esplora. These tests pin
// the Core→app mapping — especially the BTC→sats unit conversions (Core reports values
// as BTC floats), confirmations→height, and per-output gettxout spent-ness.

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
 *  returns it — values in BTC, prevout present on the input. Mirrors ESPLORA_TX's
 *  numbers so the mapped result is directly comparable. */
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

/** A ChainService wired to a stubbed Core client, no Esplora, with a tip header
 *  stub so getTip() (used for confirmations→height) resolves. */
function makeCoreService(core: CoreStub): ChainService {
	const svc = new ChainService(CFG as unknown as ConstructorParameters<typeof ChainService>[0]);
	const tipHex = buildHeader({ time: 1_750_000_000, bits: GENESIS_BITS });
	Object.assign(svc, { core, esplora: null });
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

	it('throws a not-found error for an unknown txid (code -5) so search can fall through', async () => {
		const core = makeCoreStub();
		core.call.mockRejectedValue(new CoreRpcError(-5, 'getrawtransaction', 'No such tx'));
		const svc = makeCoreService(core);

		await expect(svc.getTx(CORE_TX.txid)).rejects.toThrow(/not found/i);
	});

	// A Core node without -txindex reports the SAME code -5 for "genuinely no such
	// tx" and "confirmed tx exists but isn't in the mempool/wallet and Core has no
	// index to find it". An explicitly-configured Esplora backend can still serve
	// the second case (electrs/mempool index everything) — that's the whole reason
	// the fallback exists — so a -5/-8 must try it before declaring not-found.
	it('falls back to esplora on a Core -5/-8 (e.g. no -txindex) before declaring not-found', async () => {
		const core = makeCoreStub();
		core.call.mockRejectedValue(new CoreRpcError(-5, 'getrawtransaction', 'No such tx. Use -txindex.'));
		const esplora = makeEsploraStub();
		const svc = makeCoreService(core);
		Object.assign(svc, { esplora });

		const tx = await svc.getTx(ESPLORA_TX.txid);

		expect(esplora.getTx).toHaveBeenCalledWith(ESPLORA_TX.txid);
		expect(tx.txid).toBe(ESPLORA_TX.txid);
	});

	it('still reports not-found when esplora ALSO misses after a Core -5/-8', async () => {
		const core = makeCoreStub();
		core.call.mockRejectedValue(new CoreRpcError(-5, 'getrawtransaction', 'No such tx'));
		const esplora = makeEsploraStub();
		esplora.getTx.mockRejectedValue(new Error('esplora: also not found'));
		const svc = makeCoreService(core);
		Object.assign(svc, { esplora });

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

	it('returns null when the mempool histogram is empty and no Esplora fallback exists', async () => {
		const svc = makeCoreService(makeCoreStub());
		Object.assign(svc.electrum, { getFeeHistogram: vi.fn(async () => []) });
		await expect(svc.getMempoolBlocks()).resolves.toBeNull();
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
});
