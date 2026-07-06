import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import { getMultisigDetail } from '$lib/server/multisigScan';
import { getChain } from '$lib/server/chain';
import { buildHistoryCsv, historyCsvFilename } from '$lib/server/historyExport';
import type { RequestHandler } from './$types';

/**
 * GET /api/wallets/multisig/:id/history.csv — this multisig's transaction history as a CSV
 * download. Same columns and format as the single-sig wallet export.
 */
export const GET: RequestHandler = async (event) => {
	// Gate CSV history export behind the csv_export feature flag.
	const user = requireFeature(event, 'csv_export');
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Multisig not found');

	// History is a read-only surface — owner or any accepted share.
	const multisig = getViewableMultisig(user.id, id);
	if (!multisig) error(404, 'Multisig not found');

	let detail;
	try {
		detail = await getMultisigDetail(multisig);
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Could not scan the multisig.');
	}

	const chain = getChain();
	let tipHeight = 0;
	try {
		tipHeight = (await chain.getTip()).height;
	} catch {
		tipHeight = 0;
	}

	const csv = await buildHistoryCsv({
		rows: detail.history,
		ownedAddresses: detail.addresses.map((a) => a.address),
		tipHeight,
		getTx: (txid) => chain.getTx(txid)
	});

	const today = new Date().toISOString().slice(0, 10);
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${historyCsvFilename(multisig.name, today)}"`,
			'cache-control': 'no-store'
		}
	});
};
