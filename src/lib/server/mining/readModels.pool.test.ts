// Backfilled regression tests for three shipped v0.2.42 pool fixes (tests
// only — the fixes themselves shipped in c3d9458/c9c4cf1 and are already
// closed as beads). Sibling to readModels.test.ts (same fixture style) so
// the chain mock here can vary getNetworkHashPs per-test via vi.hoisted
// state, which the original file's fixed `core: null` mock can't do.
//
//   - cairn-r1hca: explorer pool-attribution — getPoolBlockAttribution +
//     listPoolFoundBlockHashes.
//   - cairn-et38g + cairn-20k25: getPublicPoolView's shape/admin-exclusion
//     contract, and the networkDifficulty derivation shared by
//     getUserMiningView/getPublicPoolView.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const chainState = vi.hoisted(() => ({ networkHashps: null as number | null }));

vi.mock('../chain', () => ({
	getChain: () => ({
		core:
			chainState.networkHashps === null
				? null
				: { getNetworkHashPs: async () => chainState.networkHashps },
		coreConfigured: chainState.networkHashps !== null,
		getTip: async () => ({ height: 840100, hash: 'h'.repeat(64) })
	})
}));
vi.mock('../wallets', async (orig) => {
	const actual = await orig<typeof import('../wallets')>();
	return {
		...actual,
		peekReceiveAddress: vi.fn(async () => ({ address: 'bc1qview', path: '0/0', index: 0 }))
	};
});

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { getMiningAggregates, __resetMiningEngineForTests } from './index';
import {
	getUserMiningView,
	getAdminMiningView,
	getPublicPoolView,
	getPoolBlockAttribution,
	listPoolFoundBlockHashes
} from './readModels';

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
	return (await registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] }))
		.id;
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

/** submitResult defaults 'accepted'; pass e.g. 'rejected:stale' to simulate a
 *  reorged-out / bad submit that must NOT count as a pool-found block. */
function recordBlock(
	userId: number | null,
	walletId: number | null,
	height: number,
	sats: string,
	blockHash: string,
	submitResult = 'accepted'
): void {
	db.prepare(
		`INSERT INTO mining_blocks
		   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
		    payout_address, coinbase_value_sats, submit_result)
		 VALUES (?, ?, ?, ?, 'w', ?, 'bc1qx', ?, ?)`
	).run(height, blockHash, `txid${height}`, userId, walletId, sats, submitResult);
}

/** Seed a durable (DB-mirrored) best-share row directly, as aggregates.flush
 *  would eventually write — used to test the leaderboard/best-share reads
 *  that fall back to the DB mirror when nothing is live this session. */
function seedWorkerBest(userId: number, worker: string, best: number): void {
	db.prepare(
		`INSERT INTO mining_workers (user_id, worker_name, best_share_diff) VALUES (?, ?, ?)`
	).run(userId, worker, best);
}

beforeEach(async () => {
	wipe();
	chainState.networkHashps = null;
	setSetting('registration_mode', 'open');
	__resetMiningEngineForTests();
	alice = await makeUser('alice@example.com');
	bob = await makeUser('bob@example.com');
	aliceWallet = makeWallet(alice, 'xpubALICE');
	makeWallet(bob, 'xpubBOB');
});

// ------------------------------------------------------- cairn-r1hca

describe('getPoolBlockAttribution (cairn-r1hca)', () => {
	it('attributes an accepted block to its finder, exposing walletId only to them', () => {
		recordBlock(alice, aliceWallet, 840000, '312500000', 'hashFOUND');

		const asFinder = getPoolBlockAttribution('hashFOUND', alice);
		expect(asFinder).not.toBeNull();
		expect(asFinder!.finderName).toBe('alice');
		expect(asFinder!.rewardSats).toBe(312500000);
		expect(asFinder!.isYou).toBe(true);
		expect(asFinder!.walletId).toBe(aliceWallet);

		const asOther = getPoolBlockAttribution('hashFOUND', bob);
		expect(asOther).not.toBeNull();
		expect(asOther!.finderName).toBe('alice');
		expect(asOther!.isYou).toBe(false);
		expect(asOther!.walletId).toBeNull();

		// Anonymous / logged-out viewer: still sees the finder, never a wallet.
		const asAnon = getPoolBlockAttribution('hashFOUND', null);
		expect(asAnon!.isYou).toBe(false);
		expect(asAnon!.walletId).toBeNull();
	});

	it('returns null for a block hash the pool never found', () => {
		recordBlock(alice, aliceWallet, 840000, '312500000', 'hashFOUND');
		expect(getPoolBlockAttribution('hashNEVERSEEN', alice)).toBeNull();
	});

	it('does not attribute a rejected/orphaned submit — accepted only', () => {
		recordBlock(alice, aliceWallet, 840010, '312500000', 'hashREJECTED', 'rejected:stale');
		expect(getPoolBlockAttribution('hashREJECTED', alice)).toBeNull();
	});
});

describe('listPoolFoundBlockHashes (cairn-r1hca)', () => {
	it('returns accepted block hashes newest-first, excluding rejected submits', () => {
		recordBlock(alice, aliceWallet, 840000, '312500000', 'hashA');
		recordBlock(bob, null, 840005, '312500000', 'hashB');
		recordBlock(alice, aliceWallet, 840010, '312500000', 'hashREJ', 'rejected:stale');

		const hashes = listPoolFoundBlockHashes();
		expect(hashes).toEqual(['hashB', 'hashA']);
		expect(hashes).not.toContain('hashREJ');
	});

	it('returns an empty array when the pool has never found a block', () => {
		expect(listPoolFoundBlockHashes()).toEqual([]);
	});
});

// ------------------------------------------------- cairn-et38g / cairn-20k25

describe('getPublicPoolView (cairn-et38g)', () => {
	it('produces the documented shape: pool hashrate, series, best share, leaderboard, trophy wall', async () => {
		const agg = getMiningAggregates();
		const now = Date.now();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 500, timestampMs: now });
		recordBlock(alice, aliceWallet, 840000, '312500000', 'hashA');

		const view = await getPublicPoolView(alice);

		expect(view.engine).toHaveProperty('status');
		expect(view.pool).toEqual(
			expect.objectContaining({
				connectedWorkers: expect.any(Number),
				connectedUsers: expect.any(Number),
				hashrateNow: expect.any(Number),
				hashrate24h: expect.any(Number)
			})
		);
		expect(Array.isArray(view.hashrateSeries)).toBe(true);
		expect(view.bestShare).toEqual(
			expect.objectContaining({ difficulty: 500, holderName: 'alice', isYou: true })
		);
		expect(view.leaderboard[0]).toEqual(
			expect.objectContaining({ rank: 1, name: 'alice', isYou: true, bestShareDifficulty: 500 })
		);
		expect(view.blocks.map((b) => b.blockHash)).toContain('hashA');
		expect(view.totalBlocksFound).toBe(1);
	});

	it('never exposes admin-only fields the admin view carries (settings, per-connection difficulty, sharePct)', async () => {
		const agg = getMiningAggregates();
		const now = Date.now();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 100, timestampMs: now });

		const admin = await getAdminMiningView();
		const pub = await getPublicPoolView(alice);

		// The admin view really does carry this admin-only material — otherwise
		// this test would be vacuous.
		expect(admin).toHaveProperty('settings');
		expect(admin.miners[0]).toHaveProperty('difficulty');
		expect(admin).toHaveProperty('userBreakdown');
		expect(admin.userBreakdown[0]).toHaveProperty('sharePct');
		expect(admin.engine).toHaveProperty('fatalErrors');

		// None of it leaks into the public view.
		expect(pub).not.toHaveProperty('settings');
		expect(pub).not.toHaveProperty('userBreakdown');
		expect(pub).not.toHaveProperty('miners');
		expect((pub.engine as Record<string, unknown>)).not.toHaveProperty('fatalErrors');
		expect((pub.engine as Record<string, unknown>)).not.toHaveProperty('coreRpc');
		for (const row of pub.leaderboard) {
			expect(row).not.toHaveProperty('difficulty'); // per-connection difficulty
			expect(row).not.toHaveProperty('sharePct');
		}
	});

	it('leaderboard/best-share reflect the durable (DB-mirrored) best share when nothing is live this session', async () => {
		seedWorkerBest(alice, 'alice-rig', 4096);
		seedWorkerBest(bob, 'bob-rig', 8192);

		const view = await getPublicPoolView(alice);
		expect(view.bestShare).toEqual(
			expect.objectContaining({ difficulty: 8192, holderName: 'bob', isYou: false })
		);
		const names = view.leaderboard.map((r) => r.name);
		expect(names).toEqual(['bob', 'alice']);
		expect(view.leaderboard[1]).toEqual(
			expect.objectContaining({ name: 'alice', bestShareDifficulty: 4096, isYou: true })
		);
	});

	it('a higher LIVE session best overrides a lower durable DB best for the same user', async () => {
		seedWorkerBest(alice, 'alice-rig', 100);
		const agg = getMiningAggregates();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 999, timestampMs: Date.now() });

		const view = await getPublicPoolView(bob);
		expect(view.bestShare!.difficulty).toBe(999);
		expect(view.bestShare!.holderName).toBe('alice');
	});
});

describe('networkDifficulty derivation (cairn-20k25)', () => {
	it('getUserMiningView.totals.bestShareEver is the max of durable and live-session bests', async () => {
		seedWorkerBest(alice, 'alice-rig', 250);
		const agg = getMiningAggregates();
		agg.recordShare({ userId: alice, miningId: 'hw_a', worker: 'alice-rig', difficulty: 900, timestampMs: Date.now() });

		const view = await getUserMiningView(alice);
		expect(view.totals.bestShareEver).toBe(900);
	});

	it('derives networkDifficulty as networkHashps * 600 / 2^32 on the user view', async () => {
		chainState.networkHashps = 5.2e17; // ~520 PH/s, an arbitrary realistic figure
		const expected = (chainState.networkHashps * 600) / 2 ** 32;

		const view = await getUserMiningView(alice);
		expect(view.networkDifficulty).toBe(expected);
	});

	it('derives the same networkDifficulty formula on the public pool view', async () => {
		chainState.networkHashps = 5.2e17;
		const expected = (chainState.networkHashps * 600) / 2 ** 32;

		const view = await getPublicPoolView(alice);
		expect(view.networkDifficulty).toBe(expected);
	});

	it('is null when the node cannot report a network hashrate (no Core configured)', async () => {
		chainState.networkHashps = null;
		const view = await getUserMiningView(alice);
		expect(view.networkDifficulty).toBeNull();
	});
});
