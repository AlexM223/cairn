// Session-scoped persistence for the create-multisig wizard.
//
// The wizard keeps every bit of progress — current step, chosen quorum, and
// every cosigner key collected so far — in ephemeral component state. A full
// page reload therefore used to restart it from scratch: on Umbrel, app_proxy's
// auth layer can force exactly such a reload mid-wizard. That is far costlier
// here than in the single-sig wizard (src/routes/(app)/wallets/new/_components/
// wizardProgress.ts, which this module mirrors): each cosigner key can cost a
// physical hardware-device ceremony to collect, so losing progress after adding
// 4 of 5 keys means redoing 4 ceremonies, not 1. Snapshotting into sessionStorage
// (tab-scoped, auto-cleared when the tab closes) lets a remounted wizard resume
// where the user left off instead.
//
// Only PUBLIC key material is ever stored (xpub / master fingerprint /
// derivation path / label / device type per key) — the same data already
// rendered into the page's DOM. This is Phase 1 of cairn-1u41: sessionStorage
// only, no server-side draft persistence.
//
// The in-progress "add one key" form (method picked, pasted text, typed
// fingerprint/path, etc.) is deliberately NOT part of the snapshot — see
// hasMeaningfulProgress and the wiring in +page.svelte. A device connection
// can't survive a reload anyway (WebHID/WebUSB handles die with the page), so
// restoring half-entered text would look like progress it can't actually
// resume. The unit of loss is at most one uncommitted key; every key already
// pushed onto `keys` rides along in the snapshot.

import type {
	MultisigDeviceType,
	MultisigKeyCategory,
	MultisigScriptType
} from '$lib/server/wallets/multisig';

// v1: first version of multisig wizard resume (cairn-1u41). Bump this if the
// snapshot shape ever changes incompatibly — old snapshots then age out of
// sessionStorage on their own rather than being misread.
export const WIZARD_PROGRESS_KEY = 'cairn.multisig-wizard.v1';

/** A resume older than this is stale — likely a forgotten tab, not a reload. */
export const WIZARD_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

// The four resumable steps. 'done' is terminal — like the single-sig wizard's
// post-creation Done view, it is never saved (a created wallet clears the
// snapshot outright).
const STEP_KEYS = ['why', 'keys', 'review', 'confirm'] as const;
export type WizardStepKey = (typeof STEP_KEYS)[number];

const PRESETS = ['2of3', '3of5', 'custom'] as const;
export type WizardPreset = (typeof PRESETS)[number];

const VAULT_MODES = ['collaborative', 'personal'] as const;
export type WizardVaultMode = (typeof VAULT_MODES)[number];

const SCRIPT_TYPES: readonly MultisigScriptType[] = ['p2wsh', 'p2sh-p2wsh', 'p2sh'];
const KEY_CATEGORIES: readonly MultisigKeyCategory[] = ['hardware', 'mobile', 'recovery'];
const DEVICE_TYPES: readonly Exclude<MultisigDeviceType, null>[] = [
	'trezor',
	'ledger',
	'coldcard',
	'bitbox02',
	'jade',
	'qr',
	'file'
];

export interface WizardProgressKey {
	name: string;
	category: MultisigKeyCategory;
	deviceType: MultisigDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
}

export interface WizardProgress {
	step: WizardStepKey;
	preset: WizardPreset;
	customM: number;
	customN: number;
	scriptType: MultisigScriptType;
	keys: WizardProgressKey[];
	/** The solo/shared custody-path choice (BIP-45 vs BIP-48 purpose), locked
	 *  once the first key is added. null = not asked yet, or an imported config
	 *  that skipped the question entirely. */
	vaultMode: WizardVaultMode | null;
	configImported: boolean;
	importedStartIndex: number;
	multisigName: string;
	savedAt: number;
}

function isValidKey(v: unknown): v is WizardProgressKey {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === 'string' &&
		typeof o.category === 'string' &&
		KEY_CATEGORIES.includes(o.category as MultisigKeyCategory) &&
		(o.deviceType === null ||
			(typeof o.deviceType === 'string' &&
				DEVICE_TYPES.includes(o.deviceType as Exclude<MultisigDeviceType, null>))) &&
		typeof o.xpub === 'string' &&
		o.xpub.length > 0 &&
		typeof o.fingerprint === 'string' &&
		/^[0-9a-f]{8}$/.test(o.fingerprint) &&
		typeof o.path === 'string' &&
		/^m(\/\d+'?)+$/.test(o.path)
	);
}

/**
 * Parse a stored snapshot back into wizard progress. Returns null for
 * anything unusable — malformed JSON, a stale save, an unknown enum value,
 * an invalid quorum, or any cosigner key that doesn't shape-check — so a bad
 * snapshot can never wedge the wizard; it just starts fresh.
 *
 * Unlike the single-sig wizard's preview rows (recomputable, so malformed
 * rows are filtered and the rest kept), a single bad cosigner key here
 * invalidates the WHOLE snapshot rather than being dropped: silently losing
 * one key from the middle of the array would show "3 of 5 added" with no way
 * for the user to tell which ceremony needs redoing. A corrupt blob is
 * globally suspect; an honest fresh start beats a subtly wrong resume.
 *
 * The quorum fields (preset/customM/customN/scriptType) are foundational for
 * the same reason: every added key was validated against that scriptType at
 * add time, so corruption there puts the keys' provenance in doubt too —
 * reject outright rather than clamp back to the quorum step.
 *
 * A snapshot on the Review or Confirm step whose key count no longer matches
 * the quorum's total (e.g. hand-edited storage, or a future version skew) IS
 * clamped, back to the Keys step — that's an ordinary mid-flow state, not
 * corruption, and the keys collected so far are still worth keeping.
 */
export function parseSavedMultisigProgress(raw: string | null, now: number): WizardProgress | null {
	if (!raw) return null;

	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;

	if (typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null;
	if (now - o.savedAt > WIZARD_PROGRESS_MAX_AGE_MS || o.savedAt > now) return null;

	if (typeof o.step !== 'string' || !STEP_KEYS.includes(o.step as WizardStepKey)) return null;
	const step = o.step as WizardStepKey;

	if (typeof o.preset !== 'string' || !PRESETS.includes(o.preset as WizardPreset)) return null;
	const preset = o.preset as WizardPreset;

	if (typeof o.customM !== 'number' || !Number.isInteger(o.customM)) return null;
	if (typeof o.customN !== 'number' || !Number.isInteger(o.customN)) return null;
	const customM = o.customM;
	const customN = o.customN;

	if (typeof o.scriptType !== 'string' || !SCRIPT_TYPES.includes(o.scriptType as MultisigScriptType)) {
		return null;
	}
	const scriptType = o.scriptType as MultisigScriptType;

	const threshold = preset === '2of3' ? 2 : preset === '3of5' ? 3 : customM;
	const totalKeys = preset === '2of3' ? 3 : preset === '3of5' ? 5 : customN;
	const quorumValid =
		Number.isInteger(threshold) &&
		Number.isInteger(totalKeys) &&
		threshold >= 1 &&
		totalKeys >= threshold &&
		totalKeys <= 15;
	if (!quorumValid) return null;

	if (!Array.isArray(o.keys) || !o.keys.every(isValidKey)) return null;
	const keys = o.keys as WizardProgressKey[];

	let vaultMode: WizardVaultMode | null;
	if (o.vaultMode === null) vaultMode = null;
	else if (typeof o.vaultMode === 'string' && VAULT_MODES.includes(o.vaultMode as WizardVaultMode)) {
		vaultMode = o.vaultMode as WizardVaultMode;
	} else return null;

	if (typeof o.configImported !== 'boolean') return null;
	const configImported = o.configImported;

	if (typeof o.importedStartIndex !== 'number' || !Number.isInteger(o.importedStartIndex) || o.importedStartIndex < 0) {
		return null;
	}
	const importedStartIndex = o.importedStartIndex;

	const multisigName = typeof o.multisigName === 'string' ? o.multisigName : '';

	// Review/Confirm only make sense once every slot is filled — clamp back to
	// Keys otherwise. This is a normal mid-flow state (not corruption), so the
	// keys collected so far are kept rather than the snapshot discarded.
	let resolvedStep = step;
	if ((resolvedStep === 'review' || resolvedStep === 'confirm') && keys.length !== totalKeys) {
		resolvedStep = 'keys';
	}

	return {
		step: resolvedStep,
		preset,
		customM,
		customN,
		scriptType,
		keys,
		vaultMode,
		configImported,
		importedStartIndex,
		multisigName,
		savedAt: o.savedAt
	};
}

/** True when a snapshot holds progress worth telling the user about. */
export function hasMeaningfulMultisigProgress(p: WizardProgress): boolean {
	if (p.step !== 'why') return true;
	return (
		p.keys.length > 0 ||
		p.vaultMode !== null ||
		p.preset !== '2of3' ||
		p.customM !== 2 ||
		p.customN !== 3 ||
		p.scriptType !== 'p2wsh' ||
		p.multisigName.trim() !== ''
	);
}
