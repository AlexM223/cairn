// Seed the come-aboard QA instance (move2-dev, port 5182, move2.localhost).
// Adapted from scripts/qa/seed-qa1.mjs (admin+session minting recipe).
//
// Boot the dev server once first (it creates the schema), then run:
//   node scripts/qa/seed-move2-come-aboard.mjs
//
// Seeds:
//   - admin "Alex" + long-lived session (cookie printed at the end)
//   - team mode + invite-only registration
//   - instance_name ("The Martinez Family Node")
//   - four invites: with-welcome, plain, revoked, expired
//   - a chain_snapshot row (tip height) + chainEpochs.v1 (synced=true) so the
//     landing page shows the flagship "Watching the chain · block N" state
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.resolve('C:/dev/cairn-move2/data/qa-move2.db');
const email = 'move2-admin@test.local';
const password = 'Move2Admin!2026x';

function scryptAsync(pw, salt, keylen, options) {
	return new Promise((resolve, reject) => {
		scrypt(pw, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk)));
	});
}
async function hashPassword(pw) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
	return `scrypt:16384:8:1:${salt.toString('base64')}:${hash.toString('base64')}`;
}
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const mintToken = () => randomBytes(32).toString('base64url');
const randHex = (n) => randomBytes(n).toString('hex');

if (!fs.existsSync(dbPath)) {
	console.error(`[seed-move2] ${dbPath} does not exist — boot the move2-dev server once first.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const passwordHash = await hashPassword(password);
const agreementVersion = Number(
	db.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`).get()?.value ?? 1
) || 1;

db.exec('BEGIN');
let userId, userToken;
try {
	const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
	if (existing) {
		userId = Number(existing.id);
		db.prepare(
			`UPDATE users SET password_hash = ?, display_name = ?, is_admin = 1, disabled = 0, must_reset_password = 0 WHERE id = ?`
		).run(passwordHash, 'Alex', userId);
	} else {
		userId = Number(
			db
				.prepare(
					`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
					 VALUES (?, ?, 'Alex', 1, 0, 0)`
				)
				.run(email, passwordHash).lastInsertRowid
		);
	}

	db.prepare(
		`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`
	).run(userId);
	db.prepare(
		`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)
		 ON CONFLICT(user_id, version) DO NOTHING`
	).run(userId, agreementVersion);
	if (!db.prepare(`SELECT user_id FROM account_recovery_phrases WHERE user_id = ?`).get(userId)) {
		db.prepare(`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?)`).run(
			userId,
			`scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`
		);
	}
	if (!db.prepare(`SELECT id FROM account_recovery_codes WHERE user_id = ? LIMIT 1`).get(userId)) {
		db.prepare(
			`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`
		).run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
	}

	db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
	userToken = mintToken();
	db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
		sha256hex(userToken),
		userId,
		new Date(Date.now() + 3650 * 86_400_000).toISOString()
	);

	// Instance state: team mode, invite-only signup, a captain-set node name.
	const setSetting = db.prepare(
		`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
	);
	setSetting.run('registration_mode', 'invite');
	setSetting.run('instance_mode', 'team');
	setSetting.run('instance_name', 'The Martinez Family Node');

	// Synced + watching flagship state: a persisted chain snapshot (tip height
	// for the landing's "block N") and an epoch-history cache row so
	// isFirstSyncComplete() is true. boundaryTimes spaced two weeks apart from
	// genesis — plausible enough for the decorative strip; discarded and
	// rebuilt by the real walk if it dislikes the shape.
	const GENESIS = 1_231_006_505;
	const epochs = 440;
	const boundaryTimes = Array.from({ length: epochs }, (_, i) => GENESIS + i * 1_209_600);
	setSetting.run(
		'chainEpochs.v1',
		JSON.stringify({ boundaryTimes, changes: boundaryTimes.map(() => null), source: 'boundary-blocks' })
	);
	db.prepare(
		`INSERT INTO chain_snapshot (id, data, last_synced_at) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_synced_at = excluded.last_synced_at`
	).run(
		JSON.stringify({
			blocks: [],
			tipHeight: 908_412,
			tipTime: Math.floor(Date.now() / 1000),
			hashrate: null,
			mempoolSummary: null,
			fees: null,
			difficultyInfo: null,
			difficultyHistory: null,
			mempoolBlocks: null,
			feeHistogram: null,
			mempoolTrend: null
		}),
		Date.now()
	);

	// Invites in every state the landing can meet.
	db.prepare(`DELETE FROM invites`).run();
	const mkInvite = db.prepare(
		`INSERT INTO invites (code, label, created_by, max_uses, used_count, revoked, expires_at, welcome_message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	mkInvite.run(
		'CAIRN-QAAA-WELC',
		'Family',
		userId,
		1,
		0,
		0,
		null,
		"So glad you're doing this. This node has been watching our family wallets since spring — now it can watch yours too. Ask me anything over dinner."
	);
	mkInvite.run('CAIRN-QAAA-PLAIN', null, userId, 1, 0, 0, null, null);
	mkInvite.run('CAIRN-QAAA-REVOK', null, userId, 1, 0, 1, null, null);
	mkInvite.run(
		'CAIRN-QAAA-EXPIR',
		null,
		userId,
		1,
		0,
		0,
		new Date(Date.now() - 86_400_000).toISOString(),
		null
	);

	db.exec('COMMIT');
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();

console.log('[seed-move2] seeded OK');
console.log(`  admin id=${userId} email=${email} password=${password}`);
console.log('  invites: CAIRN-QAAA-WELC (welcome msg) / CAIRN-QAAA-PLAIN / CAIRN-QAAA-REVOK / CAIRN-QAAA-EXPIR');
console.log(`COOKIE=cairn_session=${userToken}`);
