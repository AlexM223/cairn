// cairn-er7r (remainder): addressWatcherSpv.test.ts already exercises the real
// SPV verification gate (pass + forged/cold-cache fail paths against genuine
// mined headers). This file covers the three gaps the bead called out that
// SPV coverage doesn't touch:
//
//   • tx_confirmed — handleNewBlock's confirmation pass, entirely untested
//     elsewhere (addressWatcherDoublespend.test.ts only drives the
//     pending→notified transition, never the notified→confirmed one).
//   • tx_large — the large-payment threshold notification, never triggered by
//     any existing test.
//   • the baseline anti-flood system (cairn-3bt1/cairn-u7bw): pre-existing
//     history must be recorded SILENTLY at startup, and an address whose
//     initial baseline fetch fails must stay quarantined (never treated as
//     "new" history) until a retry succeeds — the exact bug that shipped
//     twice and flooded real users with false "payment received" /
//     "transaction confirmed" alerts for their entire existing history.

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
	unsubscribeScripthash = vi.fn(async () => true);
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

// SPV inclusion proof has its own dedicated real-crypto tests
// (addressWatcherSpv.test.ts) — out of scope here, so accept every proof.
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

import { startAddressWatcher, _internals } from './addressWatcher';

// ---- fixture ----------------------------------------------------------------

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

let userId: number;
let walletId: number;
let watchedAddress: string;
let watchedScripthash: string;
let watchedScript: string;

function inboundTx(
	txid: string,
	sats: number,
	opts: { confirmed: boolean; confirmations?: number; height?: number }
): TxDetail {
	return {
		txid,
		confirmed: opts.confirmed,
		blockHeight: opts.confirmed ? opts.height ?? 150 : null,
		blockHash: opts.confirmed ? 'c'.repeat(64) : null,
		blockTime: opts.confirmed ? 1_700_000_000 : null,
		confirmations: opts.confirmations ?? (opts.confirmed ? 1 : 0),
		size: 200,
		vsize: 110,
		weight: 440,
		fee: 500,
		feeRate: 4.5,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
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

function rowFor(txid: string): { status: string | null; confirmed: number; amount_sats: number | null } | undefined {
	return db
		.prepare('SELECT status, confirmed, amount_sats FROM notified_txids WHERE wallet_id = ? AND txid = ?')
		.get(walletId, txid) as { status: string | null; confirmed: number; amount_sats: number | null } | undefined;
}

function setLargeThreshold(uid: number, thresholdSats: number): void {
	db.prepare(
		`INSERT INTO notification_preferences (user_id, event_type, channel, enabled, config)
		 VALUES (?, 'tx_large', 'inapp', 1, ?)
		 ON CONFLICT(user_id, event_type, channel) DO UPDATE SET config = excluded.config`
	).run(uid, JSON.stringify({ thresholdSats }));
}

beforeAll(async () => {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM notification_preferences; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'confirmflood@example.com',
			password: 'correct horse battery',
			displayName: 'ConfirmFlood'
		})
	).id;
	walletId = createWallet(userId, { name: 'Watched', xpub: XPUB }).id;

	const derived = deriveAddress(parseXpub(XPUB), 0, 0);
	watchedAddress = derived.address;
	watchedScripthash = addressToScripthash(watchedAddress);
	watchedScript = scriptPubKeyHex(watchedAddress).toLowerCase();

	vi.useFakeTimers();
	startAddressWatcher();
	await vi.advanceTimersByTimeAsync(10_500);
	vi.useRealTimers();
	expect(pool.subscribeScripthash).toHaveBeenCalled();

	// Seed the difficulty-floor cache so spvVerifyConfirmed never cold-defers
	// (SPV itself is mocked to always-ok above, but tipCache emptiness is
	// checked independently in production code — harmless here either way).
	pool.emit('header', { height: 1, hex: '00'.repeat(80) });
});

beforeEach(() => {
	db.exec('DELETE FROM notified_txids');
	historyByScripthash.clear();
	txById.clear();
	notifyMock.mockClear();
});

// ---- tx_confirmed -------------------------------------------------------------

describe('handleNewBlock: tx_confirmed', () => {
	it('fires tx_confirmed once a notified inbound reaches CONFIRM_THRESHOLD confirmations, and flips confirmed=1', async () => {
		const TXID = '1'.repeat(64);
		// A previously-notified, not-yet-confirmed inbound (as claimReceived leaves
		// it: confirmed=0, status='notified').
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 50000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, inboundTx(TXID, 50_000, { confirmed: true, confirmations: 1 }));

		pool.emit('header', { height: 10, hex: '00'.repeat(80) });

		await vi.waitFor(() => expect(rowFor(TXID)?.confirmed).toBe(1));

		const call = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === 'tx_confirmed')?.[0] as
			| { title: string; level: string; detail: Record<string, unknown> }
			| undefined;
		expect(call).toBeTruthy();
		expect(call!.title).toBe('Transaction confirmed');
		expect(call!.level).toBe('success');
		expect(call!.detail.txid).toBe(TXID);
		expect(call!.detail.confirmations).toBe(1);
	});

	it('does not re-fire tx_confirmed on a later block once already confirmed', async () => {
		const TXID = '2'.repeat(64);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'notified', 60000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, inboundTx(TXID, 60_000, { confirmed: true, confirmations: 1 }));

		pool.emit('header', { height: 11, hex: '00'.repeat(80) });
		await vi.waitFor(() => expect(rowFor(TXID)?.confirmed).toBe(1));
		notifyMock.mockClear();

		// A further block still reports the tx confirmed — the scan query only
		// selects confirmed=0 rows, so this must be a no-op.
		txById.set(TXID, inboundTx(TXID, 60_000, { confirmed: true, confirmations: 2 }));
		pool.emit('header', { height: 12, hex: '00'.repeat(80) });
		await vi.waitFor(() => expect(fakeChain.getTx).toHaveBeenCalledWith(TXID));

		expect(notifyMock).not.toHaveBeenCalled();
	});

	it('leaves a still-pending (not yet surfaced) inbound alone until the scripthash handler flips it to notified', async () => {
		const TXID = '3'.repeat(64);
		db.prepare(
			`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed, status, amount_sats)
			 VALUES ('wallet', ?, ?, ?, 0, 'pending', 70000)`
		).run(walletId, userId, TXID);
		txById.set(TXID, inboundTx(TXID, 70_000, { confirmed: true, confirmations: 1 }));

		pool.emit('header', { height: 13, hex: '00'.repeat(80) });
		await vi.waitFor(() => expect(fakeChain.getTx).toHaveBeenCalledWith(TXID));

		// tx_confirmed must NOT jump ahead of tx_received: the row stays pending
		// and unconfirmed until the scripthash-change path notifies first.
		expect(rowFor(TXID)?.status).toBe('pending');
		expect(rowFor(TXID)?.confirmed).toBe(0);
		expect(notifyMock).not.toHaveBeenCalled();
	});
});

// ---- tx_large -------------------------------------------------------------

describe('handleScripthashChange: tx_large threshold', () => {
	it('fires tx_large in addition to tx_received when the inbound clears the configured threshold', async () => {
		setLargeThreshold(userId, 1_000_000);
		const TXID = '4'.repeat(64);
		txById.set(TXID, inboundTx(TXID, 1_500_000, { confirmed: true, confirmations: 1, height: 150 }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);

		pool.emit('scripthash', watchedScripthash, 'status-large');

		await vi.waitFor(() =>
			expect(notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_large')).toBe(true)
		);
		const received = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === 'tx_received')?.[0] as
			| { detail: { amountSats: number } }
			| undefined;
		const large = notifyMock.mock.calls.find((c) => (c[0] as { type: string }).type === 'tx_large')?.[0] as
			| { title: string; level: string; detail: { amountSats: number; thresholdSats: number } }
			| undefined;
		expect(received!.detail.amountSats).toBe(1_500_000);
		expect(large).toBeTruthy();
		expect(large!.title).toBe('Large payment received');
		expect(large!.detail.amountSats).toBe(1_500_000);
		expect(large!.detail.thresholdSats).toBe(1_000_000);
	});

	it('does NOT fire tx_large when the inbound is below the configured threshold', async () => {
		setLargeThreshold(userId, 1_000_000);
		const TXID = '5'.repeat(64);
		txById.set(TXID, inboundTx(TXID, 500_000, { confirmed: true, confirmations: 1, height: 151 }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 151 }]);

		pool.emit('scripthash', watchedScripthash, 'status-small');

		await vi.waitFor(() =>
			expect(notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_received')).toBe(true)
		);
		expect(notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_large')).toBe(false);
	});

	it('does NOT fire tx_large when the user has no threshold configured', async () => {
		db.exec('DELETE FROM notification_preferences');
		const TXID = '6'.repeat(64);
		txById.set(TXID, inboundTx(TXID, 50_000_000, { confirmed: true, confirmations: 1, height: 152 }));
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 152 }]);

		pool.emit('scripthash', watchedScripthash, 'status-nolimit');

		await vi.waitFor(() =>
			expect(notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_received')).toBe(true)
		);
		expect(notifyMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'tx_large')).toBe(false);
	});
});

// ---- cairn-3bt1 / cairn-u7bw: baseline anti-flood --------------------------

describe('baseline anti-flood (cairn-3bt1 / cairn-u7bw)', () => {
	it('records a freshly-subscribed address\'s pre-existing history as baselined (confirmed=1) WITHOUT any notification', async () => {
		// A second wallet, subscribed fresh (as refreshWatches would for a
		// newly-created or imported wallet) with history that ALREADY existed
		// before Cairn ever watched it.
		// Index chosen past WATCH_WINDOW (30) so the startup baseline pass in
		// beforeAll — which already derives/subscribes/baselines indices 0..29 on
		// both chains for this wallet — never touches it; it is genuinely
		// "freshly subscribed" from this test's point of view.
		const xpub2 = parseXpub(XPUB);
		const derived2 = deriveAddress(xpub2, 0, 35);
		const address2 = derived2.address;
		const scripthash2 = addressToScripthash(address2);

		const preexistingTxid = '7'.repeat(64);
		historyByScripthash.set(scripthash2, [{ tx_hash: preexistingTxid, height: 100 }]);

		// Directly exercise the same baseline path refreshWatches' retry sweep
		// uses: register the watch, then baseline it as "pending" (not yet in
		// baselinedScripthashes), mirroring a newly-subscribed address.
		_internals.state.byScripthash.set(scripthash2, {
			kind: 'wallet',
			walletId,
			userId,
			address: address2
		});
		expect(_internals.state.baselinedScripthashes.has(scripthash2)).toBe(false);

		notifyMock.mockClear();
		// A change event for a not-yet-baselined address takes the on-demand
		// baseline branch — silently recording history, never notifying.
		pool.emit('scripthash', scripthash2, 'status-fresh-baseline');

		await vi.waitFor(() => expect(_internals.state.baselinedScripthashes.has(scripthash2)).toBe(true));
		expect(notifyMock).not.toHaveBeenCalled();

		const row = db
			.prepare('SELECT confirmed FROM notified_txids WHERE wallet_id = ? AND txid = ?')
			.get(walletId, preexistingTxid) as { confirmed: number } | undefined;
		expect(row?.confirmed).toBe(1);
	});

	it('quarantines an address whose baseline fetch fails, so a later retry records its history silently instead of flooding it out as new', async () => {
		const xpub2 = parseXpub(XPUB);
		const derived3 = deriveAddress(xpub2, 0, 36); // also past WATCH_WINDOW
		const address3 = derived3.address;
		const scripthash3 = addressToScripthash(address3);

		_internals.state.byScripthash.set(scripthash3, {
			kind: 'wallet',
			walletId,
			userId,
			address: address3
		});
		expect(_internals.state.baselinedScripthashes.has(scripthash3)).toBe(false);

		// Simulate the Electrum drop (cairn-u7bw): the FIRST history fetch for
		// this address fails mid-baseline.
		pool.getHistory.mockImplementationOnce(async () => {
			throw new Error('connection reset');
		});

		notifyMock.mockClear();
		pool.emit('scripthash', scripthash3, 'status-drop-1');

		// The failed baseline must NOT mark the address baselined, and must NOT
		// notify for whatever history it couldn't safely diff.
		await vi.waitFor(() => expect(pool.getHistory).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(_internals.state.baselinedScripthashes.has(scripthash3)).toBe(false);
		expect(notifyMock).not.toHaveBeenCalled();

		// A REAL pre-existing txid for this address, only now visible to the retry.
		const staleTxid = '8'.repeat(64);
		historyByScripthash.set(scripthash3, [{ tx_hash: staleTxid, height: 90 }]);

		// The retry (this time getHistory succeeds) must record it as baselined
		// history — NOT flood it out as a brand-new "payment received".
		pool.emit('scripthash', scripthash3, 'status-drop-retry');

		await vi.waitFor(() => expect(_internals.state.baselinedScripthashes.has(scripthash3)).toBe(true));
		expect(notifyMock).not.toHaveBeenCalled();
		const row = db
			.prepare('SELECT confirmed FROM notified_txids WHERE wallet_id = ? AND txid = ?')
			.get(walletId, staleTxid) as { confirmed: number } | undefined;
		expect(row?.confirmed).toBe(1);
	});
});
