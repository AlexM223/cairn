import { error } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import { walletDescriptorBackup } from '$lib/server/walletExport';
import { backupFileResponse } from '$lib/server/walletApi';
import { markBackedUp } from '$lib/server/backups';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/**
 * GET /api/wallets/:id/descriptor — the single-sig wallet's output descriptors
 * as a plain-text backup file. Like the multisig descriptor export, this is the
 * raw text form (receive + change branches, checksummed) that Bitcoin Core and
 * other descriptor wallets can import directly. It holds only the PUBLIC key —
 * it cannot spend. Downloading it records the wallet as backed up.
 */
export const GET: RequestHandler = async (event) => {
	// Gate wallet descriptor export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');

	const wallet = getWallet(user.id, id);
	if (!wallet) error(404, 'Wallet not found');

	let body: string;
	try {
		body = walletDescriptorBackup({
			name: wallet.name,
			xpub: wallet.xpub,
			scriptType: wallet.script_type,
			masterFingerprint: wallet.master_fingerprint ?? null,
			derivationPath: wallet.derivation_path ?? null
		});
	} catch (e) {
		log.error({ err: e, walletId: id }, 'wallet descriptor export failed');
		error(500, 'Could not build the descriptor backup file.');
	}

	// Downloading a descriptor backup counts as backing the wallet up.
	markBackedUp(user.id, 'wallet', id);
	return backupFileResponse(body, wallet.name, { noStore: true });
};
