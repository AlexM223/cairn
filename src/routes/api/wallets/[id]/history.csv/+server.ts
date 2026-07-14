import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getWallet, getLabels } from '$lib/server/wallets';
import { scanWallet } from '$lib/server/bitcoin/walletScan';
import { historyCsvResponse } from '$lib/server/walletApi';
import { sanitizeChainError } from '$lib/server/chainErrors';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/**
 * GET /api/wallets/:id/history.csv — this wallet's transaction history as a
 * CSV download (Date, Type, Amount BTC/sats, Fee, TxID, Confirmations,
 * Address, Label). Same 50-tx window the detail page shows.
 */
export const GET: RequestHandler = async (event) => {
	// Gate CSV history export behind the csv_export feature flag.
	const user = requireFeature(event, 'csv_export');
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const wallet = getWallet(user.id, id);
	if (!wallet) error(404, 'Wallet not found');

	let scan;
	try {
		scan = await scanWallet(wallet.xpub);
	} catch (e) {
		error(
			502,
			sanitizeChainError(
				e,
				log,
				{ walletId: id },
				'wallet history.csv scan failed',
				undefined,
				'Could not scan the wallet.'
			)
		);
	}

	return historyCsvResponse({
		walletName: wallet.name,
		rows: scan.txs,
		ownedAddresses: scan.addresses.map((a) => a.address),
		labels: getLabels(user.id, id) ?? {}
	});
};
