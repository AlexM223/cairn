import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { listVaultTransactions } from '$lib/server/vaultTransactions';
import type { RequestHandler } from './$types';

/** List a vault's saved transactions, newest first. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const vaultId = Number(event.params.id);
	if (!Number.isInteger(vaultId)) return json({ error: 'Bad vault id' }, { status: 400 });

	const transactions = listVaultTransactions(user.id, vaultId);
	if (transactions === null) return json({ error: 'Vault not found' }, { status: 404 });
	return json({ transactions });
};
