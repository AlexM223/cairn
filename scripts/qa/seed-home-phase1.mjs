// scripts/qa/seed-home-phase1.mjs
//
// Seeds four throwaway users covering the three Home render states from the
// UX redesign spec (docs/UX-REDESIGN-SPEC.md §2.1, cairn-gt05.1):
//   - qa-home-zero@test.local   -- State A (zero wallets)
//   - qa-home-solo@test.local   -- State B, one wallet, funded, with activity
//   - qa-home-multi@test.local  -- State B, three wallets (compact list)
//   - qa-home-empty@test.local  -- State B, one wallet, zero balance, no
//                                  activity yet (the "your wallet is empty" nudge)
//
// Deliberately has NO src/ imports (shared checkout) -- node:sqlite +
// node:crypto against a throwaway DB, mirroring seed-flagmatrix.mjs. Wallet
// rows use real xpubs (seed-explorer-wallet.mjs's pattern) so the page never
// hits a parse error; the portfolio itself is written directly into
// portfolio_snapshot so rendering is deterministic and needs no live chain
// connectivity.
//
// Usage: node scripts/qa/seed-home-phase1.mjs --db data/qa-home.db

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
	console.error('usage: node scripts/qa/seed-home-phase1.mjs --db <dbPath>');
	process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-home-phase1] ${dbPath} does not exist yet. Boot the server once first.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

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

function writePortfolio(userId, detail) {
	db.prepare(
		`INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET detail = excluded.detail, last_synced_at = excluded.last_synced_at`
	).run(userId, JSON.stringify(detail), Date.now());
}

const agreementVersionRow = db
	.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`)
	.get();
const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

const tokens = {};

db.exec('BEGIN');
try {
	// --- State A: zero wallets ------------------------------------------
	const zeroId = upsertUser({
		email: 'qa-home-zero@test.local',
		displayName: 'QA Home Zero',
		isAdmin: false
	});
	clearGateBlockers(zeroId, false, agreementVersion);
	tokens.zero = mintSession(zeroId);

	// --- State B: solo wallet, funded, with activity ---------------------
	const soloId = upsertUser({
		email: 'qa-home-solo@test.local',
		displayName: 'QA Home Solo',
		isAdmin: false
	});
	clearGateBlockers(soloId, false, agreementVersion);
	const soloWalletId = upsertWallet(soloId, 'Everyday Spending', 201);
	writePortfolio(soloId, {
		walletCount: 1,
		scannedCount: 1,
		confirmed: 4_020_000,
		unconfirmed: 15_000,
		allocation: [
			{
				key: `wallet-${soloWalletId}`,
				kind: 'wallet',
				id: soloWalletId,
				name: 'Everyday Spending',
				href: `/wallets/${soloWalletId}`,
				balance: 4_020_000,
				lastActivity: Math.floor(Date.now() / 1000) - 7200
			}
		],
		recentActivity: [
			{
				key: `wallet-${soloWalletId}-tx1`,
				walletName: 'Everyday Spending',
				walletHref: `/wallets/${soloWalletId}`,
				txid: 'a'.repeat(64),
				direction: 'in',
				sats: 12_000_000,
				time: Math.floor(Date.now() / 1000) - 7200,
				confirmations: 6
			},
			{
				key: `wallet-${soloWalletId}-tx2`,
				walletName: 'Everyday Spending',
				walletHref: `/wallets/${soloWalletId}`,
				txid: 'b'.repeat(64),
				direction: 'out',
				sats: 4_500_000,
				time: Math.floor(Date.now() / 1000) - 90_000,
				confirmations: 20
			}
		],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d7: null, d30: null }
	});
	tokens.solo = mintSession(soloId);

	// --- State B: multi-wallet (compact list) -----------------------------
	const multiId = upsertUser({
		email: 'qa-home-multi@test.local',
		displayName: 'QA Home Multi',
		isAdmin: false
	});
	clearGateBlockers(multiId, false, agreementVersion);
	const w1 = upsertWallet(multiId, 'Everyday Spending', 211);
	const w2 = upsertWallet(multiId, 'Cold Storage', 212);
	const w3 = upsertWallet(multiId, 'Travel Fund', 213);
	writePortfolio(multiId, {
		walletCount: 3,
		scannedCount: 3,
		confirmed: 41_000_000,
		unconfirmed: 0,
		allocation: [
			{
				key: `wallet-${w1}`,
				kind: 'wallet',
				id: w1,
				name: 'Everyday Spending',
				href: `/wallets/${w1}`,
				balance: 31_000_000,
				lastActivity: Math.floor(Date.now() / 1000) - 3600
			},
			{
				key: `wallet-${w2}`,
				kind: 'wallet',
				id: w2,
				name: 'Cold Storage',
				href: `/wallets/${w2}`,
				balance: 10_000_000,
				lastActivity: Math.floor(Date.now() / 1000) - 800_000
			},
			{
				key: `wallet-${w3}`,
				kind: 'wallet',
				id: w3,
				name: 'Travel Fund',
				href: `/wallets/${w3}`,
				balance: 0,
				lastActivity: null
			}
		],
		recentActivity: [
			{
				key: `wallet-${w1}-tx1`,
				walletName: 'Everyday Spending',
				walletHref: `/wallets/${w1}`,
				txid: 'c'.repeat(64),
				direction: 'in',
				sats: 12_000_000,
				time: Math.floor(Date.now() / 1000) - 3600,
				confirmations: 3
			}
		],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d7: null, d30: null }
	});
	tokens.multi = mintSession(multiId);

	// --- State B: empty wallet (zero balance, no activity) -----------------
	const emptyId = upsertUser({
		email: 'qa-home-empty@test.local',
		displayName: 'QA Home Empty',
		isAdmin: false
	});
	clearGateBlockers(emptyId, false, agreementVersion);
	const emptyWalletId = upsertWallet(emptyId, 'New Wallet', 221);
	writePortfolio(emptyId, {
		walletCount: 1,
		scannedCount: 1,
		confirmed: 0,
		unconfirmed: 0,
		allocation: [
			{
				key: `wallet-${emptyWalletId}`,
				kind: 'wallet',
				id: emptyWalletId,
				name: 'New Wallet',
				href: `/wallets/${emptyWalletId}`,
				balance: 0,
				lastActivity: null
			}
		],
		recentActivity: [],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d7: null, d30: null }
	});
	tokens.empty = mintSession(emptyId);

	db.exec('COMMIT');
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();

console.log('[seed-home-phase1] seeded OK');
console.log('Session cookie name: cairn_session');
console.log('');
for (const [name, token] of Object.entries(tokens)) {
	console.log(`${name.toUpperCase()}_TOKEN=${token}`);
}
console.log('');
console.log('In the browser console, run e.g.:');
console.log(`  document.cookie = "cairn_session=${tokens.zero}; path=/";`);
