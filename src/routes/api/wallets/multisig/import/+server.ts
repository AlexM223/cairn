import { json, requireFeature, readJson } from '$lib/server/api';
import {
	parseDescriptor,
	validateMultisigKeyPaths,
	MultisigError
} from '$lib/server/bitcoin/multisig';
import {
	containsPrivateKeyMaterial,
	parseCaravanImport,
	PRIVATE_KEY_REFUSAL,
	type CaravanImport
} from '$lib/server/multisigExport';
import { createMultisig, type NewMultisigKey } from '$lib/server/wallets/multisig';
import { detectCosignerContacts, detectXpubReuse } from '$lib/server/cosignerDetection';
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
	/** Declared vault mode to record (cairn-1kc3.6). Imports are EXEMPT from the
	 *  BIP-45 enforcement regardless — an imported wallet already exists on-chain
	 *  with whatever paths it was built with — but the declared mode still
	 *  persists for downstream UX. */
	collaborative?: boolean;
}

function parseSource(source: string): CaravanImport {
	if (containsPrivateKeyMaterial(source)) {
		throw new MultisigError(PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (source.trim().startsWith('{')) return parseCaravanImport(source);
	const config = parseDescriptor(source.trim());
	// Path hygiene at the import boundary (cairn-1kc3.1/.3/.5): parseDescriptor
	// itself stays acceptance-agnostic (exports round-trip stored wallets
	// through it), so the check lives here where a NEW record is being accepted.
	validateMultisigKeyPaths(config);
	return {
		name: '',
		// parseDescriptor reports the wrapper it recognized: wsh() → p2wsh,
		// sh(wsh()) → p2sh-p2wsh, sh() → p2sh (cairn-opo6 — this was hardcoded
		// 'p2wsh', silently mis-typing every non-native-segwit descriptor import).
		scriptType: config.scriptType ?? 'p2wsh',
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

	if (!body.create) {
		// Anti-enumeration-safe cosigner-match hint: does any key here belong to one
		// of the importer's existing contacts? Non-committing suggestion (cairn-jaev).
		const cosignerMatches = detectCosignerContacts(
			user.id,
			parsed.keys.map((k) => k.fingerprint)
		);
		// Cross-wallet reuse hint (cairn-1kc3.4): is any of these keys already
		// stored as one of the importer's own wallets/cosigner keys? Non-blocking.
		const xpubReuse = detectXpubReuse(
			user.id,
			parsed.keys.map((k) => k.xpub)
		);
		return json({ imported: parsed, cosignerMatches, xpubReuse });
	}

	const keys: NewMultisigKey[] = parsed.keys.map((k) => ({
		name: k.name,
		category: 'hardware',
		deviceType: null,
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path
	}));
	try {
		// Cross-wallet reuse check BEFORE creation so the response can carry it
		// (cairn-1kc3.4); createMultisig also records an activity-feed warning.
		const xpubReuse = detectXpubReuse(
			user.id,
			keys.map((k) => k.xpub)
		);
		const multisig = createMultisig(user.id, {
			name: String(body.name ?? '').trim() || parsed.name,
			threshold: parsed.threshold,
			scriptType: parsed.scriptType,
			collaborative: typeof body.collaborative === 'boolean' ? body.collaborative : null,
			keys,
			// Imported from a config the user already holds — no backup prompts.
			source: 'imported',
			// Resume the receive cursor from the backup so we don't reissue used
			// addresses (cairn-u161).
			receiveCursor: parsed.startingAddressIndex
		});
		return json({ multisig, xpubReuse }, { status: 201 });
	} catch (e) {
		const message = e instanceof MultisigError ? e.message : 'Could not create that multisig.';
		if (!(e instanceof MultisigError)) log.error({ err: e }, 'wallet import create failed');
		return json({ error: message }, { status: 400 });
	}
};
