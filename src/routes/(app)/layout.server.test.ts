// cairn-8u9j — the (app) layout load() is the server-side recovery-setup gate:
// an ADMIN whose account recovery is incomplete (no phrase, or no unused codes)
// must be redirected to /recovery-setup from any app route. Pre-fix the wizard
// was only a client-side suggestion, so an operator could keep running an
// instance with an unrecoverable admin account. Pins: the redirect fires for
// admins, does NOT fire for members, exempts /recovery-setup itself (no loop),
// and stops once recovery is actually complete.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser, completeForcedCredentialReset } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { recordAdminDisclosure, recordUserAgreement } from '$lib/server/disclosures';
import { generateRecoveryPhrase, generateRecoveryCodes } from '$lib/server/recovery';
import { createAnnouncement, dismissAnnouncement } from '$lib/server/announcements';
import { load } from './+layout.server';

function wipe(): void {
	db.exec(
		'DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases; ' +
			'DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances; ' +
			'DELETE FROM announcement_dismissals; DELETE FROM announcements; ' +
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

// Forced credential-reset gate (cairn-49xi.2): a bootstrap-created admin whose
// password came from a deployment env var must land on /setup-admin before ANY
// other route — including before the disclosure and recovery gates, since an
// admin who hasn't chosen their own credentials shouldn't be onboarding yet.
describe('(app) layout forced credential-reset gate (cairn-49xi.2)', () => {
	function flagReset(userId: number): void {
		db.prepare('UPDATE users SET must_reset_password = 1 WHERE id = ?').run(userId);
	}

	it('redirects a flagged user from any app path to /setup-admin', async () => {
		flagReset(admin.id);
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: '/setup-admin' });
		expect(await runLoad(admin, '/')).toEqual({ redirected: '/setup-admin' });
	});

	it('fires BEFORE the disclosure and recovery gates', async () => {
		// Strip the disclosure acceptance so both gates would otherwise apply —
		// the reset gate must still win.
		db.exec('DELETE FROM admin_disclosure_acceptances');
		flagReset(admin.id);
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: '/setup-admin' });
	});

	it('does not redirect users without the flag', async () => {
		completeRecovery(admin.id);
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: null });
		expect(await runLoad(member, '/wallets')).toEqual({ redirected: null });
	});

	it('stops redirecting once the forced reset completes', async () => {
		flagReset(admin.id);
		completeForcedCredentialReset(admin.id, {
			email: 'chosen@example.com',
			password: 'chosen-by-human'
		});
		completeRecovery(admin.id);
		expect(await runLoad(admin, '/wallets')).toEqual({ redirected: null });
	});
});

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

// Announcement banners are loaded by this same layout load, gated on the
// announcement_banners feature flag as resolved in locals.flags (populated by
// hooks.server.ts). Flag off must mean ZERO banners in the returned data —
// the client renders whatever the load hands it.
describe('(app) layout announcement banners (flag-gated)', () => {
	/** Run the layout load for a member (no gates fire) and return its data.
	 *  (The load's return type unions with void — for a member on /wallets it
	 *  always returns data, so narrow it.) */
	type LayoutData = Exclude<Awaited<ReturnType<typeof load>>, void>;
	async function loadData(flags: Record<string, boolean>): Promise<LayoutData> {
		const event = {
			locals: { user: member, flags },
			url: new URL('http://localhost/wallets')
		} as unknown as Parameters<typeof load>[0];
		return (await load(event)) as LayoutData;
	}

	it('loads active announcements when the flag is on (default: absent ≠ false)', async () => {
		const a = createAnnouncement({ type: 'info', title: 'Hello', body: 'A test banner.' });
		const data = await loadData({});
		expect(data.announcements.map((x: { id: number }) => x.id)).toEqual([a.id]);
	});

	it('returns zero announcements when announcement_banners is off', async () => {
		createAnnouncement({ type: 'info', title: 'Hello', body: 'A test banner.' });
		const data = await loadData({ announcement_banners: false });
		expect(data.announcements).toEqual([]);
	});

	it("excludes this user's dismissed announcements", async () => {
		const a = createAnnouncement({ type: 'info', title: 'Hello', body: 'A test banner.' });
		dismissAnnouncement(member.id, a.id);
		const data = await loadData({});
		expect(data.announcements).toEqual([]);
	});
});

// Self-signed HTTPS listener advertisement (cairn-wgr8): the layout tells the
// client where Cairn's own secure-context origin lives (or that there is none)
// so USB-signing UI can offer it on plain-HTTP pages. External (host-mapped)
// port wins over the listen port; junk values mean "not running".
describe('(app) layout httpsPort (cairn-wgr8)', () => {
	async function loadData(): Promise<{ httpsPort: number | null }> {
		const event = {
			locals: { user: member, flags: {} },
			url: new URL('http://localhost/wallets')
		} as unknown as Parameters<typeof load>[0];
		return (await load(event)) as { httpsPort: number | null };
	}

	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		saved.CAIRN_HTTPS_PORT = process.env.CAIRN_HTTPS_PORT;
		saved.CAIRN_HTTPS_EXTERNAL_PORT = process.env.CAIRN_HTTPS_EXTERNAL_PORT;
		delete process.env.CAIRN_HTTPS_PORT;
		delete process.env.CAIRN_HTTPS_EXTERNAL_PORT;
	});
	afterEach(() => {
		for (const k of ['CAIRN_HTTPS_PORT', 'CAIRN_HTTPS_EXTERNAL_PORT']) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('is null when no HTTPS listener is configured', async () => {
		expect((await loadData()).httpsPort).toBeNull();
	});

	it('falls back to the listen port, and prefers the external (host-mapped) port', async () => {
		process.env.CAIRN_HTTPS_PORT = '3443';
		expect((await loadData()).httpsPort).toBe(3443);
		process.env.CAIRN_HTTPS_EXTERNAL_PORT = '3212';
		expect((await loadData()).httpsPort).toBe(3212);
	});

	it('treats junk values as not running', async () => {
		process.env.CAIRN_HTTPS_PORT = 'not-a-port';
		expect((await loadData()).httpsPort).toBeNull();
	});
});
