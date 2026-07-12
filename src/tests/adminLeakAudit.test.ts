// Regression gate for cairn-f5gh — "no admin-only data ever reaches a
// non-admin session". Directive (c) requires this but nothing previously
// asserted it as a standing test; this file is that test.
//
// Two independent halves:
//
//  A. STRUCTURAL SWEEP (regression-proof against NEW admin routes). Every
//     +server.ts under src/routes/api/admin/** and every +page.server.ts
//     action under src/routes/(app)/admin/** is discovered by walking the
//     filesystem — never hand-listed — so a route added after this test was
//     written is automatically covered. For each discovered handler, calling
//     it as an anonymous or authenticated-but-non-admin caller must be
//     rejected/failed with 401/403 and must never resolve with real data.
//     The (app)/admin layout's own load() is pinned directly: it is the
//     single gate every admin PAGE load relies on (children never re-check
//     admin in their `load`, by design — see those files' own comments); a
//     form `action`, however, does NOT run the parent layout's load (the
//     historical cairn-fame/jnlx/bgv1 bug class), so every discovered admin
//     action is swept too.
//
//  B. MARKER-DIFF SWEEP. Distinctive secret marker strings are seeded into
//     every admin-only surface cairn-f5gh names by name (Core RPC password,
//     SMTP password, a draft/inactive announcement, an inactive referral
//     service, a per-admin-only feature-flag override), plus a denylist of
//     exact sensitive field names. Every user-reachable (app) page load and
//     /api endpoint that a regular signed-in user actually hits — the shared
//     (app) layout (rendered on literally every page), every /settings page,
//     /activity, and their /api equivalents — is then invoked AS THE REGULAR
//     (non-admin) USER, and the returned JSON is asserted to contain neither
//     any marker nor any denylisted key, anywhere in the (deeply-walked)
//     payload.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting, setSecretSetting } from '$lib/server/settings';
import { resolveAllFlags } from '$lib/server/featureFlags/resolve';
import { FEATURE_FLAGS } from '$lib/server/featureFlags/registry';
import { setGlobalFlag, setUserOverride } from '$lib/server/featureFlags/admin';
import { createAnnouncement } from '$lib/server/announcements';
import { createMultisigServiceReferral } from '$lib/server/referrals';
// apiTokens.ts owns its `api_tokens` table itself (a self-contained module,
// per its own header comment) rather than in db.ts's central schema — a
// side-effect-only import guarantees the table exists before wipe()'s DELETE
// runs, the same way every other table here comes in via db.ts's own import.
import '$lib/server/apiTokens';

// ---------------------------------------------------------------------------
// Filesystem discovery — src/tests/ -> src/routes/
// ---------------------------------------------------------------------------

const ROUTES_DIR = path.resolve(import.meta.dirname, '..', 'routes');

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function relRoute(absPath: string): string {
	return path.relative(ROUTES_DIR, absPath).split(path.sep).join('/');
}

async function importModule(absPath: string): Promise<Record<string, unknown>> {
	return import(pathToFileURL(absPath).href) as Promise<Record<string, unknown>>;
}

const ADMIN_API_SERVER_FILES = walk(path.join(ROUTES_DIR, 'api', 'admin')).filter((f) =>
	f.endsWith('+server.ts')
);
const ADMIN_APP_PAGE_FILES = walk(path.join(ROUTES_DIR, '(app)', 'admin')).filter(
	(f) => f.endsWith('+page.server.ts') && !f.endsWith('.test.ts')
);

// Sanity check on the discovery mechanism itself: if these come back empty the
// whole structural sweep below would silently pass on ZERO files. Pinning a
// floor here means a refactor that moves/renames the admin route tree trips
// this test instead of quietly disabling the gate.
describe('admin-leak audit — discovery sanity', () => {
	it('found a non-trivial number of admin API server files', () => {
		expect(ADMIN_API_SERVER_FILES.length).toBeGreaterThanOrEqual(9);
	});
	it('found a non-trivial number of admin (app) page.server files', () => {
		expect(ADMIN_APP_PAGE_FILES.length).toBeGreaterThanOrEqual(9);
	});
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

// Distinctive, greppable marker strings. If any of these literal values ever
// show up in a payload handed to the non-admin session, that IS the leak.
const RPC_PASS_MARKER = 'ADMINLEAK-MARK-RPCPASS-9f2e1c';
const SMTP_PASS_MARKER = 'ADMINLEAK-MARK-SMTPPASS-9f2e1c';
const DRAFT_ANNOUNCEMENT_TITLE = 'ADMINLEAK-MARK-DRAFT-ANNOUNCEMENT-9f2e1c';
const INACTIVE_REFERRAL_NAME = 'ADMINLEAK-MARK-INACTIVE-REFERRAL-9f2e1c';
const ALL_MARKERS = [
	RPC_PASS_MARKER,
	SMTP_PASS_MARKER,
	DRAFT_ANNOUNCEMENT_TITLE,
	INACTIVE_REFERRAL_NAME
];

// Exact field names that must NEVER appear anywhere in a payload served to a
// non-admin session, regardless of value. Deliberately EXACT names (not
// prefixes/substrings) so legitimate presence-flags (hasCoreRpcPass,
// hasTelegramBotToken, hasPassword, configured, ...) don't false-positive.
const SENSITIVE_EXACT_KEYS = new Set([
	'password_hash',
	'passwordHash',
	'core_rpc_pass',
	'coreRpcPass',
	'smtp_pass',
	'smtpPass',
	'value_enc',
	'telegram_bot_token',
	'telegramBotToken',
	'webhook_secret',
	'webhookSecret',
	'token_hash',
	'tokenHash',
	'nsec',
	'nostr_private_key',
	'nostrPrivateKey'
]);

function findSensitiveKeys(value: unknown, base = '$', hits: string[] = []): string[] {
	if (value === null || typeof value !== 'object') return hits;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) findSensitiveKeys(value[i], `${base}[${i}]`, hits);
		return hits;
	}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (SENSITIVE_EXACT_KEYS.has(k)) hits.push(`${base}.${k}`);
		findSensitiveKeys(v, `${base}.${k}`, hits);
	}
	return hits;
}

function markerHitsIn(value: unknown): string[] {
	const json = JSON.stringify(value) ?? '';
	return ALL_MARKERS.filter((m) => json.includes(m));
}

function wipe(): void {
	db.exec(
		`DELETE FROM user_feature_flags; DELETE FROM feature_flags;
		 DELETE FROM announcement_dismissals; DELETE FROM announcements;
		 DELETE FROM multisig_service_referrals;
		 DELETE FROM notification_channel_config; DELETE FROM notification_preferences;
		 DELETE FROM user_pgp_keys; DELETE FROM api_tokens; DELETE FROM contacts;
		 DELETE FROM known_devices; DELETE FROM sessions;
		 DELETE FROM account_recovery_codes; DELETE FROM account_recovery_phrases;
		 DELETE FROM admin_disclosure_acceptances; DELETE FROM user_agreement_acceptances;
		 DELETE FROM instance_secrets; DELETE FROM users; DELETE FROM settings;`
	);
}

let admin: SessionUser;
let member: SessionUser;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	setSetting('instance_mode', 'team'); // let team-only pages (contacts) actually load, not 404
	// registerUser() makes the FIRST registered account the admin (repo convention).
	admin = await registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'Admin' });
	member = await registerUser({ email: 'member@example.com', password: PASSWORD, displayName: 'Member' });

	// --- Seed every admin-only surface cairn-f5gh names, with markers -------
	setSecretSetting('core_rpc_pass', RPC_PASS_MARKER);
	setSecretSetting('smtp_pass', SMTP_PASS_MARKER);
	createAnnouncement({
		type: 'info',
		title: DRAFT_ANNOUNCEMENT_TITLE,
		body: 'Draft body never meant for users.',
		active: false // inactive/"draft" — must never reach a user's announcements list
	});
	createMultisigServiceReferral({
		name: INACTIVE_REFERRAL_NAME,
		url: 'https://example.test/service',
		description: 'internal-only, inactive',
		logoUrl: '',
		active: false,
		displayOrder: 0
	});
	// A flag forced OFF globally but overridden ON for the admin specifically —
	// the regular member must see the GLOBAL (off) resolution, never the
	// admin's personal override.
	const flagKey = FEATURE_FLAGS[0].key;
	setGlobalFlag(flagKey, false, admin.id);
	setUserOverride(admin.id, flagKey, true, admin.id);
});

// ---------------------------------------------------------------------------
// Generic event builders
// ---------------------------------------------------------------------------

function localsFor(user: SessionUser | undefined): { user: SessionUser | undefined; flags: Record<string, boolean> } {
	return { user, flags: user ? resolveAllFlags(user.id) : {} };
}

/** A RequestEvent shape generic enough for both `load()` and `+server.ts` handlers. */
function makeRequestEvent(
	user: SessionUser | undefined,
	opts: { method?: string; body?: BodyInit; url?: string } = {}
): RequestEvent {
	const url = new URL(opts.url ?? 'http://localhost/');
	return {
		url,
		params: {},
		locals: localsFor(user),
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] },
		request: new Request(url, { method: opts.method ?? 'GET', body: opts.body }),
		getClientAddress: () => '127.0.0.1',
		parent: async () => ({ user })
	} as unknown as RequestEvent;
}

/** A minimal event for invoking a `load()` directly (bypassing $types constraints). */
function makeLoadEvent(user: SessionUser | undefined, url = 'http://localhost/'): unknown {
	return makeRequestEvent(user, { url });
}

async function statusOf(run: () => unknown): Promise<number | undefined> {
	try {
		const result = await run();
		return (result as { status?: number } | undefined)?.status;
	} catch (e) {
		return (e as { status?: number } | undefined)?.status;
	}
}

// ===========================================================================
// A. STRUCTURAL SWEEP
// ===========================================================================

describe('admin-leak audit — /api/admin/** structural sweep (every discovered handler)', () => {
	const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

	for (const file of ADMIN_API_SERVER_FILES) {
		const rel = relRoute(file);

		it(`${rel}: every exported handler rejects anon (401) and non-admin (403), never 2xx`, async () => {
			const mod = await importModule(file);
			let sawAtLeastOneHandler = false;

			for (const method of METHODS) {
				const handler = mod[method] as ((event: RequestEvent) => unknown) | undefined;
				if (!handler) continue;
				sawAtLeastOneHandler = true;

				// GET requests cannot carry a body (the Fetch spec throws
				// constructing the Request otherwise) — only attach one for methods
				// that allow it. METHODS never includes HEAD, so GET is the only
				// case to guard here.
				const body = method === 'GET' ? undefined : '{}';

				const anonStatus = await statusOf(() =>
					handler(makeRequestEvent(undefined, { method, body }))
				);
				expect(
					anonStatus,
					`${rel} ${method} must reject an anonymous caller with 401`
				).toBe(401);

				const memberStatus = await statusOf(() =>
					handler(makeRequestEvent(member, { method, body }))
				);
				expect(
					memberStatus,
					`${rel} ${method} must reject a non-admin caller with 403`
				).toBe(403);
			}

			expect(sawAtLeastOneHandler, `${rel} exports no recognized HTTP method handler`).toBe(true);
		});
	}
});

describe('admin-leak audit — (app)/admin layout gate', () => {
	it('throws 403 when the resolved parent user is not an admin', async () => {
		const { load } = await importModule(path.join(ROUTES_DIR, '(app)', 'admin', '+layout.server.ts'));
		const event = { parent: async () => ({ user: member }) } as unknown as Parameters<
			typeof load extends (e: infer E) => unknown ? (e: E) => unknown : never
		>[0];
		await expect((load as (e: unknown) => unknown)(event)).rejects.toMatchObject({ status: 403 });
	});

	it('does not throw for a real admin', async () => {
		const { load } = await importModule(path.join(ROUTES_DIR, '(app)', 'admin', '+layout.server.ts'));
		const event = { parent: async () => ({ user: admin }) };
		await expect((load as (e: unknown) => unknown)(event)).resolves.toBeDefined();
	});
});

describe('admin-leak audit — (app)/admin/**/+page.server.ts actions structural sweep', () => {
	// Form `actions` do NOT run the parent layout's load() (the historical
	// cairn-fame/jnlx/bgv1 bug class) — every discovered action under
	// (app)/admin/** must re-check admin itself. Read-only admin pages with no
	// `actions` export (activity, logs, notifications) are skipped: they have
	// nothing to sweep and rely entirely on the layout gate, which is covered
	// above.
	for (const file of ADMIN_APP_PAGE_FILES) {
		const rel = relRoute(file);

		it(`${rel}: every exported action rejects/fails anon and non-admin with 401/403`, async () => {
			const mod = await importModule(file);
			const actions = mod.actions as Record<string, (e: RequestEvent) => unknown> | undefined;
			if (!actions) return; // no actions exported — nothing to sweep in this file

			for (const [name, action] of Object.entries(actions)) {
				const anonStatus = await statusOf(() =>
					action(makeRequestEvent(undefined, { method: 'POST', body: new FormData() }))
				);
				expect(
					anonStatus !== undefined && anonStatus >= 400 && anonStatus < 500,
					`${rel} action "${name}" must reject/fail an anonymous caller with a 4xx (got ${anonStatus})`
				).toBe(true);

				const memberStatus = await statusOf(() =>
					action(makeRequestEvent(member, { method: 'POST', body: new FormData() }))
				);
				expect(
					memberStatus !== undefined && memberStatus >= 400 && memberStatus < 500,
					`${rel} action "${name}" must reject/fail a non-admin caller with a 4xx (got ${memberStatus})`
				).toBe(true);
			}
		});
	}
});

// ===========================================================================
// B. MARKER-DIFF SWEEP — every user-reachable load a regular session actually
//    hits, invoked AS THE NON-ADMIN MEMBER, scanned for admin-only leakage.
// ===========================================================================

interface SweepCase {
	name: string;
	load: () => Promise<unknown>;
}

async function loadModule(relParts: string[]): Promise<{ load: (e: unknown) => Promise<unknown> }> {
	const mod = await importModule(path.join(ROUTES_DIR, ...relParts));
	const rawLoad = mod.load as (e: unknown) => unknown;
	// Wrapped in an async function so the return type is always Promise<unknown>
	// regardless of whether the underlying route `load` is sync or async.
	return { load: async (e: unknown) => rawLoad(e) };
}

async function buildSweepCases(): Promise<SweepCase[]> {
	const layout = await loadModule(['(app)', '+layout.server.ts']);
	const settings = await loadModule(['(app)', 'settings', '+page.server.ts']);
	const notifSettings = await loadModule(['(app)', 'settings', 'notifications', '+page.server.ts']);
	const tokensSettings = await loadModule(['(app)', 'settings', 'tokens', '+page.server.ts']);
	const contactsSettings = await loadModule(['(app)', 'settings', 'contacts', '+page.server.ts']);
	const devicesSettings = await loadModule(['(app)', 'settings', 'devices', '+page.server.ts']);
	const activityPage = await loadModule(['(app)', 'activity', '+page.server.ts']);

	const apiActivity = await importModule(path.join(ROUTES_DIR, 'api', 'activity', '+server.ts'));
	const apiNotifications = await importModule(path.join(ROUTES_DIR, 'api', 'notifications', '+server.ts'));
	const apiTokens = await importModule(path.join(ROUTES_DIR, 'api', 'tokens', '+server.ts'));

	return [
		{ name: '(app)/+layout.server.ts', load: () => layout.load(makeLoadEvent(member)) },
		{ name: '(app)/settings/+page.server.ts', load: () => settings.load(makeLoadEvent(member)) },
		{
			name: '(app)/settings/notifications/+page.server.ts',
			load: () => notifSettings.load(makeLoadEvent(member))
		},
		{ name: '(app)/settings/tokens/+page.server.ts', load: () => tokensSettings.load(makeLoadEvent(member)) },
		{
			name: '(app)/settings/contacts/+page.server.ts',
			load: () => contactsSettings.load(makeLoadEvent(member))
		},
		{
			name: '(app)/settings/devices/+page.server.ts',
			load: () => devicesSettings.load(makeLoadEvent(member))
		},
		{ name: '(app)/activity/+page.server.ts', load: () => activityPage.load(makeLoadEvent(member)) },
		{
			name: 'api/activity/+server.ts GET',
			load: async () => {
				const res = (await (apiActivity.GET as (e: RequestEvent) => unknown)(
					makeRequestEvent(member)
				)) as Response;
				return res.json();
			}
		},
		{
			name: 'api/notifications/+server.ts GET',
			load: async () => {
				const res = (await (apiNotifications.GET as (e: RequestEvent) => unknown)(
					makeRequestEvent(member)
				)) as Response;
				return res.json();
			}
		},
		{
			name: 'api/tokens/+server.ts GET',
			load: async () => {
				const res = (await (apiTokens.GET as (e: RequestEvent) => unknown)(
					makeRequestEvent(member)
				)) as Response;
				return res.json();
			}
		}
	];
}

describe('admin-leak audit — marker-diff sweep (regular member session)', () => {
	it('none of the swept user-reachable payloads contain a seeded admin-only marker or sensitive key', async () => {
		const cases = await buildSweepCases();
		const failures: string[] = [];

		for (const c of cases) {
			const payload = await c.load();
			const markers = markerHitsIn(payload);
			const sensitiveKeys = findSensitiveKeys(payload);
			if (markers.length > 0) {
				failures.push(`${c.name}: leaked marker(s) ${JSON.stringify(markers)}`);
			}
			if (sensitiveKeys.length > 0) {
				failures.push(`${c.name}: leaked sensitive key(s) ${JSON.stringify(sensitiveKeys)}`);
			}
		}

		expect(failures, failures.join('\n')).toEqual([]);
	});

	it('the draft (inactive) announcement never appears in the (app) layout announcements list', async () => {
		const layout = await loadModule(['(app)', '+layout.server.ts']);
		const data = (await layout.load(makeLoadEvent(member))) as {
			announcements: { title: string }[];
		};
		expect(data.announcements.some((a) => a.title === DRAFT_ANNOUNCEMENT_TITLE)).toBe(false);
	});

	it("a global-off, admin-only-overridden-on flag resolves OFF (the global value) for the regular member, never the admin's personal override", async () => {
		const layout = await loadModule(['(app)', '+layout.server.ts']);
		const data = (await layout.load(makeLoadEvent(member))) as { flags: Record<string, boolean> };
		expect(data.flags[FEATURE_FLAGS[0].key]).toBe(false);
	});
});

describe('admin-leak audit — cross-user isolation (bonus: "other users\' data")', () => {
	it("the regular member's own token/activity/notification payloads never mention the admin's email", async () => {
		const apiActivity = await importModule(path.join(ROUTES_DIR, 'api', 'activity', '+server.ts'));
		const apiTokens = await importModule(path.join(ROUTES_DIR, 'api', 'tokens', '+server.ts'));

		const activityRes = (await (apiActivity.GET as (e: RequestEvent) => unknown)(
			makeRequestEvent(member)
		)) as Response;
		const tokensRes = (await (apiTokens.GET as (e: RequestEvent) => unknown)(
			makeRequestEvent(member)
		)) as Response;

		const activityJson = JSON.stringify(await activityRes.json());
		const tokensJson = JSON.stringify(await tokensRes.json());

		expect(activityJson.includes(admin.email)).toBe(false);
		expect(tokensJson.includes(admin.email)).toBe(false);
	});
});
