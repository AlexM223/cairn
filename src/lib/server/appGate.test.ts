// cairn-v84z — unit coverage for appGateRedirect(), the pure function that
// now decides the (app) route group's four access gates. This logic used to
// live inline in (app)/+layout.server.ts's load() and had DB-integration
// coverage in routes/(app)/layout.server.test.ts (forced credential-reset
// gate, recovery-setup gate); that coverage moves here since the gates moved
// here. All four underlying helpers are mocked so each branch is isolated
// and the ordering between gates is pinned precisely.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '$lib/types';

vi.mock('$lib/server/auth', () => ({
	mustResetPassword: vi.fn()
}));
vi.mock('$lib/server/disclosures', () => ({
	hasAcceptedAdminDisclosure: vi.fn(),
	hasAcceptedCurrentAgreement: vi.fn()
}));
vi.mock('$lib/server/recovery', () => ({
	hasRecoverySetup: vi.fn()
}));

import { mustResetPassword } from '$lib/server/auth';
import { hasAcceptedAdminDisclosure, hasAcceptedCurrentAgreement } from '$lib/server/disclosures';
import { hasRecoverySetup } from '$lib/server/recovery';
import { appGateRedirect } from './appGate';

const mustReset = vi.mocked(mustResetPassword);
const adminDisclosure = vi.mocked(hasAcceptedAdminDisclosure);
const userAgreement = vi.mocked(hasAcceptedCurrentAgreement);
const recoverySetup = vi.mocked(hasRecoverySetup);

const admin: SessionUser = { id: 1, email: 'admin@example.com', displayName: 'Admin', isAdmin: true };
const member: SessionUser = { id: 2, email: 'member@example.com', displayName: 'Member', isAdmin: false };

/** All-clear defaults: every gate would pass unless a test overrides it. */
beforeEach(() => {
	vi.clearAllMocks();
	mustReset.mockReturnValue(false);
	adminDisclosure.mockReturnValue(true);
	userAgreement.mockReturnValue(true);
	recoverySetup.mockReturnValue({ phrase: true, codesRemaining: 1 });
});

describe('appGateRedirect — no session', () => {
	it('redirects to /login with ?next= for a non-root path', () => {
		expect(appGateRedirect(null, '/wallets')).toBe('/login?next=%2Fwallets');
	});

	it('redirects to bare /login (no ?next=) when the path is already "/"', () => {
		expect(appGateRedirect(null, '/')).toBe('/login');
	});

	it('does not consult any of the DB-backed gate helpers when there is no user', () => {
		appGateRedirect(null, '/wallets');
		expect(mustReset).not.toHaveBeenCalled();
		expect(adminDisclosure).not.toHaveBeenCalled();
		expect(userAgreement).not.toHaveBeenCalled();
		expect(recoverySetup).not.toHaveBeenCalled();
	});
});

describe('appGateRedirect — forced credential-reset gate (cairn-49xi.2)', () => {
	it('redirects to /setup-admin when flagged, before any other gate', () => {
		mustReset.mockReturnValue(true);
		adminDisclosure.mockReturnValue(false); // would also gate — reset must win
		expect(appGateRedirect(admin, '/wallets')).toBe('/setup-admin');
	});

	it('does not short-circuit on the root path either', () => {
		mustReset.mockReturnValue(true);
		expect(appGateRedirect(admin, '/')).toBe('/setup-admin');
	});
});

describe('appGateRedirect — disclosure / agreement gate', () => {
	it('sends an admin without disclosure acceptance to /disclosure', () => {
		adminDisclosure.mockReturnValue(false);
		expect(appGateRedirect(admin, '/wallets')).toBe('/disclosure');
	});

	it('does NOT check hasAcceptedCurrentAgreement for an admin', () => {
		adminDisclosure.mockReturnValue(false);
		appGateRedirect(admin, '/wallets');
		expect(userAgreement).not.toHaveBeenCalled();
	});

	it('sends a non-admin without current agreement acceptance to /agreement', () => {
		userAgreement.mockReturnValue(false);
		expect(appGateRedirect(member, '/wallets')).toBe('/agreement');
	});

	it('does NOT check hasAcceptedAdminDisclosure for a non-admin', () => {
		userAgreement.mockReturnValue(false);
		appGateRedirect(member, '/wallets');
		expect(adminDisclosure).not.toHaveBeenCalled();
	});
});

describe('appGateRedirect — recovery gate (admin only)', () => {
	it('redirects an admin with no recovery phrase/codes to /recovery-setup', () => {
		recoverySetup.mockReturnValue({ phrase: false, codesRemaining: 0 });
		expect(appGateRedirect(admin, '/wallets')).toBe('/recovery-setup');
	});

	it('redirects an admin with a phrase but zero unused codes (half-done)', () => {
		recoverySetup.mockReturnValue({ phrase: true, codesRemaining: 0 });
		expect(appGateRedirect(admin, '/wallets')).toBe('/recovery-setup');
	});

	it('does not redirect from /recovery-setup itself — no redirect loop', () => {
		recoverySetup.mockReturnValue({ phrase: false, codesRemaining: 0 });
		expect(appGateRedirect(admin, '/recovery-setup')).toBeNull();
	});

	it('does not check recovery setup at all for a non-admin', () => {
		expect(appGateRedirect(member, '/wallets')).toBeNull();
		expect(recoverySetup).not.toHaveBeenCalled();
	});

	it('does not redirect once recovery is complete', () => {
		recoverySetup.mockReturnValue({ phrase: true, codesRemaining: 1 });
		expect(appGateRedirect(admin, '/wallets')).toBeNull();
	});
});

describe('appGateRedirect — all clear', () => {
	it('returns null for an admin who has cleared every gate', () => {
		expect(appGateRedirect(admin, '/wallets')).toBeNull();
	});

	it('returns null for a member who has cleared every gate', () => {
		expect(appGateRedirect(member, '/wallets')).toBeNull();
	});
});
