import { json, requireFeature, readJson } from '$lib/server/api';
import { parseDescriptor, MultisigError } from '$lib/server/bitcoin/multisig';
import {
	containsPrivateKeyMaterial,
	parseCaravanImport,
	PRIVATE_KEY_REFUSAL,
	type CaravanImport
} from '$lib/server/multisigExport';
import { createMultisig, type NewMultisigKey } from '$lib/server/wallets/multisig';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

interface ImportBody {
	/** A wsh(sortedmulti(...)) descriptor OR a Caravan/Unchained wallet JSON. */
	descriptor?: string;
	/** Alias for descriptor — either field is accepted. */
	source?: string;
	/** When true, create the multisig immediately instead of returning a prefill. */
	create?: boolean;
	name?: string;
}

function parseSource(source: string): CaravanImport {
	if (containsPrivateKeyMaterial(source)) {
		throw new MultisigError(PRIVATE_KEY_REFUSAL, 'invalid_key');
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
		})),
		// A bare descriptor carries no receive cursor.
		startingAddressIndex: 0
	};
}

/**
 * POST /api/wallets/multisig/import { descriptor | source, create?, name? }
 * Parses an existing multisig definition — output descriptor or Caravan wallet
 * config. By default returns a prefill for the creation wizard; with
 * create=true it creates the multisig directly.
 */
export const POST: RequestHandler = async (event) => {
	// Gate: importing a wallet config requires the wallet_config_import feature.
	const user = requireFeature(event, 'wallet_config_import');
	const body = await readJson<ImportBody>(event);

	let parsed: CaravanImport;
	try {
		parsed = parseSource(String(body.source ?? body.descriptor ?? ''));
	} catch (e) {
		const message =
			e instanceof MultisigError
				? e.message
				: 'Could not read that — paste a descriptor or a Caravan wallet JSON.';
		if (!(e instanceof MultisigError)) log.error({ err: e }, 'wallet import parse failed');
		return json({ error: message }, { status: 400 });
	}

	if (!body.create) return json({ imported: parsed });

	const keys: NewMultisigKey[] = parsed.keys.map((k) => ({
		name: k.name,
		category: 'hardware',
		deviceType: null,
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path
	}));
	try {
		const multisig = createMultisig(user.id, {
			name: String(body.name ?? '').trim() || parsed.name,
			threshold: parsed.threshold,
			scriptType: parsed.scriptType,
			keys,
			// Imported from a config the user already holds — no backup prompts.
			source: 'imported',
			// Resume the receive cursor from the backup so we don't reissue used
			// addresses (cairn-u161).
			receiveCursor: parsed.startingAddressIndex
		});
		return json({ multisig }, { status: 201 });
	} catch (e) {
		const message = e instanceof MultisigError ? e.message : 'Could not create that multisig.';
		if (!(e instanceof MultisigError)) log.error({ err: e }, 'wallet import create failed');
		return json({ error: message }, { status: 400 });
	}
};
