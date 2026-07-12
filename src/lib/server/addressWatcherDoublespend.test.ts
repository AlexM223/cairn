// cairn-a2p1: an UNCONFIRMED inbound transaction that is double-spent / RBF'd
// away before it confirms must not leave Cairn showing a stale balance and a
// stale "payment received" forever. These tests drive the watcher through the
// full lifecycle with a mocked Electrum sequence:
//
//   • an unconfirmed inbound is SEEN → recorded as a 'pending' tracking row,
//     but (SPV gate) NOT surfaced as "payment received";
//   • it DISAPPEARS from the mempool (getTx not-found + gone from history) → the
//     row flips to 'replaced', a correcting notification fires, and a forced
//     snapshot refresh corrects the balance;
//   • the guard cases — still in the mempool, a transient no-txindex miss where
//     the tx is actually still present, and one of OUR OWN sends being bumped —
//     must NOT produce a false "cancelled" alert;
//   • a pending inbound that legitimately CONFIRMS surfaces tx_received and
//     transitions to 'notified'.
//
// Regtest e2e is out of scope (see the bead's residual-risk note); this pins the
// state machine + notification + balance-correction wiring.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import { parseXpub, deriveAddress, addressToScripthash, scriptPubKeyHex } from './bitcoin/xpub';
import type { TxDetail } from '$lib/types';

// ---- fakes ------------------------------------------------------------------

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
		// ChainService.getTx throws this exact shape for a tx that is in neither a
		// block nor the mempool — the signal a tracked inbound was replaced.
		if (!tx) throw new Error(`Transaction not found: ${txid}`);
		return tx;
	})
};

vi.mock('./chain/index', () => ({ getChain: () => fakeChain }));

// SPV inclusion proof is out of scope here (own unit tests) — accept every tx.
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

// The balance-correction path (forceSnapshotRefresh) dynamic-imports walletSync;
// mock it so we can assert the forced refresh WITHOUT standing up the scan stack.
const refreshWalletSnapshotMock = vi.fn(async () => null);
const refreshMultisigSnapshotMock = vi.fn(async () => null);
vi.mock('./walletSync', () => ({
	refreshWalletSnapshot: (...a: unknown[]) => refreshWalletSnapshotMock(...(a as [])),
	refreshMultisigSnapshot: (...a: unknown[]) => refreshMultisigSnapshotMock(...(a as []))
}));

import { startAddressWatcher, listReplacedInbound, _internals } from './addressWatcher';

// ---- fixture ----------------------------------------------------------------

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

let userId: number;
let walletId: number;
let watchedAddress: string;
let watchedScripthash: string;
let watchedScript: string; // scriptPubKey hex — network-independent

function inboundTx(txid: string, sats: number, opts: { confirmed: boolean; confirmations?: number }): TxDetail {
	return {
		txid,
		confirmed: opts.confirmed,
		blockHeight: opts.confirmed ? 150 : null,
		blockHash: opts.confirmed ? 'c'.repeat(64) : null,
		blockTime: opts.confirmed ? 1_700_000_000 : null,
		confirmations: opts.confirmations ?? (opts.confirmed ? 3 : 0),
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
				scriptPubKey: watchedScript, // attribution is by script, not address
				spent: false
			}
		]
	};
}

function statusOf(txid: string): string | null | undefined {
	const row = db
		.prepare('SELECT status FROM notified_txids WHERE wallet_id = ? AND txid = ?')
		.get(walletId, txid) as { status: string | null } | undefined;
	return row ? row.status : undefined;
}

beforeAll(async () => {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'doublespend@example.com',
			password: 'correct horse battery',
			displayName: 'DoubleSpend'
		})
	).id;
	walletId = createWallet(userId, { name: 'Watched', xpub: XPUB }).id;

	const derived = deriveAddress(parseXpub(XPUB), 0, 0);
	watchedAddress = derived.address;
	watchedScripthash = addressToScripthash(watchedAddress);
	watchedScript = scriptPubKeyHex(watchedAddress).toLowerCase();

	// Boot the watcher past its 10s startup delay so the subscribe + (empty)
	// baseline pass completes and change/header events are armed.
	vi.useFakeTimers();
	startAddressWatcher();
	await vi.advanceTimersByTimeAsync(10_500);
	vi.useRealTimers();
	expect(pool.subscribeScripthash).toHaveBeenCalled();

	// Seed the difficulty-floor cache so spvVerifyConfirmed never cold-defers.
	pool.emit('header', { height: 1, hex: '00'.repeat(80) });
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

describe('cairn-a2p1: unconfirmed inbound tracking + double-spend reconciliation', () => {
	it('tracks an unconfirmed inbound as pending (no notification), then flips it to replaced with a correcting notification + balance refresh when it disappears', async () => {
		const TXID = 'a'.repeat(64);

		// --- stage 1: unconfirmed inbound seen → tracked as 'pending', SILENT ---
		txById.set(TXID, inboundTx(TXID, 250_000, { confirmed: false }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 0 }]);
		pool.emit('scripthash', watchedScripthash, 'status-mempool');

		await vi.waitFor(() => expect(statusOf(TXID)).toBe('pending'));
		// SPV gate: an unconfirmed inbound must NOT surface a "payment received".
		expect(notifyMock).not.toHaveBeenCalled();
		const pendingRow = db
			.prepare('SELECT amount_sats FROM notified_txids WHERE wallet_id = ? AND txid = ?')
			.get(walletId, TXID) as { amount_sats: number };
		expect(pendingRow.amount_sats).toBe(250_000);

		// --- stage 2: it is double-spent / RBF'd away — gone from mempool ---
		txById.delete(TXID); // getTx now throws "Transaction not found"
		historyByScripthash.set(watchedScripthash, []); // and gone from address history
		notifyMock.mockClear();

		pool.emit('header', { height: 2, hex: '00'.repeat(80) });

		await vi.waitFor(() => expect(statusOf(TXID)).toBe('replaced'));

		// Correcting notification — plain language, amber (warn), never red.
		expect(notifyMock).toHaveBeenCalledTimes(1);
		const call = notifyMock.mock.calls[0][0] as {
			type: string;
			level: string;
			title: string;
			body: string;
			detail: Record<string, unknown>;
			userId: number;
		};
		expect(call.type).toBe('tx_replaced');
		expect(call.level).toBe('warn');
		expect(call.title).toBe('Incoming payment cancelled');
		expect(call.body).toContain('cancelled');
		expect(call.userId).toBe(userId);
		// No txid in the detail (the tx no longer exists on-chain — no dead link).
		expect(call.detail.txid).toBeUndefined();
		expect(call.detail.replaced).toBe(true);

		// Balance correction: a forced snapshot refresh for THIS wallet.
		expect(refreshWalletSnapshotMock).toHaveBeenCalledWith(userId, walletId, { force: true });

		// Surfaced to the wallet-detail page as a cancelled row, with its amount.
		const cancelled = listReplacedInbound('wallet', walletId);
		expect(cancelled).toEqual([{ txid: TXID, amountSats: 250_000 }]);
	});

	it('does NOT flip to replaced while the tx is still in the mempool', async () => {
		const TXID = 'b'.repeat(64);
		// Pending row already tracked; the tx is still live (unconfirmed) in getTx.
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'pending', 90000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, inboundTx(TXID, 90_000, { confirmed: false }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 0 }]);

		pool.emit('header', { height: 3, hex: '00'.repeat(80) });
		await vi.waitFor(() => expect(fakeChain.getTx).toHaveBeenCalledWith(TXID));

		expect(statusOf(TXID)).toBe('pending'); // untouched
		expect(notifyMock).not.toHaveBeenCalled();
		expect(refreshWalletSnapshotMock).not.toHaveBeenCalled();
	});

	it('does NOT flip to replaced when getTx misses but the tx is STILL in the address history (transient / no-txindex)', async () => {
		const TXID = 'c'.repeat(64);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 70000)`
		).run(walletId, userId, TXID);
		// getTx throws not-found (txById empty), BUT the history still lists it —
		// so the cross-check proves it is not actually gone.
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		pool.emit('header', { height: 4, hex: '00'.repeat(80) });
		await vi.waitFor(() => expect(fakeChain.getTx).toHaveBeenCalledWith(TXID));

		expect(statusOf(TXID)).toBe('notified'); // NOT replaced
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('marks our OWN outgoing send replaced silently (no "cancelled" alert) when it is bumped away', async () => {
		const TXID = 'd'.repeat(64);
		// A saved outgoing transaction row with this txid — a self-RBF, not an
		// external inbound cancellation.
		db.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate)
			 VALUES (?, 'completed', 'PSBT', ?, 'bc1qrecipient', 10000, 200, 2.0)`
		).run(walletId, TXID);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 40000)`
		).run(walletId, userId, TXID);
		historyByScripthash.set(watchedScripthash, []); // gone from history

		pool.emit('header', { height: 5, hex: '00'.repeat(80) });
		// Reconciled to 'dropped' (silent) — NOT 'replaced' (user-facing).
		await vi.waitFor(() => expect(statusOf(TXID)).toBe('dropped'));

		// It is reconciled (balance corrected) but NOT announced as a cancellation.
		expect(notifyMock).not.toHaveBeenCalled();
		expect(refreshWalletSnapshotMock).toHaveBeenCalledWith(userId, walletId, { force: true });
		// Not offered to the detail page as an inbound "cancelled" row either.
		expect(listReplacedInbound('wallet', walletId)).toEqual([]);
	});

	it('surfaces tx_received and transitions pending → notified when the inbound legitimately confirms', async () => {
		const TXID = 'e'.repeat(64);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'pending', 123456)`
		).run(walletId, userId, TXID);

		// It confirms: now visible at a real height and confirmed via getTx.
		txById.set(TXID, inboundTx(TXID, 123_456, { confirmed: true, confirmations: 1 }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		pool.emit('scripthash', watchedScripthash, 'status-confirmed');

		await vi.waitFor(() => expect(statusOf(TXID)).toBe('notified'));
		const call = notifyMock.mock.calls.find(
			(c) => (c[0] as { type: string }).type === 'tx_received'
		)?.[0] as { title: string; detail: { amountSats?: number } } | undefined;
		expect(call).toBeTruthy();
		expect(call!.title).toBe('Payment received');
		expect(call!.detail.amountSats).toBe(123_456);
	});
});
