import { redirect } from '@sveltejs/kit';
import { destroySession, SESSION_COOKIE } from '$lib/server/auth';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ cookies }) => {
		destroySession(cookies.get(SESSION_COOKIE));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(302, '/login');
	}
};
