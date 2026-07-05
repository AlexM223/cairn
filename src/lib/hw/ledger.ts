// Ledger hardware-wallet signer — WebHID + Bitcoin-app (v2.1.0+) driver.
//
// Framework-agnostic on purpose: no Svelte, no DOM beyond the WebHID feature
// check, so the pure logic (PSBT → wallet policy derivation, signature
// merge-back) is unit-testable without a device. The heavy Ledger transport +
// app modules are imported lazily inside signPsbtWithLedger — never at module
// top level — so SSR and non-Ledger users never pay to load them, and the
// WebHID globals they touch are only referenced in a browser after a click.
//
// Cairn holds no private keys: the device signs. We hand the device the exact
// unsigned PSBT built by src/lib/server/bitcoin/psbt.ts, receive per-input
// signatures, and merge them back into that same PSBT so the returned base64
// commits to the identical inputs/outputs the user reviewed. The parent Sign
// step re-checks that commitment server-side (assertSameTransaction).

import { Transaction } from '@scure/btc-signer';
import { base64, createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

// ---- Types imported for annotations only (erased at build, no runtime load) --
import type { AppClient as AppClientType } from '@ledgerhq/hw-app-btc/lib/newops/appClient';
import type { DefaultDescriptorTemplate } from '@ledgerhq/hw-app-btc/lib/newops/policy';

const HARDENED = 0x80000000;

/**
 * A typed error the UI can present verbatim. `code` lets callers branch (e.g.
 * offer "open the Bitcoin app" vs "unlock your device") without string-matching.
 */
export type LedgerErrorCode =
	| 'unavailable' // WebHID not present in this browser
	| 'app_not_open' // Bitcoin app not open / wrong app selected
	| 'device_locked' // PIN not entered
	| 'rejected' // user declined on-device
	| 'no_device' // no device chosen from the browser picker / disconnected
	| 'bad_psbt' // the PSBT lacks the key-origin data Ledger needs
	| 'wrong_device' // the connected Ledger holds none of the vault's keys
	| 'policy_unregistered' // vault signing attempted before on-device policy registration
	| 'unexpected'; // anything else

export class LedgerError extends Error {
	constructor(
		message: string,
		public readonly code: LedgerErrorCode,
		options?: { cause?: unknown }
	) {
		super(message);
		this.name = 'LedgerError';
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

// BIP purpose (first, hardened path element) → Ledger single-sig descriptor
// template. These are the only default templates the app accepts for a
// single-key wallet policy.
const PURPOSE_TEMPLATE: Record<number, DefaultDescriptorTemplate> = {
	44: 'pkh(@0/**)',
	49: 'sh(wpkh(@0/**))',
	84: 'wpkh(@0/**)',
	86: 'tr(@0/**)'
};

/** Derivation info recovered from a PSBT input's bip32Derivation. */
export interface AccountOrigin {
	/**
	 * Master key fingerprint as the uint32 btc-signer stores it (BIP32
	 * big-endian, e.g. 0x1a2b3c4d). Convert to a 4-byte buffer for Ledger.
	 */
	fingerprint: number;
	/** Full account path (hardened elements only), e.g. [84',0',0']. */
	accountPath: number[];
	/** The Ledger descriptor template for this account's script type. */
	template: DefaultDescriptorTemplate;
}

/** uint32 fingerprint → 4-byte big-endian buffer (the form Ledger's createKey wants). */
export function fingerprintToBuffer(fp: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, fp >>> 0, false); // false = big-endian
	return out;
}

/**
 * Read the account origin (fingerprint, account path, descriptor template) from
 * the first input's bip32Derivation. Cairn's psbt.ts embeds, per input, a
 * pubkey → { fingerprint, path } entry where `path` is the FULL path including
 * the trailing chain/index (e.g. [84',0',0',0,4]). The account path is that
 * minus the last two elements. Kept honest — derived from the PSBT, never
 * hardcoded — so a wallet on a non-default account (m/84'/0'/3') still signs.
 *
 * Exported for unit testing: this is the load-bearing pure logic.
 */
export function accountOriginFromPsbt(unsignedPsbtBase64: string): AccountOrigin {
	let tx: Transaction;
	try {
		tx = Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch (err) {
		throw new LedgerError('That transaction could not be read as a PSBT.', 'bad_psbt', {
			cause: err
		});
	}
	if (tx.inputsLength === 0) {
		throw new LedgerError('This transaction has no inputs to sign.', 'bad_psbt');
	}

	const input = tx.getInput(0);
	const derivations = input.bip32Derivation;
	if (!derivations || derivations.length === 0) {
		throw new LedgerError(
			'This transaction is missing the key-origin information the Ledger needs to sign. Re-create it from a wallet set up with its master fingerprint.',
			'bad_psbt'
		);
	}

	// bip32Derivation entries are [pubkey, { fingerprint: Uint8Array, path: number[] }].
	const [, meta] = derivations[0];
	const fullPath = meta.path;
	if (!fullPath || fullPath.length < 3) {
		throw new LedgerError('The transaction has an unexpected derivation path.', 'bad_psbt');
	}

	// Strip the trailing (chain, index) to get the account path.
	const accountPath = fullPath.slice(0, -2);
	const purpose = accountPath[0] - HARDENED;
	const template = PURPOSE_TEMPLATE[purpose];
	if (!template) {
		throw new LedgerError(
			`This wallet's derivation (purpose ${purpose}') is not a standard single-sig account the Ledger can sign.`,
			'bad_psbt'
		);
	}

	return { fingerprint: meta.fingerprint, accountPath, template };
}

/**
 * Translate a raw Ledger/WebHID error into a typed, plain-language LedgerError.
 * The most common failure by far is the Bitcoin app not being open (0x6e01);
 * others are device-locked, user rejection, and no-device-selected. Anything
 * unrecognized is surfaced verbatim under `unexpected` rather than swallowed.
 */
export function toLedgerError(err: unknown): LedgerError {
	if (err instanceof LedgerError) return err;

	const anyErr = err as { message?: unknown; statusCode?: unknown; name?: unknown } | null;
	const msg = String((anyErr && anyErr.message) || err || '');
	const name = String((anyErr && anyErr.name) || '');
	const code = anyErr && typeof anyErr.statusCode === 'number' ? anyErr.statusCode : null;
	const hit = (re: RegExp, statusCode?: number) =>
		re.test(msg) || (statusCode != null && code === statusCode);

	if (hit(/0x6e0[01]|0x6d00|0x6511|CLA_NOT_SUPPORTED|INS_NOT_SUPPORTED/i, 0x6e01)) {
		return new LedgerError(
			'Open the Bitcoin app on your Ledger, then connect again.',
			'app_not_open',
			{ cause: err }
		);
	}
	if (hit(/0x6985|0x5501|denied|rejected|CONDITIONS_OF_USE_NOT_SATISFIED/i, 0x6985)) {
		return new LedgerError('You rejected the request on the Ledger.', 'rejected', { cause: err });
	}
	if (hit(/0x5515|0x6b0c|locked|LOCKED_DEVICE/i, 0x5515)) {
		return new LedgerError(
			'Unlock your Ledger (enter your PIN), open the Bitcoin app, then try again.',
			'device_locked',
			{ cause: err }
		);
	}
	if (/no device selected|must select|cancel|did not select|requestDevice|NotFoundError/i.test(msg) ||
		name === 'NotFoundError') {
		return new LedgerError(
			'No Ledger was selected. Plug it in, unlock it, open the Bitcoin app, then pick it from the browser prompt.',
			'no_device',
			{ cause: err }
		);
	}
	if (/already open|InvalidStateError|in use|DisconnectedDevice|disconnect/i.test(msg)) {
		return new LedgerError(
			'The Ledger was disconnected or is busy (another tab or app may be holding it). Reconnect with the Bitcoin app open and retry.',
			'unexpected',
			{ cause: err }
		);
	}
	return new LedgerError(msg ? `Ledger error: ${msg}` : 'The Ledger request failed.', 'unexpected', {
		cause: err
	});
}

/**
 * Sign a single-sig PSBT with a connected Ledger over WebHID and return the
 * signed PSBT as base64.
 *
 * Flow (mirrors @ledgerhq/hw-app-btc's BtcNew.signPsbt, but keeps Cairn's own
 * btc-signer PSBT as the source of truth so the returned commitment is byte-for
 * -byte the reviewed transaction):
 *   1. Derive the account policy (fingerprint, path, descriptor template) from
 *      the PSBT's embedded bip32Derivation — never hardcoded.
 *   2. Open the WebHID transport (prompts the browser device picker) and the
 *      AppClient.
 *   3. Fetch the account xpub + master fingerprint from the device and build a
 *      single-sig WalletPolicy (e.g. wpkh(@0/**)).
 *   4. Convert Cairn's PSBTv0 → Ledger PsbtV2 (PsbtV2.fromV0) and sign; the
 *      device shows the outputs and asks for physical approval.
 *   5. Merge each returned per-input signature back into the ORIGINAL
 *      btc-signer PSBT (partialSig, or tapKeySig for taproot) and return base64.
 *
 * Throws a LedgerError (typed, plain-language) on every failure.
 */
export async function signPsbtWithLedger(unsignedPsbtBase64: string): Promise<string> {
	if (!isWebHidAvailable()) {
		throw new LedgerError(
			'WebHID is not available in this browser. Ledger signing needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unavailable'
		);
	}

	// Recover the policy details from the PSBT before we ever touch the device —
	// a bad PSBT should fail fast with a clear message, not after a device prompt.
	const origin = accountOriginFromPsbt(unsignedPsbtBase64);

	// Parse the source PSBT once; this is the object we merge signatures into.
	let sourceTx: Transaction;
	try {
		sourceTx = Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch (err) {
		throw new LedgerError('That transaction could not be read as a PSBT.', 'bad_psbt', {
			cause: err
		});
	}

	// Lazy, browser-only imports. Kept inside the function so nothing Ledger- or
	// WebHID-related is evaluated during SSR or for users who never click Connect.
	const [transportMod, appClientMod, policyMod, psbtMod] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient'),
		import('@ledgerhq/hw-app-btc/lib/newops/policy'),
		import('@ledgerhq/psbtv2')
	]);
	const { default: TransportWebHID } = transportMod;
	const { AppClient } = appClientMod;
	const { WalletPolicy, createKey } = policyMod;
	const { PsbtV2 } = psbtMod;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let transport: any;
	try {
		try {
			transport = await TransportWebHID.create();
		} catch (err) {
			throw toLedgerError(err);
		}

		const client: AppClientType = new AppClient(transport);

		// Ask the device for its master fingerprint + the account xpub. We use the
		// device-reported fingerprint for the wallet key (it must match what the
		// PSBT embedded, or the device will refuse to recognize its own inputs).
		let masterFp: Buffer;
		let accountXpub: string;
		try {
			masterFp = await client.getMasterFingerprint();
			accountXpub = await client.getExtendedPubkey(false, origin.accountPath);
		} catch (err) {
			throw toLedgerError(err);
		}

		// Wrong-device guard: this wallet's inputs were built under a known master
		// fingerprint. A different Ledger can't sign for it — the device would
		// reject with an opaque error, so surface a clear one first. (Skip when the
		// PSBT carries the placeholder 0x00000000, i.e. no real origin was known.)
		const wantFp = fingerprintToBuffer(origin.fingerprint);
		if (origin.fingerprint !== 0 && !buffersEqual(masterFp, wantFp)) {
			throw new LedgerError(
				`This Ledger (fingerprint ${bytesToFpHex(masterFp)}) is not this wallet's key (expected ${bytesToFpHex(wantFp)}). Connect the correct device.`,
				'unexpected'
			);
		}

		const key = createKey(masterFp, origin.accountPath, accountXpub);
		const policy = new WalletPolicy(origin.template, key);

		// Convert Cairn's BIP174 (v0) PSBT to the PsbtV2 the app client wants.
		// fromV0 carries the witnessUtxo/redeemScript/bip32Derivation across.
		let psbtV2: InstanceType<typeof PsbtV2>;
		try {
			psbtV2 = PsbtV2.fromV0(Buffer.from(sourceTx.toPSBT()));
		} catch (err) {
			throw new LedgerError(
				'This transaction could not be prepared for the Ledger (unsupported PSBT shape).',
				'bad_psbt',
				{ cause: err }
			);
		}

		// null HMAC: default (unregistered) single-sig policies need no on-device
		// registration. The device shows the outputs and blocks on physical approval.
		let sigs: Map<number, Buffer>;
		try {
			sigs = await client.signPsbt(psbtV2, policy, null, () => {});
		} catch (err) {
			throw toLedgerError(err);
		}

		mergeSignatures(sourceTx, sigs);

		return base64.encode(sourceTx.toPSBT());
	} finally {
		if (transport) {
			try {
				await transport.close();
			} catch {
				/* releasing the HID handle is best-effort */
			}
		}
	}
}

/**
 * Merge the device's per-input signatures back into the source PSBT.
 *
 * `signPsbt` returns Map<inputIndex, signature>. For a legacy/segwit input the
 * signature is a partial signature that must be paired with the input's pubkey
 * (read from its bip32Derivation); for a taproot input it is the key-path
 * signature (tapKeySig, no pubkey pairing). Keyed by the device-reported index,
 * so an out-of-order or partial result still lands on the right input.
 *
 * Exported for unit testing.
 */
export function mergeSignatures(tx: Transaction, sigs: Map<number, Buffer>): void {
	sigs.forEach((sig, index) => {
		const sigBytes = toU8(sig);
		const input = tx.getInput(index);

		// Taproot: no bip32Derivation, sig goes straight into tapKeySig.
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			if (input.tapInternalKey || input.tapBip32Derivation) {
				tx.updateInput(index, { tapKeySig: sigBytes });
				return;
			}
			throw new LedgerError(
				`The Ledger returned a signature for input ${index} but that input has no key-origin to attach it to.`,
				'unexpected'
			);
		}

		// Single-key inputs carry exactly one derivation → one pubkey.
		const [pubkey] = derivations[0];
		tx.updateInput(index, { partialSig: [[toU8(pubkey), sigBytes]] });
	});
}

/** Normalize a Buffer / Uint8Array / hex string to a plain Uint8Array. */
function toU8(v: Uint8Array | Buffer | string): Uint8Array {
	if (typeof v === 'string') return hexToBytes(v);
	// Buffer IS a Uint8Array; copy into a plain one so btc-signer's coders see the
	// exact byte view they expect regardless of the source's ArrayBuffer backing.
	return Uint8Array.from(v);
}

/** Constant-shape byte equality for two same-length-or-not byte arrays. */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Lowercase 8-hex-char rendering of a 4-byte fingerprint, for messages. */
function bytesToFpHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------- vaults
//
// MULTISIG ("vault") signing via BIP-388 wallet policies. Unlike single-sig
// (default, unnamed policies the app accepts without registration), a
// multisig policy is NAMED and must be REGISTERED once per device: the app
// walks the user through the policy on-screen (name, quorum, every cosigner
// key), then returns an HMAC that Cairn persists. Every later signing call
// presents the same policy + HMAC and skips the on-device re-approval.
//
// The installed @ledgerhq/hw-app-btc (11.2.1) exposes the v2 APDU client
// (AppClient.signPsbt / getMasterFingerprint / getExtendedPubkey) but its
// WalletPolicy class is single-key/unnamed-only and there is no registerWallet
// method — so this driver builds the named multisig policy (BIP-388 wallet
// serialization v2, byte-identical to ledger-bitcoin's) and issues the
// REGISTER_WALLET APDU itself from the library's own exported primitives
// (ClientCommandInterpreter, Merkle/hashLeaf, createVarint). AppClient.signPsbt
// accepts any structurally-compatible policy object, so signing reuses the
// stock client.
//
// The policy's `keys` array is sorted CASE-SENSITIVELY by the xpub substring.
// The order only affects the @i numbering and the registration HMAC preimage —
// sortedmulti re-sorts the derived pubkeys at script-build time, so addresses
// are unaffected — but the SAME order must be produced at registration and at
// signing or the device rejects the HMAC. Never normalize xpub case.

/** The three vault script forms — mirrors multisig.ts's VaultScriptType
 *  (duplicated here so this browser driver never imports server code). */
export type VaultScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/** One cosigner key, exactly as the vault stores it (VaultKeyRow shape). */
export interface VaultSignKey {
	/** Account xpub (SLIP-132 ypub/zpub/Ypub/Zpub accepted, normalized internally). */
	xpub: string;
	/** Master fingerprint, 8 hex chars ("00000000" when unknown). */
	fingerprint: string;
	/** Account origin path, e.g. "m/48'/0'/0'/2'" ("m" when unknown). */
	path: string;
}

/** Everything vault signing needs. Framework-agnostic plain values the UI
 *  passes straight from the vault row + the sign session's combined PSBT. */
export interface VaultSignParams {
	/** Base64 PSBT — the CURRENT combined PSBT (other cosigners' partialSigs kept). */
	unsignedPsbt: string;
	threshold: number;
	keys: VaultSignKey[];
	scriptType: VaultScriptType;
}

/** What buildVaultPolicy needs — the vault's quorum/keys plus a display name. */
export interface VaultPolicyParams {
	/** Vault name; sanitized to ≤64 printable ASCII for the device. */
	policyName: string;
	threshold: number;
	keys: VaultSignKey[];
	scriptType: VaultScriptType;
}

/** A BIP-388 wallet policy in string form (what the device registers/signs). */
export interface VaultWalletPolicy {
	name: string;
	template: string;
	keys: string[];
}

const HW_HARDENED = HARDENED; // alias for readability in vault-path helpers

// SLIP-132 public-key version bytes, rewritten to standard xpub before use.
const XPUB_VERSION = 0x0488b21e;
const SLIP132_VERSIONS = new Set([
	0x049d7cb2, // ypub
	0x04b24746, // zpub
	0x0295b43f, // Ypub (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub (p2wsh multisig)
]);
const b58check = /* @__PURE__ */ createBase58check(sha256);

/** Rewrite a SLIP-132 prefix to standard xpub bytes; anything else (including
 *  invalid input) passes through unchanged so later parsing shows a real error. */
function normalizeVaultXpub(input: string): string {
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

/** "m/48'/0'/0'/2'" (h/H/' markers, leading m/ optional) → hardened-offset
 *  index array; "m"/"" → []. */
function parseVaultKeyPath(path: string, label: string): number[] {
	const stripped = path.trim().replace(/^m\/?/i, '');
	if (stripped === '') return [];
	return stripped.split('/').map((p) => {
		const hardened = /['’hH]$/.test(p);
		const digits = hardened ? p.slice(0, -1) : p;
		if (!/^\d+$/.test(digits)) {
			throw new LedgerError(`${label}: bad derivation path segment "${p}".`, 'unexpected');
		}
		const n = parseInt(digits, 10);
		if (n >= HW_HARDENED) {
			throw new LedgerError(`${label}: derivation path segment out of range "${p}".`, 'unexpected');
		}
		return hardened ? n + HW_HARDENED : n;
	});
}

/**
 * The BIP-48 account path for a vault cosigner key: m/48'/0'/{account}'/{script}'
 * where the script suffix is 2' for p2wsh and 1' for BOTH p2sh forms (BIP-48
 * gives p2sh and p2sh-p2wsh the same 1' — only native p2wsh gets 2'). Mainnet
 * only, matching the rest of Cairn. Exported for unit testing.
 */
export function vaultAccountPath(scriptType: VaultScriptType, account = 0): string {
	if (scriptType !== 'p2wsh' && scriptType !== 'p2sh-p2wsh' && scriptType !== 'p2sh') {
		throw new LedgerError(`Unsupported vault script type "${scriptType}".`, 'unexpected');
	}
	if (!Number.isInteger(account) || account < 0 || account >= HW_HARDENED) {
		throw new LedgerError(`Invalid account index ${account}.`, 'unexpected');
	}
	const sub = scriptType === 'p2wsh' ? 2 : 1;
	return `m/48'/0'/${account}'/${sub}'`;
}

/**
 * Sanitize a vault name into a Ledger policy name: printable ASCII only,
 * trimmed, at most 64 characters (the app's limit), with an ASCII "..."
 * truncation marker (a Unicode ellipsis would re-introduce the very byte the
 * filter just removed). Empty input falls back to "Cairn vault".
 *
 * Exported for unit testing.
 */
export function sanitizeVaultPolicyName(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const ascii = (raw || '').replace(/[^\x20-\x7e]/g, '').trim() || 'Cairn vault';
	return ascii.length > 64 ? `${ascii.slice(0, 61).trim()}...` : ascii;
}

/**
 * The policy-key ordering: case-sensitive comparison of the xpub substring
 * (everything after the closing `]` of the key origin). Case matters — xpubs
 * are base58, where `B` and `b` are different characters; normalizing case
 * here would silently change the HMAC preimage and break every existing
 * device registration. Exported for unit testing.
 */
export function compareVaultPolicyKeys(a: string, b: string): number {
	const ax = a.slice(a.indexOf(']') + 1);
	const bx = b.slice(b.indexOf(']') + 1);
	return ax < bx ? -1 : ax > bx ? 1 : 0;
}

/**
 * Build the BIP-388 wallet policy for a vault: the descriptor template
 * (`wsh(sortedmulti(M,@0/**,@1/**,…))`, sh()/sh(wsh()) wrapped for the p2sh
 * forms) plus the key-origin strings `[xfp/48'/0'/0'/2']xpub` — apostrophe
 * hardening markers, NO /branch/* suffix (the template's `@i/**` supplies
 * receive/change), sorted case-sensitively by xpub (see compareVaultPolicyKeys).
 * A key with an unknown origin ("m") is emitted as `[xfp]xpub`.
 *
 * Used for BOTH registration and signing so the two are always byte-identical.
 * Exported for unit testing.
 */
export function buildVaultPolicy(params: VaultPolicyParams): VaultWalletPolicy {
	const keys = params.keys ?? [];
	if (keys.length === 0) {
		throw new LedgerError('This vault has no keys.', 'unexpected');
	}
	if (
		!Number.isInteger(params.threshold) ||
		params.threshold < 1 ||
		params.threshold > keys.length
	) {
		throw new LedgerError(
			`Invalid vault threshold ${params.threshold} for ${keys.length} keys.`,
			'unexpected'
		);
	}
	const keyStrs = keys
		.map((key, i) => {
			const label = `vault key ${i + 1}`;
			if (!/^[0-9a-fA-F]{8}$/.test(key.fingerprint)) {
				throw new LedgerError(`${label}: malformed fingerprint "${key.fingerprint}".`, 'unexpected');
			}
			const xpub = normalizeVaultXpub(key.xpub);
			const origin = parseVaultKeyPath(key.path, label);
			const originStr = origin.length
				? `/${origin.map((n) => (n >= HW_HARDENED ? `${n - HW_HARDENED}'` : `${n}`)).join('/')}`
				: '';
			return `[${key.fingerprint.toLowerCase()}${originStr}]${xpub}`;
		})
		.sort(compareVaultPolicyKeys);
	const signers = keyStrs.map((_, i) => `@${i}/**`).join(',');
	const inner = `sortedmulti(${params.threshold},${signers})`;
	const template =
		params.scriptType === 'p2wsh'
			? `wsh(${inner})`
			: params.scriptType === 'p2sh'
				? `sh(${inner})`
				: params.scriptType === 'p2sh-p2wsh'
					? `sh(wsh(${inner}))`
					: null;
	if (!template) {
		throw new LedgerError(`Unsupported vault script type "${params.scriptType}".`, 'unexpected');
	}
	return { name: sanitizeVaultPolicyName(params.policyName), template, keys: keyStrs };
}

/**
 * Per-input pubkey this device will sign with: `key`'s account xpub extended
 * by each input's (chain, index) suffix, read from the input's own
 * bip32Derivation. Ledger's signPsbt result is keyed only by input index (the
 * client library drops the echoed pubkey), so this is what the merge step
 * attributes signatures to. Every derived pubkey must itself be declared in
 * the input's bip32Derivation — a mismatch means the PSBT wasn't built for
 * this vault (or this key isn't part of it) and is rejected before signing.
 *
 * Exported for unit testing.
 */
export function vaultDevicePubkeys(unsignedPsbtBase64: string, key: VaultSignKey): Uint8Array[] {
	let tx: Transaction;
	try {
		tx = Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch (err) {
		throw new LedgerError('That transaction could not be read as a PSBT.', 'bad_psbt', {
			cause: err
		});
	}
	if (tx.inputsLength === 0) {
		throw new LedgerError('This transaction has no inputs to sign.', 'bad_psbt');
	}
	let hdkey: HDKey;
	try {
		hdkey = HDKey.fromExtendedKey(normalizeVaultXpub(key.xpub));
	} catch (err) {
		throw new LedgerError('Unreadable vault key (extended public key).', 'unexpected', {
			cause: err
		});
	}

	const out: Uint8Array[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const derivations = tx.getInput(i).bip32Derivation;
		if (!derivations || derivations.length === 0) {
			throw new LedgerError(
				`Input ${i} is missing the key-origin information the Ledger needs. Re-create the draft from this vault.`,
				'bad_psbt'
			);
		}
		// All of an address's derivations share one non-hardened (chain, index).
		let suffix: [number, number] | null = null;
		for (const [, meta] of derivations) {
			const path = meta.path;
			if (!path || path.length < 2) {
				throw new LedgerError(`Input ${i} has an unexpected derivation path.`, 'bad_psbt');
			}
			const chain = path[path.length - 2];
			const index = path[path.length - 1];
			if (chain >= HW_HARDENED || index >= HW_HARDENED) {
				throw new LedgerError(`Input ${i} has a hardened chain/index derivation.`, 'bad_psbt');
			}
			if (suffix && (suffix[0] !== chain || suffix[1] !== index)) {
				throw new LedgerError(`Input ${i} mixes derivations of different addresses.`, 'bad_psbt');
			}
			suffix = [chain, index];
		}
		const [chain, index] = suffix!;
		let pubkey: Uint8Array | null;
		try {
			pubkey = hdkey.deriveChild(chain).deriveChild(index).publicKey;
		} catch (err) {
			throw new LedgerError(`Key derivation failed for input ${i}.`, 'unexpected', { cause: err });
		}
		if (!pubkey) {
			throw new LedgerError(`Key derivation failed for input ${i}.`, 'unexpected');
		}
		const declared = pubkey;
		if (!derivations.some(([pk]) => buffersEqual(Uint8Array.from(pk), declared))) {
			throw new LedgerError(
				`Input ${i} does not include this device's key — the transaction wasn't built for this vault.`,
				'bad_psbt'
			);
		}
		out.push(pubkey);
	}
	return out;
}

/**
 * Merge the device's per-input vault signatures into the source PSBT as
 * partialSig entries. `sigs` is signPsbt's Map<inputIndex, signature>
 * (signature WITH its sighash byte, as the app emits it); each is attributed
 * to `devicePubkeys[index]` — this device's derived key for that input,
 * pre-validated against the input's bip32Derivation by vaultDevicePubkeys and
 * re-checked here. Existing partialSig entries from other cosigners are
 * preserved (btc-signer merges keyed PSBT fields).
 *
 * Exported for unit testing.
 */
export function mergeVaultSignatures(
	tx: Transaction,
	sigs: Map<number, Buffer>,
	devicePubkeys: Uint8Array[]
): void {
	if (devicePubkeys.length !== tx.inputsLength) {
		throw new LedgerError(
			`Have ${devicePubkeys.length} device keys for ${tx.inputsLength} inputs.`,
			'unexpected'
		);
	}
	if (sigs.size === 0) {
		throw new LedgerError('The Ledger returned no signatures for this vault.', 'unexpected');
	}
	sigs.forEach((sig, index) => {
		if (!Number.isInteger(index) || index < 0 || index >= tx.inputsLength) {
			throw new LedgerError(
				`The Ledger returned a signature for nonexistent input ${index}.`,
				'unexpected'
			);
		}
		const sigBytes = toU8(sig);
		if (sigBytes.length === 0) {
			throw new LedgerError(`The Ledger returned an empty signature for input ${index}.`, 'unexpected');
		}
		const pubkey = devicePubkeys[index];
		const derivations = tx.getInput(index).bip32Derivation;
		if (!derivations || !derivations.some(([pk]) => buffersEqual(Uint8Array.from(pk), pubkey))) {
			throw new LedgerError(
				`The signature for input ${index} is from a key that isn't part of this vault.`,
				'unexpected'
			);
		}
		tx.updateInput(index, { partialSig: [[pubkey, sigBytes]] });
	});
}

// ---- device-side policy plumbing (BIP-388 serialization + REGISTER_WALLET) --

// v2 APDU protocol constants (see LedgerHQ/app-bitcoin-new doc/bitcoin.md) —
// the same values @ledgerhq/hw-app-btc's AppClient uses internally.
const CLA_BTC = 0xe1;
const CLA_FRAMEWORK = 0xf8;
const INS_REGISTER_WALLET = 0x02;
const INS_CONTINUE_INTERRUPTED = 0x01;
const APDU_PROTOCOL_VERSION = 1; // supported from version 2.1.0 of the app
const SW_INTERRUPTED = 0xe000;

interface PolicyDeps {
	ClientCommandInterpreter: new (progress: () => void) => {
		execute(request: Buffer): Buffer;
		addKnownPreimage(preimage: Buffer): void;
		addKnownList(elements: Buffer[]): void;
	};
	createVarint: (value: number) => Buffer;
	Merkle: new (leaves: Buffer[]) => { getRoot(): Buffer };
	hashLeaf: (buf: Buffer) => Buffer;
}

async function loadPolicyDeps(): Promise<PolicyDeps> {
	const [clientCommandsMod, varintMod, merkleMod] = await Promise.all([
		import('@ledgerhq/hw-app-btc/lib/newops/clientCommands'),
		import('@ledgerhq/hw-app-btc/lib/varint'),
		import('@ledgerhq/hw-app-btc/lib/newops/merkle')
	]);
	return {
		ClientCommandInterpreter: clientCommandsMod.ClientCommandInterpreter,
		createVarint: varintMod.createVarint,
		Merkle: merkleMod.Merkle,
		hashLeaf: merkleMod.hashLeaf
	};
}

/**
 * BIP-388 wallet-policy serialization v2 for a NAMED policy — byte-identical
 * to ledger-bitcoin's WalletPolicy.serialize():
 *   0x02 · varint(name length) · name · varint(template length) ·
 *   sha256(template) · varint(key count) · merkleRoot(hashLeaf(key)…)
 * (hw-app-btc's own WalletPolicy hardcodes an empty name, which is why this
 * driver serializes the named form itself.)
 */
function serializeVaultPolicy(policy: VaultWalletPolicy, deps: PolicyDeps): Buffer {
	const nameBytes = Buffer.from(policy.name, 'ascii');
	const templateBytes = Buffer.from(policy.template, 'ascii');
	const keysRoot = new deps.Merkle(
		policy.keys.map((k) => deps.hashLeaf(Buffer.from(k, 'ascii')))
	).getRoot();
	return Buffer.concat([
		Buffer.from([0x02]), // wallet policy version 2 (app ≥ 2.1.0)
		deps.createVarint(nameBytes.length),
		nameBytes,
		deps.createVarint(templateBytes.length),
		Buffer.from(sha256(templateBytes)),
		deps.createVarint(policy.keys.length),
		keysRoot
	]);
}

/** The structural shape AppClient.signPsbt expects of a wallet policy. */
interface DeviceWalletPolicy {
	descriptorTemplate: string;
	keys: string[];
	serialize(): Buffer;
	getWalletId(): Buffer;
}

function makeDeviceWalletPolicy(policy: VaultWalletPolicy, deps: PolicyDeps): DeviceWalletPolicy {
	const serialized = serializeVaultPolicy(policy, deps);
	return {
		descriptorTemplate: policy.template,
		keys: policy.keys,
		serialize: () => serialized,
		getWalletId: () => Buffer.from(sha256(serialized)) // wallet_id = sha256(serialization)
	};
}

/** Run one interruptible APDU exchange: send, serve the app's merkle-data
 *  requests via the interpreter until it stops yielding SW_INTERRUPTED, and
 *  return the final response body (status word stripped). Same loop as
 *  AppClient's private makeRequest. */
async function exchangeInterruptible(
	transport: { send(cla: number, ins: number, p1: number, p2: number, data: Buffer, statusList: number[]): Promise<Buffer> },
	ins: number,
	data: Buffer,
	interpreter: { execute(request: Buffer): Buffer }
): Promise<Buffer> {
	let response = await transport.send(CLA_BTC, ins, 0, APDU_PROTOCOL_VERSION, data, [
		0x9000,
		SW_INTERRUPTED
	]);
	while (response.readUInt16BE(response.length - 2) === SW_INTERRUPTED) {
		const hwRequest = response.subarray(0, response.length - 2);
		response = await transport.send(
			CLA_FRAMEWORK,
			INS_CONTINUE_INTERRUPTED,
			0,
			APDU_PROTOCOL_VERSION,
			interpreter.execute(hwRequest),
			[0x9000, SW_INTERRUPTED]
		);
	}
	return response.subarray(0, response.length - 2);
}

/** Prime a ClientCommandInterpreter with everything the app may request while
 *  processing a wallet policy (the policy preimage, the keys list, the
 *  template preimage) — mirrors ledger-bitcoin's addKnownWalletPolicy. */
function primeInterpreterWithPolicy(
	interpreter: { addKnownPreimage(p: Buffer): void; addKnownList(l: Buffer[]): void },
	policy: VaultWalletPolicy,
	device: DeviceWalletPolicy
): void {
	interpreter.addKnownPreimage(device.serialize());
	interpreter.addKnownList(policy.keys.map((k) => Buffer.from(k, 'ascii')));
	interpreter.addKnownPreimage(Buffer.from(policy.template, 'ascii'));
}

/**
 * Register a vault's BIP-388 policy on a connected Ledger — the one-time,
 * per-device on-device approval multisig signing requires. The device walks
 * the user through the policy name, quorum and every cosigner key on its own
 * screen, then returns { policyId, policyHmac }. The caller persists the HMAC
 * (it is not a secret — it only suppresses re-approval) and passes it to
 * every later signVaultPsbtWithLedger call.
 *
 * Throws a LedgerError on every failure, including `wrong_device` when the
 * connected Ledger's master fingerprint matches none of the vault's keys.
 */
export async function registerVaultPolicy(
	params: VaultPolicyParams
): Promise<{ masterFp: string; policyHmac: string; policyId: string }> {
	if (!isWebHidAvailable()) {
		throw new LedgerError(
			'WebHID is not available in this browser. Ledger signing needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unavailable'
		);
	}

	// Build (and validate) the policy before touching the device.
	const policy = buildVaultPolicy(params);

	const [transportMod, appClientMod, deps] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient'),
		loadPolicyDeps()
	]);
	const { default: TransportWebHID } = transportMod;
	const { AppClient } = appClientMod;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let transport: any;
	try {
		try {
			transport = await TransportWebHID.create();
		} catch (err) {
			throw toLedgerError(err);
		}
		const client: AppClientType = new AppClient(transport);

		let masterFp: Buffer;
		try {
			masterFp = await client.getMasterFingerprint();
		} catch (err) {
			throw toLedgerError(err);
		}
		const fpHex = bytesToFpHex(masterFp);
		assertDeviceIsVaultCosigner(fpHex, params.keys);

		const device = makeDeviceWalletPolicy(policy, deps);
		const interpreter = new deps.ClientCommandInterpreter(() => {});
		primeInterpreterWithPolicy(interpreter, policy, device);

		// REGISTER_WALLET command data: varint(length) · serialized policy.
		// Response: 32-byte wallet id · 32-byte HMAC.
		const serialized = device.serialize();
		let result: Buffer;
		try {
			result = await exchangeInterruptible(
				transport,
				INS_REGISTER_WALLET,
				Buffer.concat([deps.createVarint(serialized.length), serialized]),
				interpreter
			);
		} catch (err) {
			throw toLedgerError(err);
		}
		if (result.length !== 64) {
			throw new LedgerError(
				`The Ledger returned an unexpected registration response (${result.length} bytes).`,
				'unexpected'
			);
		}
		return {
			masterFp: fpHex,
			policyId: bytesToHex(Uint8Array.from(result.subarray(0, 32))),
			policyHmac: bytesToHex(Uint8Array.from(result.subarray(32, 64)))
		};
	} finally {
		if (transport) {
			try {
				await transport.close();
			} catch {
				/* releasing the HID handle is best-effort */
			}
		}
	}
}

/**
 * Sign a vault (M-of-N multisig) PSBT with a Ledger and return the PSBT with
 * this device's signatures merged in (other cosigners' partialSigs preserved).
 *
 * Requires the vault's policy to be REGISTERED on this device first
 * (registerVaultPolicy): the app refuses named policies without a valid HMAC,
 * so a missing HMAC is rejected up-front with code `policy_unregistered` —
 * the UI should route the user through registration and retry. `policyName`
 * must be the exact name the policy was registered under (the HMAC covers it).
 *
 * Flow:
 *   1. Rebuild the wallet policy (byte-identical to registration — same
 *      case-sensitive key sort) and this device's per-input pubkeys.
 *   2. Verify the connected device's master fingerprint is one of the vault's
 *      keys (`wrong_device` otherwise).
 *   3. Convert the PSBT to PsbtV2 and signPsbt with the policy + HMAC; the
 *      device shows the outputs and blocks on physical approval.
 *   4. Merge the returned [inputIndex → signature] entries back into the
 *      ORIGINAL PSBT as partialSig entries with pubkey validation.
 */
export async function signVaultPsbtWithLedger(
	params: VaultSignParams & { policyName: string; policyHmac: string | null }
): Promise<string> {
	if (params.policyHmac == null || params.policyHmac === '') {
		throw new LedgerError(
			"This vault isn't registered on this Ledger yet. Register it first (a one-time on-device review of the vault's keys), then sign.",
			'policy_unregistered'
		);
	}
	if (!isWebHidAvailable()) {
		throw new LedgerError(
			'WebHID is not available in this browser. Ledger signing needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unavailable'
		);
	}
	let hmac: Buffer;
	try {
		hmac = Buffer.from(hexToBytes(params.policyHmac.trim()));
	} catch (err) {
		throw new LedgerError('The stored vault registration is unreadable — register this vault on the Ledger again.', 'unexpected', { cause: err });
	}
	if (hmac.length !== 32) {
		throw new LedgerError('The stored vault registration is unreadable — register this vault on the Ledger again.', 'unexpected');
	}

	// Build everything the device flow needs BEFORE the first device prompt.
	const policy = buildVaultPolicy(params);
	let sourceTx: Transaction;
	try {
		sourceTx = Transaction.fromPSBT(base64.decode(params.unsignedPsbt.trim()));
	} catch (err) {
		throw new LedgerError('That transaction could not be read as a PSBT.', 'bad_psbt', {
			cause: err
		});
	}

	const [transportMod, appClientMod, psbtMod, deps] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient'),
		import('@ledgerhq/psbtv2'),
		loadPolicyDeps()
	]);
	const { default: TransportWebHID } = transportMod;
	const { AppClient } = appClientMod;
	const { PsbtV2 } = psbtMod;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let transport: any;
	try {
		try {
			transport = await TransportWebHID.create();
		} catch (err) {
			throw toLedgerError(err);
		}
		const client: AppClientType = new AppClient(transport);

		let masterFp: Buffer;
		try {
			masterFp = await client.getMasterFingerprint();
		} catch (err) {
			throw toLedgerError(err);
		}
		const fpHex = bytesToFpHex(masterFp);
		const deviceKeyIndex = assertDeviceIsVaultCosigner(fpHex, params.keys);
		const devicePubkeys = vaultDevicePubkeys(params.unsignedPsbt, params.keys[deviceKeyIndex]);

		// Convert Cairn's BIP174 (v0) PSBT to the PsbtV2 the app client wants.
		let psbtV2: InstanceType<typeof PsbtV2>;
		try {
			psbtV2 = PsbtV2.fromV0(Buffer.from(sourceTx.toPSBT()));
		} catch (err) {
			throw new LedgerError(
				'This transaction could not be prepared for the Ledger (unsupported PSBT shape).',
				'bad_psbt',
				{ cause: err }
			);
		}
		// PsbtV2.fromV0 does not copy PSBT_IN_WITNESS_SCRIPT (0x05). The app
		// derives the script from the registered policy itself, so signing works
		// without it — but carry it across anyway (spec-correct, and harmless)
		// via the library's generic key setter when it exists.
		const rawPsbt = psbtV2 as unknown as {
			setInput?: (index: number, keyType: number, keyData: Buffer, value: Buffer) => void;
		};
		if (typeof rawPsbt.setInput === 'function') {
			for (let i = 0; i < sourceTx.inputsLength; i++) {
				const ws = sourceTx.getInput(i).witnessScript;
				if (ws) rawPsbt.setInput(i, 0x05, Buffer.alloc(0), Buffer.from(ws));
			}
		}

		const device = makeDeviceWalletPolicy(policy, deps);
		// The device shows the outputs and blocks on physical approval. A stale
		// HMAC (e.g. the device was reset and re-seeded) surfaces as an on-device
		// status error mapped by toLedgerError.
		let sigs: Map<number, Buffer>;
		try {
			sigs = await client.signPsbt(psbtV2, device, hmac, () => {});
		} catch (err) {
			throw toLedgerError(err);
		}

		mergeVaultSignatures(sourceTx, sigs, devicePubkeys);

		return base64.encode(sourceTx.toPSBT());
	} finally {
		if (transport) {
			try {
				await transport.close();
			} catch {
				/* releasing the HID handle is best-effort */
			}
		}
	}
}

/** Wrong-device guard shared by registration and signing: the connected
 *  Ledger's master fingerprint must be one of the vault's keys. Returns the
 *  matching key index. */
function assertDeviceIsVaultCosigner(deviceFpHex: string, keys: VaultSignKey[]): number {
	const index = keys.findIndex((k) => k.fingerprint.toLowerCase() === deviceFpHex);
	if (index < 0) {
		throw new LedgerError(
			`This Ledger isn't one of this vault's keys — its fingerprint is ${deviceFpHex}, and the vault expects ${keys
				.map((k) => k.fingerprint.toLowerCase())
				.join(', ')}. Connect one of the vault's devices.`,
			'wrong_device'
		);
	}
	return index;
}

/**
 * Read a vault cosigner key straight from a connected Ledger for the vault
 * creation wizard: the BIP-48 account xpub at m/48'/0'/{account}'/{script}'
 * plus the device's master fingerprint (which the Ledger app reports
 * directly, unlike Trezor Connect). Silent reads — the wizard's on-screen
 * vault test address is the cross-check.
 *
 * Returns exactly the { xpub, fingerprint, path } shape vault keys store
 * (standard xpub form, apostrophe path notation).
 */
export async function readVaultKeyFromLedger(
	scriptType: VaultScriptType,
	account = 0
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	if (!isWebHidAvailable()) {
		throw new LedgerError(
			'WebHID is not available in this browser. Ledger signing needs a Chromium-based desktop browser (Chrome, Edge, or Brave) served over HTTPS or localhost.',
			'unavailable'
		);
	}
	const path = vaultAccountPath(scriptType, account);
	const pathElements = parseVaultKeyPath(path, 'vault account path');

	const [transportMod, appClientMod] = await Promise.all([
		import('@ledgerhq/hw-transport-webhid'),
		import('@ledgerhq/hw-app-btc/lib/newops/appClient')
	]);
	const { default: TransportWebHID } = transportMod;
	const { AppClient } = appClientMod;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let transport: any;
	try {
		try {
			transport = await TransportWebHID.create();
		} catch (err) {
			throw toLedgerError(err);
		}
		const client: AppClientType = new AppClient(transport);
		let masterFp: Buffer;
		let xpub: string;
		try {
			masterFp = await client.getMasterFingerprint();
			xpub = await client.getExtendedPubkey(false, pathElements);
		} catch (err) {
			throw toLedgerError(err);
		}
		return { xpub, fingerprint: bytesToFpHex(masterFp), path };
	} finally {
		if (transport) {
			try {
				await transport.close();
			} catch {
				/* releasing the HID handle is best-effort */
			}
		}
	}
}
