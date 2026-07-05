// BitBox02 hardware-wallet driver — bitbox-api (Rust→WASM) over WebHID.
//
// Framework-agnostic on purpose: no Svelte, no DOM beyond the WebHID feature
// check, so the pure logic (keypath derivation, xpub prefix normalization,
// scriptConfig construction) is unit-testable without a device. The heavy
// bitbox-api WASM module is imported lazily inside the functions that need it —
// never at module top level — so SSR and non-BitBox users never pay to load it,
// and the WebHID globals it touches are only referenced in a browser after a
// click. (bitbox-api's own entry module runs a top-level `await` around WASM
// instantiation; vite-plugin-top-level-await + vite-plugin-wasm handle that,
// and vite.config.ts already excludes it from esbuild pre-bundling.)
//
// Cairn holds no private keys: the device signs. Unlike the Ledger/Trezor
// drivers, which return per-input signatures we merge back ourselves, the
// BitBox02 signs a PSBT and returns the fully-signed PSBT as base64 directly
// (btcSignPSBT). The pure part here is therefore the request shape — the
// scriptConfig + account keypath — not a signature merge-back.
//
// Connection posture: WebHID only (Chrome/Edge/Brave desktop), mirroring the
// Ledger driver's Chromium-only stance. bitbox-api can also fall back to the
// locally-installed BitBoxBridge native app for Firefox/Safari (which lack
// WebHID) via bitbox02ConnectAuto; Cairn treats that as a documented
// unsupported gap for v1 and connects strictly over WebHID (bitbox02ConnectWebHID),
// throwing a clear `unsupported-browser` error when navigator.hid is absent.
//
// PAIRING PERSISTENCE (follow-up, intentionally not built here): the first
// WebHID connection performs a Noise-protocol pairing (trust-on-first-use
// pubkey pinning) whose confirmation code the user verifies on-device. The
// bitbox-api WASM persists the pinned key in localStorage on its own; Cairn's
// pairing therefore works per-session without any Cairn-side storage. A
// server-side `bitbox02_pairings` table (so a pairing survives a browser-data
// wipe, analogous to Cairn's ledger_multisig_registrations) is a deliberate
// separate follow-on — NOT added in this unit, and db.ts is untouched.

import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ScriptType } from '$lib/types';

// ---- Types imported for annotations only (erased at build, no runtime load) --
// bitbox-api ships generated .d.ts types; importing them as `import type` never
// pulls the WASM module into the bundle.
import type {
	BitBox as BitBoxType,
	PairedBitBox as PairedBitBoxType,
	PairingBitBox as PairingBitBoxType
} from 'bitbox-api';

const HARDENED = 0x80000000;

/**
 * A typed error the UI can present verbatim. `code` lets callers branch (e.g.
 * "confirm the pairing code" vs "unlock your device") without string-matching.
 * Mirrors LedgerError/TrezorError.
 */
export type Bitbox02ErrorCode =
	| 'unsupported-browser' // WebHID not present (Firefox/Safari — BitBoxBridge unsupported in v1)
	| 'unavailable' // secure-context / navigator missing entirely
	| 'device_locked' // device not unlocked (PIN not entered)
	| 'pairing_rejected' // user declined the on-device pairing confirmation
	| 'rejected' // user declined an operation on-device
	| 'no_device' // no device chosen from the browser picker / disconnected
	| 'unsupported_script_type' // e.g. p2pkh (device single-sig has no BIP44) or p2sh multisig
	| 'bad_psbt' // PSBT the device could not sign
	| 'wrong_device' // the connected BitBox02 holds none of the multisig's keys
	| 'unexpected'; // anything else

export class Bitbox02Error extends Error {
	constructor(
		message: string,
		public readonly code: Bitbox02ErrorCode,
		options?: { cause?: unknown }
	) {
		super(message);
		this.name = 'Bitbox02Error';
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

/** True only in a browser that exposes WebHID (Chromium desktop, secure context). */
export function isWebHidAvailable(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		typeof (navigator as Navigator & { hid?: unknown }).hid !== 'undefined' &&
		!!(navigator as Navigator & { hid?: unknown }).hid
	);
}

// ---------------------------------------------------------------- single-sig
//
// The BitBox02's single-sig ("simple") script configs are p2wpkhP2sh (BIP-49),
// p2wpkh (BIP-84) and p2tr (BIP-86). There is deliberately NO p2pkh (BIP-44)
// simple type in the firmware — legacy single-sig is unsupported on the device,
// so Cairn cannot read a BIP-44 key from a BitBox02. bitbox02SupportsScriptType
// / the driver reject it with a clear `unsupported_script_type` error rather
// than letting the device fail opaquely mid-flow.

/** The device's single-sig ("simple") script-config discriminant. */
export type BitboxSimpleType = 'p2wpkhP2sh' | 'p2wpkh' | 'p2tr';

/** Cairn ScriptType → device BtcSimpleType. p2pkh maps to null (unsupported). */
const SIMPLE_TYPE: Record<ScriptType, BitboxSimpleType | null> = {
	p2pkh: null, // BIP-44 legacy — the BitBox02 firmware has no simple type for it
	'p2sh-p2wpkh': 'p2wpkhP2sh', // BIP-49
	p2wpkh: 'p2wpkh', // BIP-84
	p2tr: 'p2tr' // BIP-86
};

/** Cairn ScriptType → BIP purpose (the first, hardened path element). */
const SCRIPT_PURPOSE: Record<ScriptType, number> = {
	p2pkh: 44,
	'p2sh-p2wpkh': 49,
	p2wpkh: 84,
	p2tr: 86
};

/**
 * Whether the BitBox02 can act as a SINGLE-SIG signer/key-source for a given
 * script type. False for p2pkh (BIP-44), which the device firmware does not
 * support as a simple script config. Exported so the single-sig import picker
 * can grey out / hide the BitBox02 tile for legacy p2pkh wallets.
 */
export function bitbox02SupportsScriptType(scriptType: ScriptType): boolean {
	return SIMPLE_TYPE[scriptType] != null;
}

/**
 * The standard single-sig account keypath for a script type:
 *   m/44'/0'/{account}'  p2pkh (rejected — see bitbox02SupportsScriptType)
 *   m/49'/0'/{account}'  p2sh-p2wpkh
 *   m/84'/0'/{account}'  p2wpkh
 *   m/86'/0'/{account}'  p2tr
 * Mainnet (coin 0'), matching the rest of Cairn. Returns the apostrophe string
 * form the device accepts (Keypath = string | number[]). Exported for unit
 * testing — this is load-bearing pure logic.
 */
export function singleSigAccountPath(scriptType: ScriptType, account = 0): string {
	const purpose = SCRIPT_PURPOSE[scriptType];
	if (purpose === undefined) {
		throw new Bitbox02Error(`Unsupported script type "${scriptType}".`, 'unsupported_script_type');
	}
	if (!bitbox02SupportsScriptType(scriptType)) {
		throw new Bitbox02Error(
			'The BitBox02 does not support legacy (P2PKH) single-sig accounts. Choose a SegWit or Taproot address type.',
			'unsupported_script_type'
		);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw new Bitbox02Error(`Invalid account index ${account}.`, 'unexpected');
	}
	return `m/${purpose}'/0'/${account}'`;
}

// ----------------------------------------------------------------- multisig
//
// BitBox02 multisig ("multisig") uses BtcMultisigScriptType = 'p2wsh' |
// 'p2wshP2sh' — the device supports native P2WSH and P2SH-wrapped-P2WSH ONLY.
// Plain legacy P2SH multisig is NOT a device script type (Caravan's own BitBox
// code throws for it too). Cairn's multisig feature additionally supports plain
// 'p2sh' (see src/lib/server/db.ts multisigs.script_type), so a BitBox02 cannot
// sign for a plain-P2SH Cairn multisig — bitbox02SupportsMultisigScriptType
// returns false for it so the signer/picker UI can grey it out with copy
// instead of failing mid-flow.

/** Cairn's three multisig script forms — mirrors multisig.ts's MultisigScriptType
 *  (duplicated here so this browser driver never imports server code). */
export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/** The device's multisig script-config discriminant. */
export type BitboxMultisigScriptType = 'p2wsh' | 'p2wshP2sh';

/** Cairn MultisigScriptType → device BtcMultisigScriptType. p2sh → null (unsupported). */
const MULTISIG_TYPE: Record<MultisigScriptType, BitboxMultisigScriptType | null> = {
	p2wsh: 'p2wsh',
	'p2sh-p2wsh': 'p2wshP2sh',
	p2sh: null // legacy P2SH multisig — no device script type exists for it
};

/**
 * Whether the BitBox02 can act as a MULTISIG signer for a given multisig script
 * type. False ONLY for plain 'p2sh' (the device's BtcMultisigScriptType has no
 * legacy-P2SH variant). Exported so the picker/signer UI can grey out the
 * BitBox02 option specifically when a multisig's script_type === 'p2sh', with
 * copy explaining why, rather than letting the user hit a confusing mid-flow
 * failure. (Required by §2.1 of the hardware plan.)
 */
export function bitbox02SupportsMultisigScriptType(scriptType: MultisigScriptType): boolean {
	return MULTISIG_TYPE[scriptType] != null;
}

/**
 * The BIP-48 account keypath for a multisig cosigner key:
 * m/48'/0'/{account}'/{script}' where the script suffix is 2' for p2wsh and 1'
 * for p2sh-p2wsh (BIP-48 gives native p2wsh 2' and wrapped p2sh-p2wsh 1'). The
 * device does not support plain p2sh multisig (rejected here). Mainnet only.
 * Returns the apostrophe string form. Exported for unit testing.
 */
export function multisigAccountPath(scriptType: MultisigScriptType, account = 0): string {
	if (!bitbox02SupportsMultisigScriptType(scriptType)) {
		throw new Bitbox02Error(
			'The BitBox02 cannot sign for a legacy (plain P2SH) multisig — it supports only P2WSH and P2SH-P2WSH multisigs.',
			'unsupported_script_type'
		);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw new Bitbox02Error(`Invalid account index ${account}.`, 'unexpected');
	}
	const sub = scriptType === 'p2wsh' ? 2 : 1;
	return `m/48'/0'/${account}'/${sub}'`;
}

// ------------------------------------------------------ xpub normalization
//
// The device can return an xpub under any SLIP-132 prefix (btcXpub's XPubType).
// We always REQUEST a standard 'xpub' from the device, but keep this
// normalization helper for defence-in-depth and testability: a SLIP-132 prefix
// (ypub/zpub/Ypub/Zpub) is rewritten to standard xpub bytes so downstream
// parseXpub/HDKey code sees a canonical key, matching how xpub.ts /
// multisig.ts canonicalize. Anything else (including invalid input) passes
// through unchanged so later parsing surfaces the real error.

const XPUB_VERSION = 0x0488b21e;
const SLIP132_VERSIONS = new Set([
	0x049d7cb2, // ypub  (BIP49 single-sig)
	0x04b24746, // zpub  (BIP84 single-sig)
	0x0295b43f, // Ypub  (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub  (p2wsh multisig)
]);
const b58check = /* @__PURE__ */ createBase58check(sha256);

/**
 * Rewrite a SLIP-132 prefix (ypub/zpub/Ypub/Zpub) to standard xpub bytes;
 * anything else passes through unchanged. Exported for unit testing.
 */
export function normalizeXpub(input: string): string {
	const trimmed = input.trim();
	let raw: Uint8Array;
	try {
		raw = b58check.decode(trimmed);
	} catch {
		return trimmed;
	}
	if (raw.length !== 78) return trimmed;
	const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
	if (!SLIP132_VERSIONS.has(version)) return trimmed;
	const out = new Uint8Array(raw);
	out[0] = (XPUB_VERSION >>> 24) & 0xff;
	out[1] = (XPUB_VERSION >>> 16) & 0xff;
	out[2] = (XPUB_VERSION >>> 8) & 0xff;
	out[3] = XPUB_VERSION & 0xff;
	return b58check.encode(out);
}

// --------------------------------------------------------- scriptConfig build
//
// The device's BtcScriptConfig is a tagged union. These builders are the
// load-bearing pure logic for signing: a single-sig config carries just its
// simpleType; a multisig config carries the threshold, the FULL ordered xpub
// set, this device's index within that set (ourXpubIndex), and the script type.
// Building them here (not inline in the device flow) keeps them unit-testable.

/** A device single-sig script config, as bitbox-api's BtcScriptConfig expects. */
export interface BitboxSimpleScriptConfig {
	simpleType: BitboxSimpleType;
}

/** A device multisig script config, as bitbox-api's BtcScriptConfig expects. */
export interface BitboxMultisigScriptConfig {
	multisig: {
		threshold: number;
		xpubs: string[];
		ourXpubIndex: number;
		scriptType: BitboxMultisigScriptType;
	};
}

/** Build the single-sig script config for a script type. Throws for p2pkh. */
export function buildSimpleScriptConfig(scriptType: ScriptType): BitboxSimpleScriptConfig {
	const simpleType = SIMPLE_TYPE[scriptType];
	if (simpleType == null) {
		throw new Bitbox02Error(
			'The BitBox02 does not support this single-sig address type.',
			'unsupported_script_type'
		);
	}
	return { simpleType };
}

/** One cosigner key, exactly as a Cairn multisig stores it (MultisigKeyRow shape). */
export interface MultisigSignKey {
	/** Account xpub (SLIP-132 accepted, normalized internally). */
	xpub: string;
	/** Master fingerprint, 8 hex chars ("00000000" when unknown). */
	fingerprint: string;
	/** Account origin path, e.g. "m/48'/0'/0'/2'" ("m" when unknown). */
	path: string;
}

/**
 * Build the device multisig script config for a Cairn multisig, given which key
 * is THIS device (ourXpubIndex). The device requires:
 *   - every cosigner xpub, in the SAME ORDER for every call and for registration
 *     (Cairn passes keys in its stored order; the device pins the registration
 *     to this exact ordered set + our index, so it must be stable);
 *   - ourXpubIndex: the position of this device's key in that array;
 *   - the device script type (p2wsh | p2wshP2sh).
 * xpubs are canonicalized to standard xpub form. Exported for unit testing.
 */
export function buildMultisigScriptConfig(
	keys: MultisigSignKey[],
	ourXpubIndex: number,
	threshold: number,
	scriptType: MultisigScriptType
): BitboxMultisigScriptConfig {
	const deviceScriptType = MULTISIG_TYPE[scriptType];
	if (deviceScriptType == null) {
		throw new Bitbox02Error(
			'The BitBox02 cannot sign for a legacy (plain P2SH) multisig — it supports only P2WSH and P2SH-P2WSH multisigs.',
			'unsupported_script_type'
		);
	}
	if (!Array.isArray(keys) || keys.length === 0) {
		throw new Bitbox02Error('This multisig has no keys.', 'unexpected');
	}
	if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) {
		throw new Bitbox02Error(
			`Invalid multisig threshold ${threshold} for ${keys.length} keys.`,
			'unexpected'
		);
	}
	if (!Number.isInteger(ourXpubIndex) || ourXpubIndex < 0 || ourXpubIndex >= keys.length) {
		throw new Bitbox02Error(`Invalid device key index ${ourXpubIndex}.`, 'unexpected');
	}
	return {
		multisig: {
			threshold,
			xpubs: keys.map((k) => normalizeXpub(k.xpub)),
			ourXpubIndex,
			scriptType: deviceScriptType
		}
	};
}

// ---------------------------------------------------------------- error map
//
// bitbox-api raises typed errors; run any caught value through the library's
// own ensureError() to get { code: string, message: string }. We map the codes
// we care about (user abort → rejected, etc.) to Cairn's typed error, and fall
// back to the library's message otherwise. `isUserAbort` is the library's own
// helper for the on-device cancel case.

/** The typed-error shape bitbox-api's ensureError returns. */
interface BitboxApiError {
	code?: string;
	message?: string;
}

/**
 * Translate a raw error into a typed Bitbox02Error. `deps` supplies the
 * library's ensureError/isUserAbort so this stays usable inside the device
 * flow (which has the module loaded); a plain fallback covers callers without
 * them. Exported for unit testing (pass a stub `deps`).
 */
export function toBitbox02Error(
	err: unknown,
	// isUserAbort's param is intentionally loose: the library types it against its
	// own Error subtype (with a required `code`), so a stricter signature here
	// would refuse the module object callers pass in. We only ever call it with a
	// real Error at the guarded site below.
	deps?: {
		ensureError?: (e: unknown) => BitboxApiError;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		isUserAbort?: (e: any) => boolean;
	}
): Bitbox02Error {
	if (err instanceof Bitbox02Error) return err;

	let typed: BitboxApiError | null = null;
	try {
		typed = deps?.ensureError ? deps.ensureError(err) : null;
	} catch {
		typed = null;
	}
	const raw = err as { code?: unknown; message?: unknown } | null;
	const code = String(typed?.code ?? (raw && raw.code) ?? '');
	const msg = String(typed?.message ?? (raw && raw.message) ?? err ?? '');

	// On-device cancel: prefer the library's own predicate when available.
	let aborted = false;
	try {
		if (deps?.isUserAbort && err instanceof Error) aborted = deps.isUserAbort(err);
	} catch {
		aborted = false;
	}
	if (aborted || /user-abort|user_abort|aborted|cancell?ed|declined/i.test(code + ' ' + msg)) {
		return new Bitbox02Error('You cancelled the request on the BitBox02.', 'rejected', { cause: err });
	}
	if (/unpaired|pairing|noise/i.test(code + ' ' + msg)) {
		return new Bitbox02Error(
			'Pairing was not completed. Reconnect and confirm the pairing code on the BitBox02.',
			'pairing_rejected',
			{ cause: err }
		);
	}
	if (/locked|not-initialized|uninitialized|password/i.test(code + ' ' + msg)) {
		return new Bitbox02Error(
			'Unlock your BitBox02 (enter your password), then connect again.',
			'device_locked',
			{ cause: err }
		);
	}
	if (
		/no device|not.?found|disconnect|NotFoundError|no-device/i.test(code + ' ' + msg) ||
		(raw as { name?: string })?.name === 'NotFoundError'
	) {
		return new Bitbox02Error(
			'No BitBox02 was selected. Plug it in, unlock it, then pick it from the browser prompt.',
			'no_device',
			{ cause: err }
		);
	}
	return new Bitbox02Error(
		msg ? `BitBox02 error: ${msg}` : 'The BitBox02 request failed.',
		'unexpected',
		{ cause: err }
	);
}

// ---------------------------------------------------------------- device I/O
//
// Everything below touches the device: it lazily loads the WASM module,
// connects over WebHID, pairs, runs one operation, and closes in a finally.
// The pure logic above is what the tests exercise; these functions are the thin
// device-talking shells around it (unit-tested only for their up-front guards).

type BitboxModule = typeof import('bitbox-api');

/** Lazily import the bitbox-api WASM module. Kept inside the device flow so
 *  nothing WASM-related is evaluated during SSR or for users who never click. */
async function loadBitbox(): Promise<BitboxModule> {
	return import('bitbox-api');
}

/**
 * Connect over WebHID, unlock, and pair, returning a PairedBitBox plus the
 * loaded module (for error mapping) and a close() helper. WebHID only — throws
 * `unsupported-browser` when navigator.hid is absent (Firefox/Safari), mirroring
 * Ledger's Chromium-only posture; BitBoxBridge fallback is a documented gap.
 *
 * `onPairingCode` is invoked with the trust-on-first-use pairing code (first
 * connection only) so the UI can display it while the user confirms on-device.
 * On a device that was paired and persisted before, the code is undefined and
 * the callback is not invoked.
 */
async function connectAndPair(
	mod: BitboxModule,
	onPairingCode?: (code: string) => void
): Promise<{ paired: PairedBitBoxType; close: () => void }> {
	if (!isWebHidAvailable()) {
		throw new Bitbox02Error(
			'The BitBox02 needs a Chromium-based desktop browser (Chrome, Edge, or Brave) with WebHID, served over HTTPS or localhost. Firefox and Safari are not supported.',
			'unsupported-browser'
		);
	}

	let unpaired: BitBoxType;
	try {
		// WebHID-only connect (never the BitBoxBridge auto-fallback).
		unpaired = await mod.bitbox02ConnectWebHID(undefined);
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	let pairing: PairingBitBoxType;
	try {
		pairing = await unpaired.unlockAndPair();
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	// First-connection pairing: show the code and block on the user's on-device
	// confirmation. Already-persisted pairings return undefined here.
	try {
		const code = pairing.getPairingCode();
		if (code !== undefined && onPairingCode) onPairingCode(code);
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	let paired: PairedBitBoxType;
	try {
		paired = await pairing.waitConfirm();
	} catch (err) {
		throw toBitbox02Error(err, mod);
	}

	return {
		paired,
		close: () => {
			try {
				paired.close();
			} catch {
				/* releasing the HID handle is best-effort */
			}
		}
	};
}

/** BitBox02 uses mainnet 'btc' throughout (Cairn is mainnet only). */
const COIN = 'btc' as const;

/**
 * Read a SINGLE-SIG account key straight from a connected BitBox02 for the
 * single-sig import wizard: the account xpub at the standard BIP-49/84/86 path
 * plus the device's root fingerprint. Returns exactly the { xpub, fingerprint,
 * path } shape Cairn's wallet keys store (standard xpub form, apostrophe path).
 *
 * The device shows an on-device confirmation for a public-key read; the UI copy
 * should say "Confirm on the BitBox02 when it asks." (display: true so the user
 * can cross-check the xpub on the device screen). p2pkh (BIP-44) is rejected
 * up-front — the firmware has no legacy single-sig config.
 */
export async function readSingleSigKeyFromBitbox02(
	scriptType: ScriptType,
	account = 0,
	onPairingCode?: (code: string) => void
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	// Validate before touching the device — reject p2pkh with a clear message.
	const path = singleSigAccountPath(scriptType, account);

	const mod = await loadBitbox();
	const { paired, close } = await connectAndPair(mod, onPairingCode);
	try {
		let fingerprint: string;
		let xpub: string;
		try {
			fingerprint = await paired.rootFingerprint();
			// Request a STANDARD xpub prefix; the device would warn for a
			// non-standard keypath, but these are the standard BIP-49/84/86 paths.
			xpub = await paired.btcXpub(COIN, path, 'xpub', false);
		} catch (err) {
			throw toBitbox02Error(err, mod);
		}
		return { xpub: normalizeXpub(xpub), fingerprint: fingerprint.toLowerCase(), path };
	} finally {
		close();
	}
}

/**
 * Read a MULTISIG cosigner key straight from a connected BitBox02 for the
 * multisig creation wizard: the BIP-48 account xpub at m/48'/0'/{account}'/{2|1}'
 * plus the device's root fingerprint. Mirrors readMultisigKeyFromLedger. Plain
 * p2sh multisig is rejected up-front (the device has no config for it).
 *
 * Returns exactly the { xpub, fingerprint, path } shape multisig keys store.
 */
export async function readMultisigKeyFromBitbox02(
	scriptType: MultisigScriptType,
	account = 0,
	onPairingCode?: (code: string) => void
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	const path = multisigAccountPath(scriptType, account);

	const mod = await loadBitbox();
	const { paired, close } = await connectAndPair(mod, onPairingCode);
	try {
		let fingerprint: string;
		let xpub: string;
		try {
			fingerprint = await paired.rootFingerprint();
			xpub = await paired.btcXpub(COIN, path, 'xpub', false);
		} catch (err) {
			throw toBitbox02Error(err, mod);
		}
		return { xpub: normalizeXpub(xpub), fingerprint: fingerprint.toLowerCase(), path };
	} finally {
		close();
	}
}

/** Parameters for a BitBox02 PSBT signing call. */
export interface Bitbox02SignParams {
	/**
	 * The script config + account keypath the device signs under. For single-sig
	 * this is buildSimpleScriptConfig(scriptType) + singleSigAccountPath(...); for
	 * multisig, buildMultisigScriptConfig(...) + multisigAccountPath(...). Passing
	 * these explicitly (rather than inferring) matches the plan's signature and
	 * lets the caller reuse the pure builders above.
	 */
	scriptConfig: BitboxSimpleScriptConfig | BitboxMultisigScriptConfig;
	/** Account keypath (apostrophe string or index array). */
	keypath: string | number[];
}

/**
 * Sign a PSBT with a connected BitBox02 and return the signed PSBT as base64.
 *
 * Unlike the Ledger/Trezor drivers, the device signs the PSBT and returns the
 * fully-signed PSBT directly (btcSignPSBT) — there is no per-input signature
 * merge-back to do here; the device merges its partial signatures into the PSBT
 * itself. The returned PSBT still commits to the exact inputs/outputs the user
 * reviewed on-device, and the parent Sign step re-checks that commitment
 * server-side (assertSameTransaction), same as the other drivers.
 *
 * For a MULTISIG PSBT the script config must be REGISTERED on the device first
 * (btcRegisterScriptConfig, checked lazily via btcIsScriptConfigRegistered) —
 * that registration flow is a separate signer-component concern (Unit F) and is
 * NOT performed here; this function assumes single-sig or an already-registered
 * multisig config. (A `bitbox02_multisig_registrations` table, analogous to
 * ledger_multisig_registrations, is the follow-on that makes registration
 * persistent — deliberately not built in this driver unit.)
 */
export async function signPsbtWithBitbox02(
	psbtBase64: string,
	params: Bitbox02SignParams
): Promise<string> {
	if (typeof psbtBase64 !== 'string' || psbtBase64.trim() === '') {
		throw new Bitbox02Error('No transaction to sign.', 'bad_psbt');
	}

	const mod = await loadBitbox();
	const { paired, close } = await connectAndPair(mod);
	try {
		let signed: string;
		try {
			// force_script_config carries the script config + account keypath; the
			// device signs every input it recognizes under that config. format_unit
			// 'default' shows amounts in BTC on the device screen.
			signed = await paired.btcSignPSBT(
				COIN,
				psbtBase64.trim(),
				{ scriptConfig: params.scriptConfig, keypath: params.keypath },
				'default'
			);
		} catch (err) {
			throw toBitbox02Error(err, mod);
		}
		return signed;
	} finally {
		close();
	}
}
