// scripts/qa/seed-flagmatrix.mjs
//
// Standalone seeder for the admin feature-flag matrix QA pass (cairn-1ytc).
// Deliberately has NO src/ imports (this is a shared checkout with other
// active sessions) -- just node:sqlite + node:crypto against a throwaway DB.
//
// Seeds two users (an admin + a plain user), clears the appGateRedirect
// blockers exactly like scripts/load-test/seed.mjs:279-284 does (so /(app)
// pages don't 302 to /disclosure, /agreement, or /recovery-setup), and
// mints a session for each by inserting sha256(token) into sessions.token_hash
// directly -- no password is ever set or typed. The raw tokens are printed to
// stdout for pasting into `document.cookie` in the browser (cookie name is
// SESSION_COOKIE from src/lib/server/auth.ts -- 'cairn_session', no
// __Host-/__Secure- prefix, so a JS-set cookie works fine over plain http).
//
// MUST be run while no server process holds the DB file open (node:sqlite is
// a single-writer connection) -- boot the server once first so it creates/
// migrates the schema, stop it, run this, boot the server again.
//
// Usage: node scripts/qa/seed-flagmatrix.mjs --db data/qa-matrix.db

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}

function mintToken() {
	return randomBytes(32).toString('base64url');
}

function randHex(bytes) {
	return randomBytes(bytes).toString('hex');
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--db') out.db = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) {
	console.error('usage: node scripts/qa/seed-flagmatrix.mjs --db <dbPath>');
	process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(
		`[seed-flagmatrix] ${dbPath} does not exist yet. Boot the server once against this ` +
			`HEARTWOOD_DB path first (so it creates/migrates the schema), stop it, then re-run this script.`
	);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Sanity-check the schema is actually there (server must have booted once).
const tableCheck = db
	.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'`)
	.get();
if (!tableCheck) {
	console.error(
		`[seed-flagmatrix] ${dbPath} has no 'users' table. Boot the server against this DB once ` +
			`first so it creates the schema, then re-run this script.`
	);
	db.close();
	process.exit(1);
}

const SESSION_DAYS = 3650; // far-future expiry for a throwaway QA session

function upsertUser({ email, displayName, isAdmin }) {
	const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
	if (existing) {
		db.prepare(
			`UPDATE users SET display_name = ?, is_admin = ?, disabled = 0, must_reset_password = 0, password_hash = NULL WHERE id = ?`
		).run(displayName, isAdmin ? 1 : 0, existing.id);
		return Number(existing.id);
	}
	const result = db
		.prepare(
			`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
			 VALUES (?, NULL, ?, ?, 0, 0)`
		)
		.run(email, displayName, isAdmin ? 1 : 0);
	return Number(result.lastInsertRowid);
}

function clearGateBlockers(userId, isAdmin, agreementVersion) {
	// Mirrors scripts/load-test/seed.mjs:279-284 -- appGate.ts (src/lib/server/appGate.ts)
	// redirects every (app)-group page until these rows exist.
	if (isAdmin) {
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
	} else {
		db.prepare(
			`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)
			 ON CONFLICT(user_id, version) DO NOTHING`
		).run(userId, agreementVersion);
	}
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

db.exec('BEGIN');
let adminId, userId, adminToken, userToken;
try {
	adminId = upsertUser({
		email: 'qa-matrix@test.local',
		displayName: 'QA Matrix Admin',
		isAdmin: true
	});
	userId = upsertUser({
		email: 'qa-matrix-user@test.local',
		displayName: 'QA Matrix User',
		isAdmin: false
	});
	clearGateBlockers(adminId, true, agreementVersion);
	clearGateBlockers(userId, false, agreementVersion);

	// Clear any stale sessions from a prior run of this script against the
	// same DB so stdout always reflects a token that's actually valid.
	db.prepare(
		`DELETE FROM sessions WHERE user_id IN (?, ?)`
	).run(adminId, userId);

	adminToken = mintSession(adminId);
	userToken = mintSession(userId);

	db.exec('COMMIT');
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
} finally {
	// no-op: closed explicitly below on the success path
}
db.close();

console.log('[seed-flagmatrix] seeded OK');
console.log(`  admin user id=${adminId} email=qa-matrix@test.local`);
console.log(`  plain user id=${userId} email=qa-matrix-user@test.local`);
console.log('');
console.log('Session cookie name: cairn_session (SESSION_COOKIE, src/lib/server/auth.ts:27 -- no __Host-/__Secure- prefix)');
console.log('');
console.log(`ADMIN_TOKEN=${adminToken}`);
console.log(`USER_TOKEN=${userToken}`);
console.log('');
console.log('In the browser console / javascript_tool, run:');
console.log(`  document.cookie = "cairn_session=${adminToken}; path=/";`);
console.log('or for the plain user:');
console.log(`  document.cookie = "cairn_session=${userToken}; path=/";`);
