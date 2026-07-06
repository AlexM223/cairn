// Session-scoped persistence for the add-wallet wizard (single-sig).
//
// The wizard keeps every bit of progress — current step, chosen key source,
// the validated key and its address preview — in ephemeral component state.
// Any full-page reload therefore used to restart it from the beginning: on
// Umbrel, app_proxy's auth layer can force exactly such a reload mid-wizard,
// which users experienced as "I confirmed the addresses and it threw me back
// to the choose-your-method step". Snapshotting progress into sessionStorage
// (tab-scoped, auto-cleared when the tab closes) lets a remounted wizard
// resume where the user left off instead.
//
// Only PUBLIC key material is ever stored (the xpub and addresses derived
// from it) — the same data already rendered into the page's DOM.

import type { ScriptType, WalletDeviceType } from '$lib/types';

export const WIZARD_PROGRESS_KEY = 'cairn.add-wallet-wizard.v1';

/** A resume older than this is stale — likely a forgotten tab, not a reload. */
export const WIZARD_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

const METHODS = ['trezor', 'ledger', 'coldcard', 'bitbox02', 'jade', 'qr', 'paste'] as const;
export type WizardMethod = (typeof METHODS)[number];

const SCRIPT_TYPES: readonly ScriptType[] = ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'];
const DEVICE_TYPES: readonly WalletDeviceType[] = [
	'trezor',
	'ledger',
	'coldcard',
	'bitbox02',
	'jade',
	'jade-qr',
	'qr',
	'file'
];

export interface WizardProgress {
	/** 0 Type · 1 Key · 2 Preview · 3 Name. The Done step is never saved. */
	step: 0 | 1 | 2 | 3;
	method: WizardMethod | null;
	readMethod: WizardMethod | null;
	deviceType: WalletDeviceType | null;
	xpubInput: string;
	validatedXpub: string;
	preview: { address: string; path: string }[];
	scriptType: ScriptType | null;
	name: string;
	savedAt: number;
}

function isPreviewRow(v: unknown): v is { address: string; path: string } {
	return (
		typeof v === 'object' &&
		v !== null &&
		typeof (v as Record<string, unknown>).address === 'string' &&
		typeof (v as Record<string, unknown>).path === 'string'
	);
}

/**
 * Parse a stored snapshot back into wizard progress. Returns null for
 * anything unusable — malformed JSON, a stale save, an unknown enum value —
 * so a bad snapshot can never wedge the wizard; it just starts fresh.
 *
 * A snapshot claiming a step its data can't support (e.g. the Preview step
 * with no validated key) is clamped back to the Key step rather than
 * discarded: the user's chosen method and pasted text are still worth
 * restoring.
 */
export function parseSavedProgress(raw: string | null, now: number): WizardProgress | null {
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

	const method = METHODS.includes(o.method as WizardMethod) ? (o.method as WizardMethod) : null;
	const readMethod = METHODS.includes(o.readMethod as WizardMethod)
		? (o.readMethod as WizardMethod)
		: null;
	const deviceType = DEVICE_TYPES.includes(o.deviceType as WalletDeviceType)
		? (o.deviceType as WalletDeviceType)
		: null;
	const scriptType = SCRIPT_TYPES.includes(o.scriptType as ScriptType)
		? (o.scriptType as ScriptType)
		: null;
	const xpubInput = typeof o.xpubInput === 'string' ? o.xpubInput : '';
	const validatedXpub = typeof o.validatedXpub === 'string' ? o.validatedXpub : '';
	const preview = Array.isArray(o.preview) ? o.preview.filter(isPreviewRow) : [];
	const name = typeof o.name === 'string' ? o.name : '';

	let step: WizardProgress['step'];
	if (o.step === 0 || o.step === 1 || o.step === 2 || o.step === 3) step = o.step;
	else return null;

	// The Preview and Name steps only make sense with a server-validated key
	// and its derived addresses in hand.
	if (step >= 2 && (!validatedXpub || !scriptType || preview.length === 0)) step = 1;

	return {
		step,
		method,
		readMethod,
		deviceType,
		xpubInput,
		validatedXpub,
		preview,
		scriptType,
		name,
		savedAt: o.savedAt
	};
}

/** True when a snapshot holds progress worth telling the user about. */
export function hasMeaningfulProgress(p: WizardProgress): boolean {
	return p.step >= 2 || (p.step === 1 && (p.method !== null || p.xpubInput.trim() !== ''));
}
