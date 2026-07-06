import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { childLogger } from './logger';

const log = childLogger('db');

// Exported so colocated instance state (e.g. secretKey.ts's `instance.key`) can
// live NEXT TO the DB file on the same persistent volume — under Docker/Umbrel
// that is the mounted /data volume (CAIRN_DB), not process.cwd().
export const DB_PATH = env.CAIRN_DB ?? path.join(process.cwd(), 'data', 'cairn.db');

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
	// the real data across. Only ever discards provably-empty tables: we verify
	// EACH shell table (parent and every child) is independently empty before
	// dropping any of them, rather than assuming the children are empty because
	// the parent is (FK-cascade semantics). If any child holds rows while the
	// parent is empty — the precise data-loss anomaly this migration exists to
	// catch — we abort the recovery and leave every table intact. rowCount()
	// already returns 0 for tables that do not exist, so absent children are
	// treated as empty. (The rename below then no-ops on the pre-existing
	// targets, surfacing the inconsistency rather than silently destroying data.)
	if (tableNames.has('vaults') && rowCount('vaults') > 0 && rowCount('multisigs') === 0) {
		const shellTables = [
			'multisig_keys',
			'multisig_transactions',
			'ledger_multisig_registrations',
			'multisigs'
		];
		const nonEmptyShells = shellTables.filter((t) => rowCount(t) > 0);
		if (nonEmptyShells.length > 0) {
			log.warn(
				{ nonEmptyShells },
				`[db migration] Skipping empty-shell recovery: 'multisigs' is empty but ` +
					`shell table(s) ${nonEmptyShells.join(', ')} hold rows. Leaving all tables ` +
					`intact to avoid data loss; manual reconciliation required.`
			);
		} else {
			for (const t of shellTables) {
				if (tableNames.has(t)) {
					db.exec(`DROP TABLE ${t}`);
					tableNames.delete(t);
				}
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

// Portfolio balance snapshots: one row per wallet per sampling tick, so the
// dashboard can chart total value over time and draw per-wallet sparklines.
// A tick samples EVERY wallet at the same `taken_at`, so the total series is
// SUM(balance_sats) GROUP BY taken_at and a wallet's sparkline is its own rows
// ordered by time. Sampling is lazy + throttled (see recordSnapshot in
// src/lib/server/portfolio.ts) — reusing the balances a portfolio fetch already
// computed, so no extra chain load. wallet_kind tells single-sig ('wallet')
// from multisig ('multisig') since their ids share no space.
db.exec(`
	CREATE TABLE IF NOT EXISTS balance_snapshots (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		wallet_kind  TEXT NOT NULL,                 -- 'wallet' | 'multisig'
		wallet_id    INTEGER NOT NULL,              -- id within its kind's table
		taken_at     TEXT NOT NULL,                 -- ISO 8601; shared across a tick
		balance_sats INTEGER NOT NULL               -- confirmed sats at that moment
	);
	CREATE INDEX IF NOT EXISTS idx_balance_snapshots_user ON balance_snapshots(user_id, taken_at);
	CREATE INDEX IF NOT EXISTS idx_balance_snapshots_wallet
		ON balance_snapshots(user_id, wallet_kind, wallet_id, taken_at);
`);

// Legal disclosure acceptances (see src/lib/server/disclosures.ts). Two records:
//  • admin_disclosure_acceptances — the operator's one-time acknowledgement,
//    during first-run, that they run infrastructure (not custody). One row per
//    admin who accepted.
//  • user_agreement_acceptances — a clickwrap record per user per agreement
//    version: which version they accepted, when, and from which IP (kept for the
//    operator's legal record). A version bump (admin edits the terms) means the
//    user's latest accepted version < current, and they must accept again.
// The agreement TEXT, operator name, and current version live in `settings`.
db.exec(`
	CREATE TABLE IF NOT EXISTS admin_disclosure_acceptances (
		user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
		accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		version     INTEGER NOT NULL,   -- the user_agreement_version accepted
		accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		ip          TEXT,               -- best-effort client IP at acceptance
		UNIQUE (user_id, version)
	);
	CREATE INDEX IF NOT EXISTS idx_user_agreement_acceptances_user
		ON user_agreement_acceptances(user_id);
`);

// Wallet-config backup tracking (see src/lib/server/backups.ts). Losing a
// wallet's configuration — the public keys + settings needed to find and, for
// multisig, RECONSTRUCT the wallet — can mean permanently losing access to
// funds, so backup status is treated as first-class and tracked server-side
// (not just a localStorage flag). One row per wallet once its config file has
// been downloaded. wallet_kind ('wallet' | 'multisig') disambiguates the id,
// which is not unique across the two tables.
db.exec(`
	CREATE TABLE IF NOT EXISTS wallet_backups (
		user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		wallet_kind   TEXT NOT NULL,   -- 'wallet' | 'multisig'
		wallet_id     INTEGER NOT NULL,
		downloaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		PRIMARY KEY (wallet_kind, wallet_id)
	);
	CREATE INDEX IF NOT EXISTS idx_wallet_backups_user ON wallet_backups(user_id);
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

// Persisted portfolio scan cache (see src/lib/server/scanCachePersist.ts and
// cairn-er1k). One row per unique wallet xpub / multisig descriptor holding the
// LAST completed scan result (balances, tx summary, scanned addresses) as JSON.
// Purely a performance cache: on a cold restart these rows seed the in-memory
// 60s scan caches so the first portfolio/detail request serves instant (if
// slightly stale) data instead of paying a full serialized Electrum re-scan,
// which the warm pass then refreshes. Never authoritative — a missing, corrupt,
// or absent row just falls back to a live scan. `kind` disambiguates the key
// space ('wallet' = xpub, 'multisig' = receive descriptor). Deleted by
// invalidateWalletCache/invalidateMultisigCache when a wallet is removed or the
// backend changes, so stale data for a gone wallet can never leak.
db.exec(`
	CREATE TABLE IF NOT EXISTS wallet_scan_cache (
		cache_key  TEXT PRIMARY KEY,   -- xpub (wallet) or receive descriptor (multisig)
		kind       TEXT NOT NULL,      -- 'wallet' | 'multisig'
		result     TEXT NOT NULL,      -- JSON of WalletScanResult / MultisigScanResult
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_wallet_scan_cache_kind ON wallet_scan_cache(kind);
`);

// Address-level labels (see src/lib/server/addressLabels.ts and cairn-nbsx).
// Complements tx_labels: lets a user annotate WHY an individual address exists
// ("exchange deposit", "donation address") independent of any single tx. One row
// per (wallet_kind, wallet_id, address). wallet_kind ('wallet' | 'multisig')
// disambiguates the id, which isn't unique across the two tables — so there's no
// single FK; rows are cleared explicitly when a wallet/multisig is deleted
// (deleteWallet / deleteMultisig), same pattern as notified_txids. Private to the
// instance, never shared.
db.exec(`
	CREATE TABLE IF NOT EXISTS address_labels (
		wallet_kind TEXT NOT NULL,   -- 'wallet' | 'multisig'
		wallet_id   INTEGER NOT NULL,
		address     TEXT NOT NULL,
		label       TEXT NOT NULL,
		created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		PRIMARY KEY (wallet_kind, wallet_id, address)
	);
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

// Account recovery secrets — how a user gets back INTO Cairn (their LOGIN) after
// losing every passkey, NOT how they recover bitcoin. These secrets restore the
// login only; they can never move or reveal bitcoin, whose keys live entirely on
// the hardware wallet. Two independent mechanisms, both stored ONLY as salted
// scrypt hashes (never plaintext), mirroring password_hash's format:
//   • account_recovery_phrases — a 12-word phrase, one per user, reusable.
//   • account_recovery_codes   — 8 single-use codes; used_at marks a spent code.
// Regeneration replaces the prior secret(s) (see src/lib/server/recovery.ts).
// A separate short-TTL recovery_grants table authorizes ONLY the "register a new
// passkey" step after a successful recovery verify — it is NOT a full session;
// it mirrors the sessions table (opaque token, hash stored) so it survives a
// restart without any new signing secret. See recovery.ts + the recover routes.
db.exec(`
	CREATE TABLE IF NOT EXISTS account_recovery_phrases (
		user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
		phrase_hash TEXT NOT NULL,          -- salted scrypt hash (auth.ts format)
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS account_recovery_codes (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		code_hash  TEXT NOT NULL,           -- salted scrypt hash (auth.ts format)
		used_at    TEXT,                    -- NULL = unused; set atomically on spend
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_account_recovery_codes_user ON account_recovery_codes(user_id);

	CREATE TABLE IF NOT EXISTS recovery_grants (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		token_hash TEXT NOT NULL UNIQUE,    -- sha256 of the opaque grant token
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		purpose    TEXT NOT NULL DEFAULT 'register_passkey',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		expires_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_recovery_grants_user ON recovery_grants(user_id);
`);

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

// Notification system (see docs/NOTIFICATION-PLAN.md). An in-app notification IS
// an `events` row (activity.ts) — `read_at` adds per-view read tracking to that
// existing table rather than a parallel one. The four tables below hold routing
// preferences, per-channel connection config, optional PGP keys for the email
// channel, and the outbound delivery queue for every non-inapp channel.
{
	const evCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!evCols.includes('read_at')) {
		db.exec('ALTER TABLE events ADD COLUMN read_at TEXT');
	}
	db.exec('CREATE INDEX IF NOT EXISTS idx_events_user_unread ON events(user_id, read_at)');
}
db.exec(`
	-- Per-user, per-event-type channel routing. A row's ABSENCE means "use the
	-- default for this event type" (DEFAULT_PREFERENCES in notifications.ts).
	CREATE TABLE IF NOT EXISTS notification_preferences (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		event_type TEXT NOT NULL,
		channel    TEXT NOT NULL,   -- one of NOTIFICATION_CHANNELS
		enabled    INTEGER NOT NULL DEFAULT 1,
		config     TEXT,            -- per-event-type tunables (thresholds), JSON
		UNIQUE (user_id, event_type, channel)
	);
	CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);

	-- Per-user, per-channel CONNECTION config. One row per (user, channel).
	-- Never returned to the client verbatim (see getPublicChannelConfig).
	CREATE TABLE IF NOT EXISTS notification_channel_config (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		channel     TEXT NOT NULL,
		config      TEXT NOT NULL,   -- JSON blob, shape is per-channel
		verified_at TEXT,            -- last successful test()/send; NULL = never confirmed
		created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (user_id, channel)
	);
	CREATE INDEX IF NOT EXISTS idx_notification_channel_config_user ON notification_channel_config(user_id);

	-- PGP public keys for the email channel's optional encryption. Distinct
	-- lifecycle from whether email is even on, hence its own table.
	CREATE TABLE IF NOT EXISTS user_pgp_keys (
		user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
		public_key  TEXT NOT NULL,   -- ASCII-armored public key block
		fingerprint TEXT NOT NULL,   -- computed at upload, shown for cross-check
		created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	-- Outbound delivery queue for every NON-inapp channel (in-app delivery is
	-- the events row itself). Retry with backoff; dead after max attempts. The
	-- payload is a serialized NotificationPayload and NEVER carries secrets.
	CREATE TABLE IF NOT EXISTS notification_queue (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		channel         TEXT NOT NULL,
		event_type      TEXT NOT NULL,
		payload         TEXT NOT NULL,                    -- JSON NotificationPayload
		status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'sent'|'failed'|'dead'
		attempts        INTEGER NOT NULL DEFAULT 0,
		last_error      TEXT,
		next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		sent_at         TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_notification_queue_pending ON notification_queue(status, next_attempt_at);
	CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id, id DESC);

	-- Per-user delivery preferences that aren't per-event routing (cairn-5gpv.4).
	-- Quiet hours: a do-not-disturb window during which routine (info/success)
	-- external-channel sends are DEFERRED to the window's end rather than dropped.
	-- Times are 'HH:MM' interpreted in quiet_tz (an IANA zone; NULL = server local).
	-- quiet_urgent_override=1 lets warn/error events (security alerts) still deliver
	-- inside the window. One row per user; absence means quiet hours are off.
	CREATE TABLE IF NOT EXISTS user_notification_settings (
		user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		quiet_enabled         INTEGER NOT NULL DEFAULT 0,
		quiet_start           TEXT,                       -- 'HH:MM' local
		quiet_end             TEXT,                       -- 'HH:MM' local
		quiet_tz              TEXT,                       -- IANA tz name; NULL = server local
		quiet_urgent_override INTEGER NOT NULL DEFAULT 1  -- warn/error bypass the window
	);

	-- Throttle memory for the backup_missing detector (cairn-evp9): one row per
	-- wallet we've nudged about a never-downloaded backup, so the daily scan
	-- re-nudges at most once per renotify window instead of every day. Mirrors
	-- multisig_keys.last_notified_at's guard, but for wallets that have no
	-- wallet_backups row at all.
	CREATE TABLE IF NOT EXISTS backup_missing_notified (
		wallet_kind TEXT NOT NULL,               -- 'wallet' | 'multisig'
		wallet_id   INTEGER NOT NULL,
		notified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		PRIMARY KEY (wallet_kind, wallet_id)
	);
`);

// Device tracking for new-device login alerts (cairn-5gpv.6). The sessions table
// gains the user_agent / IP captured at creation, and known_devices is the small
// per-user set of device fingerprints we've seen — a login from an unrecognized
// fingerprint fires security_new_device (but never the user's FIRST device).
{
	const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!sessionCols.includes('user_agent')) db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT');
	if (!sessionCols.includes('ip_address')) db.exec('ALTER TABLE sessions ADD COLUMN ip_address TEXT');
}
db.exec(`
	CREATE TABLE IF NOT EXISTS known_devices (
		user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		fingerprint TEXT NOT NULL,               -- sha256 of the user-agent (coarse)
		user_agent  TEXT,
		first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		PRIMARY KEY (user_id, fingerprint)
	);
`);

// Notification event hooks (Unit 8, docs/NOTIFICATION-PLAN.md §3). The address
// watcher (src/lib/server/addressWatcher.ts) subscribes each wallet/multisig
// address in its gap window over Electrum and, on a change, diffs the address's
// tx history against what it has already alerted on — this table is that memory.
// Without it, a server restart would re-notify for every historical transaction
// that predates this feature. wallet_kind ('wallet'|'multisig') disambiguates
// the two id spaces, exactly like balance_snapshots. One row per (kind, wallet,
// txid) the user has been notified about; the `confirmed` flag lets the
// block-tip pass fire a single tx_confirmed once a previously-mempool tx
// crosses into a block.
db.exec(`
	CREATE TABLE IF NOT EXISTS notified_txids (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		wallet_kind  TEXT NOT NULL,                  -- 'wallet' | 'multisig'
		wallet_id    INTEGER NOT NULL,               -- id within its kind's table
		user_id      INTEGER NOT NULL,               -- owner (who gets the notification)
		txid         TEXT NOT NULL,
		confirmed    INTEGER NOT NULL DEFAULT 0,     -- 1 once a tx_confirmed has fired
		created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (wallet_kind, wallet_id, user_id, txid)
	);
	CREATE INDEX IF NOT EXISTS idx_notified_txids_wallet ON notified_txids(wallet_kind, wallet_id);
`);

// cairn-7tst: the dedup key must include user_id. The original schema used
// UNIQUE(wallet_kind, wallet_id, txid), which — once collaborative custody wires
// up shared wallets — would let the FIRST collaborator's insert silently suppress
// every co-owner's tx_received/tx_confirmed notification for that txid. Widen the
// constraint to be per-recipient. SQLite can't ALTER a constraint in place, so
// rebuild the table when the old (narrower) shape is detected. Multisigs are
// single-owner today, so this rebuild is a lossless 1:1 copy of existing rows.
{
	const ntSql = (
		db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notified_txids'")
			.get() as { sql: string } | undefined
	)?.sql;
	// Old shape lacks user_id in the UNIQUE list; new shape has "user_id, txid)".
	if (ntSql && !/user_id\s*,\s*txid\s*\)/i.test(ntSql)) {
		db.exec(`
			ALTER TABLE notified_txids RENAME TO notified_txids_old;
			CREATE TABLE notified_txids (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				wallet_kind  TEXT NOT NULL,
				wallet_id    INTEGER NOT NULL,
				user_id      INTEGER NOT NULL,
				txid         TEXT NOT NULL,
				confirmed    INTEGER NOT NULL DEFAULT 0,
				created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				UNIQUE (wallet_kind, wallet_id, user_id, txid)
			);
			INSERT INTO notified_txids (id, wallet_kind, wallet_id, user_id, txid, confirmed, created_at)
				SELECT id, wallet_kind, wallet_id, user_id, txid, confirmed, created_at
				FROM notified_txids_old;
			DROP TABLE notified_txids_old;
			CREATE INDEX IF NOT EXISTS idx_notified_txids_wallet ON notified_txids(wallet_kind, wallet_id);
		`);
	}
}

// Key-health nudge throttle. key_health_due fires when a multisig key hasn't
// been verified in ~180 days; this column records the last time we notified for
// THAT key so we don't nag more than once per 30 days. Guarded/idempotent ALTER,
// same convention as last_verified_at above. NULL = never notified.
{
	const keyCols = (db.prepare('PRAGMA table_info(multisig_keys)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!keyCols.includes('last_notified_at')) {
		db.exec('ALTER TABLE multisig_keys ADD COLUMN last_notified_at TEXT');
	}
}

// Periodic wallet-config backup reminders (cairn-2xhw). Per-user dismissal
// timestamp for the "it's been a while since you downloaded your wallet
// backups" nudge; the nudge re-appears once it's older than the reminder
// interval. "Last backup" itself is derived from wallet_backups.downloaded_at
// (see src/lib/server/backups.ts), so only the dismissal needs storing here.
db.exec(`
	CREATE TABLE IF NOT EXISTS backup_reminders (
		user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		dismissed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`);

// Collaborative custody (see docs/COLLABORATIVE-CUSTODY-PLAN.md). Single-instance
// only — several accounts on ONE Cairn instance sharing one multisig wallet. NO
// federation/cross-instance concept exists or is planned. These tables extend the
// EXISTING multisig system (multisigs/multisig_keys/multisig_transactions) rather
// than building a parallel one: there is exactly one multisig-transaction
// lifecycle, usable by one owner or several cosigners.
db.exec(`
	-- Friends-only social graph. A wallet can only be shared with an ACCEPTED
	-- contact (a cheap guard against social-engineering a share via a leaked
	-- user id). Anti-enumeration: requestContact returns the same success shape
	-- whether or not the target email exists (see contacts.ts).
	CREATE TABLE IF NOT EXISTS contacts (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- requester
		contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- target
		status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
		created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (user_id, contact_user_id),
		CHECK (user_id <> contact_user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_contacts_contact_user ON contacts(contact_user_id);

	-- Share a multisig wallet with another user on this SAME instance. wallet_kind
	-- is future-proofing only ('multisig' for every v1 row). Key-to-user
	-- assignment lives on multisig_keys.assigned_user_id (below), NOT here, so a
	-- user holding two keys is simply two key rows with the same assigned_user_id.
	CREATE TABLE IF NOT EXISTS multisig_shares (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		wallet_kind     TEXT NOT NULL DEFAULT 'multisig',
		multisig_id     INTEGER NOT NULL REFERENCES multisigs(id) ON DELETE CASCADE,
		owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		shared_with_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		role            TEXT NOT NULL DEFAULT 'viewer', -- 'viewer' | 'cosigner'
		created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (multisig_id, shared_with_id),
		CHECK (owner_id <> shared_with_id)
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_shares_shared_with ON multisig_shares(shared_with_id);
	CREATE INDEX IF NOT EXISTS idx_multisig_shares_multisig ON multisig_shares(multisig_id);

	-- Roster for one multisig_transactions row: which users are expected to
	-- contribute a signature, and whether they have. FROZEN at transaction-
	-- creation time — later share changes don't touch an in-flight roster.
	-- assigned_key_ids is a denormalized JSON snapshot (NOT a live join) so a
	-- later key reassignment can't rewrite history. has_signed is advisory/UI
	-- only; the authoritative signature state always comes from
	-- multisigPsbtProgress() reading the actual PSBT bytes.
	CREATE TABLE IF NOT EXISTS multisig_transaction_signers (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		transaction_id   INTEGER NOT NULL REFERENCES multisig_transactions(id) ON DELETE CASCADE,
		user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		assigned_key_ids TEXT NOT NULL,   -- JSON array of multisig_keys.id
		has_signed       INTEGER NOT NULL DEFAULT 0,
		signed_at        TEXT,
		created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (transaction_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_tx_signers_tx ON multisig_transaction_signers(transaction_id);
	CREATE INDEX IF NOT EXISTS idx_multisig_tx_signers_user ON multisig_transaction_signers(user_id);
`);
// Assign a quorum key to a specific collaborator. NULL = unassigned (every key
// of a solo multisig, the common/default case, costs nothing). Guarded ALTER.
{
	const keyCols = (db.prepare('PRAGMA table_info(multisig_keys)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!keyCols.includes('assigned_user_id')) {
		db.exec(
			'ALTER TABLE multisig_keys ADD COLUMN assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'
		);
	}
	db.exec(
		'CREATE INDEX IF NOT EXISTS idx_multisig_keys_assigned_user ON multisig_keys(assigned_user_id)'
	);
}

// How a multisig came to exist: 'created' (built key-by-key in the wizard — the
// config exists NOWHERE else, so a backup is critical) vs 'imported' (loaded from
// a descriptor / Caravan config the user already holds — re-downloading what they
// just uploaded is redundant). Backup safeguards (mandatory download, persistent
// banner, 90-day reminder) apply ONLY to source='created'. Single-sig wallets are
// never gated at all — they reconstruct from the hardware device. Guarded ALTER;
// existing rows default to 'created' (the safe, backup-prompting side).
{
	const msCols = (db.prepare('PRAGMA table_info(multisigs)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!msCols.includes('source')) {
		db.exec("ALTER TABLE multisigs ADD COLUMN source TEXT NOT NULL DEFAULT 'created'");
	}
}

// Multisig RBF: a replacement draft points at the txid it was built to replace;
// the original row is marked 'superseded' when the replacement broadcasts —
// mirroring the single-sig transactions.replaces_txid column. Guarded and
// additive. See bumpMultisigTransaction in multisigTransactions.ts (cairn-mklv).
{
	const cols = (
		db.prepare('PRAGMA table_info(multisig_transactions)').all() as { name: string }[]
	).map((c) => c.name);
	if (!cols.includes('replaces_txid')) {
		db.exec('ALTER TABLE multisig_transactions ADD COLUMN replaces_txid TEXT');
	}
}

db.exec(`
	-- Instance-wide feature toggles. A row's ABSENCE means "use the registry
	-- default" (FEATURE_FLAGS[].defaultEnabled, which is always true), so an
	-- empty table = every feature on = no existing install regresses on upgrade.
	-- Modeled on notification_preferences: the DB stores only DEVIATIONS from the
	-- code-defined default; the flag list itself lives in featureFlags/registry.ts.
	CREATE TABLE IF NOT EXISTS feature_flags (
		key        TEXT PRIMARY KEY,
		enabled    INTEGER NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_by INTEGER REFERENCES users(id)
	);

	-- Per-user overrides. A row wins over the global row in EITHER direction
	-- (force-on grants an exception, force-off restricts one user); its ABSENCE
	-- means "inherit the global/registry value". See docs/FEATURE-FLAGS-PLAN.md §1.2.
	CREATE TABLE IF NOT EXISTS user_feature_flags (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		key        TEXT NOT NULL,
		enabled    INTEGER NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_by INTEGER REFERENCES users(id),
		UNIQUE (user_id, key)
	);
	CREATE INDEX IF NOT EXISTS idx_user_feature_flags_user ON user_feature_flags(user_id);
`);
