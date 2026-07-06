import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getMultisig } from '$lib/server/wallets/multisig';
import {
	getMultisigTransaction,
	multisigTransactionProgress,
	type SavedMultisigTransaction
} from '$lib/server/multisigTransactions';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import type { MultisigSigningProgress } from '$lib/server/bitcoin/multisigPsbt';
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { params, locals, url } = event;
	// The send flow itself is gated; the multisig stays viewable via its own page.
	requireFeature(event, 'send');
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Multisig not found');

	const multisig = getMultisig(locals.user!.id, id);
	if (!multisig) error(404, 'Multisig not found');

	// Fee estimates seed the fee selector; best-effort only.
	let fees: FeeEstimates | null = null;
	try {
		fees = await getChain().getFeeEstimates();
	} catch {
		fees = null;
	}

	// ?tx=N resumes a saved multisig transaction at the step its status implies —
	// including mid-quorum: the progress object says which keys still owe a
	// signature, so the Sign step can pick up exactly where the user left off.
	let resume: {
		transaction: SavedMultisigTransaction;
		summary: PsbtSummary | null;
		progress: MultisigSigningProgress | null;
	} | null = null;
	const txParam = url.searchParams.get('tx');
	if (txParam !== null) {
		const txId = Number(txParam);
		const transaction = Number.isInteger(txId)
			? getMultisigTransaction(locals.user!.id, id, txId)
			: null;
		if (!transaction) error(404, 'Saved transaction not found');
		let summary: PsbtSummary | null = null;
		try {
			summary = summarizePsbt(transaction.psbt);
		} catch {
			summary = null;
		}
		resume = { transaction, summary, progress: multisigTransactionProgress(multisig, transaction) };
	}

	return {
		multisig: {
			id: multisig.id,
			name: multisig.name,
			threshold: multisig.threshold,
			scriptType: multisig.scriptType,
			totalKeys: multisig.keys.length,
			// The signing stepper's roster: stable position order, with the device
			// routing and fingerprint each key signs under. xpub + path are public
			// key material the USB signers (Trezor/Ledger drivers) need to build
			// the multisig request client-side — the same data the registration
			// file download already exposes.
			keys: multisig.keys.map((k) => ({
				id: k.id,
				position: k.position,
				name: k.name,
				category: k.category,
				deviceType: k.deviceType,
				xpub: k.xpub,
				fingerprint: k.fingerprint,
				path: k.path
			}))
		},
		fees,
		resume
	};
};
