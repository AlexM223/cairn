import { json, readJson, requireUser } from '$lib/server/api';
import { getLabels, setLabel, TX_LABEL_MAX } from '$lib/server/wallets';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Wallet not found' }, { status: 404 });

const TXID_RE = /^[0-9a-fA-F]{64}$/;

/** GET /api/wallets/:id/labels — every tx label for this wallet, keyed by txid. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const labels = getLabels(user.id, id);
	if (labels === null) return notFound();
	return json({ labels });
};

/**
 * PUT /api/wallets/:id/labels — upsert one label: { txid, label }.
 * An empty label clears the existing one. Labels are private to this wallet
 * and stored only on this Cairn instance.
 */
export const PUT: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const body = await readJson<{ txid?: unknown; label?: unknown }>(event);
	if (typeof body.txid !== 'string' || !TXID_RE.test(body.txid)) {
		return json({ error: 'txid must be a 64-character hex string' }, { status: 400 });
	}
	if (typeof body.label !== 'string') {
		return json({ error: 'label must be a string (empty to clear)' }, { status: 400 });
	}
	if (body.label.trim().length > TX_LABEL_MAX) {
		return json({ error: `label must be at most ${TX_LABEL_MAX} characters` }, { status: 400 });
	}

	const result = setLabel(user.id, id, body.txid.toLowerCase(), body.label);
	if (result === null) return notFound();
	return json(result);
};
