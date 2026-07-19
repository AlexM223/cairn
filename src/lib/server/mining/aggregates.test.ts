// In-memory share accounting (aggregates.ts): counters, hashrate estimation,
// bounded rolling windows, and the batched 15s flush into mining_workers +
// mining_stats. No per-share DB writes (cairn-xlrm) — everything accumulates in
// memory and lands in ONE transaction per flush.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Wave 3 (docs/LIVE-UPDATES-DESIGN.md §3.4): flush() publishes live mining
// nudges. Spy on liveHub.publish so the flush tests can assert the scopes.
const publishMock = vi.fn();
vi.mock('../liveHub', () => ({ publish: (...a: unknown[]) => publishMock(...a) }));

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { MiningAggregates } from './aggregates';
import { estimateHashrate } from '$lib/shared/hashrate';
import type { ShareEvent } from './types';

function wipe(): void {
	db.exec(
		`DELETE FROM mining_blocks; DELETE FROM mining_stats; DELETE FROM mining_workers;
		 DELETE FROM mining_prefs; DELETE FROM wallets; DELETE FROM sessions;
		 DELETE FROM users; DELETE FROM settings;`
	);
}

let userId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({ email: 'miner@example.com', password: 'correct horse battery', displayName: 'miner' })
	).id;
});

function share(worker: string, difficulty: number, t = Date.now()): ShareEvent {
	return { userId, miningId: 'hw_test', worker, difficulty, timestampMs: t };
}

describe('share counters', () => {
	it('accumulates accepted shares, sum-difficulty, and best per worker', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('bitaxe', 100));
		agg.recordShare(share('bitaxe', 250));
		agg.recordShare(share('bitaxe', 50));
		const [w] = agg.liveWorkers(userId);
		expect(w.worker).toBe('bitaxe');
		expect(w.sharesAccepted).toBe(3);
		expect(w.sumDifficulty).toBe(400);
		expect(w.bestShareDiff).toBe(250);
		expect(w.currentDiff).toBe(50);
	});

	it('routes rejects: stale → stale counter, others → rejected counter', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('w1', 10));
		agg.recordReject({ userId, worker: 'w1', reason: 'stale' });
		agg.recordReject({ userId, worker: 'w1', reason: 'low_difficulty' });
		agg.recordReject({ userId, worker: 'w1', reason: 'duplicate' });
		const [w] = agg.liveWorkers(userId);
		expect(w.sharesStale).toBe(1);
		expect(w.sharesRejected).toBe(2);
	});

	it('ignores a reject with no user/worker attribution', () => {
		const agg = new MiningAggregates();
		agg.recordReject({ reason: 'unauthorized' });
		expect(agg.liveAllMiners()).toHaveLength(0);
	});
});

describe('hashrate estimation', () => {
	it('estimates each window from the difficulty-weighted shares inside it', () => {
		const agg = new MiningAggregates();
		const now = Date.now();
		for (let i = 0; i < 6; i++) agg.recordShare(share('w', 100, now - i * 1000));
		const [w] = agg.liveWorkers(userId);
		// 600 total difficulty in the last 600s window.
		expect(w.hashrate.now).toBeCloseTo(estimateHashrate(600, 600), 0);
		expect(w.hashrate.now).toBeGreaterThan(0);
	});

	it('excludes shares older than the window', () => {
		const agg = new MiningAggregates();
		const now = Date.now();
		// Shares always arrive in chronological order in production.
		agg.recordShare(share('w', 100, now - 700 * 1000)); // outside the 600s window
		agg.recordShare(share('w', 100, now)); // in the 600s window
		const [w] = agg.liveWorkers(userId);
		// Only the recent share counts toward the "now" (600s) rate.
		expect(w.hashrate.now).toBeCloseTo(estimateHashrate(100, 600), 0);
		// But both count toward the 24h rate.
		expect(w.hashrate.h24).toBeCloseTo(estimateHashrate(200, 86400), 0);
	});
});

describe('bounded memory', () => {
	it('caps a worker rolling window at 5000 entries', () => {
		const agg = new MiningAggregates();
		const now = Date.now();
		for (let i = 0; i < 5200; i++) agg.recordShare(share('fast', 1, now));
		expect(agg.windowSizeForTest(userId, 'fast')).toBe(5000);
		// Counters are unbounded (cheap scalars) even as the window is capped.
		expect(agg.liveWorkers(userId)[0].sharesAccepted).toBe(5200);
	});
});

describe('flush', () => {
	it('upserts a mining_workers row with cumulative counters', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('w1', 100));
		agg.recordShare(share('w1', 200));
		agg.recordReject({ userId, worker: 'w1', reason: 'stale' });
		agg.flush();
		const row = db
			.prepare('SELECT * FROM mining_workers WHERE user_id = ? AND worker_name = ?')
			.get(userId, 'w1') as {
			shares_accepted: number;
			shares_stale: number;
			sum_weight: string;
			best_share_diff: number;
		};
		expect(row.shares_accepted).toBe(2);
		expect(row.shares_stale).toBe(1);
		expect(Number(row.sum_weight)).toBe(300);
		expect(row.best_share_diff).toBe(200);
	});

	it('accumulates across flushes via deltas (no double counting, MAX best)', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('w1', 100));
		agg.flush();
		agg.recordShare(share('w1', 500));
		agg.flush();
		const row = db
			.prepare('SELECT shares_accepted, best_share_diff FROM mining_workers WHERE user_id = ? AND worker_name = ?')
			.get(userId, 'w1') as { shares_accepted: number; best_share_diff: number };
		expect(row.shares_accepted).toBe(2);
		expect(row.best_share_diff).toBe(500);
	});

	it('writes closed 1-minute buckets (per-worker + one pool row) to mining_stats', () => {
		const agg = new MiningAggregates();
		// Two workers in a minute that has fully elapsed.
		const bucketT = Date.now() - 120_000; // 2 minutes ago
		agg.recordShare(share('a', 100, bucketT));
		agg.recordShare(share('b', 300, bucketT));
		agg.flush(Date.now());
		const perWorker = db
			.prepare('SELECT * FROM mining_stats WHERE user_id IS NOT NULL')
			.all() as { worker_name: string; shares: number; sum_weight: string }[];
		expect(perWorker).toHaveLength(2);
		const pool = db
			.prepare('SELECT * FROM mining_stats WHERE user_id IS NULL')
			.all() as { shares: number; sum_weight: string }[];
		expect(pool).toHaveLength(1);
		expect(pool[0].shares).toBe(2);
		expect(Number(pool[0].sum_weight)).toBe(400);
	});

	it('does NOT write a bucket whose minute has not yet elapsed', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('a', 100, Date.now())); // current, open minute
		agg.flush(Date.now());
		expect(db.prepare('SELECT COUNT(*) AS n FROM mining_stats').get()).toEqual({ n: 0 });
		// Still buffered in memory as an open bucket.
		expect(agg.openBucketCountForTest()).toBe(1);
	});
});

describe('flush live nudges (Wave 3, §3.4)', () => {
	it('nudges each changed user + a broadcast-admin pool frame after a successful flush', () => {
		publishMock.mockClear();
		const agg = new MiningAggregates();
		agg.recordShare(share('bitaxe', 100));
		agg.flush();

		const mining = publishMock.mock.calls.filter((c) => c[0] === 'mining');
		expect(mining.length).toBe(1);
		expect(mining[0][1]).toEqual({ userId }); // user-scoped to the miner
		expect(mining[0][2]).toEqual({}); // nudge-only

		const pool = publishMock.mock.calls.filter((c) => c[0] === 'mining:pool');
		expect(pool.length).toBe(1);
		// Broadcast scope since cairn-et38g: the pool nudge is data-free and every
		// signed-in client may hear it; the data endpoints stay gated server-side.
		expect(pool[0][1]).toEqual({ broadcast: true });
		expect(pool[0][2]).toEqual({});
	});

	it('emits no nudge when a flush had no share activity', () => {
		const agg = new MiningAggregates();
		agg.flush(); // nothing recorded this pass
		publishMock.mockClear();
		agg.flush();
		expect(publishMock).not.toHaveBeenCalled();
	});

	it('does not re-nudge an idle worker on a subsequent no-activity flush', () => {
		const agg = new MiningAggregates();
		agg.recordShare(share('w', 50));
		agg.flush(); // real delta → nudges
		publishMock.mockClear();
		agg.flush(); // no new shares → no delta → no nudge
		expect(publishMock.mock.calls.filter((c) => c[0] === 'mining').length).toBe(0);
		expect(publishMock.mock.calls.filter((c) => c[0] === 'mining:pool').length).toBe(0);
	});
});
