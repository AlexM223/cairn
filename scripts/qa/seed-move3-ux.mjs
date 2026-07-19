// scripts/qa/seed-move3-ux.mjs
//
// Seeds three throwaway users for Move-3 UX Phase 2-4 browser QA
// (cairn-gt05.2/.3/.4, branch move3/ux-polish):
//   - qa-m3-admin@test.local  -- admin, one UNBACKED wallet (drives the amber
//                                Backups row on the Health page + Settings QA)
//   - qa-m3-solo@test.local   -- one funded wallet w/ activity (Send create/
//                                review, wallet detail, receive subpage QA);
//                                on a live regtest stack fund its first
//                                address and the watcher takes over
//   - qa-m3-empty@test.local  -- one zero-balance wallet (zero-balance Send
//                                empty state)
//
// No src/ imports (shared checkout) -- node:sqlite + node:crypto against the
// instance DB, mirroring seed-home-phase1.mjs.
//
// Usage: node scripts/qa/seed-move3-ux.mjs --db data/cairn.db

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

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
	console.error('usage: node scripts/qa/seed-move3-ux.mjs --db <dbPath>');
	process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-move3-ux] ${dbPath} does not exist yet. Boot the server once first.`);
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

// Regtest QA instance: derive the BIP84 *testnet* account and re-encode as a
// SLIP-132 vpub, which is what a chain_network=regtest backend requires
// (mainnet xpubs are rejected outright — see bitcoin/xpub.ts).
const b58check = createBase58check(sha256);
const VPUB_VERSION = 0x045f1cf6;
function realXpub(seedByte) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive("m/84'/1'/0'");
	const raw = b58check.decode(account.publicExtendedKey);
	const out = new Uint8Array(raw);
	out[0] = (VPUB_VERSION >>> 24) & 0xff;
	out[1] = (VPUB_VERSION >>> 16) & 0xff;
	out[2] = (VPUB_VERSION >>> 8) & 0xff;
	out[3] = VPUB_VERSION & 0xff;
	return b58check.encode(out);
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
const walletIds = {};

db.exec('BEGIN');
try {
	// --- Admin: one UNBACKED wallet -> amber Backups duty on Health ---------
	const adminId = upsertUser({
		email: 'qa-m3-admin@test.local',
		displayName: 'QA M3 Admin',
		isAdmin: true
	});
	clearGateBlockers(adminId, true, agreementVersion);
	const adminWalletId = upsertWallet(adminId, 'Ops Wallet', 231);
	walletIds.admin = adminWalletId;
	writePortfolio(adminId, {
		walletCount: 1,
		scannedCount: 1,
		confirmed: 2_500_000,
		unconfirmed: 0,
		allocation: [
			{
				key: `wallet-${adminWalletId}`,
				kind: 'wallet',
				id: adminWalletId,
				name: 'Ops Wallet',
				href: `/wallets/${adminWalletId}`,
				balance: 2_500_000,
				lastActivity: Math.floor(Date.now() / 1000) - 5000
			}
		],
		recentActivity: [],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d7: null, d30: null }
	});
	tokens.admin = mintSession(adminId);

	// --- Solo: funded wallet with activity (send/receive/detail QA) ---------
	const soloId = upsertUser({
		email: 'qa-m3-solo@test.local',
		displayName: 'QA M3 Solo',
		isAdmin: false
	});
	clearGateBlockers(soloId, false, agreementVersion);
	const soloWalletId = upsertWallet(soloId, 'Everyday Spending', 232);
	walletIds.solo = soloWalletId;
	writePortfolio(soloId, {
		walletCount: 1,
		scannedCount: 1,
		confirmed: 4_020_000,
		unconfirmed: 0,
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
				sats: 4_020_000,
				time: Math.floor(Date.now() / 1000) - 7200,
				confirmations: 6
			}
		],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d7: null, d30: null }
	});
	tokens.solo = mintSession(soloId);

	// --- Empty: zero-balance wallet (zero-balance Send empty state) ---------
	const emptyId = upsertUser({
		email: 'qa-m3-empty@test.local',
		displayName: 'QA M3 Empty',
		isAdmin: false
	});
	clearGateBlockers(emptyId, false, agreementVersion);
	const emptyWalletId = upsertWallet(emptyId, 'New Wallet', 233);
	walletIds.empty = emptyWalletId;
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

console.log('[seed-move3-ux] seeded OK');
console.log('Session cookie name: cairn_session');
console.log('');
for (const [name, token] of Object.entries(tokens)) {
	console.log(`${name.toUpperCase()}_TOKEN=${token}`);
}
for (const [name, id] of Object.entries(walletIds)) {
	console.log(`${name.toUpperCase()}_WALLET_ID=${id}`);
}
console.log('');
console.log('Browser console: document.cookie = "cairn_session=<TOKEN>; path=/";');
