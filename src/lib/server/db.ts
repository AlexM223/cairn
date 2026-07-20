import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { childLogger } from './logger';

const log = childLogger('db');

// Exported so colocated instance state (e.g. secretKey.ts's `instance.key`) can
// live NEXT TO the DB file on the same persistent volume — under Docker/Umbrel
// that is the mounted /data volume (CAIRN_DB), not process.cwd().
//
// HEARTWOOD_DB is the post-rebrand alias; CAIRN_DB stays supported indefinitely
// because existing self-hosted installs (Umbrel/Start9/manual Docker) have real
// databases reachable only under that name — do NOT remove the fallback.
export const DB_PATH =
	env.HEARTWOOD_DB ?? env.CAIRN_DB ?? path.join(process.cwd(), 'data', 'cairn.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

/**
 * Run `fn`'s synchronous DB writes as ONE SQLite transaction (cairn-fzqpe).
 * node:sqlite has no better-sqlite3-style `db.transaction()` helper, so this is
 * the shared primitive: BEGIN IMMEDIATE (take the write lock up front so the
 * unit serializes against concurrent writers), COMMIT on return, ROLLBACK on
 * throw. If a transaction is somehow already open (nested call), `fn` simply
 * runs inside it — the OUTER transaction owns atomicity, and this wrapper
 * neither commits nor rolls back what it didn't begin.
 *
 * The point is crash-atomicity for multi-statement invariants (e.g. the
 * address watcher's "claim txid as notified" + "enqueue the notification" pair
 * — a process death between the two must roll back the claim, never leave a
 * claimed-but-never-sent alert). `fn` MUST be synchronous: an await inside
 * would hold the write lock across the event loop.
 */
export function withTransaction<T>(fn: () => T): T {
	let began = false;
	try {
		db.exec('BEGIN IMMEDIATE');
		began = true;
	} catch {
		/* already inside a transaction — the outer one owns atomicity */
	}
	try {
		const result = fn();
		if (began) db.exec('COMMIT');
		return result;
	} catch (e) {
		if (began) {
			try {
				db.exec('ROLLBACK');
			} catch {
				/* connection-level failure; nothing more to do */
			}
		}
		throw e;
	}
}

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
	PRAGMA busy_timeout = 5000;
	-- WAL + synchronous=NORMAL is the SQLite-recommended durable pairing for a
	-- server workload (cairn-y802): FULL (the default) fsyncs the WAL on EVERY
	-- commit, which serializes concurrent writers behind the disk and produces
	-- the multi-second commit-stall tail seen under write pressure. NORMAL only
	-- fsyncs at checkpoint, never corrupts the database (WAL guarantees that),
	-- and the sole exposure is that a handful of just-committed transactions can
	-- roll back on an OS crash / power loss — fully acceptable here, where the DB
	-- holds only re-derivable wallet metadata (xpubs, PSBTs, snapshots), never
	-- private-key material. Per-connection (not persisted in the file), so this
	-- only governs this process's single DatabaseSync handle.
	PRAGMA synchronous = NORMAL;

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

	// Come-aboard (cairn-s8g9a): an optional captain-written welcome message,
	// shown on the /invite/[code] landing page to whoever holds this invite.
	// Additive, NULL for every pre-existing invite.
	const inviteCols = (db.prepare('PRAGMA table_info(invites)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!inviteCols.includes('welcome_message')) {
		db.exec('ALTER TABLE invites ADD COLUMN welcome_message TEXT');
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
		status               TEXT NOT NULL DEFAULT 'draft', -- draft | awaiting_signature | completed | superseded
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

// Stale-while-revalidate wallet snapshots (cairn-2zxt SWR). ONE row per wallet /
// multisig holding the scan-DERIVED fields a detail/list page renders — balance,
// address+tx summary, the receive-address peek (with its QR), coinbase UTXOs, the
// unconfirmed-inflow (speed-up) verdicts, and the chain tip — as a single JSON
// blob, plus `last_synced_at` (ms epoch) of the scan that produced it. The page
// loaders read this SYNCHRONOUSLY (no Electrum in load()) so navigation never
// blocks; a background refresh (src/lib/server/walletSync.ts) re-scans and rewrites
// the row, then the client re-invalidates the loader to pick up the fresh snapshot.
//
// DISTINCT from wallet_scan_cache above: that is keyed by xpub/descriptor and only
// seeds the in-memory 60s ScanCache on cold start; this is keyed by the wallet's
// id (per its kind) and is the authoritative render source for the page. Keyed by
// (wallet_kind, wallet_id) like the other polymorphic child tables, so it is swept
// by the trg_*_delete_children triggers below (and the deleteCascade introspection
// test enforces that wiring). Never authoritative for spending — the send flow
// always re-scans live (it never reads this).
db.exec(`
	CREATE TABLE IF NOT EXISTS wallet_snapshots (
		wallet_kind    TEXT NOT NULL,     -- 'wallet' | 'multisig'
		wallet_id      INTEGER NOT NULL,  -- id within its kind's table
		snapshot       TEXT NOT NULL,     -- JSON blob (WalletSnapshot / MultisigSnapshot)
		last_synced_at INTEGER NOT NULL,  -- ms epoch of the scan that produced it
		PRIMARY KEY (wallet_kind, wallet_id)
	);
`);

// A tiny denormalized `summary` blob written alongside the full snapshot
// (walletSync.writeSnapshot). The wallets-LIST page only needs balance + last
// activity per wallet, so listCachedPortfolio reads THIS column instead of
// SELECTing and JSON.parsing the whole (potentially large — every address +
// every tx) snapshot for every wallet on each navigation. Nullable + backfilled
// lazily: rows written by an older release have summary IS NULL, and the read
// path falls back to deriving from the full snapshot until the next refresh
// rewrites the row with a summary. Detail pages still read the full snapshot.
{
	const snapCols = (
		db.prepare('PRAGMA table_info(wallet_snapshots)').all() as { name: string }[]
	).map((c) => c.name);
	if (!snapCols.includes('summary')) {
		db.exec('ALTER TABLE wallet_snapshots ADD COLUMN summary TEXT');
	}
	// Dirty-tracking flag (cairn-wcxw, sync engine Phase 1). NULL = clean (the
	// persisted snapshot is trusted current); a ms-epoch timestamp = "an Electrum
	// scripthash status changed at T and this wallet needs a rescan." The refresh
	// gate (walletSync.singleFlightThrottled) skips scanning a CLEAN snapshot until
	// MAX_CLEAN_TTL, and a successful scan compare-and-swaps the flag back to NULL
	// only if no NEW status change landed mid-scan (walletSync.clearDirtyIfUnchanged).
	// Nullable + additive so existing rows read as clean (which the reconnect
	// reconciliation + TTL fallback then re-dirty on the first real signal).
	if (!snapCols.includes('dirty_since')) {
		db.exec('ALTER TABLE wallet_snapshots ADD COLUMN dirty_since INTEGER');
	}
}

// Per-scripthash last-seen Electrum status baseline (cairn-wcxw, sync engine
// Phase 1). Electrum's blockchain.scripthash.subscribe returns a STATUS HASH that
// changes iff the address's history changes (new tx, confirmation, reorg, RBF).
// The address watcher persists the last-seen status here so that, on a live
// scripthash event OR a reconnect resubscribe replay, it can tell a REAL change
// (status differs from / is absent vs the stored baseline ⇒ mark the owning
// wallet dirty) from a redundant re-notification (status unchanged ⇒ skip). Kept
// per-wallet in the PK so an address shared across two imported copies of the
// same wallet is tracked independently and each is swept correctly on delete.
// Keyed by (wallet_kind, wallet_id, scripthash) so it matches the polymorphic
// child-table shape (deleteCascade.test.ts) and is swept by the two
// trg_*_delete_children triggers below.
db.exec(`
	CREATE TABLE IF NOT EXISTS scripthash_status (
		wallet_kind TEXT NOT NULL,     -- 'wallet' | 'multisig'
		wallet_id   INTEGER NOT NULL,  -- id within its kind's table
		scripthash  TEXT NOT NULL,     -- Electrum scripthash (hex)
		status      TEXT,              -- last-seen Electrum status hash; NULL = never used
		updated_at  INTEGER NOT NULL,  -- ms epoch of the last-seen status write
		PRIMARY KEY (wallet_kind, wallet_id, scripthash)
	);
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

// Forced first-login credential reset (cairn-49xi.2). 1 = this account's
// password came from a deployment env var (CAIRN_ADMIN_PASSWORD — Umbrel shows
// the generated value on its install card and keeps it in logs indefinitely),
// so the first login is routed through a one-time "choose your own password and
// email" step (/setup-admin) before any other app route. Set only by
// bootstrapAdminFromEnv() (auth.ts) when it writes an env-supplied password;
// cleared by completeForcedCredentialReset(). Guarded and idempotent.
{
	const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!userCols.includes('must_reset_password')) {
		db.exec('ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0');
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

// Double-spend / RBF reconciliation for INBOUND transactions (cairn-a2p1). Two
// additive columns on notified_txids, guarded so existing databases upgrade in
// place:
//   • status — lifecycle of a tracked inbound. 'pending' = an UNCONFIRMED inbound
//     the watcher has SEEN and is tracking, but has deliberately NOT surfaced as
//     "payment received" yet (the SPV gate defers the user-facing tx_received
//     until the tx confirms). 'notified' = tx_received has fired. 'replaced' = the
//     tx disappeared from the mempool without confirming, or was reorg'd away
//     after — i.e. double-spent / RBF'd — AND it was a genuine external inbound
//     the user should be told about (surfaced as a "cancelled" row + notified).
//     'dropped' = it vanished too, but silently (our own bumped send, a zero-value
//     sighting, or an inbound fee-bump that still pays us): balance is corrected
//     but no cancellation is shown. A NULL status is a legacy or baselined row:
//     treated as already-handled (never re-notified, never reconciled).
//   • amount_sats — the inbound value credited to this wallet, so the correcting
//     "payment cancelled" notification and the wallet-detail cancelled row can
//     show the amount without re-fetching a transaction that no longer exists.
{
	const cols = (db.prepare('PRAGMA table_info(notified_txids)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!cols.includes('status')) db.exec('ALTER TABLE notified_txids ADD COLUMN status TEXT');
	if (!cols.includes('amount_sats')) db.exec('ALTER TABLE notified_txids ADD COLUMN amount_sats INTEGER');
	// cairn-ieilg: chain-tip height at the moment tx_confirmed fired (confirmed
	// flipped to 1). Lets the watcher keep re-checking RECENTLY-confirmed rows for
	// a bounded reorg window (tip − REORG_RECHECK_DEPTH) so a payment reorged out
	// AFTER confirming is still reconciled ('replaced'/'dropped' + corrected
	// balance) instead of keeping its stale "Payment received" forever. NULL on
	// legacy rows = never re-checked (pre-fix behavior, bounded rollout).
	if (!cols.includes('confirmed_height'))
		db.exec('ALTER TABLE notified_txids ADD COLUMN confirmed_height INTEGER');
}

// Polymorphic child-table cleanup (cairn-97ui). balance_snapshots, wallet_backups,
// address_labels, backup_missing_notified, and notified_txids all key off a
// (wallet_kind, wallet_id) pair rather than a real foreign key — SQLite has no
// polymorphic FK, so ON DELETE CASCADE can never reach them on its own. The two
// triggers below sweep every such child whenever a wallets or multisigs row goes,
// covering every delete path in one place: deleteWallet()/deleteMultisig() (a
// direct DELETE) AND user deletion (wallets.user_id/multisigs.user_id cascade
// via a real FK — SQLite still fires a table's AFTER DELETE triggers when a row
// is removed by an FK action, since foreign_keys=ON above). deleteWallet,
// deleteMultisig, and accountDeletion.ts no longer hand-roll this cleanup — do
// not resurrect per-table DELETEs there; add a new child table to BOTH trigger
// bodies here instead, and the introspective test in deleteCascade.test.ts will
// fail loudly if a new (wallet_kind, wallet_id) table is ever added without one.
//
// (multisig_shares also has a `wallet_kind` column, but it is NOT part of this
// scheme — see the comment on that table below. Its parent link is a real
// `multisig_id` FK with ON DELETE CASCADE, so it already cascades correctly and
// is deliberately excluded here.)
//
// DROP + CREATE (not `CREATE TRIGGER IF NOT EXISTS`) so a future edit to a
// trigger body — e.g. a sixth table — actually redeploys to existing databases
// instead of silently never taking effect.
db.exec(`
	DROP TRIGGER IF EXISTS trg_wallets_delete_children;
	CREATE TRIGGER trg_wallets_delete_children AFTER DELETE ON wallets BEGIN
		DELETE FROM balance_snapshots WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM wallet_backups WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM address_labels WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM backup_missing_notified WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM notified_txids WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM wallet_snapshots WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM scripthash_status WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
		DELETE FROM backup_nudges WHERE wallet_kind = 'wallet' AND wallet_id = OLD.id;
	END;

	DROP TRIGGER IF EXISTS trg_multisigs_delete_children;
	CREATE TRIGGER trg_multisigs_delete_children AFTER DELETE ON multisigs BEGIN
		DELETE FROM balance_snapshots WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM wallet_backups WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM address_labels WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM backup_missing_notified WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM notified_txids WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM wallet_snapshots WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM scripthash_status WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
		DELETE FROM backup_nudges WHERE wallet_kind = 'multisig' AND wallet_id = OLD.id;
	END;
`);

// One-time-in-spirit orphan purge: rows left behind by wallets/multisigs that
// were deleted BEFORE the triggers above existed (deleteWallet/deleteMultisig's
// old hand-written cleanup missed balance_snapshots entirely, so those rows in
// particular have been silently accumulating). Unconditional and safe to run on
// every startup rather than gated behind a "have we run this" flag: wallets.id
// and multisigs.id are non-null INTEGER PRIMARY KEYs, so the NOT IN subqueries
// below can never hit the classic NULL-poisoned-NOT-IN footgun, and once the
// historical orphans are gone this is a cheap no-op scan on every subsequent
// boot.
for (const table of [
	'balance_snapshots',
	'wallet_backups',
	'address_labels',
	'backup_missing_notified',
	'notified_txids',
	'wallet_snapshots',
	'scripthash_status'
]) {
	db.exec(`
		DELETE FROM ${table}
		 WHERE (wallet_kind = 'wallet' AND wallet_id NOT IN (SELECT id FROM wallets))
		    OR (wallet_kind = 'multisig' AND wallet_id NOT IN (SELECT id FROM multisigs))
	`);
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

// Decaying, polymorphic, state-driven backup NUDGE cadence (cairn-gt05.5,
// docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md Spec A). Distinct from
// backup_reminders above (the 90-day "refresh your OLD backup" nudge for
// wallets that already HAVE one): this table governs the "you don't have ANY
// backup yet" amber banner in (app)/+layout.svelte, replacing its old
// sessionStorage-only dismissal (which re-nagged on every new session — see
// F16 in docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md). One row per
// still-unbacked wallet, tracking when it last showed and how many times, so
// the banner decays to widening intervals instead of nagging every visit, and
// escalates (but never below a 72h floor) when the stakes genuinely rise —
// see getDueBackupNudge / escalateBackupNudge in src/lib/server/backups.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS backup_nudges (
		user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		wallet_kind   TEXT    NOT NULL,          -- 'multisig' (only created-multisigs are ever nudged)
		wallet_id     INTEGER NOT NULL,
		first_seen_at TEXT    NOT NULL,          -- earned moment (first time this wallet became due)
		last_shown_at TEXT,                      -- last time the banner actually rendered for it
		shown_count   INTEGER NOT NULL DEFAULT 0,
		stakes_bucket INTEGER NOT NULL DEFAULT 0, -- highest stakes tier seen so far (0 NEW / 1 MULTI / 2 FUNDED)
		PRIMARY KEY (user_id, wallet_kind, wallet_id)
	);
`);

// backup_nudges joined the polymorphic delete-cascade scheme late (it shipped
// in v0.2.41 WITHOUT trigger coverage — caught by deleteCascade.test.ts's
// introspective sweep, fixed alongside the trigger bodies above). Its rows key
// off (wallet_kind, wallet_id) like the other swept children, so: (a) the two
// triggers above now include it (safe even though this CREATE TABLE runs after
// the trigger DDL — SQLite resolves trigger body references at fire time, and
// by any fire time this table exists); (b) this one-time-in-spirit purge clears
// rows orphaned by wallet/multisig deletes that happened while the gap was
// live. It sits HERE rather than in the purge loop above because that loop runs
// before this CREATE TABLE on a fresh database. Same NULL-safe NOT IN shape as
// the main purge (both parent ids are non-null INTEGER PRIMARY KEYs).
db.exec(`
	DELETE FROM backup_nudges
	 WHERE (wallet_kind = 'wallet' AND wallet_id NOT IN (SELECT id FROM wallets))
	    OR (wallet_kind = 'multisig' AND wallet_id NOT IN (SELECT id FROM multisigs))
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

// The vault's declared mode at creation (cairn-1kc3.6): 1 = collaborative
// (cosigner keys shared with other people — fresh on-platform creations must
// use BIP-45 m/45' paths, enforced server-side in createMultisig), 0 = personal
// (all the user's own keys — BIP-48 paths; m/45' rejected), NULL = never
// declared (every pre-existing row, and creations from flows that don't ask
// yet — no mode enforcement). A DIFFERENT axis from `source` above: a fresh
// vault can be personal or collaborative, and an imported vault is exempt from
// the BIP-45 rule regardless of this flag. Set once at creation, never edited
// after — flipping it later wouldn't re-derive already-recorded key paths.
{
	const msCols = (db.prepare('PRAGMA table_info(multisigs)').all() as { name: string }[]).map(
		(c) => c.name
	);
	if (!msCols.includes('collaborative')) {
		db.exec('ALTER TABLE multisigs ADD COLUMN collaborative INTEGER');
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

// One live RBF replacement per original (cairn-yabj). executeRbfBump (feeBump.ts)
// does a SELECT existence check on replaces_txid and, several awaits later
// (getTx confirmation + the async buildReplacement), an INSERT — two concurrent
// bumps of the SAME original can both pass the SELECT and both INSERT a
// replacement fighting over the same inputs (a TOCTOU race the friendly SELECT
// alone can't close). A partial UNIQUE index on (owner, replaces_txid) makes the
// INSERT itself the atomic guard: the loser gets a UNIQUE-constraint violation
// feeBump maps to the SAME 'already_replaced' error the sequential check raises,
// so racing and sequential callers hit identical semantics. Partial
// (WHERE replaces_txid IS NOT NULL) so ordinary drafts and CPFP children — which
// carry a NULL replaces_txid — are entirely unconstrained (SQLite already treats
// NULLs as distinct in a UNIQUE index; the predicate makes that intent explicit
// and keeps the index to just the replacement rows). Additive/idempotent; both
// replaces_txid columns exist by this point.
db.exec(`
	CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_replaces
		ON transactions(wallet_id, replaces_txid) WHERE replaces_txid IS NOT NULL;
	CREATE UNIQUE INDEX IF NOT EXISTS idx_multisig_transactions_replaces
		ON multisig_transactions(multisig_id, replaces_txid) WHERE replaces_txid IS NOT NULL;
`);

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

// Admin announcement/banner system (cairn-yspt). Instance-wide messages —
// maintenance notices, warnings, promotions — rendered on every authenticated
// page, DISTINCT from the per-user events/notifications system. Body is plain
// text in v1 (no markdown/HTML renderer exists; link_url covers the "link" use
// case without opening an XSS surface). Dismissals mirror backup_reminders:
// per-user, permanent per announcement.
db.exec(`
	CREATE TABLE IF NOT EXISTS announcements (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		type          TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warning' | 'urgent' | 'promotion'
		title         TEXT NOT NULL,
		body          TEXT NOT NULL,
		link_url      TEXT,
		link_text     TEXT,
		dismissible   INTEGER NOT NULL DEFAULT 1,
		active        INTEGER NOT NULL DEFAULT 1,
		expires_at    TEXT,
		display_order INTEGER NOT NULL DEFAULT 0,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS announcement_dismissals (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
		dismissed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (user_id, announcement_id)
	);
	CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_user ON announcement_dismissals(user_id);
`);

// Managed multisig service referrals (cairn-01i0). An admin-managed repeatable
// list (Casa/Nunchuk/Unchained/custom) surfaced as a small card in the multisig
// wizard — so a dedicated table rather than settings k/v rows. Per-device
// referral URL overrides DO live in the settings table (referral_device_*_url).
db.exec(`
	CREATE TABLE IF NOT EXISTS multisig_service_referrals (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		name          TEXT NOT NULL,
		url           TEXT NOT NULL,
		description   TEXT,
		logo_url      TEXT,
		active        INTEGER NOT NULL DEFAULT 1,
		display_order INTEGER NOT NULL DEFAULT 0,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`);

// Instance credential material (cairn-e9mz.4), split out of the plain `settings`
// k/v table so "what's sensitive here" is visible in the schema instead of
// needing a code audit: value_enc is ALWAYS a secretKey.ts envelope (or '' for
// an explicitly cleared secret), written only via settings.ts's
// setSecretSetting. backup.ts excludes this table from exports by construction.
// setSecretSetting (qfez8.21) takes an optional domain `label` that rides in
// the envelope, so callers outside the legacy default domain (e.g. SV2's
// authority secret) share this same table/function instead of hand-rolling
// their own upsert. Current keys: smtp_pass, core_rpc_pass, telegram_bot_token,
// nostr_sender_privkey (migrated out of `settings` at startup),
// mining_sv2_authority_secret (SV2 Noise authority keypair, cairn-qfez8.8).
db.exec(`
	CREATE TABLE IF NOT EXISTS instance_secrets (
		key        TEXT PRIMARY KEY,
		value_enc  TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
`);

// Known-device-keys registry (cairn-fdlf.2, see src/lib/server/deviceKeys.ts).
// One row per (user, master fingerprint, purpose): the account xpub last read
// off that hardware device at that purpose's path, so a later wizard session
// can reuse it instead of forcing another live device touch (the single-sig
// wizard's BIP-45 prefetch writes here — cairn-fdlf.1; the multisig wizard
// read-path is cairn-fdlf.4). Modeled on Bastion's master_keys table
// (UNIQUE(user_id, xfp, purpose)). purpose keeps the single-sig ('44'/'49'/
// '84'/'86'), personal-multisig ('48'), and collaborative-vault ('45') key
// families as strictly separate rows — deviceKeys.ts validates it against a
// closed enum and requires the path to match, so the families can never be
// conflated. Convenience cache only: wallets/multisig_keys stay the source of
// truth. share_opt_in is cairn-fdlf.3's sharing flag (default off; column
// only, enforcement is that future bead).
db.exec(`
	CREATE TABLE IF NOT EXISTS device_keys (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		fingerprint  TEXT NOT NULL,               -- 8 lowercase hex master fingerprint
		purpose      TEXT NOT NULL,               -- '44'|'49'|'84'|'86'|'48'|'45'
		xpub         TEXT NOT NULL,               -- account-level xpub last read
		path         TEXT NOT NULL,               -- e.g. "m/45'", "m/84'/0'/0'"
		device_type  TEXT,                        -- 'trezor'|'ledger'|…; NULL = unknown
		share_opt_in INTEGER NOT NULL DEFAULT 0,  -- cairn-fdlf.3 (single-sig rows)
		created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (user_id, fingerprint, purpose)
	);
	CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id, fingerprint);
`);

// Persisted global chain-data snapshot for stale-while-revalidate page loads
// (single-sig-full-wallet SWR work). ONE singleton row (id pinned to 1) holding
// the whole tip-view chain dataset the dashboard + explorer pages render —
// recent blocks, mempool summary, fee estimates, difficulty, mempool-block
// projections, fee histogram, and backlog trend — as one JSON blob, plus the
// epoch-ms `last_synced_at`. This is GLOBAL data (not per-user/per-wallet), so a
// single row is correct; it is a pure performance cache (a missing/corrupt row
// just falls back to a live refresh), and it is deliberately its OWN table
// rather than a `settings` k/v row so the (frequently scanned) settings table
// isn't bloated with a large blob. Written by src/lib/server/chainSync.ts,
// read synchronously by the retrofitted page load()s (chainSnapshot.ts).
db.exec(`
	CREATE TABLE IF NOT EXISTS chain_snapshot (
		id             INTEGER PRIMARY KEY CHECK (id = 1),
		data           TEXT NOT NULL,   -- JSON PersistedChainData
		last_synced_at INTEGER NOT NULL -- epoch milliseconds
	);
`);

// Rolling local time-series of mempool size for the explorer's 2h backlog-trend
// chart (cairn-zoz8.15, mempoolSamples.ts). Replaces the mempool.space
// /v1/statistics/2h dependency with samples the background refresh drops here each
// pass — one row per unix-second (INSERT OR REPLACE dedupes a same-second write),
// pruned to a few hours. GLOBAL data, so a single small table (not per-user). Pure
// cache: it starts empty after deploy and fills over time; a missing/corrupt row
// just yields a thinner chart, never an error.
db.exec(`
	CREATE TABLE IF NOT EXISTS mempool_samples (
		at       INTEGER PRIMARY KEY, -- unix seconds
		vsize    INTEGER NOT NULL,    -- total mempool virtual bytes at sample time
		tx_count INTEGER NOT NULL
	);
`);

// Per-user dashboard portfolio aggregate for stale-while-revalidate home loads.
// The dashboard's hero balance / allocation / activity used to block on a LIVE
// Electrum scan of every wallet on every GET /api/portfolio (a 60s in-memory
// cache was the only guard). Instead, the coalesced background refresh pass
// (walletSync.refreshPortfolio) now computes this aggregate FROM the per-wallet
// snapshots it already produced and persists it here; GET /api/portfolio reads
// this row synchronously and NEVER scans. One row per user (single-row shape,
// like chain_snapshot but keyed by user_id); a pure cache — a missing/corrupt
// row just renders the first-sync state until the next refresh writes one.
// ON DELETE CASCADE cleans it up with the user; wallet deletion needs no touch
// (the next refresh rebuilds the aggregate from the surviving snapshots).
db.exec(`
	CREATE TABLE IF NOT EXISTS portfolio_snapshot (
		user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		detail         TEXT NOT NULL,   -- JSON PortfolioDetail aggregate
		last_synced_at INTEGER NOT NULL -- epoch milliseconds
	);
`);

// Per-transaction hybrid cache for the explorer tx detail page
// (single-sig-full-wallet SWR). ONE row per txid holding the last-seen decoded
// transaction (whatever chain.getTx returned) as JSON, plus the epoch-ms
// `cached_at`. The tx page reads this SYNCHRONOUSLY so it can render AND make its
// RBF-redirect decision from cached data instantly, instead of blocking first
// paint on a live Electrum/Core RPC getTx — the one route the chain_snapshot SWR
// work above didn't cover (that page's getTx stayed awaited because it drives a
// 302-to-replacement vs 404 decision). Keyed by txid because a decoded tx is
// GLOBAL (identical for every user), and its own table rather than a `settings`
// k/v row because it holds many rows. Safe to cache: a tx's replacement /
// confirmation status only moves FORWARD, so a stale "found" row is at worst
// out of date (the background refresh / next visit reconciles it, and the page's
// live streamed RBF lookup still points at any replacement) — it can never cause
// a WRONG redirect. Pure performance cache: a missing/corrupt row falls back to a
// live fetch, so it is never authoritative and is safe to prune. Written +
// refreshed by src/lib/server/txSnapshot.ts.
db.exec(`
	CREATE TABLE IF NOT EXISTS tx_snapshots (
		txid      TEXT PRIMARY KEY,
		data      TEXT NOT NULL,    -- JSON TxDetail (last chain.getTx result)
		cached_at INTEGER NOT NULL  -- epoch milliseconds
	);
`);

// Multisig wizard drafts (cairn-jy3g, Phase 2 of cairn-1u41): server-side
// per-key persistence for the create-multisig wizard, resumable via
// ?draft=N — mirroring the send flow's ?tx=N draft resume (transactions
// table). Phase 1 (wizardProgress.ts) only covers a same-tab reload within
// the hour via sessionStorage; this covers a ceremony spanning hours/days or
// switching devices. Committed after EVERY key add/remove, not just on
// exit — see syncWizardDraft in src/lib/server/multisigWizardDrafts.ts. Only
// PUBLIC key material is ever stored (xpub/fingerprint/path/label/category/
// deviceType) — never private key material, of which this flow handles none.
// multisig_wizard_draft_keys has a REAL foreign key to its one parent (unlike
// the polymorphic wallet_kind/wallet_id child tables above), so ON DELETE
// CASCADE alone covers both draft deletion and the user-deletion cascade —
// no trigger wiring needed.
db.exec(`
	CREATE TABLE IF NOT EXISTS multisig_wizard_drafts (
		id                    INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name                  TEXT NOT NULL DEFAULT '',
		threshold             INTEGER NOT NULL DEFAULT 2,
		total_keys            INTEGER NOT NULL DEFAULT 3,
		script_type           TEXT NOT NULL DEFAULT 'p2wsh',
		vault_mode            TEXT,                          -- 'collaborative' | 'personal' | NULL
		step                  TEXT NOT NULL DEFAULT 'keys',  -- wizard position at last commit
		config_imported       INTEGER NOT NULL DEFAULT 0,
		imported_start_index  INTEGER NOT NULL DEFAULT 0,
		created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_wizard_drafts_user ON multisig_wizard_drafts(user_id);

	CREATE TABLE IF NOT EXISTS multisig_wizard_draft_keys (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		draft_id    INTEGER NOT NULL REFERENCES multisig_wizard_drafts(id) ON DELETE CASCADE,
		position    INTEGER NOT NULL,
		name        TEXT NOT NULL,
		category    TEXT NOT NULL,
		device_type TEXT,
		xpub        TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		path        TEXT NOT NULL,
		created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (draft_id, position)
	);
	CREATE INDEX IF NOT EXISTS idx_multisig_wizard_draft_keys_draft ON multisig_wizard_draft_keys(draft_id);
`);

// Solo-mining (epic cairn-vn43, doctrine pivot to MULTI-USER solo — each
// authenticated miner connection gets its own coinbase paying ITS OWN
// wallet address; the block finder keeps the full reward; shares are
// tracked here for stats ONLY, never for splitting a reward (hard legal
// gate cairn-vn43.14 — do not add any column or table that aggregates
// value owed across users). The in-process engine is the only writer of
// mining_workers/mining_stats (batched, low-rate — per-share state stays
// in-memory in the engine; see cairn-xlrm hazard note on wallet-sync
// node:sqlite contention). mining_stats.round_id is reserved-NULL: a
// future split-mode seam, unused by anything in the MVP.
db.exec(`
	CREATE TABLE IF NOT EXISTS mining_prefs (
		user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		mining_id        TEXT UNIQUE,
		enabled          INTEGER NOT NULL DEFAULT 0,
		payout_wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
		updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS mining_workers (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		worker_name      TEXT NOT NULL,
		shares_accepted  INTEGER NOT NULL DEFAULT 0,
		shares_stale     INTEGER NOT NULL DEFAULT 0,
		shares_rejected  INTEGER NOT NULL DEFAULT 0,
		sum_weight       TEXT NOT NULL DEFAULT '0',
		best_share_diff  REAL NOT NULL DEFAULT 0,
		hashrate_est     REAL NOT NULL DEFAULT 0,
		current_diff     REAL NOT NULL DEFAULT 0,
		last_share_at    TEXT,
		UNIQUE (user_id, worker_name)
	);
	CREATE INDEX IF NOT EXISTS idx_mining_workers_user ON mining_workers(user_id);

	CREATE TABLE IF NOT EXISTS mining_stats (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		bucket_start TEXT NOT NULL,
		user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
		worker_name  TEXT,
		round_id     INTEGER, -- reserved-NULL; future split-mode seam, unused today
		shares       INTEGER NOT NULL DEFAULT 0,
		sum_weight   TEXT NOT NULL DEFAULT '0',
		hashrate_est REAL NOT NULL DEFAULT 0
	);
	CREATE INDEX IF NOT EXISTS idx_mining_stats_bucket ON mining_stats(bucket_start);
	CREATE INDEX IF NOT EXISTS idx_mining_stats_user ON mining_stats(user_id, bucket_start);

	CREATE TABLE IF NOT EXISTS mining_blocks (
		id                  INTEGER PRIMARY KEY AUTOINCREMENT,
		height              INTEGER NOT NULL,
		block_hash          TEXT NOT NULL UNIQUE,
		coinbase_txid       TEXT,
		user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
		worker_name         TEXT,
		wallet_id           INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
		payout_address      TEXT NOT NULL,
		coinbase_value_sats TEXT NOT NULL,
		found_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		submit_result       TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_mining_blocks_user ON mining_blocks(user_id);
`);
