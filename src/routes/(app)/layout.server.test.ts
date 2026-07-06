// cairn-8u9j — the (app) layout load() is the server-side recovery-setup gate:
// an ADMIN whose account recovery is incomplete (no phrase, or no unused codes)
// must be redirected to /recovery-setup from any app route. Pre-fix the wizard
// was only a client-side suggestion, so an operator could keep running an
// instance with an unrecoverable admin account. Pins: the redirect fires for
// admins, does NOT fire for members, exempts /recovery-setup itself (no loop),
// and stops once recovery is actually complete.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { recordAdminDisclosure, recordUserAgreement } from '$lib/server/disclosures';
import { generateRecoveryPhrase, generateRecoveryCodes } from '$lib/server/recovery';
import { load } from './+layout.server';

function wipe(): void {
	db.exec(
		'DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; ' +
			'DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances; ' +
			'DELETE FROM wallet_backups; DELETE FROM backup_reminders; DELETE FROM multisigs; ' +
			'DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const PASSWORD = 'correct horse battery';
type User = { id: number; email: string; displayName: string; isAdmin: boolean };
let admin: User;
let member: User;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	admin = registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'admin' });
	member = registerUser({ email: 'member@example.com', password: PASSWORD, displayName: 'member' });
	// Get both users past the disclosure gates so the recovery gate is what decides.
	recordAdminDisclosure(admin.id);
	recordUserAgreement(member.id, null);
});

/** Run the layout load; SvelteKit's redirect() THROWS — translate it to a value. */
async function runLoad(user: User, pathname: string): Promise<{ redirected: string | null }> {
	const event = {
		locals: { user, flags: {} },
		url: new URL(`http://localhost${pathname}`)
	} as unknown as Parameters<typeof load>[0];
	try {
		await load(event);
		return { redirected: null };
	} catch (e) {
		const r = e as { status?: number; location?: string };
		if (typeof r.status === 'number' && r.status >= 300 && r.status < 400 && r.location) {
			return { redirected: r.location };
		}
		throw e;
	}
}

function completeRecovery(userId: number): void {
	generateRecoveryPhrase().store(userId);
	generateRecoveryCodes().store(userId);
}

describe('(app) layout recovery-setup gate (cairn-8u9j)', () => {
	it('redirects an admin with NO recovery setup from a normal app path', async () => {
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: '/recovery-setup' });
	});

	it('redirects an admin with a phrase but no unused codes (recovery half-done)', async () => {
		generateRecoveryPhrase().store(admin.id); // phrase only — codes still missing
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: '/recovery-setup' });
	});

	it('does NOT redirect on /recovery-setup itself — no redirect loop', async () => {
		expect(await runLoad(admin, '/recovery-setup')).toEqual({ redirected: null });
	});

	it('does NOT redirect a non-admin with incomplete recovery (recovery is only mandatory for the operator)', async () => {
		expect(await runLoad(member, '/wallets')).toEqual({ redirected: null });
	});

	it('stops redirecting once the admin completes recovery setup', async () => {
		completeRecovery(admin.id);
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: null });
	});
});
