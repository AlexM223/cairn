import { json, readJson, requireUser } from '$lib/server/api';
import { listSavedAddresses, saveAddress, AddressBookError } from '$lib/server/addressBook';
import type { RequestHandler } from './$types';

/** GET /api/address-book — every saved recipient for the signed-in user. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	return json({ addresses: listSavedAddresses(user.id) });
};

/**
 * POST /api/address-book — save a recipient: { address, label }.
 * Saving an address that's already in the book bumps its last_used_at (and
 * renames it when a label is sent); omit `label` for a pure touch.
 * 201 when created, 200 when an existing entry was updated.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ address?: unknown; label?: unknown }>(event);
	try {
		const { entry, created } = saveAddress(user.id, body);
		return json({ address: entry, created }, { status: created ? 201 : 200 });
	} catch (e) {
		if (e instanceof AddressBookError) {
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		throw e;
	}
};
