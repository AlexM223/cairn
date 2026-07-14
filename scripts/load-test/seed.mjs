// Seeds the throwaway SQLite database directly with node:sqlite's
// DatabaseSync — run ONLY while the server is stopped (schema already
// created by a prior bootServerForSchema() boot; see run.mjs's sequence).
//
// Table/column shapes below are copy-verified against src/lib/server/db.ts
// (users/sessions/wallets/wallet_snapshots/portfolio_snapshot/tx_labels/
// address_labels/notification_preferences) rather than guessed — see the
// FINAL REPORT for the exact line references each shape was checked against.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDbPath, RESULTS_DIR, FIXTURES_DIR } from './config.mjs';
import { hdkeyFromZpub, deriveP2wpkhAddress } from './xpubDerive.mjs';

export const SEED_USER_COUNT = 200; // includes the admin (user 0)
export const SEED_ADMIN_WALLET_COUNT = 55;
export const HOT_WALLET_TX_COUNT = 130;
export const HOT_WALLET_ADDRESS_COUNT = 1100; // stand-in for "1000+ UTXOs" — see FINAL REPORT deviation note
const SESSION_DAYS = 30;

function sha256hex(s) {
	return createHash('sha256').update(s).digest('hex');
}

function mintToken() {
	return randomBytes(32).toString('base64url');
}

function loadXpubs() {
	const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'xpubs.json'), 'utf8');
	const xpubs = JSON.parse(raw);
	if (!Array.isArray(xpubs) || xpubs.length < SEED_ADMIN_WALLET_COUNT + SEED_USER_COUNT * 2) {
		throw new Error(
			`fixtures/xpubs.json has ${xpubs.length} entries — not enough for the planned wallet count. ` +
				`Regenerate with: node scripts/load-test/fixtures/generate-xpubs.mjs <count>`
		);
	}
	return xpubs;
}

/** Deterministic 1/2/3 wallet-count cycle for non-admin users (average 2),
 *  so total wallet count never depends on Math.random() and always stays
 *  comfortably under the fixture budget. */
function walletCountFor(userIndex) {
	return 1 + (userIndex % 3);
}

function randHex(bytes) {
	return randomBytes(bytes).toString('hex');
}

function nowIso() {
	return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/** Build a WalletSnapshot (src/lib/server/walletSync.ts:84-96) + its
 *  CachedSummary (walletSync.ts:154, summarizeTxs at :163-175) for one
 *  wallet. `hot` seeds a much larger address/tx set (cairn-3h0v). */
function buildWalletSnapshotAndSummary(hdkey, { hot }) {
	const addressCount = hot ? HOT_WALLET_ADDRESS_COUNT : 3 + (hdkey._i % 8 || 5);
	const txCount = hot ? HOT_WALLET_TX_COUNT : 2 + (hdkey._i % 6);
	const tipHeight = 871000;

	const addresses = [];
	for (let i = 0; i < addressCount; i++) {
		const change = i % 5 === 0 ? 1 : 0;
		const index = Math.floor(i / 2);
		let address;
		try {
			address = deriveP2wpkhAddress(hdkey, change, index);
		} catch {
			address = `bc1q${randHex(20)}`; // pathological derivation index — fall back rather than abort seeding
		}
		const used = i < addressCount * 0.6;
		addresses.push({
			address,
			derivationPath: `m/${change}/${index}`,
			index,
			change: change === 1,
			used,
			balance: used ? (i * 733) % 250_000 : 0,
			txCount: used ? 1 + (i % 3) : 0
		});
	}

	const txs = [];
	let confirmedSats = 0;
	let unconfirmedSats = 0;
	const nowSec = Math.floor(Date.now() / 1000);
	for (let i = 0; i < txCount; i++) {
		const isPending = hot ? i % 25 === 0 : i === 0 && txCount > 3;
		const delta = (i % 2 === 0 ? 1 : -1) * (10_000 + ((i * 9973) % 400_000));
		if (isPending) unconfirmedSats += delta;
		else confirmedSats += delta;
		txs.push({
			txid: randHex(32),
			height: isPending ? 0 : tipHeight - (i % 500),
			time: isPending ? null : nowSec - i * 3600,
			delta,
			fee: isPending ? null : 200 + (i % 800)
		});
	}

	// cairn-g1u2: the full spendable coin set a real doWalletScan now persists so
	// the send page can render coin control + spendable balance from the snapshot
	// when the wallet is clean, instead of a live re-scan. One coin per used,
	// funded address — for the hot wallet this is the ~660-UTXO set the send page's
	// coin-control list serialises. All confirmed + mature so none is folded out.
	const spendableUtxos = [];
	for (const a of addresses) {
		if (a.used && a.balance > 0) {
			spendableUtxos.push({
				txid: randHex(32),
				vout: 0,
				value: a.balance,
				height: tipHeight - 10,
				coinbase: false
			});
		}
	}

	const snapshot = {
		scan: { addresses, txs, confirmed: confirmedSats, unconfirmed: unconfirmedSats },
		receive: {
			address: addresses[0]?.address ?? `bc1q${randHex(20)}`,
			path: 'm/0/0',
			index: 0,
			// Placeholder data URL, not a real rendered QR — nothing in the load
			// test decodes it, only checks the field is a non-empty string
			// (deviation from a live doWalletScan, noted in the FINAL REPORT).
			qr: 'data:image/png;base64,loadtest'
		},
		coinbaseUtxos: [],
		spendableUtxos,
		tipHeight,
		speedUp: [],
		scanError: null
	};

	let hasPending = false;
	let latest = null;
	for (const tx of txs) {
		if (tx.height <= 0) hasPending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	const summary = {
		confirmed: confirmedSats,
		unconfirmed: unconfirmedSats,
		hasPending,
		latestConfirmedTime: latest
	};

	return { snapshot, summary };
}

/** Minimal-but-valid PortfolioDetail (src/lib/types.ts:347-360) built from
 *  the wallets just seeded for this user. */
function buildPortfolioDetail(walletRows) {
	const allocation = walletRows.map((w) => ({
		key: `wallet-${w.id}`,
		kind: 'wallet',
		id: w.id,
		name: w.name,
		href: `/wallets/${w.id}`,
		balance: w.confirmed,
		lastActivity: w.latestConfirmedTime
	}));
	const recentActivity = walletRows.slice(0, 5).flatMap((w) =>
		w.sampleTxs.slice(0, 3).map((tx) => ({
			key: `wallet-${w.id}-${tx.txid}`,
			walletName: w.name,
			walletHref: `/wallets/${w.id}`,
			txid: tx.txid,
			direction: tx.delta >= 0 ? 'in' : 'out',
			sats: Math.abs(tx.delta),
			time: tx.time,
			confirmations: tx.height > 0 ? 6 : 0
		}))
	);
	const confirmed = walletRows.reduce((s, w) => s + w.confirmed, 0);
	const unconfirmed = walletRows.reduce((s, w) => s + w.unconfirmed, 0);
	const nowSec = Math.floor(Date.now() / 1000);
	const balanceSeries = [0, 1, 2].map((i) => ({
		t: nowSec - (2 - i) * 86400,
		sats: Math.max(0, confirmed - (2 - i) * 1000)
	}));
	const sparklines = {};
	for (const w of walletRows) sparklines[`wallet-${w.id}`] = [w.confirmed, w.confirmed];

	return {
		walletCount: walletRows.length,
		scannedCount: walletRows.length,
		confirmed,
		unconfirmed,
		allocation,
		recentActivity,
		balanceSeries,
		sparklines,
		change: { d1: 0, d7: 0, d30: 0 }
	};
}

/**
 * Seed the database at dbPath. MUST be called while no server process holds
 * it open (node:sqlite is a single-writer connection; the schema is assumed
 * already created by a prior schema-boot pass — see run.mjs).
 */
export function seedDatabase(dbPath) {
	assertSafeDbPath(dbPath);
	const xpubs = loadXpubs();
	let xpubCursor = 0;
	const nextXpub = () => {
		if (xpubCursor >= xpubs.length) throw new Error('ran out of unique xpub fixtures while seeding');
		return xpubs[xpubCursor++];
	};

	const db = new DatabaseSync(dbPath);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

	const insertUser = db.prepare(
		`INSERT INTO users (email, password_hash, display_name, is_admin, disabled, must_reset_password)
		 VALUES (?, NULL, ?, ?, 0, 0)`
	);
	const insertSession = db.prepare(
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`
	);
	const insertWallet = db.prepare(
		`INSERT INTO wallets (user_id, name, type, xpub, script_type, receive_cursor, master_fingerprint, derivation_path, device_type)
		 VALUES (?, ?, 'xpub', ?, 'p2wpkh', 50, ?, 'm/84''/0''/0''', NULL)`
	);
	const insertSnapshot = db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, ?, ?)`
	);
	const insertPortfolio = db.prepare(
		`INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, ?, ?)`
	);
	const insertTxLabel = db.prepare(
		`INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, ?)
		 ON CONFLICT(wallet_id, txid) DO NOTHING`
	);
	const insertAddrLabel = db.prepare(
		`INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES ('wallet', ?, ?, ?)
		 ON CONFLICT(wallet_kind, wallet_id, address) DO NOTHING`
	);
	const insertNotifPref = db.prepare(
		`INSERT INTO notification_preferences (user_id, event_type, channel, enabled, config)
		 VALUES (?, ?, ?, 1, NULL)
		 ON CONFLICT(user_id, event_type, channel) DO NOTHING`
	);
	// appGateRedirect (src/lib/server/appGate.ts) 302s every (app)-group page
	// to /disclosure, /agreement, or /recovery-setup until these are recorded
	// — without seeding them, EVERY page GET in the scenarios below would
	// bounce through the gate instead of rendering the real page. Values
	// don't need to be cryptographically real (hasRecoverySetup /
	// hasAcceptedAdminDisclosure only check row presence; hasAcceptedCurrentAgreement
	// compares the stored version number).
	const insertAdminDisclosure = db.prepare(
		`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?)`
	);
	const insertAgreement = db.prepare(
		`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, NULL)`
	);
	const insertRecoveryPhrase = db.prepare(
		`INSERT INTO account_recovery_phrases (user_id, phrase_hash) VALUES (?, ?)`
	);
	const insertRecoveryCode = db.prepare(
		`INSERT INTO account_recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)`
	);
	const agreementVersionRow = db
		.prepare(`SELECT value FROM settings WHERE key = 'user_agreement_version'`)
		.get();
	const agreementVersion = agreementVersionRow ? Number(agreementVersionRow.value) || 1 : 1;

	const sessions = [];
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();

	db.exec('BEGIN');
	try {
		let walletsCreated = 0;
		for (let u = 0; u < SEED_USER_COUNT; u++) {
			const isAdmin = u === 0;
			const email = `loadtest+${u}@cairn.local`;
			const displayName = isAdmin ? 'Load Test Admin' : `Load Test User ${u}`;
			const userResult = insertUser.run(email, displayName, isAdmin ? 1 : 0);
			const userId = Number(userResult.lastInsertRowid);

			const token = mintToken();
			insertSession.run(sha256hex(token), userId, expiresAt);
			const sessionEntry = { userId, email, token, isAdmin, firstWalletId: null, seedTxid: null };
			sessions.push(sessionEntry);

			// Clear every appGateRedirect gate up front (see comment above) so
			// scenario page GETs hit the real route instead of a 302 chain.
			if (isAdmin) {
				insertAdminDisclosure.run(userId);
				insertRecoveryPhrase.run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
				insertRecoveryCode.run(userId, `scrypt:16384:8:1:${randHex(16)}:${randHex(32)}`);
			} else {
				insertAgreement.run(userId, agreementVersion);
			}

			const walletCount = isAdmin ? SEED_ADMIN_WALLET_COUNT : walletCountFor(u);
			const walletRowsForPortfolio = [];

			for (let w = 0; w < walletCount; w++) {
				const xpub = nextXpub();
				const name = isAdmin ? `Admin Wallet ${w + 1}` : `Wallet ${w + 1}`;
				const fingerprint = randHex(4);
				const walletResult = insertWallet.run(userId, name, xpub, fingerprint);
				const walletId = Number(walletResult.lastInsertRowid);
				walletsCreated++;

				const hdkey = hdkeyFromZpub(xpub);
				hdkey._i = walletId; // cheap per-wallet variety seed for buildWalletSnapshotAndSummary
				// The designated "hot" wallet (cairn-3h0v): admin's very first wallet.
				const hot = isAdmin && w === 0;
				const { snapshot, summary } = buildWalletSnapshotAndSummary(hdkey, { hot });
				insertSnapshot.run(walletId, JSON.stringify(snapshot), JSON.stringify(summary), Date.now());

				walletRowsForPortfolio.push({
					id: walletId,
					name,
					confirmed: summary.confirmed,
					unconfirmed: summary.unconfirmed,
					latestConfirmedTime: summary.latestConfirmedTime,
					sampleTxs: snapshot.scan.txs
				});

				// Write-scenario seed data: one tx label + one address label per
				// wallet so scenario (d)'s upserts have real existing rows to hit.
				if (snapshot.scan.txs[0]) {
					insertTxLabel.run(walletId, snapshot.scan.txs[0].txid, 'Seeded label');
					if (w === 0) sessionEntry.seedTxid = snapshot.scan.txs[0].txid;
				}
				if (snapshot.scan.addresses[0]) {
					insertAddrLabel.run(walletId, snapshot.scan.addresses[0].address, 'Seeded address label');
				}
				if (w === 0) sessionEntry.firstWalletId = walletId;
			}

			const portfolio = buildPortfolioDetail(walletRowsForPortfolio);
			insertPortfolio.run(userId, JSON.stringify(portfolio), Date.now());

			// Pre-create a couple of notification-preference rows per user so
			// scenario (d)'s PATCH exercises real upserts, not just first-inserts.
			insertNotifPref.run(userId, 'tx_received', 'email');
			insertNotifPref.run(userId, 'tx_large', 'email');
		}
		db.exec('COMMIT');
		console.log(
			`[seed] ${SEED_USER_COUNT} users, ${walletsCreated} wallets seeded (admin hot wallet: ${HOT_WALLET_ADDRESS_COUNT} addresses / ${HOT_WALLET_TX_COUNT} txs)`
		);
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	} finally {
		db.close();
	}

	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.writeFileSync(path.join(RESULTS_DIR, 'sessions.json'), JSON.stringify(sessions, null, 2));
	return sessions;
}

// Allow direct invocation for debugging: `node scripts/load-test/seed.mjs <dbPath>`
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1] === fileURLToPath(import.meta.url)) {
	const dbPath = process.argv[2];
	if (!dbPath) {
		console.error('usage: node seed.mjs <dbPath>');
		process.exit(1);
	}
	seedDatabase(dbPath);
}
