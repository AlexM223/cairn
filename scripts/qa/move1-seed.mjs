// Seed the Move-1 QA DB (data/move1-qa.db) with everything the watchtower-wave
// UI QA needs — no chain stack required, pages render from persisted snapshots:
//   - admin user + minted session (token printed for document.cookie)
//   - one wallet with a snapshot carrying: maturing coinbase (50 BTC, 11 confs),
//     an UNVERIFIED young coin (0.5 BTC, cairn-8lwa6), a plain 1 BTC coin
//   - portfolio aggregate mirroring it (Home hero + maturing/verifying lines,
//     Mining-reward activity tag)
//   - mining_blocks + mining_prefs + 'mining' feature flag (Total earned /
//     Matured labels on /mining, cairn-e176o)
//   - a mining_block_found event (flame glyph on /activity, cairn-i0d0q)
// Usage: node scripts/qa/move1-seed.mjs   (after the dev server created the DB)
import { DatabaseSync } from 'node:sqlite';
import { scrypt, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';

const dbPath = 'C:/dev/cairn-move1/data/move1-qa.db';
const email = 'qa-move1@test.local';
const password = 'Move1Qa!2026x';
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const CB_TXID = 'c0'.repeat(32); // maturing coinbase (pool-found)
const UNV_TXID = 'ee'.repeat(32); // unverified young coin
const PLAIN_TXID = 'aa'.repeat(32); // ordinary deposit
const TIP = 250;
const NOW = Math.floor(Date.now() / 1000);

function scryptAsync(pw, salt, keylen, options) {
	return new Promise((res, rej) => scrypt(pw, salt, keylen, options, (e, dk) => (e ? rej(e) : res(dk))));
}
async function hashPassword(pw) {
	const salt = randomBytes(16);
	const hash = await scryptAsync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
	return `scrypt:16384:8:1:${salt.toString('base64')}:${hash.toString('base64')}`;
}
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

if (!fs.existsSync(dbPath)) {
	console.error(`[move1-seed] ${dbPath} missing — start the dev server once first.`);
	process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const passwordHash = await hashPassword(password);
const agreementVersion = Number(
	db.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`).get()?.value ?? 1
);

db.exec('BEGIN');
try {
	// --- user + session -------------------------------------------------------
	let userId;
	const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
	if (existing) {
		userId = Number(existing.id);
		db.prepare(
			`UPDATE users SET password_hash = ?, is_admin = 1, disabled = 0, must_reset_password = 0 WHERE id = ?`
		).run(passwordHash, userId);
	} else {
		userId = Number(
			db
				.prepare(
					`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
					 VALUES (?, ?, 'Move1 QA', 1, 0, 0)`
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
	db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
	const token = randomBytes(32).toString('base64url');
	db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(
		sha256hex(token),
		userId,
		new Date(Date.now() + 30 * 86_400_000).toISOString()
	);

	// --- wallet + snapshot ----------------------------------------------------
	db.prepare(`DELETE FROM wallets WHERE user_id = ?`).run(userId);
	const walletId = Number(
		db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint, derivation_path)
				 VALUES (?, 'Watchtower QA', 'xpub', ?, 'p2wpkh', '73c5da0a', 'm/84''/0''/0''')`
			)
			.run(userId, ZPUB).lastInsertRowid
	);
	const txs = [
		{ txid: CB_TXID, height: 240, time: NOW - 6600, delta: 5_000_000_000, fee: null },
		{ txid: UNV_TXID, height: 245, time: NOW - 3600, delta: 50_000_000, fee: null },
		{ txid: PLAIN_TXID, height: 200, time: NOW - 86_400, delta: 100_000_000, fee: null }
	];
	const snapshot = {
		scan: { addresses: [], txs, confirmed: 5_150_000_000, unconfirmed: 0 },
		receive: null,
		coinbaseUtxos: [{ txid: CB_TXID, vout: 0, value: 5_000_000_000, height: 240 }],
		spendableUtxos: [],
		tipHeight: TIP,
		maturingTotal: 5_000_000_000,
		unverifiedTotal: 50_000_000,
		speedUp: [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, NULL, ?)
		 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET snapshot = excluded.snapshot,
		   last_synced_at = excluded.last_synced_at`
	).run(walletId, JSON.stringify(snapshot), Date.now());

	// --- portfolio aggregate (what Home's GET /api/portfolio serves) ----------
	const key = `wallet-${walletId}`;
	const detail = {
		walletCount: 1,
		scannedCount: 1,
		confirmed: 5_150_000_000,
		unconfirmed: 0,
		maturingTotal: 5_000_000_000,
		unverifiedTotal: 50_000_000,
		allocation: [
			{
				key,
				kind: 'wallet',
				id: walletId,
				name: 'Watchtower QA',
				href: `/wallets/${walletId}`,
				balance: 5_150_000_000,
				lastActivity: NOW - 3600
			}
		],
		recentActivity: [
			{
				key: `${key}-${UNV_TXID}`,
				walletName: 'Watchtower QA',
				walletHref: `/wallets/${walletId}`,
				txid: UNV_TXID,
				direction: 'in',
				sats: 50_000_000,
				time: NOW - 3600,
				confirmations: TIP - 245 + 1
			},
			{
				key: `${key}-${CB_TXID}`,
				walletName: 'Watchtower QA',
				walletHref: `/wallets/${walletId}`,
				txid: CB_TXID,
				direction: 'in',
				sats: 5_000_000_000,
				time: NOW - 6600,
				confirmations: TIP - 240 + 1,
				isMiningReward: true
			},
			{
				key: `${key}-${PLAIN_TXID}`,
				walletName: 'Watchtower QA',
				walletHref: `/wallets/${walletId}`,
				txid: PLAIN_TXID,
				direction: 'in',
				sats: 100_000_000,
				time: NOW - 86_400,
				confirmations: TIP - 200 + 1
			}
		],
		balanceSeries: [],
		sparklines: {},
		change: { d1: null, d30: null, d365: null, all: null }
	};
	db.prepare(
		`INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET detail = excluded.detail, last_synced_at = excluded.last_synced_at`
	).run(userId, JSON.stringify(detail), Date.now());

	// --- mining: flag, prefs, found blocks ------------------------------------
	db.prepare(
		`INSERT INTO feature_flags (key, enabled) VALUES ('mining', 1)
		 ON CONFLICT(key) DO UPDATE SET enabled = 1`
	).run();
	db.prepare(
		`INSERT INTO mining_prefs (user_id, mining_id, enabled, payout_wallet_id) VALUES (?, ?, 1, ?)
		 ON CONFLICT(user_id) DO UPDATE SET enabled = 1, payout_wallet_id = excluded.payout_wallet_id`
	).run(userId, `hw_${sha256hex(email).slice(0, 8)}`, walletId);
	db.prepare(`DELETE FROM mining_blocks WHERE user_id = ?`).run(userId);
	const insBlock = db.prepare(
		`INSERT INTO mining_blocks (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id, payout_address, coinbase_value_sats, found_at, submit_result)
		 VALUES (?, ?, ?, ?, 'qa-rig', ?, 'bcrt1qmove1payout', ?, ?, 'accepted')`
	);
	// Maturing block (the snapshot's coinbase UTXO) + an older MATURE block.
	insBlock.run(240, 'b1'.repeat(32), CB_TXID, userId, walletId, '5000000000', new Date(Date.now() - 6_600_000).toISOString());
	insBlock.run(120, 'b2'.repeat(32), 'c1'.repeat(32), userId, walletId, '5000000000', new Date(Date.now() - 86_400_000).toISOString());

	// --- activity event (flame glyph, cairn-i0d0q) ----------------------------
	db.prepare(
		`INSERT INTO events (user_id, type, level, message, detail)
		 VALUES (?, 'mining_block_found', 'success', 'Block found! Your pool mined block 240 — 50.00000000 BTC to Watchtower QA.', ?)`
	).run(userId, JSON.stringify({ height: 240, link: '/mining' }));

	db.exec('COMMIT');
	console.log(`[move1-seed] OK user=${userId} wallet=${walletId}`);
	console.log(`[move1-seed] cookie: cairn_session=${token}`);
} catch (e) {
	db.exec('ROLLBACK');
	db.close();
	throw e;
}
db.close();
