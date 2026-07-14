// Regression tests for collectScanTxs' Electrum-only fallback (QA finding F4).
//
// Symptom: after a confirmed spend, balance and per-address txCount were
// correct (both come straight from Electrum's get_balance/get_history), but
// wallet.lastActivity stayed null and the Transactions tab showed nothing.
// Root cause: collectScanTxs called chain.getTx() for every candidate tx's
// delta/fee/time, and getTx() unconditionally throws when Core RPC is not
// configured (chain/index.ts) — exactly the Electrum-only setup Cairn's docs
// treat as the primary deployment. A caught
// getTx() failure silently OMITTED the transaction rather than falling back,
// so scan.txs came back empty and wallet.lastActivity (derived from it) had
// nothing to work with.
//
// These tests mock the chain seam with ONLY getTxHex + getBlockTimeAtHeight
// (no getTx at all) — the same "Electrum-only" shape walletSync.test.ts uses
// for the sibling F2 regression — and drive collectScanTxs directly.

import { describe, it, expect, beforeEach } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { vi } from 'vitest';

const { getTxMock, getTxHexMock, getBlockTimeAtHeightMock } = vi.hoisted(() => ({
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn(),
	getBlockTimeAtHeightMock: vi.fn()
}));

vi.mock('../chain/index', () => ({
	getChain: () => ({
		getTx: getTxMock,
		getTxHex: getTxHexMock,
		getBlockTimeAtHeight: getBlockTimeAtHeightMock
	})
}));

import { collectScanTxs } from './gapLimitScanner';
import { parseXpub, deriveAddress, scriptPubKeyHex } from './xpub';
import type { ElectrumHistoryItem } from '../electrum/client';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const parsed = parseXpub(ZPUB);
const RECEIVE_0 = deriveAddress(parsed, 0, 0).address; // m/0/0 — wallet-owned
const CHANGE_0 = deriveAddress(parsed, 1, 0).address; // m/1/0 — wallet-owned change
const EXTERNAL = deriveAddress(parsed, 0, 5).address; // not included in `scanned` below — treated as external

const TXOPTS = { allowUnknownInputs: true, disableScriptCheck: true } as const;

/** Deposit: an external, unresolvable funding input paying straight to RECEIVE_0. */
function buildDepositTx(): Transaction {
	const tx = new Transaction(TXOPTS);
	tx.addInput({ txid: 'aa'.repeat(32), index: 0 }); // funding parent intentionally NOT stubbed
	tx.addOutputAddress(RECEIVE_0, 1_500_000n, NETWORK);
	return tx;
}

/** Spend: consumes the deposit's output, pays an external recipient + wallet change. */
function buildSpendTx(depositTxid: string): Transaction {
	const tx = new Transaction(TXOPTS);
	tx.addInput({ txid: depositTxid, index: 0 });
	tx.addOutputAddress(EXTERNAL, 1_000_000n, NETWORK);
	tx.addOutputAddress(CHANGE_0, 499_000n, NETWORK);
	return tx;
}

/** Mirrors wallets.ts' lastActivityOf: newest confirmed tx time, or "now" if pending. */
function lastActivityOf(txs: { height: number; time: number | null }[]): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of txs) {
		if (tx.height <= 0) pending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	if (pending) return Math.floor(Date.now() / 1000);
	return latest;
}

describe('collectScanTxs — Electrum-only fallback (QA F4 regression)', () => {
	beforeEach(() => {
		// Default: no Core RPC configured, mirroring an Electrum-only deployment
		// where chain.getTx() unconditionally throws — the existing tests below
		// rely on this to exercise the raw-parse fallback. The cairn-uhg1 test
		// further down overrides this to exercise the getTx()-succeeds-but-no-
		// prevout path instead.
		getTxMock.mockReset().mockRejectedValue(new Error('getTx() needs Core RPC'));
		getTxHexMock.mockReset();
		getBlockTimeAtHeightMock.mockReset();
	});

	it('populates the activity list (and would set lastActivity) for a received + later-spent address, with no getTx() available at all', async () => {
		const deposit = buildDepositTx();
		const spend = buildSpendTx(deposit.id);

		getTxHexMock.mockImplementation(async (txid: string) => {
			if (txid === deposit.id) return deposit.hex;
			if (txid === spend.id) return spend.hex;
			throw new Error(`unknown txid in test fixture: ${txid}`); // e.g. the deposit's own external funding parent
		});
		getBlockTimeAtHeightMock.mockImplementation(async (height: number) => {
			if (height === 100) return 1_700_000_000;
			if (height === 200) return 1_700_100_000;
			throw new Error(`unexpected height: ${height}`);
		});

		const scanned = [
			{
				address: RECEIVE_0,
				history: [
					{ tx_hash: deposit.id, height: 100 },
					{ tx_hash: spend.id, height: 200 }
				] as ElectrumHistoryItem[]
			},
			{
				address: CHANGE_0,
				history: [{ tx_hash: spend.id, height: 200 }] as ElectrumHistoryItem[]
			}
		];

		const txs = await collectScanTxs(scanned);

		// The pre-fix bug: this came back empty (every getTx() call threw, and the
		// tx was silently omitted instead of falling back), so lastActivity/the
		// Transactions tab had nothing to show despite a real, confirmed spend.
		expect(txs).toHaveLength(2);

		const byId = new Map(txs.map((t) => [t.txid, t]));
		const depositTx = byId.get(deposit.id);
		const spendTx = byId.get(spend.id);
		expect(depositTx).toBeDefined();
		expect(spendTx).toBeDefined();

		// Deposit: +1,500,000 received on RECEIVE_0; funding parent unresolvable
		// (external, not stubbed) so fee degrades to null rather than a guess.
		expect(depositTx).toMatchObject({ height: 100, time: 1_700_000_000, delta: 1_500_000, fee: null });

		// Spend: -1,500,000 (RECEIVE_0 input resolved via the deposit tx) + 499,000
		// change back to CHANGE_0 = net -1,001,000; fee = 1,500,000 - 1,000,000 -
		// 499,000 = 1,000, fully resolvable since the one input's parent is known.
		expect(spendTx).toMatchObject({
			height: 200,
			time: 1_700_100_000,
			delta: 499_000 - 1_500_000,
			fee: 1_000
		});

		// The exact field wallet.lastActivity is derived from (wallets.ts
		// lastActivityOf / walletSync.ts summarizeTxs) — now non-null.
		expect(lastActivityOf(txs)).toBe(1_700_100_000);
	});

	it('omits a transaction only when its OWN raw bytes are unfetchable (never fabricates one)', async () => {
		getTxHexMock.mockRejectedValue(new Error('electrum: connection reset'));
		getBlockTimeAtHeightMock.mockResolvedValue(1_700_000_000);

		const scanned = [
			{
				address: RECEIVE_0,
				history: [{ tx_hash: 'bb'.repeat(32), height: 300 }] as ElectrumHistoryItem[]
			}
		];

		const txs = await collectScanTxs(scanned);
		expect(txs).toEqual([]);
	});

	// cairn-uhg1: chain.getTx() can also "succeed" without throwing while still
	// carrying no prevout data — a full-indexing Electrum server's verbose
	// transaction.get decode (chain/index.ts's getTxViaElectrum, cairn-zc4x) and
	// an old pre-verbosity-2 Core node both do this. Before this fix, a
	// successful-but-incomplete getTx() result was trusted at face value: every
	// non-coinbase vin has prevScriptPubKey/value null, so the spent-wallet-
	// input side of the delta was silently never subtracted — a spend would
	// have reported a wrong (too-high) delta instead of falling back to
	// raw-parse like the "getTx() throws" case already did.
	it('falls back to raw-parse (not a wrong delta) when getTx() decodes the tx WITHOUT prevout data', async () => {
		const deposit = buildDepositTx();
		const spend = buildSpendTx(deposit.id);

		// getTx() "succeeds" for the spend tx, Electrum-verbose-decode shaped:
		// vout is fully known (no prevout needed there, matching buildSpendTx's
		// EXTERNAL + CHANGE_0 outputs) but the one non-coinbase vin has null
		// prevScriptPubKey/value, exactly like chain/index.ts's toTxDetailFromCore
		// maps a Core/Electrum verbose (no verbosity-2) reply.
		getTxMock.mockImplementation(async (txid: string) => {
			if (txid !== spend.id) throw new Error(`unstubbed getTx ${txid}`);
			return {
				vout: [
					{ scriptPubKey: scriptPubKeyHex(EXTERNAL), value: 1_000_000, address: null, spent: null },
					{ scriptPubKey: scriptPubKeyHex(CHANGE_0), value: 499_000, address: null, spent: null }
				],
				vin: [{ coinbase: false, prevScriptPubKey: null, value: null, txid: deposit.id, vout: 0 }],
				blockTime: 1_700_100_000,
				fee: null
			};
		});
		getTxHexMock.mockImplementation(async (txid: string) => {
			if (txid === deposit.id) return deposit.hex;
			if (txid === spend.id) return spend.hex;
			throw new Error(`unknown txid in test fixture: ${txid}`);
		});
		getBlockTimeAtHeightMock.mockImplementation(async (height: number) => {
			if (height === 200) return 1_700_100_000;
			throw new Error(`unexpected height: ${height}`);
		});

		const scanned = [
			{ address: RECEIVE_0, history: [{ tx_hash: spend.id, height: 200 }] as ElectrumHistoryItem[] },
			{ address: CHANGE_0, history: [{ tx_hash: spend.id, height: 200 }] as ElectrumHistoryItem[] }
		];

		const txs = await collectScanTxs(scanned);
		expect(txs).toHaveLength(1);

		// The bug: trusting getTx()'s null-prevout vin would have reported delta
		// = +499,000 (only the change output counted, spent 1,500,000 input never
		// subtracted). The fix: fall through to raw-parse, which resolves the
		// deposit as the spend's parent and gets the correct net delta.
		expect(txs[0]).toMatchObject({ delta: 499_000 - 1_500_000, fee: 1_000 });
	});
});
