import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, AuthError } from './auth';
import { setSetting } from './settings';
import { getLabels, setLabel, deleteWallet, TX_LABEL_MAX } from './wallets';

const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);

function wipe(): void {
	db.exec(
		'DELETE FROM tx_labels; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

let xpubSeq = 0;
function makeWallet(userId: number): number {
	const res = db
		.prepare(
			"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')"
		)
		.run(userId, `xpub-test-${xpubSeq++}`);
	return Number(res.lastInsertRowid);
}

describe('tx labels', () => {
	it('getLabels returns an empty record for an owned wallet with no labels', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		expect(getLabels(user.id, walletId)).toEqual({});
	});

	it('getLabels and setLabel return null for missing or non-owned wallets', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const walletId = makeWallet(owner.id);

		expect(getLabels(other.id, walletId)).toBeNull();
		expect(getLabels(owner.id, 9999)).toBeNull();
		expect(setLabel(other.id, walletId, TXID_A, 'sneaky')).toBeNull();
		expect(setLabel(owner.id, 9999, TXID_A, 'nope')).toBeNull();
		// The non-owner write must not have landed.
		expect(getLabels(owner.id, walletId)).toEqual({});
	});

	it('setLabel inserts a trimmed label and getLabels returns it keyed by txid', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		expect(setLabel(user.id, walletId, TXID_A, '  rent  ')).toEqual({
			txid: TXID_A,
			label: 'rent'
		});
		setLabel(user.id, walletId, TXID_B, 'invoice #4021');
		expect(getLabels(user.id, walletId)).toEqual({
			[TXID_A]: 'rent',
			[TXID_B]: 'invoice #4021'
		});
	});

	it('setLabel upserts: relabeling the same txid replaces the old label', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		setLabel(user.id, walletId, TXID_A, 'rent');
		setLabel(user.id, walletId, TXID_A, 'rent — March');
		expect(getLabels(user.id, walletId)).toEqual({ [TXID_A]: 'rent — March' });
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM tx_labels WHERE wallet_id = ?')
			.get(walletId) as { n: number };
		expect(n).toBe(1);
	});

	it(`setLabel caps labels at ${TX_LABEL_MAX} characters`, async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		const long = 'x'.repeat(TX_LABEL_MAX + 40);
		const res = setLabel(user.id, walletId, TXID_A, long);
		expect(res?.label).toHaveLength(TX_LABEL_MAX);
		expect(getLabels(user.id, walletId)?.[TXID_A]).toHaveLength(TX_LABEL_MAX);
	});

	it('setLabel with an empty or whitespace label clears an existing one', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		setLabel(user.id, walletId, TXID_A, 'rent');
		expect(setLabel(user.id, walletId, TXID_A, '   ')).toEqual({ txid: TXID_A, label: '' });
		expect(getLabels(user.id, walletId)).toEqual({});
		// Clearing a label that never existed is a harmless no-op.
		expect(setLabel(user.id, walletId, TXID_B, '')).toEqual({ txid: TXID_B, label: '' });
	});

	it('labels are scoped per wallet: same txid can carry different labels', async () => {
		const user = await makeUser('owner@example.com');
		const w1 = makeWallet(user.id);
		const w2 = makeWallet(user.id);

		setLabel(user.id, w1, TXID_A, 'rent');
		setLabel(user.id, w2, TXID_A, 'savings top-up');
		expect(getLabels(user.id, w1)).toEqual({ [TXID_A]: 'rent' });
		expect(getLabels(user.id, w2)).toEqual({ [TXID_A]: 'savings top-up' });
	});

	it('deleting a wallet cascades away its labels', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		setLabel(user.id, walletId, TXID_A, 'rent');

		expect(deleteWallet(user.id, walletId)).toBe(true);
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM tx_labels WHERE wallet_id = ?')
			.get(walletId) as { n: number };
		expect(n).toBe(0);
	});
});

// ---- cairn-vop2: deleteWallet refuses while a live broadcast claim exists ----
//
// deleteWallet's cascade (transactions.wallet_id ON DELETE CASCADE) used to have
// no guard at all, unlike deleteTransaction's per-row broadcast check (cairn-up0q).
// The fix mirrors that guard at the wallet level: refuse only while a claim is
// still live (< 60s old, the same window broadcastTransaction itself uses to
// reclaim a crashed attempt) — a completed/superseded transaction, or a STALE
// claim, does not block a deliberate whole-wallet delete.

function insertTx(
	walletId: number,
	opts: { status?: string; broadcastStartedAt?: string | null } = {}
): number {
	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, broadcast_started_at)
			 VALUES (?, ?, 'cHNidA==', 'bc1qtest', 10000, 100, 5, ?)`
		)
		.run(walletId, opts.status ?? 'awaiting_signature', opts.broadcastStartedAt ?? null);
	return Number(res.lastInsertRowid);
}

describe('deleteWallet broadcast-claim guard (cairn-vop2)', () => {
	it('refuses while a transaction has a live (fresh) broadcast claim', async () => {
		const user = await makeUser('livebroadcast@example.com');
		const walletId = makeWallet(user.id);
		insertTx(walletId);
		db.prepare(
			"UPDATE transactions SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE wallet_id = ?"
		).run(walletId);

		expect(() => deleteWallet(user.id, walletId)).toThrow(AuthError);
		try {
			deleteWallet(user.id, walletId);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(AuthError);
			expect((e as AuthError).code).toBe('broadcast_in_progress');
		}
		// The wallet must still exist — the guard blocked before the DELETE ran.
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE id = ?').get(walletId) as {
			n: number;
		};
		expect(n).toBe(1);
	});

	it('allows deletion once a crashed-broadcast claim goes stale (>60s)', async () => {
		const user = await makeUser('staleclaim@example.com');
		const walletId = makeWallet(user.id);
		insertTx(walletId);
		db.prepare(
			"UPDATE transactions SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds') WHERE wallet_id = ?"
		).run(walletId);

		expect(deleteWallet(user.id, walletId)).toBe(true);
	});

	it('allows deletion of a wallet whose transactions are completed/superseded (no live claim)', async () => {
		const user = await makeUser('completed@example.com');
		const walletId = makeWallet(user.id);
		insertTx(walletId, { status: 'completed' });
		insertTx(walletId, { status: 'superseded' });

		expect(deleteWallet(user.id, walletId)).toBe(true);
	});
});

// ---- cairn-cvcu: wallet creation shows up in the activity feed ------------------

import { createWallet } from './wallets';
import { listUserFeed, listAllActivity } from './activity';

// BIP84 test-vector account zpub — public test key, never a real wallet.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('createWallet activity event (cairn-cvcu)', () => {
	beforeEach(() => {
		db.exec('DELETE FROM events;');
	});

	it('emits wallet_added into the user feed and the admin log', async () => {
		const user = await makeUser('feed@example.com');
		const summary = createWallet(user.id, { name: 'Cold storage', xpub: ZPUB, deviceType: 'trezor' });

		const feed = listUserFeed(user.id);
		expect(feed).toHaveLength(1);
		expect(feed[0].type).toBe('wallet_added');
		expect(feed[0].level).toBe('success');
		expect(feed[0].message).toContain('Cold storage');
		expect(feed[0].scope).toBe('you');

		const admin = listAllActivity({ type: 'wallet_added', includeDetail: true });
		expect(admin.total).toBe(1);
		expect(admin.events[0].userId).toBe(user.id);
		expect(admin.events[0].detail).toMatchObject({
			walletKind: 'wallet',
			walletId: summary.id,
			deviceType: 'trezor'
		});
		// Privacy: the xpub itself never lands in the event detail.
		expect(JSON.stringify(admin.events[0].detail)).not.toContain(ZPUB);
	});

	it('does not emit when creation fails (duplicate key)', async () => {
		const user = await makeUser('dup@example.com');
		createWallet(user.id, { name: 'First', xpub: ZPUB });
		db.exec('DELETE FROM events;');
		expect(() => createWallet(user.id, { name: 'Second', xpub: ZPUB })).toThrow(/already/i);
		expect(listUserFeed(user.id)).toHaveLength(0);
	});
});

// ---- cairn-alw8: createWallet persists the key origin -----------------------------------
//
// Without wallets.master_fingerprint, constructPsbt never attaches
// bip32Derivation and NO hardware wallet can sign this wallet's transactions.
// These tests pin the fix: origin arrives (explicit fields, or embedded in the
// key string) → stored; absent → honestly null, never fabricated.

import { getWallet } from './wallets';

describe('createWallet key origin (cairn-alw8)', () => {
	function originOf(userId: number, walletId: number) {
		const row = getWallet(userId, walletId);
		return { fingerprint: row?.master_fingerprint ?? null, path: row?.derivation_path ?? null };
	}

	it('stores fingerprint and path passed explicitly (device-connect flow)', async () => {
		const user = await makeUser('device@example.com');
		const w = createWallet(user.id, {
			name: 'Trezor wallet',
			xpub: ZPUB,
			deviceType: 'trezor',
			fingerprint: '73C5DA0A', // devices may report uppercase — normalized
			derivationPath: 'm/84h/0h/0h' // h-hardened — canonicalized
		});
		expect(originOf(user.id, w.id)).toEqual({
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
	});

	it('parses and stores an origin embedded in the key string (paste-descriptor flow)', async () => {
		const user = await makeUser('descriptor@example.com');
		const w = createWallet(user.id, {
			name: 'Pasted',
			xpub: `[73c5da0a/84'/0'/0']${ZPUB}`
		});
		expect(originOf(user.id, w.id)).toEqual({
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
		// The stored xpub is the bare key, not the bracketed form.
		expect(getWallet(user.id, w.id)?.xpub).toBe(ZPUB);
	});

	it('embedded origin wins over the explicit fields', async () => {
		const user = await makeUser('conflict@example.com');
		const w = createWallet(user.id, {
			xpub: `[73c5da0a/84'/0'/0']${ZPUB}`,
			fingerprint: 'deadbeef',
			derivationPath: "m/44'/0'/0'"
		});
		expect(originOf(user.id, w.id)).toEqual({
			fingerprint: '73c5da0a',
			path: "m/84'/0'/0'"
		});
	});

	it('regression guard: a bare-xpub import stores null origin (the pre-fix state)', async () => {
		const user = await makeUser('bare@example.com');
		const w = createWallet(user.id, { name: 'Bare', xpub: ZPUB });
		// This is exactly why hardware signing was broken: no fingerprint means
		// transactions.ts passes origin: null and the PSBT gets no bip32Derivation.
		expect(originOf(user.id, w.id)).toEqual({ fingerprint: null, path: null });
	});

	it('treats the all-zero placeholder fingerprint as unknown, not an error', async () => {
		const user = await makeUser('coldcard-placeholder@example.com');
		const w = createWallet(user.id, {
			xpub: ZPUB,
			fingerprint: '00000000', // ColdCard-parser placeholder for "unknown"
			derivationPath: "m/84'/0'/0'"
		});
		expect(originOf(user.id, w.id)).toEqual({ fingerprint: null, path: "m/84'/0'/0'" });
	});

	it('rejects a malformed fingerprint or path loudly instead of dropping it', async () => {
		const user = await makeUser('typo@example.com');
		expect(() => createWallet(user.id, { xpub: ZPUB, fingerprint: '73c5da0' })).toThrow(
			/fingerprint/i
		);
		expect(() => createWallet(user.id, { xpub: ZPUB, fingerprint: 'not-hex!' })).toThrow(
			/fingerprint/i
		);
		expect(() =>
			createWallet(user.id, { xpub: ZPUB, derivationPath: 'four score and seven' })
		).toThrow(/derivation path/i);
		// Nothing landed despite three attempts.
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?')
			.get(user.id) as { n: number };
		expect(n).toBe(0);
	});
});

// ---- cairn-alw8 end-to-end: created wallet → PSBT → hardware driver ---------------------
//
// Crosses every seam of the bug in one pass: createWallet persists the origin,
// the wallet row feeds constructPsbt the exact way transactions.ts does, and
// the resulting PSBT satisfies the real Trezor driver's key-origin requirement
// (the code that used to throw "missing the key-origin information" for every
// single-key wallet in the product).

import { constructPsbt, DEFAULT_ORIGIN_PATH } from './bitcoin/psbt';
import { Transaction } from '@scure/btc-signer';
import { psbtHasKeyOrigin } from '$lib/hw/keyOrigin';
import { trezorSignRequestFromPsbt } from '$lib/hw/trezor';
import type { ScriptType } from '$lib/types';

describe('created wallet signs on hardware (cairn-alw8 end-to-end)', () => {
	const HARDENED = 0x80000000;
	// m/84'/0'/0'/0/0 of the ZPUB test vector.
	const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
	const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
	const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0

	/** A synthetic funding tx with a REAL txid, so nonWitnessUtxo verification passes. */
	function fundingTx(): { hex: string; txid: string } {
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		tx.addInput({ txid: '00'.repeat(32), index: 0 });
		tx.addOutputAddress(RECEIVE_0, 100_000n);
		return { hex: tx.hex, txid: tx.id };
	}

	/** Build a spend from the wallet row EXACTLY the way transactions.ts does. */
	async function psbtFromWalletRow(userId: number, walletId: number): Promise<string> {
		const wallet = getWallet(userId, walletId)!;
		const scriptType = wallet.script_type as ScriptType;
		// Mirror of src/lib/server/transactions.ts buildDraft's origin construction.
		const origin = wallet.master_fingerprint
			? {
					fingerprint: wallet.master_fingerprint,
					path: wallet.derivation_path ?? DEFAULT_ORIGIN_PATH[scriptType]
				}
			: null;
		const fund = fundingTx();
		const details = await constructPsbt({
			xpub: wallet.xpub,
			utxos: [
				{ txid: fund.txid, vout: 0, value: 100_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
			],
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 5,
			changeAddress: CHANGE_0,
			changeIndex: 0,
			origin,
			fetchRawTx: async () => fund.hex
		});
		return details.psbtBase64;
	}

	it('a wallet imported with its origin yields a PSBT the Trezor driver accepts', async () => {
		const user = await makeUser('e2e-fixed@example.com');
		const w = createWallet(user.id, { xpub: `[73c5da0a/84'/0'/0']${ZPUB}` });

		const psbt = await psbtFromWalletRow(user.id, w.id);
		expect(psbtHasKeyOrigin(psbt)).toBe(true);

		// The real driver translation — this used to be unreachable for every
		// single-key wallet. The derived path must be the full account path plus
		// chain/index, so the device signs with the right key.
		const req = trezorSignRequestFromPsbt(psbt);
		expect(req.inputs[0].address_n).toEqual([84 + HARDENED, HARDENED, HARDENED, 0, 0]);
	});

	it('regression: a bare-xpub wallet still produces the origin-free PSBT the driver rejects', async () => {
		const user = await makeUser('e2e-broken@example.com');
		const w = createWallet(user.id, { xpub: ZPUB });

		const psbt = await psbtFromWalletRow(user.id, w.id);
		expect(psbtHasKeyOrigin(psbt)).toBe(false);
		expect(() => trezorSignRequestFromPsbt(psbt)).toThrow(/key-origin/i);
	});
});

// ---- QA R2 finding R7 / task #11: reject a derivation-purpose/prefix mismatch ----
//
// createWallet never used to cross-check a declared derivation path's BIP
// purpose (44'/49'/84'/86') against the script type its own SLIP-132 prefix
// (xpub/ypub/zpub) implies. Worst case: a BIP-86 (Taproot) xpub has no SLIP-132
// prefix of its own (wallets export it as a plain xpub, same as BIP-44), so it
// silently became a legacy p2pkh wallet — generating addresses that never
// match what the same key produces anywhere Taproot-aware. Design decision:
// REJECT (not warn-and-allow) on any purpose/prefix mismatch, and only when a
// derivation path is actually declared (an absent/unknown path stays accepted,
// same as before this fix).

describe('createWallet rejects derivation-purpose/prefix mismatches (task #11)', () => {
	// BIP49 test vector account ypub (same "abandon…about" mnemonic as ZPUB).
	const YPUB =
		'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP';
	// BIP44 test vector account xpub (same mnemonic) — also the prefix real
	// wallets use to export a BIP-86 Taproot account, since SLIP-132 has no
	// distinct Taproot version bytes.
	const XPUB =
		'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';

	function walletCount(userId: number): number {
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?')
			.get(userId) as { n: number };
		return n;
	}

	it('accepts each of the four standard purposes when they match their key prefix', async () => {
		const u44 = await makeUser('match44@example.com');
		const w44 = createWallet(u44.id, { xpub: XPUB, derivationPath: "m/44'/0'/0'" });
		expect(getWallet(u44.id, w44.id)?.script_type).toBe('p2pkh');

		const u49 = await makeUser('match49@example.com');
		const w49 = createWallet(u49.id, { xpub: YPUB, derivationPath: "m/49'/0'/0'" });
		expect(getWallet(u49.id, w49.id)?.script_type).toBe('p2sh-p2wpkh');

		const u84 = await makeUser('match84@example.com');
		const w84 = createWallet(u84.id, { xpub: ZPUB, derivationPath: "m/84'/0'/0'" });
		expect(getWallet(u84.id, w84.id)?.script_type).toBe('p2wpkh');
	});

	it('rejects a 49-purpose path on a zpub (native SegWit) key with the exact mismatch copy', async () => {
		const user = await makeUser('mismatch49z@example.com');
		expect(() => createWallet(user.id, { xpub: ZPUB, derivationPath: "m/49'/0'/0'" })).toThrow(
			"This key's derivation path (m/49'/0'/0') doesn't match its prefix type (zpub → native SegWit). Double-check you exported the right key."
		);
		expect(walletCount(user.id)).toBe(0);
	});

	it('rejects a 44-purpose path on a zpub key', async () => {
		const user = await makeUser('mismatch44z@example.com');
		expect(() => createWallet(user.id, { xpub: ZPUB, derivationPath: "m/44'/0'/0'" })).toThrow(
			/doesn't match its prefix type \(zpub → native SegWit\)/
		);
		expect(walletCount(user.id)).toBe(0);
	});

	it('rejects an 84-purpose path on a plain xpub (legacy) key', async () => {
		const user = await makeUser('mismatch84x@example.com');
		expect(() => createWallet(user.id, { xpub: XPUB, derivationPath: "m/84'/0'/0'" })).toThrow(
			/doesn't match its prefix type \(xpub → legacy\)/
		);
		expect(walletCount(user.id)).toBe(0);
	});

	it('rejects an 84-purpose path on a ypub (nested SegWit) key', async () => {
		const user = await makeUser('mismatch84y@example.com');
		expect(() => createWallet(user.id, { xpub: YPUB, derivationPath: "m/84'/0'/0'" })).toThrow(
			/doesn't match its prefix type \(ypub → nested SegWit\)/
		);
		expect(walletCount(user.id)).toBe(0);
	});

	it('rejects a Taproot (86-purpose) path with the Taproot-specific copy, regardless of the key prefix', async () => {
		// The realistic QA case: a BIP-86 key exported under the plain xpub prefix.
		const userXpub = await makeUser('taproot-xpub@example.com');
		expect(() => createWallet(userXpub.id, { xpub: XPUB, derivationPath: "m/86'/0'/0'" })).toThrow(
			"Taproot wallets aren't supported yet. This key would generate legacy addresses that won't match your other wallet's."
		);
		expect(walletCount(userXpub.id)).toBe(0);

		// Same rejection even when paired with a prefix that isn't legacy — 86'
		// never matches ANY prefix-inferred type (none of xpub/ypub/zpub imply
		// p2tr), so it always hits the Taproot branch, never the generic one.
		const userZpub = await makeUser('taproot-zpub@example.com');
		expect(() => createWallet(userZpub.id, { xpub: ZPUB, derivationPath: "m/86'/0'/0'" })).toThrow(
			/Taproot wallets aren't supported yet/
		);
		expect(walletCount(userZpub.id)).toBe(0);
	});

	it('accepts a key with no declared derivation path, regardless of prefix (nothing to contradict)', async () => {
		const user = await makeUser('nopath@example.com');
		const w = createWallet(user.id, { xpub: ZPUB });
		expect(getWallet(user.id, w.id)?.derivation_path).toBeNull();
		expect(walletCount(user.id)).toBe(1);
	});
});
