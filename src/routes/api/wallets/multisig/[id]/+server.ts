import { json, requireUser } from '$lib/server/api';
import { getMultisig, deleteMultisig } from '$lib/server/wallets/multisig';
import { getMultisigDetail, invalidateMultisigCache, toMultisigSummary } from '$lib/server/multisigScan';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Multisig not found' }, { status: 404 });

/** GET /api/wallets/multisig/:id — multisig config plus full scan (balance, UTXOs, addresses, history). */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const multisig = getMultisig(user.id, id);
	if (!multisig) return notFound();

	try {
		const detail = await getMultisigDetail(multisig);
		return json({
			multisig: toMultisigSummary(multisig),
			threshold: multisig.threshold,
			keys: multisig.keys,
			...detail
		});
	} catch (e) {
		log.error({ err: e, multisigId: Number(event.params.id) }, 'wallet scan failed');
		return json({ error: e instanceof Error ? e.message : 'Multisig scan failed' }, { status: 502 });
	}
};

/** DELETE /api/wallets/multisig/:id */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const multisig = getMultisig(user.id, id);
	if (!multisig || !deleteMultisig(user.id, id)) return notFound();
	invalidateMultisigCache(multisig);
	return json({ ok: true });
};
