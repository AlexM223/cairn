// Write-pressure burst — correctness under many rapid interleaved writes across
// three hot tables (events, address_labels, notification_queue). This is a
// CORRECTNESS test, not a benchmark: it asserts exact final row counts and a
// clean PRAGMA integrity_check after the burst, with a generous wall-time budget
// only so a pathological regression (e.g. an accidental O(n^2) prune) trips CI.
// (test/qa-wave-2026-07-12, workstream-d; relates to cairn-9q33.)
//
// recordActivity is the real service (INSERT + prune, fully synchronous → atomic
// per call). address_labels and notification_queue are exercised via direct
// INSERTs at the same statements the services use, keeping the focus on DB write
// throughput/integrity rather than the access-gate scaffolding around them.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { recordActivity, EVENTS_PER_BUCKET } from './activity';

function wipe(): void {
	db.exec(
		`DELETE FROM notification_queue; DELETE FROM address_labels; DELETE FROM events;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function integrityOk(): boolean {
	const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
	return rows.length === 1 && rows[0].integrity_check === 'ok';
}

const insertLabel = () =>
	db.prepare(
		`INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES (?, ?, ?, ?)
		 ON CONFLICT (wallet_kind, wallet_id, address) DO UPDATE SET label = excluded.label`
	);
const insertQueue = () =>
	db.prepare(
		`INSERT INTO notification_queue (user_id, channel, event_type, payload) VALUES (?, ?, ?, ?)`
	);

describe('write-pressure burst across events / address_labels / notification_queue', () => {
	it('round-robin interleave of 3×200 writes: exact counts, integrity ok, bounded time', async () => {
		const user = await registerUser({ email: 'burst@example.com', password: 'correct horse battery', displayName: 'u' });
		const N = 200; // < EVENTS_PER_BUCKET (500), so no event is pruned away
		expect(N).toBeLessThan(EVENTS_PER_BUCKET);

		const labelStmt = insertLabel();
		const queueStmt = insertQueue();

		const start = performance.now();
		for (let i = 0; i < N; i++) {
			// Interleave one write to each table per iteration — the "many small
			// writes hitting different tables back to back" production shape.
			recordActivity({ type: 'tx_received', level: 'info', userId: user.id, message: `evt ${i}`, detail: { i } });
			labelStmt.run('wallet', 1, `addr-${i}`, `label ${i}`); // distinct address → new row each time
			queueStmt.run(user.id, 'email', 'tx_received', JSON.stringify({ i }));
		}
		const elapsedMs = performance.now() - start;

		// Exact counts — nothing lost, nothing duplicated.
		expect((db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get(user.id) as { n: number }).n).toBe(N);
		expect((db.prepare('SELECT COUNT(*) AS n FROM address_labels').get() as { n: number }).n).toBe(N);
		expect((db.prepare('SELECT COUNT(*) AS n FROM notification_queue WHERE user_id = ?').get(user.id) as { n: number }).n).toBe(N);
		expect(integrityOk()).toBe(true);
		// Generous ceiling: 600 tiny writes should be well under a second; the cap
		// only exists to catch a catastrophic regression, keeping CI fast.
		expect(elapsedMs).toBeLessThan(20_000);
	});

	it('event pruning holds the per-user bucket at the cap under sustained INSERTs', async () => {
		const user = await registerUser({ email: 'prune@example.com', password: 'correct horse battery', displayName: 'u' });
		const OVER = EVENTS_PER_BUCKET + 250;
		for (let i = 0; i < OVER; i++) {
			recordActivity({ type: 'tx_received', level: 'info', userId: user.id, message: `evt ${i}`, detail: { i } });
		}
		// The bucket is pruned to exactly EVENTS_PER_BUCKET newest rows — no
		// unbounded growth, no under-prune, even under a tight write loop.
		const n = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?').get(user.id) as { n: number }).n;
		expect(n).toBe(EVENTS_PER_BUCKET);
		// The survivors are the NEWEST ones (highest ids) — prune kept the right set.
		const oldest = (db.prepare('SELECT MIN(id) AS m FROM events WHERE user_id = ?').get(user.id) as { m: number }).m;
		const firstKeptMessage = (db.prepare('SELECT message FROM events WHERE id = ?').get(oldest) as { message: string }).message;
		expect(firstKeptMessage).toBe(`evt ${OVER - EVENTS_PER_BUCKET}`);
		expect(integrityOk()).toBe(true);
	});

	it('label upserts under pressure converge to last-writer value, one row per key', async () => {
		const labelStmt = insertLabel();
		// Hammer the SAME (kind, wallet, address) key 300 times — every write is an
		// upsert onto one row; the final value must be the last write, count == 1.
		for (let i = 0; i < 300; i++) labelStmt.run('multisig', 7, 'bc1qsame', `v${i}`);
		const rows = db.prepare("SELECT label FROM address_labels WHERE wallet_kind = 'multisig' AND wallet_id = 7 AND address = 'bc1qsame'").all() as { label: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('v299');
		expect(integrityOk()).toBe(true);
	});
});
