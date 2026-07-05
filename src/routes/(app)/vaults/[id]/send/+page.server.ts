import { error } from '@sveltejs/kit';
import { getVault } from '$lib/server/vaults';
import {
	getVaultTransaction,
	vaultTransactionProgress,
	type SavedVaultTransaction
} from '$lib/server/vaultTransactions';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import type { VaultSigningProgress } from '$lib/server/bitcoin/vaultPsbt';
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Vault not found');

	const vault = getVault(locals.user!.id, id);
	if (!vault) error(404, 'Vault not found');

	// Fee estimates seed the fee selector; best-effort only.
	let fees: FeeEstimates | null = null;
	try {
		fees = await getChain().getFeeEstimates();
	} catch {
		fees = null;
	}

	// ?tx=N resumes a saved vault transaction at the step its status implies —
	// including mid-quorum: the progress object says which keys still owe a
	// signature, so the Sign step can pick up exactly where the user left off.
	let resume: {
		transaction: SavedVaultTransaction;
		summary: PsbtSummary | null;
		progress: VaultSigningProgress | null;
	} | null = null;
	const txParam = url.searchParams.get('tx');
	if (txParam !== null) {
		const txId = Number(txParam);
		const transaction = Number.isInteger(txId)
			? getVaultTransaction(locals.user!.id, id, txId)
			: null;
		if (!transaction) error(404, 'Saved transaction not found');
		let summary: PsbtSummary | null = null;
		try {
			summary = summarizePsbt(transaction.psbt);
		} catch {
			summary = null;
		}
		resume = { transaction, summary, progress: vaultTransactionProgress(vault, transaction) };
	}

	return {
		vault: {
			id: vault.id,
			name: vault.name,
			threshold: vault.threshold,
			scriptType: vault.scriptType,
			totalKeys: vault.keys.length,
			// The signing stepper's roster: stable position order, with the device
			// routing and fingerprint each key signs under.
			keys: vault.keys.map((k) => ({
				id: k.id,
				position: k.position,
				name: k.name,
				category: k.category,
				deviceType: k.deviceType,
				fingerprint: k.fingerprint
			}))
		},
		fees,
		resume
	};
};
