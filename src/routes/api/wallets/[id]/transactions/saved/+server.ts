import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { listTransactions } from '$lib/server/transactions';
import type { RequestHandler } from './$types';

/**
 * GET /api/wallets/:id/transactions/saved
 * Saved (Cairn-authored) transactions — drafts, awaiting-signature, completed.
 * Distinct from GET ../transactions, which is the wallet's on-chain history.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	if (!Number.isInteger(walletId) || walletId <= 0) {
		return json({ error: 'Wallet not found' }, { status: 404 });
	}
	const transactions = listTransactions(user.id, walletId);
	if (transactions === null) return json({ error: 'Wallet not found' }, { status: 404 });
	return json({ transactions });
};
