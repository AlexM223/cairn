// cairn-8nk5: assertTeamMode/requireTeamMode (api.ts:128-137) — the
// solo-vs-team instanceMode boundary gating the multi-user MANAGEMENT
// surfaces (admin invites/contacts, multisig-share create/edit) — had zero
// coverage. This file pins:
//   1. assertTeamMode()/requireTeamMode() in isolation, including the guard
//      ORDER (sign-in is checked before instanceMode, so an unauthenticated
//      caller always gets 401, never a mode-dependent 404).
//   2. An actual route built on requireTeamMode end-to-end — GET/POST
//      /api/wallets/multisig/[id]/shares — including the "never leak wallet
//      existence" 404-for-everything shape (solo mode, non-owner, and a
//      non-owner-in-team-mode are all indistinguishable 404s).
//   3. Role-change MID-SESSION (the exact scenario cairn-7t0z.5's code
//      comment promises but nothing previously exercised): toggling
//      instanceMode team->solo->team does NOT revoke a cosigner/viewer's
//      already-granted read/sign access, but DOES immediately hide/restore
//      the owner's share-management surface.

import { describe, it, expect, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { assertTeamMode, requireTeamMode } from './api';
import { getViewableMultisig, getSignableMultisig } from './wallets/multisig';
import { GET as sharesGET, POST as sharesPOST } from '../../routes/api/wallets/multisig/[id]/shares/+server';
import type { RequestEvent as SharesRequestEvent } from '../../routes/api/wallets/multisig/[id]/shares/$types';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transactions; DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM contacts; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeUser(email: string): Promise<{ id: number; email: string; displayName: string; isAdmin: boolean }> {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

function befriend(a: number, b: number): void {
	db.prepare("INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')").run(a, b);
	db.prepare("INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')").run(b, a);
}

function makeMultisig(ownerId: number): { msId: number } {
	const msId = Number(
		db
			.prepare('INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, ?)')
			.run(ownerId, 'Family vault', 'p2wsh').lastInsertRowid
	);
	return { msId };
}

/** Minimal RequestEvent stand-in — mirrors api.test.ts's makeEvent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(overrides: Record<string, unknown> = {}): any {
	return {
		request: new Request('http://localhost/api/x'),
		url: new URL('http://localhost/api/x'),
		locals: { user: null, flags: {} },
		getClientAddress: () => '127.0.0.1',
		...overrides
	};
}

function asUser(user: { id: number; email: string; displayName: string; isAdmin: boolean }) {
	return {
		id: user.id,
		email: user.email,
		displayName: user.displayName,
		isAdmin: user.isAdmin
	};
}

async function expectThrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

function sharesEvent(user: { id: number } | null, msId: number, body?: unknown): SharesRequestEvent {
	const init: RequestInit = body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) };
	return {
		request: new Request(`http://localhost/api/wallets/multisig/${msId}/shares`, init),
		url: new URL(`http://localhost/api/wallets/multisig/${msId}/shares`),
		params: { id: String(msId) },
		locals: { user, flags: {} },
		getClientAddress: () => '127.0.0.1'
	} as unknown as SharesRequestEvent;
}

describe('assertTeamMode / requireTeamMode — boundary in isolation (cairn-8nk5)', () => {
	it('assertTeamMode: 404 in solo mode (a fresh instance defaults to solo)', () => {
		const thrown = expectThrown(() => assertTeamMode());
		return thrown.then((e) => {
			expect(isHttpError(e)).toBe(true);
			expect((e as { status: number }).status).toBe(404);
		});
	});

	it('assertTeamMode: no throw once instanceMode is team', () => {
		setSetting('instance_mode', 'team');
		expect(() => assertTeamMode()).not.toThrow();
	});

	it('requireTeamMode: an unauthenticated caller gets 401, in EITHER mode — sign-in is checked first', async () => {
		// Solo mode (default):
		let thrown = await expectThrown(() => requireTeamMode(makeEvent()));
		expect((thrown as { status: number }).status).toBe(401);

		// Team mode: still 401, not 404 — proves requireUser runs before assertTeamMode.
		setSetting('instance_mode', 'team');
		thrown = await expectThrown(() => requireTeamMode(makeEvent()));
		expect((thrown as { status: number }).status).toBe(401);
	});

	it('requireTeamMode: an authenticated caller gets 404 in solo mode, regardless of who they are', async () => {
		const user = await makeUser('owner@example.com');
		const event = makeEvent({ locals: { user: asUser(user), flags: {} } });
		const thrown = await expectThrown(() => requireTeamMode(event));
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);
	});

	it('requireTeamMode: an authenticated caller passes straight through in team mode and gets the user back', async () => {
		setSetting('instance_mode', 'team');
		const user = await makeUser('owner@example.com');
		const event = makeEvent({ locals: { user: asUser(user), flags: {} } });
		const result = requireTeamMode(event);
		expect(result.id).toBe(user.id);
	});
});

describe('GET/POST /api/wallets/multisig/[id]/shares — team-mode gate end-to-end (cairn-8nk5)', () => {
	it('solo mode: even the OWNER is 404d — the management surface is fully hidden, not just narrowed', async () => {
		const owner = await makeUser('owner@example.com');
		const { msId } = makeMultisig(owner.id);
		// Explicitly solo (default, but be explicit — this is the behavior under test).
		setSetting('instance_mode', 'solo');

		// requireTeamMode's assertTeamMode() throws a SvelteKit HttpError straight
		// out of the route (it's not caught/converted to a Response by GET itself).
		const thrown = await expectThrown(() => sharesGET(sharesEvent(asUser(owner), msId)));
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);
	});

	it('team mode, non-owner (no share at all): 404 — indistinguishable from solo mode\'s 404 (no existence leak)', async () => {
		const owner = await makeUser('owner@example.com');
		const outsider = await makeUser('outsider@example.com');
		const { msId } = makeMultisig(owner.id);
		setSetting('instance_mode', 'team');

		const res = await sharesGET(sharesEvent(asUser(outsider), msId));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Wallet not found' });
	});

	it('team mode, owner: GET lists collaborators (empty), POST shares with an accepted contact and the list updates', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		befriend(owner.id, bob.id);
		const { msId } = makeMultisig(owner.id);
		setSetting('instance_mode', 'team');

		const getRes = await sharesGET(sharesEvent(asUser(owner), msId));
		expect(getRes.status).toBe(200);
		expect((await getRes.json()).collaborators).toEqual([]);

		const postRes = await sharesPOST(
			sharesEvent(asUser(owner), msId, { contactUserId: bob.id, role: 'viewer' })
		);
		expect(postRes.status).toBe(200);
		const postBody = await postRes.json();
		expect(postBody.collaborators).toHaveLength(1);
		expect(postBody.collaborators[0]).toMatchObject({ userId: bob.id, role: 'viewer' });
	});

	it('team mode, POST from a non-owner against someone else\'s wallet: 404 (ShareError not_owner), never a 403', async () => {
		const owner = await makeUser('owner@example.com');
		const outsider = await makeUser('outsider@example.com');
		const somebody = await makeUser('somebody@example.com');
		befriend(outsider.id, somebody.id);
		const { msId } = makeMultisig(owner.id);
		setSetting('instance_mode', 'team');

		const res = await sharesPOST(
			sharesEvent(asUser(outsider), msId, { contactUserId: somebody.id, role: 'viewer' })
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Wallet not found', code: 'not_owner' });
	});
});

describe('role-change MID-SESSION: toggling instanceMode never touches already-granted read/sign access (cairn-7t0z.5, cairn-8nk5)', () => {
	it('team -> solo: a cosigner keeps read+sign access; the owner\'s share-management route starts 404ing', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		befriend(owner.id, bob.id);
		const { msId } = makeMultisig(owner.id);

		setSetting('instance_mode', 'team');
		const postRes = await sharesPOST(
			sharesEvent(asUser(owner), msId, { contactUserId: bob.id, role: 'cosigner' })
		);
		expect(postRes.status).toBe(200);

		// Bob's access via the unconditional (non-team-mode-gated) functions:
		expect(getViewableMultisig(bob.id, msId)).not.toBeNull();
		expect(getSignableMultisig(bob.id, msId)).not.toBeNull();

		// Now the instance is switched BACK to solo mid-"session" (no new login —
		// this is a live toggle by the admin while Bob may already be signed in).
		setSetting('instance_mode', 'solo');

		// Bob's already-granted access is UNCHANGED — this is the promise
		// multisigShares.ts's cairn-7t0z.5 comment makes; it was never exercised.
		expect(getViewableMultisig(bob.id, msId)).not.toBeNull();
		expect(getSignableMultisig(bob.id, msId)).not.toBeNull();

		// But the owner's own management surface is now hidden, even though the
		// share still exists in the DB — this is the "narrower, not disabled" 404.
		const thrown = await expectThrown(() => sharesGET(sharesEvent(asUser(owner), msId)));
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);
	});

	it('solo -> team: flipping back on immediately restores the owner\'s management view of a share created earlier', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		befriend(owner.id, bob.id);
		const { msId } = makeMultisig(owner.id);

		// Share was created while team mode was on...
		setSetting('instance_mode', 'team');
		await sharesPOST(sharesEvent(asUser(owner), msId, { contactUserId: bob.id, role: 'viewer' }));

		// ...instance flips to solo (share row persists, just hidden)...
		setSetting('instance_mode', 'solo');
		const thrown = await expectThrown(() => sharesGET(sharesEvent(asUser(owner), msId)));
		expect(isHttpError(thrown)).toBe(true);
		expect((thrown as { status: number }).status).toBe(404);

		// ...and flips back to team: the SAME share reappears with no data loss.
		setSetting('instance_mode', 'team');
		const res = await sharesGET(sharesEvent(asUser(owner), msId));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.collaborators).toHaveLength(1);
		expect(body.collaborators[0]).toMatchObject({ userId: bob.id, role: 'viewer' });
	});
});
