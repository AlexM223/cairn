import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';

const DB_PATH = env.CAIRN_DB ?? path.join(process.cwd(), 'data', 'cairn.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
	PRAGMA busy_timeout = 5000;

	CREATE TABLE IF NOT EXISTS users (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		display_name  TEXT NOT NULL,
		is_admin      INTEGER NOT NULL DEFAULT 0,
		disabled      INTEGER NOT NULL DEFAULT 0,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_login    TEXT
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		token_hash TEXT NOT NULL UNIQUE,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		expires_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

	CREATE TABLE IF NOT EXISTS wallets (
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
	CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

	CREATE TABLE IF NOT EXISTS invites (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		code       TEXT NOT NULL UNIQUE,
		label      TEXT,
		created_by INTEGER NOT NULL REFERENCES users(id),
		max_uses   INTEGER NOT NULL DEFAULT 1,
		used_count INTEGER NOT NULL DEFAULT 0,
		revoked    INTEGER NOT NULL DEFAULT 0,
		expires_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS transactions (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		wallet_id    INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
		status       TEXT NOT NULL DEFAULT 'draft', -- draft | awaiting_signature | completed
		psbt         TEXT NOT NULL,                 -- base64, replaced as signatures arrive
		txid         TEXT,                          -- set once broadcast
		recipient    TEXT NOT NULL,
		amount       INTEGER NOT NULL,              -- sats to the recipient
		fee          INTEGER NOT NULL,              -- sats
		fee_rate     REAL NOT NULL,                 -- sat/vB at construction time
		change_index INTEGER,                       -- change-chain index, null when changeless
		created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);

	CREATE TABLE IF NOT EXISTS tx_labels (
		wallet_id  INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
		txid       TEXT NOT NULL,
		label      TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		PRIMARY KEY (wallet_id, txid)
	);
`);

// Columns added after the original schema shipped — guarded so existing
// databases upgrade in place. (The signing flows need the key's origin to
// embed BIP32 derivation info in PSBTs; both stay null until provided.)
{
	const walletCols = (db.prepare('PRAGMA table_info(wallets)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!walletCols.includes('master_fingerprint')) {
		db.exec('ALTER TABLE wallets ADD COLUMN master_fingerprint TEXT');
	}
	if (!walletCols.includes('derivation_path')) {
		db.exec('ALTER TABLE wallets ADD COLUMN derivation_path TEXT');
	}

	// In-flight broadcast claim marker: set atomically before a broadcast goes
	// out to the network so concurrent broadcast attempts cannot double-send;
	// cleared again when a broadcast fails (successful ones set txid instead).
	const txCols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!txCols.includes('broadcast_started_at')) {
		db.exec('ALTER TABLE transactions ADD COLUMN broadcast_started_at TEXT');
	}
}

// Address book: saved recipients, scoped to the user (not the wallet — who you
// pay doesn't depend on which wallet you pay from). Kept in its own exec so it
// lands on existing databases too. See src/lib/server/addressBook.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS saved_addresses (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		label        TEXT NOT NULL,
		address      TEXT NOT NULL,
		created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_used_at TEXT,
		UNIQUE (user_id, address)
	);
	CREATE INDEX IF NOT EXISTS idx_saved_addresses_user ON saved_addresses(user_id);
`);
