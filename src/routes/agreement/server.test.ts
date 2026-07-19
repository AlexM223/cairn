// cairn-cont — pins the fix for cairn-z6i1 (commit 46dd16f): the /agreement
// acceptance action must be a NAMED action ('accept', POSTed to ?/accept), not
// `default`. The original bare default action collided with SvelteKit's
// reserved `?/default` name and 500'd the mandatory onboarding gate right
// after signup — the action must run cleanly end to end.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { hasAcceptedCurrentAgreement } from '$lib/server/disclosures';
import { actions, load } from './+page.server';

function wipe(): void {
	db.exec(
		'DELETE FROM user_agreement_acceptances; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser() {
	return registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'User'
	});
}

/** Minimal RequestEvent for invoking the accept action. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function acceptEvent(
	user: Awaited<ReturnType<typeof registerUser>> | null,
	fields: Record<string, string> = { accept: 'on' }
): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	return {
		locals: { user },
		request: new Request('http://localhost/agreement?/accept', { method: 'POST', body }),
		getClientAddress: () => '203.0.113.7',
		params: {},
		url: new URL('http://localhost/agreement')
	};
}

describe('/agreement actions export', () => {
	it('uses the named accept action and NOT the reserved default shape that 500d onboarding', () => {
		expect(Object.keys(actions)).toContain('accept');
		expect(Object.keys(actions)).not.toContain('default');
	});
});

describe('/agreement ?/accept', () => {
	it('succeeds for a signed-in user: records acceptance (with IP) and redirects — no 500', async () => {
		const user = await makeUser();

		// The action redirects on success — SvelteKit signals that by THROWING a
		// redirect object (status + location), which is NOT an error/500.
		let thrown: unknown;
		try {
			await actions.accept(acceptEvent(user));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		expect(thrown).toMatchObject({ status: 303, location: '/' });
		// Sanity: this was a redirect, not an HttpError (which carries `body`).
		expect((thrown as { body?: unknown }).body).toBeUndefined();

		expect(hasAcceptedCurrentAgreement(user.id)).toBe(true);
		const row = db
			.prepare('SELECT ip FROM user_agreement_acceptances WHERE user_id = ?')
			.get(user.id) as { ip: string | null };
		expect(row.ip).toBe('203.0.113.7');
	});

	it('returns a 400 fail (not a throw) when the accept box is unchecked', async () => {
		const user = await makeUser();
		const res = await actions.accept(acceptEvent(user, {}));
		expect(res).toMatchObject({ status: 400 });
		expect(hasAcceptedCurrentAgreement(user.id)).toBe(false);
	});

	it('redirects a signed-out request to /login instead of recording anything', async () => {
		let thrown: unknown;
		try {
			await actions.accept(acceptEvent(null));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
		expect(
			(db.prepare('SELECT COUNT(*) AS n FROM user_agreement_acceptances').get() as { n: number }).n
		).toBe(0);
	});
});

describe('/agreement ?/accept next-threading (cairn-95yic)', () => {
	it('redirects to /welcome-aboard when the allowlisted next token rides the form', async () => {
		const user = await makeUser();
		let thrown: unknown;
		try {
			await actions.accept(acceptEvent(user, { accept: 'on', next: 'welcome-aboard' }));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toMatchObject({ status: 303, location: '/welcome-aboard' });
		expect(hasAcceptedCurrentAgreement(user.id)).toBe(true);
	});

	it('ignores any non-allowlisted next value — no open redirect, not even internal paths', async () => {
		for (const evil of ['/admin', '//evil.example', 'https://evil.example', '/welcome-aboard']) {
			wipe();
			setSetting('registration_mode', 'open');
			const user = await makeUser();
			let thrown: unknown;
			try {
				await actions.accept(acceptEvent(user, { accept: 'on', next: evil }));
			} catch (e) {
				thrown = e;
			}
			// Note '/welcome-aboard' (with the slash) is also rejected: the token
			// is the exact string 'welcome-aboard', never a pathname.
			expect(thrown).toMatchObject({ status: 303, location: '/' });
		}
	});

	it('load surfaces the token only for the exact allowlisted value', async () => {
		const user = await makeUser();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const at = (q: string) =>
			({ locals: { user }, url: new URL(`http://localhost/agreement${q}`) }) as any;
		expect(((await load(at('?next=welcome-aboard'))) as { next: string | null }).next).toBe(
			'welcome-aboard'
		);
		expect(((await load(at('?next=/welcome-aboard'))) as { next: string | null }).next).toBeNull();
		expect(((await load(at('?next=evil'))) as { next: string | null }).next).toBeNull();
		expect(((await load(at(''))) as { next: string | null }).next).toBeNull();
	});
});

describe('/agreement load', () => {
	it('reports alreadyAccepted correctly before and after acceptance', async () => {
		const user = await makeUser();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const loadEvent = { locals: { user }, url: new URL('http://localhost/agreement') } as any;

		type LoadData = { alreadyAccepted: boolean; agreement: { version: number } };
		const before = (await load(loadEvent)) as LoadData;
		expect(before.alreadyAccepted).toBe(false);
		expect(before.agreement.version).toBeGreaterThanOrEqual(1);

		try {
			await actions.accept(acceptEvent(user));
		} catch {
			// redirect — expected
		}

		const after = (await load(loadEvent)) as LoadData;
		expect(after.alreadyAccepted).toBe(true);
	});
});
