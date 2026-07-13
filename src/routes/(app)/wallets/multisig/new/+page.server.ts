import { fail, redirect } from '@sveltejs/kit';
import {
	deriveMultisigAddress,
	parseDescriptor,
	validateMultisigKeyPaths,
	MultisigError,
	type MultisigConfig
} from '$lib/server/bitcoin/multisig';
import {
	parseVaultIntent,
	validateKeyForIntent,
	intentPurpose,
	reusableDeviceKeys
} from './vaultIntent.server';
import { listDeviceKeys, rememberDeviceKey, purposeFromPath } from '$lib/server/deviceKeys';
import { childLogger } from '$lib/server/logger';
import {
	createMultisig,
	MULTISIG_KEY_CATEGORIES,
	MULTISIG_SCRIPT_TYPES,
	type NewMultisigKey,
	type MultisigDeviceType,
	type MultisigKeyCategory,
	type MultisigScriptType
} from '$lib/server/wallets/multisig';
import { normalizeMultisigKeyInput, PASTED_PRIVATE_KEY_REFUSAL } from '$lib/server/wallets/keyInput';
import { containsPrivateKeyMaterial, parseCaravanImport } from '$lib/server/multisigExport';
import { detectCosignerContacts } from '$lib/server/cosignerDetection';
import { listMultisigs } from '$lib/server/wallets/multisig';
import { listActiveMultisigServiceReferrals } from '$lib/server/referrals';
import { requireFeature } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// Guard locals.user directly rather than trusting the parent layout's redirect
	// to have already run: a race (observed as a 500 "Cannot read properties of
	// null (reading id)" that succeeded on retry) could let this child load run
	// with a stale/null user before the parent guard took effect (cairn-mlxf).
	if (!event.locals.user) throw redirect(302, '/login');
	// The whole create-multisig wizard is gated; existing multisigs stay usable.
	requireFeature(event, 'multisig_create');
	// First-timers get the "why a multisig?" education expanded; repeat users get
	// it collapsed out of the way.
	return {
		hasMultisigs: listMultisigs(event.locals.user.id).length > 0,
		// Managed-service suggestions (cairn-y5l6): active rows only, and only
		// when the referral_links flag is on — otherwise an empty list, which the
		// page treats as "render nothing".
		multisigServices:
			event.locals.flags?.referral_links !== false ? listActiveMultisigServiceReferrals() : []
	};
};

const log = childLogger('multisigWizard');

const DEVICE_TYPES = new Set(['trezor', 'ledger', 'bitbox02', 'jade', 'coldcard', 'qr', 'file']);

/** Devices whose keys arrive via a LIVE in-browser read (vs paste/file/QR) —
 *  the only reads worth caching in the device-keys registry. */
const LIVE_READ_DEVICES = new Set(['trezor', 'ledger', 'bitbox02', 'jade']);

/**
 * Best-effort registry write after a live device read (cairn-fdlf.4): remember
 * the key under its purpose so the NEXT vault (or the next key slot of this
 * one) can offer reuse instead of another device touch. Never blocks the add —
 * the registry is a convenience cache, the key itself already validated.
 */
function rememberLiveRead(
	userId: number | undefined,
	readFromRaw: unknown,
	key: { xpub: string; fingerprint: string; path: string }
): void {
	const readFrom = String(readFromRaw ?? '');
	if (!userId || !LIVE_READ_DEVICES.has(readFrom)) return;
	if (key.fingerprint === '00000000') return; // "no fingerprint on record" placeholder
	const purpose = purposeFromPath(key.path);
	if (purpose !== '45' && purpose !== '48') return; // only multisig-purpose reads land here
	try {
		rememberDeviceKey(userId, {
			fingerprint: key.fingerprint,
			purpose,
			xpub: key.xpub,
			path: key.path,
			deviceType: readFrom
		});
	} catch (e) {
		log.warn({ err: e, userId }, 'device-key registry write skipped after live read');
	}
}

function errMessage(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	// Single-key validation wraps the key in a 1-of-1 descriptor, so the
	// library prefixes errors with "Key 1:" / "key 1:" — noise here.
	return msg.replace(/^[Kk]ey 1: /, '');
}

function parseConfigJson(json: string): MultisigConfig {
	let cfg: MultisigConfig;
	try {
		cfg = JSON.parse(json) as MultisigConfig;
	} catch {
		throw new MultisigError('The multisig configuration was malformed.', 'invalid_config');
	}
	return {
		threshold: Number(cfg.threshold),
		keys: (Array.isArray(cfg.keys) ? cfg.keys : []).map((k) => ({
			xpub: String(k.xpub ?? ''),
			fingerprint: String(k.fingerprint ?? '00000000'),
			path: String(k.path ?? 'm')
		}))
	};
}

export const actions: Actions = {
	/** Validate + normalize one key (paste, device read, or ColdCard file). */
	key: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const category = String(form.get('category') ?? '') as MultisigKeyCategory;
		const deviceTypeRaw = String(form.get('deviceType') ?? '');

		if (!name || name.length > 60) {
			return fail(400, { error: 'Give this key a short name (1-60 characters).' });
		}
		if (!MULTISIG_KEY_CATEGORIES.includes(category)) {
			return fail(400, { error: 'Pick what kind of key this is.' });
		}
		const deviceType = (DEVICE_TYPES.has(deviceTypeRaw) ? deviceTypeRaw : null) as MultisigDeviceType;

		// The vault's declared mode + script type (cairn-fdlf.4/.5): a key that
		// contradicts the declared intent is rejected HERE, at add time, with an
		// actionable message — createMultisig would reject it at the end anyway
		// (cairn-1kc3.6), which is the worst place for the user to find out.
		const intent = parseVaultIntent(form.get('intent'));
		const scriptTypeRaw = String(form.get('scriptType') ?? '') as MultisigScriptType;
		const scriptType = MULTISIG_SCRIPT_TYPES.includes(scriptTypeRaw) ? scriptTypeRaw : 'p2wsh';

		try {
			const normalized = normalizeMultisigKeyInput(
				String(form.get('xpub') ?? ''),
				String(form.get('fingerprint') ?? ''),
				String(form.get('path') ?? '')
			);
			validateKeyForIntent(normalized.path, scriptType, intent, name);
			rememberLiveRead(locals.user?.id, form.get('readFrom'), normalized);
			return { key: { name, category, deviceType, ...normalized } };
		} catch (e) {
			return fail(400, { error: errMessage(e) });
		}
	},

	/**
	 * Registry lookup for the reuse-before-fresh-read offer (cairn-fdlf.4): the
	 * caller's known device keys at the declared intent's purpose, filtered to
	 * rows actually usable in this vault. Only multisig-purpose rows ('45'/'48')
	 * are ever read — single-sig registry rows stay private (cairn-fdlf.3).
	 */
	knownKeys: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in first.' });
		const form = await request.formData();
		const intent = parseVaultIntent(form.get('intent'));
		if (!intent) return { knownKeys: [] };
		const scriptTypeRaw = String(form.get('scriptType') ?? '') as MultisigScriptType;
		const scriptType = MULTISIG_SCRIPT_TYPES.includes(scriptTypeRaw) ? scriptTypeRaw : 'p2wsh';
		const rows = listDeviceKeys(locals.user.id, [intentPurpose(intent)]).map((r) => ({
			fingerprint: r.fingerprint,
			purpose: r.purpose as '45' | '48',
			xpub: r.xpub,
			path: r.path,
			deviceType: r.deviceType
		}));
		return {
			knownKeys: reusableDeviceKeys(rows, scriptType, intent).map(
				({ fingerprint, xpub, path, deviceType }) => ({ fingerprint, xpub, path, deviceType })
			)
		};
	},

	/** First receive addresses for the Review step's cross-check. */
	preview: async ({ request }) => {
		const form = await request.formData();
		try {
			const config = parseConfigJson(String(form.get('config') ?? ''));
			const addresses: string[] = [];
			for (let i = 0; i < 3; i++) addresses.push(deriveMultisigAddress(config, 0, i).address);
			return { addresses };
		} catch (e) {
			return fail(400, { error: errMessage(e) });
		}
	},

	/** Create the multisig. Returns the id so the wizard can show its Done step. */
	create: async (event) => {
		// The persistence boundary for a new multisig — the real create gate.
		requireFeature(event, 'multisig_create');
		const { request, locals } = event;
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const scriptTypeRaw = String(form.get('scriptType') ?? 'p2wsh') as MultisigScriptType;
		const scriptType = MULTISIG_SCRIPT_TYPES.includes(scriptTypeRaw) ? scriptTypeRaw : 'p2wsh';
		// 'imported' when the wizard was pre-filled from an uploaded config (the
		// user already has that file); 'created' when built key-by-key.
		const source = String(form.get('source') ?? '') === 'imported' ? 'imported' : 'created';
		// Carried through from an imported Caravan config so a restored wallet
		// resumes at the right receive index instead of reusing 0.. (cairn-u161).
		const startRaw = Number(form.get('startingAddressIndex'));
		const receiveCursor = Number.isInteger(startRaw) && startRaw > 0 ? startRaw : 0;
		// Declared vault mode (cairn-fdlf.4 → cairn-1kc3.6): 'true'/'false' when
		// the wizard asked its collaborative-vs-personal question, '' when it
		// didn't (import prefills). createMultisig enforces the mode server-side.
		const collabRaw = String(form.get('collaborative') ?? '');
		const collaborative = collabRaw === 'true' ? true : collabRaw === 'false' ? false : null;

		let keys: NewMultisigKey[];
		let threshold: number;
		try {
			const parsed = JSON.parse(String(form.get('keys') ?? '[]')) as NewMultisigKey[];
			threshold = Number(form.get('threshold'));
			keys = (Array.isArray(parsed) ? parsed : []).map((k) => ({
				name: String(k.name ?? ''),
				category: k.category,
				deviceType: (DEVICE_TYPES.has(String(k.deviceType)) ? k.deviceType : null) as MultisigDeviceType,
				xpub: String(k.xpub ?? ''),
				fingerprint: String(k.fingerprint ?? '00000000'),
				path: String(k.path ?? 'm')
			}));
		} catch {
			return fail(400, { error: 'The multisig configuration was malformed.' });
		}

		try {
			const multisig = createMultisig(locals.user!.id, {
				name,
				threshold,
				scriptType,
				keys,
				source,
				receiveCursor,
				collaborative
			});
			return { multisigId: multisig.id };
		} catch (e) {
			// Double-submit guard (cairn-50ng): createMultisig's synchronous
			// check-then-insert throws 'duplicate_name' when this (user, name)
			// pair already exists — a distinct status from a validation failure.
			const status = e instanceof MultisigError && e.code === 'duplicate_name' ? 409 : 400;
			return fail(status, {
				error: e instanceof MultisigError ? e.message : 'Could not create that multisig.'
			});
		}
	},

	/**
	 * Prefill from an existing multisig: a wsh(sortedmulti(...)) descriptor OR a
	 * Caravan/Unchained wallet-config JSON (also what Cairn's own JSON backup
	 * emits, so export → import round-trips).
	 */
	import: async (event) => {
		// Pasting/uploading an existing config to prefill the wizard is the import gate.
		requireFeature(event, 'wallet_config_import');
		const { request, locals } = event;
		const form = await request.formData();
		const source = String(form.get('source') ?? '').trim();
		try {
			if (containsPrivateKeyMaterial(source)) {
				throw new MultisigError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
			}
			const imported = source.startsWith('{')
				? parseCaravanImport(source)
				: (() => {
						const config = parseDescriptor(source);
						// Path hygiene at the import boundary (cairn-1kc3.1/.3/.5), same
						// as the API import route: parseDescriptor itself stays
						// acceptance-agnostic (exports round-trip through it). Import mode
						// (cairn-acft) tolerates a historical legacy-P2SH 1'-suffix label
						// with a warning instead of rejecting it outright.
						const warnings = validateMultisigKeyPaths(config, { mode: 'import' });
						return {
							name: '',
							// parseDescriptor reports the wrapper it recognized: wsh() →
							// p2wsh, sh(wsh()) → p2sh-p2wsh, sh() → p2sh (cairn-opo6 —
							// this was hardcoded 'p2wsh', silently mis-typing every
							// non-native-segwit descriptor import).
							scriptType: config.scriptType ?? ('p2wsh' as const),
							threshold: config.threshold,
							totalKeys: config.keys.length,
							keys: config.keys.map((k, i) => ({ name: `Key ${i + 1}`, ...k })),
							warnings
						};
					})();
			// Anti-enumeration-safe: does any of these cosigner keys belong to one of
			// the importer's existing contacts? A non-committing invite suggestion only
			// (cairn-jaev) — never auto-shares.
			const cosignerMatches = detectCosignerContacts(
				locals.user!.id,
				imported.keys.map((k) => k.fingerprint)
			);
			return { imported, cosignerMatches };
		} catch (e) {
			return fail(400, {
				error:
					e instanceof MultisigError
						? e.message
						: 'Could not read that — paste a descriptor or a Caravan wallet JSON.'
			});
		}
	}
};
