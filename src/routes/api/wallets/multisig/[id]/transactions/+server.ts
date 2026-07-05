import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { listMultisigTransactions } from '$lib/server/multisigTransactions';
import type { RequestHandler } from './$types';

/** List a multisig's saved transactions, newest first. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const multisigId = Number(event.params.id);
	if (!Number.isInteger(multisigId)) return json({ error: 'Bad multisig id' }, { status: 400 });

	const transactions = listMultisigTransactions(user.id, multisigId);
	if (transactions === null) return json({ error: 'Multisig not found' }, { status: 404 });
	return json({ transactions });
};
