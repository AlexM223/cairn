// Unit test for the exported isAdminMutationRequest() predicate — the pure
// boundary check driving hooks.server.ts's Layer-2 backstop against the
// admin-action auth bypass (cairn-fame, cairn-jnlx, cairn-bgv1: SvelteKit
// form `actions` don't run a parent route's load(), so a state-changing
// request straight to an /admin/* action skipped the layout's isAdmin gate).
// This must match on the EXACT /admin or /admin/* boundary, not a bare
// startsWith('/admin') — the latter would also catch an unrelated future
// route like /admin-help.

import { describe, it, expect } from 'vitest';
import { isAdminMutationRequest } from './hooks.server';

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
