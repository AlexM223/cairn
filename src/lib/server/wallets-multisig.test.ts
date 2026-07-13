import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	compareMultisigKey,
	createMultisig,
	deleteMultisig,
	getMultisig,
	markKeyVerified,
	toMultisigConfig,
	type NewMultisigKey,
	type MultisigKeyRow,
	type MultisigRow
} from './wallets/multisig';
import {
	multisigAddressAt,
	multisigAddressDetailAt,
	primeMultisigScanCache,
	scanMultisig,
	type MultisigScanResult
} from './multisigScan';
import { multisigToDescriptor } from './bitcoin/multisig';
import { persistScanResult } from './scanCachePersist';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path — same construction as multisigScan.test.ts / multisig.test.ts so all
// suites pin one derivation universe. Test-only keys, never a real wallet.
const BIP48_PATH = "m/48'/0'/0'/2'";

function fixtureKeyAt(
	seedByte: number,
	path: string
): { xpub: string; fingerprint: string; path: string } {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = path === 'm' ? master : master.derive(path);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path
	};
}

function fixtureKey(seedByte: number): { xpub: string; fingerprint: string; path: string } {
	return fixtureKeyAt(seedByte, BIP48_PATH);
}

function newKey(seedByte: number, name: string): NewMultisigKey {
	return { name, category: 'hardware', deviceType: 'trezor', ...fixtureKey(seedByte) };
}

function newKeyAt(seedByte: number, name: string, path: string): NewMultisigKey {
	return { name, category: 'hardware', deviceType: 'trezor', ...fixtureKeyAt(seedByte, path) };
}

/** Re-encode an xpub with the SLIP-132 Zpub (p2wsh multisig) version bytes. */
function asZpub(xpub: string): string {
	const b58check = createBase58check(sha256);
	const raw = b58check.decode(xpub);
	const out = new Uint8Array(raw);
	out[0] = 0x02;
	out[1] = 0xaa;
	out[2] = 0x7e;
	out[3] = 0xd3;
	return b58check.encode(out);
}

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	});
}

function makeMultisig(userId: number): MultisigRow {
	return createMultisig(userId, {
		name: 'Family savings',
		threshold: 2,
		keys: [newKey(1, 'Trezor'), newKey(2, 'Ledger'), newKey(3, 'Steel backup')]
	});
}

describe('key health checks (markKeyVerified / lastVerifiedAt)', () => {
	it('new keys start never-verified and getMultisig surfaces the field', async () => {
		const user = await makeUser('owner@example.com');
		const multisig = makeMultisig(user.id);
		expect(multisig.keys).toHaveLength(3);
		for (const k of multisig.keys) expect(k.lastVerifiedAt).toBeNull();
	});

	it('markKeyVerified stamps the key and the stamp reads back', async () => {
		const user = await makeUser('owner@example.com');
		const multisig = makeMultisig(user.id);
		const key = multisig.keys[1];

		const before = Date.now();
		const updated = markKeyVerified(user.id, multisig.id, key.id);
		expect(updated).not.toBeNull();
		expect(updated!.id).toBe(key.id);
		expect(updated!.lastVerifiedAt).toBeTruthy();
		const stamped = Date.parse(updated!.lastVerifiedAt!);
		expect(stamped).toBeGreaterThanOrEqual(before - 2000);
		expect(stamped).toBeLessThanOrEqual(Date.now() + 2000);

		// Round-trips through getMultisig; the OTHER keys stay untouched.
		const reread = getMultisig(user.id, multisig.id)!;
		expect(reread.keys.find((k) => k.id === key.id)!.lastVerifiedAt).toBe(
			updated!.lastVerifiedAt
		);
		for (const k of reread.keys.filter((k) => k.id !== key.id)) {
			expect(k.lastVerifiedAt).toBeNull();
		}
	});

	it('re-verifying refreshes the timestamp (never goes backwards)', async () => {
		const user = await makeUser('owner@example.com');
		const multisig = makeMultisig(user.id);
		const key = multisig.keys[0];

		const first = markKeyVerified(user.id, multisig.id, key.id)!;
		await new Promise((r) => setTimeout(r, 5));
		const second = markKeyVerified(user.id, multisig.id, key.id)!;
		expect(Date.parse(second.lastVerifiedAt!)).toBeGreaterThanOrEqual(
			Date.parse(first.lastVerifiedAt!)
		);
	});

	it('enforces ownership end to end: wrong user, wrong multisig, wrong key all fail', async () => {
		const alice = await makeUser('alice@example.com');
		const bob = await makeUser('bob@example.com');
		const multisig = makeMultisig(alice.id);
		const key = multisig.keys[0];

		expect(markKeyVerified(bob.id, multisig.id, key.id)).toBeNull();
		expect(markKeyVerified(alice.id, multisig.id + 99, key.id)).toBeNull();
		expect(markKeyVerified(alice.id, multisig.id, key.id + 99)).toBeNull();

		// A key id from a DIFFERENT multisig of the same user is rejected too.
		const other = createMultisig(alice.id, {
			name: 'Other multisig',
			threshold: 1,
			keys: [newKey(7, 'Solo key')]
		});
		expect(markKeyVerified(alice.id, multisig.id, other.keys[0].id)).toBeNull();

		// Nothing got stamped anywhere.
		for (const k of getMultisig(alice.id, multisig.id)!.keys) expect(k.lastVerifiedAt).toBeNull();
	});
});

describe('compareMultisigKey (device re-read vs stored row)', () => {
	const stored = fixtureKey(1);

	it('matches when the device returns the stored key', () => {
		expect(compareMultisigKey(stored, { xpub: stored.xpub, fingerprint: stored.fingerprint }))
			.toEqual({ fingerprintMatch: true, xpubMatch: true });
	});

	it('is case-insensitive on fingerprints and tolerant of whitespace', () => {
		expect(
			compareMultisigKey(stored, {
				xpub: ` ${stored.xpub} `,
				fingerprint: ` ${stored.fingerprint.toUpperCase()} `
			})
		).toEqual({ fingerprintMatch: true, xpubMatch: true });
	});

	it('a SLIP-132 Zpub alias of the stored xpub still matches (either side)', () => {
		const zpub = asZpub(stored.xpub);
		expect(zpub.startsWith('Zpub')).toBe(true);
		expect(compareMultisigKey(stored, { xpub: zpub, fingerprint: stored.fingerprint }).xpubMatch).toBe(
			true
		);
		expect(
			compareMultisigKey(
				{ xpub: zpub, fingerprint: stored.fingerprint },
				{ xpub: stored.xpub, fingerprint: stored.fingerprint }
			).xpubMatch
		).toBe(true);
	});

	it('a different seed fails both checks; same-fingerprint-different-account fails only xpub', () => {
		const otherSeed = fixtureKey(2);
		expect(compareMultisigKey(stored, { xpub: otherSeed.xpub, fingerprint: otherSeed.fingerprint }))
			.toEqual({ fingerprintMatch: false, xpubMatch: false });

		// Same master (fingerprint matches), different account xpub.
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
		const otherAccount = master.derive("m/48'/0'/1'/2'").publicExtendedKey;
		expect(compareMultisigKey(stored, { xpub: otherAccount, fingerprint: stored.fingerprint }))
			.toEqual({ fingerprintMatch: true, xpubMatch: false });
	});

	it('garbage xpubs never match (and never throw)', () => {
		expect(
			compareMultisigKey(stored, { xpub: 'not-a-key', fingerprint: stored.fingerprint }).xpubMatch
		).toBe(false);
		expect(
			compareMultisigKey(
				{ xpub: 'not-a-key', fingerprint: stored.fingerprint },
				{ xpub: 'not-a-key', fingerprint: stored.fingerprint }
			).xpubMatch
		).toBe(false);
	});
});

describe('multisigAddressDetailAt (address transparency)', () => {
	function literalMultisig(scriptType: MultisigRow['scriptType']): MultisigRow {
		const keys: MultisigKeyRow[] = [1, 2, 3].map((seed, i) => ({
			id: i + 1,
			multisigId: 1,
			position: i,
			name: `Key ${i + 1}`,
			category: 'hardware',
			deviceType: null,
			...fixtureKey(seed)
		}));
		return {
			id: 1,
			userId: 1,
			name: 'Test multisig',
			threshold: 2,
			scriptType,
			receiveCursor: 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			keys
		};
	}

	it('p2wsh: witness script only, BIP-67 sorted pubkeys, full per-key paths', () => {
		const multisig = literalMultisig('p2wsh');
		const detail = multisigAddressDetailAt(multisig, 0, 12);

		expect(detail.address).toBe(multisigAddressAt(multisig, 0, 12));
		expect(detail.scriptType).toBe('p2wsh');
		expect(detail.witnessScript).toMatch(/^52(21[0-9a-f]{66}){3}53ae$/); // OP_2 <3 keys> OP_3 CHECKMULTISIG
		expect(detail.redeemScript).toBeNull();

		expect(detail.sortedPubkeys).toHaveLength(3);
		const sorted = [...detail.sortedPubkeys].sort();
		expect(detail.sortedPubkeys).toEqual(sorted); // hex sort == byte sort here
		// The witness script embeds the pubkeys in exactly that order.
		expect(detail.witnessScript).toBe(
			`5221${detail.sortedPubkeys[0]}21${detail.sortedPubkeys[1]}21${detail.sortedPubkeys[2]}53ae`
		);

		expect(detail.keys.map((k) => k.fullPath)).toEqual([
			`${BIP48_PATH}/0/12`,
			`${BIP48_PATH}/0/12`,
			`${BIP48_PATH}/0/12`
		]);
		expect(detail.keys[0].basePath).toBe(BIP48_PATH);
	});

	it('p2sh: the multisig script is the redeem script; no witness script', () => {
		const detail = multisigAddressDetailAt(literalMultisig('p2sh'), 1, 0);
		expect(detail.witnessScript).toBeNull();
		expect(detail.redeemScript).toMatch(/^52(21[0-9a-f]{66}){3}53ae$/);
		expect(detail.keys[0].fullPath).toBe(`${BIP48_PATH}/1/0`);
	});

	it('p2sh-p2wsh: both scripts present, redeem script wraps the witness program', () => {
		const detail = multisigAddressDetailAt(literalMultisig('p2sh-p2wsh'), 0, 0);
		expect(detail.witnessScript).toMatch(/^52(21[0-9a-f]{66}){3}53ae$/);
		expect(detail.redeemScript).toMatch(/^0020[0-9a-f]{64}$/); // OP_0 <sha256(witnessScript)>
	});

	it('an origin-less key ("m") gets a chain/index-only full path', () => {
		const multisig = literalMultisig('p2wsh');
		multisig.keys[2] = { ...multisig.keys[2], path: 'm' };
		const detail = multisigAddressDetailAt(multisig, 0, 3);
		expect(detail.keys[2].fullPath).toBe('m/0/3');
		expect(detail.keys[0].fullPath).toBe(`${BIP48_PATH}/0/3`);
	});
});

// ---- cairn-cvcu: multisig creation shows up in the activity feed ----------------

import { listUserFeed, listAllActivity } from './activity';

describe('createMultisig activity event (cairn-cvcu)', () => {
	it('emits wallet_created with the quorum in the message', async () => {
		const user = await makeUser('msfeed@example.com');
		db.exec('DELETE FROM events;');
		const ms = makeMultisig(user.id);

		const feed = listUserFeed(user.id);
		expect(feed).toHaveLength(1);
		expect(feed[0].type).toBe('wallet_created');
		expect(feed[0].message).toContain('Family savings');
		expect(feed[0].message).toContain('2-of-3');
		expect(feed[0].message).toContain('created');

		const admin = listAllActivity({ type: 'wallet_created', includeDetail: true });
		expect(admin.total).toBe(1);
		expect(admin.events[0].detail).toMatchObject({
			walletKind: 'multisig',
			walletId: ms.id,
			threshold: 2,
			totalKeys: 3,
			source: 'created'
		});
	});

	it('says "imported" for a config import', async () => {
		const user = await makeUser('msimport@example.com');
		db.exec('DELETE FROM events;');
		createMultisig(user.id, {
			name: 'Restored vault',
			threshold: 2,
			source: 'imported',
			keys: [newKey(4, 'K1'), newKey(5, 'K2'), newKey(6, 'K3')]
		});
		const feed = listUserFeed(user.id);
		expect(feed[0].message).toContain('imported');
	});
});

// ---- cairn-1kc3.1/.2/.3: cosigner path acceptance at creation ------------------

import { MultisigError } from './bitcoin/multisig';

describe('createMultisig double-submit guard (cairn-50ng)', () => {
	it('a second create with the same (user, name) throws duplicate_name and stores nothing new', async () => {
		const user = await makeUser('dupname@example.com');
		makeMultisig(user.id);
		expect(db.prepare('SELECT COUNT(*) AS n FROM multisigs').get()).toEqual({ n: 1 });

		// Two sequential calls, not raced promises: createMultisig's check and its
		// INSERT are separated by zero `await`s, so a synchronous SQLite backend
		// makes the two atomic regardless of request timing — this pins the
		// guard's logic directly rather than depending on scheduler luck.
		expect(() => makeMultisig(user.id)).toThrow(/already have a multisig named/i);
		try {
			makeMultisig(user.id);
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigError);
			expect((e as MultisigError).code).toBe('duplicate_name');
		}
		expect(db.prepare('SELECT COUNT(*) AS n FROM multisigs').get()).toEqual({ n: 1 });
	});

	it('the same name is free again for a different user', async () => {
		const alice = await makeUser('alice-dup@example.com');
		const bob = await makeUser('bob-dup@example.com');
		makeMultisig(alice.id);
		expect(() => makeMultisig(bob.id)).not.toThrow();
		expect(db.prepare('SELECT COUNT(*) AS n FROM multisigs').get()).toEqual({ n: 2 });
	});
});

describe('createMultisig cosigner path validation (cairn-1kc3.1/.3)', () => {
	it('rejects a key declaring a single-sig path — the audit case (cairn-1kc3.3)', async () => {
		const user = await makeUser('paths@example.com');
		expect(() =>
			createMultisig(user.id, {
				name: 'Bad vault',
				threshold: 2,
				keys: [newKey(1, 'Trezor'), newKey(2, 'Ledger'), newKeyAt(3, 'Pasted', "m/84'/0'/0'")]
			})
		).toThrow(/Pasted.*single-sig/);
		// Nothing was stored.
		expect(db.prepare('SELECT COUNT(*) AS n FROM multisigs').get()).toEqual({ n: 0 });
	});

	it("rejects a BIP-48 suffix contradicting the wallet's script type (cairn-1kc3.1)", async () => {
		const user = await makeUser('suffix@example.com');
		expect(() =>
			createMultisig(user.id, {
				name: 'Mismatch',
				threshold: 2,
				scriptType: 'p2wsh',
				keys: [newKey(1, 'A'), newKey(2, 'B'), newKeyAt(3, 'C', "m/48'/0'/0'/1'")]
			})
		).toThrow(/C: .*1'.*p2wsh/);
	});

	it('accepts BIP-45 keys and unknown-origin keys', async () => {
		const user = await makeUser('bip45@example.com');
		const ms = createMultisig(user.id, {
			name: 'Shared vault',
			threshold: 2,
			keys: [
				newKeyAt(1, 'Mine', "m/45'"),
				newKeyAt(2, 'Theirs', "m/45'"),
				{ ...newKeyAt(3, 'Watch-only', 'm'), fingerprint: '00000000' }
			]
		});
		expect(ms.keys.map((k) => k.path)).toEqual(["m/45'", "m/45'", 'm']);
	});

	it("accepts a p2sh wallet whose keys carry Trezor's 0' suffix — proving the real scriptType flows into validation and the sanity derivation (cairn-1kc3.2)", async () => {
		const user = await makeUser('p2sh@example.com');
		// Before cairn-1kc3.2 the acceptance config dropped scriptType, so
		// everything validated as if p2wsh — under which these 0'-suffix keys
		// would be wrongly rejected (and 2'-suffix keys wrongly accepted below).
		// BIP-48 defines no suffix for bare p2sh at all; 0' is Trezor firmware's
		// own extension for it (m/45' is the other accepted convention) — 1' is
		// deliberately NOT valid here, since that's p2sh-p2wsh's slot and
		// accepting it on a p2sh wallet would mask a wrong-key paste (cairn-acft).
		const ms = createMultisig(user.id, {
			name: 'Legacy vault',
			threshold: 2,
			scriptType: 'p2sh',
			keys: [
				newKeyAt(1, 'A', "m/48'/0'/0'/0'"),
				newKeyAt(2, 'B', "m/48'/0'/0'/0'"),
				newKeyAt(3, 'C', "m/48'/0'/0'/0'")
			]
		});
		expect(ms.scriptType).toBe('p2sh');
		expect(() =>
			createMultisig(user.id, {
				name: 'Legacy vault 2',
				threshold: 2,
				scriptType: 'p2sh',
				keys: [newKey(4, 'A'), newKey(5, 'B'), newKey(6, 'C')] // 2' suffix
			})
		).toThrow(/2'.*P2SH/);
	});

	it('applies the universal checks to imports too — a single-sig path never enters (cairn-1kc3.3 rule 3)', async () => {
		const user = await makeUser('importpaths@example.com');
		expect(() =>
			createMultisig(user.id, {
				name: 'Imported bad',
				threshold: 1,
				source: 'imported',
				keys: [newKeyAt(1, 'K', "m/44'/0'/0'")]
			})
		).toThrow(/single-sig/);
	});

	it("tolerates a legacy-P2SH key's historical 1' suffix on import, but still rejects it on fresh creation (cairn-acft)", async () => {
		const user = await makeUser('legacyimport@example.com');
		const legacyKeys = [
			newKeyAt(1, 'A', "m/48'/0'/0'/1'"),
			newKeyAt(2, 'B', "m/48'/0'/0'/1'"),
			newKeyAt(3, 'C', "m/48'/0'/0'/1'")
		];
		// A from-scratch build (the default source) still hard-rejects the
		// nested-SegWit-slot label on a p2sh wallet.
		expect(() =>
			createMultisig(user.id, { name: 'Fresh', threshold: 2, scriptType: 'p2sh', keys: legacyKeys })
		).toThrow(MultisigError);
		// The SAME keys succeed when saved as an import — Cairn's own "Download
		// backup" export of an old wallet round-trips instead of being refused.
		const ms = createMultisig(user.id, {
			name: 'Restored',
			threshold: 2,
			scriptType: 'p2sh',
			source: 'imported',
			keys: legacyKeys
		});
		expect(ms.keys.map((k) => k.path)).toEqual(["m/48'/0'/0'/1'", "m/48'/0'/0'/1'", "m/48'/0'/0'/1'"]);
	});
});

// ---- cairn-acft: a STORED legacy-P2SH wallet keeps working ---------------------
//
// validateCosignerKeyPath (tightened just above) runs ONLY at ACCEPTANCE time —
// createMultisig and the Caravan import parser (multisigExport.ts). It is never
// consulted when a wallet is loaded, has its addresses derived, or is spent from:
// the origin path is metadata for display/hardware-wallet matching, and the
// address math is a pure function of the xpub. A wallet whose keys carry the
// now-rejected m/48'/…/1' label on a bare-p2sh wallet (exactly what the HW
// drivers used to derive before cairn-acft's fix) must keep deriving, showing
// balance, and spending — blocking those operations would strand real funds
// over a label. This test inserts such a row directly (createMultisig itself now
// refuses it, proven first) to lock in that the load/spend path stays silent.
import { deriveMultisigAddress, validateCosignerKeyPath } from './bitcoin/multisig';
import { constructMultisigPsbt } from './bitcoin/multisigPsbt';
import { Transaction, NETWORK } from '@scure/btc-signer';

describe('a stored legacy-P2SH wallet keeps loading and spending (cairn-acft)', () => {
	it("loads, derives its address, and builds a spend PSBT for keys carrying the now-rejected 1' suffix", async () => {
		const user = await makeUser('legacy-p2sh-survivor@example.com');
		const legacyPath = "m/48'/0'/0'/1'"; // nested-SegWit's BIP-48 slot — invalid on a p2sh wallet
		const keys = [newKeyAt(1, 'A', legacyPath), newKeyAt(2, 'B', legacyPath), newKeyAt(3, 'C', legacyPath)];

		// Prove this exact wallet could NOT be created fresh today — the tightened
		// rule really does apply here, both directly and via createMultisig.
		expect(() => validateCosignerKeyPath(legacyPath, 'p2sh', 'A')).toThrow(MultisigError);
		expect(() =>
			createMultisig(user.id, { name: 'Would be rejected', threshold: 2, scriptType: 'p2sh', keys })
		).toThrow(MultisigError);

		// Insert the same keys directly — bypassing createMultisig's validation —
		// simulating a wallet that already existed before the tightening shipped.
		const multisigId = Number(
			db
				.prepare('INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, ?, ?)')
				.run(user.id, 'Legacy survivor', 2, 'p2sh').lastInsertRowid
		);
		keys.forEach((k, i) => {
			db.prepare(
				'INSERT INTO multisig_keys (multisig_id, position, name, category, device_type, xpub, fingerprint, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			).run(multisigId, i, k.name, k.category, k.deviceType ?? null, k.xpub, k.fingerprint, k.path);
		});

		// Load exactly the way the app does — no re-validation anywhere on this path.
		const row = getMultisig(user.id, multisigId);
		expect(row).not.toBeNull();
		expect(row!.keys.map((k) => k.path)).toEqual([legacyPath, legacyPath, legacyPath]);
		const cfg = toMultisigConfig(row!);

		// Address derivation works — the xpub drives the math, not the path.
		const address = deriveMultisigAddress(cfg, 0, 0).address;
		expect(address).toMatch(/^3/); // bare p2sh mainnet address

		// A spend PSBT builds too (legacy p2sh needs the raw previous tx for nonWitnessUtxo).
		const fund = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fund.addInput({ txid: '00'.repeat(32), index: 0 });
		fund.addOutputAddress(address, 200_000n, NETWORK);
		const draft = await constructMultisigPsbt({
			config: cfg,
			utxos: [{ txid: fund.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }],
			recipients: [{ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0,
			fetchRawTx: async () => fund.hex
		});
		expect(draft.psbtBase64).toBeTruthy();
	});
});

// ---- cairn-1kc3.6: declared vault mode (collaborative vs personal) -------------

describe('createMultisig vault mode (cairn-1kc3.6)', () => {
	const bip45Keys = () => [newKeyAt(1, 'Mine', "m/45'"), newKeyAt(2, 'Theirs', "m/45'")];
	const bip48Keys = () => [newKey(1, 'A'), newKey(2, 'B')];

	it('collaborative vaults require BIP-45 on every key', async () => {
		const user = await makeUser('collab@example.com');
		expect(() =>
			createMultisig(user.id, {
				name: 'Family vault',
				threshold: 2,
				collaborative: true,
				keys: bip48Keys()
			})
		).toThrow(MultisigError);
		expect(() =>
			createMultisig(user.id, {
				name: 'Family vault',
				threshold: 2,
				collaborative: true,
				keys: bip48Keys()
			})
		).toThrow(/m\/45'/);
		// An unknown-origin key can't prove it is BIP-45 — rejected too.
		expect(() =>
			createMultisig(user.id, {
				name: 'Family vault',
				threshold: 2,
				collaborative: true,
				keys: [newKeyAt(1, 'Mine', "m/45'"), { ...newKeyAt(2, 'Mystery', 'm'), fingerprint: '00000000' }]
			})
		).toThrow(/Mystery/);

		const ms = createMultisig(user.id, {
			name: 'Family vault',
			threshold: 2,
			collaborative: true,
			keys: bip45Keys()
		});
		expect(ms.collaborative).toBe(true);
		expect(getMultisig(user.id, ms.id)!.collaborative).toBe(true);
	});

	it('personal vaults reject BIP-45 keys (they mark a key as shared)', async () => {
		const user = await makeUser('personal@example.com');
		expect(() =>
			createMultisig(user.id, {
				name: 'My vault',
				threshold: 2,
				collaborative: false,
				keys: [newKey(1, 'A'), newKeyAt(2, 'Shared key', "m/45'")]
			})
		).toThrow(/Shared key.*collaborative/);

		const ms = createMultisig(user.id, {
			name: 'My vault',
			threshold: 2,
			collaborative: false,
			keys: bip48Keys()
		});
		expect(ms.collaborative).toBe(false);
	});

	it('undeclared mode (the default) keeps today\'s behavior: both purposes accepted, stored as null', async () => {
		const user = await makeUser('unset@example.com');
		const ms = createMultisig(user.id, {
			name: 'Legacy-flow vault',
			threshold: 2,
			keys: [newKeyAt(1, 'A', "m/45'"), newKey(2, 'B')]
		});
		expect(ms.collaborative).toBeNull();
		expect(getMultisig(user.id, ms.id)!.collaborative).toBeNull();
	});

	it('imports are exempt from the BIP-45 rule but still persist the declared mode', async () => {
		const user = await makeUser('importmode@example.com');
		const ms = createMultisig(user.id, {
			name: 'Imported collab vault',
			threshold: 2,
			source: 'imported',
			collaborative: true,
			keys: bip48Keys() // 48' paths — fine for an import
		});
		expect(ms.collaborative).toBe(true);
		expect(ms.source).toBe('imported');
	});
});

// ---- cairn-1kc3.4: cross-wallet xpub reuse warning ------------------------------

describe('createMultisig xpub reuse warning (cairn-1kc3.4)', () => {
	it('creating a multisig with a key already stored as a single-sig wallet warns in the activity feed', async () => {
		const user = await makeUser('reuse@example.com');
		db.exec('DELETE FROM events; DELETE FROM wallets;');
		const shared = fixtureKey(1);
		db.prepare(
			"INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, 'Daily wallet', 'xpub', ?, 'p2wpkh')"
		).run(user.id, shared.xpub);

		createMultisig(user.id, {
			name: 'Overlapping vault',
			threshold: 2,
			keys: [newKey(1, 'Reused'), newKey(2, 'Fresh'), newKey(3, 'Fresh 2')]
		});

		const warns = listUserFeed(user.id).filter((e) => e.type === 'key_reuse');
		expect(warns).toHaveLength(1);
		expect(warns[0].level).toBe('warn');
		expect(warns[0].message).toContain('Daily wallet');
		expect(warns[0].message).toContain('Overlapping vault');
		// No xpubs leak into the feed.
		expect(warns[0].message).not.toContain(shared.xpub);
	});

	it('a key shared across two multisigs warns; disjoint keys stay silent; the new vault never matches itself', async () => {
		const user = await makeUser('reuse2@example.com');
		db.exec('DELETE FROM events; DELETE FROM wallets;');
		createMultisig(user.id, {
			name: 'First vault',
			threshold: 2,
			keys: [newKey(1, 'A'), newKey(2, 'B')]
		});
		// Creating a vault does NOT warn about its own keys.
		expect(listUserFeed(user.id).filter((e) => e.type === 'key_reuse')).toHaveLength(0);

		createMultisig(user.id, {
			name: 'Second vault',
			threshold: 2,
			keys: [newKey(2, 'B again'), newKey(3, 'C')]
		});
		const warns = listUserFeed(user.id).filter((e) => e.type === 'key_reuse');
		expect(warns).toHaveLength(1);
		expect(warns[0].message).toContain('First vault');

		db.exec('DELETE FROM events;');
		createMultisig(user.id, {
			name: 'Disjoint vault',
			threshold: 2,
			keys: [newKey(8, 'X'), newKey(9, 'Y')]
		});
		expect(listUserFeed(user.id).filter((e) => e.type === 'key_reuse')).toHaveLength(0);
	});
});

// ---- cairn-ez9y: deleteMultisig must invalidate the scan cache ------------------

describe('deleteMultisig cache invalidation (cairn-ez9y)', () => {
	const emptyScan: MultisigScanResult = { addresses: [], txs: [], confirmed: 0, unconfirmed: 0 };

	function cacheKeyFor(multisig: MultisigRow): string {
		return multisigToDescriptor(toMultisigConfig(multisig));
	}

	function persistedRowExists(key: string): boolean {
		return (
			(
				db.prepare('SELECT COUNT(*) AS n FROM wallet_scan_cache WHERE cache_key = ?').get(key) as {
					n: number;
				}
			).n > 0
		);
	}

	it('deleting a multisig drops its in-memory scan cache entry', async () => {
		const user = await makeUser('cache-owner@example.com');
		const ms = makeMultisig(user.id);
		const key = cacheKeyFor(ms);

		// Seed the in-memory cache with a sentinel result.
		const sentinelA: MultisigScanResult = { ...emptyScan, confirmed: 111 };
		primeMultisigScanCache(key, sentinelA);
		expect((await scanMultisig(ms)).confirmed).toBe(111);

		expect(deleteMultisig(user.id, ms.id)).toBe(true);

		// If the delete had left the in-memory slot in place, priming a second
		// sentinel would be a no-op (prime() only fills an empty/expired slot)
		// and the stale 111 would still be served.
		const sentinelB: MultisigScanResult = { ...emptyScan, confirmed: 222 };
		primeMultisigScanCache(key, sentinelB);
		expect((await scanMultisig(ms)).confirmed).toBe(222);
	});

	it('deleting a multisig removes the persisted wallet_scan_cache row', async () => {
		const user = await makeUser('cache-owner2@example.com');
		const ms = makeMultisig(user.id);
		const key = cacheKeyFor(ms);

		persistScanResult('multisig', key, { ...emptyScan, confirmed: 333 });
		expect(persistedRowExists(key)).toBe(true);

		expect(deleteMultisig(user.id, ms.id)).toBe(true);

		// Not just absent from the live cache — gone from the DB row that
		// seedScanCachesFromDb (portfolioWarm.ts) reads back on every restart.
		expect(persistedRowExists(key)).toBe(false);
	});

	it('a failed (non-owned) delete leaves both caches alone', async () => {
		const owner = await makeUser('cache-real-owner@example.com');
		const other = await makeUser('cache-attacker@example.com');
		const ms = makeMultisig(owner.id);
		const key = cacheKeyFor(ms);

		persistScanResult('multisig', key, { ...emptyScan, confirmed: 444 });
		primeMultisigScanCache(key, { ...emptyScan, confirmed: 444 });

		expect(deleteMultisig(other.id, ms.id)).toBe(false);

		expect(persistedRowExists(key)).toBe(true);
		expect((await scanMultisig(ms)).confirmed).toBe(444);
	});
});
