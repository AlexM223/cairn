// Blockstream Jade hardware-wallet signer — USB (Web Serial) driver.
//
// ⚠️ MAINTENANCE RISK (Cairn hardware plan §2.2). Blockstream ships NO official
// JS/TypeScript SDK for Jade — its only official client is Python. This driver
// depends on `jadets` (npm), an unofficial, thin, single-maintainer TypeScript
// reimplementation of Jade's CBOR-RPC protocol (github.com/Austin-Fulbright/
// jadets, created 2025). It is what a real production coordinator (Caravan)
// ships with today, but it is young and lightly maintained. We therefore:
//   - pin the version and never auto-update (foundation: jadets@^1.1.18);
//   - defensively wrap EVERY jadets call in try/catch → JadeError, never
//     trusting an unhandled shape to bubble up as a raw Error;
//   - keep all pure, testable logic (path derivation, SLIP-132 xpub
//     normalization, descriptor adaptation) OUT of the device-I/O functions so
//     the bulk of this file is verifiable without hardware or the library.
// If jadets proves unreliable, the fallback (per §2.2) is a hand-rolled CBOR-RPC
// client over Web Serial — larger effort, only worth it if this breaks.
//
// Framework-agnostic on purpose: no Svelte, no DOM beyond the Web Serial feature
// check. The heavy jadets module is imported lazily inside each device function
// — never at module top level — so SSR and non-Jade users never pay to load it,
// and the navigator.serial globals it touches are only referenced in a browser
// after a click.
//
// Cairn holds no private keys: the device signs. We hand Jade the exact unsigned
// PSBT built by src/lib/server/bitcoin/psbt.ts and receive the signed PSBT back.
// The parent Sign step re-checks that the returned transaction commits to the
// same inputs/outputs the user reviewed (assertSameTransaction).
//
// This module covers the USB / Web Serial path ONLY. Jade's air-gapped QR mode
// uses BC-UR (a different codec from Cairn's existing BBQr) and is a separate
// follow-on driver (hw/jadeUr.ts, plan Unit E2) — not built here.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ScriptType } from '$lib/types';
import {
	HARDENED,
	HwError,
	SINGLE_SIG_VERSIONS,
	b58check,
	formatKeyPath,
	multisigAccountPathIndexes as sharedMultisigAccountPathIndexes,
	parseKeyPath as sharedParseKeyPath,
	singleSigAccountPathIndexes,
	xpubWithVersion,
	type MultisigScriptType,
	type MultisigSignKey
} from './common';

// ---- Types imported for annotations only (erased at build, no runtime load) --
import type { MultisigDescriptor, SignerDescriptor } from 'jadets';

// Cairn is mainnet-only, matching the rest of the codebase. jadets' network
// strings are "mainnet"/"testnet" (see its getFingerprintFromXpub).
const JADE_NETWORK = 'mainnet';

/**
 * A typed error the UI can present verbatim. `code` lets callers branch (e.g.
 * offer "unlock your Jade" vs "use a Chromium browser") without string-matching.
 * Mirrors LedgerError/TrezorError.
 */
export type JadeErrorCode =
	| 'unsupported-browser' // Web Serial not present (non-Chromium / insecure context)
	| 'no_device' // no serial port chosen from the browser picker / disconnected
	| 'auth_failed' // PIN unlock (authUser) did not complete
	| 'rejected' // user declined on-device
	| 'bad_psbt' // the PSBT could not be read / signed
	| 'wrong_device' // the connected Jade holds none of the multisig's keys
	| 'unexpected'; // anything else

export class JadeError extends HwError<JadeErrorCode> {
	constructor(message: string, code: JadeErrorCode, options?: { cause?: unknown }) {
		super('JadeError', message, code, options);
	}
}

/** Builds this driver's typed error for the shared common.ts helpers. */
const jadeFail = (message: string): JadeError => new JadeError(message, 'unexpected');

/** True only in a browser that exposes Web Serial (Chromium desktop, secure
 *  context). Jade USB shares Ledger's Chromium-only posture. */
export function isWebSerialAvailable(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		typeof (navigator as Navigator & { serial?: unknown }).serial !== 'undefined' &&
		!!(navigator as Navigator & { serial?: unknown }).serial
	);
}

// ---------------------------------------------------------------- pure logic
//
// Everything below the device functions is pure and unit-tested without a
// device or the jadets library.

/**
 * The standard single-sig BIP44/49/84/86 account path for a script type, as a
 * hardened-offset index array (the form jadets' getXpub wants): purpose', 0'
 * (mainnet coin type), account'. Mainnet only, matching the rest of Cairn.
 *
 * Exported for unit testing — the load-bearing single-sig derivation.
 */
export function singleSigAccountPath(scriptType: ScriptType, account = 0): number[] {
	return singleSigAccountPathIndexes(scriptType, account, jadeFail);
}

// The multisig script forms live in the client-safe common.ts (shared across
// drivers); re-exported so existing importers of this driver keep working.
export type { MultisigScriptType } from './common';

/**
 * The BIP-48 account path for a FRESH multisig cosigner key:
 * m/48'/0'/{account}'/{script}' where the script suffix is 2' for p2wsh and 1'
 * for p2sh-p2wsh. Throws for bare p2sh — no longer a creation option
 * (cairn-acft; see common.ts). Returned as a hardened-offset index array.
 * Mainnet only. Exported for unit testing.
 */
export function multisigAccountPathIndexes(scriptType: MultisigScriptType, account = 0): number[] {
	return sharedMultisigAccountPathIndexes(scriptType, account, jadeFail);
}

/** Hardened-offset index array → apostrophe-notation path string, e.g.
 *  [84',0',0'] → "m/84'/0'/0'". [] → "m". Exported for unit testing. */
export function formatPath(indexes: number[]): string {
	return formatKeyPath(indexes);
}

/**
 * Rewrite a standard xpub (as Jade returns it) to the SLIP-132 prefix Cairn's
 * single-sig wallets are keyed by for this script type. Taproot stays xpub —
 * and a plain-xpub target still re-encodes, so a SLIP-132 alias arriving here
 * is normalized to the canonical prefix. Anything that doesn't decode to a
 * 78-byte extended key passes through unchanged so later parsing surfaces the
 * real error.
 *
 * Exported for unit testing.
 */
export function toSingleSigXpub(input: string, scriptType: ScriptType): string {
	const targetVersion = SINGLE_SIG_VERSIONS[scriptType];
	if (targetVersion === undefined) {
		throw new JadeError(`Unsupported single-sig script type "${scriptType}".`, 'unexpected');
	}
	return xpubWithVersion(input, targetVersion);
}

// One cosigner key, exactly as the multisig stores it (MultisigKeyRow shape)
// — lives in the client-safe common.ts, re-exported for importers.
export type { MultisigSignKey } from './common';

/** What building a Jade multisig registration needs — the multisig's quorum,
 *  keys, script form, and a display name. */
export interface JadeMultisigParams {
	/** Multisig name; sanitized to a Jade-safe registration name. */
	name: string;
	threshold: number;
	keys: MultisigSignKey[];
	scriptType: MultisigScriptType;
	/**
	 * The cosigner key the connected Jade is expected to be (the roster key this
	 * signature is being collected for). When present, registerMultisigWithJade
	 * verifies the connected device actually holds this key and throws
	 * `wrong_device` otherwise (see assertJadeIsExpectedKey). Optional so the
	 * creation-wizard descriptor build and tests need not supply it.
	 */
	expectedKey?: MultisigSignKey;
}

/** jadets multisig `variant` string per Cairn script form. Jade's sorted-multi
 *  is expressed as variant + `sorted: true` (BIP-67), so the base multi()
 *  variant is what we hand it. */
const JADE_MULTISIG_VARIANT: Record<MultisigScriptType, string> = {
	p2wsh: 'wsh(multi(k))',
	'p2sh-p2wsh': 'sh(wsh(multi(k)))',
	p2sh: 'sh(multi(k))'
};

/** "m/48'/0'/0'/2'" (h/H/' markers, leading m/ optional) → hardened-offset
 *  index array; "m"/"" → []. */
function parseKeyPath(path: string, label: string): number[] {
	return sharedParseKeyPath(path, label, jadeFail);
}

/** 8-hex-char fingerprint string → 4-byte Uint8Array (the form jadets' signer
 *  descriptor wants). Throws on malformed input. */
function fingerprintToBytes(fingerprint: string, label: string): Uint8Array {
	if (!/^[0-9a-fA-F]{8}$/.test(fingerprint)) {
		throw new JadeError(`${label}: malformed fingerprint "${fingerprint}".`, 'unexpected');
	}
	const out = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		out[i] = parseInt(fingerprint.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/**
 * Adapt a Cairn multisig (the same quorum/keys/scriptType shape
 * multisigToDescriptor consumes) into a jadets MultisigDescriptor for
 * jade.registerMultisig: the script `variant`, `sorted: true` (Cairn multisigs
 * are always BIP-67 sortedmulti), the threshold, and one SignerDescriptor per
 * cosigner — fingerprint (4 bytes), derivation (the origin path as an index
 * array), and the account xpub (canonical form). This is a light adapter over
 * Cairn's existing descriptor shape, not new descriptor-building logic (§2.2).
 *
 * Exported for unit testing: this is the load-bearing descriptor adaptation.
 */
export function buildJadeMultisigDescriptor(params: JadeMultisigParams): MultisigDescriptor {
	const keys = params.keys ?? [];
	if (keys.length === 0) {
		throw new JadeError('This multisig has no keys.', 'unexpected');
	}
	if (
		!Number.isInteger(params.threshold) ||
		params.threshold < 1 ||
		params.threshold > keys.length
	) {
		throw new JadeError(
			`Invalid multisig threshold ${params.threshold} for ${keys.length} keys.`,
			'unexpected'
		);
	}
	const variant = JADE_MULTISIG_VARIANT[params.scriptType];
	if (!variant) {
		throw new JadeError(`Unsupported multisig script type "${params.scriptType}".`, 'unexpected');
	}

	const signers: SignerDescriptor[] = keys.map((key, i) => {
		const label = `multisig key ${i + 1}`;
		const derivation = parseKeyPath(key.path, label);
		return {
			fingerprint: fingerprintToBytes(key.fingerprint, label),
			derivation,
			// Cairn stores the account xpub verbatim (SLIP-132 aliases accepted); the
			// origin-path derivation above is what Jade uses to place it, and the
			// xpub is the account-level key the signer contributes. Keys are emitted
			// in config order — sorted:true tells Jade to BIP-67 sort at derivation.
			xpub: key.xpub.trim()
		};
	});

	return {
		variant,
		sorted: true,
		threshold: params.threshold,
		signers
	};
}

/**
 * Sanitize a multisig name into a Jade registration name. Jade registration
 * names are short identifiers, not free text: printable ASCII, no spaces,
 * trimmed to a conservative length. Empty input falls back to "cairnms".
 *
 * Exported for unit testing.
 */
export function sanitizeJadeMultisigName(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const ascii = (raw || '').replace(/[^\x21-\x7e]/g, '').trim();
	const cleaned = ascii || 'cairnms';
	// Jade caps registration names (16 chars in its firmware); stay under it.
	return cleaned.length > 16 ? cleaned.slice(0, 16) : cleaned;
}

/** Key material of an extended key (everything past the 4 version bytes: depth,
 *  parent fp, child number, chain code, pubkey) as hex — identical for a
 *  SLIP-132 alias and its standard-xpub form. Non-decodable input hashes as its
 *  raw string so a malformed key still contributes to identity distinctly. */
function extendedKeyMaterialHex(xpub: string): string {
	const s = xpub.trim();
	try {
		const raw = b58check.decode(s);
		if (raw.length === 78) return bytesToHex(raw.slice(4));
	} catch {
		// fall through
	}
	return `raw:${s}`;
}

/** Do two extended-key strings identify the same key? True when they match on
 *  everything but the version bytes (so ypub/Zpub aliases equal their xpub). */
function sameExtendedKey(a: string, b: string): boolean {
	const ma = extendedKeyMaterialHex(a);
	return !ma.startsWith('raw:') && ma === extendedKeyMaterialHex(b);
}

/**
 * Does a connected Jade's identity match the multisig key a signing slot expects?
 * Primary: the account xpub read from the device equals the stored cosigner xpub
 * (key material, SLIP-132-insensitive). Fallback: the device master fingerprint
 * equals the key's recorded (non-placeholder) fingerprint — covers keys stored
 * with an unresolvable account path. Exported for unit testing.
 */
export function jadeKeyIdentityMatches(
	expected: { xpub: string; fingerprint: string },
	reading: { xpub: string; fingerprint: string }
): boolean {
	if (sameExtendedKey(expected.xpub, reading.xpub)) return true;
	const fp = reading.fingerprint.trim().toLowerCase();
	return fp !== '' && fp !== '00000000' && fp === expected.fingerprint.trim().toLowerCase();
}

/** A canonical, order-independent identity string for a multisig wallet: its
 *  script form, threshold, and the SLIP-132-insensitive material of each key
 *  (fingerprint + origin path + key material), sorted so cosigner order can't
 *  change it. Two wallets with the same quorum+keys hash equal; any different
 *  key set hashes differently. */
function canonicalMultisigIdentity(params: JadeMultisigParams): Uint8Array {
	const perKey = (params.keys ?? [])
		.map(
			(k) =>
				`${k.fingerprint.trim().toLowerCase()}:${k.path.trim()}:${extendedKeyMaterialHex(k.xpub)}`
		)
		.sort();
	return sha256(new TextEncoder().encode(`${params.scriptType}:${params.threshold}:${perKey.join('|')}`));
}

/**
 * Deterministic Jade registration name for a multisig: a short readable prefix
 * plus a hash of the wallet's canonical descriptor, kept within Jade's 16-char
 * firmware limit. The hash suffix is the fix for cairn-1qkk: Jade registers
 * multisigs by name into fixed device-side slots and silently REPLACES an
 * existing entry when the name repeats. Two DIFFERENT wallets whose names share a
 * 16-char sanitized prefix ("Family Vault Primary" / "Family Vault Backup" ->
 * both "FamilyVaultBack"...) would otherwise clobber each other's registration,
 * corrupting the first wallet's later address-verification and signing with no
 * error. Binding the name to the descriptor makes distinct wallets get distinct
 * names, while the same wallet always resolves to the same name (idempotent
 * re-registration). Exported for unit testing.
 */
export function jadeMultisigRegistrationName(params: JadeMultisigParams): string {
	// 6 hex chars of identity + '_' separator leaves 9 for the human-readable part.
	const digest = bytesToHex(canonicalMultisigIdentity(params)).slice(0, 6);
	const base = sanitizeJadeMultisigName(params.name).slice(0, 9);
	return `${base}_${digest}`;
}

/**
 * Translate a raw jadets/Web-Serial error into a typed, plain-language
 * JadeError. jadets throws bare `Error`s (often `RPC Error <code>: <message>`
 * from the device, or Web Serial DOMExceptions), so this is string-matching by
 * necessity — the thin library exposes no structured error codes. Anything
 * unrecognized is surfaced verbatim under `unexpected` rather than swallowed.
 *
 * Exported for unit testing.
 */
export function toJadeError(err: unknown): JadeError {
	if (err instanceof JadeError) return err;

	const anyErr = err as { message?: unknown; name?: unknown } | null;
	const msg = String((anyErr && anyErr.message) || err || '');
	const name = String((anyErr && anyErr.name) || '');

	if (/No serial port selected|No port selected|NotFoundError|did not select|no device/i.test(msg) ||
		name === 'NotFoundError') {
		return new JadeError(
			'No Jade was selected. Plug it in, unlock it, then pick it from the browser prompt.',
			'no_device',
			{ cause: err }
		);
	}
	if (/not supported in this browser|Web Serial/i.test(msg)) {
		return new JadeError(
			'Web Serial is not available in this browser. Jade over USB needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unsupported-browser',
			{ cause: err }
		);
	}
	if (/denied|declined|rejected|user cancelled|CBOR_RPC_USER_CANCELLED/i.test(msg)) {
		return new JadeError('You rejected the request on the Jade.', 'rejected', { cause: err });
	}
	if (/auth_user|authenticate|PIN|not unlocked|HTTP request function/i.test(msg)) {
		return new JadeError(
			'Could not unlock the Jade. Enter your PIN on the device, then try again.',
			'auth_failed',
			{ cause: err }
		);
	}
	if (/disconnect|InvalidStateError|in use|Port not available|Not connected|NetworkError/i.test(msg)) {
		return new JadeError(
			'The Jade was disconnected or is busy (another tab or app may be holding it). Reconnect it and retry.',
			'unexpected',
			{ cause: err }
		);
	}
	if (/RPC call timed out|timed out|timeout/i.test(msg)) {
		return new JadeError(
			'The Jade did not respond in time. Reconnect it, make sure it is unlocked, and retry.',
			'unexpected',
			{ cause: err }
		);
	}
	return new JadeError(msg ? `Jade error: ${msg}` : 'The Jade request failed.', 'unexpected', {
		cause: err
	});
}

// ------------------------------------------------------------------ device I/O
//
// The functions below talk to a real device over Web Serial. They are NOT
// unit-tested (that needs the emulator / real hardware, plan §2.2). They keep
// no pure logic of their own — everything derivable is done above.

/** The jadets HTTP-relay function shape. Jade's PIN-unlock is INVERTED: the
 *  DEVICE decides the PIN-server request/response, and the host's only job is
 *  to relay fetch() on the device's behalf (a "blind oracle" — Blockstream's
 *  PIN server never sees the PIN, only a hash+nonce). We implement it as a thin
 *  fetch relay, nothing more. */
type JadeHttpRequestParams = {
	urls?: string[];
	method?: string;
	data?: unknown;
	accept?: string;
};
export type JadeHttpRequestFunction = (params: JadeHttpRequestParams) => Promise<{ body: unknown }>;

/**
 * The PIN-unlock HTTP relay. Jade hands us a request (target URL(s), method,
 * body); we perform exactly that fetch and hand the response body back. We
 * never inspect or alter it — the device drives the whole handshake. Uses the
 * first URL Jade offers (its list is ordered by preference). Kept tiny and
 * side-effect-free beyond the single fetch.
 */
function makeHttpRelay(): JadeHttpRequestFunction {
	return async (params: JadeHttpRequestParams) => {
		const urls = params?.urls ?? [];
		const url = urls[0];
		if (!url) {
			throw new JadeError('The Jade requested an empty PIN-server URL.', 'auth_failed');
		}
		let res: Response;
		try {
			res = await fetch(url, {
				method: params.method || 'POST',
				headers: { 'Content-Type': 'application/json', Accept: params.accept || 'application/json' },
				body: params.data !== undefined ? JSON.stringify(params.data) : undefined
			});
		} catch (err) {
			throw new JadeError(
				'Could not reach the Jade PIN server. Check your internet connection and try again.',
				'auth_failed',
				{ cause: err }
			);
		}
		if (!res.ok) {
			throw new JadeError(
				`The Jade PIN server returned an error (${res.status}).`,
				'auth_failed'
			);
		}
		const body = await res.json();
		return { body };
	};
}

/**
 * Open a Jade over Web Serial and PIN-unlock it. Returns the connected `Jade`
 * plus a `dispose()` the caller MUST run in a finally block.
 *
 * Connection (jadets SerialTransport → JadeInterface → Jade):
 *   1. navigator.serial.requestPort() — NOTE: jadets applies NO VID/PID filter
 *      (no Jade USB VID/PID was found in any source during research, §2.2), so
 *      Chrome shows its full generic serial-port list. This is a materially
 *      worse first-connect UX than Ledger/Trezor's filtered picker — a known
 *      gap to revisit if a real VID/PID surfaces.
 *   2. jade.connect() opens the port at 115200 baud (CBOR framing).
 *   3. jade.authUser(network, httpRelay) — PIN handshake, host relays fetch()
 *      only (see makeHttpRelay). The user enters their PIN on the device.
 */
async function openJade(): Promise<{
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	jade: any;
	dispose: () => Promise<void>;
}> {
	if (!isWebSerialAvailable()) {
		throw new JadeError(
			'Web Serial is not available in this browser. Jade over USB needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unsupported-browser'
		);
	}

	// Lazy, browser-only import — kept inside the function so nothing jadets- or
	// Web-Serial-related is evaluated during SSR or for users who never connect.
	let mod: typeof import('jadets');
	try {
		mod = await import('jadets');
	} catch (err) {
		throw toJadeError(err);
	}
	const { Jade, JadeInterface, SerialTransport } = mod;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let jade: any;
	try {
		const transport = new SerialTransport({ baudRate: 115200 });
		const iface = new JadeInterface(transport);
		jade = new Jade(iface);
	} catch (err) {
		throw toJadeError(err);
	}

	const dispose = async () => {
		try {
			await jade.disconnect();
		} catch {
			/* releasing the serial port is best-effort */
		}
	};

	try {
		await jade.connect();
	} catch (err) {
		await dispose();
		throw toJadeError(err);
	}

	try {
		const ok = await jade.authUser(JADE_NETWORK, makeHttpRelay());
		if (ok === false) {
			throw new JadeError(
				'Could not unlock the Jade. Enter your PIN on the device, then try again.',
				'auth_failed'
			);
		}
	} catch (err) {
		await dispose();
		throw toJadeError(err);
	}

	return { jade, dispose };
}

/**
 * Read a single-sig key straight from a connected Jade for the single-sig wallet
 * import flow: the account xpub at the standard BIP44/49/84/86 path for the
 * script type, plus the device's master fingerprint. The xpub is returned in
 * Cairn's single-sig SLIP-132 form (xpub/ypub/zpub; taproot stays xpub).
 *
 * Returns the { xpub, fingerprint, path } shape single-sig import expects.
 */
export async function readSingleSigKeyFromJade(
	scriptType: ScriptType,
	account = 0
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	const pathIndexes = singleSigAccountPath(scriptType, account); // validates + fails fast
	const { jade, dispose } = await openJade();
	try {
		let rawXpub: string;
		let fingerprint: string | null;
		try {
			rawXpub = await jade.getXpub(JADE_NETWORK, pathIndexes);
			fingerprint = await jade.getMasterFingerPrint(JADE_NETWORK);
		} catch (err) {
			throw toJadeError(err);
		}
		if (!fingerprint) {
			throw new JadeError('The Jade did not report its master fingerprint.', 'unexpected');
		}
		return {
			xpub: toSingleSigXpub(rawXpub, scriptType),
			fingerprint: fingerprint.toLowerCase(),
			path: formatPath(pathIndexes)
		};
	} finally {
		await dispose();
	}
}

/**
 * Read a multisig cosigner key straight from a connected Jade for the multisig
 * creation wizard: the BIP-48 account xpub at m/48'/0'/{account}'/{script}'
 * plus the device's master fingerprint. The xpub is returned as the canonical
 * standard xpub (the multisig layer accepts and normalizes it).
 *
 * Returns the { xpub, fingerprint, path } shape multisig keys store.
 */
export async function readMultisigKeyFromJade(
	scriptType: MultisigScriptType,
	account = 0
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	const pathIndexes = multisigAccountPathIndexes(scriptType, account); // validates + fails fast
	const { jade, dispose } = await openJade();
	try {
		let xpub: string;
		let fingerprint: string | null;
		try {
			xpub = await jade.getXpub(JADE_NETWORK, pathIndexes);
			fingerprint = await jade.getMasterFingerPrint(JADE_NETWORK);
		} catch (err) {
			throw toJadeError(err);
		}
		if (!fingerprint) {
			throw new JadeError('The Jade did not report its master fingerprint.', 'unexpected');
		}
		return { xpub: xpub.trim(), fingerprint: fingerprint.toLowerCase(), path: formatPath(pathIndexes) };
	} finally {
		await dispose();
	}
}

/**
 * Register a multisig on a connected Jade — the one-time on-device approval
 * Jade requires before it will derive addresses or sign for a multisig (same
 * shape as the Ledger/BitBox02 registration requirement). Builds the jadets
 * MultisigDescriptor from Cairn's own multisig config (buildJadeMultisigDescriptor)
 * and calls jade.registerMultisig; the device walks the user through the quorum
 * and cosigner keys. Returns the registration name Jade stored it under (needed
 * later for address verification / signing lookups).
 */
export async function registerMultisigWithJade(
	params: JadeMultisigParams
): Promise<{ name: string }> {
	// Build (and validate) the descriptor before touching the device.
	const descriptor = buildJadeMultisigDescriptor(params);
	// Descriptor-bound name so distinct wallets never clobber each other's
	// device-side registration slot (cairn-1qkk).
	const name = jadeMultisigRegistrationName(params);

	const { jade, dispose } = await openJade();
	try {
		// Fail fast and clearly if this Jade isn't the key this signature is for,
		// before registering or signing under a wallet it doesn't hold (cairn-86n5).
		if (params.expectedKey) {
			let reading: { xpub: string; fingerprint: string };
			try {
				const derivation = parseKeyPath(params.expectedKey.path, 'expected key');
				const xpub = await jade.getXpub(JADE_NETWORK, derivation);
				const fingerprint = (await jade.getMasterFingerPrint(JADE_NETWORK)) ?? '';
				reading = { xpub: (xpub ?? '').trim(), fingerprint: fingerprint.toLowerCase() };
			} catch (err) {
				throw toJadeError(err);
			}
			if (!jadeKeyIdentityMatches(params.expectedKey, reading)) {
				throw new JadeError(
					`This Jade isn't the key this signature is for — the connected device's fingerprint is ${reading.fingerprint || 'unknown'}, but this signing slot expects ${params.expectedKey.fingerprint.toLowerCase()}. Connect the Jade that holds this multisig key.`,
					'wrong_device'
				);
			}
		}

		let ok: boolean;
		try {
			ok = await jade.registerMultisig(JADE_NETWORK, name, descriptor);
		} catch (err) {
			throw toJadeError(err);
		}
		if (ok === false) {
			throw new JadeError(
				'The Jade did not confirm the multisig registration. Approve it on the device and try again.',
				'rejected'
			);
		}
		return { name };
	} finally {
		await dispose();
	}
}

/**
 * Sign a PSBT with a connected Jade and return the signed PSBT bytes. Cairn's
 * PSBT is the source of truth: we hand Jade the exact unsigned PSBT and receive
 * the signed bytes back, which the parent Sign step re-checks commits to the
 * same transaction (assertSameTransaction). Works for both single-sig and
 * (already-registered) multisig PSBTs — Jade routes on the PSBT's own contents.
 */
export async function signPsbtWithJade(
	network: string,
	psbtBytes: Uint8Array
): Promise<Uint8Array> {
	// Jade takes a network string; Cairn is mainnet-only, so ignore any other
	// value and use the canonical one (kept in the signature for parity with the
	// other drivers and future testnet support).
	void network;
	if (!(psbtBytes instanceof Uint8Array) || psbtBytes.length === 0) {
		throw new JadeError('That transaction could not be read as a PSBT.', 'bad_psbt');
	}

	const { jade, dispose } = await openJade();
	try {
		let signed: Uint8Array;
		try {
			signed = await jade.signPSBT(JADE_NETWORK, psbtBytes);
		} catch (err) {
			throw toJadeError(err);
		}
		if (!(signed instanceof Uint8Array) || signed.length === 0) {
			throw new JadeError('The Jade returned an empty signed transaction.', 'unexpected');
		}
		return signed;
	} finally {
		await dispose();
	}
}
