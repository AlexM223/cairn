// Rebrand back-compat (cairn-koy4.12): HEARTWOOD_DB / HEARTWOOD_LOG_FILE are
// aliases for CAIRN_DB / CAIRN_LOG_FILE. The HEARTWOOD_* name wins when set;
// otherwise the legacy CAIRN_* value must keep working forever, because every
// existing self-hosted install (Umbrel/Start9/manual Docker) sets only CAIRN_*.
//
// Both modules resolve their path at import time, so each case re-imports the
// module after vi.resetModules() with the env arranged first.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

describe('logger LOG_FILE env alias', () => {
	it('prefers HEARTWOOD_LOG_FILE when set', async () => {
		vi.resetModules();
		vi.stubEnv('CAIRN_LOG_FILE', path.join(os.tmpdir(), 'legacy-cairn.log'));
		vi.stubEnv('HEARTWOOD_LOG_FILE', path.join(os.tmpdir(), 'heartwood.log'));
		try {
			const { LOG_FILE } = await import('$lib/server/logger');
			expect(LOG_FILE).toBe(path.join(os.tmpdir(), 'heartwood.log'));
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('falls back to CAIRN_LOG_FILE when HEARTWOOD_LOG_FILE is unset', async () => {
		vi.resetModules();
		delete process.env.HEARTWOOD_LOG_FILE;
		vi.stubEnv('CAIRN_LOG_FILE', path.join(os.tmpdir(), 'legacy-cairn.log'));
		try {
			const { LOG_FILE } = await import('$lib/server/logger');
			expect(LOG_FILE).toBe(path.join(os.tmpdir(), 'legacy-cairn.log'));
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('db DB_PATH env alias', () => {
	it('prefers HEARTWOOD_DB when set', async () => {
		const hwDbPath = path.join(
			os.tmpdir(),
			`heartwood-alias-test-${randomBytes(8).toString('hex')}.db`
		);
		vi.resetModules();
		vi.stubEnv('HEARTWOOD_DB', hwDbPath);
		try {
			const mod = await import('$lib/server/db');
			expect(mod.DB_PATH).toBe(hwDbPath);
			mod.db.close();
		} finally {
			vi.unstubAllEnvs();
			for (const suffix of ['', '-wal', '-shm']) {
				try {
					fs.rmSync(hwDbPath + suffix, { force: true });
				} catch {
					// Best-effort temp cleanup (Windows may still hold the handle).
				}
			}
		}
	});

	it('falls back to CAIRN_DB when HEARTWOOD_DB is unset (existing installs)', async () => {
		// setup.ts points CAIRN_DB at the per-run temp DB; that legacy name must
		// still resolve unchanged. This import is deliberately LAST and left open:
		// it becomes the module instance setup.ts's afterAll closes and deletes.
		vi.resetModules();
		delete process.env.HEARTWOOD_DB;
		expect(process.env.CAIRN_DB).toBeTruthy();
		const mod = await import('$lib/server/db');
		expect(mod.DB_PATH).toBe(process.env.CAIRN_DB);
	});
});
