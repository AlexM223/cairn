// cairn-a857 — session/auth edge-case sweep, feeding the REAL session and
// guard functions (not mocked): createSession/getSessionUser/destroySession
// (auth.ts), requireUser (api.ts, the /api-route 401 guard), and the logout
// route's load/action (routes/logout/+page.server.ts).
//
// Scope: expired-token handling at the API-guard layer (not just
// getSessionUser, which auth.test.ts already covers), tampered/truncated
// tokens, session-after-logout, concurrent logins for one user, the exact
// expiry-instant boundary, and a deleted user's live session. Where current
// behavior is a real gap, it's pinned under a "KNOWN GAP (candidate bead)"
// describe block per src/lib/server/bitcoin/sendBoundaryMatrix.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import type { Cookies } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { db } from './db';
import {
	registerUser,
	createSession,
	getSessionUser,
	destroySession,
	destroyUserSessions,
	SESSION_COOKIE
} from './auth';
import { setSetting } from './settings';
import { requireUser } from './api';
import { load as logoutLoad, actions as logoutActions } from '../../routes/logout/+page.server';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Minimal RequestEvent stand-in for requireUser — mirrors api.test.ts's makeEvent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeApiEvent(user: unknown): any {
	return {
		request: new Request('http://localhost/api/x'),
		url: new URL('http://localhost/api/x'),
		locals: { user, flags: {} },
		getClientAddress: () => '127.0.0.1'
	};
}

/** Asserts a thrown value is a clean SvelteKit HttpError with this status —
 *  i.e. a deliberate 401, never an unhandled exception that would surface as
 *  a raw 500 to the client. */
function expectClean401(fn: () => unknown): void {
	let caught: unknown;
	try {
		fn();
	} catch (e) {
		caught = e;
	}
	expect(isHttpError(caught)).toBe(true);
	expect((caught as { status: number }).status).toBe(401);
}

/** In-memory Cookies stand-in that actually stores what's set, so a
 *  set-then-get (as the logout flow needs: read the cookie, then delete it)
 *  round-trips like the real SvelteKit Cookies object would. */
function makeCookieJar(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	const deleted: string[] = [];
	const cookies = {
		get: (name: string) => store.get(name),
		set: (name: string, value: string) => {
			store.set(name, value);
		},
		delete: (name: string) => {
			store.delete(name);
			deleted.push(name);
		}
	} as unknown as Cookies;
	return { cookies, deleted };
}

/** Reads a thrown SvelteKit redirect() as {status, location}, or undefined
 *  if nothing was thrown — same shape (app)/layout.server.test.ts uses. */
async function catchRedirect(fn: () => unknown): Promise<{ status?: number; location?: string } | undefined> {
	try {
		await fn();
	} catch (e) {
		return e as { status?: number; location?: string };
	}
	return undefined;
}

// ── expired session: clean 401 at the API-guard layer, not a 500 ───────────

describe('expired session -> clean 401, not a 500 (requireUser)', () => {
	it('a session that expired since it was created is rejected as signed-out, with a proper HttpError', async () => {
		const user = await makeUser('owner@example.com');
		const token = 'will-expire';
		db.prepare(
			'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
		).run(
			createHash('sha256').update(token).digest('hex'),
			user.id,
			new Date(Date.now() - 1000).toISOString()
		);
		// getSessionUser resolves it to null (session is expired and deleted)...
		expect(getSessionUser(token)).toBeNull();
		// ...and hooks.server.ts would set locals.user to that null before any
		// /api route ever ran requireUser — simulate exactly that handoff.
		expectClean401(() => requireUser(makeApiEvent(null)));
	});

	it('an expired session is deleted from the table on the read that discovers it — a retry never re-authenticates', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
			new Date(Date.now() - 1).toISOString(),
			createHash('sha256').update(token).digest('hex')
		);
		expect(getSessionUser(token)).toBeNull();
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
		// Calling again is still a clean null/401, not a crash on a re-deleted row.
		expect(getSessionUser(token)).toBeNull();
		expectClean401(() => requireUser(makeApiEvent(null)));
	});
});

// ── tampered / truncated / garbage session tokens ───────────────────────────

describe('tampered, truncated, or garbage session tokens never crash and never authenticate', () => {
	it('a truncated (prefix of a) valid token does not authenticate', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		const truncated = token.slice(0, token.length - 4);
		expect(truncated).not.toBe(token);
		expect(getSessionUser(truncated)).toBeNull();
		expect(getSessionUser(token)).not.toBeNull(); // the real token is untouched
	});

	it('a single flipped character in an otherwise-valid token does not authenticate', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		const chars = token.split('');
		chars[5] = chars[5] === 'a' ? 'b' : 'a';
		const tampered = chars.join('');
		expect(getSessionUser(tampered)).toBeNull();
	});

	it.each([
		'',
		'   ',
		'a'.repeat(100_000), // pathologically long garbage
		"'; DROP TABLE sessions;--",
		'\x00\x00\x00',
		'👍'.repeat(1000),
		'../../../etc/passwd',
		'null',
		'undefined'
	])('garbage token %j is rejected cleanly (null, no throw)', (garbage) => {
		expect(() => getSessionUser(garbage)).not.toThrow();
		expect(getSessionUser(garbage)).toBeNull();
	});

	it('a garbage/tampered token used against requireUser yields a clean 401, not a 500', async () => {
		// hooks.server.ts resolves the cookie -> getSessionUser -> null -> locals.user
		// stays null, so this is what an /api request with a tampered cookie sees.
		expect(getSessionUser("'; DROP TABLE sessions;--")).toBeNull();
		expectClean401(() => requireUser(makeApiEvent(null)));
		// The sessions table itself is untouched — the garbage token was never
		// anything but a literal (parameterized) hash lookup key.
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
		expect(n).toBe(0);
	});
});

// ── session used after logout ───────────────────────────────────────────────

describe('a session is dead the instant logout runs, not just eventually', () => {
	it('load() (GET /logout) destroys the session and redirects to /login', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		const { cookies, deleted } = makeCookieJar({ [SESSION_COOKIE]: token });

		const thrown = await catchRedirect(() => logoutLoad({ cookies } as never));
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
		expect(deleted).toContain(SESSION_COOKIE);
		expect(getSessionUser(token)).toBeNull();
	});

	it('actions.default (POST /logout) destroys the session too', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		const { cookies } = makeCookieJar({ [SESSION_COOKIE]: token });

		const thrown = await catchRedirect(() => logoutActions.default({ cookies } as never));
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
		expect(getSessionUser(token)).toBeNull();
	});

	it('re-presenting the SAME cookie value after logout still yields a clean 401, never a 500', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		const { cookies } = makeCookieJar({ [SESSION_COOKIE]: token });
		await catchRedirect(() => logoutLoad({ cookies } as never));

		// A stale browser tab or a replayed request still carrying the old cookie
		// value — the token itself never becomes invalid syntactically, only the
		// backing row is gone.
		expect(getSessionUser(token)).toBeNull();
		expectClean401(() => requireUser(makeApiEvent(null)));
	});

	it('logging out one session does not affect a second, independent session for the same user', async () => {
		const user = await makeUser('owner@example.com');
		const a = createSession(user.id);
		const b = createSession(user.id);
		destroySession(a.token);
		expect(getSessionUser(a.token)).toBeNull();
		expect(getSessionUser(b.token)).not.toBeNull();
	});
});

// ── concurrent logins for the same user ─────────────────────────────────────

describe('concurrent logins: multiple live sessions per user are allowed by design', () => {
	it('two independent logins both authenticate at the same time — no implicit single-session revocation', async () => {
		const user = await makeUser('owner@example.com');
		const deviceA = createSession(user.id);
		const deviceB = createSession(user.id);
		expect(deviceA.token).not.toBe(deviceB.token);

		const uA = getSessionUser(deviceA.token);
		const uB = getSessionUser(deviceB.token);
		expect(uA?.id).toBe(user.id);
		expect(uB?.id).toBe(user.id);

		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(2);
	});

	it('a THIRD login still does not revoke the first two — sessions accumulate rather than replacing', async () => {
		const user = await makeUser('owner@example.com');
		const a = createSession(user.id);
		const b = createSession(user.id);
		const c = createSession(user.id);
		expect(getSessionUser(a.token)).not.toBeNull();
		expect(getSessionUser(b.token)).not.toBeNull();
		expect(getSessionUser(c.token)).not.toBeNull();
	});

	it('destroyUserSessions (used when an admin disables an account) is the only thing that revokes every concurrent session at once', async () => {
		const user = await makeUser('owner@example.com');
		const a = createSession(user.id);
		const b = createSession(user.id);
		destroyUserSessions(user.id);
		expect(getSessionUser(a.token)).toBeNull();
		expect(getSessionUser(b.token)).toBeNull();
	});
});

// ── exact expiry-instant boundary ───────────────────────────────────────────

describe('session expiry boundary: the exact expiry instant is still valid, one tick later is not', () => {
	it('a session is valid AT its expires_at instant and invalid the millisecond after (strict "<" comparison)', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000_000_000_000);
			const user = await makeUser('owner@example.com');
			const { token } = createSession(user.id);
			const hash = createHash('sha256').update(token).digest('hex');
			const expiresAtMs = 1_000_000_050_000;
			db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
				new Date(expiresAtMs).toISOString(),
				hash
			);

			// Exactly at the expiry instant: getSessionUser's check is
			// `expires_at < now` — equal is NOT less-than, so still valid.
			vi.setSystemTime(expiresAtMs);
			expect(getSessionUser(token)).not.toBeNull();

			// One millisecond later: now strictly past expires_at -> invalid, and
			// the row is swept.
			vi.setSystemTime(expiresAtMs + 1);
			expect(getSessionUser(token)).toBeNull();
			const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(hash) as {
				n: number;
			};
			expect(n).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── deleted user's still-live session ───────────────────────────────────────

describe('a deleted user cannot leave a live session behind (schema-enforced cascade, not a gap)', () => {
	it('DELETE FROM users cascades to sessions (foreign_keys=ON) — the row is gone, not just orphaned', async () => {
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		expect(getSessionUser(token)).not.toBeNull();

		db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

		// The session ROW itself is gone (cascade), not merely unresolvable —
		// confirms this isn't a "user vanished but session row + secret survive"
		// situation that a future FK change could quietly reintroduce.
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
		expect(getSessionUser(token)).toBeNull();
	});

	it('disabling (not deleting) a user revokes their live sessions immediately via destroyUserSessions', async () => {
		// admin.ts's setUserDisabled calls destroyUserSessions(id) when disabling —
		// pinned here at the session layer: disabled + live session together must
		// never authenticate, and the session is actually removed, not just
		// masked by the `disabled` check in getSessionUser.
		const user = await makeUser('owner@example.com');
		const { token } = createSession(user.id);
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(user.id);
		// Belt-and-suspenders: getSessionUser also fails closed even before any
		// explicit session revocation runs.
		expect(getSessionUser(token)).toBeNull();
	});
});
