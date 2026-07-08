// P0 coverage for the "vault" -> "multisig" rename migration in db.ts
// (cairn-z2m6). That migration runs as top-level module side effects on
// EVERY import of $lib/server/db — there is no exported function to call in
// isolation — so these tests build an old-schema SQLite fixture file on disk
// BEFORE importing the module, point CAIRN_DB at it, then import fresh
// (vi.resetModules + vi.stubEnv, the same pattern src/tests/envAlias.test.ts
// uses for this exact module) so the migration actually executes against our
// fixture data instead of a blank database.
//
// Covers:
//  (a) data preservation — every vaults/vault_keys/vault_transactions/
//      ledger_vault_registrations row survives, verbatim, in the renamed
//      multisig* tables, with the FK column renamed vault_id -> multisig_id.
//  (b) the empty-shell recovery DROP branch (db.ts ~205-235) fires ONLY when
//      every shell table is independently empty, and leaves everything
//      intact (drops nothing) the moment any shell table holds a row.
//  (c) idempotency — re-importing against an already-migrated file is a
//      total no-op: no duplication, no errors, no data loss.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function tmpDbPath(label: string): string {
	return path.join(os.tmpdir(), `cairn-vault-migration-${label}-${randomBytes(8).toString('hex')}.db`);
}

function cleanupDbFile(dbPath: string): void {
	for (const suffix of ['', '-wal', '-shm']) {
		try {
			fs.rmSync(dbPath + suffix, { force: true });
		} catch {
			// Best-effort temp cleanup (Windows may still hold the handle briefly).
		}
	}
}

// Builds a pre-rename ("vault"-era) database at `dbPath`: a users row plus one
// populated vaults / vault_keys / vault_transactions / ledger_vault_registrations
// set, matching the exact old shape db.ts's migration expects to find (FK
// column `vault_id`, table names `vault*`/`ledger_vault_registrations`).
function buildOldSchemaFixture(dbPath: string): void {
	const raw = new DatabaseSync(dbPath);
	raw.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE COLLATE NOCASE,
			password_hash TEXT,
			display_name TEXT NOT NULL,
			is_admin INTEGER NOT NULL DEFAULT 0,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			last_login TEXT
		);

		CREATE TABLE vaults (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name           TEXT NOT NULL,
			threshold      INTEGER NOT NULL,
			script_type    TEXT NOT NULL DEFAULT 'p2wsh',
			receive_cursor INTEGER NOT NULL DEFAULT 0,
			created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE INDEX idx_vaults_user ON vaults(user_id);

		CREATE TABLE vault_keys (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			vault_id    INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
			position    INTEGER NOT NULL,
			name        TEXT NOT NULL,
			category    TEXT NOT NULL,
			device_type TEXT,
			xpub        TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			path        TEXT NOT NULL,
			UNIQUE (vault_id, position),
			UNIQUE (vault_id, xpub)
		);
		CREATE INDEX idx_vault_keys_vault ON vault_keys(vault_id);

		CREATE TABLE ledger_vault_registrations (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			vault_id    INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
			master_fp   TEXT NOT NULL,
			policy_name TEXT NOT NULL,
			policy_hmac TEXT NOT NULL,
			policy_id   TEXT,
			created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			UNIQUE (vault_id, master_fp)
		);

		CREATE TABLE vault_transactions (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			vault_id             INTEGER NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
			status               TEXT NOT NULL DEFAULT 'draft',
			psbt                 TEXT NOT NULL,
			txid                 TEXT,
			recipient            TEXT NOT NULL,
			amount               INTEGER NOT NULL,
			recipients           TEXT,
			fee                  INTEGER NOT NULL,
			fee_rate             REAL NOT NULL,
			change_index         INTEGER,
			broadcast_started_at TEXT,
			created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE INDEX idx_vault_transactions_vault ON vault_transactions(vault_id);
	`);

	raw.prepare(
		`INSERT INTO users (id, email, display_name) VALUES (1, 'owner@example.com', 'Owner')`
	).run();

	raw.prepare(
		`INSERT INTO vaults (id, user_id, name, threshold, script_type, receive_cursor)
		 VALUES (1, 1, 'Cold storage', 2, 'p2wsh', 7)`
	).run();

	const insertKey = raw.prepare(
		`INSERT INTO vault_keys (vault_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	insertKey.run(1, 1, 'My Trezor', 'hardware', 'trezor', 'xpub-key-one', 'aaaaaaaa', "m/48'/0'/0'/2'");
	insertKey.run(1, 2, 'Steel backup', 'recovery', null, 'xpub-key-two', 'bbbbbbbb', "m/48'/0'/0'/2'");
	insertKey.run(1, 3, 'Ledger', 'hardware', 'ledger', 'xpub-key-three', 'cccccccc', "m/48'/0'/0'/2'");

	raw.prepare(
		`INSERT INTO ledger_vault_registrations (vault_id, master_fp, policy_name, policy_hmac)
		 VALUES (1, 'cccccccc', 'Cold storage', ?)`
	).run('f'.repeat(64));

	raw.prepare(
		`INSERT INTO vault_transactions
			(vault_id, status, psbt, txid, recipient, amount, fee, fee_rate)
		 VALUES (1, 'completed', 'cHNidP8BAH0...', ?, 'bc1qrecipient', 50000, 500, 12.5)`
	).run('deadbeef'.repeat(8));

	raw.close();
}

// Loads $lib/server/db fresh against `dbPath`, forcing its top-level
// migration code to actually run (module singletons otherwise cache).
async function importDbAgainst(dbPath: string) {
	vi.resetModules();
	delete process.env.HEARTWOOD_DB;
	vi.stubEnv('CAIRN_DB', dbPath);
	return import('$lib/server/db');
}

const openDbPaths: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const p of openDbPaths.splice(0)) cleanupDbFile(p);
});

describe('vault -> multisig rename migration (db.ts)', () => {
	it('moves every row from vaults/vault_keys/vault_transactions/ledger_vault_registrations into the renamed multisig* tables, unchanged', async () => {
		const dbPath = tmpDbPath('golden');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		// Old tables are gone.
		const tableNames = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('vaults')).toBe(false);
		expect(tableNames.has('vault_keys')).toBe(false);
		expect(tableNames.has('vault_transactions')).toBe(false);
		expect(tableNames.has('ledger_vault_registrations')).toBe(false);

		// New tables hold exactly the old data.
		const multisig = db.prepare('SELECT * FROM multisigs WHERE id = 1').get() as Record<
			string,
			unknown
		>;
		expect(multisig).toMatchObject({
			user_id: 1,
			name: 'Cold storage',
			threshold: 2,
			script_type: 'p2wsh',
			receive_cursor: 7
		});

		const keys = db
			.prepare('SELECT * FROM multisig_keys WHERE multisig_id = 1 ORDER BY position')
			.all() as Record<string, unknown>[];
		expect(keys).toHaveLength(3);
		expect(keys.map((k) => k.xpub)).toEqual(['xpub-key-one', 'xpub-key-two', 'xpub-key-three']);
		expect(keys.every((k) => k.multisig_id === 1)).toBe(true);
		// The FK column itself was renamed, not just re-populated.
		expect(Object.keys(keys[0])).not.toContain('vault_id');

		const reg = db.prepare('SELECT * FROM ledger_multisig_registrations').get() as Record<
			string,
			unknown
		>;
		expect(reg).toMatchObject({ multisig_id: 1, master_fp: 'cccccccc', policy_name: 'Cold storage' });

		const tx = db.prepare('SELECT * FROM multisig_transactions').get() as Record<string, unknown>;
		expect(tx).toMatchObject({
			multisig_id: 1,
			status: 'completed',
			recipient: 'bc1qrecipient',
			amount: 50000,
			fee: 500
		});

		db.close();
	});

	it('is idempotent: re-importing an already-migrated database is a no-op (no duplication, no data loss)', async () => {
		const dbPath = tmpDbPath('idempotent');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		const first = await importDbAgainst(dbPath);
		const beforeKeys = first.db
			.prepare('SELECT * FROM multisig_keys ORDER BY position')
			.all() as Record<string, unknown>[];
		const beforeMultisig = first.db.prepare('SELECT * FROM multisigs WHERE id = 1').get();
		first.db.close();

		const second = await importDbAgainst(dbPath);
		const afterKeys = second.db
			.prepare('SELECT * FROM multisig_keys ORDER BY position')
			.all() as Record<string, unknown>[];
		const afterMultisig = second.db.prepare('SELECT * FROM multisigs WHERE id = 1').get();

		expect(afterKeys).toEqual(beforeKeys);
		expect(afterMultisig).toEqual(beforeMultisig);
		expect(afterKeys).toHaveLength(3);

		// Old tables did not get resurrected by the second run.
		const tableNames = new Set(
			(
				second.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
					name: string;
				}[]
			).map((t) => t.name)
		);
		expect(tableNames.has('vaults')).toBe(false);
		expect(tableNames.has('vault_keys')).toBe(false);

		second.db.close();
	});

	it('empty-shell recovery: drops genuinely-empty leftover multisig* shells and completes the real migration', async () => {
		const dbPath = tmpDbPath('empty-shell-recovery');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		// Simulate a prior partial run: the new-named tables already exist
		// (e.g. created by the CREATE TABLE IF NOT EXISTS block on some earlier,
		// interrupted start) but hold zero rows — a pure empty shell.
		const raw = new DatabaseSync(dbPath);
		raw.exec(`
			CREATE TABLE multisigs (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
				threshold INTEGER NOT NULL, script_type TEXT NOT NULL DEFAULT 'p2wsh',
				receive_cursor INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);
			CREATE TABLE multisig_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT, multisig_id INTEGER NOT NULL,
				position INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
				device_type TEXT, xpub TEXT NOT NULL, fingerprint TEXT NOT NULL, path TEXT NOT NULL
			);
			CREATE TABLE multisig_transactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT, multisig_id INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'draft', psbt TEXT NOT NULL, txid TEXT,
				recipient TEXT NOT NULL, amount INTEGER NOT NULL, fee INTEGER NOT NULL, fee_rate REAL NOT NULL
			);
			CREATE TABLE ledger_multisig_registrations (
				id INTEGER PRIMARY KEY AUTOINCREMENT, multisig_id INTEGER NOT NULL,
				master_fp TEXT NOT NULL, policy_name TEXT NOT NULL, policy_hmac TEXT NOT NULL, policy_id TEXT
			);
		`);
		raw.close();

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		// The shells were dropped and the real vault data landed in their place.
		const keys = db
			.prepare('SELECT * FROM multisig_keys ORDER BY position')
			.all() as Record<string, unknown>[];
		expect(keys).toHaveLength(3);
		expect(keys.map((k) => k.xpub)).toEqual(['xpub-key-one', 'xpub-key-two', 'xpub-key-three']);

		const multisig = db.prepare('SELECT * FROM multisigs WHERE id = 1').get() as Record<
			string,
			unknown
		>;
		expect(multisig).toMatchObject({ name: 'Cold storage', threshold: 2 });

		const tableNames = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('vaults')).toBe(false);

		db.close();
	});

	it('empty-shell recovery ABORTS and drops nothing when a shell table already holds rows (the exact data-loss anomaly it guards against)', async () => {
		const dbPath = tmpDbPath('nonempty-shell-abort');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		// Simulate the dangerous case: 'multisigs' (the parent) is an empty
		// shell, but a CHILD shell already holds a row — e.g. a half-finished
		// migration that got as far as writing one multisig_keys row before
		// being interrupted. The parent-empty check alone would wrongly treat
		// this as "safe to drop"; the migration must independently verify every
		// shell table and abort rather than discard that row.
		const raw = new DatabaseSync(dbPath);
		raw.exec(`
			CREATE TABLE multisigs (
				id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
				threshold INTEGER NOT NULL, script_type TEXT NOT NULL DEFAULT 'p2wsh',
				receive_cursor INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			);
			CREATE TABLE multisig_keys (
				id INTEGER PRIMARY KEY AUTOINCREMENT, multisig_id INTEGER NOT NULL,
				position INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
				device_type TEXT, xpub TEXT NOT NULL, fingerprint TEXT NOT NULL, path TEXT NOT NULL
			);
		`);
		raw
			.prepare(
				`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path)
				 VALUES (999, 1, 'Orphaned partial-migration key', 'hardware', 'xpub-orphan', 'eeeeeeee', 'm/48''/0''/0''/2''')`
			)
			.run();
		raw.close();

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		// Nothing was dropped: the old vault* tables are still present with
		// their original data...
		const tableNames = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('vaults')).toBe(true);
		expect(tableNames.has('vault_keys')).toBe(true);

		const oldVault = db.prepare('SELECT * FROM vaults WHERE id = 1').get() as Record<
			string,
			unknown
		>;
		expect(oldVault).toMatchObject({ name: 'Cold storage', threshold: 2 });
		const oldKeys = db.prepare('SELECT * FROM vault_keys ORDER BY position').all() as Record<
			string,
			unknown
		>[];
		expect(oldKeys).toHaveLength(3);
		expect(oldKeys.map((k) => k.xpub)).toEqual(['xpub-key-one', 'xpub-key-two', 'xpub-key-three']);

		// ...and the pre-existing shell row (the thing that must never be
		// silently dropped) is still exactly there too.
		const orphanKeys = db.prepare('SELECT * FROM multisig_keys').all() as Record<string, unknown>[];
		expect(orphanKeys).toHaveLength(1);
		expect(orphanKeys[0]).toMatchObject({ multisig_id: 999, xpub: 'xpub-orphan' });

		// The empty 'multisigs' shell was left alone too (not populated, not dropped).
		const multisigRows = db.prepare('SELECT COUNT(*) AS c FROM multisigs').get() as { c: number };
		expect(multisigRows.c).toBe(0);

		db.close();
	});

	it('a fresh database with no vault* tables skips the migration cleanly (no error, empty multisig* tables)', async () => {
		const dbPath = tmpDbPath('fresh-install');
		openDbPaths.push(dbPath);
		// No fixture at all — db.ts creates the file itself on import.

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		const tableNames = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('multisigs')).toBe(true);
		expect(tableNames.has('vaults')).toBe(false);
		const count = db.prepare('SELECT COUNT(*) AS c FROM multisigs').get() as { c: number };
		expect(count.c).toBe(0);

		db.close();
	});
});
