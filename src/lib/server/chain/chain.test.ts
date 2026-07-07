// Regression tests for cairn-a0nb: the ChainService facade (chain/index.ts) had
// zero test coverage. Pins down the facade's mapping/normalization logic against
// a stubbed Esplora backend: getTx (toTxDetail — confirmations from the tip,
// vout scriptPubKey passthrough, fee-rate/segwit/RBF derivation), getTip,
// fee-estimate normalization (both mempool.space /v1 and plain-esplora shapes),
// address lookup, block lookup, and the outspends degrade-to-null error path.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EsploraAddress, EsploraBlock, EsploraTx } from './esplora';

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

import { ChainService } from './index';
import { EsploraApi } from './esplora';

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
});

// ---- tip ------------------------------------------------------------------------

describe('getTip', () => {
	it('combines tip height and hash from the backend', async () => {
		const svc = makeService(makeEsploraStub());
		await expect(svc.getTip()).resolves.toEqual({ height: TIP_HEIGHT, hash: TIP_HASH });
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
});

// ---- fee estimates -----------------------------------------------------------------

// The normalization itself lives in EsploraApi.getFeeEstimates (the facade
// delegates), so these run the REAL EsploraApi against a stubbed global fetch —
// one test per backend shape.
describe('fee estimate normalization', () => {
	function stubFetchRoutes(routes: Record<string, { status: number; body: unknown }>): void {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: unknown) => {
				const u = String(url);
				const key = Object.keys(routes).find((k) => u.includes(k));
				if (!key) throw new Error(`unexpected fetch: ${u}`);
				const r = routes[key];
				return {
					status: r.status,
					ok: r.status >= 200 && r.status < 300,
					text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
				};
			})
		);
	}

	it('maps a mempool.space /v1/fees/recommended payload to the normalized shape', async () => {
		stubFetchRoutes({
			'/v1/fees/recommended': {
				status: 200,
				body: { fastestFee: 30, halfHourFee: 20, hourFee: 10, economyFee: 5 }
			}
		});
		const api = new EsploraApi('http://esplora.test');
		await expect(api.getFeeEstimates()).resolves.toEqual({
			fastest: 30,
			halfHour: 20,
			hour: 10,
			economy: 5
		});
	});

	it('normalizes a plain-esplora /fee-estimates map: targets, rounding, and missing-target fallback', async () => {
		stubFetchRoutes({
			// 404 on /v1 → the backend is plain esplora; probeV1 latches false.
			'/v1/fees/recommended': { status: 404, body: 'not found' },
			// Target "1" is deliberately absent → fastest falls back to the hour rate.
			'/fee-estimates': { status: 200, body: { '3': 10.126, '6': 5, '144': 1.2 } }
		});
		const api = new EsploraApi('http://esplora.test');
		await expect(api.getFeeEstimates()).resolves.toEqual({
			fastest: 5, // missing 1-block target → hour fallback
			halfHour: 10.13, // rounded to 2dp
			hour: 5,
			economy: 1.2
		});
	});
});

// ---- address lookup -----------------------------------------------------------------

describe('address lookup', () => {
	it('getAddressInfo derives balances, counts, and the script type', async () => {
		const address = 'bc1q' + 'a'.repeat(38); // 42 chars → p2wpkh
		const stub = makeEsploraStub();
		stub.getAddress.mockResolvedValue({
			address,
			chain_stats: {
				funded_txo_count: 3,
				funded_txo_sum: 500_000,
				spent_txo_count: 1,
				spent_txo_sum: 100_000,
				tx_count: 5
			},
			mempool_stats: {
				funded_txo_count: 1,
				funded_txo_sum: 25_000,
				spent_txo_count: 0,
				spent_txo_sum: 0,
				tx_count: 1
			}
		} satisfies EsploraAddress);
		const svc = makeService(stub);

		await expect(svc.getAddressInfo(address)).resolves.toEqual({
			address,
			scriptType: 'p2wpkh',
			confirmedBalance: 400_000,
			unconfirmedBalance: 25_000,
			txCount: 6,
			totalReceived: 500_000,
			totalSent: 100_000,
			used: true
		});
	});

	it('getAddressTxs computes the per-address net delta from vouts and prevouts', async () => {
		const stub = makeEsploraStub();
		stub.getAddressTxs.mockResolvedValue([ESPLORA_TX]);
		const svc = makeService(stub);

		// bc1qreceiver only receives vout[0] → +150000.
		const received = await svc.getAddressTxs('bc1qreceiver');
		expect(received).toEqual([
			{
				txid: ESPLORA_TX.txid,
				height: TIP_HEIGHT - 10,
				time: 1_750_000_000,
				fee: 1_410,
				delta: 150_000
			}
		]);

		// bc1qsender funds the 200000 input and receives nothing → -200000.
		const sent = await svc.getAddressTxs('bc1qsender');
		expect(sent[0].delta).toBe(-200_000);
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
