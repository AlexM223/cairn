// cairn-ieilg: with CONFIRM_THRESHOLD = 1, a payment can fire tx_received AND
// tx_confirmed and then be reorged out one block later. Before the fix,
// handleNewBlock's scan excluded every confirmed=1 row, so the stale
// "Payment received" (and the inflated balance) survived forever — the a2p1
// reconciliation could never run for it. The fix stamps `confirmed_height` when
// tx_confirmed fires and keeps re-checking recently-confirmed 'notified' rows
// inside a REORG_RECHECK_DEPTH (6-block) window.
//
// Harness cloned from addressWatcherDoublespend.test.ts (same fakes, same
// lifecycle boot); heights used here are strictly increasing per test because
// state.tipHeight is monotonic across the shared watcher singleton.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import { parseXpub, deriveAddress, addressToScripthash, scriptPubKeyHex } from './bitcoin/xpub';
import type { TxDetail } from '$lib/types';

// ---- fakes (mirroring addressWatcherDoublespend.test.ts) --------------------

const historyByScripthash = new Map<string, { tx_hash: string; height: number }[]>();
class FakePool extends EventEmitter {
	subscribeScripthash = vi.fn(async () => 'status0');
	getHistory = vi.fn(async (sh: string) => historyByScripthash.get(sh) ?? []);
	getMerkleProof = vi.fn(async () => ({ merkle: [], pos: 0 }));
	getBlockHeader = vi.fn(async () => '00'.repeat(80));
}
const pool = new FakePool();

const txById = new Map<string, TxDetail>();
const fakeChain = {
	electrum: pool,
	getTip: vi.fn(async () => ({ height: 200 })),
	getTx: vi.fn(async (txid: string) => {
		const tx = txById.get(txid);
		if (!tx) throw new Error(`Transaction not found: ${txid}`);
		return tx;
	})
};

vi.mock('./chain/index', () => ({ getChain: () => fakeChain }));

vi.mock('./bitcoin/spv', () => ({
	verifyTxInclusion: () => ({ ok: true }),
	parseBlockHeader: () => ({
		version: 1,
		prevHash: '0'.repeat(64),
		merkleRoot: '0'.repeat(64),
		time: 0,
		bits: 0x207fffff,
		nonce: 0
	}),
	blockHash: (hex: string) => hex,
	meetsTarget: () => true,
	bitsToTarget: () => 1n
}));

const notifyMock = vi.fn();
vi.mock('./notifications', () => ({ notify: (...args: unknown[]) => notifyMock(...args) }));

const refreshWalletSnapshotMock = vi.fn(async () => null);
const refreshMultisigSnapshotMock = vi.fn(async () => null);
vi.mock('./walletSync', () => ({
	refreshWalletSnapshot: (...a: unknown[]) => refreshWalletSnapshotMock(...(a as [])),
	refreshMultisigSnapshot: (...a: unknown[]) => refreshMultisigSnapshotMock(...(a as []))
}));

import { startAddressWatcher, listReplacedInbound } from './addressWatcher';

// ---- fixture ----------------------------------------------------------------

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

let userId: number;
let walletId: number;
let watchedScripthash: string;
let watchedScript: string;

function confirmedTx(txid: string, sats: number, confirmations = 1): TxDetail {
	return {
		txid,
		confirmed: true,
		blockHeight: 150,
		blockHash: 'c'.repeat(64),
		blockTime: 1_700_000_000,
		confirmations,
		size: 200,
		vsize: 110,
		weight: 440,
		fee: 500,
		feeRate: 4.5,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: true,
		vin: [],
		vout: [
			{
				address: 'bcrt1qforeignencoding00000000000000000000000',
				value: sats,
				scriptType: 'v0_p2wpkh',
				scriptPubKey: watchedScript,
				spent: false
			}
		]
	};
}

function rowOf(txid: string):
	| { status: string | null; confirmed: number; confirmed_height: number | null }
	| undefined {
	return db
		.prepare(
			'SELECT status, confirmed, confirmed_height FROM notified_txids WHERE wallet_id = ? AND txid = ?'
		)
		.get(walletId, txid) as
		| { status: string | null; confirmed: number; confirmed_height: number | null }
		| undefined;
}

function emitHeader(height: number): void {
	pool.emit('header', { height, hex: '00'.repeat(80) });
}

beforeAll(async () => {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'reorg@example.com',
			password: 'correct horse battery',
			displayName: 'Reorg'
		})
	).id;
	walletId = createWallet(userId, { name: 'Watched', xpub: XPUB }).id;

	const derived = deriveAddress(parseXpub(XPUB), 0, 0);
	watchedScripthash = addressToScripthash(derived.address);
	watchedScript = scriptPubKeyHex(derived.address).toLowerCase();

	vi.useFakeTimers();
	startAddressWatcher();
	await vi.advanceTimersByTimeAsync(10_500);
	vi.useRealTimers();
	expect(pool.subscribeScripthash).toHaveBeenCalled();

	// Seed the difficulty-floor cache so spvVerifyConfirmed never cold-defers.
	emitHeader(1);
});

beforeEach(() => {
	db.exec('DELETE FROM notified_txids');
	historyByScripthash.clear();
	txById.clear();
	notifyMock.mockClear();
	refreshWalletSnapshotMock.mockClear();
	refreshMultisigSnapshotMock.mockClear();
});

// ---- tests ------------------------------------------------------------------

describe('cairn-ieilg: reorg-out AFTER tx_confirmed is reconciled within the recheck window', () => {
	it('stamps confirmed_height when tx_confirmed fires', async () => {
		const TXID = 'a1'.repeat(32);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 250000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, confirmedTx(TXID, 250_000));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		emitHeader(10);
		await vi.waitFor(() => expect(rowOf(TXID)?.confirmed).toBe(1));

		const row = rowOf(TXID)!;
		expect(row.confirmed_height).toBe(10); // the tip at confirmation time
		expect(
			notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_confirmed')
		).toBe(true);
	});

	it('flips a confirmed row to replaced with a "reversed" (not "cancelled") notification + balance refresh when the tx vanishes inside the window', async () => {
		const TXID = 'b2'.repeat(32);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 400000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, confirmedTx(TXID, 400_000));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		// Confirm it (fires tx_confirmed, stamps confirmed_height = 20).
		emitHeader(20);
		await vi.waitFor(() => expect(rowOf(TXID)?.confirmed).toBe(1));
		notifyMock.mockClear();
		refreshWalletSnapshotMock.mockClear();

		// One block later the chain reorgs it out: getTx not-found AND gone from
		// the address history.
		txById.delete(TXID);
		historyByScripthash.set(watchedScripthash, []);
		emitHeader(21); // 20 > 21 - 6 → still inside the recheck window

		await vi.waitFor(() => expect(rowOf(TXID)?.status).toBe('replaced'));

		const call = notifyMock.mock.calls.find(
			(c) => (c[0] as { type: string }).type === 'tx_replaced'
		)?.[0] as { title: string; body: string; level: string } | undefined;
		expect(call).toBeTruthy();
		expect(call!.title).toBe('Confirmed payment reversed');
		expect(call!.body).toContain('reorganization');
		expect(call!.level).toBe('warn');
		// Balance corrected, and surfaced as a cancelled row with its amount.
		expect(refreshWalletSnapshotMock).toHaveBeenCalledWith(userId, walletId, { force: true });
		expect(listReplacedInbound('wallet', walletId)).toEqual([{ txid: TXID, amountSats: 400_000 }]);
	});

	it('leaves a still-present confirmed row untouched (no duplicate tx_confirmed, no reconcile)', async () => {
		const TXID = 'c3'.repeat(32);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 50000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, confirmedTx(TXID, 50_000));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		emitHeader(30);
		await vi.waitFor(() => expect(rowOf(TXID)?.confirmed).toBe(1));
		notifyMock.mockClear();
		fakeChain.getTx.mockClear();

		// Next block: the row is re-checked (inside the window) but still present —
		// nothing fires, nothing flips.
		emitHeader(31);
		await vi.waitFor(() => expect(fakeChain.getTx).toHaveBeenCalledWith(TXID));

		const row = rowOf(TXID)!;
		expect(row.status).toBe('notified');
		expect(row.confirmed).toBe(1);
		expect(row.confirmed_height).toBe(30); // NOT re-stamped by the re-check
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('stops re-checking once the row is deeper than REORG_RECHECK_DEPTH — a later disappearance is left alone', async () => {
		const TXID = 'd4'.repeat(32);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 60000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, confirmedTx(TXID, 60_000));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		emitHeader(40);
		await vi.waitFor(() => expect(rowOf(TXID)?.confirmed).toBe(1)); // confirmed_height = 40
		notifyMock.mockClear();

		// Tip advances beyond the window (40 ≤ 47 - 6), THEN the tx vanishes.
		txById.delete(TXID);
		historyByScripthash.set(watchedScripthash, []);
		fakeChain.getTx.mockClear();
		emitHeader(47);

		// The scan ran (header processed) but never selected this row.
		await new Promise((r) => setTimeout(r, 50));
		expect(fakeChain.getTx).not.toHaveBeenCalledWith(TXID);
		const row = rowOf(TXID)!;
		expect(row.status).toBe('notified'); // stale by design past the window
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('never re-checks legacy confirmed rows (confirmed_height NULL — incl. baselined rows)', async () => {
		const TXID = 'e5'.repeat(32);
		// A pre-fix row: confirmed=1, no confirmed_height (also the shape of every
		// baselined row, which additionally has status NULL).
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 1, 'notified', 70000)`
		).run(walletId, userId, TXID);
		historyByScripthash.set(watchedScripthash, []);
		fakeChain.getTx.mockClear();

		emitHeader(55);
		await new Promise((r) => setTimeout(r, 50));

		expect(fakeChain.getTx).not.toHaveBeenCalledWith(TXID);
		expect(rowOf(TXID)!.status).toBe('notified');
		expect(notifyMock).not.toHaveBeenCalled();
	});
});
