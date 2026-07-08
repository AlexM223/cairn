// cairn-97ui — the definitive backstop for the wallets/multisigs polymorphic
// delete-cascade bug. Several tables (discovered below, NOT hardcoded) key off a
// (wallet_kind, wallet_id) pair instead of a real foreign key, so SQLite's own
// ON DELETE CASCADE can never reach them — db.ts's trg_wallets_delete_children /
// trg_multisigs_delete_children AFTER DELETE triggers are the only thing that
// does, and they cover all three delete paths (deleteWallet, deleteMultisig, and
// a user's wallets/multisigs disappearing via the users(id) ON DELETE CASCADE
// FK) because SQLite fires a table's AFTER DELETE triggers even when a row is
// removed by an FK action, as long as foreign_keys=ON (db.ts:25).
//
// This test does NOT hardcode the table list — it discovers every table shaped
// like this via sqlite_master + pragma_table_info, so a table added later that
// matches the shape but was never wired into a trigger body FAILS this test
// immediately, instead of silently leaking orphans the way balance_snapshots did
// before cairn-97ui (deleteWallet/deleteMultisig's old hand-written cleanup
// never touched it — see git history on wallets.ts/wallets/multisig.ts).
//
// multisig_shares also carries a `wallet_kind` column but has NO `wallet_id`
// column — its parent link is a real `multisig_id` FK with ON DELETE CASCADE, so
// it already cascades correctly on its own and structurally does not match the
// discovery query below. It is deliberately NOT added to EXEMPT_TABLES: that
// list is reserved for tables that DO match the (wallet_kind, wallet_id) shape
// but whose cleanup must stay in TypeScript for an ordering-sensitive side
// effect (none exist today).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { deleteWallet } from './wallets';
import { deleteMultisig } from './wallets/multisig';
import { deleteOwnAccount } from './accountDeletion';

/** Tables allowed to keep (wallet_kind, wallet_id) cleanup in TypeScript instead
 *  of the blind SQL trigger sweep, keyed by table name with the reason recorded
 *  inline. Empty today — see the file header for why multisig_shares isn't here. */
const EXEMPT_TABLES: Record<string, string> = {};

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM address_labels; DELETE FROM wallet_backups;
		 DELETE FROM backup_missing_notified; DELETE FROM balance_snapshots;
		 DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs;
		 DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeUser(email: string): Promise<number> {
	return (
		await registerUser({
			email,
			password: 'correct horse battery',
			displayName: email.split('@')[0]
		})
	).id;
}

let xpubSeq = 0;
function makeWallet(userId: number): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
		.run(userId, `xpub-cascade-${xpubSeq++}`);
	return Number(res.lastInsertRowid);
}

function makeMultisig(userId: number): number {
	const res = db
		.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'ms', 2, 'p2wsh')")
		.run(userId);
	return Number(res.lastInsertRowid);
}

/** Every table shaped like the polymorphic-child pattern: a real column named
 *  wallet_kind AND a real column named wallet_id. */
function discoverPolymorphicTables(): string[] {
	const tables = (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
	).map((t) => t.name);
	return tables.filter((t) => {
		const cols = new Set(
			(db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
		);
		return cols.has('wallet_kind') && cols.has('wallet_id');
	});
}

interface ColInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

function tableColumns(table: string): ColInfo[] {
	return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColInfo[];
}

/** Local columns of `table` that carry a real foreign key to `targetTable`. */
function fkColumnsTo(table: string, targetTable: string): Set<string> {
	const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
		table: string;
		from: string;
	}[];
	return new Set(rows.filter((r) => r.table === targetTable).map((r) => r.from));
}

/**
 * Insert one generic row into `table` for (kind, id), filling every other
 * NOT-NULL/no-default column with a placeholder: the real seeded user id for
 * anything FK'd to users, 0 for other integer columns, a fixed string for
 * everything else. Written to work for any table shaped like the polymorphic
 * pattern — including one added after this test was written — not just the
 * five known today.
 */
function seedPolymorphicRow(
	table: string,
	kind: 'wallet' | 'multisig',
	id: number,
	userId: number
): void {
	const cols = tableColumns(table);
	const singlePk = cols.filter((c) => c.pk > 0).length === 1;
	const userFkCols = fkColumnsTo(table, 'users');

	const names: string[] = [];
	const values: (string | number)[] = [];
	for (const c of cols) {
		if (c.name === 'wallet_kind') {
			names.push(c.name);
			values.push(kind);
		} else if (c.name === 'wallet_id') {
			names.push(c.name);
			values.push(id);
		} else if (singlePk && c.pk === 1 && /INT/i.test(c.type)) {
			continue; // autoincrement rowid — let SQLite assign it
		} else if (c.dflt_value !== null) {
			continue; // has a default — no need to specify
		} else if (c.notnull === 0) {
			continue; // nullable — fine to omit
		} else if (userFkCols.has(c.name)) {
			names.push(c.name);
			values.push(userId);
		} else if (/INT/i.test(c.type)) {
			names.push(c.name);
			values.push(0);
		} else {
			names.push(c.name);
			values.push(`seed-${c.name}`);
		}
	}

	const placeholders = names.map(() => '?').join(', ');
	db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(...values);
}

function orphanCount(table: string, kind: 'wallet' | 'multisig', id: number): number {
	return (
		db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE wallet_kind = ? AND wallet_id = ?`)
			.get(kind, id) as { n: number }
	).n;
}

function sweepableTables(): string[] {
	return discoverPolymorphicTables().filter((t) => !(t in EXEMPT_TABLES));
}

describe('polymorphic (wallet_kind, wallet_id) delete cascade (cairn-97ui)', () => {
	it('discovers at least the five known polymorphic child tables', () => {
		// Sanity check on the introspection query itself, so a silently-empty
		// discovery couldn't make every test below vacuously pass.
		expect(discoverPolymorphicTables()).toEqual(
			expect.arrayContaining([
				'balance_snapshots',
				'wallet_backups',
				'address_labels',
				'backup_missing_notified',
				'notified_txids'
			])
		);
	});

	it('does NOT discover multisig_shares (it has wallet_kind but no wallet_id — real FK instead)', () => {
		expect(discoverPolymorphicTables()).not.toContain('multisig_shares');
	});

	it('every discovered non-exempt table is swept by a trigger', () => {
		const triggerSql = (
			db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'").all() as {
				sql: string | null;
			}[]
		)
			.map((r) => r.sql ?? '')
			.join('\n');

		for (const table of sweepableTables()) {
			expect(triggerSql, `expected trigger coverage for "${table}"`).toContain(table);
		}
	});

	it('deleteWallet/deleteMultisig (direct-delete path) leaves zero orphans in every non-exempt table', async () => {
		const owner = await makeUser('owner-direct@example.com');
		const walletId = makeWallet(owner);
		const multisigId = makeMultisig(owner);

		for (const table of sweepableTables()) {
			seedPolymorphicRow(table, 'wallet', walletId, owner);
			seedPolymorphicRow(table, 'multisig', multisigId, owner);
		}

		expect(deleteWallet(owner, walletId)).toBe(true);
		expect(deleteMultisig(owner, multisigId)).toBe(true);

		for (const table of sweepableTables()) {
			expect(orphanCount(table, 'wallet', walletId), `${table} (wallet)`).toBe(0);
			expect(orphanCount(table, 'multisig', multisigId), `${table} (multisig)`).toBe(0);
		}
	});

	it('user deletion (user-cascade path) leaves zero orphans in every non-exempt table', async () => {
		// The first user registered after wipe() auto-becomes the instance admin
		// (auth.ts registerUser) — burn that slot on a throwaway account so the
		// real test user isn't the sole admin (deleteOwnAccount refuses to delete
		// the only active administrator).
		await makeUser('admin-cascade@example.com');
		const owner = await makeUser('owner-cascade@example.com');
		const walletId = makeWallet(owner);
		const multisigId = makeMultisig(owner);

		for (const table of sweepableTables()) {
			seedPolymorphicRow(table, 'wallet', walletId, owner);
			seedPolymorphicRow(table, 'multisig', multisigId, owner);
		}

		// deleteOwnAccount never calls deleteWallet/deleteMultisig — the
		// wallets/multisigs rows disappear via the users(id) ON DELETE CASCADE FK
		// (db.ts:53/281 in the schema), which is exactly the path that makes the
		// AFTER DELETE triggers (not app code) the only thing that can reach these
		// tables.
		deleteOwnAccount(owner);

		for (const table of sweepableTables()) {
			expect(orphanCount(table, 'wallet', walletId), `${table} (wallet)`).toBe(0);
			expect(orphanCount(table, 'multisig', multisigId), `${table} (multisig)`).toBe(0);
		}
	});

	it('does not touch a live sibling wallet/multisig’s rows', async () => {
		const owner = await makeUser('owner-sibling@example.com');
		const goneWallet = makeWallet(owner);
		const keptWallet = makeWallet(owner);
		const goneMultisig = makeMultisig(owner);
		const keptMultisig = makeMultisig(owner);

		for (const table of sweepableTables()) {
			seedPolymorphicRow(table, 'wallet', goneWallet, owner);
			seedPolymorphicRow(table, 'wallet', keptWallet, owner);
			seedPolymorphicRow(table, 'multisig', goneMultisig, owner);
			seedPolymorphicRow(table, 'multisig', keptMultisig, owner);
		}

		expect(deleteWallet(owner, goneWallet)).toBe(true);
		expect(deleteMultisig(owner, goneMultisig)).toBe(true);

		for (const table of sweepableTables()) {
			expect(orphanCount(table, 'wallet', goneWallet), `${table} gone wallet`).toBe(0);
			expect(orphanCount(table, 'wallet', keptWallet), `${table} kept wallet`).toBe(1);
			expect(orphanCount(table, 'multisig', goneMultisig), `${table} gone multisig`).toBe(0);
			expect(orphanCount(table, 'multisig', keptMultisig), `${table} kept multisig`).toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// One-time migration purge (db.ts) — rows left behind by wallets/multisigs
// deleted BEFORE the triggers above existed. Runs as an ordinary module-load
// side effect on every db.ts import, so it's exercised here the same way
// db.vaultMigration.test.ts exercises the vault-rename migration: build a
// fixture database, close it, then import $lib/server/db FRESH (vi.resetModules
// + vi.stubEnv) against that file and confirm the module-load purge actually ran.
// ---------------------------------------------------------------------------

function tmpDbPath(label: string): string {
	return path.join(os.tmpdir(), `cairn-delete-cascade-${label}-${randomBytes(8).toString('hex')}.db`);
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

/** Loads $lib/server/db fresh against `dbPath`, forcing its top-level migration
 *  code (including the orphan purge) to actually run. */
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

describe('one-time orphan purge on db.ts import (cairn-97ui)', () => {
	it('removes rows whose (wallet_kind, wallet_id) no longer matches a live parent, and leaves live rows alone', async () => {
		const dbPath = tmpDbPath('purge');
		openDbPaths.push(dbPath);

		// First import: builds the schema (including the trigger pair) fresh.
		const first = await importDbAgainst(dbPath);
		const liveUserId = Number(
			first.db
				.prepare("INSERT INTO users (email, display_name) VALUES ('owner@example.com', 'Owner')")
				.run().lastInsertRowid
		);
		const liveWalletId = Number(
			first.db
				.prepare(
					"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', 'xpub-purge', 'p2wpkh')"
				)
				.run(liveUserId).lastInsertRowid
		);
		// A live row, tied to a wallet that still exists.
		first.db
			.prepare(
				"INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid) VALUES ('wallet', ?, ?, 'aa')"
			)
			.run(liveWalletId, liveUserId);
		// An orphan: exactly what the old hand-written cleanup left behind for
		// balance_snapshots (and would have left for the others too, pre-fix) —
		// a wallet_id with no matching row in `wallets` at all.
		const ghostWalletId = liveWalletId + 999_000;
		first.db
			.prepare(
				'INSERT INTO balance_snapshots (user_id, wallet_kind, wallet_id, taken_at, balance_sats) VALUES (?, ?, ?, ?, ?)'
			)
			.run(liveUserId, 'wallet', ghostWalletId, new Date().toISOString(), 5000);
		first.db
			.prepare('INSERT INTO notified_txids (wallet_kind, wallet_id, user_id, txid) VALUES (?, ?, ?, ?)')
			.run('wallet', ghostWalletId, liveUserId, 'bb');
		first.db.close();

		// Second import against the SAME file — simulates the app restarting
		// after this fix ships. The purge runs unconditionally on every import,
		// so it should clear the ghost rows this time (they didn't exist during
		// the first import) while leaving the live wallet's row untouched.
		const second = await importDbAgainst(dbPath);
		const ghostSnapshots = (
			second.db
				.prepare('SELECT COUNT(*) AS n FROM balance_snapshots WHERE wallet_id = ?')
				.get(ghostWalletId) as { n: number }
		).n;
		const ghostNotified = (
			second.db
				.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE wallet_id = ?')
				.get(ghostWalletId) as { n: number }
		).n;
		const liveNotified = (
			second.db
				.prepare('SELECT COUNT(*) AS n FROM notified_txids WHERE wallet_id = ?')
				.get(liveWalletId) as { n: number }
		).n;

		expect(ghostSnapshots).toBe(0);
		expect(ghostNotified).toBe(0);
		expect(liveNotified).toBe(1);
		second.db.close();
	});
});
