// cairn-ug2g: coverage for the notified_txids UNIQUE-widening rebuild in db.ts
// (RENAME TO old / CREATE new shape / INSERT...SELECT / DROP old), which
// widens UNIQUE(wallet_kind, wallet_id, txid) to UNIQUE(wallet_kind,
// wallet_id, user_id, txid) — cairn-7tst. Under the OLD constraint, a shared
// (collaborative-custody) wallet could only ever hold ONE notified_txids row
// for a given txid across ALL co-owners: the first collaborator's insert
// silently starved every other co-owner of their own tx_received/tx_confirmed
// tracking for that same transaction. This migration is destructive
// (RENAME/DROP) and, like the vault->multisig rename (db.vaultMigration.test.ts,
// whose fixture-import pattern this file follows), runs as a top-level module
// side effect on every import with zero prior test coverage.
//
// Covers:
//  (a) every pre-migration row survives, verbatim, in the rebuilt table;
//  (b) the widened constraint is actually enforced afterward — a second
//      co-owner's row for the same (wallet_kind, wallet_id, txid) that the OLD
//      schema would have rejected now succeeds, while a true duplicate
//      ((wallet_kind, wallet_id, user_id, txid) already present) still fails;
//  (c) the old shadow table is dropped, not left behind;
//  (d) idempotency — re-importing an already-migrated database is a no-op;
//  (e) a fresh install (no pre-existing notified_txids at all) gets the new
//      shape directly, skipping the rebuild branch cleanly.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function tmpDbPath(label: string): string {
	return path.join(os.tmpdir(), `cairn-notifiedtxids-migration-${label}-${randomBytes(8).toString('hex')}.db`);
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

// The exact `users` shape db.ts expects at import time (copied from
// db.vaultMigration.test.ts's fixture, which already proves this shape lets
// the rest of db.ts's own migrations run cleanly on top).
const USERS_TABLE_SQL = `
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
`;

/** Builds a pre-cairn-7tst database: notified_txids with the OLD (narrower)
 *  UNIQUE(wallet_kind, wallet_id, txid) — no user_id in the constraint — plus
 *  a few realistic rows across both wallet kinds. */
function buildOldSchemaFixture(dbPath: string): void {
	const raw = new DatabaseSync(dbPath);
	raw.exec(USERS_TABLE_SQL);
	// Real parent rows for wallet_id=1 (wallet) / wallet_id=5 (multisig): db.ts's
	// startup orphan purge (cairn-97ui, right after this migration) unconditionally
	// deletes any notified_txids row whose wallet_id isn't found in wallets/
	// multisigs — without these, every fixture row below would be wrongly swept
	// away as "orphaned" before the assertions ever ran.
	raw.exec(`
		CREATE TABLE wallets (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name           TEXT NOT NULL,
			type           TEXT NOT NULL DEFAULT 'xpub',
			xpub           TEXT NOT NULL,
			script_type    TEXT NOT NULL,
			receive_cursor INTEGER NOT NULL DEFAULT 0,
			created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			UNIQUE (user_id, xpub)
		);
		CREATE TABLE multisigs (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name           TEXT NOT NULL,
			threshold      INTEGER NOT NULL,
			script_type    TEXT NOT NULL DEFAULT 'p2wsh',
			receive_cursor INTEGER NOT NULL DEFAULT 0,
			created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE TABLE notified_txids (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			wallet_kind  TEXT NOT NULL,
			wallet_id    INTEGER NOT NULL,
			user_id      INTEGER NOT NULL,
			txid         TEXT NOT NULL,
			confirmed    INTEGER NOT NULL DEFAULT 0,
			created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			UNIQUE (wallet_kind, wallet_id, txid)
		);
		CREATE INDEX idx_notified_txids_wallet ON notified_txids(wallet_kind, wallet_id);
	`);

	raw.prepare(`INSERT INTO users (id, email, display_name) VALUES (1, 'owner@example.com', 'Owner')`).run();
	raw.prepare(`INSERT INTO users (id, email, display_name) VALUES (2, 'cosigner@example.com', 'Cosigner')`).run();
	raw
		.prepare(
			`INSERT INTO wallets (id, user_id, name, xpub, script_type) VALUES (1, 1, 'Everyday', 'xpub-fixture', 'p2wpkh')`
		)
		.run();
	raw
		.prepare(`INSERT INTO multisigs (id, user_id, name, threshold) VALUES (5, 1, 'Shared cold storage', 2)`)
		.run();

	const insert = raw.prepare(
		`INSERT INTO notified_txids (id, wallet_kind, wallet_id, user_id, txid, confirmed, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	// Single-sig wallet, already-confirmed inbound.
	insert.run(1, 'wallet', 1, 1, 'a'.repeat(64), 1, '2026-01-01T00:00:00.000Z');
	// Same single-sig wallet, still-unconfirmed inbound.
	insert.run(2, 'wallet', 1, 1, 'b'.repeat(64), 0, '2026-01-02T00:00:00.000Z');
	// A shared multisig, tracked only for its FIRST co-owner — the exact
	// duplicate-prone shape cairn-7tst's widened constraint exists to fix: a
	// second co-owner could never get their OWN row for this same txid under
	// the old (wallet_kind, wallet_id, txid) constraint.
	insert.run(3, 'multisig', 5, 1, 'c'.repeat(64), 1, '2026-01-03T00:00:00.000Z');

	raw.close();
}

/** Loads $lib/server/db fresh against `dbPath`, forcing its top-level
 *  migration code to actually run (module singletons otherwise cache). */
async function importDbAgainst(dbPath: string) {
	vi.resetModules();
	delete process.env.HEARTWOOD_DB;
	vi.stubEnv('CAIRN_DB', dbPath);
	return import('$lib/server/db');
}

function tableSql(database: { prepare: (q: string) => { get: () => unknown } }, name: string): string | undefined {
	return (
		database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?" as string).get() as
			| { sql: string }
			| undefined
	)?.sql;
}

const openDbPaths: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const p of openDbPaths.splice(0)) cleanupDbFile(p);
});

describe('notified_txids UNIQUE-widening rebuild migration (db.ts, cairn-7tst)', () => {
	it('rebuilds the table with the widened UNIQUE and copies every pre-existing row unchanged', async () => {
		const dbPath = tmpDbPath('golden');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		// The rebuilt table's declared UNIQUE now includes user_id.
		const sql = (
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notified_txids'")
				.get() as { sql: string }
		).sql;
		expect(/user_id\s*,\s*txid\s*\)/i.test(sql)).toBe(true);

		// The shadow table used mid-rebuild does not survive.
		const tableNames = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('notified_txids_old')).toBe(false);

		// Every original row survived, verbatim, on its original id.
		const rows = db
			.prepare('SELECT id, wallet_kind, wallet_id, user_id, txid, confirmed, created_at FROM notified_txids ORDER BY id')
			.all() as Record<string, unknown>[];
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			id: 1,
			wallet_kind: 'wallet',
			wallet_id: 1,
			user_id: 1,
			txid: 'a'.repeat(64),
			confirmed: 1,
			created_at: '2026-01-01T00:00:00.000Z'
		});
		expect(rows[1]).toMatchObject({
			id: 2,
			wallet_kind: 'wallet',
			wallet_id: 1,
			user_id: 1,
			txid: 'b'.repeat(64),
			confirmed: 0
		});
		expect(rows[2]).toMatchObject({
			id: 3,
			wallet_kind: 'multisig',
			wallet_id: 5,
			user_id: 1,
			txid: 'c'.repeat(64),
			confirmed: 1
		});

		// The supporting index still exists and is usable.
		const idxRows = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notified_txids'")
			.all() as { name: string }[];
		expect(idxRows.some((i) => i.name === 'idx_notified_txids_wallet')).toBe(true);

		db.close();
	});

	it('the widened constraint now allows a second co-owner to hold their own row for the same wallet+txid, while still rejecting a true duplicate', async () => {
		const dbPath = tmpDbPath('constraint');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		// User 2 (a co-owner of the same shared multisig, wallet_id=5) gets their
		// OWN tracking row for the exact same (wallet_kind, wallet_id, txid) that
		// user 1 already has — impossible under the pre-migration constraint.
		expect(() =>
			db
				.prepare(
					`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed)
					 VALUES ('multisig', 5, 2, ?, 1)`
				)
				.run('c'.repeat(64))
		).not.toThrow();

		const bothRows = db
			.prepare("SELECT user_id FROM notified_txids WHERE wallet_kind = 'multisig' AND wallet_id = 5 AND txid = ? ORDER BY user_id")
			.all('c'.repeat(64)) as { user_id: number }[];
		expect(bothRows.map((r) => r.user_id)).toEqual([1, 2]);

		// But a genuine duplicate — same (wallet_kind, wallet_id, user_id, txid)
		// as an existing row — is still rejected; the constraint was widened, not
		// dropped.
		expect(() =>
			db
				.prepare(
					`INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid, confirmed)
					 VALUES ('multisig', 5, 1, ?, 1)`
				)
				.run('c'.repeat(64))
		).toThrow();

		db.close();
	});

	it('is idempotent: re-importing an already-migrated database duplicates nothing and loses nothing', async () => {
		const dbPath = tmpDbPath('idempotent');
		openDbPaths.push(dbPath);
		buildOldSchemaFixture(dbPath);

		const first = await importDbAgainst(dbPath);
		const beforeRows = first.db
			.prepare('SELECT id, wallet_kind, wallet_id, user_id, txid, confirmed FROM notified_txids ORDER BY id')
			.all();
		const beforeSql = tableSql(first.db, 'notified_txids');
		first.db.close();

		const second = await importDbAgainst(dbPath);
		const afterRows = second.db
			.prepare('SELECT id, wallet_kind, wallet_id, user_id, txid, confirmed FROM notified_txids ORDER BY id')
			.all();
		const afterSql = tableSql(second.db, 'notified_txids');

		expect(afterRows).toEqual(beforeRows);
		expect(afterRows).toHaveLength(3);
		expect(afterSql).toBe(beforeSql);

		const tableNames = new Set(
			(second.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
				(t) => t.name
			)
		);
		expect(tableNames.has('notified_txids_old')).toBe(false);

		second.db.close();
	});

	it('a fresh database with no pre-existing notified_txids gets the new (widened) shape directly, skipping the rebuild', async () => {
		const dbPath = tmpDbPath('fresh-install');
		openDbPaths.push(dbPath);
		// No fixture at all — db.ts creates the file and every table itself.

		const mod = await importDbAgainst(dbPath);
		const { db } = mod;

		const sql = (
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notified_txids'")
				.get() as { sql: string }
		).sql;
		expect(/user_id\s*,\s*txid\s*\)/i.test(sql)).toBe(true);

		const count = db.prepare('SELECT COUNT(*) AS c FROM notified_txids').get() as { c: number };
		expect(count.c).toBe(0);

		db.close();
	});
});
