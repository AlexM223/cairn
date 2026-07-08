// Unit test for the exported isAdminMutationRequest() predicate — the pure
// boundary check driving hooks.server.ts's Layer-2 backstop against the
// admin-action auth bypass (cairn-fame, cairn-jnlx, cairn-bgv1: SvelteKit
// form `actions` don't run a parent route's load(), so a state-changing
// request straight to an /admin/* action skipped the layout's isAdmin gate).
// This must match on the EXACT /admin or /admin/* boundary, not a bare
// startsWith('/admin') — the latter would also catch an unrelated future
// route like /admin-help.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser, createSession, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { recordAdminDisclosure } from '$lib/server/disclosures';
import { generateRecoveryPhrase, generateRecoveryCodes } from '$lib/server/recovery';
import { handle, isAdminMutationRequest } from './hooks.server';
import type { RequestEvent } from '@sveltejs/kit';

describe('isAdminMutationRequest', () => {
	it('is true for state-changing requests to /admin and /admin/*', () => {
		expect(isAdminMutationRequest('POST', '/admin/users')).toBe(true);
		expect(isAdminMutationRequest('POST', '/admin')).toBe(true);
	});

	it('is false for GET/HEAD requests, regardless of path', () => {
		expect(isAdminMutationRequest('GET', '/admin/users')).toBe(false);
		expect(isAdminMutationRequest('HEAD', '/admin')).toBe(false);
	});

	it('is false for a look-alike path that merely starts with "/admin" (boundary case)', () => {
		expect(isAdminMutationRequest('POST', '/admin-help')).toBe(false);
	});

	it('is false for routes outside /admin entirely', () => {
		expect(isAdminMutationRequest('POST', '/api/admin/users')).toBe(false);
		expect(isAdminMutationRequest('POST', '/setup-admin')).toBe(false);
		expect(isAdminMutationRequest('POST', '/wallets')).toBe(false);
	});

	describe('decode hardening', () => {
		it('is true for a percent-encoded "a" spelling /admin/users, matching the decoded route the router dispatches to', () => {
			expect(isAdminMutationRequest('POST', '/%61dmin/users')).toBe(true);
		});

		it('is true for a percent-encoded "a" spelling of bare /admin', () => {
			expect(isAdminMutationRequest('POST', '/%61dmin')).toBe(true);
		});

		it('is false for /admin%2Fusers — %2F is a reserved char decodeURI leaves encoded, so this stays non-matching here exactly as it 404s in the router (no bypass, no over-block)', () => {
			expect(isAdminMutationRequest('POST', '/admin%2Fusers')).toBe(false);
		});

		it('is true for a malformed %-escape under /admin/ — decodeURI throws, and the fail-safe fallback to the raw path still matches and blocks', () => {
			expect(isAdminMutationRequest('POST', '/admin/%ZZ')).toBe(true);
		});
	});
});

// Integration coverage for handle() itself (cairn-isda, cairn-v84z). Drives
// the real hook against a real (per-test-file) DB, the same way
// routes/setup-admin/server.test.ts drives a route's load/actions — a
// minimal object satisfying the bits of RequestEvent the hook reads
// (url, route.id, request, cookies.get, locals).

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; ' +
			'DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances; ' +
			'DELETE FROM users; DELETE FROM settings;'
	);
}

function makeEvent(
	pathname: string,
	opts: { method?: string; routeId?: string | null; cookie?: string } = {}
): { event: RequestEvent; locals: Record<string, unknown> } {
	const url = new URL(`http://localhost${pathname}`);
	const locals: Record<string, unknown> = {};
	const event = {
		url,
		route: { id: opts.routeId ?? null },
		request: new Request(url, { method: opts.method ?? 'GET' }),
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? opts.cookie : undefined) },
		locals
	} as unknown as RequestEvent;
	return { event, locals };
}

async function callHandle(event: RequestEvent): Promise<Response> {
	return handle({ event, resolve: async () => new Response('ok', { status: 200 }) });
}

async function expectThrown(fn: () => unknown): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	return undefined;
}

describe('handle — asset fast-path runs before session/flags work (cairn-isda)', () => {
	it('resolves an /_app/ asset request without ever setting locals.user/flags', async () => {
		const { event, locals } = makeEvent('/_app/immutable/chunks/abc123.js');
		const res = await callHandle(event);
		expect(res.status).toBe(200);
		expect('user' in locals).toBe(false);
		expect('flags' in locals).toBe(false);
	});

	it('treats favicon/robots and common static extensions the same way', async () => {
		for (const p of ['/favicon.ico', '/robots.txt', '/logo.png', '/app.css']) {
			const { event, locals } = makeEvent(p);
			const res = await callHandle(event);
			expect(res.status).toBe(200);
			expect('user' in locals).toBe(false);
		}
	});

	it('sets locals.user/flags for a non-asset request', async () => {
		const { event, locals } = makeEvent('/some-non-app-route', { routeId: '/sync' });
		await callHandle(event);
		expect('user' in locals).toBe(true);
		expect('flags' in locals).toBe(true);
	});
});

describe('handle — (app) route group gates (cairn-v84z)', () => {
	beforeEach(() => {
		wipe();
		setSetting('registration_mode', 'open');
	});

	async function makeAdmin(): Promise<{
		id: number;
		email: string;
		displayName: string;
		isAdmin: boolean;
	}> {
		return registerUser({
			email: 'admin@example.com',
			password: 'correct horse battery',
			displayName: 'Admin'
		});
	}

	it('redirects an unauthenticated GET under (app) to /login with ?next=', async () => {
		const { event } = makeEvent('/wallets', { routeId: '/(app)/wallets' });
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 302, location: '/login?next=%2Fwallets' });
	});

	it('redirects a gated authenticated GET (forced credential reset) to /setup-admin', async () => {
		const admin = await makeAdmin();
		db.prepare('UPDATE users SET must_reset_password = 1 WHERE id = ?').run(admin.id);
		const { token } = createSession(admin.id);
		const { event } = makeEvent('/wallets', { routeId: '/(app)/wallets', cookie: token });
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 302, location: '/setup-admin' });
	});

	it('does not redirect once every gate is cleared', async () => {
		const admin = await makeAdmin();
		recordAdminDisclosure(admin.id);
		await generateRecoveryPhrase().store(admin.id);
		await generateRecoveryCodes().store(admin.id);
		const { token } = createSession(admin.id);
		const { event } = makeEvent('/wallets', { routeId: '/(app)/wallets', cookie: token });
		const res = await callHandle(event);
		expect(res.status).toBe(200);
	});

	it('does not redirect an admin with incomplete recovery on /recovery-setup itself (no loop)', async () => {
		const admin = await makeAdmin();
		recordAdminDisclosure(admin.id);
		const { token } = createSession(admin.id);
		const { event } = makeEvent('/recovery-setup', {
			routeId: '/(app)/recovery-setup',
			cookie: token
		});
		const res = await callHandle(event);
		expect(res.status).toBe(200);
	});

	it('fails a non-GET (app) action with 401 when unauthenticated (redirect() would break use:enhance)', async () => {
		const { event } = makeEvent('/wallets/send', { routeId: '/(app)/wallets/send', method: 'POST' });
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 401 });
	});

	it('fails a non-GET (app) action with 403 when authenticated but gated', async () => {
		const admin = await makeAdmin();
		db.prepare('UPDATE users SET must_reset_password = 1 WHERE id = ?').run(admin.id);
		const { token } = createSession(admin.id);
		const { event } = makeEvent('/wallets/send', {
			routeId: '/(app)/wallets/send',
			method: 'POST',
			cookie: token
		});
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 403 });
	});

	it('does not gate a route outside the (app) group (e.g. /login itself)', async () => {
		const { event } = makeEvent('/login', { routeId: '/(auth)/login' });
		const res = await callHandle(event);
		expect(res.status).toBe(200);
	});

	it('does not gate a route with no matched route id (e.g. a plain 404)', async () => {
		const { event } = makeEvent('/nope-not-a-route', { routeId: null });
		const res = await callHandle(event);
		expect(res.status).toBe(200);
	});
});

describe('handle — admin-mutation backstop and /vaults redirect still fire unchanged', () => {
	beforeEach(() => {
		wipe();
	});

	it('blocks an unauthenticated non-GET /admin/* request with 401 (Layer-2 backstop)', async () => {
		const { event } = makeEvent('/admin/users', { method: 'POST', routeId: '/(app)/admin/users' });
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 401 });
	});

	it('permanently redirects /vaults/[id] to the equivalent /wallets/multisig/[id] route', async () => {
		const { event } = makeEvent('/vaults/42', { routeId: null });
		const thrown = await expectThrown(() => callHandle(event));
		expect(thrown).toMatchObject({ status: 301, location: '/wallets/multisig/42' });
	});
});
