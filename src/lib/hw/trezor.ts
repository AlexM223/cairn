// Trezor hardware-wallet signer — Trezor Connect v9 (popup) driver.
//
// Framework-agnostic on purpose: no Svelte, no DOM beyond the secure-context
// feature check, so the pure logic (PSBT → Connect signTransaction params,
// signature merge-back) is unit-testable without a device. The heavy
// @trezor/connect-web module is imported lazily inside signPsbtWithTrezor —
// never at module top level — so SSR and non-Trezor users never pay to load it.
//
// One deliberate difference from the Ledger driver: Trezor Connect loads its
// device UI / signing core as a POPUP from connect.trezor.io. The popup is
// Trezor's supported browser integration (it holds the WebUSB/Bridge transport
// permissions, so the host page needs no WebHID/WebUSB of its own) — but it
// means signing opens a trezor.io window. Nothing secret crosses it: Connect
// receives the same unsigned transaction the device is about to display.
//
// Cairn holds no private keys: the device signs. We hand the device the exact
// inputs/outputs of the unsigned PSBT built by src/lib/server/bitcoin/psbt.ts,
// receive per-input signatures, and merge them back into that same PSBT so the
// returned base64 commits to the identical inputs/outputs the user reviewed.
// The parent Sign step re-checks that commitment server-side
// (assertSameTransaction).

import { Transaction, Address, OutScript, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

const HARDENED = 0x80000000;
const SIGHASH_ALL = 0x01;

/**
 * A typed error the UI can present verbatim. `code` lets callers branch (e.g.
 * offer "approve the popup" vs "reconnect the device") without string-matching.
 */
export type TrezorErrorCode =
	| 'unavailable' // not a secure browser context — the Connect popup can't run
	| 'rejected' // user declined on the device itself
	| 'cancelled' // popup closed / permissions not granted (host-side, not on-device)
	| 'no_device' // no Trezor found, or it disconnected mid-flow
	| 'bad_psbt' // the PSBT lacks the data Trezor Connect needs
	| 'unexpected'; // anything else

export class TrezorError extends Error {
	constructor(
		message: string,
		public readonly code: TrezorErrorCode,
		options?: { cause?: unknown }
	) {
		super(message);
		this.name = 'TrezorError';
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

/**
 * True in any browser running in a secure context (HTTPS or localhost). Unlike
 * Ledger's WebHID, Trezor Connect works cross-browser: the popup it opens on
 * connect.trezor.io holds the device transport, so the host page only needs to
 * be allowed to open that popup.
 */
export function isTrezorConnectAvailable(): boolean {
	return typeof window !== 'undefined' && window.isSecureContext === true;
}

// BIP purpose (first, hardened path element) → Trezor input/change-output
// script types (the firmware's InputScriptType/OutputScriptType enums). Same
// purposes the Ledger driver accepts.
const PURPOSE_INPUT_SCRIPT: Record<number, TrezorInputScriptType> = {
	44: 'SPENDADDRESS',
	49: 'SPENDP2SHWITNESS',
	84: 'SPENDWITNESS',
	86: 'SPENDTAPROOT'
};
const PURPOSE_CHANGE_SCRIPT: Record<number, TrezorChangeScriptType> = {
	44: 'PAYTOADDRESS',
	49: 'PAYTOP2SHWITNESS',
	84: 'PAYTOWITNESS',
	86: 'PAYTOTAPROOT'
};

export type TrezorInputScriptType =
	| 'SPENDADDRESS'
	| 'SPENDP2SHWITNESS'
	| 'SPENDWITNESS'
	| 'SPENDTAPROOT';
export type TrezorChangeScriptType =
	| 'PAYTOADDRESS'
	| 'PAYTOP2SHWITNESS'
	| 'PAYTOWITNESS'
	| 'PAYTOTAPROOT';

/** One PSBT input translated to Connect's signTransaction shape. */
export interface TrezorInput {
	/** Full derivation path, hardened elements offset (e.g. [84', 0', 0', 0, 4]). */
	address_n: number[];
	/** Previous txid, display-order hex. */
	prev_hash: string;
	prev_index: number;
	/** Sats as a decimal string (Connect's UintType). */
	amount: string;
	script_type: TrezorInputScriptType;
	sequence: number;
}

/**
 * One PSBT output translated to Connect's shape. Outputs carrying their own
 * bip32Derivation are sent as address_n so the device recognizes them as
 * change (and doesn't ask the user to confirm paying themselves); everything
 * else is sent as a plain address the device displays for verification.
 */
export type TrezorOutput =
	| { address: string; address_n?: undefined; amount: string; script_type: 'PAYTOADDRESS' }
	| { address?: undefined; address_n: number[]; amount: string; script_type: TrezorChangeScriptType };

/**
 * A previous transaction, re-serialized for the firmware's streaming TxAck
 * protocol. Required for legacy (non-segwit) inputs: the device recomputes the
 * prev txid from these fields to verify the claimed input amount. Built from
 * the PSBT's own nonWitnessUtxo — never fetched from a third party.
 */
export interface TrezorRefTx {
	/** Display-order txid hex — must hash-match the serialized fields below. */
	hash: string;
	version: number;
	inputs: { prev_hash: string; prev_index: number; script_sig: string; sequence: number }[];
	bin_outputs: { amount: number; script_pubkey: string }[];
	lock_time: number;
}

/** Everything TrezorConnect.signTransaction needs, derived purely from a PSBT. */
export interface TrezorSignRequest {
	coin: 'btc'; // Cairn is mainnet-only (psbt.ts builds against NETWORK)
	inputs: TrezorInput[];
	outputs: TrezorOutput[];
	refTxs?: TrezorRefTx[];
	/** Passed explicitly so the signed tx commits to the PSBT's exact fields. */
	version: number;
	locktime: number;
}

/**
 * Translate an unsigned PSBT into Trezor Connect signTransaction params.
 * Everything is read from the PSBT itself — derivation paths from each input's
 * bip32Derivation, amounts from witnessUtxo / nonWitnessUtxo, prev txs for
 * legacy inputs from nonWitnessUtxo — never hardcoded, so a wallet on a
 * non-default account (m/84'/0'/3') still signs.
 *
 * Exported for unit testing: this is the load-bearing pure logic.
 */
export function trezorSignRequestFromPsbt(unsignedPsbtBase64: string): TrezorSignRequest {
	const tx = parsePsbt(unsignedPsbtBase64);
	if (tx.inputsLength === 0) {
		throw new TrezorError('This transaction has no inputs to sign.', 'bad_psbt');
	}

	const inputs: TrezorInput[] = [];
	// Keyed by txid: several inputs may spend outputs of the same previous tx.
	const refTxs = new Map<string, TrezorRefTx>();

	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			throw new TrezorError(
				'This transaction is missing the key-origin information the Trezor needs to sign. Re-create it from a wallet set up with its master fingerprint.',
				'bad_psbt'
			);
		}
		// bip32Derivation entries are [pubkey, { fingerprint, path: number[] }].
		const [, meta] = derivations[0];
		const path = meta.path;
		if (!path || path.length < 3) {
			throw new TrezorError('The transaction has an unexpected derivation path.', 'bad_psbt');
		}
		const purpose = path[0] - HARDENED;
		const scriptType = PURPOSE_INPUT_SCRIPT[purpose];
		if (!scriptType) {
			throw new TrezorError(
				`This wallet's derivation (purpose ${purpose}') is not a standard single-sig account the Trezor can sign.`,
				'bad_psbt'
			);
		}
		if (!input.txid || input.index === undefined || input.sequence === undefined) {
			throw new TrezorError('The transaction has an incomplete input.', 'bad_psbt');
		}

		// The input amount the device will display. Segwit inputs carry it in
		// witnessUtxo; legacy inputs prove it via the full previous transaction.
		let amount: bigint;
		if (input.witnessUtxo) {
			amount = input.witnessUtxo.amount;
		} else if (input.nonWitnessUtxo) {
			const prevOut = input.nonWitnessUtxo.outputs[input.index];
			if (!prevOut) {
				throw new TrezorError(
					'An input references an output its previous transaction does not have.',
					'bad_psbt'
				);
			}
			amount = prevOut.amount;
			const hash = bytesToHex(input.txid);
			if (!refTxs.has(hash)) refTxs.set(hash, refTxFromNonWitnessUtxo(hash, input.nonWitnessUtxo));
		} else {
			throw new TrezorError(
				'An input is missing its coin data (no witnessUtxo or previous transaction).',
				'bad_psbt'
			);
		}

		inputs.push({
			address_n: [...path],
			prev_hash: bytesToHex(input.txid),
			prev_index: input.index,
			amount: amount.toString(),
			script_type: scriptType,
			sequence: input.sequence
		});
	}

	const outputs: TrezorOutput[] = [];
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		if (!out.script || out.amount === undefined) {
			throw new TrezorError('The transaction has an incomplete output.', 'bad_psbt');
		}
		const derivations = out.bip32Derivation;
		if (derivations && derivations.length > 0) {
			// Change back to this wallet: send the path so the device treats it as
			// change rather than a second recipient to confirm.
			const path = derivations[0][1].path;
			const changeType = path && path.length >= 3 ? PURPOSE_CHANGE_SCRIPT[path[0] - HARDENED] : undefined;
			if (!path || !changeType) {
				throw new TrezorError('A change output has an unexpected derivation path.', 'bad_psbt');
			}
			outputs.push({ address_n: [...path], amount: out.amount.toString(), script_type: changeType });
		} else {
			const address = addressFromScript(out.script);
			if (!address) {
				throw new TrezorError(
					'The transaction pays an output the Trezor cannot display as an address.',
					'bad_psbt'
				);
			}
			outputs.push({ address, amount: out.amount.toString(), script_type: 'PAYTOADDRESS' });
		}
	}

	return {
		coin: 'btc',
		inputs,
		outputs,
		...(refTxs.size > 0 ? { refTxs: [...refTxs.values()] } : {}),
		version: tx.version,
		locktime: tx.lockTime
	};
}

/**
 * Account path (hardened elements only, e.g. [84',0',0']) from the first
 * input's bip32Derivation — the full path minus the trailing (chain, index).
 * Used to ask the device for the matching account node.
 *
 * Exported for unit testing.
 */
export function accountPathFromPsbt(unsignedPsbtBase64: string): number[] {
	const tx = parsePsbt(unsignedPsbtBase64);
	if (tx.inputsLength === 0) {
		throw new TrezorError('This transaction has no inputs to sign.', 'bad_psbt');
	}
	const derivations = tx.getInput(0).bip32Derivation;
	if (!derivations || derivations.length === 0) {
		throw new TrezorError(
			'This transaction is missing the key-origin information the Trezor needs to sign. Re-create it from a wallet set up with its master fingerprint.',
			'bad_psbt'
		);
	}
	const path = derivations[0][1].path;
	if (!path || path.length < 3) {
		throw new TrezorError('The transaction has an unexpected derivation path.', 'bad_psbt');
	}
	return path.slice(0, -2);
}

/**
 * Wrong-device guard: verify the connected Trezor actually holds the keys this
 * PSBT declares. Trezor's signatures come back positionally (no pubkey
 * attached), so before signing we fetch the device's account node and derive
 * each input's child key ourselves — every derived pubkey must equal the one
 * the PSBT's bip32Derivation declares. Only then can a positional signature be
 * safely attributed to that pubkey. (Connect never reports the master
 * fingerprint, so this pubkey-level check stands in for the Ledger driver's
 * fingerprint comparison — and is strictly stronger.)
 *
 * `account` is the device-reported account node (Connect's HDNodeResponse
 * publicKey/chainCode, hex). Exported for unit testing.
 */
export function assertAccountMatchesPsbt(
	tx: Transaction,
	accountPath: number[],
	account: { publicKey: string; chainCode: string }
): void {
	let node: HDKey;
	try {
		node = new HDKey({
			publicKey: hexToBytes(account.publicKey),
			chainCode: hexToBytes(account.chainCode)
		});
	} catch (err) {
		throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected', {
			cause: err
		});
	}

	for (let i = 0; i < tx.inputsLength; i++) {
		const derivations = tx.getInput(i).bip32Derivation;
		if (!derivations || derivations.length === 0) continue; // taproot inputs carry tap fields instead
		const [pubkey, meta] = derivations[0];
		const path = meta.path;
		// Cairn wallets are single-account: every input must extend the same
		// account path by exactly (chain, index), both non-hardened.
		const suffix = path.slice(accountPath.length);
		if (
			path.length !== accountPath.length + 2 ||
			!accountPath.every((v, j) => path[j] === v) ||
			suffix.some((v) => v >= HARDENED)
		) {
			throw new TrezorError('The transaction mixes inputs from different accounts.', 'bad_psbt');
		}
		const child = node.deriveChild(suffix[0]).deriveChild(suffix[1]);
		if (!child.publicKey || !bytesEqual(child.publicKey, Uint8Array.from(pubkey))) {
			throw new TrezorError(
				"This Trezor does not hold this wallet's keys — its account key derives different addresses than the transaction spends. Connect the correct device.",
				'unexpected'
			);
		}
	}
}

/**
 * Merge the device's positional signatures back into the source PSBT.
 *
 * Connect returns one hex signature per input, in input order, DER-encoded
 * WITHOUT the sighash byte. We append SIGHASH_ALL (the only mode Trezor signs
 * standard payments with, and the only mode Cairn's PSBTs request) and pair
 * each signature with the input's bip32Derivation pubkey — the PSBT's own
 * declaration, never a device-claimed key. Taproot inputs (no ECDSA
 * derivation) get the 64-byte Schnorr signature as tapKeySig.
 *
 * Exported for unit testing.
 */
export function mergeTrezorSignatures(tx: Transaction, signatures: string[]): void {
	if (signatures.length !== tx.inputsLength) {
		throw new TrezorError(
			`The Trezor returned ${signatures.length} signatures for ${tx.inputsLength} inputs.`,
			'unexpected'
		);
	}

	signatures.forEach((sigHex, index) => {
		let sig: Uint8Array;
		try {
			sig = hexToBytes(sigHex);
		} catch (err) {
			throw new TrezorError(
				`The Trezor returned an unreadable signature for input ${index}.`,
				'unexpected',
				{ cause: err }
			);
		}
		const input = tx.getInput(index);

		// Taproot: no bip32Derivation, the 64-byte Schnorr sig goes into tapKeySig.
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			if ((input.tapInternalKey || input.tapBip32Derivation) && sig.length === 64) {
				tx.updateInput(index, { tapKeySig: sig });
				return;
			}
			throw new TrezorError(
				`The Trezor returned a signature for input ${index} but that input has no key-origin to attach it to.`,
				'unexpected'
			);
		}

		// ECDSA inputs: a DER signature always starts with the 0x30 sequence tag.
		// A malformed blob here would produce an unbroadcastable transaction — fail
		// loudly now instead of at the node.
		if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30) {
			throw new TrezorError(
				`The Trezor returned a malformed signature for input ${index}.`,
				'unexpected'
			);
		}
		const withHashType = new Uint8Array(sig.length + 1);
		withHashType.set(sig);
		withHashType[sig.length] = SIGHASH_ALL;

		// Single-key inputs carry exactly one derivation → one pubkey.
		const [pubkey] = derivations[0];
		tx.updateInput(index, { partialSig: [[Uint8Array.from(pubkey), withHashType]] });
	});
}

/**
 * Translate a raw Connect failure (thrown error or `{ success: false }`
 * payload) into a typed, plain-language TrezorError. Order matters:
 * Failure_ActionCancelled (an ON-DEVICE rejection) must be caught before the
 * generic /cancel/ branch, or a device rejection would read as a host-side
 * popup cancellation. Anything unrecognized is surfaced verbatim under
 * `unexpected` rather than swallowed.
 */
export function toTrezorError(err: unknown): TrezorError {
	if (err instanceof TrezorError) return err;

	const anyErr = err as { error?: unknown; message?: unknown; code?: unknown } | null;
	const msg = String((anyErr && (anyErr.error || anyErr.message)) || err || '');
	const code = String((anyErr && anyErr.code) || '');
	const hit = (re: RegExp) => re.test(msg) || re.test(code);

	if (hit(/Failure_ActionCancelled/i)) {
		return new TrezorError('You rejected the request on the Trezor.', 'rejected', { cause: err });
	}
	if (hit(/Method_PermissionsNotGranted|permissions not granted/i)) {
		return new TrezorError(
			'Trezor Connect needs your approval — grant the permissions in the Connect popup, then try again.',
			'cancelled',
			{ cause: err }
		);
	}
	if (hit(/cancel|Method_Cancel|Method_Interrupted|popup.*clos|closed/i)) {
		return new TrezorError(
			'The Trezor request was cancelled. Try again and approve it in the popup and on the device.',
			'cancelled',
			{ cause: err }
		);
	}
	if (hit(/Device_Disconnected|disconnect|Device_NotFound|no device|Transport/i)) {
		return new TrezorError(
			'No Trezor found. Plug it in, unlock it, then try again.',
			'no_device',
			{ cause: err }
		);
	}
	if (hit(/Failure_DataError|Forbidden key path/i)) {
		return new TrezorError(
			'The Trezor refused this transaction as malformed. Re-create the draft and try again.',
			'bad_psbt',
			{ cause: err }
		);
	}
	// Generic firmware refusals, AFTER the specific "Forbidden key path" above.
	if (hit(/forbidden|not allowed/i)) {
		return new TrezorError('You rejected the request on the Trezor.', 'rejected', { cause: err });
	}
	if (hit(/firmware|outdated/i)) {
		return new TrezorError('Update your Trezor firmware, then try again.', 'unexpected', {
			cause: err
		});
	}
	return new TrezorError(msg ? `Trezor error: ${msg}` : 'The Trezor request failed.', 'unexpected', {
		cause: err
	});
}

// Connect init is memoized single-flight: TrezorConnect.init throws if called
// twice, but a FAILED init (popup blocked, user closed it) must be retryable —
// so the promise is nulled on rejection. Nothing here runs until the first
// device call: the module import and init both live inside ensureInit.
type TrezorConnectApi = (typeof import('@trezor/connect-web'))['default'];
let initPromise: Promise<TrezorConnectApi> | null = null;

async function ensureInit(): Promise<TrezorConnectApi> {
	if (!initPromise) {
		initPromise = (async () => {
			const mod = await import('@trezor/connect-web');
			// Some bundlers' CJS/ESM interop (observed with Vite's dep pre-bundling)
			// double-wraps this package's default export as `{ default: { default:
			// <real API>, ...named exports } }` instead of unwrapping it to the real
			// API directly. Detect the real API by the presence of `.init` rather
			// than assuming either shape, so this keeps working if a bundler's
			// interop behavior changes.
			const unwrapped = mod.default as unknown as { default?: TrezorConnectApi };
			const TrezorConnect: TrezorConnectApi =
				typeof mod.default?.init === 'function'
					? mod.default
					: (unwrapped.default as TrezorConnectApi);
			await TrezorConnect.init({
				// Trezor requires a developer manifest on every integration. Cairn is
				// self-hosted open source, so these identify the app, not a company.
				manifest: { appName: 'Cairn', email: 'admin@cairn.local', appUrl: window.location.origin },
				lazyLoad: false,
				popup: true
			});
			return TrezorConnect;
		})().catch((err) => {
			initPromise = null;
			throw toTrezorError(err);
		});
	}
	return initPromise;
}

/**
 * Sign a single-sig PSBT with a Trezor via Connect's popup and return the
 * signed PSBT as base64.
 *
 * Flow (keeps Cairn's own btc-signer PSBT as the source of truth so the
 * returned commitment is byte-for-byte the reviewed transaction):
 *   1. Translate the PSBT into Connect signTransaction params — derivation
 *      paths, amounts, prev txs all read from the PSBT itself, never fetched.
 *   2. Lazily load + init Trezor Connect (first call opens the popup).
 *   3. Silently read the device's account node and verify every input pubkey
 *      the PSBT declares actually derives from it (wrong-device guard — see
 *      assertAccountMatchesPsbt for why this is required with positional sigs).
 *   4. signTransaction: the device shows each output on its own screen and
 *      blocks on physical approval.
 *   5. Merge the returned per-input signatures back into the ORIGINAL
 *      btc-signer PSBT (partialSig, or tapKeySig for taproot) and return base64.
 *
 * Throws a TrezorError (typed, plain-language) on every failure.
 */
export async function signPsbtWithTrezor(unsignedPsbtBase64: string): Promise<string> {
	if (!isTrezorConnectAvailable()) {
		throw new TrezorError(
			'Trezor signing needs a secure browser context (HTTPS or localhost) so the Trezor Connect popup can open.',
			'unavailable'
		);
	}

	// Build the request before we ever touch the device — a bad PSBT should fail
	// fast with a clear message, not after a popup and a device prompt.
	const request = trezorSignRequestFromPsbt(unsignedPsbtBase64);
	const accountPath = accountPathFromPsbt(unsignedPsbtBase64);

	// Parse the source PSBT once; this is the object we merge signatures into.
	const sourceTx = parsePsbt(unsignedPsbtBase64);

	const TrezorConnect = await ensureInit();

	// Wrong-device guard (silent read — nothing shown on the device screen).
	let account: { publicKey: string; chainCode: string };
	try {
		const res = await TrezorConnect.getPublicKey({
			path: [...accountPath],
			coin: 'btc',
			showOnTrezor: false
		});
		if (!res.success) throw toTrezorError(res.payload);
		account = res.payload;
	} catch (err) {
		throw toTrezorError(err);
	}
	assertAccountMatchesPsbt(sourceTx, accountPath, account);

	// The device shows the outputs and blocks on physical approval.
	let signatures: string[];
	try {
		const res = await TrezorConnect.signTransaction({
			coin: request.coin,
			inputs: request.inputs,
			outputs: request.outputs,
			...(request.refTxs ? { refTxs: request.refTxs } : {}),
			version: request.version,
			locktime: request.locktime,
			// Cairn broadcasts through its own node after the server-side
			// substitution guard — never let Connect push the transaction itself.
			push: false
		});
		if (!res.success) throw toTrezorError(res.payload);
		signatures = res.payload.signatures;
	} catch (err) {
		throw toTrezorError(err);
	}

	mergeTrezorSignatures(sourceTx, signatures);

	return base64.encode(sourceTx.toPSBT());
}

// ---------------------------------------------------------------- internals

function parsePsbt(unsignedPsbtBase64: string): Transaction {
	try {
		return Transaction.fromPSBT(base64.decode(unsignedPsbtBase64.trim()));
	} catch (err) {
		throw new TrezorError('That transaction could not be read as a PSBT.', 'bad_psbt', {
			cause: err
		});
	}
}

/**
 * Re-shape a decoded nonWitnessUtxo into the firmware's ref-tx form. Witness
 * data is deliberately absent: the firmware recomputes the txid from the
 * stripped serialization, which is exactly these fields.
 */
function refTxFromNonWitnessUtxo(
	hash: string,
	raw: NonNullable<ReturnType<Transaction['getInput']>['nonWitnessUtxo']>
): TrezorRefTx {
	return {
		hash,
		version: raw.version,
		inputs: raw.inputs.map((i) => ({
			prev_hash: bytesToHex(i.txid),
			prev_index: i.index,
			script_sig: bytesToHex(i.finalScriptSig),
			sequence: i.sequence
		})),
		bin_outputs: raw.outputs.map((o) => ({
			amount: Number(o.amount),
			script_pubkey: bytesToHex(o.script)
		})),
		lock_time: raw.lockTime
	};
}

function addressFromScript(script: Uint8Array): string | null {
	try {
		// btc-signer's OutScript union and Address's expected input differ only
		// in ArrayBuffer generics — safe to bridge. (Same idiom as psbt.ts.)
		return Address(NETWORK).encode(OutScript.decode(script) as never);
	} catch {
		return null;
	}
}

/** Byte equality for two same-length-or-not byte arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
