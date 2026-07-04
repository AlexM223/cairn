import type { Handle } from '@sveltejs/kit';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/auth';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = getSessionUser(event.cookies.get(SESSION_COOKIE));
	return resolve(event);
};
