import { redirect, type Cookies } from '@sveltejs/kit';
import { destroySession, SESSION_COOKIE } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function logout(cookies: Cookies) {
	destroySession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

// Support GET /logout (plain links, typed URLs) — the route has no +page.svelte,
// so without a load a GET would 500 instead of logging the user out.
export const load: PageServerLoad = async ({ cookies }) => {
	logout(cookies);
	redirect(302, '/login');
};

export const actions: Actions = {
	default: async ({ cookies }) => {
		logout(cookies);
		redirect(302, '/login');
	}
};
