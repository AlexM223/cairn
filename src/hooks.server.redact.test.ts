// cairn-16xi follow-up: src/hooks.server.test.ts (322 lines) already covers
// isAdminMutationRequest, the asset fast-path, (app) route-group gates, CSP
// fallback/widening, and the /vaults redirect — the bead's original "zero
// coverage" premise is stale. Two real gaps remain, both exercised here:
//
//   1. redactPath()/redactSegment() (hooks.server.ts:345-354) are unexported
//      internals with no dedicated test anywhere — every log line that
//      carries a request path runs through them (bitcoin addresses/txids must
//      never land in full in an operator's shipped logs). Not exportable
//      without touching src/, so this file pins their behavior INDIRECTLY:
//      mock $lib/server/logger's childLogger to capture the structured
//      fields hooks.server.ts actually logs, drive a real gated/blocked
//      request whose pathname contains a txid/bech32/base58/plain segment,
//      and assert what reached the log line.
//   2. A malformed/garbage/oversized session-cookie token reaching handle()
//      END-TO-END (not just getSessionUser/requireUser in isolation, which
//      sessionEdges.test.ts already covers) — proving locals.user resolves
//      to null and the (app) gate redirects to /login exactly as it would
//      for any other signed-out request, with no crash anywhere in the
//      pipeline.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const logs = vi.hoisted(() => ({
	adminGuard: [] as unknown[],
	gate: [] as unknown[]
}));

vi.mock('$lib/server/logger', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/logger')>();
	const stub = (bucket: unknown[]) => ({
		warn: (fields: unknown) => bucket.push(fields),
		info: (fields: unknown) => bucket.push(fields),
		error: (fields: unknown) => bucket.push(fields),
		debug: () => {}
	});
	return {
		...actual,
		childLogger: (tag: string) => {
			if (tag === 'admin-guard') return stub(logs.adminGuard);
			if (tag === 'gate') return stub(logs.gate);
			// Everything else (http, error, startup, process, ...) — real logger,
			// silent in test mode per logger.ts's own LEVEL default.
			return actual.childLogger(tag);
		}
	};
});

import { db } from '$lib/server/db';
import { registerUser, createSession, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { recordAdminDisclosure } from '$lib/server/disclosures';
import { generateRecoveryPhrase, generateRecoveryCodes } from '$lib/server/recovery';
import { handle } from './hooks.server';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; ' +
			'DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances; ' +
			'DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	logs.adminGuard.length = 0;
	logs.gate.length = 0;
	setSetting('registration_mode', 'open');
});

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

describe('redactPath — truncates sensitive path segments before they reach the log (indirect, via the admin-guard log line)', () => {
	it('a 64-hex txid/block-hash segment is truncated to its first 8 chars + ellipsis, never logged in full', async () => {
		const txid = 'a'.repeat(64);
		const { event } = makeEvent(`/admin/tx/${txid}`, { method: 'POST' });
		await expectThrown(() => callHandle(event)); // unauthenticated -> 401 thrown

		expect(logs.adminGuard).toHaveLength(1);
		const field = logs.adminGuard[0] as { path: string };
		expect(field.path).not.toContain(txid);
		expect(field.path).toBe(`/admin/tx/${'a'.repeat(8)}…`);
	});

	it('a bech32 address segment is truncated to its first 10 chars + ellipsis', async () => {
		const addr = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
		const { event } = makeEvent(`/admin/addr/${addr}`, { method: 'POST' });
		await expectThrown(() => callHandle(event));

		const field = logs.adminGuard[0] as { path: string };
		expect(field.path).not.toContain(addr);
		expect(field.path).toBe(`/admin/addr/${addr.slice(0, 10)}…`);
	});

	it('a base58 legacy-address-shaped segment is truncated to its first 8 chars + ellipsis', async () => {
		const addr = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
		const { event } = makeEvent(`/admin/addr/${addr}`, { method: 'POST' });
		await expectThrown(() => callHandle(event));

		const field = logs.adminGuard[0] as { path: string };
		expect(field.path).not.toContain(addr);
		expect(field.path).toBe(`/admin/addr/${addr.slice(0, 8)}…`);
	});

	it('a plain, non-sensitive segment passes through completely untouched', async () => {
		const { event } = makeEvent('/admin/users/settings', { method: 'POST' });
		await expectThrown(() => callHandle(event));

		const field = logs.adminGuard[0] as { path: string };
		expect(field.path).toBe('/admin/users/settings');
	});

	it('a segment that merely LOOKS like a txid (63 hex chars, one short) is left unredacted — the pattern is an exact 64-char match', async () => {
		const almostTxid = 'a'.repeat(63);
		const { event } = makeEvent(`/admin/tx/${almostTxid}`, { method: 'POST' });
		await expectThrown(() => callHandle(event));

		const field = logs.adminGuard[0] as { path: string };
		expect(field.path).toBe(`/admin/tx/${almostTxid}`);
	});
});

describe('redactPath via the (app) gate log line — same redaction applies on the other logging call site', () => {
	it('the /vaults legacy-redirect gate log line also redacts a txid-shaped segment in the path', async () => {
		const txid = 'b'.repeat(64);
		const { event } = makeEvent(`/vaults/${txid}`, { method: 'GET' });
		await expectThrown(() => callHandle(event)); // throws redirect(301, ...)

		expect(logs.gate).toHaveLength(1);
		const field = logs.gate[0] as { path: string };
		expect(field.path).not.toContain(txid);
		expect(field.path).toBe(`/vaults/${'b'.repeat(8)}…`);
	});
});

describe('a malformed/garbage/oversized session cookie reaches handle() end-to-end and is treated exactly like signed-out (no crash anywhere in the pipeline)', () => {
	it('a garbage cookie value on a gated (app) route: locals.user stays null and the request is redirected to /login, same as no cookie at all', async () => {
		const { event, locals } = makeEvent('/wallets', {
			routeId: '/(app)/wallets',
			cookie: "'; DROP TABLE sessions;--"
		});
		const thrown = await expectThrown(() => callHandle(event));
		expect(locals.user).toBeNull();
		expect(thrown).toMatchObject({ status: 302 });
		expect((thrown as { location: string }).location).toMatch(/^\/login\?next=/);
	});

	it('a pathologically oversized cookie value (100k chars) does not crash handle() and resolves to signed-out', async () => {
		const { event, locals } = makeEvent('/wallets', {
			routeId: '/(app)/wallets',
			cookie: 'x'.repeat(100_000)
		});
		const thrown = await expectThrown(() => callHandle(event));
		expect(locals.user).toBeNull();
		expect(thrown).toMatchObject({ status: 302 });
	});

	it('a truncated PREFIX of a real, currently-valid token does not authenticate through the full pipeline', async () => {
		const user = await registerUser({
			email: 'owner@example.com',
			password: 'correct horse battery',
			displayName: 'owner'
		});
		// Clear every other (app) gate (disclosure/recovery-phrase/recovery-codes)
		// so the "real token" sanity check below resolves cleanly instead of
		// redirecting somewhere else in the gate chain — mirrors
		// hooks.server.test.ts's own "does not redirect once every gate is
		// cleared" setup.
		recordAdminDisclosure(user.id);
		await generateRecoveryPhrase().store(user.id);
		await generateRecoveryCodes().store(user.id);
		const { token } = createSession(user.id);
		const truncated = token.slice(0, token.length - 4);

		const { event, locals } = makeEvent('/wallets', { routeId: '/(app)/wallets', cookie: truncated });
		const thrown = await expectThrown(() => callHandle(event));
		expect(locals.user).toBeNull();
		expect(thrown).toMatchObject({ status: 302 });

		// Sanity: the real, untouched token still works through the same pipeline.
		const { event: goodEvent, locals: goodLocals } = makeEvent('/wallets', {
			routeId: '/(app)/wallets',
			cookie: token
		});
		await callHandle(goodEvent);
		expect((goodLocals.user as { id: number } | null)?.id).toBe(user.id);
	});

	it('a garbage cookie on a NON-gated route (e.g. a plain API-style path outside (app)) never throws — handle() just resolves with locals.user null', async () => {
		const { event, locals } = makeEvent('/api/wallets', { routeId: '/api/wallets', cookie: 'not-a-real-token' });
		const res = await callHandle(event);
		expect(res.status).toBe(200); // resolve() ran, nothing threw
		expect(locals.user).toBeNull();
	});
});
