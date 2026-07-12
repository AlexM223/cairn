// Wave 1 of the multisig key-check redesign (MULTISIG-KEY-AUDIT-DESIGN): this
// endpoint gained a "paste" method alongside the existing "device" re-read —
// same compare (compareMultisigKey), same response shape, the endpoint never
// looks at the source of a reading, only the values. These tests cover the
// compare paths (match / fingerprint-mismatch / xpub-mismatch) for both
// "device" (regression — no prior coverage existed) and the new "paste"
// method, plus "manual" and malformed-method rejection.

import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createMultisig, type NewMultisigKey } from '$lib/server/wallets/multisig';
import { POST } from './+server';

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

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let ownerId: number;
let multisigId: number;
let keyId: number;
let stored: { xpub: string; fingerprint: string; path: string };

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	const owner = await registerUser({
		email: 'owner@example.com',
		password: 'correct horse battery',
		displayName: 'owner'
	});
	ownerId = owner.id;
	stored = fixtureKey(1);
	const multisig = createMultisig(ownerId, {
		name: 'Family savings',
		threshold: 2,
		keys: [newKey(1, 'Trezor'), newKey(2, 'Ledger'), newKey(3, 'Steel backup')]
	});
	multisigId = multisig.id;
	keyId = multisig.keys[0].id;
});

function event(body: unknown): Parameters<typeof POST>[0] {
	return {
		locals: { user: { id: ownerId, email: 'owner@example.com', isAdmin: false } },
		params: { id: String(multisigId), keyId: String(keyId) },
		request: new Request(
			`http://localhost/api/wallets/multisig/${multisigId}/keys/${keyId}/verified`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}
		)
	} as unknown as Parameters<typeof POST>[0];
}

describe('POST .../keys/:keyId/verified — method: device (regression)', () => {
	it('a matching re-read records the check', async () => {
		const res = await POST(event({ method: 'device', xpub: stored.xpub, fingerprint: stored.fingerprint }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.verified).toBe(true);
		expect(typeof body.lastVerifiedAt).toBe('string');
	});

	it('a different seed fails both fingerprint and xpub', async () => {
		const other = fixtureKey(99);
		const res = await POST(event({ method: 'device', xpub: other.xpub, fingerprint: other.fingerprint }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			verified: false,
			fingerprintMatch: false,
			xpubMatch: false,
			expectedFingerprint: stored.fingerprint.toLowerCase(),
			deviceFingerprint: other.fingerprint.toLowerCase()
		});
	});

	it('same master, different account: fingerprint matches but xpub does not', async () => {
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
		const otherAccount = master.derive("m/48'/0'/1'/2'").publicExtendedKey;
		const res = await POST(
			event({ method: 'device', xpub: otherAccount, fingerprint: stored.fingerprint })
		);
		const body = await res.json();
		expect(body).toMatchObject({ verified: false, fingerprintMatch: true, xpubMatch: false });
	});

	it('rejects a device body missing xpub/fingerprint', async () => {
		const res = await POST(event({ method: 'device', xpub: stored.xpub }));
		expect(res.status).toBe(400);
	});
});

describe('POST .../keys/:keyId/verified — method: paste (Wave 1 addition)', () => {
	it('a matching pasted xpub+fingerprint records the check — same as device', async () => {
		const res = await POST(event({ method: 'paste', xpub: stored.xpub, fingerprint: stored.fingerprint }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.verified).toBe(true);
		expect(typeof body.lastVerifiedAt).toBe('string');
	});

	it('fingerprint mismatch (wrong seed / passphrase) reports both flags false', async () => {
		const other = fixtureKey(42);
		const res = await POST(event({ method: 'paste', xpub: other.xpub, fingerprint: other.fingerprint }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			verified: false,
			fingerprintMatch: false,
			xpubMatch: false,
			expectedFingerprint: stored.fingerprint.toLowerCase(),
			deviceFingerprint: other.fingerprint.toLowerCase()
		});
	});

	it('xpub-only mismatch (right master, different account) reports fingerprintMatch true, xpubMatch false', async () => {
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(1));
		const otherAccount = master.derive("m/48'/0'/1'/2'").publicExtendedKey;
		const res = await POST(
			event({ method: 'paste', xpub: otherAccount, fingerprint: stored.fingerprint })
		);
		const body = await res.json();
		expect(body).toMatchObject({ verified: false, fingerprintMatch: true, xpubMatch: false });
	});

	it('is case-insensitive on fingerprint and tolerant of whitespace (matches compareMultisigKey)', async () => {
		const res = await POST(
			event({
				method: 'paste',
				xpub: ` ${stored.xpub} `,
				fingerprint: ` ${stored.fingerprint.toUpperCase()} `
			})
		);
		const body = await res.json();
		expect(body.verified).toBe(true);
	});

	it('rejects a paste body missing xpub/fingerprint, same as device', async () => {
		const res = await POST(event({ method: 'paste', fingerprint: stored.fingerprint }));
		expect(res.status).toBe(400);
	});
});

describe('POST .../keys/:keyId/verified — method: manual and validation', () => {
	it('manual always records the check with no comparison', async () => {
		const res = await POST(event({ method: 'manual' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.verified).toBe(true);
	});

	it('rejects an unrecognized method', async () => {
		const res = await POST(event({ method: 'guess' }));
		expect(res.status).toBe(400);
	});

	it('404s for a key that does not belong to this multisig', async () => {
		const res = await POST({
			locals: { user: { id: ownerId, email: 'owner@example.com', isAdmin: false } },
			params: { id: String(multisigId), keyId: '999999' },
			request: new Request('http://localhost/x', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: 'manual' })
			})
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(404);
	});
});
