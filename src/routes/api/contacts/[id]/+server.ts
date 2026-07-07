import { json, readJson, requireTeamMode } from '$lib/server/api';
import { respondToContact, removeContact } from '$lib/server/contacts';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * PATCH /api/contacts/:id — respond to an incoming request: { accept: boolean }.
 * Accept adds the friendship; decline removes the request.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	const body = await readJson<{ accept?: unknown }>(event);
	if (id === null || !respondToContact(user.id, id, body.accept === true)) {
		return json({ error: 'Request not found' }, { status: 404 });
	}
	return json({ ok: true });
};

/**
 * DELETE /api/contacts/:id — cancel a request you sent, or remove an existing
 * contact. Works from either side of the relationship.
 */
export const DELETE: RequestHandler = async (event) => {
	const user = requireTeamMode(event);
	const id = parseId(event.params.id);
	if (id === null || !removeContact(user.id, id)) {
		return json({ error: 'Contact not found' }, { status: 404 });
	}
	return json({ ok: true });
};
