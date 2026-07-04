import { error } from '@sveltejs/kit';
import { getWallet, getWalletDetail } from '$lib/server/wallets';
import { getTransaction } from '$lib/server/transactions';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const row = getWallet(locals.user!.id, id);
	if (!row) error(404, 'Wallet not found');

	// Confirmed balance for the Create step; a scan failure disables building
	// (no UTXO set to spend from) but the page still renders with an explanation.
	let confirmed: number | null = null;
	let scanError: string | null = null;
	try {
		const detail = await getWalletDetail(locals.user!.id, id);
		if (!detail) error(404, 'Wallet not found');
		confirmed = detail.scan.confirmed;
	} catch (e) {
		if (e instanceof Error && e.cause === 'unreachable') {
			scanError = e.message;
		} else {
			throw e;
		}
	}

	// Fee estimates seed the fee selector; best-effort only.
	let fees: FeeEstimates | null = null;
	try {
		fees = await getChain().getFeeEstimates();
	} catch {
		fees = null;
	}

	// ?tx=N resumes a saved transaction at the step its status implies.
	let resume: { transaction: ReturnType<typeof getTransaction>; summary: PsbtSummary | null } | null =
		null;
	const txParam = url.searchParams.get('tx');
	if (txParam !== null) {
		const txId = Number(txParam);
		const transaction = Number.isInteger(txId) ? getTransaction(locals.user!.id, id, txId) : null;
		if (!transaction) error(404, 'Saved transaction not found');
		let summary: PsbtSummary | null = null;
		try {
			summary = summarizePsbt(transaction.psbt);
		} catch {
			summary = null;
		}
		resume = { transaction, summary };
	}

	return {
		wallet: {
			id: row.id,
			name: row.name,
			scriptType: row.script_type
		},
		confirmed,
		scanError,
		fees,
		resume
	};
};
