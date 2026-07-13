// Regression coverage for cairn-qlxs: the mandatory recovery-setup wizard
// (POST /api/auth/recovery/phrase, then POST /api/auth/recovery/codes) was
// reported to 401 on the *codes* step moments after the *phrase* step
// succeeded in the same session, persistently until a fresh login — reported
// twice independently during the 2026-07-12 destructive-ops QA wave (see
// docs/TEST-FINDINGS-2026-07-12.md and bead cairn-qlxs).
//
// This drives the REAL per-request pipeline — hooks.server.ts's `handle()`
// resolving `event.locals.user` fresh from the session cookie via
// getSessionUser(), exactly as two independent HTTP requests would — rather
// than hand-injecting `locals.user` the way most route-handler unit tests in
// this repo do (see hooks.server.test.ts's own "Integration coverage for
// handle() itself" section for the established pattern). That distinction
// matters here: a bug in session survival across requests can only show up
// when each step re-resolves locals.user from the cookie, not when a test
// hands the handler an already-authenticated `locals` object.
//
// Findings of this investigation (recorded in the cairn-qlxs bead comment):
//   - Neither /api/auth/recovery/phrase nor /api/auth/recovery/codes touches
//     the sessions table, destroyUserSessions(), or the cookie at all — both
//     call plain requireUser(event) and otherwise only write to
//     account_recovery_phrases / account_recovery_codes.
//   - hooks.server.ts's (app) route-group gate (appGateRedirect) only applies
//     to routes whose event.route.id starts with '/(app)' — these two routes
//     live at top-level /api/auth/recovery/*, so the gate never runs for them
//     even when an admin's recovery is incomplete (which, on the phrase step
//     specifically, is always true almost by definition).
//   - No rate limiter, feature flag, or admin-bootstrap step touches sessions
//     on this path either.
//
// The tests below exercise the exact reported sequence end-to-end through
// handle() twice (mirroring two real HTTP requests sharing one session
// cookie) and assert BOTH steps succeed — pinning the current (correct)
// behavior so a future regression that reintroduces a session-drop on this
// path fails loudly here instead of only surfacing in manual QA again.
import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { registerUser, createSession, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { recordAdminDisclosure } from '$lib/server/disclosures';
import { handle } from '../../../../hooks.server';
import { POST as postPhrase } from './phrase/+server';
import { POST as postCodes } from './codes/+server';
import { GET as getStatus } from './status/+server';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; ' +
			'DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances; ' +
			'DELETE FROM events; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeAdmin() {
	const admin = await registerUser({
		email: 'admin@example.com',
		password: 'correct horse battery',
		displayName: 'Admin'
	});
	// Clear the disclosure/agreement gates so they can't mask what we're
	// testing — this suite is about the recovery-secret endpoints only.
	recordAdminDisclosure(admin.id);
	return admin;
}

/** Build a bare-bones RequestEvent for a JSON POST/GET, the same shape
 *  hooks.server.test.ts's makeEvent() constructs, plus a real resolve() that
 *  dispatches to the given route handler — so handle() drives the FULL
 *  per-request pipeline (session resolution -> gates -> the route handler)
 *  exactly as SvelteKit would for a live request. */
async function requestThrough(
	handler: (event: RequestEvent) => Response | Promise<Response>,
	opts: { pathname: string; routeId: string; method?: string; cookie?: string }
): Promise<Response> {
	const url = new URL(`http://localhost${opts.pathname}`);
	const locals: Record<string, unknown> = {};
	const event = {
		url,
		route: { id: opts.routeId },
		request: new Request(url, { method: opts.method ?? 'POST' }),
		cookies: {
			get: (name: string) => (name === SESSION_COOKIE ? opts.cookie : undefined),
			set: () => {},
			delete: () => {}
		},
		getClientAddress: () => '127.0.0.1',
		locals
	} as unknown as RequestEvent;

	return await handle({
		event,
		resolve: async (ev) => handler(ev as RequestEvent)
	});
}

// The generated +server.ts handlers are typed as RequestHandler<Params, RouteId>
// for their own specific route (a narrower RequestEvent than the generic one
// requestThrough() deals in), so they're cast once here to the shape
// requestThrough() expects — the same "as unknown as" pattern already used
// for getStatus below — rather than repeating the cast at every call site.
const phraseHandler = postPhrase as unknown as (event: RequestEvent) => Response | Promise<Response>;
const codesHandler = postCodes as unknown as (event: RequestEvent) => Response | Promise<Response>;

describe('mandatory recovery-setup wizard end-to-end (cairn-qlxs)', () => {
	it('POST phrase (200) followed immediately by POST codes (200) in the same session — the exact reported repro sequence', async () => {
		const admin = await makeAdmin();
		const { token } = createSession(admin.id);

		const phraseRes = await requestThrough(phraseHandler, {
			pathname: '/api/auth/recovery/phrase',
			routeId: '/api/auth/recovery/phrase',
			cookie: token
		});
		expect(phraseRes.status).toBe(200);
		const phraseBody = await phraseRes.json();
		expect(typeof phraseBody.phrase).toBe('string');
		expect(phraseBody.phrase.split(' ')).toHaveLength(12);

		// This is the step that was reported to 401 "moments later" in the same
		// session. A fresh RequestEvent is used (as a second real HTTP request
		// would be), re-resolving locals.user from the SAME session cookie via
		// handle() -> getSessionUser(), exactly like two consecutive requests
		// from one browser tab.
		const codesRes = await requestThrough(codesHandler, {
			pathname: '/api/auth/recovery/codes',
			routeId: '/api/auth/recovery/codes',
			cookie: token
		});
		expect(codesRes.status).toBe(200);
		const codesBody = await codesRes.json();
		expect(codesBody.codes).toHaveLength(8);
	});

	it('the session used for the phrase step is still valid immediately afterward (no session drop as a side effect of minting a phrase)', async () => {
		const admin = await makeAdmin();
		const { token } = createSession(admin.id);

		await requestThrough(phraseHandler, {
			pathname: '/api/auth/recovery/phrase',
			routeId: '/api/auth/recovery/phrase',
			cookie: token
		});

		// A third, unrelated authenticated GET on the same cookie must still
		// resolve to the same user — proves generating the phrase didn't touch
		// the sessions table at all.
		const statusRes = await requestThrough(getStatus as unknown as (e: RequestEvent) => Response, {
			pathname: '/api/auth/recovery/status',
			routeId: '/api/auth/recovery/status',
			method: 'GET',
			cookie: token
		});
		expect(statusRes.status).toBe(200);
		const statusBody = await statusRes.json();
		expect(statusBody.phrase).toBe(true);
	});

	it('sanity check: an absent/garbage session cookie legitimately 401s both endpoints (the gate is still real)', async () => {
		// requireUser() throws SvelteKit's error() helper rather than returning a
		// Response — it propagates as a rejection here (a real deployment's
		// top-level request handling converts it to a JSON 401 response), so
		// assert on the thrown HttpError the same way hooks.server.test.ts does
		// for its own 401/403 gate assertions.
		const phraseThrown = await requestThrough(phraseHandler, {
			pathname: '/api/auth/recovery/phrase',
			routeId: '/api/auth/recovery/phrase',
			cookie: undefined
		}).catch((e) => e);
		expect(phraseThrown).toMatchObject({ status: 401 });

		const codesThrown = await requestThrough(codesHandler, {
			pathname: '/api/auth/recovery/codes',
			routeId: '/api/auth/recovery/codes',
			cookie: 'not-a-real-token'
		}).catch((e) => e);
		expect(codesThrown).toMatchObject({ status: 401 });
	});
});
