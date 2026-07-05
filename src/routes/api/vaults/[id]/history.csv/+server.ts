import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { getVaultDetail } from '$lib/server/vaultScan';
import { getChain } from '$lib/server/chain';
import { buildHistoryCsv, historyCsvFilename } from '$lib/server/historyExport';
import type { RequestHandler } from './$types';

/**
 * GET /api/vaults/:id/history.csv — this vault's transaction history as a CSV
 * download. Same columns and format as the single-sig wallet export.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Vault not found');

	const vault = getVault(user.id, id);
	if (!vault) error(404, 'Vault not found');

	let detail;
	try {
		detail = await getVaultDetail(vault);
	} catch (e) {
		error(502, e instanceof Error ? e.message : 'Could not scan the vault.');
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
			'content-disposition': `attachment; filename="${historyCsvFilename(vault.name, today)}"`,
			'cache-control': 'no-store'
		}
	});
};
