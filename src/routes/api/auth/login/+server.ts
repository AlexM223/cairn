import { json } from '@sveltejs/kit';
import { loginUser, createSession, AuthError, SESSION_COOKIE } from '$lib/server/auth';
import { readJson } from '$lib/server/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string; password?: string }>(event);

	try {
		const user = loginUser(body.email ?? '', body.password ?? '');
		const { token, expiresAt } = createSession(user.id);
		event.cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: expiresAt
		});
		return json({ user });
	} catch (e) {
		if (e instanceof AuthError)
			return json({ error: e.message, code: e.code }, { status: 401 });
		throw e;
	}
};
