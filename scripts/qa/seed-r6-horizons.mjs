// scripts/qa/seed-r6-horizons.mjs
//
// QA seed for cairn-d326 (R6 — multi-horizon balance delta + lazy fiat
// repaint): one user with a real wallet history so Home's portfolio.change
// AND the wallet-detail page's client-derived (tx-based) horizons both have
// non-null, non-trivial data to render (percent-led 1d/30d/1yr/all-time).
//
// Mirrors seed-home-phase1.mjs's pattern (no src/ imports; writes straight
// into portfolio_snapshot + wallet_snapshots so rendering is deterministic
// with no live chain connectivity needed).
//
// Usage: node scripts/qa/seed-r6-horizons.mjs --db data/qa-uxr6.db

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HDKey } from '@scure/bip32';

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
	console.error('usage: node scripts/qa/seed-r6-horizons.mjs --db <dbPath>');
	process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-r6-horizons] ${dbPath} does not exist yet. Boot the server once first.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SESSION_DAYS = 3650;
const DAY = 86400;
const nowS = Math.floor(Date.now() / 1000);

function upsertUser({ email, displayName }) {
	const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
	if (existing) {
		db.prepare(
			`UPDATE users SET display_name = ?, disabled = 0, must_reset_password = 0, password_hash = NULL WHERE id = ?`
		).run(displayName, existing.id);
		return Number(existing.id);
	}
	const result = db
		.prepare(
			`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
			 VALUES (?, NULL, ?, 0, 0, 0)`
		)
		.run(email, displayName);
	return Number(result.lastInsertRowid);
}

function clearGateBlockers(userId, agreementVersion) {
	db.prepare(
		`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)
		 ON CONFLICT(user_id, version) DO NOTHING`
	).run(userId, agreementVersion);
}

function mintSession(userId) {
	const token = mintToken();
	db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
	db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
		sha256hex(token),
		userId,
		expiresAt
	);
	return token;
}

function realXpub(seedByte) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive("m/84'/0'/0'");
	return account.publicExtendedKey;
}

function upsertWallet(userId, name, seedByte) {
	const xpub = realXpub(seedByte);
	const existing = db
		.prepare(`SELECT id FROM wallets WHERE user_id = ? AND xpub = ?`)
		.get(userId, xpub);
	if (existing) return Number(existing.id);
	const res = db
		.prepare(
			`INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, ?, 'xpub', ?, 'p2wpkh')`
		)
		.run(userId, name, xpub);
	return Number(res.lastInsertRowid);
}

const agreementVersionRow = db
	.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`)
	.get();
const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

db.exec('BEGIN');
try {
	const userId = upsertUser({ email: 'qa-r6-horizons@test.local', displayName: 'QA R6 Horizons' });
	clearGateBlockers(userId, agreementVersion);
	const walletId = upsertWallet(userId, 'Cold Storage', 231);

	// Tx history: 400d ago +50,000,000; 45d ago +18,000,000 (misses the 30d
	// horizon on purpose so that row shows "--"); 3d ago -6,000,000. Confirmed
	// balance = 62,000,000 — deltas sum exactly, so historyFromTxDeltas trusts it.
	const txs = [
		{
			txid: 'a'.repeat(64),
			height: 100,
			time: nowS - 400 * DAY,
			delta: 50_000_000
		},
		{
			txid: 'b'.repeat(64),
			height: 200,
			time: nowS - 45 * DAY,
			delta: 18_000_000
		},
		{
			txid: 'c'.repeat(64),
			height: 300,
			time: nowS - 3 * DAY,
			delta: -6_000_000
		}
	];
	const confirmed = 62_000_000;

	// --- Home portfolio_snapshot (server-computed change) -------------------
	const change = {
		// vs 3d-ago point cutoff would be the same running total (62,000,000) since
		// the -3d tx already landed by "1d ago" too -> 0 net change in the last 1d.
		d1: 0,
		// vs the point nearest 30d ago -> the 45d-ago point precedes it, so this
		// reads null (no snapshot inside the last 30 days) -- exercises the
		// honest "no data yet" branch in BalanceHorizons.
		d30: null,
		// vs the point nearest 365d ago -> the 400d-ago point (50,000,000)
		d365: confirmed - 50_000_000,
		// vs the very first point (50,000,000)
		all: confirmed - 50_000_000
	};

	db.prepare(
		`INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET detail = excluded.detail, last_synced_at = excluded.last_synced_at`
	).run(
		userId,
		JSON.stringify({
			walletCount: 1,
			scannedCount: 1,
			confirmed,
			unconfirmed: 0,
			allocation: [
				{
					key: `wallet-${walletId}`,
					kind: 'wallet',
					id: walletId,
					name: 'Cold Storage',
					href: `/wallets/${walletId}`,
					balance: confirmed,
					lastActivity: nowS - 3 * DAY
				}
			],
			recentActivity: [
				{
					key: `wallet-${walletId}-tx3`,
					walletName: 'Cold Storage',
					walletHref: `/wallets/${walletId}`,
					txid: txs[2].txid,
					direction: 'out',
					sats: 6_000_000,
					time: txs[2].time,
					confirmations: 10
				}
			],
			balanceSeries: [],
			sparklines: {},
			change
		}),
		Date.now()
	);

	// --- wallet-detail wallet_snapshots (client-derived horizons) -----------
	const walletSnapshot = {
		scan: {
			addresses: [],
			txs,
			confirmed,
			unconfirmed: 0
		},
		receive: null,
		coinbaseUtxos: [],
		spendableUtxos: [],
		tipHeight: 900_000,
		maturingTotal: 0,
		speedUp: [],
		scanError: null
	};
	const summary = {
		confirmed,
		unconfirmed: 0,
		hasPending: false,
		latestConfirmedTime: txs[2].time
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, ?, ?)
		 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET
		   snapshot = excluded.snapshot, summary = excluded.summary, last_synced_at = excluded.last_synced_at`
	).run(walletId, JSON.stringify(walletSnapshot), JSON.stringify(summary), Date.now());

	const token = mintSession(userId);
	db.exec('COMMIT');

	console.log('[seed-r6-horizons] seeded OK');
	console.log(`Wallet id: ${walletId}`);
	console.log('Session cookie name: cairn_session');
	console.log('');
	console.log(`TOKEN=${token}`);
	console.log('');
	console.log('In the browser console, run:');
	console.log(`  document.cookie = "cairn_session=${token}; path=/";`);
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();
