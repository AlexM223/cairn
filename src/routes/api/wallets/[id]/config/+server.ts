import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import { markBackedUp } from '$lib/server/backups';
import type { RequestHandler } from './$types';

function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'wallet'
	);
}

/**
 * GET /api/wallets/:id/config — the single-sig wallet's configuration backup as
 * a downloadable JSON file. This is the public info needed to find the wallet
 * again (and re-import it into Cairn, Sparrow, or Electrum) if Cairn's data is
 * lost — the xpub, script type, and key origin. It holds NOTHING that can spend.
 * Downloading it records the wallet as backed up (see wallet_backups).
 */
export const GET: RequestHandler = async (event) => {
	// Gate wallet config export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const wallet = getWallet(user.id, id);
	if (!wallet) error(404, 'Wallet not found');

	const config = {
		format: 'cairn-wallet-config',
		version: 1,
		type: 'single-sig',
		name: wallet.name,
		scriptType: wallet.script_type,
		xpub: wallet.xpub,
		masterFingerprint: wallet.master_fingerprint ?? null,
		derivationPath: wallet.derivation_path ?? null,
		note: 'Public keys only — cannot spend. Re-import the xpub to restore this wallet in Cairn, Sparrow, or Electrum.'
	};

	// Downloading the config is what "backed up" means for a single-sig wallet.
	markBackedUp(user.id, 'wallet', id);
	const date = new Date().toISOString().slice(0, 10);

	return new Response(JSON.stringify(config, null, 2), {
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="cairn-${slug(wallet.name)}-backup-${date}.json"`,
			'cache-control': 'no-store'
		}
	});
};
