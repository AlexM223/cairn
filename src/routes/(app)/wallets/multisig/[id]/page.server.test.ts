// Regression test for cairn-v27o (follow-up to cairn-wqkk): the `receive` and
// `delete` actions here used destructured params ({ params, locals, request })
// with no requireUser call — only the locals.user!.id non-null assertion (a
// masked 500 for an anonymous caller) stood between an action and an
// unauthenticated request. Both now call requireUser(event) first, converting
// that into a clean 401.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { actions, load } from './+page.server';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createMultisig } from '$lib/server/wallets/multisig';
import { getDefaultNetwork, setDefaultNetwork } from '$lib/server/bitcoin/xpub';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		params: { id: '1' },
		locals: { user },
		request: new Request('http://localhost/wallets/multisig/1', { method: 'POST', body: form })
	};
}

describe('wallets/multisig/[id] actions — anon is denied with a 401 throw', () => {
	it('receive throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		await expect(actions.receive(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});

	it('delete throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		await expect(actions.delete(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});
});

// Regression test for cairn-zltwz part (b): a multisig created while the
// instance's configured network matched its keys' encoding (mainnet, here)
// but later left stranded when the instance's Bitcoin connection is
// reconfigured to a different network (regtest) — multisigToDescriptor then
// throws MultisigError (mainnet key vs. regtest backend) instead of
// returning a string. Before this fix load() let that escape uncaught,
// which SvelteKit turns into a raw 500. It must instead surface a
// plain-language descriptorError and still return the rest of the page.
describe('wallets/multisig/[id] load() — stranded-network descriptor build fails gracefully (cairn-zltwz)', () => {
	const BIP48_PATH = "m/48'/0'/0'/2'";

	function fixtureKey(seedByte: number) {
		const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
		const account = master.derive(BIP48_PATH);
		return {
			xpub: account.publicExtendedKey,
			fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
			path: BIP48_PATH
		};
	}

	function newKey(seedByte: number, name: string) {
		return {
			name,
			category: 'hardware' as const,
			deviceType: 'trezor' as const,
			...fixtureKey(seedByte)
		};
	}

	function wipe(): void {
		db.exec(
			'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
		);
	}

	let ownerId: number;
	let multisigId: number;
	const originalNetwork = getDefaultNetwork();

	beforeEach(async () => {
		setDefaultNetwork('mainnet');
		wipe();
		setSetting('registration_mode', 'open');
		const owner = await registerUser({
			email: 'owner@example.com',
			password: 'correct horse battery',
			displayName: 'owner'
		});
		ownerId = owner.id;
		// Created while the instance's network is mainnet — matches these keys'
		// encoding, so creation validates cleanly.
		const multisig = createMultisig(ownerId, {
			name: 'Stranded vault',
			threshold: 2,
			keys: [newKey(1, 'Trezor'), newKey(2, 'Ledger'), newKey(3, 'Steel backup')]
		});
		multisigId = multisig.id;
	});

	afterEach(() => {
		setDefaultNetwork(originalNetwork);
	});

	function loadEvent(id: number) {
		return {
			params: { id: String(id) },
			locals: { user: { id: ownerId, email: 'owner@example.com', isAdmin: false } },
			url: new URL(`http://localhost/wallets/multisig/${id}`),
			depends: () => {}
		} as unknown as Parameters<typeof load>[0];
	}

	it('returns descriptor + no error while the network still matches', async () => {
		const data = (await load(loadEvent(multisigId))) as {
			descriptor: string | null;
			descriptorError: string | null;
		};
		expect(data.descriptor).toBeTruthy();
		expect(data.descriptorError).toBeNull();
	});

	it('returns descriptorError (not a throw) once the instance network no longer matches the keys', async () => {
		// Simulates reconfigureChain() re-syncing defaultNetwork after the
		// instance's Bitcoin connection is (re)configured for a different network.
		setDefaultNetwork('regtest');
		const data = (await load(loadEvent(multisigId))) as {
			descriptor: string | null;
			descriptorError: string | null;
		};
		expect(data.descriptor).toBeNull();
		expect(data.descriptorError).toMatch(/incomplete/i);
	});
});
