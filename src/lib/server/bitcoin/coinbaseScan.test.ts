// Coinbase-maturity fail-closed behavior on chain-RPC failure (cairn-9lnj,
// pinning the cairn-7fmd fix in commit c17328b), PLUS the Electrum-only
// fund-freeze fix (QA finding F2, P0): isCoinbaseTx now derives coinbase-ness
// from the funding tx's RAW HEX (getTxHex — served by a plain Electrum
// connection via blockchain.transaction.get) instead of a decoded/verbose tx
// lookup (getTx, which requires Core RPC and
// unconditionally throws without one). The old getTx-based check returned
// 'unknown' for EVERY UTXO in Electrum-only deployments, which walletSync.ts's
// bare-truthiness filter then rendered as an immature mining reward — freezing
// every ordinary deposit and change output for ~100 confirmations.
//
// The mocked chain seam below deliberately exposes ONLY getTxHex (no getTx) —
// mirroring a real Electrum-only backend and guarding against a future
// regression back to getTx: if isCoinbaseTx ever called getTx again, the mock
// object wouldn't have that method, the call would throw, and every
// happy-path assertion in this file would fail (status degrading to
// 'unknown' instead of a definitive true/false).
//
// isCoinbaseTx used to swallow a transient chain failure and return FALSE —
// an immature mining reward then looked ordinary and spendable, bypassing the
// 100-block maturity guard. The fix propagates 'unknown', and the shared spend
// rules (selectSpendCandidates in psbt.ts) treat an unverifiable coin inside
// the maturity window conservatively: dropped from automatic selection,
// refused with a clear error under coin control. These tests pin the whole
// path: annotation verdict → selection outcome.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';

const getTxHexMock = vi.fn<(txid: string) => Promise<string>>();
vi.mock('../chain', () => ({
	getChain: () => ({ getTxHex: getTxHexMock })
}));

import { annotateCoinbase } from './coinbaseScan';
import { selectSpendCandidates, PsbtError, type SpendableUtxo } from './psbt';

const ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const CHANGE_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

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

/**
 * Raw hex of an ordinary (non-coinbase) funding tx: a real (non-synthetic)
 * prevout input. `withChangeOutput` adds a second output to model the
 * "wallet's own change output" scenario from QA finding F2's corroboration —
 * coinbase-ness is a property of the funding tx's INPUT, not of what its
 * outputs are later spent as, so a normal input stays non-coinbase regardless
 * of how many outputs it has.
 */
function normalRawHex(withChangeOutput = false): string {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: 'ab'.repeat(32), index: 0 });
	tx.addOutputAddress(ADDRESS, 150_000_000n, NETWORK);
	if (withChangeOutput) tx.addOutputAddress(CHANGE_ADDRESS, 44_999_856n, NETWORK);
	return tx.hex;
}

/**
 * Raw hex of a genuine coinbase tx: exactly one input carrying the synthetic
 * marker prevout (32 zero bytes, index 0xffffffff) — the consensus-level
 * definition isCoinbaseTx now checks directly.
 */
function coinbaseRawHex(): string {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0xffffffff });
	tx.addOutputAddress(ADDRESS, 5_000_000_000n, NETWORK);
	return tx.hex;
}

const NORMAL_HEX = normalRawHex();
const CHANGE_HEX = normalRawHex(true);
const COINBASE_HEX = coinbaseRawHex();

beforeEach(() => {
	getTxHexMock.mockReset();
});

describe('annotateCoinbase under chain-RPC failure (cairn-9lnj / cairn-7fmd)', () => {
	it("marks the UTXO 'unknown' — NOT a silent 'not a coinbase' — when the funding-tx fetch fails", async () => {
		getTxHexMock.mockRejectedValue(new Error('electrum: connection reset'));
		const u = utxo(freshTxid());
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');
		expect(u.coinbase).not.toBe(false); // the pre-fix bug: failure → false → spendable
	});

	it('a fetch failure never fails the whole scan, and other coins still resolve', async () => {
		const bad = utxo(freshTxid());
		const good = utxo(freshTxid());
		getTxHexMock.mockImplementation(async (txid) => {
			if (txid === bad.txid) throw new Error('timeout');
			return NORMAL_HEX;
		});
		await expect(annotateCoinbase([bad, good])).resolves.toBeDefined();
		expect(bad.coinbase).toBe('unknown');
		expect(good.coinbase).toBe(false);
	});

	it("never caches 'unknown': a later scan re-fetches and can resolve the truth", async () => {
		const u = utxo(freshTxid());
		getTxHexMock.mockRejectedValueOnce(new Error('hiccup'));
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');

		// The chain recovers — the SAME txid must be fetched again, not served
		// from a poisoned cache, and now resolves definitively.
		getTxHexMock.mockResolvedValueOnce(COINBASE_HEX);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(true);
		expect(getTxHexMock).toHaveBeenCalledTimes(2);
	});

	it('caches definitive results: the second scan of a known txid never re-fetches', async () => {
		const u = utxo(freshTxid());
		getTxHexMock.mockResolvedValue(NORMAL_HEX);
		await annotateCoinbase([u]);
		await annotateCoinbase([utxo(u.txid)]);
		expect(getTxHexMock).toHaveBeenCalledTimes(1);
	});

	it("a malformed/unparseable raw hex resolves 'unknown' too, not a crash or a silent false", async () => {
		getTxHexMock.mockResolvedValue('not-valid-hex-zz');
		const u = utxo(freshTxid());
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');
	});
});

describe('unknown-coinbase coins are unspendable inside the maturity window (cairn-9lnj)', () => {
	// height 900_000 at tip 900_050 = 51 confirmations — inside the 100-block
	// maturity window, so an unverifiable coin COULD be an immature reward.
	const TIP = 900_050;

	async function unknownUtxo(height = 900_000): Promise<SpendableUtxo> {
		getTxHexMock.mockRejectedValue(new Error('chain down'));
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
		getTxHexMock.mockResolvedValue(NORMAL_HEX);
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

describe('Electrum-only mode (getTxHex works, no getTx configured) — QA finding F2 regression lock', () => {
	const TIP = 900_050;

	it('an ordinary deposit resolves coinbase === false, is spendable, and is NOT flagged as a mining reward', async () => {
		getTxHexMock.mockResolvedValue(NORMAL_HEX);
		const u = utxo(freshTxid(), 900_000); // 51 confs — would be immature IF it were a coinbase
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(false);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});

	it('a change-output scenario (ordinary input, two outputs) resolves coinbase === false', async () => {
		getTxHexMock.mockResolvedValue(CHANGE_HEX);
		const u = utxo(freshTxid(), 900_000);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(false);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});

	it('a true coinbase tx (raw hex with the zero-prevout/0xffffffff input) resolves coinbase === true and gets maturity treatment', async () => {
		getTxHexMock.mockResolvedValue(COINBASE_HEX);
		const immature = utxo(freshTxid(), 900_000); // 51 confs — immature
		await annotateCoinbase([immature]);
		expect(immature.coinbase).toBe(true);
		expect(() => selectSpendCandidates({ utxos: [immature], tipHeight: TIP }, 'wallet')).toThrow(
			/no mature coins/
		);

		const mature = utxo(freshTxid(), 800_000); // 100+ confs — mature
		await annotateCoinbase([mature]);
		expect(mature.coinbase).toBe(true);
		const { spendable } = selectSpendCandidates({ utxos: [mature], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([mature]);
	});

	it('getTxHex ALSO failing (a true transient failure) still resolves unknown and the spend guard still refuses', async () => {
		getTxHexMock.mockRejectedValue(new Error('electrum: connection reset'));
		const u = utxo(freshTxid(), 900_000);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe('unknown');
		try {
			selectSpendCandidates(
				{ utxos: [u], onlyUtxos: [{ txid: u.txid, vout: 0 }], tipHeight: TIP },
				'wallet'
			);
			expect.unreachable();
		} catch (e) {
			expect((e as PsbtError).code).toBe('immature_coinbase');
		}
	});
});

describe('happy path: raw-hex parsing works (cairn-9lnj)', () => {
	const TIP = 900_050;

	it('a non-coinbase coin resolves false and passes selection untouched', async () => {
		getTxHexMock.mockResolvedValue(NORMAL_HEX);
		const u = utxo(freshTxid());
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(false);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});

	it('an immature coinbase resolves true and is flagged: dropped from auto, rejected under coin control', async () => {
		getTxHexMock.mockResolvedValue(COINBASE_HEX);
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
		getTxHexMock.mockResolvedValue(COINBASE_HEX);
		const u = utxo(freshTxid(), 800_000);
		await annotateCoinbase([u]);
		expect(u.coinbase).toBe(true);
		const { spendable } = selectSpendCandidates({ utxos: [u], tipHeight: TIP }, 'wallet');
		expect(spendable).toEqual([u]);
	});
});
