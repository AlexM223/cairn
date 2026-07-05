import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	compareVaultKey,
	createVault,
	getVault,
	markKeyVerified,
	type NewVaultKey,
	type VaultKeyRow,
	type VaultRow
} from './vaults';
import { vaultAddressAt, vaultAddressDetailAt } from './vaultScan';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path — same construction as vaultScan.test.ts / multisig.test.ts so all
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

function newKey(seedByte: number, name: string): NewVaultKey {
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
		'DELETE FROM vault_keys; DELETE FROM vaults; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
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

function makeVault(userId: number): VaultRow {
	return createVault(userId, {
		name: 'Family savings',
		threshold: 2,
		keys: [newKey(1, 'Trezor'), newKey(2, 'Ledger'), newKey(3, 'Steel backup')]
	});
}

describe('key health checks (markKeyVerified / lastVerifiedAt)', () => {
	it('new keys start never-verified and getVault surfaces the field', () => {
		const user = makeUser('owner@example.com');
		const vault = makeVault(user.id);
		expect(vault.keys).toHaveLength(3);
		for (const k of vault.keys) expect(k.lastVerifiedAt).toBeNull();
	});

	it('markKeyVerified stamps the key and the stamp reads back', () => {
		const user = makeUser('owner@example.com');
		const vault = makeVault(user.id);
		const key = vault.keys[1];

		const before = Date.now();
		const updated = markKeyVerified(user.id, vault.id, key.id);
		expect(updated).not.toBeNull();
		expect(updated!.id).toBe(key.id);
		expect(updated!.lastVerifiedAt).toBeTruthy();
		const stamped = Date.parse(updated!.lastVerifiedAt!);
		expect(stamped).toBeGreaterThanOrEqual(before - 2000);
		expect(stamped).toBeLessThanOrEqual(Date.now() + 2000);

		// Round-trips through getVault; the OTHER keys stay untouched.
		const reread = getVault(user.id, vault.id)!;
		expect(reread.keys.find((k) => k.id === key.id)!.lastVerifiedAt).toBe(
			updated!.lastVerifiedAt
		);
		for (const k of reread.keys.filter((k) => k.id !== key.id)) {
			expect(k.lastVerifiedAt).toBeNull();
		}
	});

	it('re-verifying refreshes the timestamp (never goes backwards)', async () => {
		const user = makeUser('owner@example.com');
		const vault = makeVault(user.id);
		const key = vault.keys[0];

		const first = markKeyVerified(user.id, vault.id, key.id)!;
		await new Promise((r) => setTimeout(r, 5));
		const second = markKeyVerified(user.id, vault.id, key.id)!;
		expect(Date.parse(second.lastVerifiedAt!)).toBeGreaterThanOrEqual(
			Date.parse(first.lastVerifiedAt!)
		);
	});

	it('enforces ownership end to end: wrong user, wrong vault, wrong key all fail', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const vault = makeVault(alice.id);
		const key = vault.keys[0];

		expect(markKeyVerified(bob.id, vault.id, key.id)).toBeNull();
		expect(markKeyVerified(alice.id, vault.id + 99, key.id)).toBeNull();
		expect(markKeyVerified(alice.id, vault.id, key.id + 99)).toBeNull();

		// A key id from a DIFFERENT vault of the same user is rejected too.
		const other = createVault(alice.id, {
			name: 'Other vault',
			threshold: 1,
			keys: [newKey(7, 'Solo key')]
		});
		expect(markKeyVerified(alice.id, vault.id, other.keys[0].id)).toBeNull();

		// Nothing got stamped anywhere.
		for (const k of getVault(alice.id, vault.id)!.keys) expect(k.lastVerifiedAt).toBeNull();
	});
});

describe('compareVaultKey (device re-read vs stored row)', () => {
	const stored = fixtureKey(1);

	it('matches when the device returns the stored key', () => {
		expect(compareVaultKey(stored, { xpub: stored.xpub, fingerprint: stored.fingerprint }))
			.toEqual({ fingerprintMatch: true, xpubMatch: true });
	});

	it('is case-insensitive on fingerprints and tolerant of whitespace', () => {
		expect(
			compareVaultKey(stored, {
				xpub: ` ${stored.xpub} `,
				fingerprint: ` ${stored.fingerprint.toUpperCase()} `
			})
		).toEqual({ fingerprintMatch: true, xpubMatch: true });
	});

	it('a SLIP-132 Zpub alias of the stored xpub still matches (either side)', () => {
		const zpub = asZpub(stored.xpub);
		expect(zpub.startsWith('Zpub')).toBe(true);
		expect(compareVaultKey(stored, { xpub: zpub, fingerprint: stored.fingerprint }).xpubMatch).toBe(
			true
		);
		expect(
			compareVaultKey(
				{ xpub: zpub, fingerprint: stored.fingerprint },
				{ xpub: stored.xpub, fingerprint: stored.fingerprint }
			).xpubMatch
		).toBe(true);
	});

	it('a different seed fails both checks; same-fingerprint-different-account fails only xpub', () => {
		const otherSeed = fixtureKey(2);
		expect(compareVaultKey(stored, { xpub: otherSeed.xpub, fingerprint: otherSeed.fingerprint }))
			.toEqual({ fingerprintMatch: false, xpubMatch: false });

		// Same master (fingerprint matches), different account xpub.
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
		const otherAccount = master.derive("m/48'/0'/1'/2'").publicExtendedKey;
		expect(compareVaultKey(stored, { xpub: otherAccount, fingerprint: stored.fingerprint }))
			.toEqual({ fingerprintMatch: true, xpubMatch: false });
	});

	it('garbage xpubs never match (and never throw)', () => {
		expect(
			compareVaultKey(stored, { xpub: 'not-a-key', fingerprint: stored.fingerprint }).xpubMatch
		).toBe(false);
		expect(
			compareVaultKey(
				{ xpub: 'not-a-key', fingerprint: stored.fingerprint },
				{ xpub: 'not-a-key', fingerprint: stored.fingerprint }
			).xpubMatch
		).toBe(false);
	});
});

describe('vaultAddressDetailAt (address transparency)', () => {
	function literalVault(scriptType: VaultRow['scriptType']): VaultRow {
		const keys: VaultKeyRow[] = [1, 2, 3].map((seed, i) => ({
			id: i + 1,
			vaultId: 1,
			position: i,
			name: `Key ${i + 1}`,
			category: 'hardware',
			deviceType: null,
			...fixtureKey(seed)
		}));
		return {
			id: 1,
			userId: 1,
			name: 'Test vault',
			threshold: 2,
			scriptType,
			receiveCursor: 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			keys
		};
	}

	it('p2wsh: witness script only, BIP-67 sorted pubkeys, full per-key paths', () => {
		const vault = literalVault('p2wsh');
		const detail = vaultAddressDetailAt(vault, 0, 12);

		expect(detail.address).toBe(vaultAddressAt(vault, 0, 12));
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
		const detail = vaultAddressDetailAt(literalVault('p2sh'), 1, 0);
		expect(detail.witnessScript).toBeNull();
		expect(detail.redeemScript).toMatch(/^52(21[0-9a-f]{66}){3}53ae$/);
		expect(detail.keys[0].fullPath).toBe(`${BIP48_PATH}/1/0`);
	});

	it('p2sh-p2wsh: both scripts present, redeem script wraps the witness program', () => {
		const detail = vaultAddressDetailAt(literalVault('p2sh-p2wsh'), 0, 0);
		expect(detail.witnessScript).toMatch(/^52(21[0-9a-f]{66}){3}53ae$/);
		expect(detail.redeemScript).toMatch(/^0020[0-9a-f]{64}$/); // OP_0 <sha256(witnessScript)>
	});

	it('an origin-less key ("m") gets a chain/index-only full path', () => {
		const vault = literalVault('p2wsh');
		vault.keys[2] = { ...vault.keys[2], path: 'm' };
		const detail = vaultAddressDetailAt(vault, 0, 3);
		expect(detail.keys[2].fullPath).toBe('m/0/3');
		expect(detail.keys[0].fullPath).toBe(`${BIP48_PATH}/0/3`);
	});
});
