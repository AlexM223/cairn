// scripts/qa/seed-recovery-complete.mjs
//
// Bypass the first-run recovery-setup wizard (a known automation tar-pit) for a
// QA admin by inserting the exact gate-blocker rows appGate.ts checks for an
// admin: account_recovery_phrases + account_recovery_codes (admin_disclosure
// is assumed already accepted via UI). Mirrors scripts/qa/seed-flagmatrix.mjs's
// clearGateBlockers() admin branch. Also mints a fresh session token so we can
// document.cookie past any stale cookie.
//
// Usage: node scripts/qa/seed-recovery-complete.mjs --db <dbPath> --email <email>
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}
function randHex(bytes) {
	return randomBytes(bytes).toString('hex');
}
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--db') out.db = argv[++i];
		else if (argv[i] === '--email') out.email = argv[++i];
	}
	return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.db || !args.email) {
	console.error('usage: node scripts/qa/seed-recovery-complete.mjs --db <dbPath> --email <email>');
	process.exit(1);
}
const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-recovery-complete] ${dbPath} does not exist.`);
	process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 8000;');

const user = db.prepare('SELECT id, email, is_admin FROM users WHERE email = ?').get(args.email);
if (!user) {
	console.error(`[seed-recovery-complete] no user with email ${args.email}`);
	db.close();
	process.exit(1);
}
const uid = Number(user.id);

db.prepare(
	`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`
).run(uid);
db.prepare(
	`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`
).run(uid, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
const hasCode = db.prepare(`SELECT id FROM account_recovery_codes WHERE user_id = ? LIMIT 1`).get(uid);
if (!hasCode) {
	db.prepare(
		`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`
	).run(uid, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
}

const token = randomBytes(32).toString('base64url');
const expiresAt = new Date(Date.now() + 3650 * 86_400_000).toISOString();
db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
	sha256hex(token),
	uid,
	expiresAt
);
db.close();

console.log('[seed-recovery-complete] OK');
console.log(`  user id=${uid} email=${args.email} is_admin=${user.is_admin}`);
console.log(`SESSION_TOKEN=${token}`);
console.log(`document.cookie = "cairn_session=${token}; path=/";`);
