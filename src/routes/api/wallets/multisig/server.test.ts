// cairn-50ng + cairn-mvtf regression coverage for POST /api/wallets/multisig.
//
// cairn-50ng: two back-to-back identical creates used to both succeed (201)
// and leave two rows behind — there was no (user, name) uniqueness guard at
// all, only an unguarded INSERT. createMultisig now does a synchronous
// check-then-insert (see src/lib/server/wallets/multisig.ts); this exercises
// that guard through the actual route so the 201→409 status mapping is
// covered too.
//
// cairn-mvtf: a `[fingerprint/path]xpub` key-origin expression submitted as
// the `xpub` field embeds its own fingerprint — that descriptor-derived value
// must win over a separately declared `fingerprint` field that contradicts
// it, mirroring the wizard's normalizeMultisigKeyInput (src/lib/server/wallets/keyInput.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { getMultisig, listMultisigs } from '$lib/server/wallets/multisig';
import { POST } from './+server';

const BIP48_PATH = "48'/0'/0'/2'";

function fixtureKey(seedByte: number): { xpub: string; fingerprint: string } {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(`m/${BIP48_PATH}`);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0')
	};
}

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let ownerId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	const owner = await registerUser({
		email: 'owner@example.com',
		password: 'correct horse battery',
		displayName: 'owner'
	});
	ownerId = owner.id;
});

function event(body: unknown): Parameters<typeof POST>[0] {
	return {
		locals: {
			user: { id: ownerId, email: 'owner@example.com', isAdmin: false },
			flags: { multisig_create: true }
		},
		request: new Request('http://localhost/api/wallets/multisig', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0];
}

function threeKeyBody(name: string) {
	const k1 = fixtureKey(1);
	const k2 = fixtureKey(2);
	const k3 = fixtureKey(3);
	return {
		name,
		threshold: 2,
		keys: [
			{ name: 'Trezor', category: 'hardware', xpub: k1.xpub, fingerprint: k1.fingerprint, path: `m/${BIP48_PATH}` },
			{ name: 'Ledger', category: 'hardware', xpub: k2.xpub, fingerprint: k2.fingerprint, path: `m/${BIP48_PATH}` },
			{ name: 'Steel backup', category: 'recovery', xpub: k3.xpub, fingerprint: k3.fingerprint, path: `m/${BIP48_PATH}` }
		]
	};
}

describe('POST /api/wallets/multisig — double-submit guard (cairn-50ng)', () => {
	it('a second identical create is rejected 409, not a second 201', async () => {
		const body = threeKeyBody('Family savings');

		const first = await POST(event(body));
		expect(first.status).toBe(201);

		// Sequential, not concurrent (the guard is a synchronous check-then-insert
		// inside createMultisig — see wallets/multisig.ts — so it's correct
		// regardless of request timing; no need to race real promises here).
		const second = await POST(event(body));
		expect(second.status).toBe(409);
		const secondBody = await second.json();
		expect(secondBody.error).toMatch(/already have a multisig named/i);

		expect(listMultisigs(ownerId)).toHaveLength(1);
	});

	it('a different name from the same user still succeeds', async () => {
		const first = await POST(event(threeKeyBody('Family savings')));
		expect(first.status).toBe(201);
		const second = await POST(event(threeKeyBody('Business reserve')));
		expect(second.status).toBe(201);
		expect(listMultisigs(ownerId)).toHaveLength(2);
	});
});

describe('POST /api/wallets/multisig — descriptor-derived fingerprint wins (cairn-mvtf)', () => {
	it('a [fingerprint/path]xpub key-origin expression overrides a contradicting declared fingerprint', async () => {
		const real = fixtureKey(1);
		const bracketed = `[${real.fingerprint}/${BIP48_PATH}]${real.xpub}`;
		const k2 = fixtureKey(2);
		const k3 = fixtureKey(3);

		const res = await POST(
			event({
				name: 'Origin vault',
				threshold: 2,
				keys: [
					{
						name: 'Trezor',
						category: 'hardware',
						xpub: bracketed,
						// Deliberately contradicts the embedded fingerprint above —
						// the repro for cairn-mvtf.
						fingerprint: 'deadbeef',
						path: 'm/1'
					},
					{ name: 'Ledger', category: 'hardware', xpub: k2.xpub, fingerprint: k2.fingerprint, path: `m/${BIP48_PATH}` },
					{ name: 'Steel backup', category: 'recovery', xpub: k3.xpub, fingerprint: k3.fingerprint, path: `m/${BIP48_PATH}` }
				]
			})
		);

		expect(res.status).toBe(201);
		const body = await res.json();
		const stored = getMultisig(ownerId, body.multisig.id)!;
		const trezorKey = stored.keys.find((k) => k.name === 'Trezor')!;
		expect(trezorKey.fingerprint).toBe(real.fingerprint.toLowerCase());
		expect(trezorKey.fingerprint).not.toBe('deadbeef');
		expect(trezorKey.path).toBe(`m/${BIP48_PATH}`);
	});

	it('a bare account-level xpub (the usual case) keeps trusting the declared fingerprint, unchanged', async () => {
		const res = await POST(event(threeKeyBody('Plain vault')));
		expect(res.status).toBe(201);
		const body = await res.json();
		const stored = getMultisig(ownerId, body.multisig.id)!;
		const k1 = fixtureKey(1);
		const trezorKey = stored.keys.find((k) => k.name === 'Trezor')!;
		expect(trezorKey.fingerprint).toBe(k1.fingerprint.toLowerCase());
	});
});
