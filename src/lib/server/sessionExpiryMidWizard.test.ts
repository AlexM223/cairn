// cairn-a857 — mid-operation disruption: a session that expires BETWEEN two
// POSTs of a multi-step wizard.
//
// Cairn's wallet-creation wizard keeps its step state entirely client-side
// (sessionStorage — see wallets/new/_components/wizardProgress.ts); there is
// no server-side "wizard session" row to corrupt. So the real server-side
// contract this bead cares about lives one layer down, in hooks.server.ts's
// handle(): every (app)-group form action re-checks the session on EVERY
// POST (SvelteKit doesn't run a parent layout's load() for actions, so this
// hook is the only per-request auth check an action gets — see hooks.server.ts's
// own comment on cairn-fame/cairn-jnlx/cairn-bgv1). This file drives that
// real hook against a real DB session through an actual two-POST sequence —
// step 1 succeeds, the session then expires exactly the way it would in
// production (TTL, not logout), and step 2 must:
//   - 401 cleanly (never run the action body — no double-write, no 500)
//   - leave nothing server-side that would need cleanup or block a retry
//   - let a fresh login immediately retry the same step successfully
//
// Harness mirrors hooks.server.test.ts's makeEvent/callHandle exactly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { registerUser, createSession, SESSION_COOKIE, getSessionUser } from './auth';
import { setSetting } from './settings';
import { recordUserAgreement } from './disclosures';
import { createWallet, listWalletRows } from './wallets';
import { handle } from '../../hooks.server';

function wipe(): void {
	db.exec(
		`DELETE FROM sessions; DELETE FROM wallets; DELETE FROM user_agreement_acceptances;
		 DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

/**
 * A plain, fully-onboarded MEMBER — every (app) gate clear except the one
 * this file exercises. auth.ts promotes the FIRST user ever registered in a
 * fresh DB to admin (isFirstUser = userCount() === 0), which would otherwise
 * drag in the disclosure/recovery gates too; a throwaway admin (registered
 * first, every call — wipe() truncates `users` before each test) absorbs
 * that slot so every test subject here is an ordinary member gated only by
 * hasAcceptedCurrentAgreement.
 */
async function makeMember(email: string): Promise<{ id: number }> {
	await registerUser({
		email: 'throwaway-admin@example.com',
		password: 'correct horse battery',
		displayName: 'seed-admin'
	});
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	// Clears the agreement gate so appGateRedirect returns null for this
	// member — an ordinary, fully-onboarded user mid-wizard.
	recordUserAgreement(user.id, '127.0.0.1');
	return user;
}

function makeEvent(
	pathname: string,
	opts: { method?: string; routeId?: string | null; cookie?: string } = {}
): RequestEvent {
	const url = new URL(`http://localhost${pathname}`);
	return {
		url,
		route: { id: opts.routeId ?? null },
		request: new Request(url, { method: opts.method ?? 'GET' }),
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? opts.cookie : undefined) },
		locals: {}
	} as unknown as RequestEvent;
}

async function expectThrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

const XPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('a session that expires between wizard-step POSTs', () => {
	it('step 1 (valid session) runs the action; step 2 (expired session) 401s WITHOUT running it', async () => {
		const user = await makeMember('mid-wizard@example.com');
		const { token } = createSession(user.id);

		// Step 1 — key/preview step, valid session: the wizard "actions" run
		// exactly like a real POST /wallets/new action would.
		let step1Ran = false;
		const res1 = await handle({
			event: makeEvent('/wallets/new', { method: 'POST', routeId: '/(app)/wallets/new', cookie: token }),
			resolve: async () => {
				step1Ran = true;
				return new Response('ok', { status: 200 });
			}
		});
		expect(res1.status).toBe(200);
		expect(step1Ran).toBe(true);

		// The session expires naturally (TTL elapses) between step 1 and step 2 —
		// NOT a logout, exactly the bead's scenario. Simulated the same way
		// sessionEdges.test.ts does: back-date expires_at directly.
		db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			user.id
		);

		// Step 2 — the create action, same cookie the browser would still be
		// carrying. The action body must NEVER run.
		let step2Ran = false;
		const thrown = await expectThrown(() =>
			handle({
				event: makeEvent('/wallets/new', {
					method: 'POST',
					routeId: '/(app)/wallets/new',
					cookie: token
				}),
				resolve: async () => {
					step2Ran = true;
					// If this ran, it would be the real createWallet side effect —
					// asserted below to prove it never happened.
					createWallet(user.id, { name: 'Should not exist', xpub: XPUB });
					return new Response('ok', { status: 200 });
				}
			})
		);

		expect(thrown).toMatchObject({ status: 401 });
		expect(step2Ran).toBe(false);
		// No partial/duplicate write: the wallet from the never-run action body
		// does not exist.
		expect(listWalletRows(user.id)).toEqual([]);
		// The expired row was swept by the read that discovered it (same
		// contract getSessionUser already guarantees elsewhere) — nothing left
		// to clean up server-side.
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('a re-login after the mid-wizard 401 can immediately retry the SAME step — no residual block', async () => {
		const user = await makeMember('retry-after-expiry@example.com');
		const { token: staleToken } = createSession(user.id);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			user.id
		);

		const blocked = await expectThrown(() =>
			handle({
				event: makeEvent('/wallets/new', {
					method: 'POST',
					routeId: '/(app)/wallets/new',
					cookie: staleToken
				}),
				resolve: async () => new Response('ok', { status: 200 })
			})
		);
		expect(blocked).toMatchObject({ status: 401 });

		// User re-authenticates (fresh session, same account) and retries the
		// identical step. Nothing about the earlier blocked attempt lingers.
		const { token: freshToken } = createSession(user.id);
		let actionRan = false;
		const res = await handle({
			event: makeEvent('/wallets/new', {
				method: 'POST',
				routeId: '/(app)/wallets/new',
				cookie: freshToken
			}),
			resolve: async () => {
				actionRan = true;
				createWallet(user.id, { name: 'Retry Wallet', xpub: XPUB });
				return new Response('ok', { status: 200 });
			}
		});
		expect(res.status).toBe(200);
		expect(actionRan).toBe(true);
		expect(listWalletRows(user.id)).toHaveLength(1);
	});

	it('a GET (loading the next wizard step\'s page) with an expired session gets a clean 302 to /login, not a 401/500', async () => {
		const user = await makeMember('get-mid-wizard@example.com');
		const { token } = createSession(user.id);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			user.id
		);

		const thrown = await expectThrown(() =>
			handle({
				event: makeEvent('/wallets/new', { method: 'GET', routeId: '/(app)/wallets/new', cookie: token }),
				resolve: async () => new Response('ok', { status: 200 })
			})
		);
		expect(thrown).toMatchObject({ status: 302, location: '/login?next=%2Fwallets%2Fnew' });
	});

	it('the exact expiry instant is still a valid step-2 POST; one tick later is a clean 401 (boundary)', async () => {
		vi.useFakeTimers();
		try {
			const base = 1_700_000_000_000;
			vi.setSystemTime(base);
			const user = await makeMember('boundary-mid-wizard@example.com');
			const { token } = createSession(user.id);
			const expiresAtMs = base + 50_000;
			db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
				new Date(expiresAtMs).toISOString(),
				user.id
			);

			vi.setSystemTime(expiresAtMs);
			expect(getSessionUser(token)).not.toBeNull();
			let ranAtBoundary = false;
			const okRes = await handle({
				event: makeEvent('/wallets/new', {
					method: 'POST',
					routeId: '/(app)/wallets/new',
					cookie: token
				}),
				resolve: async () => {
					ranAtBoundary = true;
					return new Response('ok', { status: 200 });
				}
			});
			expect(okRes.status).toBe(200);
			expect(ranAtBoundary).toBe(true);

			// Re-issue a session at the SAME instant (the previous one wasn't
			// consumed/rotated by the request above) and step past expiry by 1ms.
			db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(
				new Date(expiresAtMs).toISOString(),
				user.id
			);
			vi.setSystemTime(expiresAtMs + 1);
			let ranAfterExpiry = false;
			const thrown = await expectThrown(() =>
				handle({
					event: makeEvent('/wallets/new', {
						method: 'POST',
						routeId: '/(app)/wallets/new',
						cookie: token
					}),
					resolve: async () => {
						ranAfterExpiry = true;
						return new Response('ok', { status: 200 });
					}
				})
			);
			expect(thrown).toMatchObject({ status: 401 });
			expect(ranAfterExpiry).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
