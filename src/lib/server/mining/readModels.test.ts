// Read models (readModels.ts): the exact user/admin view contracts, and the
// hard requirement that getUserMiningView is STRICTLY scoped — user A's view
// never carries user B's workers or earnings.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// No chain backend in tests: fixed tip, no Core (so odds resolve to null).
vi.mock('../chain', () => ({
	getChain: () => ({
		core: null,
		coreConfigured: false,
		getTip: async () => ({ height: 840100, hash: 'h'.repeat(64) })
	})
}));
vi.mock('../wallets', async (orig) => {
	const actual = await orig<typeof import('../wallets')>();
	return { ...actual, peekReceiveAddress: vi.fn(async () => ({ address: 'bc1qview', path: '0/0', index: 0 })) };
});

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { ensureMiningPrefs, setPayoutWallet, setUserMiningEnabled } from './prefs';
import { getMiningAggregates, __resetMiningEngineForTests } from './index';
import { getUserMiningView, getAdminMiningView } from './readModels';

function wipe(): void {
	db.exec(
		`DELETE FROM mining_blocks; DELETE FROM mining_stats; DELETE FROM mining_workers;
		 DELETE FROM mining_prefs; DELETE FROM wallets; DELETE FROM events;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

let alice: number;
let bob: number;
let aliceWallet: number;

async function makeUser(email: string): Promise<number> {
	return (await registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] })).id;
}

function makeWallet(userId: number, xpub: string): number {
	return Number(
		db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, receive_cursor)
				 VALUES (?, ?, 'xpub', ?, 'p2wpkh', 0)`
			)
			.run(userId, 'payout', xpub).lastInsertRowid
	);
}

function recordBlock(userId: number, walletId: number, height: number, sats: string): void {
	db.prepare(
		`INSERT INTO mining_blocks
		   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
		    payout_address, coinbase_value_sats, submit_result)
		 VALUES (?, ?, ?, ?, 'w', ?, 'bc1qx', ?, 'accepted')`
	).run(height, `hash${height}`, `txid${height}`, userId, walletId, sats);
}

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	__resetMiningEngineForTests();
	alice = await makeUser('alice@example.com');
	bob = await makeUser('bob@example.com');
	aliceWallet = makeWallet(alice, 'xpubALICE');
	makeWallet(bob, 'xpubBOB');
});

describe('getUserMiningView isolation', () => {
	it('never leaks another user’s workers or earnings', async () => {
		const agg = getMiningAggregates();
		const now = Date.now();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 100, timestampMs: now });
		agg.recordShare({ userId: bob, miningId: 'hw_b', worker: 'bob-rig', difficulty: 999, timestampMs: now });
		recordBlock(alice, aliceWallet, 840000, '312500000');
		recordBlock(bob, makeWallet(bob, 'xpubBOB2'), 840050, '625000000');

		const view = await getUserMiningView(alice);
		expect(view.workers.map((w) => w.name)).toEqual(['alice-rig']);
		expect(view.workers.some((w) => w.name === 'bob-rig')).toBe(false);
		expect(view.earnings.blocksFound.map((b) => b.height)).toEqual([840000]);
		// Alice's one block is mature at tip 840100 (101 confs).
		expect(view.earnings.totalMaturedSats).toBe(312500000);
	});

	it('produces the full user contract shape', async () => {
		ensureMiningPrefs(alice);
		setPayoutWallet(alice, aliceWallet);
		setUserMiningEnabled(alice, true);
		const view = await getUserMiningView(alice);

		expect(view.engine).toHaveProperty('status');
		expect(view.engine).toHaveProperty('stratumPort');
		expect(view.engine).toHaveProperty('bind');
		expect(view.connection).not.toBeNull();
		expect(view.connection!.miningId).toMatch(/^hw_[0-9a-f]{8}$/);
		expect(view.connection!.workerFormat).toContain('.<workerName>');
		expect(view.connection!.password).toBe('x');
		expect(view.payout).toEqual({ walletId: aliceWallet, walletName: 'payout', address: 'bc1qview' });
		expect(view.totals).toHaveProperty('bestShareEver');
		expect(view.odds).toBeNull(); // no Core → no network hashrate
		expect(view.wallets.length).toBeGreaterThan(0);
		expect(view.wallets[0]).toHaveProperty('eligible');
	});
});

describe('getAdminMiningView', () => {
	it('aggregates every user’s miners and blocks pool-wide', async () => {
		const agg = getMiningAggregates();
		const now = Date.now();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 100, timestampMs: now });
		agg.recordShare({ userId: bob, miningId: 'hw_b', worker: 'bob-rig', difficulty: 200, timestampMs: now });
		recordBlock(alice, aliceWallet, 840000, '312500000');

		const view = await getAdminMiningView();
		const workers = view.miners.map((m) => m.worker).sort();
		expect(workers).toEqual(['alice-rig', 'bob-rig']);
		expect(view.userBreakdown.length).toBe(2);
		// sharePct sums to ~100 across users when there is live hashrate.
		const pctSum = view.userBreakdown.reduce((a, u) => a + u.sharePct, 0);
		expect(pctSum).toBeCloseTo(100, 5);
		expect(view.blocks.map((b) => b.height)).toContain(840000);
		expect(view.settings).toHaveProperty('poolTag');
		expect(view.engine).toHaveProperty('coreRpc');
	});
});
