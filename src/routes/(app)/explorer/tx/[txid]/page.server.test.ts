import { describe, it, expect, beforeEach, vi } from 'vitest';

// The explorer tx detail page's hybrid cache (single-sig-full-wallet SWR). These
// tests pin the three behaviors that matter for "the app hangs on a slow node":
//   • cache HIT renders + decides the redirect from the persisted row WITHOUT
//     awaiting a live getTx (only a fire-and-forget refresh is kicked);
//   • cache MISS fetches live and persists the row;
//   • a MISS whose fetch never resolves renders the "looking this up" shell
//     within the timeout budget instead of hanging the request.
// ChainService is fully stubbed (no Electrum, no network).

const h = vi.hoisted(() => {
	const chain = {
		getTx: vi.fn(),
		getTxRbfInfo: vi.fn(async () => null),
		// Streamed supplementary lookups — never awaited by load(); stub as harmless.
		getFeeEstimates: vi.fn(async () => null),
		getCpfpInfo: vi.fn(async () => null),
		getTxHex: vi.fn(async () => null),
		// Block context is streamed alongside the other details (never awaited by load).
		getTxBlockContext: vi.fn(async () => ({
			richness: 'basic',
			confirmed: true,
			height: 800_000,
			confirmations: 3,
			tipHeight: 800_002,
			position: 7,
			positionTotal: 16,
			positionEstimated: true,
			neighbors: [],
			vsize: 140,
			fee: null,
			feeRate: null,
			coreConfigured: false
		})),
		coreConfigured: false
	};
	return { chain };
});

vi.mock('$lib/server/chain', () => ({ getChain: () => h.chain }));

import { db } from '$lib/server/db';
import { readTxSnapshot, writeTxSnapshot, __resetTxSnapshotForTests } from '$lib/server/txSnapshot';
import { load } from './+page.server';
import type { TxDetail } from '$lib/types';

const TXID = 'a'.repeat(64);

function makeTx(txid: string, over: Partial<TxDetail> = {}): TxDetail {
	return {
		txid,
		confirmed: true,
		blockHeight: 800_000,
		blockHash: 'b'.repeat(64),
		blockTime: 1_700_000_000,
		confirmations: 3,
		size: 200,
		vsize: 140,
		weight: 560,
		fee: 500,
		feeRate: 3.57,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
		vin: [{ txid: 'c'.repeat(64), vout: 0, address: 'bc1qsender', value: 10_000, prevScriptPubKey: null, coinbase: false, scriptSig: null, witness: null }],
		vout: [{ address: 'bc1qrecipient', value: 9_500, scriptType: 'v0_p2wpkh', scriptPubKey: '00', spent: false }],
		...over
	} as TxDetail;
}

function loadEvent(txid: string, search = '') {
	return {
		params: { txid },
		url: new URL(`http://localhost/explorer/tx/${txid}${search}`),
		depends: vi.fn()
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	db.exec('DELETE FROM tx_snapshots');
	__resetTxSnapshotForTests();
	vi.clearAllMocks();
	h.chain.getTx.mockReset();
	h.chain.getTxRbfInfo.mockReset().mockResolvedValue(null);
});

describe('explorer tx load — cache hit', () => {
	it('renders from the cached row without a live getTx blocking the load', async () => {
		writeTxSnapshot(TXID, makeTx(TXID));
		// A never-resolving getTx proves the cache hit does NOT await the live fetch.
		h.chain.getTx.mockReturnValue(new Promise<TxDetail>(() => {}));

		const data = (await load(loadEvent(TXID))) as {
			loading: boolean;
			notFound: boolean;
			tx: TxDetail | null;
		};

		expect(data.loading).toBe(false);
		expect(data.notFound).toBe(false);
		expect(data.tx?.txid).toBe(TXID);
		// A cache hit renders the found tx — it never 302-redirects (only a
		// not-found miss can), so there was no live-data wait to make that call.
	});
});

describe('explorer tx load — cache miss', () => {
	it('fetches live and persists the row', async () => {
		expect(readTxSnapshot(TXID)).toBeNull();
		h.chain.getTx.mockResolvedValue(makeTx(TXID));

		const data = (await load(loadEvent(TXID))) as { loading: boolean; tx: TxDetail | null };

		expect(h.chain.getTx).toHaveBeenCalledWith(TXID);
		expect(data.loading).toBe(false);
		expect(data.tx?.txid).toBe(TXID);
		// Persisted for the next visit.
		expect(readTxSnapshot(TXID)?.tx.txid).toBe(TXID);
	});

	it('streams the block context alongside the other tx details', async () => {
		h.chain.getTx.mockResolvedValue(makeTx(TXID));

		const data = (await load(loadEvent(TXID))) as {
			details: Promise<{ blockContext: { richness: string; position: number | null } }> | null;
		};

		// details is streamed (a promise), never awaited by load itself.
		expect(data.details).not.toBeNull();
		const details = await data.details!;
		expect(h.chain.getTxBlockContext).toHaveBeenCalledWith(TXID);
		expect(details.blockContext.richness).toBe('basic');
		expect(details.blockContext.position).toBe(7);
	});

	it('renders the loading shell (not a hang) when the fetch never resolves', async () => {
		h.chain.getTx.mockReturnValue(new Promise<TxDetail>(() => {}));

		const start = Date.now();
		const data = (await load(loadEvent(TXID))) as { loading: boolean; tx: TxDetail | null };
		const elapsed = Date.now() - start;

		expect(data.loading).toBe(true);
		expect(data.tx).toBeNull();
		// Returned on the timeout budget (4s), not blocked on the never-resolving
		// fetch — generous ceiling to keep the test non-flaky.
		expect(elapsed).toBeLessThan(6_000);
	}, 10_000);
});
