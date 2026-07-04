import { json } from '@sveltejs/kit';
import { registerUser, createSession, AuthError, SESSION_COOKIE } from '$lib/server/auth';
import {
	inviteRetryAfter,
	noteInviteFailure,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import { readJson } from '$lib/server/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{
		email?: string;
		password?: string;
		displayName?: string;
		inviteCode?: string;
	}>(event);

	const ip = event.getClientAddress();
	const wait = inviteRetryAfter(ip);
	if (wait !== null) {
		return json(
			{ error: tooManyAttemptsMessage(wait), code: 'rate_limited' },
			{ status: 429, headers: { 'retry-after': String(wait) } }
		);
	}

	try {
		const user = registerUser({
			email: body.email ?? '',
			password: body.password ?? '',
			displayName: body.displayName ?? '',
			inviteCode: body.inviteCode
		});
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
			if (e.code === 'bad_invite') noteInviteFailure(ip);
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		throw e;
	}
};
