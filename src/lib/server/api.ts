import { error, json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';

/** Guard for /api routes: 401 JSON error when not signed in. */
export function requireUser(event: RequestEvent): SessionUser {
	if (!event.locals.user) error(401, 'Authentication required');
	return event.locals.user;
}

/** Guard for /api/admin routes: 403 when not an admin. */
export function requireAdmin(event: RequestEvent): SessionUser {
	const user = requireUser(event);
	if (!user.isAdmin) error(403, 'Admin access required');
	return user;
}

/** Read a JSON body, returning 400 on malformed input. */
export async function readJson<T = Record<string, unknown>>(event: RequestEvent): Promise<T> {
	try {
		return (await event.request.json()) as T;
	} catch {
		error(400, 'Invalid JSON body');
	}
}

export { json };
