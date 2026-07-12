// Regression tests for the Wave 6 dual-field error shape (err-server.md §1):
// every guard/body-reader in api.ts throws through the new `apiError` helper,
// whose HttpError body carries BOTH `message` (SvelteKit's own convention)
// and `error` (the shape every `.svelte` client actually reads via
// `body?.error`). Before this fix, a fetch caller hitting a guard failure saw
// `body?.error === undefined` and silently fell back to its own generic
// string — the guard's specific, sometimes user-facing reason (e.g.
// requireFeature's admin-set message) never arrived.

import { describe, it, expect } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import {
	requireUser,
	requireAdmin,
	requireFeature,
	assertTeamMode,
	readJson,
	readOptionalJson
} from './api';

/** Minimal RequestEvent stand-in — only the fields each guard actually reads. */
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

/** Run a guard expected to throw, and assert the caught HttpError's body has
 *  the dual-field shape with both fields equal to the expected message. */
function expectDualFieldThrow(fn: () => unknown, status: number, message: string): void {
	let caught: unknown;
	try {
		fn();
	} catch (e) {
		caught = e;
	}
	expect(isHttpError(caught)).toBe(true);
	// isHttpError narrows caught to HttpError & {status}; body carries the shape.
	const err = caught as { status: number; body: { message?: string; error?: string } };
	expect(err.status).toBe(status);
	expect(err.body).toEqual({ message, error: message });
}

async function expectDualFieldThrowAsync(
	fn: () => Promise<unknown>,
	status: number,
	message: string
): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	expect(isHttpError(caught)).toBe(true);
	const err = caught as { status: number; body: { message?: string; error?: string } };
	expect(err.status).toBe(status);
	expect(err.body).toEqual({ message, error: message });
}

describe('api.ts guards emit the dual-field {error, message} shape (Wave 6)', () => {
	it('requireUser: 401 "Authentication required" when signed out', () => {
		expectDualFieldThrow(() => requireUser(makeEvent()), 401, 'Authentication required');
	});

	it('requireAdmin: 403 "Admin access required" for a non-admin user', () => {
		const event = makeEvent({
			locals: { user: { id: 1, email: 'a@x.com', displayName: 'A', isAdmin: false }, flags: {} }
		});
		expectDualFieldThrow(() => requireAdmin(event), 403, 'Admin access required');
	});

	it("requireFeature: 403 with the flag's own userMessage when disabled — the case R8/err-server.md flagged as silently dropped", () => {
		const event = makeEvent({
			locals: {
				user: { id: 1, email: 'a@x.com', displayName: 'A', isAdmin: false },
				// Explicitly resolved off — no DB round-trip needed for this guard.
				flags: { send: false }
			}
		});
		expectDualFieldThrow(
			() => requireFeature(event, 'send'),
			403,
			'Sending has been disabled by your administrator.'
		);
	});

	it('assertTeamMode: 404 "Not found" outside team mode (fresh test DB defaults to solo)', () => {
		expectDualFieldThrow(() => assertTeamMode(), 404, 'Not found');
	});

	it('readJson: 400 "Invalid JSON body" on malformed input', async () => {
		const event = makeEvent({ request: new Request('http://localhost/api/x', { method: 'POST', body: '{not json' }) });
		await expectDualFieldThrowAsync(() => readJson(event), 400, 'Invalid JSON body');
	});

	it('readOptionalJson: 400 "Invalid JSON body" on non-empty malformed input', async () => {
		const event = makeEvent({ request: new Request('http://localhost/api/x', { method: 'POST', body: 'not json either' }) });
		await expectDualFieldThrowAsync(() => readOptionalJson(event), 400, 'Invalid JSON body');
	});

	it('readJson: 413 "Request body too large" over the shared cap, declared via content-length', async () => {
		const event = makeEvent({
			request: new Request('http://localhost/api/x', {
				method: 'POST',
				headers: { 'content-length': '2000000' },
				body: 'x'
			})
		});
		await expectDualFieldThrowAsync(() => readJson(event), 413, 'Request body too large');
	});
});
