// Multi-process / multi-handle contention against the shared WAL DB file
// (test/qa-wave-2026-07-12, workstream-b/d; relates to cairn-a857, cairn-9q33).
//
// PRODUCTION REALITY. Cairn opens exactly ONE DatabaseSync handle for the whole
// process (src/lib/server/db.ts line 21). Because node:sqlite is synchronous and
// Node is single-threaded, that one handle can never contend with itself — there
// is only ever one in-flight statement. So SQLITE_BUSY is IMPOSSIBLE in the app
// as shipped. This suite exists to characterize the ONLY way it could appear: a
// SECOND handle on the same file — an Umbrel sidecar, a stray second app
// instance, or a backup tool opening the DB while the app runs — and to prove
// the file survives it intact.
//
// Two shapes:
//   1. A second in-process handle deterministically pins the raw busy behavior:
//      with busy_timeout=0 it throws "database is locked" (SQLITE_BUSY, errcode
//      5) the instant the primary holds the write lock; the app's own handle
//      sets busy_timeout=5000 (db.ts line 26) and would instead wait-and-retry.
//   2. A worker_thread with its OWN handle writes in genuine OS-thread parallel
//      with the main thread. With busy_timeout configured on both, every write
//      succeeds (the timeout absorbs the contention), row counts are exact, and
//      integrity_check is clean — no corruption, no unhandled crash.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { db, DB_PATH } from './db';

const SCRATCH = 'stress_multihandle';
const WORKER = fileURLToPath(new URL('../../../scripts/stress/dbWriterWorker.mjs', import.meta.url));

function integrityOk(handle: { prepare: (s: string) => { all: () => unknown[] } }): boolean {
	const rows = handle.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
	return rows.length === 1 && rows[0].integrity_check === 'ok';
}

beforeAll(() => {
	db.exec(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, n INTEGER NOT NULL)`);
});
afterAll(() => {
	try {
		db.exec(`DROP TABLE IF EXISTS ${SCRATCH}`);
	} catch {
		/* teardown best-effort */
	}
});

describe('second in-process handle: raw busy behavior', () => {
	it('a handle with busy_timeout=0 throws SQLITE_BUSY while the primary holds the write lock', () => {
		db.exec(`DELETE FROM ${SCRATCH}`);
		const second = new DatabaseSync(DB_PATH);
		second.exec('PRAGMA busy_timeout = 0'); // no wait — surface contention immediately
		try {
			// Primary takes and HOLDS the write lock (synchronous — nothing releases
			// it until COMMIT below, so the second handle genuinely collides).
			db.exec('BEGIN IMMEDIATE');
			db.prepare(`INSERT INTO ${SCRATCH} (src, n) VALUES ('primary', 1)`).run();

			let err: { message: string; errcode?: number } | null = null;
			try {
				second.prepare(`INSERT INTO ${SCRATCH} (src, n) VALUES ('second', 1)`).run();
			} catch (e) {
				err = { message: String((e as Error).message), errcode: (e as { errcode?: number }).errcode };
			}
			expect(err).not.toBeNull();
			expect(err!.message).toMatch(/lock|busy/i);
			expect(err!.errcode).toBe(5); // SQLITE_BUSY

			db.exec('COMMIT');
			// After the primary releases, the second handle writes cleanly.
			second.prepare(`INSERT INTO ${SCRATCH} (src, n) VALUES ('second', 2)`).run();
			expect((db.prepare(`SELECT COUNT(*) AS n FROM ${SCRATCH}`).get() as { n: number }).n).toBe(2);
			expect(integrityOk(db)).toBe(true);
		} finally {
			// Never leave a dangling transaction if an assertion above threw.
			try {
				db.exec('COMMIT');
			} catch {
				/* already committed */
			}
			second.close();
		}
	});
});

describe('worker_thread with its own handle: genuine parallel writes', () => {
	it('busy_timeout absorbs contention — all writes land, counts exact, integrity ok', async () => {
		db.exec(`DELETE FROM ${SCRATCH}`);
		const N = 250;

		// Kick the worker off FIRST so its writes overlap the main-thread loop.
		const workerDone = new Promise<{ written: number; errors: string[] }>((resolve, reject) => {
			const w = new Worker(WORKER, {
				workerData: { dbPath: DB_PATH, table: SCRATCH, src: 'worker', count: N, busyTimeout: 5000 }
			});
			w.on('message', (m) => {
				w.terminate().finally(() => resolve(m as { written: number; errors: string[] }));
			});
			w.on('error', reject);
		});

		// Main thread hammers the same table in parallel. The app handle already
		// has busy_timeout=5000, so these coexist with the worker's writes.
		const mainStmt = db.prepare(`INSERT INTO ${SCRATCH} (src, n) VALUES ('main', ?)`);
		const mainErrors: string[] = [];
		for (let i = 0; i < N; i++) {
			try {
				mainStmt.run(i);
			} catch (e) {
				mainErrors.push(String((e as Error).message));
			}
		}

		const workerResult = await workerDone;

		// No write was dropped on either side — the configured busy_timeout made
		// every colliding writer wait-and-retry rather than throw.
		expect(mainErrors).toEqual([]);
		expect(workerResult.errors).toEqual([]);
		expect(workerResult.written).toBe(N);
		// Exactly 2N rows: N from the worker's handle, N from the app handle.
		const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${SCRATCH}`).get() as { n: number }).n;
		expect(total).toBe(2 * N);
		expect((db.prepare(`SELECT COUNT(*) AS n FROM ${SCRATCH} WHERE src = 'worker'`).get() as { n: number }).n).toBe(N);
		expect((db.prepare(`SELECT COUNT(*) AS n FROM ${SCRATCH} WHERE src = 'main'`).get() as { n: number }).n).toBe(N);
		// The WAL file is not corrupt after concurrent multi-handle write pressure.
		expect(integrityOk(db)).toBe(true);
	}, 30_000);
});
