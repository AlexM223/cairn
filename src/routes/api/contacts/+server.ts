import { json, readJson, requireUser } from '$lib/server/api';
import { listContacts, requestContact, ContactError } from '$lib/server/contacts';
import type { RequestHandler } from './$types';

/** GET /api/contacts — the caller's friends, incoming and outgoing requests. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	return json(listContacts(user.id));
};

/**
 * POST /api/contacts — send a contact request: { email }. Anti-enumeration: a
 * request to an unknown email returns the same success as a real one, so this
 * never reveals which emails have accounts. A reciprocal pending request is
 * auto-accepted.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ email?: unknown }>(event);
	try {
		requestContact(user.id, String(body.email ?? ''));
		return json({ ok: true });
	} catch (e) {
		if (e instanceof ContactError) {
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		throw e;
	}
};
