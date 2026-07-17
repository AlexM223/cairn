// scripts/qa/seed-miningqa-wave3.mjs
//
// Standalone seeder for the mining pool UI visual-QA pass (Wave 3, epic
// cairn-vn43). No src/ imports (shared checkout, other sessions active) --
// just node:sqlite + node:crypto against the throwaway
// data/qa-miningqa-wave3.db. Boot the server once first (creates/migrates the
// schema), stop it, run this script, then boot the server again.
//
// Seeds:
//   - an admin user + two regular users (userA, userB), each with a minted
//     session token (no passwords), gate blockers cleared so (app) pages don't
//     redirect to /disclosure or /agreement.
//   - the `mining` global feature flag ON (fresh installs default it off --
//     miningDefaultMigration.ts -- so QA needs it explicitly flipped).
//   - a payout-eligible xpub wallet for each of userA/userB.
//   - mining_prefs for userA (enabled) and userB (enabled, for the isolation
//     check in item D of the QA matrix) and admin (left disabled/untouched).
//   - mining_workers rows for userA: one Bitaxe-scale worker (~1.2 TH/s, seen
//     30s ago -> "online"), one small worker (~400 GH/s, seen 40 minutes ago
//     -> "offline"). NOTE (see QA report): the live /mining and /admin/mining
//     UI reads worker lists from the IN-MEMORY MiningAggregates singleton
//     (src/lib/server/mining/aggregates.ts), never from this mining_workers
//     table directly -- these rows only feed the all-time best-share MAX()
//     query. They will NOT appear in the workers/miners list after a fresh
//     server boot. Seeded anyway for that DB-level check plus documentation.
//   - 24h of mining_stats 1-minute pool buckets (user_id NULL) so the admin
//     hashrate chart has a real series to render.
//   - 2 mining_blocks rows for userA: one recent (maturing) and one old
//     (mature, 150+ confs assumed at any regtest/dev tip), realistic reward.
//
// Usage: node scripts/qa/seed-miningqa-wave3.mjs --db data/qa-miningqa-wave3.db

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
	console.error('usage: node scripts/qa/seed-miningqa-wave3.mjs --db <dbPath>');
	process.exit(1);
}
const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-miningqa-wave3] ${dbPath} does not exist. Boot the server once first.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get();
if (!tableCheck) {
	console.error(`[seed-miningqa-wave3] ${dbPath} has no 'users' table -- boot the server once first.`);
	db.close();
	process.exit(1);
}

const SESSION_DAYS = 3650;

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
	if (isAdmin) {
		db.prepare(
			`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`
		).run(userId);
		db.prepare(
			`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`
		).run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
		const hasCode = db.prepare(`SELECT id FROM account_recovery_codes WHERE user_id = ? LIMIT 1`).get(userId);
		if (!hasCode) {
			db.prepare(
				`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`
			).run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
		}
	} else {
		db.prepare(
			`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL) ON CONFLICT(user_id, version) DO NOTHING`
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

function makeWallet(userId, name, xpub) {
	const existing = db.prepare(`SELECT id FROM wallets WHERE user_id = ? AND xpub = ?`).get(userId, xpub);
	if (existing) return Number(existing.id);
	return Number(
		db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, ?, 'xpub', ?, 'p2wpkh')`
			)
			.run(userId, name, xpub).lastInsertRowid
	);
}

function upsertMiningPrefs(userId, miningId, enabled, payoutWalletId) {
	db.prepare(
		`INSERT INTO mining_prefs (user_id, mining_id, enabled, payout_wallet_id, updated_at)
		 VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(user_id) DO UPDATE SET
		   mining_id = excluded.mining_id, enabled = excluded.enabled,
		   payout_wallet_id = excluded.payout_wallet_id, updated_at = excluded.updated_at`
	).run(userId, miningId, enabled ? 1 : 0, payoutWalletId);
}

function upsertMiningWorker(userId, workerName, opts) {
	db.prepare(
		`INSERT INTO mining_workers
		   (user_id, worker_name, shares_accepted, shares_stale, shares_rejected,
		    sum_weight, best_share_diff, hashrate_est, current_diff, last_share_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, worker_name) DO UPDATE SET
		   shares_accepted = excluded.shares_accepted, shares_stale = excluded.shares_stale,
		   shares_rejected = excluded.shares_rejected, sum_weight = excluded.sum_weight,
		   best_share_diff = excluded.best_share_diff, hashrate_est = excluded.hashrate_est,
		   current_diff = excluded.current_diff, last_share_at = excluded.last_share_at`
	).run(
		userId,
		workerName,
		opts.sharesAccepted,
		opts.sharesStale,
		opts.sharesRejected,
		String(opts.sumWeight),
		opts.bestShareDiff,
		opts.hashrateEst,
		opts.currentDiff,
		opts.lastShareAt
	);
}

function insertMiningStatsBucket(bucketIso, hashrateEst) {
	db.prepare(
		`INSERT INTO mining_stats (bucket_start, user_id, worker_name, shares, sum_weight, hashrate_est)
		 VALUES (?, NULL, NULL, ?, ?, ?)`
	).run(bucketIso, Math.max(1, Math.round(hashrateEst / 1e9)), String(hashrateEst / 1e7), hashrateEst);
}

function insertMiningBlock(row) {
	const existing = db.prepare(`SELECT id FROM mining_blocks WHERE block_hash = ?`).get(row.blockHash);
	if (existing) return;
	db.prepare(
		`INSERT INTO mining_blocks
		   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
		    payout_address, coinbase_value_sats, found_at, submit_result)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`
	).run(
		row.height,
		row.blockHash,
		row.coinbaseTxid,
		row.userId,
		row.workerName,
		row.walletId,
		row.payoutAddress,
		row.coinbaseValueSats,
		row.foundAt
	);
}

function setGlobalFlag(key, enabled, updatedBy) {
	db.prepare(
		`INSERT INTO feature_flags (key, enabled, updated_by, updated_at)
		 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
	).run(key, enabled ? 1 : 0, updatedBy);
}

const agreementVersionRow = db.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`).get();
const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

db.exec('BEGIN');
let adminId, userAId, userBId, adminToken, userAToken, userBToken;
try {
	adminId = upsertUser({ email: 'qa-mining-admin@test.local', displayName: 'QA Mining Admin', isAdmin: true });
	userAId = upsertUser({ email: 'qa-mining-usera@test.local', displayName: 'QA Miner A', isAdmin: false });
	userBId = upsertUser({ email: 'qa-mining-userb@test.local', displayName: 'QA Miner B', isAdmin: false });
	clearGateBlockers(adminId, true, agreementVersion);
	clearGateBlockers(userAId, false, agreementVersion);
	clearGateBlockers(userBId, false, agreementVersion);

	db.prepare(`DELETE FROM sessions WHERE user_id IN (?, ?, ?)`).run(adminId, userAId, userBId);
	adminToken = mintSession(adminId);
	userAToken = mintSession(userAId);
	userBToken = mintSession(userBId);

	// mining flag ON instance-wide (fresh install defaults it off)
	setGlobalFlag('mining', true, adminId);

	// wallets
	const walletA = makeWallet(
		userAId,
		'QA Payout Wallet A',
		'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'
	);
	const walletB = makeWallet(
		userBId,
		'QA Payout Wallet B',
		'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzB5v3fDVmy'
	);

	// mining prefs
	upsertMiningPrefs(userAId, 'hw_a1b2c3d4', true, walletA);
	upsertMiningPrefs(userBId, 'hw_e5f6a7b8', true, walletB);

	const now = Date.now();

	// mining_workers (see header note: NOT read by the live workers list, only
	// feeds the storedBest MAX() query -- kept for that + documentation)
	upsertMiningWorker(userAId, 'bitaxe-livingroom', {
		sharesAccepted: 48213,
		sharesStale: 12,
		sharesRejected: 3,
		sumWeight: 48213 * 0.5,
		bestShareDiff: 2.1,
		hashrateEst: 1.2e12,
		currentDiff: 0.5,
		lastShareAt: new Date(now - 30_000).toISOString() // 30s ago -> "online"
	});
	upsertMiningWorker(userAId, 'nerdaxe-garage', {
		sharesAccepted: 15042,
		sharesStale: 4,
		sharesRejected: 1,
		sumWeight: 15042 * 0.5,
		bestShareDiff: 0.8,
		hashrateEst: 4e11,
		currentDiff: 0.5,
		lastShareAt: new Date(now - 40 * 60_000).toISOString() // 40 min ago -> "offline"
	});
	upsertMiningWorker(userBId, 'bitaxe-userb', {
		sharesAccepted: 9001,
		sharesStale: 2,
		sharesRejected: 0,
		sumWeight: 9001 * 0.5,
		bestShareDiff: 0.6,
		hashrateEst: 3e11,
		currentDiff: 0.5,
		lastShareAt: new Date(now - 20_000).toISOString()
	});

	// mining_stats: 24h of 1-minute pool buckets (user_id NULL) for the admin chart
	const insertStats = db.prepare(
		`INSERT INTO mining_stats (bucket_start, user_id, worker_name, shares, sum_weight, hashrate_est) VALUES (?, NULL, NULL, ?, ?, ?)`
	);
	const bucketMs = 60_000;
	const start = Math.floor((now - 24 * 3_600_000) / bucketMs) * bucketMs;
	let seeded = 0;
	for (let t = start; t < now; t += bucketMs) {
		// gentle sinusoidal variation around ~1.6 TH/s combined pool hashrate so the
		// chart shows real movement, not a flat line -- never negative/NaN.
		const hoursIn = (t - start) / 3_600_000;
		const wobble = Math.sin(hoursIn / 2) * 3e11;
		const hashrate = Math.max(2e11, 1.6e12 + wobble);
		const bucketIso = new Date(t).toISOString();
		insertStats.run(bucketIso, 30, String(hashrate / 1e7), hashrate);
		seeded++;
	}

	// mining_blocks: one recent (maturing), one old (mature)
	insertMiningBlock({
		height: 900100,
		blockHash: 'qa'.repeat(16) + 'aa',
		coinbaseTxid: 'cb'.repeat(16) + 'aa',
		userId: userAId,
		workerName: 'bitaxe-livingroom',
		walletId: walletA,
		payoutAddress: 'bc1qqamining0000000000000000000000000aa',
		coinbaseValueSats: '312500000', // 3.125 BTC post-halving reward, sats
		foundAt: new Date(now - 3_600_000).toISOString() // 1h ago -> maturing
	});
	insertMiningBlock({
		height: 899500,
		blockHash: 'qa'.repeat(16) + 'bb',
		coinbaseTxid: 'cb'.repeat(16) + 'bb',
		userId: userAId,
		workerName: 'bitaxe-livingroom',
		walletId: walletA,
		payoutAddress: 'bc1qqamining0000000000000000000000000bb',
		coinbaseValueSats: '312500000',
		foundAt: new Date(now - 30 * 86_400_000).toISOString() // 30 days ago -> mature
	});

	db.exec('COMMIT');
	console.log(`[seed-miningqa-wave3] seeded OK (24h pool buckets: ${seeded})`);
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();

console.log('');
console.log(`  admin  id=${adminId} email=qa-mining-admin@test.local`);
console.log(`  userA  id=${userAId} email=qa-mining-usera@test.local mining_id=hw_a1b2c3d4`);
console.log(`  userB  id=${userBId} email=qa-mining-userb@test.local mining_id=hw_e5f6a7b8`);
console.log('');
console.log('Session cookie name: cairn_session');
console.log('');
console.log(`ADMIN_TOKEN=${adminToken}`);
console.log(`USERA_TOKEN=${userAToken}`);
console.log(`USERB_TOKEN=${userBToken}`);
