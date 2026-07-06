import { json, requireUser } from '$lib/server/api';
import { getSignableMultisig } from '$lib/server/wallets/multisig';
import { multisigAddressDetailAt } from '$lib/server/multisigScan';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/address-detail?chain=0|1&index=N — the verification
 * detail for one multisig address: witness/redeem script hex, BIP-67 sorted
 * child pubkeys, and every key's full derivation path. Derived on demand so
 * the detail page never ships scripts for hundreds of addresses it may never
 * expand. Pure derivation — no network, nothing persisted.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	// This surfaces every key's full derivation path, so it is signer-only
	// (owner or cosigner) — a pure viewer must not learn other keys' paths (§6).
	const multisig = Number.isInteger(id) && id > 0 ? getSignableMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	const chain = Number(event.url.searchParams.get('chain'));
	const index = Number(event.url.searchParams.get('index'));
	if (chain !== 0 && chain !== 1) {
		return json({ error: 'chain must be 0 (receive) or 1 (change)' }, { status: 400 });
	}
	if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
		return json({ error: 'index must be a non-negative integer' }, { status: 400 });
	}

	try {
		return json(multisigAddressDetailAt(multisig, chain as 0 | 1, index));
	} catch (e) {
		const status = e instanceof MultisigError ? 400 : 500;
		if (!(e instanceof MultisigError)) {
			log.error({ err: e, id, chain, index }, 'wallet address-detail failed');
		}
		return json(
			{ error: e instanceof Error ? e.message : 'Address derivation failed' },
			{ status }
		);
	}
};
