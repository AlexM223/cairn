import { fail } from '@sveltejs/kit';
import {
	deriveMultisigAddress,
	parseDescriptor,
	multisigToDescriptor,
	MultisigError,
	type MultisigConfig
} from '$lib/server/bitcoin/multisig';
import {
	createMultisig,
	MULTISIG_KEY_CATEGORIES,
	MULTISIG_SCRIPT_TYPES,
	type NewMultisigKey,
	type MultisigDeviceType,
	type MultisigKeyCategory,
	type MultisigScriptType
} from '$lib/server/wallets/multisig';
import { containsPrivateKeyMaterial, parseCaravanImport } from '$lib/server/multisigExport';
import { listMultisigs } from '$lib/server/wallets/multisig';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// First-timers get the "why a multisig?" education expanded; repeat users get
	// it collapsed out of the way.
	return { hasMultisigs: listMultisigs(locals.user!.id).length > 0 };
};

const DEVICE_TYPES = new Set(['trezor', 'ledger', 'coldcard', 'qr', 'file']);

const PASTED_PRIVATE_KEY_REFUSAL =
	"That's a private key. Never paste it anywhere. Export the public key instead (look for 'xpub' in your wallet).";

function errMessage(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	// Single-key validation wraps the key in a 1-of-1 descriptor, so the
	// library prefixes errors with "Key 1:" / "key 1:" — noise here.
	return msg.replace(/^[Kk]ey 1: /, '');
}

/**
 * Normalize one pasted/imported key. Accepts a bare xpub, a SLIP-132
 * Ypub/Zpub, or a descriptor-style `[fingerprint/path]xpub` expression —
 * whatever the multisig library's key parsing accepts, by wrapping the paste
 * in a 1-of-1 sortedmulti descriptor. Separate fingerprint/path fields fill
 * in whatever the paste itself didn't carry.
 */
function normalizeKey(paste: string, fpField: string, pathField: string) {
	const raw = paste.replace(/\s+/g, '');
	if (!raw) {
		throw new MultisigError('Paste the key first — it starts with xpub, Zpub or [.', 'invalid_key');
	}
	if (containsPrivateKeyMaterial(raw)) {
		throw new MultisigError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (/^(wsh|sh)\(/i.test(raw)) {
		throw new MultisigError(
			'That looks like a full multisig descriptor — use "Import an existing multisig" instead.',
			'invalid_descriptor'
		);
	}
	const parsed = parseDescriptor(`wsh(sortedmulti(1,${raw}))`).keys[0];

	let fingerprint = parsed.fingerprint;
	let path = parsed.path;
	const fp = fpField.trim().toLowerCase();
	const p = pathField.trim();
	if (fingerprint === '00000000' && fp) fingerprint = fp;
	if (path === 'm' && p) path = p;

	// Full validation (fingerprint format, path syntax, key parses) plus
	// SLIP-132 canonicalization, via a descriptor round-trip — one code path.
	const single: MultisigConfig = { threshold: 1, keys: [{ xpub: parsed.xpub, fingerprint, path }] };
	const canonical = parseDescriptor(multisigToDescriptor(single)).keys[0].xpub;
	return { xpub: canonical, fingerprint, path };
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
	key: async ({ request }) => {
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

		try {
			const normalized = normalizeKey(
				String(form.get('xpub') ?? ''),
				String(form.get('fingerprint') ?? ''),
				String(form.get('path') ?? '')
			);
			return { key: { name, category, deviceType, ...normalized } };
		} catch (e) {
			return fail(400, { error: errMessage(e) });
		}
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
	create: async ({ request, locals }) => {
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
				receiveCursor
			});
			return { multisigId: multisig.id };
		} catch (e) {
			return fail(400, {
				error: e instanceof MultisigError ? e.message : 'Could not create that multisig.'
			});
		}
	},

	/**
	 * Prefill from an existing multisig: a wsh(sortedmulti(...)) descriptor OR a
	 * Caravan/Unchained wallet-config JSON (also what Cairn's own JSON backup
	 * emits, so export → import round-trips).
	 */
	import: async ({ request }) => {
		const form = await request.formData();
		const source = String(form.get('source') ?? '').trim();
		try {
			if (containsPrivateKeyMaterial(source)) {
				throw new MultisigError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
			}
			if (source.startsWith('{')) {
				const caravan = parseCaravanImport(source);
				return { imported: caravan };
			}
			// parseDescriptor only accepts wsh(sortedmulti(...)) — native segwit.
			const config = parseDescriptor(source);
			return {
				imported: {
					name: '',
					scriptType: 'p2wsh' as const,
					threshold: config.threshold,
					totalKeys: config.keys.length,
					keys: config.keys.map((k, i) => ({ name: `Key ${i + 1}`, ...k }))
				}
			};
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
