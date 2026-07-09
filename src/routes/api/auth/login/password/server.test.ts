// cairn-wukz: POST /api/auth/login/password — email+password sign-in, plus the
// gated admin break-glass backdoor.
//
// Properties under test:
//   - normal login: right credentials → 200 + a real session; wrong → 401
//     bad_credentials with NO session.
//   - rejection mapping: a DISABLED account with the RIGHT password maps to 403
//     'disabled', a WRONG password maps to 401 'bad_credentials'. These must NOT
//     collapse into each other.
//   - break-glass (recovery.ts tryAdminBreakGlass): wired ONLY when
//     CAIRN_ADMIN_RECOVERY==='true', ONLY for the admin account with no passkeys,
//     ONLY with the exact env password. With the flag off it is inert (the env
//     password buys nothing); a non-admin never gets in this way.
//
// Each test uses a UNIQUE admin email + client ip so the module-level login
// throttle (not reset by the DB wipe) can't couple cases.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser, getSessionUser, SESSION_COOKIE } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { POST } from './+server';

function wipe(): void {
	db.exec('DELETE FROM user_credentials; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM events;');
}

let seq = 0;

const ENV_KEYS = ['CAIRN_ADMIN_RECOVERY', 'CAIRN_ADMIN_PASSWORD', 'APP_PASSWORD'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	// Break-glass OFF unless a test opts in.
	delete process.env.CAIRN_ADMIN_RECOVERY;
	delete process.env.CAIRN_ADMIN_PASSWORD;
	delete process.env.APP_PASSWORD;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
});

function makeCookies() {
	const jar: Record<string, string> = {};
	return {
		jar,
		get: (name: string) => jar[name],
		set: (name: string, value: string) => {
			jar[name] = value;
		},
		delete: (name: string) => {
			delete jar[name];
		}
	};
}

function event(body: Record<string, unknown>): { ev: Parameters<typeof POST>[0]; jar: Record<string, string> } {
	const cookies = makeCookies();
	const ip = `10.0.2.${++seq}`;
	const ev = {
		request: new Request('http://localhost/api/auth/login/password', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
			body: JSON.stringify(body)
		}),
		url: new URL('http://localhost/api/auth/login/password'),
		getClientAddress: () => ip,
		cookies,
		locals: {}
	} as unknown as Parameters<typeof POST>[0];
	return { ev, jar: cookies.jar };
}

async function post(body: Record<string, unknown>) {
	const { ev, jar } = event(body);
	const res = await POST(ev);
	return {
		status: res.status,
		body: (await res.json().catch(() => null)) as { error?: string; code?: string; user?: { id: number; email: string } } | null,
		jar
	};
}

/** Register a fresh admin (first user) with a unique email each call. */
async function freshAdmin(password?: string) {
	const email = `admin${++seq}@example.com`;
	const user = await registerUser({ email, displayName: 'Admin', password });
	return { ...user, email };
}

describe('POST /api/auth/login/password — normal login', () => {
	it('correct credentials return 200 and open a real session', async () => {
		const admin = await freshAdmin('correct horse battery');
		const { status, body, jar } = await post({ email: admin.email, password: 'correct horse battery' });
		expect(status).toBe(200);
		expect(body?.user?.id).toBe(admin.id);
		const token = jar[SESSION_COOKIE];
		expect(getSessionUser(token)?.id).toBe(admin.id);
	});

	it('a wrong password returns 401 bad_credentials with no session', async () => {
		const admin = await freshAdmin('correct horse battery');
		const { status, body, jar } = await post({ email: admin.email, password: 'nope nope nope' });
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
		expect(jar[SESSION_COOKIE]).toBeUndefined();
	});

	it('an unknown email returns the same 401 bad_credentials (no existence leak)', async () => {
		await freshAdmin('correct horse battery');
		const { status, body } = await post({ email: 'ghost@example.com', password: 'whatever pass' });
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
	});
});

describe('POST /api/auth/login/password — disabled vs bad-credential mapping', () => {
	it('a disabled account with the RIGHT password maps to 403 disabled (not 401)', async () => {
		const admin = await freshAdmin('correct horse battery');
		// Add a second user to disable (first user is admin; disabling it is fine too,
		// but use a member to keep intent clear).
		const member = await registerUser({ email: `member${++seq}@example.com`, displayName: 'M', password: 'member password ok' });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(member.id);

		const { status, body, jar } = await post({ email: member.email, password: 'member password ok' });
		expect(status).toBe(403);
		expect(body?.code).toBe('disabled');
		// A disabled account never gets a session.
		expect(jar[SESSION_COOKIE]).toBeUndefined();
		void admin;
	});

	it('a disabled account with a WRONG password still maps to 401 bad_credentials', async () => {
		await freshAdmin('correct horse battery');
		const member = await registerUser({ email: `member${++seq}@example.com`, displayName: 'M', password: 'member password ok' });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(member.id);

		const { status, body } = await post({ email: member.email, password: 'wrong wrong wrong' });
		// The disabled state is only revealed to someone who already has the right
		// password; a wrong password looks like any other bad login.
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
	});
});

describe('POST /api/auth/login/password — admin break-glass backdoor', () => {
	const BREAK_GLASS_PW = 'break-glass-env-password-xyz';

	it('is inert while CAIRN_ADMIN_RECOVERY is unset (env password buys nothing)', async () => {
		// Admin has a password but no passkeys; env password is set but the flag is OFF.
		const admin = await freshAdmin('the real admin password');
		process.env.CAIRN_ADMIN_PASSWORD = BREAK_GLASS_PW;
		// CAIRN_ADMIN_RECOVERY deliberately left unset.

		const { status, body, jar } = await post({ email: admin.email, password: BREAK_GLASS_PW });
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
		expect(jar[SESSION_COOKIE]).toBeUndefined();
	});

	it('lets a locked-out (passkey-less) admin in with the exact env password when enabled', async () => {
		const admin = await freshAdmin('the real admin password'); // no passkeys → break-glass eligible
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = BREAK_GLASS_PW;

		// The env password differs from the account's real password, so normal login
		// fails first and the break-glass path is what admits them.
		const { status, body, jar } = await post({ email: admin.email, password: BREAK_GLASS_PW });
		expect(status).toBe(200);
		expect(body?.user?.id).toBe(admin.id);
		expect(getSessionUser(jar[SESSION_COOKIE])?.id).toBe(admin.id);
	});

	it('rejects a wrong break-glass password even when enabled', async () => {
		const admin = await freshAdmin('the real admin password');
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = BREAK_GLASS_PW;

		const { status, body } = await post({ email: admin.email, password: 'not-the-env-password' });
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
	});

	it('never admits a NON-admin account, even with the env password', async () => {
		await freshAdmin('the real admin password'); // the actual admin
		const member = await registerUser({ email: `member${++seq}@example.com`, displayName: 'M', password: 'member real password' });
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = BREAK_GLASS_PW;

		const { status, body, jar } = await post({ email: member.email, password: BREAK_GLASS_PW });
		expect(status).toBe(401);
		expect(body?.code).toBe('bad_credentials');
		expect(jar[SESSION_COOKIE]).toBeUndefined();
		void member;
	});
});
