// Wave 2 (docs/LIVE-UPDATES-DESIGN.md §3.4): the address watcher publishes a
// user-scoped `wallet` frame next to each tx notification (received / large /
// confirmed / replaced). These tests spy on liveHub.publish and assert the frame
// is emitted on the received and confirmed paths with the correct scope
// ({ userId } = the wallet's owner) and payload shape. Scope *isolation* itself
// is liveHub's own responsibility (liveHub.test.ts §6) — here we only assert the
// watcher hands publish() the right userId, so a frame can never be mis-scoped at
// the source. The harness mirrors addressWatcher.test.ts's proven fakes.

import { describe, it, expect, beforeAll, vi } from 'vitest';
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
		if (!tx) throw new Error('tx not found');
		return tx;
	})
};

vi.mock('./chain/index', () => ({ getChain: () => fakeChain }));

// SPV proof is out of scope here — accept every tx (see addressWatcher.test.ts).
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

vi.mock('./notifications', () => ({ notify: vi.fn() }));

// The unit under test: spy on liveHub.publish.
const publishMock = vi.fn();
vi.mock('./liveHub', () => ({ publish: (...args: unknown[]) => publishMock(...args) }));

import { startAddressWatcher } from './addressWatcher';

// ---- fixture ----------------------------------------------------------------

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

const TXID = 'a'.repeat(64);

let userId: number;
let walletId: number;
let watchedAddress: string;
let watchedScripthash: string;
let watchedScript: string;

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

/** Pull the single `wallet`-topic publish call out of the spy. */
function walletFrames(): { scope: unknown; data: Record<string, unknown> }[] {
	return publishMock.mock.calls
		.filter((c) => c[0] === 'wallet')
		.map((c) => ({ scope: c[1], data: c[2] as Record<string, unknown> }));
}

beforeAll(async () => {
	db.exec(
		'DELETE FROM notified_txids; DELETE FROM notification_preferences; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'live-watcher@example.com',
			password: 'correct horse battery',
			displayName: 'LiveWatcher'
		})
	).id;
	walletId = createWallet(userId, { name: 'Live', xpub: XPUB }).id;

	const derived = deriveAddress(parseXpub(XPUB), 0, 0);
	watchedAddress = derived.address;
	watchedScripthash = addressToScripthash(watchedAddress);
	watchedScript = scriptPubKeyHex(watchedAddress).toLowerCase();

	vi.useFakeTimers();
	startAddressWatcher();
	await vi.advanceTimersByTimeAsync(10_500);
	vi.useRealTimers();
	expect(pool.subscribeScripthash).toHaveBeenCalled();

	// Seed the difficulty-floor cache so spvVerifyConfirmed doesn't cold-defer.
	pool.emit('header', { height: 1, hex: '00'.repeat(80) });
});

// ---- tests ------------------------------------------------------------------

describe('addressWatcher wallet frames (Wave 2, §3.4)', () => {
	it('publishes a user-scoped `received` frame with the wallet identity and amount', async () => {
		publishMock.mockClear();
		txById.set(TXID, {
			...baseTx(TXID),
			vout: [
				{
					address: watchedAddress,
					value: 123_456,
					scriptType: 'v0_p2wpkh',
					scriptPubKey: watchedScript,
					spent: false
				}
			]
		});
		historyByScripthash.set(watchedScripthash, [{ tx_hash: TXID, height: 150 }]);
		pool.emit('scripthash', watchedScripthash, 'status1');

		await vi.waitFor(() => expect(walletFrames().length).toBeGreaterThan(0));

		const received = walletFrames().find((f) => f.data.event === 'received');
		expect(received).toBeDefined();
		// Correct scope — the wallet's owner, so liveHub only fans it to that user.
		expect(received!.scope).toEqual({ userId });
		expect(received!.data).toMatchObject({
			walletKind: 'wallet',
			walletId,
			txid: TXID,
			event: 'received',
			amountSats: 123_456
		});
	});

	it('publishes a `confirmed` frame on the next block for the tracked tx', async () => {
		publishMock.mockClear();
		// The received test above recorded TXID as a 'notified', confirmed=0 row.
		// A new block re-checks it; getTx reports it confirmed (confirmations 51),
		// firing tx_confirmed and its wallet frame.
		pool.emit('header', { height: 151, hex: '00'.repeat(80) });

		await vi.waitFor(() => {
			expect(walletFrames().some((f) => f.data.event === 'confirmed')).toBe(true);
		});

		const confirmed = walletFrames().find((f) => f.data.event === 'confirmed')!;
		expect(confirmed.scope).toEqual({ userId });
		expect(confirmed.data).toMatchObject({
			walletKind: 'wallet',
			walletId,
			txid: TXID,
			event: 'confirmed'
		});
	});
});
