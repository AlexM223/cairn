// Block lifecycle wiring (index.ts): onBlockAccepted advances the finder's
// receive cursor exactly once, records a mining_blocks row, and notifies the
// finder + admins; onBlockRejected records a 'rejected:<reason>' row; the
// best-share milestone notifies only on a ≥2× new all-time best, throttled to
// once per user per day. notify() and nextReceiveAddress are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const notifyMock = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../notifications', () => ({ notify: notifyMock.notify }));

const advanceMock = vi.hoisted(() => ({
	next: vi.fn(async () => ({ address: 'bc1qnext', path: '0/6', index: 6 }))
}));
vi.mock('../wallets', async (orig) => {
	const actual = await orig<typeof import('../wallets')>();
	return { ...actual, nextReceiveAddress: advanceMock.next };
});

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import {
	handleBlockAccepted,
	handleBlockRejected,
	maybeBestShareNotify,
	__resetMiningEngineForTests
} from './index';
import type { SolveEvent, ShareEvent } from './types';

function wipe(): void {
	db.exec(
		`DELETE FROM mining_blocks; DELETE FROM mining_stats; DELETE FROM mining_workers;
		 DELETE FROM mining_prefs; DELETE FROM wallets; DELETE FROM events;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

let uid: number;
let wid: number;

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

function solve(overrides: Partial<SolveEvent> = {}): SolveEvent {
	return {
		jobId: 'job1',
		extranonce1Hex: '00',
		extranonce2Hex: '0000',
		ntimeHex: '00000000',
		nonceHex: 'deadbeef',
		hashDisplay: 'a'.repeat(64),
		height: 840000,
		userId: uid,
		miningId: 'hw_test',
		worker: 'bitaxe',
		walletId: wid,
		address: 'bc1qpayout',
		payoutScriptHex: '0014' + '11'.repeat(20),
		coinbaseValueSats: 312500000n,
		...overrides
	};
}

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	__resetMiningEngineForTests();
	notifyMock.notify.mockClear();
	advanceMock.next.mockClear();
	uid = await makeUser('finder@example.com');
	wid = makeWallet(uid, 'xpubFINDER');
});

describe('onBlockAccepted', () => {
	it('advances the finder receive cursor exactly once', async () => {
		await handleBlockAccepted(solve(), 'b'.repeat(64), 'c'.repeat(64));
		expect(advanceMock.next).toHaveBeenCalledTimes(1);
		expect(advanceMock.next).toHaveBeenCalledWith(uid, wid);
	});

	it('records an accepted mining_blocks row', async () => {
		const blockHash = 'b'.repeat(64);
		await handleBlockAccepted(solve(), blockHash, 'c'.repeat(64));
		const row = db.prepare('SELECT * FROM mining_blocks WHERE block_hash = ?').get(blockHash) as {
			height: number;
			submit_result: string;
			user_id: number;
			wallet_id: number;
			coinbase_value_sats: string;
			coinbase_txid: string;
		};
		expect(row.submit_result).toBe('accepted');
		expect(row.height).toBe(840000);
		expect(row.user_id).toBe(uid);
		expect(row.wallet_id).toBe(wid);
		expect(row.coinbase_value_sats).toBe('312500000');
		expect(row.coinbase_txid).toBe('c'.repeat(64));
	});

	it('notifies the finder (success → /mining) and admins (info → /admin/mining)', async () => {
		await handleBlockAccepted(solve(), 'b'.repeat(64), 'c'.repeat(64));
		const calls = notifyMock.notify.mock.calls.map((c) => c[0]);
		const finder = calls.find((p) => p.userId === uid);
		const admin = calls.find((p) => p.userId === null);
		expect(finder).toBeTruthy();
		expect(finder.type).toBe('mining_block_found');
		expect(finder.level).toBe('success');
		expect(finder.link).toBe('/mining');
		expect(admin).toBeTruthy();
		expect(admin.level).toBe('info');
		expect(admin.link).toBe('/admin/mining');
	});
});

describe('onBlockRejected', () => {
	it('records a rejected row with the reason, without colliding block_hash', () => {
		handleBlockRejected(solve(), 'high-hash');
		const row = db.prepare("SELECT * FROM mining_blocks WHERE submit_result LIKE 'rejected%'").get() as {
			submit_result: string;
			block_hash: string;
		};
		expect(row.submit_result).toBe('rejected:high-hash');
		expect(row.block_hash.startsWith('rejected:')).toBe(true);
	});
});

describe('best-share milestone', () => {
	function share(difficulty: number): ShareEvent {
		return { userId: uid, miningId: 'hw_test', worker: 'bitaxe', difficulty, timestampMs: Date.now() };
	}

	it('notifies on a ≥2× new all-time best, then throttles for the day', () => {
		// Seed a stored best of 100.
		db.prepare(
			`INSERT INTO mining_workers (user_id, worker_name, best_share_diff) VALUES (?, 'bitaxe', 100)`
		).run(uid);
		__resetMiningEngineForTests(); // clear the cached baseline so it re-reads the DB

		maybeBestShareNotify(share(250)); // 250 ≥ 2×100 and a new best → notify
		expect(notifyMock.notify).toHaveBeenCalledTimes(1);
		expect(notifyMock.notify.mock.calls[0][0].type).toBe('mining_best_share');

		notifyMock.notify.mockClear();
		maybeBestShareNotify(share(600)); // qualifies by doubling but throttled same day
		expect(notifyMock.notify).not.toHaveBeenCalled();
	});

	it('does not notify on a new best that is under the 2× milestone', () => {
		db.prepare(
			`INSERT INTO mining_workers (user_id, worker_name, best_share_diff) VALUES (?, 'bitaxe', 100)`
		).run(uid);
		__resetMiningEngineForTests();
		maybeBestShareNotify(share(150)); // new best, but < 2×100
		expect(notifyMock.notify).not.toHaveBeenCalled();
	});

	it('seeds the baseline silently on the first-ever best (no notification)', () => {
		__resetMiningEngineForTests();
		maybeBestShareNotify(share(500)); // no prior baseline → seed only
		expect(notifyMock.notify).not.toHaveBeenCalled();
	});
});
