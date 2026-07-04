import { fail, redirect } from '@sveltejs/kit';
import { loginUser, createSession, AuthError, SESSION_COOKIE, userCount } from '$lib/server/auth';
import {
	loginRetryAfter,
	noteLoginFailure,
	noteLoginSuccess,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Brand-new instance: send straight to first-admin signup.
	if (userCount() === 0) redirect(302, '/signup');
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const { request, cookies, url } = event;
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');
		const ip = event.getClientAddress();

		const wait = loginRetryAfter(ip, email);
		if (wait !== null) return fail(429, { error: tooManyAttemptsMessage(wait), email });

		try {
			const user = loginUser(email, password);
			noteLoginSuccess(ip, email);
			const { token, expiresAt } = createSession(user.id);
			cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				expires: expiresAt
			});
		} catch (e) {
			if (e instanceof AuthError) {
				if (e.code === 'bad_credentials') noteLoginFailure(ip, email);
				return fail(400, { error: e.message, email });
			}
			throw e;
		}

		const next = url.searchParams.get('next');
		redirect(302, next && next.startsWith('/') ? next : '/');
	}
};
