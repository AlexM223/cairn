import { fail, redirect } from '@sveltejs/kit';
import { loginUser, createSession, AuthError, SESSION_COOKIE, userCount } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Brand-new instance: send straight to first-admin signup.
	if (userCount() === 0) redirect(302, '/signup');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');

		try {
			const user = loginUser(email, password);
			const { token, expiresAt } = createSession(user.id);
			cookies.set(SESSION_COOKIE, token, {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				expires: expiresAt
			});
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message, email });
			throw e;
		}

		const next = url.searchParams.get('next');
		redirect(302, next && next.startsWith('/') ? next : '/');
	}
};
