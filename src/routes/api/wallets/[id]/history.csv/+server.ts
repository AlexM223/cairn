import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getWallet, getLabels } from '$lib/server/wallets';
import { scanWallet } from '$lib/server/bitcoin/walletScan';
import { getChain } from '$lib/server/chain';
import { buildHistoryCsv, historyCsvFilename } from '$lib/server/historyExport';
import type { RequestHandler } from './$types';

/**
 * GET /api/wallets/:id/history.csv — this wallet's transaction history as a
 * CSV download (Date, Type, Amount BTC/sats, Fee, TxID, Confirmations,
 * Address, Label). Same 50-tx window the detail page shows.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const wallet = getWallet(user.id, id);
	if (!wallet) error(404, 'Wallet not found');

	let scan;
	try {
		scan = await scanWallet(wallet.xpub);
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Could not scan the wallet.');
	}

	const chain = getChain();
	let tipHeight = 0;
	try {
		tipHeight = (await chain.getTip()).height;
	} catch {
		// No tip → confirmations report 0; the rest of the export is unaffected.
		tipHeight = 0;
	}

	const csv = await buildHistoryCsv({
		rows: scan.txs,
		ownedAddresses: scan.addresses.map((a) => a.address),
		tipHeight,
		getTx: (txid) => chain.getTx(txid),
		labels: getLabels(user.id, id) ?? {}
	});

	const today = new Date().toISOString().slice(0, 10);
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${historyCsvFilename(wallet.name, today)}"`,
			'cache-control': 'no-store'
		}
	});
};
