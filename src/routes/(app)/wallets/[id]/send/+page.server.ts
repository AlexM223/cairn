import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getWallet, getWalletDetail } from '$lib/server/wallets';
import { listSavedAddresses } from '$lib/server/addressBook';
import {
	getTransaction,
	getWalletUtxos,
	ownBroadcastTxids,
	classifyUnconfirmedTrust
} from '$lib/server/transactions';
import type { UnconfirmedTrust } from '$lib/server/bitcoin/psbt';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import { getReferralBuyUrls } from '$lib/server/referrals';
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export interface SendLiveData {
	/** Confirmed spendable balance; null when the scan couldn't reach the node. */
	confirmed: number | null;
	/** Human-readable reason the scan was unreachable, or null on success. */
	scanError: string | null;
	/**
	 * Spendable coins for the optional coin-control picker — confirmed first,
	 * then unconfirmed (each tagged own-change vs received for badging).
	 * Empty when the scan failed or the wallet is empty.
	 */
	utxos: {
		txid: string;
		vout: number;
		value: number;
		height: number;
		coinbase: boolean;
		unconfirmedTrust: UnconfirmedTrust | null;
	}[];
	/** Live fee estimates seeding the fee selector; null when unavailable. */
	fees: FeeEstimates | null;
	/** Current block tip — coin control maturity-checks coinbase coins against it. */
	tipHeight: number;
}

/**
 * The Electrum/Core RPC-dependent half of the send load. Returned UNAWAITED from
 * load() so SvelteKit streams it in: the page shell (name, saved recipients, the
 * ?tx= resume step) paints instantly while this resolves in the background. Every
 * network hop degrades gracefully to a zero/empty value — the page never 500s on
 * an unreachable node, and a rejection of this promise is handled the same way on
 * the client (a "couldn't reach your node" state, never a broken page).
 */
async function loadSendLiveData(userId: number, id: number, xpub: string): Promise<SendLiveData> {
	// Confirmed balance for the Create step; a scan failure disables building
	// (no UTXO set to spend from) but the page still renders with an explanation.
	// The spendable-coin list feeds the manual coin-control picker — it comes
	// from the same (60s-cached) wallet scan the balance does, plus the same
	// listUnspent lookups the build endpoint will run, so what the user picks
	// from is exactly what the server will select from.
	let confirmed: number | null = null;
	let scanError: string | null = null;
	let utxos: SendLiveData['utxos'] = [];
	try {
		const detail = await getWalletDetail(userId, id);
		// The wallet existence was already validated synchronously in load(); a
		// null detail here is a scan inconsistency, degraded to an empty spendable
		// set rather than a stream rejection (the shell has already rendered).
		if (detail) {
			confirmed = detail.scan.confirmed;
			// Include UNCONFIRMED coins too (cairn-u9ob.1/.7): the builder can spend our
			// own unconfirmed change automatically and received unconfirmed coins when
			// explicitly selected. classifyUnconfirmedTrust tags each so coin control can
			// badge own-change (neutral) vs received (risky). height + coinbase ride along
			// so coin control can maturity-check mining rewards live against the block tip.
			utxos = classifyUnconfirmedTrust(await getWalletUtxos(xpub), ownBroadcastTxids(id))
				.map((u) => ({
					txid: u.txid,
					vout: u.vout,
					value: u.value,
					height: u.height,
					coinbase: u.coinbase === true,
					unconfirmedTrust: u.height > 0 ? null : u.unconfirmedTrust ?? 'received'
				}))
				// Confirmed coins first (largest value), then unconfirmed (largest value).
				.sort((a, b) => {
					const ca = a.height > 0 ? 1 : 0;
					const cb = b.height > 0 ? 1 : 0;
					if (ca !== cb) return cb - ca;
					return b.value - a.value;
				});
		}
	} catch (e) {
		if (e instanceof Error && e.cause === 'unreachable') {
			scanError = e.message;
		} else if (scanError === null && confirmed !== null) {
			// The scan worked but the UTXO listing failed — coin control simply
			// isn't offered this load; the default (automatic) flow is unaffected.
			utxos = [];
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

	// Block tip seeds coin control's coinbase-maturity check. The client keeps it
	// fresh live via onNewBlock; a failed lookup falls back to 0, which just means
	// coinbase coins read as immature until the first live block arrives (safe:
	// the server construction guard rejects immature coinbase regardless).
	let tipHeight = 0;
	try {
		tipHeight = (await getChain().getTip()).height;
	} catch {
		tipHeight = 0;
	}

	return { confirmed, scanError, utxos, fees, tipHeight };
}

export const load: PageServerLoad = async (event) => {
	const { params, locals, url, depends } = event;
	// The send flow itself is gated; the wallet stays viewable via its own page.
	requireFeature(event, 'send');
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const row = getWallet(locals.user!.id, id);
	if (!row) error(404, 'Wallet not found');

	// New-block SSE events invalidate this tag → the streamed fee estimates and
	// tip refresh without a poll (the client wires onNewBlock in onMount).
	depends(`cairn:send:${id}`);

	// ?tx=N resumes a saved transaction at the step its status implies. This is a
	// SQLite read + pure in-process PSBT parse — NO Electrum calls — so it stays
	// synchronous/unstreamed and the resumed step renders instantly, with the
	// network-dependent fields (utxos/fees/tip) streaming in behind it.
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
			scriptType: row.script_type,
			deviceType: row.device_type ?? null
		},
		resume,
		// The user's address book seeds the recipient autocomplete. User-scoped,
		// small, and cheap to load alongside the page.
		savedAddresses: listSavedAddresses(locals.user!.id),
		// Buy-a-device links for the signer cards' unavailable states; null when
		// the referral_links flag is off (the cards then render no referral UI).
		referralBuyUrls: getReferralBuyUrls(locals.flags),
		// Streamed, not awaited (SvelteKit 2 leaves top-level promises alone): the
		// page paints immediately from the cheap fields above while the Electrum
		// round-trips (scan → UTXOs → fee estimates → tip) resolve in the
		// background. loadSendLiveData degrades every hop to a safe empty/zero
		// value; the client also catches a rejection into the same graceful state.
		live: loadSendLiveData(locals.user!.id, id, row.xpub)
	};
};
