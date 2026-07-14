import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getSignableMultisig } from '$lib/server/wallets/multisig';
import {
	getMultisigTransaction,
	multisigTransactionProgress,
	ownMultisigTxids,
	type SavedMultisigTransaction
} from '$lib/server/multisigTransactions';
import { getRoster, type RosterMember } from '$lib/server/multisigRoster';
import { getMultisigUtxos } from '$lib/server/multisigScan';
import { classifyUnconfirmedTrust } from '$lib/server/transactions';
import { summarizePsbt, type PsbtSummary, type UnconfirmedTrust } from '$lib/server/bitcoin/psbt';
import type { MultisigSigningProgress } from '$lib/server/bitcoin/multisigPsbt';
import { getReferralBuyUrls } from '$lib/server/referrals';
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

/** One spendable coin for the optional manual coin-control picker. */
type SendUtxo = {
	txid: string;
	vout: number;
	value: number;
	height: number;
	coinbase: boolean;
	unconfirmedTrust: UnconfirmedTrust | null;
};

/** The Electrum/Core RPC-dependent slice of this page: fee estimates, spendable
 *  coins, and the block tip. Streamed (not awaited) so navigation paints the
 *  send shell — and any resumed step — instantly while these round-trips settle
 *  in the background (cairn-vknb.4). Never rejects: every hop degrades to its
 *  empty/zero fallback on failure, exactly as the pre-streaming inline
 *  try/catch blocks did, so a scan failure just means coin control isn't offered
 *  and the fee selector falls back to a custom rate — never a 500. */
async function loadSendChain(
	multisig: NonNullable<ReturnType<typeof getSignableMultisig>>,
	id: number
): Promise<{ fees: FeeEstimates | null; utxos: SendUtxo[]; tipHeight: number }> {
	const chain = getChain();
	const [fees, utxos, tipHeight] = await Promise.all([
		// Fee estimates seed the fee selector; best-effort only.
		chain.getFeeEstimates().catch(() => null),
		// Spendable coins for the optional manual coin-control picker — confirmed
		// first, then unconfirmed (each tagged own-change vs received) — the same
		// UTXO set the /psbt build endpoint selects from, so what a user picks is
		// exactly what the server spends (cairn-zcui). Best-effort: a scan failure
		// just means coin control isn't offered this load; the default automatic
		// flow is unaffected.
		(async (): Promise<SendUtxo[]> => {
			try {
				// Include unconfirmed coins too (cairn-u9ob.6/.7), each classified
				// own-change vs received so coin control can badge them — confirmed
				// coins auto-select, received unconfirmed only when explicitly picked.
				return classifyUnconfirmedTrust(await getMultisigUtxos(multisig), ownMultisigTxids(id))
					.map((u) => ({
						txid: u.txid,
						vout: u.vout,
						value: u.value,
						height: u.height,
						coinbase: u.coinbase === true,
						unconfirmedTrust: u.height > 0 ? null : u.unconfirmedTrust ?? 'received'
					}))
					.sort((a, b) => {
						const ca = a.height > 0 ? 1 : 0;
						const cb = b.height > 0 ? 1 : 0;
						if (ca !== cb) return cb - ca;
						return b.value - a.value;
					});
			} catch {
				return [];
			}
		})(),
		// Block tip seeds coin control's coinbase-maturity check; the page keeps it live.
		chain
			.getTip()
			.then((t) => t.height)
			.catch(() => 0)
	]);
	return { fees, utxos, tipHeight };
}

export const load: PageServerLoad = async (event) => {
	const { params, locals, url, depends } = event;
	// The send flow itself is gated; the multisig stays viewable via its own page.
	requireFeature(event, 'send');
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Multisig not found');

	// New-block SSE events invalidate this tag only — refreshing the streamed
	// fee/tip snapshot without a manual reload and without retriggering anything
	// else on the page (mirrors depends('cairn:chain') on the dashboard).
	depends(`cairn:multisig-send:${id}`);

	// The sign flow is cosigner-reachable: owner or a role='cosigner' share. A
	// pure viewer (or non-participant) gets the uniform 404. Full key material
	// (xpub + path for every key) is intentionally unredacted here — the signing
	// stepper builds the multisig request client-side and a cosigner must hold
	// the whole quorum's config to produce a valid signature.
	const multisig = getSignableMultisig(locals.user!.id, id);
	if (!multisig) error(404, 'Multisig not found');

	// ?tx=N resumes a saved multisig transaction at the step its status implies —
	// including mid-quorum: the progress object says which keys still owe a
	// signature, so the Sign step can pick up exactly where the user left off.
	let resume: {
		transaction: SavedMultisigTransaction;
		summary: PsbtSummary | null;
		progress: MultisigSigningProgress | null;
		/** Per-PERSON signing roster (display name + signed state), for shared
		 *  wallets only — the collaborative-custody "who has signed" view. Null for
		 *  a solo wallet, where the per-key chips already say everything. */
		roster: RosterMember[] | null;
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
			// Threshold-aware (qa-findings-R3.md ~line 228): keep summary.complete
			// in agreement with the quorum-aware `progress` object computed right
			// below from the same PSBT.
			summary = summarizePsbt(transaction.psbt, multisig.threshold);
		} catch {
			summary = null;
		}
		const progress = multisigTransactionProgress(multisig, transaction);
		// Reconcile the frozen roster against the real PSBT and surface it only when
		// the wallet is actually shared (more than the owner) — otherwise the
		// person-view is just the owner and adds nothing over the key chips.
		let roster: RosterMember[] | null = null;
		try {
			const members = getRoster(multisig, transaction, progress);
			roster = members.length > 1 ? members : null;
		} catch {
			roster = null;
		}
		resume = { transaction, summary, progress, roster };
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
		// Streamed, not awaited (SvelteKit 2 leaves top-level promises alone):
		// fee estimates, spendable coins (for the optional coin-control picker),
		// and the block tip stream in behind the shell so the send page — and any
		// resumed step below — paints instantly instead of blocking on Electrum
		// (cairn-vknb.4). loadSendChain never rejects; each field degrades to its
		// empty/zero fallback on a scan failure.
		chain: loadSendChain(multisig, id),
		// The ?tx=N resume payload is pure local work (SQLite read + in-process
		// PSBT parse + roster reconcile — no Electrum), so it stays synchronous:
		// the resumed step renders the instant the shell paints, with fees/utxos/
		// tip filling in behind it.
		resume,
		// Buy-a-device links for the signer cards' unavailable states; null when
		// the referral_links flag is off (the cards then render no referral UI).
		referralBuyUrls: getReferralBuyUrls(locals.flags)
	};
};
