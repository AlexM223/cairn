import { json, requireUser } from '$lib/server/api';
import { getWalletDetail, deleteWallet, toWalletSummary } from '$lib/server/wallets';
import type { RequestHandler } from './$types';

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
		return json(
			{ error: e instanceof Error ? e.message : 'Wallet scan failed' },
			{ status: 502 }
		);
	}
};

/** DELETE /api/wallets/:id */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null || !deleteWallet(user.id, id)) return notFound();
	return json({ ok: true });
};
