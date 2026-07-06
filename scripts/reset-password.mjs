#!/usr/bin/env node
/**
 * Emergency password reset for a Cairn user — for when no admin can help you
 * from the UI (e.g. you are the locked-out sole admin).
 *
 * Usage:
 *   node scripts/reset-password.mjs <email> [--db path/to/cairn.db]
 *
 * The database path defaults to ./data/cairn.db; the CAIRN_DB environment
 * variable is respected, and --db overrides both. Safe to run while the app
 * is running or stopped (WAL mode). Non-interactive: it generates a strong
 * random temporary password, stores its scrypt hash, deletes the user's
 * sessions, and prints the new password once.
 *
 * Deliberately standalone: node:sqlite + node:crypto only, no imports from
 * src/, so it works against a production database with nothing else built.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Must match src/lib/server/auth.ts exactly.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function usage(message) {
	if (message) console.error(`Error: ${message}\n`);
	console.error('Usage: node scripts/reset-password.mjs <email> [--db path/to/cairn.db]');
	console.error('       (default DB: ./data/cairn.db, or $CAIRN_DB if set)');
	process.exit(1);
}

// ---------- Parse arguments ----------

const args = process.argv.slice(2);
let email = null;
let dbPath = process.env.CAIRN_DB ?? path.join(process.cwd(), 'data', 'cairn.db');

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--db') {
		if (!args[i + 1]) usage('--db requires a path.');
		dbPath = args[++i];
	} else if (args[i].startsWith('--')) {
		usage(`Unknown option: ${args[i]}`);
	} else if (email === null) {
		email = args[i];
	} else {
		usage(`Unexpected argument: ${args[i]}`);
	}
}

if (!email) usage('An email address is required.');
if (!existsSync(dbPath)) usage(`Database not found: ${dbPath}`);

// ---------- Reset ----------

const db = new DatabaseSync(dbPath);
try {
	const user = db
		.prepare('SELECT id, email FROM users WHERE email = ?')
		.get(email.trim().toLowerCase());

	if (!user) {
		console.error(`Error: no user with email "${email}" in ${dbPath}`);
		process.exit(1);
	}

	const tempPassword = randomBytes(12).toString('base64url');

	db.exec('BEGIN');
	db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
		hashPassword(tempPassword),
		user.id
	);
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
	db.exec('COMMIT');

	console.log(`Password reset for ${user.email}.`);
	console.log('');
	console.log(`  Temporary password: ${tempPassword}`);
	console.log('');
	console.log('This is the only time it will be shown. All existing sessions for this');
	console.log('account were signed out. Sign in with the temporary password and change');
	console.log('it right away.');
} finally {
	db.close();
}
