// POST /api/auth/login/password { email, password }
// Email + password sign-in (the default method). Throttled to blunt guessing.

import { json, readJson } from '$lib/server/api';
import {
	loginWithPassword,
	createSession,
	setSessionCookie,
	getUserById,
	hasNoCredentials,
	AuthError
} from '$lib/server/auth';
import { tryAdminBreakGlass, recordBreakGlassLogin } from '$lib/server/recovery';
import { loginRetryAfter, noteLoginFailure, noteLoginSuccess, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string; password?: string }>(event);
	const email = String(body.email ?? '');
	const password = String(body.password ?? '');
	const ip = event.getClientAddress();

	const wait = loginRetryAfter(ip, email);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });

	try {
		const user = loginWithPassword(email, password);
		noteLoginSuccess(ip, email);
		const { token, expiresAt } = createSession(user.id);
		setSessionCookie(event.cookies, token, expiresAt, event.url);
		return json({ user });
	} catch (e) {
		if (e instanceof AuthError) {
			// Break-glass admin recovery (OFF unless CAIRN_ADMIN_RECOVERY === 'true').
			// Only a locked-out admin (no usable passkeys) matching the deployment
			// password env var gets in this way; it never widens normal auth, so it
			// is only consulted AFTER normal password login has failed.
			if (e.code === 'bad_credentials') {
				const grant = tryAdminBreakGlass(email, password, hasNoCredentials);
				if (grant) {
					const admin = getUserById(grant.userId);
					if (admin) {
						noteLoginSuccess(ip, email);
						recordBreakGlassLogin(admin.id, admin.email);
						const { token, expiresAt } = createSession(admin.id);
						setSessionCookie(event.cookies, token, expiresAt, event.url);
						return json({ user: admin });
					}
				}
				noteLoginFailure(ip, email);
			}
			return json({ error: e.message, code: e.code }, { status: e.code === 'disabled' ? 403 : 401 });
		}
		throw e;
	}
};
