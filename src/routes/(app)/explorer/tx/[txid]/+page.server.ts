import { error, redirect } from '@sveltejs/kit';
import { getChain } from '$lib/server/chain';
import { coreRpcConfigured } from '$lib/server/settings';
import { isNotFoundError, chainErrorMessage } from '$lib/server/search';
import { readTxSnapshot, writeTxSnapshot, refreshTxSnapshot } from '$lib/server/txSnapshot';
import { txOwnership } from '../../ownership.server';
import type { PageServerLoad } from './$types';
import type { CpfpInfo, FeeEstimates, RbfInfo, TxDetail } from '$lib/types';

// Raw hex beyond this is a novelty payload (huge inscriptions etc.) — don't
// ship hundreds of KB to the client just for a curiosity viewer.
const RAW_HEX_LIMIT = 400_000;

// First-ever view of a txid must fetch (nothing cached to show), but a slow /
// unreachable Electrum-esplora backend must not hang the request indefinitely.
// Cap the blocking fetch; on timeout the page renders a "looking this up" shell
// and the client polls until the (still in-flight, self-persisting) fetch lands.
const TX_FETCH_TIMEOUT_MS = 4_000;
const TX_TIMEOUT = Symbol('tx-fetch-timeout');

/** Resolve `p`, or the TX_TIMEOUT sentinel if it hasn't settled within `ms`.
 *  Rejections from `p` propagate (so the not-found / 502 handling still fires). */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TX_TIMEOUT> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<typeof TX_TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(TX_TIMEOUT), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		clearTimeout(timer!);
	}
}

interface TxDetails {
	fees: FeeEstimates | null;
	rbf: RbfInfo | null;
	cpfp: CpfpInfo | null;
	rawHex: string | null;
	rawTooLarge: boolean;
}

/** The fee-outlook estimate, RBF timeline, CPFP package context, and raw hex are
 *  each EXTRA Electrum/esplora round-trips (cairn-2zxt.3) — the RBF-index lookup
 *  and raw-hex fetch can be slow. They're streamed so the decoded transaction
 *  paints immediately and these supplementary details fill in after. Never
 *  rejects: every sub-call already degrades to null. */
async function loadTxDetails(tx: TxDetail, isCoinbase: boolean): Promise<TxDetails> {
	const chain = getChain();

	// For mempool transactions, current fee tiers let the page estimate when
	// this fee rate is likely to confirm.
	const feesPromise: Promise<FeeEstimates | null> =
		!tx.confirmed && tx.feeRate !== null
			? chain.getFeeEstimates().catch(() => null)
			: Promise.resolve(null);

	// Replace-by-fee history. Coinbase txs can't be replaced; failures and
	// backends without an RBF index degrade to "no timeline".
	const rbfPromise: Promise<RbfInfo | null> = isCoinbase
		? Promise.resolve(null)
		: chain.getTxRbfInfo(tx.txid).catch(() => null);

	// CPFP package context only matters while the tx sits in the mempool.
	const cpfpPromise: Promise<CpfpInfo | null> = tx.confirmed
		? Promise.resolve(null)
		: chain.getCpfpInfo(tx.txid).catch(() => null);

	const rawHexPromise: Promise<string | null> = chain.getTxHex(tx.txid).catch(() => null);

	const [fees, rbf, cpfp, fetchedHex] = await Promise.all([
		feesPromise,
		rbfPromise,
		cpfpPromise,
		rawHexPromise
	]);

	const rawTooLarge = fetchedHex !== null && fetchedHex.length > RAW_HEX_LIMIT;
	const rawHex = rawTooLarge ? null : fetchedHex;
	return { fees, rbf, cpfp, rawHex, rawTooLarge };
}

export const load: PageServerLoad = async ({ params, url, depends, locals }) => {
	const txid = params.txid.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) error(404, 'Transaction not found');

	// The "looking this up" shell polls by re-invalidating this dependency (see
	// +page.svelte) until the first fetch lands and this load can serve real data.
	depends('cairn:tx');

	// Full tx detail comes from the operator's own Bitcoin Core node; when it isn't
	// configured the page renders the honest CoreRpcRequiredNotice instead of a bare
	// 502/not-found (cairn-zoz8.11). Threaded onto every return via `base`.
	const base = { coreRpcConfigured: coreRpcConfigured(), isAdmin: locals?.user?.isAdmin ?? false };

	// Explains the hop when the visitor arrived via a replaced-tx redirect.
	const replacedFromRaw = url.searchParams.get('replaced');
	const replacedFrom =
		replacedFromRaw && /^[0-9a-f]{64}$/.test(replacedFromRaw) ? replacedFromRaw : null;

	const chain = getChain();

	// HYBRID CACHE (single-sig-full-wallet). getTx drives a routing decision — a
	// not-found tx either 302-redirects to its RBF replacement or renders an
	// in-page 404 — so it can't be pure stale-while-revalidate; but it needn't
	// always be a LIVE fetch either. A cached decoded tx renders (and decides "no
	// redirect", since a found tx is never a replacement dead-end) instantly, with
	// a fire-and-forget refresh keeping the row current. Safe because a tx's
	// replacement/confirmation status only moves forward: a stale "found" row is
	// at worst out of date, and the LIVE streamed RBF lookup below still surfaces
	// any replacement — a cache hit can never produce a WRONG redirect.
	const cached = readTxSnapshot(txid);
	if (cached) {
		// Background refresh (throttled + single-flight); the page shows cached data
		// now and the fresh row is picked up on the next visit / invalidate.
		void refreshTxSnapshot(txid);
		const tx = cached.tx;
		const isCoinbase = tx.vin.some((v) => v.coinbase);
		return {
			...base,
			notFound: false as const,
			loading: false as const,
			txid,
			tx,
			replacedFrom,
			// "This transaction involves your wallet" badges — synchronous, chain-free,
			// viewer-scoped local lookup (ownership.server.ts). null when none of the
			// viewing user's wallets touch this tx.
			ownership: txOwnership(locals?.user?.id, tx),
			// Streamed, not awaited (cairn-2zxt.3): supplementary display data only.
			details: loadTxDetails(tx, isCoinbase)
		};
	}

	// CACHE MISS: nothing to show, so we must fetch — but under a timeout so a
	// slow/unreachable backend renders a shell instead of hanging the request.
	const txPromise = chain.getTx(txid);
	let raced: TxDetail | typeof TX_TIMEOUT;
	try {
		raced = await raceTimeout(txPromise, TX_FETCH_TIMEOUT_MS);
	} catch (e) {
		// getTx itself rejected (before the timeout).
		if (isNotFoundError(e)) {
			// Replaced transactions are evicted from the backend, so their pages
			// 404 — but the RBF index may still know what superseded them. Send
			// the visitor to the live version instead of a dead end. This lookup
			// is part of the routing decision, so it stays synchronous too.
			const rbf = await chain.getTxRbfInfo(txid).catch(() => null);
			const newest = rbf?.chain[rbf.chain.length - 1];
			if (newest && newest.txid !== txid) {
				redirect(302, `/explorer/tx/${newest.txid}?replaced=${txid}`);
			}
			// A syntactically valid txid the backend has no record of. Return an
			// in-page not-found state as page DATA (matching the block and address
			// detail pages) rather than throwing a route-level error(404) — that
			// would bubble to the generic app-wide error page with a hardcoded
			// message instead of a contextual "Transaction not found" (cairn-t9b6).
			return { ...base, notFound: true as const, loading: false as const, txid, tx: null, replacedFrom, ownership: null, details: null };
		}
		// No backend that can serve tx detail (Core RPC unconfigured): render the
		// honest CoreRpcRequiredNotice via the in-page not-found state (the svelte
		// swaps the message on !coreRpcConfigured) instead of a route-level 502.
		if (!base.coreRpcConfigured) {
			return { ...base, notFound: true as const, loading: false as const, txid, tx: null, replacedFrom, ownership: null, details: null };
		}
		error(502, chainErrorMessage(e));
	}

	if (raced === TX_TIMEOUT) {
		// The backend is slow, not necessarily down. Persist the slow fetch's
		// eventual result so the client's poll (re-invalidating 'cairn:tx') finds a
		// warm cache and swaps in the real tx — without a second backend round-trip.
		txPromise.then((tx) => writeTxSnapshot(txid, tx)).catch(() => {});
		return { ...base, notFound: false as const, loading: true as const, txid, tx: null, replacedFrom, ownership: null, details: null };
	}

	// Fetched in time: persist for future visits and render as before.
	const tx = raced;
	writeTxSnapshot(txid, tx);
	const isCoinbase = tx.vin.some((v) => v.coinbase);

	return {
		...base,
		notFound: false as const,
		loading: false as const,
		txid,
		tx,
		replacedFrom,
		// See the cache-hit branch: viewer-scoped "involves your wallet" badges.
		ownership: txOwnership(locals?.user?.id, tx),
		// Streamed, not awaited (cairn-2zxt.3): supplementary display data only.
		details: loadTxDetails(tx, isCoinbase)
	};
};
