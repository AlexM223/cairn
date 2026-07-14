import { json, readJson, requireUser } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import {
	getAddressLabels,
	setAddressLabel,
	ADDRESS_LABEL_MAX
} from '$lib/server/addressLabels';
import { TextInputError } from '$lib/server/textGuard';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Wallet not found' }, { status: 404 });

/** GET /api/wallets/:id/address-labels — every address label for this wallet. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();
	if (!getWallet(user.id, id)) return notFound();
	return json({ labels: getAddressLabels(user.id, 'wallet', id) });
};

/**
 * PUT /api/wallets/:id/address-labels — upsert one label: { address, label }.
 * An empty label clears it. Private to this wallet, stored only on this instance.
 */
export const PUT: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();
	if (!getWallet(user.id, id)) return notFound();

	const body = await readJson<{ address?: unknown; label?: unknown }>(event);
	if (typeof body.address !== 'string' || body.address.trim().length === 0) {
		return json({ error: 'address is required' }, { status: 400 });
	}
	if (typeof body.label !== 'string') {
		return json({ error: 'label must be a string (empty to clear)' }, { status: 400 });
	}
	if (body.label.trim().length > ADDRESS_LABEL_MAX) {
		return json({ error: `label must be at most ${ADDRESS_LABEL_MAX} characters` }, { status: 400 });
	}

	try {
		return json(setAddressLabel(user.id, 'wallet', id, body.address.trim(), body.label));
	} catch (e) {
		if (e instanceof TextInputError) return json({ error: e.message }, { status: 400 });
		throw e;
	}
};
