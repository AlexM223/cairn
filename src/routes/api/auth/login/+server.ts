import { json } from '@sveltejs/kit';
import { loginUser, createSession, AuthError, SESSION_COOKIE } from '$lib/server/auth';
import {
	loginRetryAfter,
	noteLoginFailure,
	noteLoginSuccess,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import { readJson } from '$lib/server/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string; password?: string }>(event);
	const email = body.email ?? '';
	const ip = event.getClientAddress();

	const wait = loginRetryAfter(ip, email);
	if (wait !== null) {
		return json(
			{ error: tooManyAttemptsMessage(wait), code: 'rate_limited' },
			{ status: 429, headers: { 'retry-after': String(wait) } }
		);
	}

	try {
		const user = loginUser(email, body.password ?? '');
		noteLoginSuccess(ip, email);
		const { token, expiresAt } = createSession(user.id);
		event.cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: expiresAt
		});
		return json({ user });
	} catch (e) {
		if (e instanceof AuthError) {
			if (e.code === 'bad_credentials') noteLoginFailure(ip, email);
			return json({ error: e.message, code: e.code }, { status: 401 });
		}
		throw e;
	}
};
