import { json, requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { vaultAddressDetailAt } from '$lib/server/vaultScan';
import { VaultError } from '$lib/server/bitcoin/multisig';
import type { RequestHandler } from './$types';

/**
 * GET /api/vaults/:id/address-detail?chain=0|1&index=N — the verification
 * detail for one vault address: witness/redeem script hex, BIP-67 sorted
 * child pubkeys, and every key's full derivation path. Derived on demand so
 * the detail page never ships scripts for hundreds of addresses it may never
 * expand. Pure derivation — no network, nothing persisted.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const vault = Number.isInteger(id) && id > 0 ? getVault(user.id, id) : null;
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	const chain = Number(event.url.searchParams.get('chain'));
	const index = Number(event.url.searchParams.get('index'));
	if (chain !== 0 && chain !== 1) {
		return json({ error: 'chain must be 0 (receive) or 1 (change)' }, { status: 400 });
	}
	if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
		return json({ error: 'index must be a non-negative integer' }, { status: 400 });
	}

	try {
		return json(vaultAddressDetailAt(vault, chain as 0 | 1, index));
	} catch (e) {
		const status = e instanceof VaultError ? 400 : 500;
		return json(
			{ error: e instanceof Error ? e.message : 'Address derivation failed' },
			{ status }
		);
	}
};
