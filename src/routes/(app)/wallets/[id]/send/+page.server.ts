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
import { getChain } from '$lib/server/chain';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { params, locals, url } = event;
	// The send flow itself is gated; the wallet stays viewable via its own page.
	requireFeature(event, 'send');
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const row = getWallet(locals.user!.id, id);
	if (!row) error(404, 'Wallet not found');

	// Confirmed balance for the Create step; a scan failure disables building
	// (no UTXO set to spend from) but the page still renders with an explanation.
	// The spendable-coin list feeds the manual coin-control picker — it comes
	// from the same (60s-cached) wallet scan the balance does, plus the same
	// listUnspent lookups the build endpoint will run, so what the user picks
	// from is exactly what the server will select from.
	let confirmed: number | null = null;
	let scanError: string | null = null;
	let utxos: {
		txid: string;
		vout: number;
		value: number;
		height: number;
		coinbase: boolean;
		unconfirmedTrust: UnconfirmedTrust | null;
	}[] = [];
	try {
		const detail = await getWalletDetail(locals.user!.id, id);
		if (!detail) error(404, 'Wallet not found');
		confirmed = detail.scan.confirmed;
		// Include UNCONFIRMED coins too (cairn-u9ob.1/.7): the builder can spend our
		// own unconfirmed change automatically and received unconfirmed coins when
		// explicitly selected. classifyUnconfirmedTrust tags each so coin control can
		// badge own-change (neutral) vs received (risky). height + coinbase ride along
		// so coin control can maturity-check mining rewards live against the block tip.
		utxos = classifyUnconfirmedTrust(await getWalletUtxos(row.xpub), ownBroadcastTxids(id))
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
			scriptType: row.script_type,
			deviceType: row.device_type ?? null
		},
		confirmed,
		scanError,
		fees,
		resume,
		// Spendable coins for the optional coin-control picker — confirmed first,
		// then unconfirmed (each tagged own-change vs received for badging).
		// Empty when the scan failed or the wallet is empty.
		utxos,
		// Current block tip — coin control maturity-checks coinbase coins against
		// it, and the send page keeps it live via onNewBlock.
		tipHeight,
		// The user's address book seeds the recipient autocomplete. User-scoped,
		// small, and cheap to load alongside the page.
		savedAddresses: listSavedAddresses(locals.user!.id)
	};
};
