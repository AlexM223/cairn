import { fail, redirect } from '@sveltejs/kit';
import {
	registerUser,
	createSession,
	AuthError,
	SESSION_COOKIE,
	userCount
} from '$lib/server/auth';
import {
	inviteRetryAfter,
	noteInviteFailure,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import { getInstanceSettings } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const firstUser = userCount() === 0;
	const mode = getInstanceSettings().registrationMode;
	return {
		firstUser,
		registrationMode: mode,
		needsInvite: !firstUser && mode === 'invite',
		closed: !firstUser && mode === 'closed'
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies } = event;
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const displayName = String(form.get('displayName') ?? '');
		const password = String(form.get('password') ?? '');
		const inviteCode = String(form.get('inviteCode') ?? '') || undefined;
		const ip = event.getClientAddress();

		// Throttle invite-code guessing before touching the database.
		const wait = inviteRetryAfter(ip);
		if (wait !== null)
			return fail(429, { error: tooManyAttemptsMessage(wait), email, displayName, inviteCode });

		try {
			const user = registerUser({ email, password, displayName, inviteCode });
			const { token, expiresAt } = createSession(user.id);
			cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				expires: expiresAt
			});
		} catch (e) {
			if (e instanceof AuthError) {
				if (e.code === 'bad_invite') noteInviteFailure(ip);
				return fail(400, { error: e.message, email, displayName, inviteCode });
			}
			throw e;
		}

		redirect(302, '/');
	}
};
