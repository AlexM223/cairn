import { json, requireUser, readJson } from '$lib/server/api';
import { getWalletDetail, deleteWallet, toWalletSummary, setWalletDevice } from '$lib/server/wallets';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';
import { AuthError } from '$lib/server/auth';

const log = childLogger('wallet');

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Wallet not found' }, { status: 404 });

/** GET /api/wallets/:id — wallet summary plus full scan (addresses, txs, balances). */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	try {
		const detail = await getWalletDetail(user.id, id);
		if (!detail) return notFound();
		return json({
			wallet: toWalletSummary(detail.wallet, detail.scan),
			addresses: detail.scan.addresses,
			txs: detail.scan.txs,
			confirmed: detail.scan.confirmed,
			unconfirmed: detail.scan.unconfirmed
		});
	} catch (e) {
		log.error({ err: e, walletId: Number(event.params.id) }, 'wallet scan failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Wallet scan failed' },
			{ status: 502 }
		);
	}
};

/**
 * PATCH /api/wallets/:id { deviceType } — record which signing device holds
 * this wallet's key (used when associating a device on first send). An empty
 * or unrecognized value clears it back to the file-based fallback.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const body = await readJson<{ deviceType?: unknown }>(event);
	const wallet = setWalletDevice(user.id, id, body.deviceType);
	if (!wallet) return notFound();
	return json({ wallet });
};

/** DELETE /api/wallets/:id */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();
	try {
		if (!deleteWallet(user.id, id)) return notFound();
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 409 });
		throw e;
	}
	return json({ ok: true });
};
