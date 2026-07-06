import { json, readJson, requireUser } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import {
	getAddressLabels,
	setAddressLabel,
	ADDRESS_LABEL_MAX
} from '$lib/server/addressLabels';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Multisig not found' }, { status: 404 });

/** GET /api/wallets/multisig/:id/address-labels — every address label for this vault. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();
	// Any participant (owner, cosigner, viewer) can read the shared annotations.
	if (!getViewableMultisig(user.id, id)) return notFound();
	return json({ labels: getAddressLabels('multisig', id) });
};

/**
 * PUT /api/wallets/multisig/:id/address-labels — upsert one label: { address, label }.
 * Shared across the vault's participants (collaborative custody); private to the
 * instance. An empty label clears it.
 */
export const PUT: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();
	if (!getViewableMultisig(user.id, id)) return notFound();

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

	return json(setAddressLabel('multisig', id, body.address.trim(), body.label));
};
