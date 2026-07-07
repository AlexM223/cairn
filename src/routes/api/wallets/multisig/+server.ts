import { json, requireUser, requireFeature, readJson } from '$lib/server/api';
import {
	createMultisig,
	type NewMultisigKey,
	type MultisigDeviceType,
	type MultisigKeyCategory,
	type MultisigScriptType
} from '$lib/server/wallets/multisig';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import { detectXpubReuse } from '$lib/server/cosignerDetection';
import { listMultisigSummaries } from '$lib/server/multisigScan';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/** GET /api/wallets/multisig — all of the user's multisigs with (cached) live balances. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { multisigs, errors } = await listMultisigSummaries(user.id);
	return json({ multisigs, errors });
};

interface CreateBody {
	name?: string;
	threshold?: number;
	scriptType?: MultisigScriptType;
	/** Declared vault mode (cairn-1kc3.6): true = collaborative (every key must
	 *  be BIP-45 m/45'), false = personal (BIP-48; m/45' rejected), omitted =
	 *  undeclared (no mode enforcement — today's wizard doesn't ask yet). */
	collaborative?: boolean;
	keys?: {
		name?: string;
		category?: MultisigKeyCategory;
		deviceType?: MultisigDeviceType;
		xpub?: string;
		fingerprint?: string;
		path?: string;
	}[];
}

const DEVICE_TYPES = new Set(['trezor', 'ledger', 'coldcard', 'qr', 'file']);

/**
 * POST /api/wallets/multisig { name, threshold, scriptType?, keys } — create a multisig.
 * All cryptographic validation happens in createMultisig (which derives a real
 * address before anything is stored); MultisigError messages surface verbatim.
 */
export const POST: RequestHandler = async (event) => {
	// Gate: creating a multisig requires the multisig_create feature.
	const user = requireFeature(event, 'multisig_create');
	const body = await readJson<CreateBody>(event);

	const keys: NewMultisigKey[] = (Array.isArray(body.keys) ? body.keys : []).map((k) => ({
		name: String(k?.name ?? ''),
		category: k?.category as MultisigKeyCategory,
		deviceType:
			k?.deviceType && DEVICE_TYPES.has(k.deviceType) ? (k.deviceType as MultisigDeviceType) : null,
		xpub: String(k?.xpub ?? ''),
		// Placeholder fingerprint / origin-less path when omitted — the same
		// convention the descriptor library uses for watch-only keys.
		fingerprint: String(k?.fingerprint ?? '').trim() || '00000000',
		path: String(k?.path ?? '').trim() || 'm'
	}));

	try {
		// Cross-wallet reuse check BEFORE creation so the response can carry it
		// (cairn-1kc3.4) — non-blocking; createMultisig also records a warning in
		// the activity feed.
		const xpubReuse = detectXpubReuse(
			user.id,
			keys.map((k) => k.xpub)
		);
		const multisig = createMultisig(user.id, {
			name: String(body.name ?? ''),
			threshold: Number(body.threshold),
			scriptType: body.scriptType,
			collaborative: typeof body.collaborative === 'boolean' ? body.collaborative : null,
			keys
		});
		return json({ multisig, xpubReuse }, { status: 201 });
	} catch (e) {
		if (e instanceof MultisigError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e }, 'wallet create failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not create that multisig.' },
			{ status: 400 }
		);
	}
};
