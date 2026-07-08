// Regression test for cairn-20al / cairn-v13r / cairn-j6fv: the address watcher
// must attribute a transaction's outputs to a wallet by scriptPubKey, NOT by
// address string. The chain backend reports addresses in its own network
// encoding (bcrt1…/tb1… on regtest/testnet), which never equals Cairn's
// mainnet-derived address strings — string matching silently zeroes every
// deposit. This exact bug shipped twice (walletScan/multisigScan, then
// addressWatcher eleven hours after the first fix), so this test pins the
// scriptPubKey path down with a vout whose address string deliberately does
// NOT match the watched address.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HDKey } from '@scure/bip32';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet, deleteWallet } from './wallets';
import { createMultisig, deleteMultisig, type NewMultisigKey } from './wallets/multisig';
import { parseXpub, deriveAddress, addressToScripthash, scriptPubKeyHex } from './bitcoin/xpub';
import type { TxDetail } from '$lib/types';

// ---- fakes ------------------------------------------------------------------

// Electrum pool: a real EventEmitter so the watcher's 'scripthash' listener can
// be fired, with per-scripthash canned history.
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
		if (!tx) throw new Error('tx not found');
		return tx;
	})
};

vi.mock('./chain/index', () => ({
	getChain: () => fakeChain
}));

// The SPV inclusion proof is out of scope here (it has its own unit tests);
// forging a PoW-valid header for a fixture is not practical, so accept the tx.
// The header-cache helpers (parseBlockHeader/blockHash/meetsTarget/
// bitsToTarget — cairn-8kbw's difficulty-floor calibration) are stubbed the
// same way: any streamed 'header' event the watcher receives is accepted into
// its cache, so spvVerifyConfirmed never falls into the (correct, but
// out-of-scope-here) cold-cache defer. blockHash is stubbed as identity so a
// cached height's exact-hash check trivially matches whatever fake header hex
// this file uses.
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
vi.mock('./notifications', () => ({
	notify: (...args: unknown[]) => notifyMock(...args)
}));

import { startAddressWatcher, refreshWatches, _internals } from './addressWatcher';

// ---- fixture ----------------------------------------------------------------

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

const TXID_MATCH = 'a'.repeat(64);
const TXID_FOREIGN = 'b'.repeat(64);

let userId: number;
let walletId: number;
let watchedAddress: string; // receive index 0, mainnet encoding
let watchedScripthash: string;
let watchedScript: string; // scriptPubKey hex — network-independent

function baseTx(txid: string): Omit<TxDetail, 'vout'> {
	return {
		txid,
		confirmed: true,
		blockHeight: 150,
		blockHash: 'c'.repeat(64),
		blockTime: 1_700_000_000,
		confirmations: 51,
		size: 200,
		vsize: 110,
		weight: 440,
		fee: 500,
		feeRate: 4.5,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
		vin: []
	};
}

beforeAll(async () => {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM notification_preferences; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'watcher@example.com',
			password: 'correct horse battery',
			displayName: 'Watcher'
		})
	).id;
	walletId = createWallet(userId, { name: 'Watched', xpub: XPUB }).id;

	const derived = deriveAddress(parseXpub(XPUB), 0, 0);
	watchedAddress = derived.address;
	watchedScripthash = addressToScripthash(watchedAddress);
	watchedScript = scriptPubKeyHex(watchedAddress).toLowerCase();

	// Boot the watcher: fast-forward past its 10s startup delay so the initial
	// subscribe + baseline pass (empty history everywhere) completes and change
	// events are armed.
	vi.useFakeTimers();
	startAddressWatcher();
	await vi.advanceTimersByTimeAsync(10_500);
	vi.useRealTimers();
	expect(pool.subscribeScripthash).toHaveBeenCalled();

	// Seed the difficulty-floor cache (cairn-8kbw) with one fake streamed tip so
	// spvVerifyConfirmed's cold-cache defer never fires below — this file's own
	// scope is scriptPubKey attribution, not SPV, which the mock above already
	// short-circuits to always-ok.
	pool.emit('header', { height: 1, hex: '00'.repeat(80) });
});

// ---- tests --------------------------------------------------------------------

describe('addressWatcher tx-amount attribution (cairn-20al / cairn-v13r)', () => {
	it('attributes a deposit via scriptPubKey even when the address STRING does not match', async () => {
		// The backend reports the output under a regtest-style encoding, so naive
		// address-string comparison against the watched (mainnet-derived) address
		// fails — exactly the mismatch that zeroed every deposit in cairn-j6fv.
		const backendEncoding = 'bcrt1qnotthemainnetencoding000000000000000000';
		expect(backendEncoding).not.toBe(watchedAddress);
		txById.set(TXID_MATCH, {
			...baseTx(TXID_MATCH),
			vout: [
				{
					address: backendEncoding,
					value: 123_456,
					scriptType: 'v0_p2wpkh',
					scriptPubKey: watchedScript.toUpperCase(), // case must not matter either
					spent: false
				},
				{
					// Unrelated change output — must not count toward the deposit.
					address: null,
					value: 999_999,
					scriptType: 'v0_p2wpkh',
					scriptPubKey: '0014' + 'ee'.repeat(20),
					spent: false
				}
			]
		});
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID_MATCH, height: 150 }]);
		pool.emit('scripthash', watchedScripthash, 'status1');

		await vi.waitFor(() => expect(notifyMock).toHaveBeenCalled());
		const call = notifyMock.mock.calls[0][0] as {
			type: string;
			title: string;
			userId: number;
			detail: { amountSats?: number; txid: string };
		};
		expect(call.type).toBe('tx_received');
		expect(call.title).toBe('Payment received'); // valued, not the zero-amount fallback
		expect(call.userId).toBe(userId);
		expect(call.detail.txid).toBe(TXID_MATCH);
		// The watched output's value, and ONLY it — the foreign output is excluded.
		expect(call.detail.amountSats).toBe(123_456);

		// Recorded so a re-emit never re-notifies.
		const row = db
			.prepare(
				"SELECT COUNT(*) AS n FROM notified_txids WHERE wallet_kind = 'wallet' AND wallet_id = ? AND txid = ?"
			)
			.get(walletId, TXID_MATCH) as { n: number };
		expect(row.n).toBe(1);
	});

	it('a tx paying only foreign scripts records without a valued payment notification', async () => {
		notifyMock.mockClear();
		txById.set(TXID_FOREIGN, {
			...baseTx(TXID_FOREIGN),
			vout: [
				{
					// Address string EQUAL to the watched address, but a different
					// scriptPubKey: string matching would wrongly count this. The watcher
					// must trust the script, so the deposit values at 0.
					address: watchedAddress,
					value: 55_555,
					scriptType: 'v0_p2wpkh',
					scriptPubKey: '0014' + 'dd'.repeat(20),
					spent: false
				}
			]
		});
		historyByScripthash.set(watchedScripthash, [
			{ tx_hash: TXID_MATCH, height: 150 },
			{ tx_hash: TXID_FOREIGN, height: 151 }
		]);
		pool.emit('scripthash', watchedScripthash, 'status2');

		await vi.waitFor(() => expect(notifyMock).toHaveBeenCalled());
		const call = notifyMock.mock.calls[0][0] as { title: string; detail: { amountSats?: number } };
		// Zero inbound value → the generic activity note, never 'Payment received'.
		expect(call.title).toBe('New wallet activity');
		expect(call.detail.amountSats).toBeUndefined();
	});
});

// ---- cairn-uzgu / cairn-gakd Phase 1: stale-watch cleanup on delete ----------
//
// Pre-fix, refreshWatches() only ever ADDED to state.byScripthash — a deleted
// wallet's ~60 scripthash subscriptions lived forever, kept manufacturing
// orphaned notified_txids rows, and kept firing notifications that deep-link
// to a 404. These tests pin both halves of the fix: the removal path (delete
// drops the watcher's local bookkeeping) and the notify guard (even a
// lingering subscription — e.g. left behind by a delete path that bypasses
// deleteWallet/deleteMultisig, like account deletion's FK cascade — can never
// notify, and self-prunes the moment Electrum reports a change for it).

describe('cairn-uzgu / cairn-gakd Phase 1: stale single-sig watch cleanup on delete', () => {
	it("deleteWallet drops the wallet's scripthashes from watcher state", () => {
		// Sanity: the fixture wallet from the describe block above is still watched.
		expect(_internals.state.byScripthash.has(watchedScripthash)).toBe(true);
		expect(_internals.state.baselinedScripthashes.has(watchedScripthash)).toBe(true);

		expect(deleteWallet(userId, walletId)).toBe(true);

		expect(_internals.state.byScripthash.has(watchedScripthash)).toBe(false);
		expect(_internals.state.baselinedScripthashes.has(watchedScripthash)).toBe(false);
		// None of this wallet's watched addresses (WATCH_WINDOW × 2 chains) survive.
		for (const w of _internals.state.byScripthash.values()) {
			expect(w.kind === 'wallet' && w.walletId === walletId).toBe(false);
		}
	});

	it('handleScripthashChange ignores a lingering subscription for a deleted wallet, and self-prunes it', async () => {
		// Simulate a delete path that bypasses deleteWallet's unwatchWallet call
		// (e.g. account deletion's FK cascade, which never reaches addressWatcher):
		// re-insert the entry directly even though the wallet row is gone
		// (deleted in the previous test).
		_internals.state.byScripthash.set(watchedScripthash, {
			kind: 'wallet',
			walletId,
			userId,
			address: watchedAddress
		});
		_internals.state.baselinedScripthashes.add(watchedScripthash);

		notifyMock.mockClear();
		const ghostTxid = 'e'.repeat(64);
		txById.set(ghostTxid, { ...baseTx(ghostTxid), vout: [] });
		historyByScripthash.set(watchedScripthash, [{ tx_hash: ghostTxid, height: 150 }]);

		pool.emit('scripthash', watchedScripthash, 'status-ghost');

		await vi.waitFor(() =>
			expect(_internals.state.byScripthash.has(watchedScripthash)).toBe(false)
		);
		expect(notifyMock).not.toHaveBeenCalled();

		const row = db
			.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE txid = ?')
			.get(ghostTxid) as { n: number };
		expect(row.n).toBe(0);
	});
});

describe('cairn-uzgu / cairn-gakd Phase 1: stale multisig watch cleanup on delete', () => {
	const BIP48_PATH = "m/48'/0'/0'/2'";

	function fixtureKey(seedByte: number): { xpub: string; fingerprint: string; path: string } {
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
		const account = master.derive(BIP48_PATH);
		return {
			xpub: account.publicExtendedKey,
			fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
			path: BIP48_PATH
		};
	}
	function newMultisigKey(seedByte: number, name: string): NewMultisigKey {
		return { name, category: 'hardware', deviceType: 'trezor', ...fixtureKey(seedByte) };
	}

	let msUserId: number;
	let msId: number;
	let msScripthash = '';
	let msWatched:
		| { kind: 'wallet' | 'multisig'; walletId: number; userId: number; address: string }
		| undefined;

	beforeAll(async () => {
		msUserId = (
			await registerUser({
				email: 'watcher-ms@example.com',
				password: 'correct horse battery',
				displayName: 'WatcherMS'
			})
		).id;
		const ms = createMultisig(msUserId, {
			name: 'Ghost multisig',
			threshold: 2,
			keys: [newMultisigKey(11, 'Key A'), newMultisigKey(12, 'Key B'), newMultisigKey(13, 'Key C')]
		});
		msId = ms.id;

		// The startup pass already ran; pick up this newly created multisig the
		// same way the periodic 5-minute refresh would in production.
		await refreshWatches();

		for (const [sh, w] of _internals.state.byScripthash) {
			if (w.kind === 'multisig' && w.walletId === msId) {
				msScripthash = sh;
				msWatched = w;
				break;
			}
		}
		if (!msScripthash) throw new Error('test setup: multisig scripthash not found after refreshWatches');
	});

	it("refreshWatches subscribed the new multisig, and deleteMultisig drops its scripthashes from watcher state", () => {
		expect(_internals.state.byScripthash.has(msScripthash)).toBe(true);

		expect(deleteMultisig(msUserId, msId)).toBe(true);

		expect(_internals.state.byScripthash.has(msScripthash)).toBe(false);
		for (const w of _internals.state.byScripthash.values()) {
			expect(w.kind === 'multisig' && w.walletId === msId).toBe(false);
		}
	});

	it('handleScripthashChange ignores a lingering subscription for a deleted multisig, and self-prunes it', async () => {
		_internals.state.byScripthash.set(msScripthash, msWatched!);
		_internals.state.baselinedScripthashes.add(msScripthash);

		notifyMock.mockClear();
		const ghostTxid = 'f'.repeat(64);
		txById.set(ghostTxid, { ...baseTx(ghostTxid), vout: [] });
		historyByScripthash.set(msScripthash, [{ tx_hash: ghostTxid, height: 150 }]);

		pool.emit('scripthash', msScripthash, 'status-ghost-ms');

		await vi.waitFor(() => expect(_internals.state.byScripthash.has(msScripthash)).toBe(false));
		expect(notifyMock).not.toHaveBeenCalled();

		const row = db
			.prepare("SELECT COUNT(*) AS n FROM notified_txids WHERE wallet_kind = 'multisig' AND txid = ?")
			.get(ghostTxid) as { n: number };
		expect(row.n).toBe(0);
	});
});

// ---- cairn-mo36: TOCTOU race between existence check and write --------------
//
// handleScripthashChange checks walletStillExists(w) ONCE near the top, then
// crosses several awaits (getHistory/spvVerifyConfirmed/getTx, or
// baselineScripthash's own getHistory on the on-demand path) before it writes
// notified_txids / fires a notification. A synchronous delete
// (deleteWallet/deleteMultisig's unwatch calls, or refreshWatches' periodic
// prune) can land in that window for a handler that already passed the
// earlier checks. These tests force the delete to happen mid-await — inside
// the mocked chain.getTx / chain.electrum.getHistory call — and assert the
// write/notify never happens. They fail if the cairn-mo36 re-checks
// (state.byScripthash.has(scripthash), placed immediately before each write
// with no further await in between) are removed.

describe('cairn-mo36: TOCTOU race between existence check and write', () => {
	it('per-txid history-diff path: wallet deleted during the getTx await records nothing and never notifies', async () => {
		const raceUserId = (
			await registerUser({
				email: 'race-history@example.com',
				password: 'correct horse battery',
				displayName: 'RaceHistory'
			})
		).id;
		const raceXpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(101)).publicExtendedKey;
		const raceWalletId = createWallet(raceUserId, { name: 'Racer A', xpub: raceXpub }).id;
		const raceAddress = deriveAddress(parseXpub(raceXpub), 0, 0).address;
		const raceScripthash = addressToScripthash(raceAddress);

		// Wire the subscription up directly, already baselined, so this test only
		// exercises the history-diff path (not the on-demand baseline path below).
		_internals.state.byScripthash.set(raceScripthash, {
			kind: 'wallet',
			walletId: raceWalletId,
			userId: raceUserId,
			address: raceAddress
		});
		_internals.state.baselinedScripthashes.add(raceScripthash);

		const raceTxid = '3'.repeat(64);
		txById.set(raceTxid, { ...baseTx(raceTxid), vout: [] });
		historyByScripthash.set(raceScripthash, [{ tx_hash: raceTxid, height: 150 }]);

		// The delete lands DURING the chain.getTx await — after
		// handleScripthashChange already passed its top-of-function
		// walletStillExists check.
		fakeChain.getTx.mockImplementationOnce(async (txid: string) => {
			expect(deleteWallet(raceUserId, raceWalletId)).toBe(true);
			const tx = txById.get(txid);
			if (!tx) throw new Error('tx not found');
			return tx;
		});

		notifyMock.mockClear();
		pool.emit('scripthash', raceScripthash, 'status-race-history');

		// vi.waitFor polls on a real timer (a macrotask boundary), so by the time
		// this resolves the entire — purely synchronous — continuation after the
		// getTx await, including the cairn-mo36 recheck and whatever it gates, has
		// already run to completion.
		await vi.waitFor(() => {
			expect(fakeChain.getTx).toHaveBeenCalledWith(raceTxid);
		});

		expect(notifyMock).not.toHaveBeenCalled();
		expect(_internals.state.byScripthash.has(raceScripthash)).toBe(false);
		const row = db
			.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE txid = ?')
			.get(raceTxid) as { n: number };
		expect(row.n).toBe(0);
	});

	it('on-demand baseline path: wallet deleted during the getHistory await inserts nothing', async () => {
		const raceUserId = (
			await registerUser({
				email: 'race-baseline@example.com',
				password: 'correct horse battery',
				displayName: 'RaceBaseline'
			})
		).id;
		const raceXpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(102)).publicExtendedKey;
		const raceWalletId = createWallet(raceUserId, { name: 'Racer B', xpub: raceXpub }).id;
		const raceAddress = deriveAddress(parseXpub(raceXpub), 0, 0).address;
		const raceScripthash = addressToScripthash(raceAddress);

		// Watched but deliberately NOT yet baselined, so the change event takes
		// the on-demand baselineScripthash branch.
		_internals.state.byScripthash.set(raceScripthash, {
			kind: 'wallet',
			walletId: raceWalletId,
			userId: raceUserId,
			address: raceAddress
		});

		const raceTxid = '4'.repeat(64);
		historyByScripthash.set(raceScripthash, [{ tx_hash: raceTxid, height: 150 }]);

		// The delete lands DURING baselineScripthash's chain.electrum.getHistory
		// await.
		pool.getHistory.mockImplementationOnce(async (sh: string) => {
			expect(deleteWallet(raceUserId, raceWalletId)).toBe(true);
			return historyByScripthash.get(sh) ?? [];
		});

		notifyMock.mockClear();
		pool.emit('scripthash', raceScripthash, 'status-race-baseline');

		await vi.waitFor(() => {
			expect(pool.getHistory).toHaveBeenCalledWith(raceScripthash);
		});

		expect(notifyMock).not.toHaveBeenCalled();
		expect(_internals.state.byScripthash.has(raceScripthash)).toBe(false);
		expect(_internals.state.baselinedScripthashes.has(raceScripthash)).toBe(false);
		const row = db
			.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE txid = ?')
			.get(raceTxid) as { n: number };
		expect(row.n).toBe(0);
	});
});
