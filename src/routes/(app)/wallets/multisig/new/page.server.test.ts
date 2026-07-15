// Regression test for cairn-wqkk: the `key` and `preview` actions here used
// destructured params ({ request }, { request, locals }) with no requireUser
// call — `preview` in particular never touched `locals` at all, so an
// anonymous POST ran it to completion (harmless today: pure computation, no
// mutation). Both now call requireUser(event) first, converting the
// previously-open path into a clean 401.

import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import {
	getWizardDraft,
	createWizardDraft,
	syncWizardDraft,
	type WizardDraftKeyInput
} from '$lib/server/multisigWizardDrafts';
import { load, actions } from './+page.server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		locals: { user },
		request: new Request('http://localhost/wallets/multisig/new', { method: 'POST', body: form })
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCreateEvent(user: { id: number }, form: FormData): any {
	return {
		locals: { user, flags: { multisig_create: true } },
		request: new Request('http://localhost/wallets/multisig/new', { method: 'POST', body: form })
	};
}

describe('wallets/multisig/new actions — anon is denied with a 401 throw', () => {
	it('key throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('name', 'Test key');
		form.set('category', 'primary');
		await expect(actions.key(makeEvent(undefined, form))).rejects.toMatchObject({ status: 401 });
	});

	it('preview throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('config', '{}');
		await expect(actions.preview(makeEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});
});

describe('wallets/multisig/new create action — bare legacy P2SH bypass is blocked server-side (cairn-etz9)', () => {
	it('rejects scriptType=p2sh with a 400 fail() when source is not "imported"', async () => {
		const form = new FormData();
		form.set('name', 'Legacy vault');
		form.set('scriptType', 'p2sh');
		form.set('threshold', '2');
		form.set('keys', '[]');
		// source omitted entirely, same as a from-scratch wizard build
		const result = await actions.create(makeCreateEvent({ id: 1 }, form));
		expect(result).toMatchObject({ status: 400, data: { error: expect.stringMatching(/p2sh/i) } });
	});

	it('does not block scriptType=p2sh when source=imported (restoring a legacy config)', async () => {
		const form = new FormData();
		form.set('name', 'Restored vault');
		form.set('scriptType', 'p2sh');
		form.set('source', 'imported');
		form.set('threshold', '2');
		form.set('keys', '[]'); // empty keys fails downstream validation, not this guard
		const result = await actions.create(makeCreateEvent({ id: 1 }, form));
		// Falls through to createMultisig, which now rejects for a DIFFERENT
		// reason (no keys) — proving the p2sh guard itself did not fire.
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data?: { error?: string } }).data?.error ?? '').not.toMatch(
			/can no longer be created new/i
		);
	});
});

// cairn-jy3g: server-side wizard draft persistence — resumable via ?draft=N
// (load), committed via the `draftSync` action, cleared via `draftAbandon`
// and (on success) by `create` itself.
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

function wipeWizardFixtures(): void {
	db.exec(
		'DELETE FROM multisig_wizard_draft_keys; DELETE FROM multisig_wizard_drafts; ' +
			'DELETE FROM multisig_keys; DELETE FROM multisigs; ' +
			'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeLoadEvent(user: { id: number } | undefined, url: string): any {
	return {
		locals: { user, flags: { multisig_create: true } },
		url: new URL(url)
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeUserEvent(user: { id: number } | undefined, form: FormData): any {
	return {
		locals: { user },
		request: new Request('http://localhost/wallets/multisig/new', { method: 'POST', body: form })
	};
}

// SvelteKit's generated PageServerLoad type is self-referential through
// App.PageData (it derives App.PageData FROM this very load()'s return type),
// so calling the exported `load` directly (rather than through a component's
// generated $types) resolves to an under-specified union. Cast the awaited
// result to the shape this test actually cares about — same pattern as the
// send flow's page.server.test.ts (`type LoadResult = { savedAddresses: ... }`).
type LoadResult = {
	resumeDraft: { id: number; name: string; keys: unknown[] } | null;
};

describe('wallets/multisig/new load — ?draft=N resume (cairn-jy3g)', () => {
	beforeEach(() => {
		wipeWizardFixtures();
		setSetting('registration_mode', 'open');
	});

	it('returns resumeDraft: null when no ?draft= param is present', async () => {
		const user = await makeUser('owner@example.com');
		const result = (await load(
			makeLoadEvent(user, 'http://localhost/wallets/multisig/new')
		)) as LoadResult;
		expect(result.resumeDraft).toBeNull();
	});

	it('resumes the caller’s own draft, keys included', async () => {
		const user = await makeUser('owner@example.com');
		const draft = createWizardDraft(user.id, {
			name: 'Family vault',
			threshold: 2,
			totalKeys: 2,
			scriptType: 'p2wsh',
			vaultMode: 'personal',
			step: 'keys',
			configImported: false,
			importedStartIndex: 0
		});
		syncWizardDraft(
			user.id,
			draft.id,
			{
				name: 'Family vault',
				threshold: 2,
				totalKeys: 2,
				scriptType: 'p2wsh',
				vaultMode: 'personal',
				step: 'keys',
				configImported: false,
				importedStartIndex: 0
			},
			[
				{
					name: 'Trezor',
					category: 'hardware',
					deviceType: 'trezor',
					...fixtureKey(1)
				}
			]
		);

		const result = (await load(
			makeLoadEvent(user, `http://localhost/wallets/multisig/new?draft=${draft.id}`)
		)) as LoadResult;
		expect(result.resumeDraft?.id).toBe(draft.id);
		expect(result.resumeDraft?.name).toBe('Family vault');
		expect(result.resumeDraft?.keys).toHaveLength(1);
	});

	it('404s when the draft belongs to a different user', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const draft = createWizardDraft(owner.id, {
			name: 'Private vault',
			threshold: 2,
			totalKeys: 3,
			scriptType: 'p2wsh',
			vaultMode: null,
			step: 'keys',
			configImported: false,
			importedStartIndex: 0
		});

		await expect(
			load(makeLoadEvent(other, `http://localhost/wallets/multisig/new?draft=${draft.id}`))
		).rejects.toMatchObject({ status: 404 });
	});

	it('404s for a ?draft= id that does not exist at all', async () => {
		const user = await makeUser('owner@example.com');
		await expect(
			load(makeLoadEvent(user, 'http://localhost/wallets/multisig/new?draft=999999'))
		).rejects.toMatchObject({ status: 404 });
	});

	it('404s for a non-numeric ?draft= value', async () => {
		const user = await makeUser('owner@example.com');
		await expect(
			load(makeLoadEvent(user, 'http://localhost/wallets/multisig/new?draft=not-a-number'))
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('wallets/multisig/new draftSync action — per-key commit (cairn-jy3g)', () => {
	beforeEach(() => {
		wipeWizardFixtures();
		setSetting('registration_mode', 'open');
	});

	function syncForm(over: Record<string, string> = {}): FormData {
		const form = new FormData();
		form.set('draftId', '');
		form.set('name', 'My vault');
		form.set('threshold', '2');
		form.set('totalKeys', '3');
		form.set('scriptType', 'p2wsh');
		form.set('vaultMode', 'personal');
		form.set('step', 'keys');
		form.set('configImported', 'false');
		form.set('importedStartIndex', '0');
		form.set('keys', '[]');
		for (const [k, v] of Object.entries(over)) form.set(k, v);
		return form;
	}

	it('throws 401 for an anonymous caller', async () => {
		await expect(actions.draftSync(makeUserEvent(undefined, syncForm()))).rejects.toMatchObject({
			status: 401
		});
	});

	it('creates a new draft on the first call (empty draftId) and persists the first key', async () => {
		const user = await makeUser('owner@example.com');
		const key = { name: 'Trezor', category: 'hardware', deviceType: 'trezor', ...fixtureKey(1) };
		const result = (await actions.draftSync(
			makeUserEvent(user, syncForm({ keys: JSON.stringify([key]) }))
		)) as { draftId: number };

		expect(result.draftId).toBeGreaterThan(0);
		const stored = getWizardDraft(user.id, result.draftId);
		expect(stored?.keys).toHaveLength(1);
		expect(stored?.keys[0].xpub).toBe(key.xpub);
	});

	it('a second call with the returned draftId commits the second key (per-key commit)', async () => {
		const user = await makeUser('owner@example.com');
		const key1 = { name: 'Trezor', category: 'hardware', deviceType: 'trezor', ...fixtureKey(1) };
		const key2 = { name: 'Ledger', category: 'hardware', deviceType: 'ledger', ...fixtureKey(2) };

		const first = (await actions.draftSync(
			makeUserEvent(user, syncForm({ keys: JSON.stringify([key1]) }))
		)) as { draftId: number };

		const second = (await actions.draftSync(
			makeUserEvent(
				user,
				syncForm({ draftId: String(first.draftId), keys: JSON.stringify([key1, key2]) })
			)
		)) as { draftId: number };

		expect(second.draftId).toBe(first.draftId);
		const stored = getWizardDraft(user.id, first.draftId);
		expect(stored?.keys.map((k) => k.xpub)).toEqual([key1.xpub, key2.xpub]);
	});

	it('fails with 404 (fail, not a thrown error) when draftId belongs to another user', async () => {
		const owner = await makeUser('owner@example.com');
		const attacker = await makeUser('attacker@example.com');
		const draft = createWizardDraft(owner.id, {
			name: 'Owner vault',
			threshold: 2,
			totalKeys: 3,
			scriptType: 'p2wsh',
			vaultMode: 'personal',
			step: 'keys',
			configImported: false,
			importedStartIndex: 0
		});

		const result = await actions.draftSync(
			makeUserEvent(attacker, syncForm({ draftId: String(draft.id), name: 'Hijacked' }))
		);
		expect(result).toMatchObject({ status: 404 });

		// No partial write landed — the owner's draft keeps its original name.
		expect(getWizardDraft(owner.id, draft.id)?.name).toBe('Owner vault');
	});

	it('fails with 400 on a malformed key list', async () => {
		const user = await makeUser('owner@example.com');
		const result = await actions.draftSync(
			makeUserEvent(user, syncForm({ keys: 'not json' }))
		);
		expect(result).toMatchObject({ status: 400 });
	});
});

describe('wallets/multisig/new draftAbandon action (cairn-jy3g)', () => {
	beforeEach(() => {
		wipeWizardFixtures();
		setSetting('registration_mode', 'open');
	});

	it('throws 401 for an anonymous caller', async () => {
		const form = new FormData();
		form.set('draftId', '1');
		await expect(actions.draftAbandon(makeUserEvent(undefined, form))).rejects.toMatchObject({
			status: 401
		});
	});

	it('deletes the caller’s own draft', async () => {
		const user = await makeUser('owner@example.com');
		const draft = createWizardDraft(user.id, {
			name: 'Scratch vault',
			threshold: 2,
			totalKeys: 3,
			scriptType: 'p2wsh',
			vaultMode: null,
			step: 'keys',
			configImported: false,
			importedStartIndex: 0
		});

		const form = new FormData();
		form.set('draftId', String(draft.id));
		await actions.draftAbandon(makeUserEvent(user, form));

		expect(getWizardDraft(user.id, draft.id)).toBeNull();
	});

	it('is a no-op against another user’s draft — it survives', async () => {
		const owner = await makeUser('owner@example.com');
		const attacker = await makeUser('attacker@example.com');
		const draft = createWizardDraft(owner.id, {
			name: 'Owner vault',
			threshold: 2,
			totalKeys: 3,
			scriptType: 'p2wsh',
			vaultMode: null,
			step: 'keys',
			configImported: false,
			importedStartIndex: 0
		});

		const form = new FormData();
		form.set('draftId', String(draft.id));
		await actions.draftAbandon(makeUserEvent(attacker, form));

		expect(getWizardDraft(owner.id, draft.id)).not.toBeNull();
	});
});

describe('wallets/multisig/new create action — deletes its wizard draft on success (cairn-jy3g)', () => {
	beforeEach(() => {
		wipeWizardFixtures();
		setSetting('registration_mode', 'open');
	});

	it('cleans up the draft row once the multisig is actually created', async () => {
		const user = await makeUser('owner@example.com');
		const draft = createWizardDraft(user.id, {
			name: 'Two of two',
			threshold: 2,
			totalKeys: 2,
			scriptType: 'p2wsh',
			vaultMode: 'personal',
			step: 'review',
			configImported: false,
			importedStartIndex: 0
		});
		const keys: WizardDraftKeyInput[] = [
			{ name: 'Trezor', category: 'hardware', deviceType: 'trezor', ...fixtureKey(1) },
			{ name: 'Ledger', category: 'hardware', deviceType: 'ledger', ...fixtureKey(2) }
		];
		syncWizardDraft(
			user.id,
			draft.id,
			{
				name: 'Two of two',
				threshold: 2,
				totalKeys: 2,
				scriptType: 'p2wsh',
				vaultMode: 'personal',
				step: 'review',
				configImported: false,
				importedStartIndex: 0
			},
			keys
		);

		const form = new FormData();
		form.set('name', 'Two of two');
		form.set('threshold', '2');
		form.set('scriptType', 'p2wsh');
		form.set('keys', JSON.stringify(keys));
		form.set('collaborative', 'false');
		form.set('draftId', String(draft.id));

		const result = (await actions.create(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{
				locals: { user, flags: { multisig_create: true } },
				request: new Request('http://localhost/wallets/multisig/new', {
					method: 'POST',
					body: form
				})
			} as any
		)) as { multisigId: number };

		expect(result.multisigId).toBeGreaterThan(0);
		expect(getWizardDraft(user.id, draft.id)).toBeNull();
	});
});
