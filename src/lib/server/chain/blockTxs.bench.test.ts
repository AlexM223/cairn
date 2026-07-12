// Regression benchmark for cairn-jii4: the explorer block-detail page
// (src/routes/(app)/explorer/block/[id]/+page.server.ts) paginates its tx list
// at 25/page via ChainService.getBlockTxs(hash, page). This was previously
// UNVERIFIED: does a single page view issue one getrawtransaction per-tx RPC
// call for only the 25 txs on the requested page, or does it somehow scale
// with the block's total tx count (up to ~4,000 in a max-weight block)?
//
// Traced (chain/index.ts):
//   - getBlockTxsViaCore() calls core.getBlock(hash, 1) ONCE — this returns the
//     full txid array (`tx: string[]`) and `nTx`, but NOT per-tx data, so its
//     cost doesn't include fetching every transaction's contents.
//   - It then slices the txid array to exactly BLOCK_TXS_PAGE_SIZE (25) entries
//     for the requested page BEFORE issuing any getrawtransaction calls.
//   - Only those 25 (sliced) txids get a getrawtransaction RPC call each.
// So the Core RPC path is bounded to ~page-size per-tx calls, independent of
// the block's total tx count. This test pins that down with a mocked 4,000-tx
// block (a realistic max-weight block) so a future change that removes the
// slice-before-fetch step (e.g. mapping over the full txid array) fails loudly.

import { describe, it, expect, vi } from 'vitest';

// Keep ChainService construction side-effect free: no real Electrum socket.
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

const BLOCK_HASH = 'b'.repeat(64);
const BLOCK_TXS_PAGE_SIZE = 25;
const MAX_BLOCK_TX_COUNT = 4_000; // realistic max-weight-block tx count

/** A confirmed 1-in/2-out segwit tx shaped as Core's getrawtransaction verbosity=2
 *  returns it. Content doesn't matter for this benchmark — only call counts/timing. */
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
			sequence: 0xfffffffd,
			prevout: {
				value: 0.002,
				scriptPubKey: { hex: '0014' + 'aa'.repeat(20), address: 'bc1qsender' }
			}
		}
	],
	vout: [
		{ value: 0.0015, n: 0, scriptPubKey: { hex: '0014' + 'bb'.repeat(20), address: 'bc1qreceiver' } },
		{ value: 0.0004859, n: 1, scriptPubKey: { hex: '0014' + 'cc'.repeat(20), address: 'bc1qchange' } }
	],
	confirmations: 11,
	blockhash: 'd'.repeat(64),
	blocktime: 1_750_000_000
};

function makeCoreStub(txCount: number) {
	const txids = Array.from({ length: txCount }, (_, i) => i.toString(16).padStart(64, '0'));
	// Simulate a small, realistic per-RPC network round-trip so wall time is a
	// meaningful (non-zero) measurement rather than pure in-process noise.
	const RPC_LATENCY_MS = 2;
	const delay = <T>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), RPC_LATENCY_MS));

	return {
		call: vi.fn(async (method: string) => {
			if (method === 'getrawtransaction') return delay(CORE_TX);
			throw new Error(`unstubbed core.call ${method}`);
		}),
		getBlockHash: vi.fn(async () => BLOCK_HASH),
		getBlock: vi.fn(async () =>
			delay({
				hash: BLOCK_HASH,
				height: 900_000,
				time: 1_750_000_000,
				nonce: 1,
				bits: '1b0404cb',
				difficulty: 1,
				nTx: txCount,
				previousblockhash: 'a'.repeat(64),
				size: 1_500_000,
				weight: 3_990_000,
				confirmations: 11,
				tx: txids
			})
		),
		getBlockStats: vi.fn(),
		getRawTransaction: vi.fn(async () => CORE_TX),
		getTxOut: vi.fn(async () => null),
		getMempoolInfo: vi.fn(),
		getMempoolEntry: vi.fn(),
		close: vi.fn()
	};
}

function makeCoreService(core: ReturnType<typeof makeCoreStub>): ChainService {
	const svc = new ChainService(CFG as unknown as ConstructorParameters<typeof ChainService>[0]);
	Object.assign(svc, { core, esplora: null });
	return svc;
}

describe('getBlockTxs Core RPC call count is bounded to page size (cairn-jii4)', () => {
	it('a 4,000-tx block: one page view issues ~25 getrawtransaction calls, not 4,000', async () => {
		const core = makeCoreStub(MAX_BLOCK_TX_COUNT);
		const svc = makeCoreService(core);

		const start = performance.now();
		const res = await svc.getBlockTxs(BLOCK_HASH, 0);
		const elapsedMs = performance.now() - start;

		// Correctness: page 0 of a 4,000-tx block still returns 25 txs and the
		// true total (not the page size).
		expect(res.txs).toHaveLength(BLOCK_TXS_PAGE_SIZE);
		expect(res.total).toBe(MAX_BLOCK_TX_COUNT);

		// The bound: exactly ONE getblock call regardless of tx count (it returns
		// the txid array + nTx, not per-tx data)...
		expect(core.getBlock).toHaveBeenCalledTimes(1);
		// ...and exactly PAGE_SIZE getrawtransaction calls — NOT one per tx in the
		// block. If a regression maps over the full txid array before slicing,
		// this would jump to 4,000 and fail here.
		const rawTxCalls = core.call.mock.calls.filter(([method]) => method === 'getrawtransaction');
		expect(rawTxCalls).toHaveLength(BLOCK_TXS_PAGE_SIZE);

		// Wall time: bounded to ~page-size work (a couple of RPC round-trips),
		// not proportional to the block's 4,000 txs. Generous ceiling so this
		// doesn't flake on a loaded CI box, but a scan-the-whole-block regression
		// (4,000 sequential/serialized round-trips) would blow well past it.
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it('a later page (page 3) still slices only its 25 txids out of 4,000', async () => {
		const core = makeCoreStub(MAX_BLOCK_TX_COUNT);
		const svc = makeCoreService(core);

		const res = await svc.getBlockTxs(BLOCK_HASH, 3); // txids[75..99]

		expect(res.txs).toHaveLength(BLOCK_TXS_PAGE_SIZE);
		const rawTxCalls = core.call.mock.calls.filter(([method]) => method === 'getrawtransaction');
		expect(rawTxCalls).toHaveLength(BLOCK_TXS_PAGE_SIZE);
	});

	it('the last (partial) page of a 4,000-tx block bounds calls to the remainder, not 4,000', async () => {
		const core = makeCoreStub(MAX_BLOCK_TX_COUNT);
		const svc = makeCoreService(core);
		const lastPage = Math.floor((MAX_BLOCK_TX_COUNT - 1) / BLOCK_TXS_PAGE_SIZE); // 159

		const res = await svc.getBlockTxs(BLOCK_HASH, lastPage);

		expect(res.txs.length).toBeLessThanOrEqual(BLOCK_TXS_PAGE_SIZE);
		expect(res.txs.length).toBeGreaterThan(0);
		const rawTxCalls = core.call.mock.calls.filter(([method]) => method === 'getrawtransaction');
		expect(rawTxCalls).toHaveLength(res.txs.length);
	});
});
