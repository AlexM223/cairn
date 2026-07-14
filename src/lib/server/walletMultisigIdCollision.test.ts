// cairn-n4az — the collision half of the polymorphic (wallet_kind, wallet_id)
// follow-up. wallets.id and multisigs.id are DISJOINT AUTOINCREMENT spaces that
// BOTH start at 1, so wallet_id=N and multisig_id=N coexisting is not a rare
// edge case — it is the steady state once both tables have more than a
// handful of rows. cairn-97ui's deleteCascade.test.ts already proves the
// delete-sweep triggers never orphan or cross-touch rows; this file proves
// the OTHER half the cairn-n4az audit calls for: with a live wallet and a live
// multisig sharing the same numeric id, every read/write through the actual
// service layer (address labels, backup-tracked status, balance snapshots)
// stays correctly scoped to its own kind, and the delete-sweep triggers only
// ever touch the (kind, id) pair that was actually deleted — never the OTHER
// kind's row at the same numeric id.
//
// The generic sweep at the bottom reuses deleteCascade.test.ts's introspection
// idiom (discover every table shaped like (wallet_kind, wallet_id) from
// sqlite_master, don't hardcode the list) so a table added later is covered
// automatically, directly operationalizing the audit task from the bead: "grep
// every 'wallet_id = ?' predicate lacking a wallet_kind companion" — expressed
// here as a data-level guarantee instead of a source grep.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { deleteWallet } from './wallets';
import { deleteMultisig } from './wallets/multisig';
import { getAddressLabels, setAddressLabel } from './addressLabels';
import { markBackedUp, isBackedUp } from './backups';
import { recordSnapshot, getSparklines } from './portfolio';

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM address_labels; DELETE FROM wallet_backups;
		 DELETE FROM backup_missing_notified; DELETE FROM balance_snapshots; DELETE FROM wallet_snapshots;
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

/** Insert a wallet/multisig at an EXPLICIT id, so the collision doesn't depend
 *  on incidental autoincrement state lining up — it is forced and guaranteed. */
function makeWalletAt(id: number, userId: number): void {
	db.prepare(
		"INSERT INTO wallets (id, user_id, name, xpub, script_type) VALUES (?, ?, 'w', ?, 'p2wpkh')"
	).run(id, userId, `xpub-collide-${id}`);
}

function makeMultisigAt(id: number, userId: number): void {
	db.prepare(
		"INSERT INTO multisigs (id, user_id, name, threshold, script_type) VALUES (?, ?, 'ms', 2, 'p2wsh')"
	).run(id, userId);
}

describe('wallet/multisig id collision — service-layer reads stay kind-scoped (cairn-n4az)', () => {
	it('address labels, backup status, and balance snapshots never bleed across a shared numeric id', async () => {
		const owner = await makeUser('collision-live@example.com');
		const id = 555_555;
		makeWalletAt(id, owner);
		makeMultisigAt(id, owner);

		// Address labels: same id, different kind, different address+label.
		setAddressLabel(owner, 'wallet', id, 'addr-w', 'wallet label');
		setAddressLabel(owner, 'multisig', id, 'addr-m', 'multisig label');
		expect(getAddressLabels(owner, 'wallet', id)).toEqual({ 'addr-w': 'wallet label' });
		expect(getAddressLabels(owner, 'multisig', id)).toEqual({ 'addr-m': 'multisig label' });

		// Backup status: mark only the wallet as backed up.
		markBackedUp(owner, 'wallet', id);
		expect(isBackedUp('wallet', id)).toBe(true);
		expect(isBackedUp('multisig', id)).toBe(false);

		// Balance snapshots + the sparkline reader that groups by `${kind}-${id}`.
		recordSnapshot(owner, [
			{ kind: 'wallet', id, balance: 1_000 },
			{ kind: 'multisig', id, balance: 2_000 }
		]);
		const sparklines = getSparklines(owner);
		expect(sparklines[`wallet-${id}`]).toEqual([1_000]);
		expect(sparklines[`multisig-${id}`]).toEqual([2_000]);

		// Deleting the WALLET must sweep only the wallet's rows at this id — the
		// multisig's rows at the SAME numeric id must survive untouched.
		expect(deleteWallet(owner, id)).toBe(true);
		expect(getAddressLabels(owner, 'multisig', id)).toEqual({ 'addr-m': 'multisig label' });
		expect(isBackedUp('multisig', id)).toBe(false); // untouched (never set for multisig)
		expect(getSparklines(owner)[`multisig-${id}`]).toEqual([2_000]);

		// The multisig itself is unaffected — deleteMultisig on the SAME id still
		// finds and removes exactly the multisig's row, not a phantom left by the
		// wallet delete. (Read via raw SQL, not getAddressLabels: once the parent
		// multisig row is gone, the access re-check in addressLabels.ts correctly
		// refuses — the sweep itself is what this asserts, not API access.)
		expect(deleteMultisig(owner, id)).toBe(true);
		const remaining = db
			.prepare("SELECT COUNT(*) AS n FROM address_labels WHERE wallet_kind = 'multisig' AND wallet_id = ?")
			.get(id) as { n: number };
		expect(remaining.n).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Generic data-level guarantee: for every table shaped like the polymorphic
// (wallet_kind, wallet_id) pattern (discovered, not hardcoded — see
// deleteCascade.test.ts), seeding one row per kind at the SAME colliding id
// must read back exactly one row per kind, and deleting one kind's parent must
// leave the other kind's row at that id alone.
// ---------------------------------------------------------------------------

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

function fkColumnsTo(table: string, targetTable: string): Set<string> {
	const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
		table: string;
		from: string;
	}[];
	return new Set(rows.filter((r) => r.table === targetTable).map((r) => r.from));
}

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
			continue;
		} else if (c.dflt_value !== null) {
			continue;
		} else if (c.notnull === 0) {
			continue;
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
	db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(
		...values
	);
}

function countAt(table: string, kind: 'wallet' | 'multisig', id: number): number {
	return (
		db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE wallet_kind = ? AND wallet_id = ?`)
			.get(kind, id) as { n: number }
	).n;
}

describe('every polymorphic (wallet_kind, wallet_id) table stays kind-scoped at a colliding id (cairn-n4az)', () => {
	it('seeding both kinds at the same id reads back exactly one row per kind, and deleting one kind leaves the other alone', async () => {
		const owner = await makeUser('collision-generic@example.com');
		const id = 777_777;
		makeWalletAt(id, owner);
		makeMultisigAt(id, owner);

		const tables = discoverPolymorphicTables();
		expect(tables.length).toBeGreaterThan(0); // discovery itself must not be vacuous

		for (const table of tables) {
			seedPolymorphicRow(table, 'wallet', id, owner);
			seedPolymorphicRow(table, 'multisig', id, owner);
		}

		for (const table of tables) {
			expect(countAt(table, 'wallet', id), `${table} (wallet, before delete)`).toBe(1);
			expect(countAt(table, 'multisig', id), `${table} (multisig, before delete)`).toBe(1);
		}

		expect(deleteWallet(owner, id)).toBe(true);

		for (const table of tables) {
			expect(countAt(table, 'wallet', id), `${table} (wallet, after wallet delete)`).toBe(0);
			expect(countAt(table, 'multisig', id), `${table} (multisig, after wallet delete)`).toBe(1);
		}

		expect(deleteMultisig(owner, id)).toBe(true);

		for (const table of tables) {
			expect(countAt(table, 'multisig', id), `${table} (multisig, after multisig delete)`).toBe(0);
		}
	});
});
