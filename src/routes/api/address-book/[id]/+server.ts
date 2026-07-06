import { json, requireFeature } from '$lib/server/api';
import { deleteSavedAddress } from '$lib/server/addressBook';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** DELETE /api/address-book/:id — remove one saved recipient. */
export const DELETE: RequestHandler = async (event) => {
	// Gate: the address book requires the address_book feature.
	const user = requireFeature(event, 'address_book');
	const id = parseId(event.params.id);
	if (id === null || !deleteSavedAddress(user.id, id)) {
		return json({ error: 'Saved address not found' }, { status: 404 });
	}
	return json({ ok: true });
};
