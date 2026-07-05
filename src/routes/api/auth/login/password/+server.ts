// POST /api/auth/login/password { email, password }
// Email + password sign-in (the default method). Throttled to blunt guessing.

import { json, readJson } from '$lib/server/api';
import { loginWithPassword, createSession, setSessionCookie, AuthError } from '$lib/server/auth';
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
		setSessionCookie(event.cookies, token, expiresAt);
		return json({ user });
	} catch (e) {
		if (e instanceof AuthError) {
			if (e.code === 'bad_credentials') noteLoginFailure(ip, email);
			return json({ error: e.message, code: e.code }, { status: e.code === 'disabled' ? 403 : 401 });
		}
		throw e;
	}
};
