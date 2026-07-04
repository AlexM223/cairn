import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { listTransactions } from '$lib/server/transactions';
import type { RequestHandler } from './$types';

/** List saved transactions (drafts, awaiting-signature, completed) for a wallet. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const transactions = listTransactions(user.id, walletId);
	if (transactions === null) return json({ error: 'Wallet not found' }, { status: 404 });
	return json({ transactions });
};
