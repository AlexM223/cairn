import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '../db';
import { registerUser } from '../auth';
import { requireFeature } from '../api';
import { FEATURE_FLAGS } from './registry';
import { isFeatureEnabled, resolveAllFlags } from './resolve';
import { setGlobalFlag, setUserOverride, clearUserOverride } from './admin';

function wipe(): void {
	db.exec('DELETE FROM user_feature_flags; DELETE FROM feature_flags; DELETE FROM sessions; DELETE FROM users;');
}

beforeEach(() => {
	wipe();
});

const PASSWORD = 'correct horse battery';
let seq = 0;
function makeUser() {
	const email = `flags${seq++}@example.com`;
	return registerUser({ email, password: PASSWORD, displayName: 'Flag Tester' });
}

// A stable, representative key used across the precedence tests.
const KEY = 'send';

describe('isFeatureEnabled — resolution precedence (docs/FEATURE-FLAGS-PLAN.md §1.2)', () => {
	it('global absent + user absent → true (registry default)', async () => {
		const u = await makeUser();
		expect(isFeatureEnabled(KEY, u.id)).toBe(true);
	});

	it('global true + user absent → true', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, true, u.id);
		expect(isFeatureEnabled(KEY, u.id)).toBe(true);
	});

	it('global false + user absent → false', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, false, u.id);
		expect(isFeatureEnabled(KEY, u.id)).toBe(false);
	});

	it('global true + user false → false (admin restricts one user)', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, true, u.id);
		setUserOverride(u.id, KEY, false, u.id);
		expect(isFeatureEnabled(KEY, u.id)).toBe(false);
	});

	it('global false + user true → true (admin grants one user an exception)', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, false, u.id);
		setUserOverride(u.id, KEY, true, u.id);
		expect(isFeatureEnabled(KEY, u.id)).toBe(true);
	});

	it('clearing a user override reverts to the global value', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, false, u.id);
		setUserOverride(u.id, KEY, true, u.id);
		expect(isFeatureEnabled(KEY, u.id)).toBe(true);
		clearUserOverride(u.id, KEY);
		expect(isFeatureEnabled(KEY, u.id)).toBe(false);
	});

	it('a null (logged-out/system) context resolves the global value, ignoring any user rows', async () => {
		const u = await makeUser();
		setGlobalFlag(KEY, false, u.id);
		setUserOverride(u.id, KEY, true, u.id);
		expect(isFeatureEnabled(KEY, null)).toBe(false);
	});

	it('throws on an unknown flag key rather than silently granting/denying', async () => {
		const u = await makeUser();
		expect(() => isFeatureEnabled('not_a_real_flag', u.id)).toThrow(/Unknown feature flag/);
		expect(() => isFeatureEnabled('not_a_real_flag', null)).toThrow(/Unknown feature flag/);
	});
});

describe('resolveAllFlags', () => {
	it('migration safety: every registered flag resolves true against an empty database', async () => {
		const u = await makeUser();
		const resolvedForUser = resolveAllFlags(u.id);
		const resolvedGlobal = resolveAllFlags(null);
		for (const def of FEATURE_FLAGS) {
			expect(def.defaultEnabled).toBe(true); // the compiler guarantee, asserted at runtime too
			expect(resolvedForUser[def.key]).toBe(true);
			expect(resolvedGlobal[def.key]).toBe(true);
		}
		// Exactly the registry's keys, nothing more or less.
		expect(Object.keys(resolvedForUser).sort()).toEqual(FEATURE_FLAGS.map((f) => f.key).sort());
	});

	it('overlays user overrides over global rows over registry defaults in one pass', async () => {
		const u = await makeUser();
		setGlobalFlag('explorer', false, u.id); // global off
		setGlobalFlag('send', false, u.id); // global off
		setUserOverride(u.id, 'send', true, u.id); // user exception → on
		const flags = resolveAllFlags(u.id);
		expect(flags.explorer).toBe(false); // inherits global off
		expect(flags.send).toBe(true); // user override wins
		expect(flags.coin_control).toBe(true); // untouched → registry default
	});
});

// requireFeature is the real enforcement boundary. It prefers event.locals.flags
// (populated per-request in hooks.server.ts) and falls back to a fresh DB read.
function fakeEvent(userId: number | null, flags?: Record<string, boolean>): RequestEvent {
	return {
		locals: { user: userId == null ? null : { id: userId }, flags }
	} as unknown as RequestEvent;
}

/** Capture the status of an error(...) thrown by a guard. */
function statusOf(fn: () => void): number | undefined {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
}

describe('requireFeature — enforcement', () => {
	it('401s when there is no user at all', () => {
		expect(statusOf(() => requireFeature(fakeEvent(null), 'send'))).toBe(401);
	});

	it('403s with the flag userMessage when the resolved flag is off (via locals.flags)', async () => {
		const u = await makeUser();
		let thrown: unknown;
		try {
			requireFeature(fakeEvent(u.id, { send: false }), 'send');
		} catch (e) {
			thrown = e;
		}
		expect((thrown as { status?: number }).status).toBe(403);
		expect((thrown as { body?: { message?: string } }).body?.message).toMatch(
			/Sending has been disabled/
		);
	});

	it('returns the user when the flag is on (via locals.flags)', async () => {
		const u = await makeUser();
		const user = requireFeature(fakeEvent(u.id, { send: true }), 'send');
		expect(user.id).toBe(u.id);
	});

	it('falls back to a DB read when locals.flags is absent', async () => {
		const u = await makeUser();
		setGlobalFlag('send', false, u.id);
		// No flags on the event → requireFeature must read the DB and see the off row.
		expect(statusOf(() => requireFeature(fakeEvent(u.id), 'send'))).toBe(403);
		// A per-user exception flips it back on.
		setUserOverride(u.id, 'send', true, u.id);
		expect(requireFeature(fakeEvent(u.id), 'send').id).toBe(u.id);
	});
});
