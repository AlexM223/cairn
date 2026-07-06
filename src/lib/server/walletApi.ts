// Shared handler plumbing for the wallet-scoped API resource pairs. Most
// wallet resources exist twice — /api/wallets/[id]/* and
// /api/wallets/multisig/[id]/* — and until the 2026-07-06 architecture review
// each pair carried a verbatim copy of its request shaping and response
// building. The wallet-type-specific parts (which access gate, which service
// call) stay in the route files where they're auditable at a glance; what
// lives here is only the logic that is identical by design on both sides:
//
//   - spend-request body shaping + the finer coin-control/batch feature gates
//     (the psbt pair)
//   - the PsbtError → HTTP status mapping those builders share
//   - the bounded-concurrency parent-mass classification (the utxo-mass pair)
//   - the history-CSV and dated backup-file download responses

import { json, type RequestEvent } from '@sveltejs/kit';
import { requireFeature, readJson } from './api';
import { getChain } from './chain';
import { PsbtError } from './bitcoin/psbt';
import {
	classifyAndCacheParent,
	getCachedParentMass,
	tierForVsize,
	type ParentClassification
} from './bitcoin/signingMass';
import { buildHistoryCsv, historyCsvFilename } from './historyExport';
import { filenameSlug } from './walletExport';
import { childLogger } from './logger';

const log = childLogger('wallet');

// ---------------------------------------------------------- spend requests

export interface SpendRequest {
	recipients: { address: string; amount: number | 'max' }[];
	feeRate: number;
	onlyUtxos?: { txid: string; vout: number }[];
}

/**
 * Read and shape a PSBT-build request body — one or more recipients (the
 * pre-batch single-recipient shape { recipient, amount } is still accepted as
 * a length-1 array) plus an optional manual-coin-control allowlist, sanitized
 * down to well-formed (txid, vout) pairs; the server-side selection treats
 * anything unknown as simply not matching.
 *
 * Applies the finer feature gates the same way both wallet types always did:
 * only reject when the request actually exercises coin control or batching,
 * so an ordinary single-recipient auto-coin-select spend is unaffected.
 */
export async function readSpendRequest(event: RequestEvent): Promise<SpendRequest> {
	const body = await readJson<{
		recipients?: { address?: unknown; amount?: unknown }[];
		recipient?: string;
		amount?: number | 'max';
		feeRate?: number;
		onlyUtxos?: { txid?: unknown; vout?: unknown }[];
	}>(event);

	const toAmount = (a: unknown): number | 'max' => (a === 'max' ? 'max' : Number(a));

	const recipients: { address: string; amount: number | 'max' }[] =
		Array.isArray(body.recipients) && body.recipients.length > 0
			? body.recipients.map((r) => ({
					address: String(r?.address ?? ''),
					amount: toAmount(r?.amount)
				}))
			: [{ address: String(body.recipient ?? ''), amount: toAmount(body.amount) }];

	const onlyUtxos = Array.isArray(body.onlyUtxos)
		? body.onlyUtxos
				.map((c) => ({ txid: String(c?.txid ?? ''), vout: Number(c?.vout) }))
				.filter((c) => /^[0-9a-f]{64}$/i.test(c.txid) && Number.isInteger(c.vout) && c.vout >= 0)
		: undefined;

	if (onlyUtxos && onlyUtxos.length > 0) requireFeature(event, 'coin_control');
	if (recipients.length > 1) requireFeature(event, 'batch_transactions');

	return {
		recipients,
		feeRate: Number(body.feeRate),
		onlyUtxos: onlyUtxos && onlyUtxos.length > 0 ? onlyUtxos : undefined
	};
}

/**
 * The PSBT-build error mapping both psbt routes share: a known PsbtError is
 * the user's problem (400, or 404 when construction itself failed), anything
 * else is logged and surfaced as a 502. `logContext` carries the route's id
 * key ({ walletId } or { multisigId }) so /admin/logs attribution is unchanged.
 */
export function psbtBuildErrorResponse(
	e: unknown,
	logContext: Record<string, unknown>
): Response {
	if (e instanceof PsbtError) {
		const status = e.code === 'construction_failed' ? 404 : 400;
		return json({ error: e.message, code: e.code }, { status });
	}
	log.error({ err: e, ...logContext }, 'wallet psbt build failed');
	return json(
		{ error: e instanceof Error ? e.message : 'Could not build the transaction' },
		{ status: 502 }
	);
}

// ------------------------------------------------------------ utxo mass

/**
 * How many parent transactions to fetch from the chain source at once. The
 * utxo-mass endpoints are user-triggered (the coin-control mass disclosure),
 * so they ARE allowed to fetch — but a wallet of pool payouts could reference
 * dozens of multi-hundred-KB parents, so fetches are bounded rather than
 * fired all at once, and everything lands in the process-wide parent cache so
 * the work happens once per parent per process.
 */
const MASS_FETCH_CONCURRENCY = 4;

export interface UtxoMassEntry {
	txid: string;
	vout: number;
	parentVsize: number;
	tier: ReturnType<typeof tierForVsize>;
	source: ParentClassification['source'];
}

/**
 * Signing-mass classification for a set of (confirmed) UTXOs — the shared body
 * of both utxo-mass endpoints. Lazy + cached + individually tolerant: parents
 * are consulted from the in-process cache first, missing ones are fetched with
 * bounded concurrency, and a coin whose parent can't be fetched or parsed is
 * simply absent from the result (the UI shows nothing for it rather than a
 * guess).
 */
export async function classifyUtxoMasses(
	utxos: { txid: string; vout: number }[]
): Promise<UtxoMassEntry[]> {
	const missing = [...new Set(utxos.map((u) => u.txid))].filter(
		(txid) => !getCachedParentMass(txid)
	);
	const chain = getChain();
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(MASS_FETCH_CONCURRENCY, missing.length) },
		async () => {
			while (next < missing.length) {
				const txid = missing[next++];
				try {
					classifyAndCacheParent(txid, await chain.getTxHex(txid));
				} catch {
					// Tolerated: this parent's coins are left out of the response.
				}
			}
		}
	);
	await Promise.all(workers);

	return utxos.flatMap((u) => {
		const parent = getCachedParentMass(u.txid);
		if (!parent) return [];
		return [
			{
				txid: u.txid,
				vout: u.vout,
				parentVsize: parent.vsize,
				tier: tierForVsize(parent.vsize),
				source: parent.source
			}
		];
	});
}

// ------------------------------------------------------------ file downloads

/**
 * The history-CSV download both wallet types produce — same columns, same
 * filename convention, same headers. The tip height is best-effort: no tip →
 * confirmations report 0 and the rest of the export is unaffected.
 */
export async function historyCsvResponse(args: {
	walletName: string;
	rows: Parameters<typeof buildHistoryCsv>[0]['rows'];
	ownedAddresses: string[];
	labels?: Record<string, string>;
}): Promise<Response> {
	const chain = getChain();
	let tipHeight = 0;
	try {
		tipHeight = (await chain.getTip()).height;
	} catch {
		tipHeight = 0;
	}

	const csv = await buildHistoryCsv({
		rows: args.rows,
		ownedAddresses: args.ownedAddresses,
		tipHeight,
		getTx: (txid) => chain.getTx(txid),
		labels: args.labels
	});

	const today = new Date().toISOString().slice(0, 10);
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${historyCsvFilename(args.walletName, today)}"`,
			'cache-control': 'no-store'
		}
	});
}

/**
 * A dated plain-text backup download (descriptor exports) — standard filename
 * comparable across a wallet's export buttons after a re-download or key
 * rotation (cairn-vxum).
 */
export function backupFileResponse(
	body: string,
	walletName: string,
	opts?: { noStore?: boolean }
): Response {
	const date = new Date().toISOString().slice(0, 10);
	const headers: Record<string, string> = {
		'content-type': 'text/plain; charset=utf-8',
		'content-disposition': `attachment; filename="cairn-${filenameSlug(walletName)}-backup-${date}-descriptor.txt"`
	};
	if (opts?.noStore) headers['cache-control'] = 'no-store';
	return new Response(body, { headers });
}
