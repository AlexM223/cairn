// Pins the retention-sweep dispatcher contract (cairn-zui7.1): every registered
// step runs, in order, and one step throwing or rejecting is contained — it is
// reported failed but never prevents the remaining steps from running. Below
// that, each registered purge step (cairn-zui7.2–4) gets its own suite: old and
// orphaned rows go, everything recent or live is never touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getBalanceSeries } from './portfolio';
import {
	runRetentionSweep,
	purgeBalanceSnapshots,
	purgeNotificationQueue,
	purgeExpiredAuthRows,
	purgeStaleKnownDevices,
	type RetentionStep
} from './dataRetention';

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

describe('runRetentionSweep', () => {
	it('runs every step in registration order', async () => {
		const order: string[] = [];
		const steps: RetentionStep[] = ['a', 'b', 'c'].map((name) => ({
			name,
			run: () => {
				order.push(name);
			}
		}));

		const results = await runRetentionSweep(steps);
		expect(order).toEqual(['a', 'b', 'c']);
		expect(results).toEqual([
			{ name: 'a', ok: true },
			{ name: 'b', ok: true },
			{ name: 'c', ok: true }
		]);
	});

	it('a throwing step is contained — later steps still run', async () => {
		const after = vi.fn();
		const results = await runRetentionSweep([
			{
				name: 'boom',
				run: () => {
					throw new Error('purge failed');
				}
			},
			{ name: 'after', run: after }
		]);

		expect(after).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			{ name: 'boom', ok: false },
			{ name: 'after', ok: true }
		]);
	});

	it('a rejecting async step is contained too', async () => {
		const after = vi.fn(async () => {});
		const results = await runRetentionSweep([
			{ name: 'reject', run: async () => Promise.reject(new Error('nope')) },
			{ name: 'after', run: after }
		]);

		expect(after).toHaveBeenCalledTimes(1);
		expect(results.map((r) => r.ok)).toEqual([false, true]);
	});

	it('an empty step list is a no-op', async () => {
		expect(await runRetentionSweep([])).toEqual([]);
	});
});

let userId: number;
let walletId: number;

function wipeData(): void {
	db.exec(
		`DELETE FROM balance_snapshots; DELETE FROM notification_queue;
		 DELETE FROM recovery_grants; DELETE FROM wallets; DELETE FROM multisigs;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

async function seedUserAndWallet(): Promise<void> {
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;
	walletId = Number(
		db
			.prepare(
				"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-test', 'p2wpkh')"
			)
			.run(userId).lastInsertRowid
	);
}

function snapshot(takenAt: string, opts: { wid?: number; kind?: string; sats?: number } = {}): number {
	return Number(
		db
			.prepare(
				'INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, ?, ?, ?, ?)'
			)
			.run(userId, opts.kind ?? 'wallet', opts.wid ?? walletId, takenAt, opts.sats ?? 1000)
			.lastInsertRowid
	);
}

function snapshotCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number }).n;
}

describe('purgeBalanceSnapshots (cairn-zui7.2)', () => {
	beforeEach(async () => {
		wipeData();
		await seedUserAndWallet();
	});

	it('keeps recent rows hourly, downsamples old rows to one per wallet per day', () => {
		// Recent: three hourly ticks inside the 30-day window — all survive.
		const recent = [snapshot(isoDaysAgo(1)), snapshot(isoDaysAgo(1.04)), snapshot(isoDaysAgo(1.08))];
		// Old: three ticks on the SAME day ~60 days ago — collapse to the first.
		const dayBase = Date.now() - 60 * 24 * 60 * 60_000;
		const sameDay = new Date(dayBase);
		sameDay.setUTCHours(3, 0, 0, 0);
		const oldFirst = snapshot(sameDay.toISOString());
		sameDay.setUTCHours(9);
		const oldSecond = snapshot(sameDay.toISOString());
		sameDay.setUTCHours(20);
		const oldThird = snapshot(sameDay.toISOString());

		purgeBalanceSnapshots();

		const ids = new Set(
			(db.prepare('SELECT id FROM balance_snapshots').all() as { id: number }[]).map((r) => r.id)
		);
		for (const id of recent) expect(ids.has(id)).toBe(true);
		expect(ids.has(oldFirst)).toBe(true);
		expect(ids.has(oldSecond)).toBe(false);
		expect(ids.has(oldThird)).toBe(false);

		// The balance-over-time series still renders from what's left.
		const series = getBalanceSeries(userId);
		expect(series.length).toBe(4);
		expect(series.every((p) => p.sats === 1000)).toBe(true);
	});

	it('hard-deletes rows older than ~13 months', () => {
		snapshot(isoDaysAgo(420));
		snapshot(isoDaysAgo(1));
		purgeBalanceSnapshots();
		expect(snapshotCount()).toBe(1);
	});

	it('drops orphaned rows for deleted wallets/multisigs at any age', () => {
		snapshot(isoDaysAgo(1), { wid: 99999 }); // wallet no longer exists
		snapshot(isoDaysAgo(1), { wid: 99999, kind: 'multisig' });
		const kept = snapshot(isoDaysAgo(1)); // live wallet — stays

		purgeBalanceSnapshots();

		const rows = db.prepare('SELECT id FROM balance_snapshots').all() as { id: number }[];
		expect(rows.map((r) => r.id)).toEqual([kept]);
	});
});

describe('purgeNotificationQueue (cairn-zui7.3)', () => {
	beforeEach(async () => {
		wipeData();
		await seedUserAndWallet();
	});

	function queueRow(status: string, ageDays: number): number {
		const ts = isoDaysAgo(ageDays);
		return Number(
			db
				.prepare(
					`INSERT INTO notification_queue
					   (user_id, channel, event_type, payload, status, next_attempt_at, created_at, sent_at)
					 VALUES (?, 'email', 'tx_received', '{}', ?, ?, ?, ?)`
				)
				.run(userId, status, ts, ts, status === 'sent' ? ts : null).lastInsertRowid
		);
	}

	it('removes only sent/dead rows older than 30 days; in-flight rows are never touched', () => {
		const oldSent = queueRow('sent', 45);
		const oldDead = queueRow('dead', 45);
		const newSent = queueRow('sent', 5);
		const newDead = queueRow('dead', 5);
		const oldPending = queueRow('pending', 45); // in-flight, however old
		const oldFailed = queueRow('failed', 45); // awaiting retry

		purgeNotificationQueue();

		const ids = new Set(
			(db.prepare('SELECT id FROM notification_queue').all() as { id: number }[]).map((r) => r.id)
		);
		expect(ids.has(oldSent)).toBe(false);
		expect(ids.has(oldDead)).toBe(false);
		for (const id of [newSent, newDead, oldPending, oldFailed]) expect(ids.has(id)).toBe(true);
	});
});

describe('purgeStaleKnownDevices (cairn-zui7.5)', () => {
	beforeEach(async () => {
		wipeData();
		await seedUserAndWallet();
		db.exec('DELETE FROM known_devices');
	});

	it('removes devices last seen over 12 months ago, keeps recent ones', () => {
		const insert = db.prepare(
			'INSERT INTO known_devices (user_id, fingerprint, user_agent, last_seen) VALUES (?, ?, ?, ?)'
		);
		insert.run(userId, 'fp-stale', 'OldBrowser/1.0', isoDaysAgo(400));
		insert.run(userId, 'fp-recent', 'Browser/2.0', isoDaysAgo(30));

		purgeStaleKnownDevices();

		const rows = db.prepare('SELECT fingerprint FROM known_devices').all() as {
			fingerprint: string;
		}[];
		expect(rows.map((r) => r.fingerprint)).toEqual(['fp-recent']);
	});
});

describe('purgeExpiredAuthRows (cairn-zui7.4)', () => {
	beforeEach(async () => {
		wipeData();
		await seedUserAndWallet();
	});

	function session(expiresAt: string, tokenHash: string): number {
		return Number(
			db
				.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
				.run(tokenHash, userId, expiresAt).lastInsertRowid
		);
	}

	function grant(expiresAt: string, tokenHash: string): number {
		return Number(
			db
				.prepare('INSERT INTO recovery_grants (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
				.run(tokenHash, userId, expiresAt).lastInsertRowid
		);
	}

	it('sweeps expired sessions and recovery grants; live rows are never touched', () => {
		const inAnHour = new Date(Date.now() + 60 * 60_000).toISOString();
		const expiredSession = session(isoDaysAgo(2), 'hash-expired');
		const liveSession = session(inAnHour, 'hash-live');
		const expiredGrant = grant(isoDaysAgo(2), 'grant-expired');
		const liveGrant = grant(inAnHour, 'grant-live');

		purgeExpiredAuthRows();

		const sessionIds = new Set(
			(db.prepare('SELECT id FROM sessions').all() as { id: number }[]).map((r) => r.id)
		);
		const grantIds = new Set(
			(db.prepare('SELECT id FROM recovery_grants').all() as { id: number }[]).map((r) => r.id)
		);
		expect(sessionIds.has(expiredSession)).toBe(false);
		expect(sessionIds.has(liveSession)).toBe(true);
		expect(grantIds.has(expiredGrant)).toBe(false);
		expect(grantIds.has(liveGrant)).toBe(true);
	});
});
