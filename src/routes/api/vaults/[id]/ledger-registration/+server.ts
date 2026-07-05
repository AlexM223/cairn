import { json, requireUser, readJson } from '$lib/server/api';
import {
	getLedgerRegistration,
	listLedgerRegistrations,
	saveLedgerRegistration,
	VaultRegistrationError
} from '$lib/server/vaultRegistrations';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('vault');

/**
 * GET /api/vaults/:id/ledger-registration            → { registrations: [...] }
 * GET /api/vaults/:id/ledger-registration?fp=f5acc2fd → { registration: {...} | null }
 *
 * The stored BIP-388 policy registrations (per-device HMACs) for this vault.
 * With ?fp= the response is the single registration for that device's master
 * fingerprint — null when that Ledger has never registered this vault, which
 * the signer treats as "run the one-time on-device registration first".
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const vaultId = Number(event.params.id);
	if (!Number.isInteger(vaultId) || vaultId <= 0) {
		return json({ error: 'Vault not found' }, { status: 404 });
	}

	// Ownership gate (null = not this user's vault) before honoring ?fp.
	const registrations = listLedgerRegistrations(user.id, vaultId);
	if (!registrations) return json({ error: 'Vault not found' }, { status: 404 });

	const fp = event.url.searchParams.get('fp');
	if (fp !== null) {
		if (!/^[0-9a-fA-F]{8}$/.test(fp.trim())) {
			return json({ error: 'The fingerprint must be 8 hex characters.' }, { status: 400 });
		}
		return json({ registration: getLedgerRegistration(user.id, vaultId, fp) });
	}
	return json({ registrations });
};

/**
 * POST /api/vaults/:id/ledger-registration
 * Body: { masterFp, policyName, policyHmac, policyId? }
 *
 * Persist the result of an on-device registerVaultPolicy run. Upserts on
 * (vault, masterFp): re-registering the same Ledger replaces the stored HMAC.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const vaultId = Number(event.params.id);
	if (!Number.isInteger(vaultId) || vaultId <= 0) {
		return json({ error: 'Vault not found' }, { status: 404 });
	}

	const body = await readJson<{
		masterFp?: unknown;
		policyName?: unknown;
		policyHmac?: unknown;
		policyId?: unknown;
	}>(event);

	try {
		const registration = saveLedgerRegistration(user.id, vaultId, body);
		return json({ registration }, { status: 201 });
	} catch (e) {
		if (e instanceof VaultRegistrationError) {
			return json(
				{ error: e.message, code: e.code },
				{ status: e.code === 'vault_not_found' ? 404 : 400 }
			);
		}
		log.error({ err: e, vaultId }, 'vault ledger-registration failed');
		return json({ error: 'Could not save the Ledger registration.' }, { status: 500 });
	}
};
