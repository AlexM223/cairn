import { json, requireUser, readJson } from '$lib/server/api';
import {
	createVault,
	type NewVaultKey,
	type VaultDeviceType,
	type VaultKeyCategory,
	type VaultScriptType
} from '$lib/server/vaults';
import { VaultError } from '$lib/server/bitcoin/multisig';
import { listVaultSummaries } from '$lib/server/vaultScan';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('vault');

/** GET /api/vaults — all of the user's vaults with (cached) live balances. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { vaults, errors } = await listVaultSummaries(user.id);
	return json({ vaults, errors });
};

interface CreateBody {
	name?: string;
	threshold?: number;
	scriptType?: VaultScriptType;
	keys?: {
		name?: string;
		category?: VaultKeyCategory;
		deviceType?: VaultDeviceType;
		xpub?: string;
		fingerprint?: string;
		path?: string;
	}[];
}

const DEVICE_TYPES = new Set(['trezor', 'ledger', 'coldcard', 'qr', 'file']);

/**
 * POST /api/vaults { name, threshold, scriptType?, keys } — create a vault.
 * All cryptographic validation happens in createVault (which derives a real
 * address before anything is stored); VaultError messages surface verbatim.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<CreateBody>(event);

	const keys: NewVaultKey[] = (Array.isArray(body.keys) ? body.keys : []).map((k) => ({
		name: String(k?.name ?? ''),
		category: k?.category as VaultKeyCategory,
		deviceType:
			k?.deviceType && DEVICE_TYPES.has(k.deviceType) ? (k.deviceType as VaultDeviceType) : null,
		xpub: String(k?.xpub ?? ''),
		// Placeholder fingerprint / origin-less path when omitted — the same
		// convention the descriptor library uses for watch-only keys.
		fingerprint: String(k?.fingerprint ?? '').trim() || '00000000',
		path: String(k?.path ?? '').trim() || 'm'
	}));

	try {
		const vault = createVault(user.id, {
			name: String(body.name ?? ''),
			threshold: Number(body.threshold),
			scriptType: body.scriptType,
			keys
		});
		return json({ vault }, { status: 201 });
	} catch (e) {
		if (e instanceof VaultError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e }, 'vault create failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not create that vault.' },
			{ status: 400 }
		);
	}
};
