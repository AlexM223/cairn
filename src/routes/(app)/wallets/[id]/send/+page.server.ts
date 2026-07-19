import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getWallet, getWalletDetail } from '$lib/server/wallets';
import { listSavedAddresses } from '$lib/server/addressBook';
import {
	getTransaction,
	getWalletUtxos,
	ownBroadcastTxids,
	sentRecipientAddresses
} from '$lib/server/transactions';
import type { UnconfirmedTrust, CoinbaseStatus } from '$lib/server/bitcoin/psbt';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import { getReferralBuyUrls } from '$lib/server/referrals';
import { getChain } from '$lib/server/chain';
import { getChainConfig } from '$lib/server/settings';
import { sendSnapshot } from '$lib/server/walletSync';
import { coinbaseMaturity } from '$lib/shared/coinbase';
import type { FeeEstimates } from '$lib/types';
import type { PageServerLoad } from './$types';

export interface SendLiveData {
	/**
	 * Truly-spendable confirmed balance — immature coinbase value already
	 * excluded (cairn-oae1.3: Electrum's raw confirmed balance counts it, but
	 * the build engine refuses to spend it, so the eyebrow and max-amount
	 * validation must agree with what a build will actually accept). Null when
	 * the scan couldn't reach the node.
	 */
	confirmed: number | null;
	/**
	 * Sum of immature-coinbase value folded OUT of `confirmed` above — the
	 * "still maturing" figure the page can surface alongside it. 0 when the
	 * wallet holds no immature coinbase (or the scan failed).
	 */
	maturingTotal: number;
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

/** The lean spendable-coin shape both the live scan (getWalletUtxos → SpendableUtxo)
 *  and the clean-wallet snapshot (walletSync SnapshotUtxo) satisfy — the only
 *  fields _assembleSendLiveData reads. */
type RawSendUtxo = {
	txid: string;
	vout: number;
	value: number;
	height: number;
	coinbase?: CoinbaseStatus;
};

/**
 * Assemble the SendLiveData payload from raw coins + balance + tip + fees. The
 * SINGLE source of truth shared by both the live-scan and the clean-snapshot fast
 * path (cairn-g1u2), so the two are byte-for-byte identical for the same state —
 * the coin-control list, the own-change/received badging, the confirmed-first
 * sort, and the immature-coinbase subtraction (cairn-oae1.3) are computed here and
 * nowhere else. Exported for the parity test. Pure; no IO.
 */
export function _assembleSendLiveData(args: {
	/** Raw confirmed balance from the scan, or null when the scan was unreachable. */
	confirmed: number | null;
	rawUtxos: RawSendUtxo[];
	tipHeight: number;
	fees: FeeEstimates | null;
	/** Txids this wallet broadcast itself — the own-change vs received signal. */
	ownTxids: Set<string>;
	scanError: string | null;
}): SendLiveData {
	// Include UNCONFIRMED coins too (cairn-u9ob.1/.7): the builder can spend our own
	// unconfirmed change automatically and received unconfirmed coins when explicitly
	// selected. Tag each own-change (neutral) vs received (risky) exactly as
	// classifyUnconfirmedTrust does, so coin control badges them identically whether
	// this came from a live scan or the snapshot.
	const utxos = args.rawUtxos
		.map((u) => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			height: u.height,
			coinbase: u.coinbase === true,
			unconfirmedTrust: (u.height > 0
				? null
				: args.ownTxids.has(u.txid.toLowerCase())
					? 'own-change'
					: 'received') as UnconfirmedTrust | null
		}))
		// Confirmed coins first (largest value), then unconfirmed (largest value).
		.sort((a, b) => {
			const ca = a.height > 0 ? 1 : 0;
			const cb = b.height > 0 ? 1 : 0;
			if (ca !== cb) return cb - ca;
			return b.value - a.value;
		});

	// cairn-oae1.3: fold immature-coinbase value out of `confirmed` so the
	// eyebrow/max-amount validation never advertises sats the build engine will
	// refuse to spend (psbt.ts's selectSpendCandidates already excludes them).
	let maturingTotal = 0;
	let confirmed = args.confirmed;
	if (confirmed !== null) {
		for (const u of utxos) {
			if (u.coinbase && u.height > 0 && !coinbaseMaturity(u.height, args.tipHeight).mature) {
				maturingTotal += u.value;
			}
		}
		confirmed -= maturingTotal;
	}

	return {
		confirmed,
		maturingTotal,
		scanError: args.scanError,
		utxos,
		fees: args.fees,
		tipHeight: args.tipHeight
	};
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
	const ownTxids = ownBroadcastTxids(id);

	// Fast path (cairn-g1u2): a PROVABLY-clean wallet serves its coins + balance
	// from the snapshot the background sync already maintains — no live re-scan,
	// which is the dominant per-send-GET cost that collapsed mixed load at tier
	// 200. sendSnapshot returns non-null ONLY when the wallet is watched, clean,
	// within MAX_CLEAN_TTL, and has a persisted spendable set; on ANY doubt it
	// returns null and we fall through to the live scan below. The build/broadcast
	// path re-scans live regardless, so this only affects the DISPLAYED list.
	const cached = sendSnapshot('wallet', id);
	if (cached) {
		// Fees stay live (30s-cached in the chain layer, cheap, and genuinely
		// time-varying — not wallet state). Tip comes from the snapshot; the client
		// keeps it fresh via onNewBlock.
		let fees: FeeEstimates | null = null;
		try {
			fees = await getChain().getFeeEstimates();
		} catch {
			fees = null;
		}
		return _assembleSendLiveData({
			confirmed: cached.confirmed,
			rawUtxos: cached.utxos,
			tipHeight: cached.tipHeight,
			fees,
			ownTxids,
			scanError: null
		});
	}

	// Live path (behavior unchanged): re-scan for fresh UTXOs. Confirmed balance
	// for the Create step; a scan failure disables building (no UTXO set to spend
	// from) but the page still renders with an explanation. The spendable-coin list
	// feeds the manual coin-control picker — the same listUnspent lookups the build
	// endpoint runs, so what the user picks from is what the server selects from.
	let confirmed: number | null = null;
	let scanError: string | null = null;
	let rawUtxos: RawSendUtxo[] = [];
	try {
		const detail = await getWalletDetail(userId, id);
		// The wallet existence was already validated synchronously in load(); a null
		// detail here is a scan inconsistency, degraded to an empty spendable set
		// rather than a stream rejection (the shell has already rendered).
		if (detail) {
			confirmed = detail.scan.confirmed;
			rawUtxos = await getWalletUtxos(xpub);
		}
	} catch (e) {
		if (e instanceof Error && e.cause === 'unreachable') {
			scanError = e.message;
		} else if (scanError === null && confirmed !== null) {
			// The scan worked but the UTXO listing failed — coin control simply isn't
			// offered this load; the default (automatic) flow is unaffected.
			rawUtxos = [];
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
	// coinbase coins read as immature until the first live block arrives (safe: the
	// server construction guard rejects immature coinbase regardless).
	let tipHeight = 0;
	try {
		tipHeight = (await getChain().getTip()).height;
	} catch {
		tipHeight = 0;
	}

	return _assembleSendLiveData({ confirmed, rawUtxos, tipHeight, fees, ownTxids, scanError });
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
		// This instance's configured Bitcoin network (cairn-xqnn7) — cheap,
		// synchronous, no Electrum round-trip. The client's recipient-address
		// shape check (addressShape.ts) needs this to accept the RIGHT
		// network's addresses: it used to hardcode "mainnet-shaped only", which
		// rejected legitimate bcrt1/tb1 destinations on a regtest/testnet
		// instance and disabled Review for a perfectly valid send.
		network: getChainConfig().network,
		resume,
		// The user's address book seeds the recipient autocomplete. User-scoped,
		// small, and cheap to load alongside the page. Gated on the address_book
		// flag (cairn-de7e): GET /api/address-book already 403s when it's off,
		// but this load() handed the saved list to the client regardless, so the
		// RecipientCombobox kept showing autocomplete even with the flag off.
		// Withholding the data here (rather than only hiding it client-side)
		// means the off state can't leak via a devtools/API-adjacent read of the
		// page data either.
		savedAddresses: locals.flags?.address_book === false ? [] : listSavedAddresses(locals.user!.id),
		// R2 (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md): addresses this wallet has
		// already broadcast a completed send to — half of the "known address"
		// signal for the review step's stake-triggered verification micro-step
		// (the other half is savedAddresses above). Cheap synchronous SQLite read,
		// not gated on any flag — it's a first-send SAFETY signal, unrelated to the
		// address_book convenience feature.
		sentAddresses: sentRecipientAddresses(locals.user!.id, id),
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
