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

	-- Auth supports BOTH email+password (scrypt — the default) and passkeys
	-- (WebAuthn — optional/additive). password_hash is NULL for passkey-only
	-- accounts; passkeys live in user_credentials (below).
	CREATE TABLE IF NOT EXISTS users (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT,
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
		status       TEXT NOT NULL DEFAULT 'draft', -- draft | awaiting_signature | completed | superseded
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

	// Which signing device holds this wallet's key — 'trezor'|'ledger'|
	// 'coldcard'|'qr'|'file', mirroring multisig_keys.device_type. Routes the send
	// flow's Sign step to the right device and labels the wallet in the UI.
	// NULL until the user says (import or first send); a null device signs via
	// the universal file/PSBT fallback, so a wallet is always spendable.
	if (!walletCols.includes('device_type')) {
		db.exec('ALTER TABLE wallets ADD COLUMN device_type TEXT');
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

// Replace-by-fee lineage: a fee bump saves a NEW transaction row whose
// replaces_txid points at the txid it was built to replace; the original row
// is marked 'superseded' when the replacement broadcasts. Guarded and
// additive like the migrations above. See bumpTransaction in transactions.ts.
{
	const txCols = (db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!txCols.includes('replaces_txid')) {
		db.exec('ALTER TABLE transactions ADD COLUMN replaces_txid TEXT');
	}

	// Batch sends: a JSON array of { address, amount } covering EVERY output
	// recipient. NULL for single-recipient rows — `recipient`/`amount` stay the
	// canonical source there (and remain populated for batch rows too, holding
	// the first recipient and the total, so old rows and old queries keep
	// working). See mapRow in transactions.ts.
	if (!txCols.includes('recipients')) {
		db.exec('ALTER TABLE transactions ADD COLUMN recipients TEXT');
	}
}

// Terminology migration: "vault" → "multisig wallet". Databases created before
// the rename hold vaults / vault_keys / vault_transactions /
// ledger_vault_registrations with a vault_id foreign-key column. Rename them in
// place (data preserved) BEFORE the CREATE TABLE IF NOT EXISTS blocks below —
// otherwise those would create fresh empty tables and orphan the old data.
// Guarded and idempotent: a fresh database (no old tables) skips straight to
// the CREATEs; an already-migrated database is untouched. SQLite's RENAME TO
// also rewrites the child tables' foreign-key references automatically.
{
	const tableNames = new Set(
		(
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((t) => t.name)
	);
	const rowCount = (t: string) =>
		tableNames.has(t) ? (db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c : 0;

	// Empty-shell recovery: if a prior partial run (e.g. two dev servers on one
	// DB, or an app start between the rename landing in code and this migration
	// shipping) created EMPTY new tables alongside the still-populated old ones,
	// the plain rename below would skip (target exists) and orphan the real data.
	// Detect that exact case — old `vaults` has rows, new `multisigs` is empty —
	// and drop the empty shells (children before parent) so the rename can move
	// the real data across. Only ever discards provably-empty tables.
	if (tableNames.has('vaults') && rowCount('vaults') > 0 && rowCount('multisigs') === 0) {
		for (const t of [
			'multisig_keys',
			'multisig_transactions',
			'ledger_multisig_registrations',
			'multisigs'
		]) {
			if (tableNames.has(t)) {
				db.exec(`DROP TABLE ${t}`);
				tableNames.delete(t);
			}
		}
	}

	const renameTable = (from: string, to: string) => {
		if (tableNames.has(from) && !tableNames.has(to)) {
			db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
			tableNames.delete(from);
			tableNames.add(to);
		}
	};
	renameTable('vaults', 'multisigs');
	renameTable('vault_keys', 'multisig_keys');
	renameTable('vault_transactions', 'multisig_transactions');
	renameTable('ledger_vault_registrations', 'ledger_multisig_registrations');

	// Rename the vault_id foreign-key column on the (now-renamed) child tables.
	const renameCol = (table: string, from: string, to: string) => {
		if (!tableNames.has(table)) return;
		const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
			(c) => c.name
		);
		if (cols.includes(from) && !cols.includes(to)) {
			db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
		}
	};
	renameCol('multisig_keys', 'vault_id', 'multisig_id');
	renameCol('multisig_transactions', 'vault_id', 'multisig_id');
	renameCol('ledger_multisig_registrations', 'vault_id', 'multisig_id');

	// Drop the old-named indexes; the CREATE INDEX IF NOT EXISTS below re-adds
	// them under the new names.
	db.exec(`
		DROP INDEX IF EXISTS idx_vaults_user;
		DROP INDEX IF EXISTS idx_vault_keys_vault;
		DROP INDEX IF EXISTS idx_vault_transactions_vault;
	`);
}

// Multisigs: local M-of-N multisig where ONE user holds several keys — not
// collaborative custody, so there is no roster/session machinery; signing
// progress lives in the PSBT itself (see src/lib/server/bitcoin/multisigPsbt.ts)
// and quorum is threshold-of-keys. Key metadata is relational rather than a
// config JSON blob so the wizard can edit keys one at a time; the descriptor
// (the portable artifact) is derived on demand by src/lib/server/wallets/multisig.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS multisigs (
		id             INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name           TEXT NOT NULL,
		threshold      INTEGER NOT NULL,
		script_type    TEXT NOT NULL DEFAULT 'p2wsh', -- 'p2wsh' | 'p2sh-p2wsh' | 'p2sh'
		receive_cursor INTEGER NOT NULL DEFAULT 0,
		created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_multisigs_user ON multisigs(user_id);

	CREATE TABLE IF NOT EXISTS multisig_keys (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		multisig_id    INTEGER NOT NULL REFERENCES multisigs(id) ON DELETE CASCADE,
		position    INTEGER NOT NULL,          -- stable display/signing order
		name        TEXT NOT NULL,             -- "My Trezor", "Steel backup"
		category    TEXT NOT NULL,             -- 'hardware' | 'mobile' | 'recovery'
		device_type TEXT,                      -- 'trezor'|'ledger'|'coldcard'|'qr'|'file'; routes the signing stepper
		xpub        TEXT NOT NULL,
		fingerprint TEXT NOT NULL,             -- 8 lowercase hex; '00000000' when unknown
		path        TEXT NOT NULL,             -- "m/48'/0'/0'/2'" (BIP-48)
		UNIQUE (multisig_id, position),
		UNIQUE (multisig_id, xpub)
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_keys_multisig ON multisig_keys(multisig_id);

	-- Ledger requires a BIP-388 wallet-policy registration (an on-device
	-- approval yielding an HMAC) before it will sign for a multisig policy.
	-- The HMAC is not a secret — storing it only spares the user re-approving
	-- the same multisig on-device every session. One registration per device
	-- (master fingerprint) per multisig.
	CREATE TABLE IF NOT EXISTS ledger_multisig_registrations (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		multisig_id    INTEGER NOT NULL REFERENCES multisigs(id) ON DELETE CASCADE,
		master_fp   TEXT NOT NULL,             -- 8 lowercase hex
		policy_name TEXT NOT NULL,             -- <=64 ASCII, shown on-device
		policy_hmac TEXT NOT NULL,             -- 64 hex chars (32 bytes)
		policy_id   TEXT,
		created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (multisig_id, master_fp)
	);
`);

// Multisig spends: DELIBERATELY a parallel table to `transactions` rather than a
// nullable wallet_id/multisig_id merge — wallet queries (and their indexes,
// cascades, and status vocabulary) stay untouched, and the two lifecycles can
// diverge freely (multisigs collect M signatures per spend and have no RBF bump
// lineage yet; wallets have replaces_txid/superseded). Columns mirror
// `transactions` where the meaning is identical: `psbt` holds the CURRENT
// combined PSBT and is replaced as each key's signature merges in; quorum
// progress is never stored — it is derived from the PSBT by multisigPsbtProgress
// (src/lib/server/bitcoin/multisigPsbt.ts), which cannot disagree with reality.
// broadcast_started_at is the same atomic broadcast-claim marker transactions
// uses. See src/lib/server/multisigTransactions.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS multisig_transactions (
		id                   INTEGER PRIMARY KEY AUTOINCREMENT,
		multisig_id             INTEGER NOT NULL REFERENCES multisigs(id) ON DELETE CASCADE,
		status               TEXT NOT NULL DEFAULT 'draft', -- draft | awaiting_signature | completed
		psbt                 TEXT NOT NULL,                 -- base64, the working combined PSBT
		txid                 TEXT,                          -- set once broadcast
		recipient            TEXT NOT NULL,                 -- first recipient (display anchor)
		amount               INTEGER NOT NULL,              -- total sats across recipients
		recipients           TEXT,                          -- JSON breakdown for batch sends, NULL for single
		fee                  INTEGER NOT NULL,              -- sats
		fee_rate             REAL NOT NULL,                 -- sat/vB at construction time
		change_index         INTEGER,                       -- multisig change-chain index, NULL when changeless
		broadcast_started_at TEXT,                          -- in-flight broadcast claim (see transactions)
		created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_transactions_multisig ON multisig_transactions(multisig_id);
`);

// User-facing activity feed (adapted from Bastion's audit_log, but for
// friendly "here's what your instance is doing" events rather than a security
// trail). One row per notable happening. user_id is NULL for instance-wide
// events (network up/down, new block, electrum switch) that every user sees;
// otherwise it scopes the event to one user (their broadcast, their scan, their
// signing session). `detail` holds a small JSON blob of non-secret structured
// fields (height, txid, counts, server names) — never PSBTs, keys, or tokens.
// Pruned to the most recent EVENTS_PER_BUCKET rows per user (and per the NULL
// bucket) by recordActivity in src/lib/server/activity.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS events (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE, -- NULL = instance-wide
		type       TEXT NOT NULL,                                  -- 'new_block' | 'broadcast' | ...
		level      TEXT NOT NULL DEFAULT 'info',                   -- 'info'|'success'|'warn'|'error' (UI tone)
		message    TEXT NOT NULL,                                  -- human-friendly, already formatted
		detail     TEXT,                                           -- optional JSON of structured fields
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, id DESC);
`);

// Passkey (WebAuthn) credentials — auth is passkey-only, no passwords. Each
// user can register several (phone + laptop + security key), so an account never
// depends on a single device. See src/lib/server/webauthn.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS user_credentials (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		credential_id TEXT NOT NULL UNIQUE,   -- base64url credential id
		public_key    TEXT NOT NULL,          -- base64url COSE public key
		counter       INTEGER NOT NULL DEFAULT 0,
		transports    TEXT,                   -- JSON array of transport hints
		device_type   TEXT,                   -- 'singleDevice' | 'multiDevice'
		backed_up     INTEGER NOT NULL DEFAULT 0,
		name          TEXT,                   -- user-friendly label ("iPhone", "YubiKey")
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_used_at  TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_user_credentials_user ON user_credentials(user_id);
`);

// Password auth is the default; passkeys are additive. A database that briefly
// ran the passkey-only build had password_hash dropped — add it back (nullable;
// NULL just means a passkey-only account). Guarded and idempotent.
{
	const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!userCols.includes('password_hash')) {
		db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
	}
}

// Key health checks (Casa's periodic-verification pattern): a multisig key you
// haven't recently proven you still control is a silent liability — devices
// die, PINs get forgotten, a device restored from the wrong seed keeps working
// for everything except THIS multisig. Casa's answer is a per-key "last verified"
// timestamp plus a periodic nudge when any key goes unchecked too long
// (~6 months); we store exactly that. Only the timestamp is recorded — HOW the
// key was verified (device re-read vs guided manual check) is deliberately not,
// because either proof is only as fresh as the moment it happened. NULL means
// never verified. Guarded and additive like the migrations above; see
// markKeyVerified in src/lib/server/wallets/multisig.ts.
{
	const keyCols = (db.prepare('PRAGMA table_info(multisig_keys)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!keyCols.includes('last_verified_at')) {
		db.exec('ALTER TABLE multisig_keys ADD COLUMN last_verified_at TEXT');
	}
}
