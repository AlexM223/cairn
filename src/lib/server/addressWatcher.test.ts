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
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
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
vi.mock('./bitcoin/spv', () => ({
	verifyTxInclusion: () => ({ ok: true })
}));

const notifyMock = vi.fn();
vi.mock('./notifications', () => ({
	notify: (...args: unknown[]) => notifyMock(...args)
}));

import { startAddressWatcher } from './addressWatcher';

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
	userId = registerUser({
		email: 'watcher@example.com',
		password: 'correct horse battery',
		displayName: 'Watcher'
	}).id;
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
