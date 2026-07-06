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
	getMultisig,
	markKeyVerified,
	type NewMultisigKey,
	type MultisigKeyRow,
	type MultisigRow
} from './wallets/multisig';
import { multisigAddressAt, multisigAddressDetailAt } from './multisigScan';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path — same construction as multisigScan.test.ts / multisig.test.ts so all
// suites pin one derivation universe. Test-only keys, never a real wallet.
const BIP48_PATH = "m/48'/0'/0'/2'";

function fixtureKey(seedByte: number): { xpub: string; fingerprint: string; path: string } {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH
	};
}

function newKey(seedByte: number, name: string): NewMultisigKey {
	return { name, category: 'hardware', deviceType: 'trezor', ...fixtureKey(seedByte) };
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
	it('new keys start never-verified and getMultisig surfaces the field', () => {
		const user = makeUser('owner@example.com');
		const multisig = makeMultisig(user.id);
		expect(multisig.keys).toHaveLength(3);
		for (const k of multisig.keys) expect(k.lastVerifiedAt).toBeNull();
	});

	it('markKeyVerified stamps the key and the stamp reads back', () => {
		const user = makeUser('owner@example.com');
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
		const user = makeUser('owner@example.com');
		const multisig = makeMultisig(user.id);
		const key = multisig.keys[0];

		const first = markKeyVerified(user.id, multisig.id, key.id)!;
		await new Promise((r) => setTimeout(r, 5));
		const second = markKeyVerified(user.id, multisig.id, key.id)!;
		expect(Date.parse(second.lastVerifiedAt!)).toBeGreaterThanOrEqual(
			Date.parse(first.lastVerifiedAt!)
		);
	});

	it('enforces ownership end to end: wrong user, wrong multisig, wrong key all fail', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
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
