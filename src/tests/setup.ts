// Vitest setup: point the app database at a unique temp file BEFORE any test
// imports $lib/server/db (which opens the DB at module load), and clean up after.
import { afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const dbPath = path.join(os.tmpdir(), `cairn-test-${randomBytes(8).toString('hex')}.db`);
process.env.CAIRN_DB = dbPath;

afterAll(async () => {
	// Close the sqlite handle if this test file ever opened it, so the files
	// can be deleted on Windows. The db module creates the file at import time,
	// so a missing file means it was never loaded here.
	if (fs.existsSync(dbPath)) {
		try {
			const mod = await import('$lib/server/db');
			mod.db.close();
		} catch {
			// Already closed — nothing to do.
		}
	}
	for (const suffix of ['', '-wal', '-shm']) {
		try {
			fs.rmSync(dbPath + suffix, { force: true });
		} catch {
			// Best-effort cleanup of temp files.
		}
	}
});
