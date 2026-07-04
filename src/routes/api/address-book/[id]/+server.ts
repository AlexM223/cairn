import { json, requireUser } from '$lib/server/api';
import { deleteSavedAddress } from '$lib/server/addressBook';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** DELETE /api/address-book/:id — remove one saved recipient. */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null || !deleteSavedAddress(user.id, id)) {
		return json({ error: 'Saved address not found' }, { status: 404 });
	}
	return json({ ok: true });
};
