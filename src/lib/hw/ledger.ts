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
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils.js';

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
