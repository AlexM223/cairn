// The (app) layout load() used to own four access gates (forced
// credential-reset, disclosure/agreement, recovery-setup) plus the data it
// threads to the client (announcements, httpsPort, firstSyncComplete, etc).
// cairn-v84z moved the gates to hooks.server.ts (via appGateRedirect() —
// see src/lib/server/appGate.ts and its dedicated appGate.test.ts, plus the
// hooks.server.ts integration tests) so this load can read ONLY `locals` and
// stay cacheable across client-side navigations. The gate-specific describes
// that used to live in this file (cairn-49xi.2 forced-reset, cairn-8u9j
// recovery-setup) have moved with the logic they tested; what remains here
// is coverage for the data this load still returns, plus the minimal
// defense-in-depth `!locals.user` fallback (Part C of cairn-v84z).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createAnnouncement, dismissAnnouncement } from '$lib/server/announcements';
import { resetFirstSyncStateForTests } from '$lib/server/syncStatus';
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
let member: User;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	// Get past the first-sync gate (cairn-koy4.11): mark the chain-history
	// cache as already built so the tests below control it explicitly via
	// clearHistoryCache(). The completion memo is process-wide — reset it so
	// the settings row is what this test controls.
	resetFirstSyncStateForTests();
	setSetting('chainEpochs.v1', '{"seeded":"by-test"}');
	// registerUser makes the FIRST registered account the admin, so register a
	// throwaway admin first, then `member` (non-admin) as the account these
	// data-loading tests exercise — none of them are gate tests anymore, so
	// isAdmin only matters here in that it's held constant across runs.
	registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'admin' });
	member = registerUser({ email: 'member@example.com', password: PASSWORD, displayName: 'member' });
});

/** Minimal event for invoking load(); the new signature reads only `locals`. */
function makeEvent(user: User | null): Parameters<typeof load>[0] {
	return { locals: { user, flags: {} } } as unknown as Parameters<typeof load>[0];
}

describe('(app) layout load — locals.user guard (cairn-v84z Part C, defense-in-depth)', () => {
	// hooks.server.ts's (app)-scoped appGateRedirect() guarantees locals.user is
	// set before this load ever runs in production, so this branch is normally
	// unreachable. It's still worth pinning: redirects to a PLAIN '/login' (no
	// ?next=), since reading `url` to build one would give this load a tracked
	// dependency and defeat the whole point of the refactor.
	it('redirects to plain /login when locals.user is null', async () => {
		const thrown = await (async () => {
			try {
				await load(makeEvent(null));
			} catch (e) {
				return e as { status?: number; location?: string };
			}
			return undefined;
		})();
		expect(thrown).toMatchObject({ status: 302, location: '/login' });
	});

	it('does not redirect when locals.user is set', async () => {
		const data = (await load(makeEvent(member))) as { user: User };
		expect(data.user.id).toBe(member.id);
	});
});

// Announcement banners are loaded by this same layout load, gated on the
// announcement_banners feature flag as resolved in locals.flags (populated by
// hooks.server.ts). Flag off must mean ZERO banners in the returned data —
// the client renders whatever the load hands it.
describe('(app) layout announcement banners (flag-gated)', () => {
	type LayoutData = Exclude<Awaited<ReturnType<typeof load>>, void>;
	async function loadData(flags: Record<string, boolean>): Promise<LayoutData> {
		const event = { locals: { user: member, flags } } as unknown as Parameters<typeof load>[0];
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
		return (await load(makeEvent(member))) as { httpsPort: number | null };
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

// First sync is NON-BLOCKING (cairn-2zxt.1): the layout never redirects on an
// incomplete chain-history cache, it just threads a coarse boolean the client
// polls around. (There used to be a redirect-based gate here; it was removed
// well before cairn-v84z, and the "no redirect" assertions that pinned its
// absence were removed in this same pass since load() no longer redirects for
// ANY gate — that coverage now lives in appGate.test.ts and
// hooks.server.test.ts.)
describe('(app) layout first-sync is non-blocking (cairn-2zxt.1)', () => {
	function clearHistoryCache(): void {
		db.prepare(`DELETE FROM settings WHERE key = 'chainEpochs.v1'`).run();
		resetFirstSyncStateForTests();
	}

	it('threads firstSyncComplete=false into the data while the cache is missing', async () => {
		clearHistoryCache();
		const data = (await load(makeEvent(member))) as Record<string, unknown>;
		expect(data.firstSyncComplete).toBe(false);
	});

	it('threads firstSyncComplete=true once the cache exists', async () => {
		setSetting('chainEpochs.v1', '{"seeded":"by-test"}');
		resetFirstSyncStateForTests();
		const data = (await load(makeEvent(member))) as Record<string, unknown>;
		expect(data.firstSyncComplete).toBe(true);
	});
});
