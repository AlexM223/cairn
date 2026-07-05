import { fail } from '@sveltejs/kit';
import {
	deriveVaultAddress,
	parseDescriptor,
	vaultToDescriptor,
	VaultError,
	type VaultConfig
} from '$lib/server/bitcoin/multisig';
import {
	createVault,
	VAULT_KEY_CATEGORIES,
	VAULT_SCRIPT_TYPES,
	type NewVaultKey,
	type VaultDeviceType,
	type VaultKeyCategory,
	type VaultScriptType
} from '$lib/server/vaults';
import { containsPrivateKeyMaterial, parseCaravanImport } from '$lib/server/vaultExport';
import { listVaults } from '$lib/server/vaults';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// First-timers get the "why a vault?" education expanded; repeat users get
	// it collapsed out of the way.
	return { hasVaults: listVaults(locals.user!.id).length > 0 };
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
		throw new VaultError('Paste the key first — it starts with xpub, Zpub or [.', 'invalid_key');
	}
	if (containsPrivateKeyMaterial(raw)) {
		throw new VaultError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (/^(wsh|sh)\(/i.test(raw)) {
		throw new VaultError(
			'That looks like a full vault descriptor — use "Import an existing vault" instead.',
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
	const single: VaultConfig = { threshold: 1, keys: [{ xpub: parsed.xpub, fingerprint, path }] };
	const canonical = parseDescriptor(vaultToDescriptor(single)).keys[0].xpub;
	return { xpub: canonical, fingerprint, path };
}

function parseConfigJson(json: string): VaultConfig {
	let cfg: VaultConfig;
	try {
		cfg = JSON.parse(json) as VaultConfig;
	} catch {
		throw new VaultError('The vault configuration was malformed.', 'invalid_config');
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
		const category = String(form.get('category') ?? '') as VaultKeyCategory;
		const deviceTypeRaw = String(form.get('deviceType') ?? '');

		if (!name || name.length > 60) {
			return fail(400, { error: 'Give this key a short name (1-60 characters).' });
		}
		if (!VAULT_KEY_CATEGORIES.includes(category)) {
			return fail(400, { error: 'Pick what kind of key this is.' });
		}
		const deviceType = (DEVICE_TYPES.has(deviceTypeRaw) ? deviceTypeRaw : null) as VaultDeviceType;

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
			for (let i = 0; i < 3; i++) addresses.push(deriveVaultAddress(config, 0, i).address);
			return { addresses };
		} catch (e) {
			return fail(400, { error: errMessage(e) });
		}
	},

	/** Create the vault. Returns the id so the wizard can show its Done step. */
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const scriptTypeRaw = String(form.get('scriptType') ?? 'p2wsh') as VaultScriptType;
		const scriptType = VAULT_SCRIPT_TYPES.includes(scriptTypeRaw) ? scriptTypeRaw : 'p2wsh';

		let keys: NewVaultKey[];
		let threshold: number;
		try {
			const parsed = JSON.parse(String(form.get('keys') ?? '[]')) as NewVaultKey[];
			threshold = Number(form.get('threshold'));
			keys = (Array.isArray(parsed) ? parsed : []).map((k) => ({
				name: String(k.name ?? ''),
				category: k.category,
				deviceType: (DEVICE_TYPES.has(String(k.deviceType)) ? k.deviceType : null) as VaultDeviceType,
				xpub: String(k.xpub ?? ''),
				fingerprint: String(k.fingerprint ?? '00000000'),
				path: String(k.path ?? 'm')
			}));
		} catch {
			return fail(400, { error: 'The vault configuration was malformed.' });
		}

		try {
			const vault = createVault(locals.user!.id, { name, threshold, scriptType, keys });
			return { vaultId: vault.id };
		} catch (e) {
			return fail(400, {
				error: e instanceof VaultError ? e.message : 'Could not create that vault.'
			});
		}
	},

	/**
	 * Prefill from an existing vault: a wsh(sortedmulti(...)) descriptor OR a
	 * Caravan/Unchained wallet-config JSON (also what Cairn's own JSON backup
	 * emits, so export → import round-trips).
	 */
	import: async ({ request }) => {
		const form = await request.formData();
		const source = String(form.get('source') ?? '').trim();
		try {
			if (containsPrivateKeyMaterial(source)) {
				throw new VaultError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
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
					e instanceof VaultError
						? e.message
						: 'Could not read that — paste a descriptor or a Caravan wallet JSON.'
			});
		}
	}
};
