import { error, fail, redirect } from '@sveltejs/kit';
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
import { requireFeature, requireUser } from '$lib/server/api';
import {
	getWizardDraft,
	createWizardDraft,
	syncWizardDraft,
	deleteWizardDraft,
	type WizardDraftKeyInput,
	type WizardDraftVaultMode
} from '$lib/server/multisigWizardDrafts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	// Guard locals.user directly rather than trusting the parent layout's redirect
	// to have already run: a race (observed as a 500 "Cannot read properties of
	// null (reading id)" that succeeded on retry) could let this child load run
	// with a stale/null user before the parent guard took effect (cairn-mlxf).
	if (!event.locals.user) throw redirect(302, '/login');
	// The whole create-multisig wizard is gated; existing multisigs stay usable.
	requireFeature(event, 'multisig_create');

	// ?draft=N resumes a server-persisted wizard draft (cairn-jy3g), mirroring
	// the send flow's ?tx=N resume (see wallets/[id]/send/+page.server.ts and
	// getTransaction in transactions.ts). A synchronous SQLite read only — no
	// Electrum, no device I/O. Owner-scoped: getWizardDraft returns null both
	// when the draft doesn't exist and when it belongs to another user, and
	// either case 404s identically, so a resume link can never be used to
	// probe another user's in-progress vault.
	let resumeDraft: ReturnType<typeof getWizardDraft> = null;
	const draftParam = event.url.searchParams.get('draft');
	if (draftParam !== null) {
		const draftId = Number(draftParam);
		resumeDraft = Number.isInteger(draftId) ? getWizardDraft(event.locals.user.id, draftId) : null;
		if (!resumeDraft) error(404, 'Saved wizard draft not found');
	}

	// First-timers get the "why a multisig?" education expanded; repeat users get
	// it collapsed out of the way.
	return {
		hasMultisigs: listMultisigs(event.locals.user.id).length > 0,
		// Managed-service suggestions (cairn-y5l6): active rows only, and only
		// when the referral_links flag is on — otherwise an empty list, which the
		// page treats as "render nothing".
		multisigServices:
			event.locals.flags?.referral_links !== false ? listActiveMultisigServiceReferrals() : [],
		resumeDraft
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
	key: async (event) => {
		requireUser(event);
		const { request, locals } = event;
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
	preview: async (event) => {
		requireUser(event);
		const { request } = event;
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

		// cairn-etz9: Option B (cairn-acft) removed bare legacy P2SH from this
		// wizard's UI, but that only hid the choice — a scripted POST straight to
		// this action could still mint a fresh bare-P2SH wallet. Enforce the same
		// restriction server-side for CREATE; a restored/imported legacy config
		// still needs scriptType='p2sh' to round-trip, so only 'created' is blocked.
		if (scriptType === 'p2sh' && source !== 'imported') {
			return fail(400, {
				error: 'Legacy P2SH multisig wallets can no longer be created new — import an existing one instead.'
			});
		}

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
			// The wizard draft's job is done — the multisig itself is now the
			// durable record. Best-effort/owner-scoped delete: a missing or
			// already-cleared draftId is a no-op, never a reason to fail a
			// successful create (cairn-jy3g).
			const draftIdRaw = Number(form.get('draftId'));
			if (Number.isInteger(draftIdRaw) && draftIdRaw > 0) {
				try {
					deleteWizardDraft(locals.user!.id, draftIdRaw);
				} catch (e) {
					log.warn({ err: e, userId: locals.user!.id, draftId: draftIdRaw }, 'wizard draft cleanup skipped');
				}
			}
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
	 * Server-side wizard persistence (cairn-jy3g, Phase 2 of cairn-1u41): commits
	 * the wizard's current quorum/key-list/position to a per-user draft row,
	 * creating it on the first call and updating it in place after. The client
	 * calls this immediately after every local key add/remove (submitKey /
	 * removeKey in +page.svelte) — see syncWizardDraft's doc comment for why a
	 * full key-list replace is both simple and still gives each key its own
	 * durable commit. `draftId` empty/absent creates a new draft; a non-empty
	 * `draftId` that isn't owned by this user 404s (fail, not error() — this is
	 * a background sync call, not a page navigation, so it must not blow away
	 * the wizard's in-memory state with SvelteKit's error page).
	 *
	 * SECURITY: only public key fields are accepted (name/category/deviceType/
	 * xpub/fingerprint/path) — the exact same shape the `key` action above
	 * already validated and handed back to the client. This action does NOT
	 * re-run normalizeMultisigKeyInput's private-key-material refusal because
	 * it never accepts raw pasted text — only the already-normalized key
	 * objects the client got back from a successful `key` call.
	 */
	draftSync: async (event) => {
		const user = requireUser(event);
		const { request } = event;
		const form = await request.formData();

		const name = String(form.get('name') ?? '').trim();
		const threshold = Number(form.get('threshold'));
		const totalKeys = Number(form.get('totalKeys'));
		const scriptTypeRaw = String(form.get('scriptType') ?? '') as MultisigScriptType;
		const scriptType = MULTISIG_SCRIPT_TYPES.includes(scriptTypeRaw) ? scriptTypeRaw : 'p2wsh';
		const vaultModeRaw = String(form.get('vaultMode') ?? '');
		const vaultMode: WizardDraftVaultMode | null =
			vaultModeRaw === 'collaborative' || vaultModeRaw === 'personal' ? vaultModeRaw : null;
		const step = String(form.get('step') ?? 'keys').slice(0, 40);
		const configImported = String(form.get('configImported') ?? '') === 'true';
		const importedStartIndexRaw = Number(form.get('importedStartIndex'));
		const importedStartIndex =
			Number.isInteger(importedStartIndexRaw) && importedStartIndexRaw >= 0 ? importedStartIndexRaw : 0;

		if (!Number.isInteger(threshold) || !Number.isInteger(totalKeys) || threshold < 1 || totalKeys < threshold) {
			return fail(400, { error: 'Invalid quorum.' });
		}

		let keys: WizardDraftKeyInput[];
		try {
			const parsed = JSON.parse(String(form.get('keys') ?? '[]')) as unknown[];
			if (!Array.isArray(parsed)) throw new Error('not an array');
			keys = parsed.map((raw) => {
				const k = raw as Record<string, unknown>;
				const category = String(k.category ?? '') as MultisigKeyCategory;
				if (!MULTISIG_KEY_CATEGORIES.includes(category)) throw new Error('invalid category');
				const deviceTypeRaw = String(k.deviceType ?? '');
				const deviceType = (DEVICE_TYPES.has(deviceTypeRaw) ? deviceTypeRaw : null) as MultisigDeviceType;
				const xpub = String(k.xpub ?? '').trim();
				const fingerprint = String(k.fingerprint ?? '').trim();
				const path = String(k.path ?? '').trim();
				if (!xpub || !fingerprint || !path) throw new Error('incomplete key');
				return { name: String(k.name ?? '').trim(), category, deviceType, xpub, fingerprint, path };
			});
		} catch {
			return fail(400, { error: 'The wizard draft could not be saved (malformed key list).' });
		}

		const fields = { name, threshold, totalKeys, scriptType, vaultMode, step, configImported, importedStartIndex };

		const draftIdRaw = Number(form.get('draftId'));
		if (Number.isInteger(draftIdRaw) && draftIdRaw > 0) {
			const updated = syncWizardDraft(user.id, draftIdRaw, fields, keys);
			if (!updated) return fail(404, { error: 'Saved wizard draft not found.' });
			return { draftId: updated.id };
		}
		const created = createWizardDraft(user.id, fields);
		// A brand-new draft with keys already attached (e.g. the very first
		// commit fires after the first key is added) — one more sync call folds
		// them in immediately rather than leaving the draft keyless until the
		// NEXT add.
		if (keys.length > 0) {
			const withKeys = syncWizardDraft(user.id, created.id, fields, keys);
			return { draftId: (withKeys ?? created).id };
		}
		return { draftId: created.id };
	},

	/** Explicit abandon (Start over): deletes the draft so a later visit to
	 *  /wallets/multisig/new starts genuinely fresh rather than offering a
	 *  resume of work the user just discarded. Owner-scoped + idempotent
	 *  (deleteWizardDraft is a no-op on a missing/foreign id), so this never
	 *  fails the client's local reset. */
	draftAbandon: async (event) => {
		const user = requireUser(event);
		const { request } = event;
		const form = await request.formData();
		const draftIdRaw = Number(form.get('draftId'));
		if (Number.isInteger(draftIdRaw) && draftIdRaw > 0) {
			deleteWizardDraft(user.id, draftIdRaw);
		}
		return { ok: true };
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
