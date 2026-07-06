import { json, readJson, requireUser } from '$lib/server/api';
import { listContacts, requestContact, ContactError } from '$lib/server/contacts';
import {
	contactRequestRetryAfter,
	noteContactRequest,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
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
	// Rate limit before doing any work: without this, the anti-enumeration
	// same-shape response still lets a wordlist be run at full speed (cairn-n4k4).
	const ip = event.getClientAddress();
	const wait = contactRequestRetryAfter(ip, user.id);
	if (wait !== null) {
		return json({ error: tooManyAttemptsMessage(wait), code: 'rate_limited' }, { status: 429 });
	}
	noteContactRequest(ip, user.id);

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
