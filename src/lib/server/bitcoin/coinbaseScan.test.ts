// Coinbase-maturity fail-closed behavior on chain-RPC failure (cairn-9lnj,
// pinning the cairn-7fmd fix in commit c17328b).
//
// isCoinbaseTx used to swallow a transient chain failure and return FALSE —
// an immature mining reward then looked ordinary and spendable, bypassing the
// 100-block maturity guard. The fix propagates 'unknown', and the shared spend
// rules (selectSpendCandidates in psbt.ts) treat an unverifiable coin inside
// the maturity window conservatively: dropped from automatic selection,
// refused with a clear error under coin control. These tests mock the chain
// seam (getChain from ../chain) and pin the whole path: annotation verdict →
// selection outcome.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTxMock = vi.fn<(txid: string) => Promise<{ vin: Record<string, unknown>[] }>>();
vi.mock('../chain', () => ({
	getChain: () => ({ getTx: getTxMock })
}));

import { annotateCoinbase } from './coinbaseScan';
import { selectSpendCandidates, PsbtError, type SpendableUtxo } from './psbt';

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** A confirmed UTXO with a caller-chosen txid; coinbase status undetermined. */
function utxo(txid: string, height = 900_000): SpendableUtxo {
	return { txid, vout: 0, value: 60_000, height, address: ADDRESS, chain: 0, index: 0 };
}

// The module-level coinbase cache in coinbaseScan.ts is process-wide and never
// expires (coinbase-ness is immutable), so every test uses its OWN txids —
// cache reuse across tests is exercised deliberately, never accidentally.
let nextTxid = 0;
function freshTxid(): string {
	return (nextTxid++).toString(16).padStart(2, '0').repeat(32).slice(0, 64);
}

const NORMAL_TX = { vin: [{ prevout: 'aa'.repeat(32) }] };
const COINBASE_TX = { vin: [{ coinbase: '044c86041b020602' }] };

beforeEach(() => {
	getTxMock.mockReset();
});

describe('annotateCoinbase under chain-RPC failure (cairn-9lnj / cairn-7fmd)', () => {
	it("marks the UTXO 'unknown' — NOT a silent 'not a coinbase' — when the funding-tx fetch fails", async () => {
		getTxMock.mockRejectedValue(new Error('electrum: connection reset'));
		const u = utxo(freshTxid());
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');
		expect(u.coinbase).not.toBe(false); // the pre-fix bug: failure → false → spendable
	});

	it('a fetch failure never fails the whole scan, and other coins still resolve', async () => {
		const bad = utxo(freshTxid());
		const good = utxo(freshTxid());
		getTxMock.mockImplementation(async (txid) => {
			if (txid === bad.txid) throw new Error('timeout');
			return NORMAL_TX;
		});
		await expect(annotateCoinbase([bad, good])).resolves.toBeDefined();
		expect(bad.coinbase).toBe('unknown');
		expect(good.coinbase).toBe(false);
	});

	it("never caches 'unknown': a later scan re-fetches and can resolve the truth", async () => {
		const u = utxo(freshTxid());
		getTxMock.mockRejectedValueOnce(new Error('hiccup'));
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');

		// The chain recovers — the SAME txid must be fetched again, not served
		// from a poisoned cache, and now resolves definitively.
		getTxMock.mockResolvedValueOnce(COINBASE_TX);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(true);
		expect(getTxMock).toHaveBeenCalledTimes(2);
	});

	it('caches definitive results: the second scan of a known txid never re-fetches', async () => {
		const u = utxo(freshTxid());
		getTxMock.mockResolvedValue(NORMAL_TX);
		await annotateCoinbase([u]);
		await annotateCoinbase([utxo(u.txid)]);
		expect(getTxMock).toHaveBeenCalledTimes(1);
	});
});

describe('unknown-coinbase coins are unspendable inside the maturity window (cairn-9lnj)', () => {
	// height 900_000 at tip 900_050 = 51 confirmations — inside the 100-block
	// maturity window, so an unverifiable coin COULD be an immature reward.
	const TIP = 900_050;

	async function unknownUtxo(height = 900_000): Promise<SpendableUtxo> {
		getTxMock.mockRejectedValue(new Error('chain down'));
		const u = utxo(freshTxid(), height);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown'); // fixture sanity
		return u;
	}

	it('automatic selection drops it — the spend fails with no_utxos instead of building an invalid tx', async () => {
		const u = await unknownUtxo();
		expect(() => selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet')).toThrow(PsbtError);
		try {
			selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
			expect.unreachable();
		} catch (e) {
			expect((e as PsbtError).code).toBe('no_utxos');
			expect((e as PsbtError).message).toMatch(/no mature coins/);
		}
	});

	it('automatic selection with other coins available excludes exactly the unverifiable one', async () => {
		const suspect = await unknownUtxo();
		const clean = utxo(freshTxid(), 800_000);
		getTxMock.mockResolvedValue(NORMAL_TX);
		await annotateCoinbase([clean]);
		const { spendable } = selectSpendCandidates({ utxos: [suspect, clean], tipHeight: TIP }, 'wallet');
		expect(spendable.map((s) => s.txid)).toEqual([clean.txid]);
	});

	it('coin control refuses it with a clear immature_coinbase error (fail closed, explained)', async () => {
		const u = await unknownUtxo();
		try {
			selectSpendCandidates(
				{ utxos: [u], onlyUtxos: [{ txid: u.txid, vout: 0 }], tipHeight: TIP },
				'wallet'
			);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(PsbtError);
			expect((e as PsbtError).code).toBe('immature_coinbase');
			expect((e as PsbtError).message).toMatch(/Couldn't verify/);
		}
	});

	it('an unknown-status coin PAST the maturity window stays spendable (safe regardless)', async () => {
		// 100+ confirmations: even if it were a coinbase it would be mature, so a
		// chain hiccup must not freeze old coins.
		const u = await unknownUtxo(800_000);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});
});

describe('happy path: RPC works (cairn-9lnj)', () => {
	const TIP = 900_050;

	it('a non-coinbase coin resolves false and passes selection untouched', async () => {
		getTxMock.mockResolvedValue(NORMAL_TX);
		const u = utxo(freshTxid());
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(false);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});

	it('an immature coinbase resolves true and is flagged: dropped from auto, rejected under coin control', async () => {
		getTxMock.mockResolvedValue(COINBASE_TX);
		const u = utxo(freshTxid(), 900_000); // 51 confs at TIP — immature
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(true);

		expect(() => selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet')).toThrow(
			/no mature coins/
		);
		try {
			selectSpendCandidates(
				{ utxos: [u], onlyUtxos: [{ txid: u.txid, vout: 0 }], tipHeight: TIP },
				'wallet'
			);
			expect.unreachable();
		} catch (e) {
			expect((e as PsbtError).code).toBe('immature_coinbase');
			expect((e as PsbtError).message).toMatch(/immature mining reward/);
		}
	});

	it('a MATURE coinbase (100+ confirmations) resolves true and stays spendable', async () => {
		getTxMock.mockResolvedValue(COINBASE_TX);
		const u = utxo(freshTxid(), 800_000);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(true);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});
});
