import { json, requireUser, readJson } from '$lib/server/api';
import {
	getLedgerRegistration,
	listLedgerRegistrations,
	saveLedgerRegistration,
	MultisigRegistrationError
} from '$lib/server/multisigRegistrations';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/ledger-registration            → { registrations: [...] }
 * GET /api/wallets/multisig/:id/ledger-registration?fp=f5acc2fd → { registration: {...} | null }
 *
 * The stored BIP-388 policy registrations (per-device HMACs) for this multisig.
 * With ?fp= the response is the single registration for that device's master
 * fingerprint — null when that Ledger has never registered this multisig, which
 * the signer treats as "run the one-time on-device registration first".
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const multisigId = Number(event.params.id);
	if (!Number.isInteger(multisigId) || multisigId <= 0) {
		return json({ error: 'Multisig not found' }, { status: 404 });
	}

	// Ownership gate (null = not this user's multisig) before honoring ?fp.
	const registrations = listLedgerRegistrations(user.id, multisigId);
	if (!registrations) return json({ error: 'Multisig not found' }, { status: 404 });

	const fp = event.url.searchParams.get('fp');
	if (fp !== null) {
		if (!/^[0-9a-fA-F]{8}$/.test(fp.trim())) {
			return json({ error: 'The fingerprint must be 8 hex characters.' }, { status: 400 });
		}
		return json({ registration: getLedgerRegistration(user.id, multisigId, fp) });
	}
	return json({ registrations });
};

/**
 * POST /api/wallets/multisig/:id/ledger-registration
 * Body: { masterFp, policyName, policyHmac, policyId? }
 *
 * Persist the result of an on-device registerMultisigPolicy run. Upserts on
 * (multisig, masterFp): re-registering the same Ledger replaces the stored HMAC.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const multisigId = Number(event.params.id);
	if (!Number.isInteger(multisigId) || multisigId <= 0) {
		return json({ error: 'Multisig not found' }, { status: 404 });
	}

	const body = await readJson<{
		masterFp?: unknown;
		policyName?: unknown;
		policyHmac?: unknown;
		policyId?: unknown;
	}>(event);

	try {
		const registration = saveLedgerRegistration(user.id, multisigId, body);
		return json({ registration }, { status: 201 });
	} catch (e) {
		if (e instanceof MultisigRegistrationError) {
			return json(
				{ error: e.message, code: e.code },
				{ status: e.code === 'multisig_not_found' ? 404 : 400 }
			);
		}
		log.error({ err: e, multisigId }, 'wallet ledger-registration failed');
		return json({ error: 'Could not save the Ledger registration.' }, { status: 500 });
	}
};
