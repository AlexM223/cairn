// cairn-jy3g: server-side per-key persistence for the create-multisig wizard.
// Covers the owner-scoped lookup (the seam ?draft=N resume and the
// `draftSync` action both rely on), the per-key-commit replace semantics of
// syncWizardDraft, and cascade delete of a draft's keys.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	createWizardDraft,
	getWizardDraft,
	syncWizardDraft,
	deleteWizardDraft,
	type WizardDraftFields,
	type WizardDraftKeyInput
} from './multisigWizardDrafts';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_wizard_draft_keys; DELETE FROM multisig_wizard_drafts; ' +
			'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

function baseFields(over: Partial<WizardDraftFields> = {}): WizardDraftFields {
	return {
		name: '',
		threshold: 2,
		totalKeys: 3,
		scriptType: 'p2wsh',
		vaultMode: 'personal',
		step: 'keys',
		configImported: false,
		importedStartIndex: 0,
		...over
	};
}

function keyInput(n: number): WizardDraftKeyInput {
	return {
		name: `Key ${n}`,
		category: 'hardware',
		deviceType: 'trezor',
		xpub: `xpub-fixture-${n}`,
		fingerprint: `0000000${n}`,
		path: "m/48'/0'/0'/2'"
	};
}

describe('createWizardDraft + getWizardDraft', () => {
	it('round-trips a freshly created draft with no keys', async () => {
		const user = await makeUser('a@example.com');
		const draft = createWizardDraft(user.id, baseFields({ name: 'Family vault' }));
		expect(draft.name).toBe('Family vault');
		expect(draft.threshold).toBe(2);
		expect(draft.totalKeys).toBe(3);
		expect(draft.vaultMode).toBe('personal');
		expect(draft.keys).toEqual([]);

		const reread = getWizardDraft(user.id, draft.id);
		expect(reread).toEqual(draft);
	});

	it('returns null for a draft id that does not exist', async () => {
		const user = await makeUser('a@example.com');
		expect(getWizardDraft(user.id, 999_999)).toBeNull();
	});

	// The core security property (cairn-jy3g SECURITY note): a draft belonging
	// to a different user must be completely invisible — not just "found but
	// forbidden", but indistinguishable from a nonexistent id. This is the
	// data-layer half of the ?draft=N resume's 404 (the load()/action layer
	// just forwards a null here into a 404 either way).
	it('returns null when the draft belongs to a different user (cross-user isolation)', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const draft = createWizardDraft(owner.id, baseFields({ name: "Owner's vault" }));

		expect(getWizardDraft(other.id, draft.id)).toBeNull();
		// The owner can still read it — proves the miss above is scoping, not corruption.
		expect(getWizardDraft(owner.id, draft.id)).not.toBeNull();
	});
});

describe('syncWizardDraft — per-key commit', () => {
	it('adds one key, then adds a second — each call is a durable full commit', async () => {
		const user = await makeUser('a@example.com');
		const draft = createWizardDraft(user.id, baseFields());

		const afterFirst = syncWizardDraft(user.id, draft.id, baseFields(), [keyInput(1)]);
		expect(afterFirst?.keys).toEqual([{ position: 0, ...keyInput(1) }]);

		// A fresh read (simulating a reload right after the first key's ceremony,
		// before the second key is ever touched) sees the SAME state syncWizardDraft
		// just returned — proving the commit is durable, not just an in-memory echo.
		expect(getWizardDraft(user.id, draft.id)?.keys).toEqual([{ position: 0, ...keyInput(1) }]);

		const afterSecond = syncWizardDraft(user.id, draft.id, baseFields(), [keyInput(1), keyInput(2)]);
		expect(afterSecond?.keys).toEqual([
			{ position: 0, ...keyInput(1) },
			{ position: 1, ...keyInput(2) }
		]);
	});

	it('a key removal (a shorter list synced) drops the removed key, not just appends', async () => {
		const user = await makeUser('a@example.com');
		const draft = createWizardDraft(user.id, baseFields());
		syncWizardDraft(user.id, draft.id, baseFields(), [keyInput(1), keyInput(2), keyInput(3)]);

		const afterRemove = syncWizardDraft(user.id, draft.id, baseFields(), [keyInput(1), keyInput(3)]);
		expect(afterRemove?.keys.map((k) => k.xpub)).toEqual([keyInput(1).xpub, keyInput(3).xpub]);
		// Positions are re-derived from array order, not the removed key's old slot.
		expect(afterRemove?.keys.map((k) => k.position)).toEqual([0, 1]);
	});

	it('also updates the draft-level fields (quorum, step, name, vaultMode) in the same commit', async () => {
		const user = await makeUser('a@example.com');
		const draft = createWizardDraft(user.id, baseFields());
		const updated = syncWizardDraft(
			user.id,
			draft.id,
			baseFields({ name: 'Renamed vault', threshold: 3, totalKeys: 5, step: 'review' }),
			[keyInput(1)]
		);
		expect(updated).toMatchObject({ name: 'Renamed vault', threshold: 3, totalKeys: 5, step: 'review' });
	});

	// Cross-user 404 equivalent at the data layer: syncWizardDraft must refuse
	// to write into (or even acknowledge the existence of) another user's draft.
	it('returns null and makes no change when called by a non-owner', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const draft = createWizardDraft(owner.id, baseFields());
		syncWizardDraft(owner.id, draft.id, baseFields(), [keyInput(1)]);

		const result = syncWizardDraft(other.id, draft.id, baseFields({ name: 'Hijacked' }), [keyInput(9)]);
		expect(result).toBeNull();

		// The owner's draft is untouched — no partial write leaked through.
		const stillOwners = getWizardDraft(owner.id, draft.id);
		expect(stillOwners?.name).not.toBe('Hijacked');
		expect(stillOwners?.keys.map((k) => k.xpub)).toEqual([keyInput(1).xpub]);
	});

	it('returns null for a draft id that does not exist at all', async () => {
		const user = await makeUser('a@example.com');
		expect(syncWizardDraft(user.id, 999_999, baseFields(), [])).toBeNull();
	});
});

describe('deleteWizardDraft', () => {
	it('deletes the draft and cascades to its keys', async () => {
		const user = await makeUser('a@example.com');
		const draft = createWizardDraft(user.id, baseFields());
		syncWizardDraft(user.id, draft.id, baseFields(), [keyInput(1), keyInput(2)]);

		deleteWizardDraft(user.id, draft.id);

		expect(getWizardDraft(user.id, draft.id)).toBeNull();
		const orphanKeys = db
			.prepare('SELECT count(*) AS c FROM multisig_wizard_draft_keys WHERE draft_id = ?')
			.get(draft.id) as { c: number };
		expect(orphanKeys.c).toBe(0);
	});

	it('is a no-op when called by a non-owner — the draft survives', async () => {
		const owner = await makeUser('owner@example.com');
		const other = await makeUser('other@example.com');
		const draft = createWizardDraft(owner.id, baseFields());

		deleteWizardDraft(other.id, draft.id);

		expect(getWizardDraft(owner.id, draft.id)).not.toBeNull();
	});

	it('is a no-op (not a throw) when the draft is already gone', async () => {
		const user = await makeUser('a@example.com');
		expect(() => deleteWizardDraft(user.id, 999_999)).not.toThrow();
	});
});
