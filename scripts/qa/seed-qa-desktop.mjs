// scripts/qa/seed-qa-desktop.mjs
//
// Standalone seeder for the "cairn-qa-desktop" visual + runtime QA pass
// (design/evergreen-identity branch, 2026-07-17). Same no-src-imports,
// no-password-login pattern as scripts/qa/seed-flagmatrix.mjs: just
// node:sqlite + node:crypto against a throwaway DB, session token minted
// directly into sessions.token_hash, printed to stdout for pasting into
// document.cookie. No interactive login required (the login form does not
// submit under browser automation -- known hazard, see MANUAL.md QA runbook
// and MEMORY.md "Cairn browser QA hazards").
//
// UNLIKE seed-flagmatrix.mjs, this script is self-bootstrapping: it creates
// the handful of tables it needs (users, sessions, the three appGate-blocker
// tables, settings) with CREATE TABLE IF NOT EXISTS using the EXACT column
// definitions from src/lib/server/db.ts (verified 2026-07-17). That means it
// works against a brand-new, never-booted DB file -- no need to start the
// dev server first just to create schema. When the real dev server later
// boots against this same CAIRN_DB path, its own migration (also
// CREATE TABLE IF NOT EXISTS, idempotent) will add every other table without
// touching anything seeded here.
//
// Also sets a real scrypt password hash (same format as
// scripts/qa/reset-qa-admin-password.mjs) as a fallback in case a QA agent
// ever needs interactive password login instead of cookie seeding.
//
// Usage:
//   node scripts/qa/seed-qa-desktop.mjs [--db <dbPath>] [--email <email>] [--password <pw>]
//
// Defaults: --db data/qa-desktop.db (relative to repo root), matching the
// "cairn-qa-desktop" entry in .claude/launch.json (CAIRN_DB env there).

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}

function mintToken() {
	return randomBytes(32).toString('base64url');
}

function randHex(bytes) {
	return randomBytes(bytes).toString('hex');
}

function scryptAsync(pw, salt, keylen, options) {
	return new Promise((resolve, reject) => {
		scrypt(pw, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk)));
	});
}

async function hashPassword(pw) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(pw, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function parseArgs(argv) {
	const out = {
		db: 'data/qa-desktop.db',
		email: 'qa-desktop@test.local',
		password: 'QaDesktop!2026x',
		displayName: 'QA Desktop Admin'
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--db') out.db = argv[++i];
		else if (argv[i] === '--email') out.email = argv[++i];
		else if (argv[i] === '--password') out.password = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const dbPath = path.isAbsolute(args.db) ? args.db : path.resolve(REPO_ROOT, args.db);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

// Minimal self-bootstrap: exact column defs mirrored from src/lib/server/db.ts
// (lines ~42-59, ~396-411) as of 2026-07-17. CREATE TABLE IF NOT EXISTS so a
// later real server boot against this same file is a no-op here and safely
// adds everything else.
db.exec(`
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

	CREATE TABLE IF NOT EXISTS settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS admin_disclosure_acceptances (
		user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
		accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		version     INTEGER NOT NULL,
		accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		ip          TEXT,
		UNIQUE (user_id, version)
	);
	CREATE INDEX IF NOT EXISTS idx_user_agreement_acceptances_user
		ON user_agreement_acceptances(user_id);

	CREATE TABLE IF NOT EXISTS account_recovery_phrases (
		user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
		phrase_hash TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS account_recovery_codes (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		code_hash  TEXT NOT NULL,
		used_at    TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);
	CREATE INDEX IF NOT EXISTS idx_account_recovery_codes_user ON account_recovery_codes(user_id);
`);

// must_reset_password is added via ALTER in db.ts's migration path (not part
// of the initial CREATE TABLE) -- mirror that here too so both fresh and
// pre-existing `users` tables end up with it.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('must_reset_password')) {
	db.exec('ALTER TABLE users ADD COLUMN must_reset_password INTEGER NOT NULL DEFAULT 0');
}

const SESSION_DAYS = 3650; // far-future expiry for a throwaway QA session

function upsertUser({ email, displayName, isAdmin, passwordHash }) {
	const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
	if (existing) {
		db.prepare(
			`UPDATE users SET display_name = ?, is_admin = ?, disabled = 0, must_reset_password = 0, password_hash = ? WHERE id = ?`
		).run(displayName, isAdmin ? 1 : 0, passwordHash, existing.id);
		return Number(existing.id);
	}
	const result = db
		.prepare(
			`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
			 VALUES (?, ?, ?, ?, 0, 0)`
		)
		.run(email, passwordHash, displayName, isAdmin ? 1 : 0);
	return Number(result.lastInsertRowid);
}

function clearGateBlockers(userId, agreementVersion) {
	// Mirrors scripts/load-test/seed.mjs and seed-flagmatrix.mjs -- appGate.ts
	// (src/lib/server/appGate.ts) redirects every (app)-group page until these
	// rows exist for an admin user.
	db.prepare(
		`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?)
		 ON CONFLICT(user_id) DO NOTHING`
	).run(userId);
	db.prepare(
		`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?)
		 ON CONFLICT(user_id) DO NOTHING`
	).run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
	const hasCode = db
		.prepare(`SELECT id FROM account_recovery_codes WHERE user_id = ? LIMIT 1`)
		.get(userId);
	if (!hasCode) {
		db.prepare(
			`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`
		).run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
	}
	db.prepare(
		`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)
		 ON CONFLICT(user_id, version) DO NOTHING`
	).run(userId, agreementVersion);
}

function mintSession(userId) {
	const token = mintToken();
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
	db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
		sha256hex(token),
		userId,
		expiresAt
	);
	return token;
}

const agreementVersionRow = db
	.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`)
	.get();
const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

const passwordHash = await hashPassword(args.password);

db.exec('BEGIN');
let userId, token;
try {
	userId = upsertUser({
		email: args.email,
		displayName: args.displayName,
		isAdmin: true,
		passwordHash
	});
	clearGateBlockers(userId, agreementVersion);

	// Clear stale sessions from a prior run so stdout always reflects a token
	// that's actually valid.
	db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
	token = mintSession(userId);

	db.exec('COMMIT');
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();

console.log('[seed-qa-desktop] seeded OK');
console.log(`  db path: ${dbPath}`);
console.log(`  admin user id=${userId} email=${args.email} (is_admin=1)`);
console.log(`  fallback password login: ${args.password}`);
console.log('');
console.log(
	"Session cookie name: cairn_session (SESSION_COOKIE, src/lib/server/auth.ts:28 -- no __Host-/__Secure- prefix)"
);
console.log('');
console.log(`SESSION_TOKEN=${token}`);
console.log('');
console.log('In the browser console / javascript_tool, run:');
console.log(`  document.cookie = "cairn_session=${token}; path=/";`);
