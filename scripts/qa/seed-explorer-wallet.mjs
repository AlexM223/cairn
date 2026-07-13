// scripts/qa/seed-explorer-wallet.mjs
//
// Adds one real-xpub single-sig wallet to the admin user seeded by
// seed-flagmatrix.mjs, purely so the explorer's "Yours" pip / pending-tx band
// has a wallet to look up (cairn-6efi visual QA). Background wallet sync
// (against public Electrum) fills in wallet_snapshots after boot; this script
// does not wait for that -- it only guarantees the wallet row exists.
//
// Usage: node scripts/qa/seed-explorer-wallet.mjs --db data/qa-explorer.db

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { HDKey } from '@scure/bip32';

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--db') out.db = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) {
	console.error('usage: node scripts/qa/seed-explorer-wallet.mjs --db <dbPath>');
	process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
	console.error(`[seed-explorer-wallet] ${dbPath} does not exist yet. Boot the server once first.`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const admin = db.prepare(`SELECT id FROM users WHERE email = 'qa-matrix@test.local'`).get();
if (!admin) {
	console.error('[seed-explorer-wallet] admin user not found -- run seed-flagmatrix.mjs first.');
	db.close();
	process.exit(1);
}

function realXpub(seedByte) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive("m/84'/0'/0'");
	return account.publicExtendedKey;
}

const xpub = realXpub(217);
const existing = db.prepare(`SELECT id FROM wallets WHERE user_id = ? AND xpub = ?`).get(admin.id, xpub);
if (existing) {
	console.log(`[seed-explorer-wallet] wallet already exists id=${existing.id}`);
} else {
	const res = db
		.prepare(`INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, 'Explorer QA Wallet', 'xpub', ?, 'p2wpkh')`)
		.run(admin.id, xpub);
	console.log(`[seed-explorer-wallet] inserted wallet id=${res.lastInsertRowid}`);
}
db.close();
