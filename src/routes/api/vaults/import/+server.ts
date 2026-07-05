import { json, requireUser, readJson } from '$lib/server/api';
import { parseDescriptor, VaultError } from '$lib/server/bitcoin/multisig';
import {
	containsPrivateKeyMaterial,
	parseCaravanImport,
	PRIVATE_KEY_REFUSAL,
	type CaravanImport
} from '$lib/server/vaultExport';
import { createVault, type NewVaultKey } from '$lib/server/vaults';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('vault');

interface ImportBody {
	/** A wsh(sortedmulti(...)) descriptor OR a Caravan/Unchained wallet JSON. */
	descriptor?: string;
	/** Alias for descriptor — either field is accepted. */
	source?: string;
	/** When true, create the vault immediately instead of returning a prefill. */
	create?: boolean;
	name?: string;
}

function parseSource(source: string): CaravanImport {
	if (containsPrivateKeyMaterial(source)) {
		throw new VaultError(PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (source.trim().startsWith('{')) return parseCaravanImport(source);
	const config = parseDescriptor(source.trim());
	return {
		name: '',
		scriptType: 'p2wsh', // parseDescriptor only accepts native-segwit wsh()
		threshold: config.threshold,
		totalKeys: config.keys.length,
		keys: config.keys.map((k, i) => ({
			name: `Key ${i + 1}`,
			xpub: k.xpub,
			fingerprint: k.fingerprint,
			path: k.path
		}))
	};
}

/**
 * POST /api/vaults/import { descriptor | source, create?, name? }
 * Parses an existing vault definition — output descriptor or Caravan wallet
 * config. By default returns a prefill for the creation wizard; with
 * create=true it creates the vault directly.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<ImportBody>(event);

	let parsed: CaravanImport;
	try {
		parsed = parseSource(String(body.source ?? body.descriptor ?? ''));
	} catch (e) {
		const message =
			e instanceof VaultError
				? e.message
				: 'Could not read that — paste a descriptor or a Caravan wallet JSON.';
		if (!(e instanceof VaultError)) log.error({ err: e }, 'vault import parse failed');
		return json({ error: message }, { status: 400 });
	}

	if (!body.create) return json({ imported: parsed });

	const keys: NewVaultKey[] = parsed.keys.map((k) => ({
		name: k.name,
		category: 'hardware',
		deviceType: null,
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path
	}));
	try {
		const vault = createVault(user.id, {
			name: String(body.name ?? '').trim() || parsed.name,
			threshold: parsed.threshold,
			scriptType: parsed.scriptType,
			keys
		});
		return json({ vault }, { status: 201 });
	} catch (e) {
		const message = e instanceof VaultError ? e.message : 'Could not create that vault.';
		if (!(e instanceof VaultError)) log.error({ err: e }, 'vault import create failed');
		return json({ error: message }, { status: 400 });
	}
};
