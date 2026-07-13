// Stress helper: a worker_thread that opens its OWN DatabaseSync handle on an
// existing SQLite file and hammers INSERTs at it, in genuine OS-thread parallel
// with whatever the spawning process is doing to the same file. Used by
// src/lib/server/concurrencyMultiHandle.test.ts to reproduce the ONLY way Cairn
// could ever see multi-writer contention: a second process/handle sharing the
// WAL DB (an Umbrel sidecar, a stray second app instance, a backup tool). The
// production app opens exactly one handle (src/lib/server/db.ts), so this shape
// never occurs in-process — the test uses this worker to prove what WOULD happen.
//
// workerData: { dbPath, table, src, count, busyTimeout }
//   busyTimeout: number of ms to set PRAGMA busy_timeout to on THIS handle, or
//                null to leave SQLite's default (0 → immediate SQLITE_BUSY throw).
// Reports { written, errors[] } so the test can assert the configured
// busy_timeout absorbs contention (0 errors) vs. a raw handle that throws.
import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const { dbPath, table, src, count, busyTimeout } = workerData;

const db = new DatabaseSync(dbPath);
// Never set WAL here — journal_mode is a persistent DB-level setting the primary
// handle already established; a second handle just inherits it. busy_timeout,
// by contrast, is PER-CONNECTION and does NOT inherit, which is the whole point.
if (busyTimeout != null) db.exec(`PRAGMA busy_timeout = ${Number(busyTimeout)}`);

const stmt = db.prepare(`INSERT INTO ${table} (src, n) VALUES (?, ?)`);
const errors = [];
let written = 0;
for (let i = 0; i < count; i++) {
	try {
		stmt.run(src, i);
		written++;
	} catch (e) {
		errors.push(String((e && e.message) || e));
	}
}
db.close();
parentPort.postMessage({ written, errors });
