// Reset the QA admin's password to the documented QA-runbook value so future
// QA waves can authenticate normally (cairn-wymc). Reproduces the exact hash
// format produced by src/lib/server/auth.ts hashPassword():
//   scrypt:16384:8:1:<saltBase64>:<hashBase64>
// (N=16384, r=8, p=1, keylen=32). Reusable — override via env:
//   QA_DB, QA_ADMIN_EMAIL, QA_ADMIN_PASSWORD
//
// Usage: node scripts/qa/reset-qa-admin-password.mjs
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

const dbPath = path.resolve(process.env.QA_DB ?? 'C:/dev/cairn/data/qa-wave-2026-07-12.db');
const email = process.env.QA_ADMIN_EMAIL ?? 'qa-wave-admin@test.local';
const password = process.env.QA_ADMIN_PASSWORD ?? 'QaWave2026!Admin';

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

if (!fs.existsSync(dbPath)) {
	console.error(`[reset-qa-admin-password] ${dbPath} does not exist.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');

const user = db.prepare('SELECT id, email, is_admin FROM users WHERE email = ?').get(email);
if (!user) {
	console.error(`[reset-qa-admin-password] no user with email ${email}`);
	db.close();
	process.exit(1);
}

const stored = await hashPassword(password);
db.prepare(
	'UPDATE users SET password_hash = ?, must_reset_password = 0, disabled = 0 WHERE id = ?'
).run(stored, user.id);
db.close();

console.log('[reset-qa-admin-password] OK');
console.log(`  user id=${user.id} email=${email} is_admin=${user.is_admin}`);
console.log(`  password set to the documented QA value (${password.length} chars)`);
