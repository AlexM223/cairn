// Trezor hardware-wallet signer — Trezor Connect v9 (popup) driver.
//
// Framework-agnostic on purpose: no Svelte, no DOM beyond a browser-environment
// check, so the pure logic (PSBT → Connect signTransaction params,
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
import type { ScriptType } from '$lib/types';
import {
	HARDENED,
	HwError,
	SINGLE_SIG_VERSIONS,
	formatKeyPath,
	multisigAccountPathIndexes,
	normalizeXpub,
	parseKeyPath,
	singleSigAccountPathIndexes,
	xpubWithVersion,
	type MultisigScriptType,
	type MultisigSignKey
} from './common';

const SIGHASH_ALL = 0x01;

/**
 * A typed error the UI can present verbatim. `code` lets callers branch (e.g.
 * offer "approve the popup" vs "reconnect the device") without string-matching.
 */
export type TrezorErrorCode =
	| 'unavailable' // not a browser (SSR/Node) — the Connect popup can't run
	| 'rejected' // user declined on the device itself
	| 'cancelled' // popup closed / permissions not granted (host-side, not on-device)
	| 'no_device' // no Trezor found, or it disconnected mid-flow
	| 'bad_psbt' // the PSBT lacks the data Trezor Connect needs
	| 'wrong_device' // the connected Trezor holds none of the multisig's keys
	| 'unexpected'; // anything else

export class TrezorError extends HwError<TrezorErrorCode> {
	constructor(message: string, code: TrezorErrorCode, options?: { cause?: unknown }) {
		super('TrezorError', message, code, options);
	}
}

/** Builds this driver's typed error for the shared common.ts helpers. */
const trezorFail = (message: string): TrezorError => new TrezorError(message, 'unexpected');

/**
 * True in any browser. Unlike Ledger's WebHID, Trezor Connect works
 * cross-browser AND from insecure origins (plain-HTTP Umbrel included): the
 * popup it opens on connect.trezor.io is its own secure context and holds the
 * device transport (WebUSB/Bridge), so the host page's scheme doesn't matter —
 * it only needs to be allowed to open that popup. Caravan ships the same popup
 * with no secure-context gate, verified working on Umbrel HTTP (cairn-n5ok).
 */
export function isTrezorConnectAvailable(): boolean {
	return typeof window !== 'undefined';
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
				manifest: { appName: 'Heartwood', email: 'admin@cairn.local', appUrl: window.location.origin },
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
			'Trezor Connect can only run in a web browser.',
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

// ------------------------------------------------------------------- multisigs
//
// MULTISIG ("multisig") signing. A multisig is an M-of-N sortedmulti (BIP-67) wallet
// in one of three script forms (see src/lib/server/bitcoin/multisig.ts). The
// Trezor firmware has no persistent multisig registration: the FULL cosigner
// set travels with every signTransaction call as a per-input `multisig` field.
//
// The one rule that matters (Bastion RISK #2): the `multisig.pubkeys` nodes
// MUST be listed in the SAME order as the pubkeys appear in the input's actual
// multisig script. Trezor does NOT sort them — a mismatched order makes the
// device build a different script, producing a signature that can never
// finalize. We therefore RECOVER the order from the PSBT's own
// witnessScript/redeemScript rather than re-sorting anything ourselves.
// (Connect also has `pubkeys_order: LEXICOGRAPHIC`, but that needs firmware
// ≥ 2.8.7 — explicit script-order nodes work on every firmware, so we use
// those and skip the flag entirely.)

// The multisig script forms and cosigner-key shape live in the client-safe
// common.ts (shared across drivers); re-exported so existing importers of this
// driver keep working.
export type { MultisigScriptType, MultisigSignKey } from './common';

/** Everything multisig signing needs. Framework-agnostic plain values the UI
 *  passes straight from the multisig row + the sign session's combined PSBT. */
export interface MultisigSignParams {
	/** Base64 PSBT — the CURRENT combined PSBT (other cosigners' partialSigs kept). */
	unsignedPsbt: string;
	threshold: number;
	keys: MultisigSignKey[];
	scriptType: MultisigScriptType;
}

export type TrezorMultisigInputScriptType = 'SPENDWITNESS' | 'SPENDP2SHWITNESS' | 'SPENDMULTISIG';
export type TrezorMultisigChangeScriptType = 'PAYTOWITNESS' | 'PAYTOP2SHWITNESS' | 'PAYTOSCRIPTHASH';

const MULTISIG_SPEND: Record<MultisigScriptType, TrezorMultisigInputScriptType> = {
	p2wsh: 'SPENDWITNESS',
	'p2sh-p2wsh': 'SPENDP2SHWITNESS',
	p2sh: 'SPENDMULTISIG'
};
const MULTISIG_PAYTO: Record<MultisigScriptType, TrezorMultisigChangeScriptType> = {
	p2wsh: 'PAYTOWITNESS',
	'p2sh-p2wsh': 'PAYTOP2SHWITNESS',
	p2sh: 'PAYTOSCRIPTHASH'
};

/** One cosigner node inside Connect's `multisig` field. `node` is the account
 *  xpub as a string (Connect deserializes it), `address_n` the non-hardened
 *  [chain, index] suffix appended to it. */
export interface TrezorMultisigPubkey {
	node: string;
	address_n: number[];
}

/** Connect's MultisigRedeemScriptType, as this driver emits it. */
export interface TrezorMultisig {
	/** In the SCRIPT's pubkey order — see the section comment. */
	pubkeys: TrezorMultisigPubkey[];
	/** Positional placeholders (''), one per cosigner. */
	signatures: string[];
	m: number;
}

export interface TrezorMultisigInput {
	/** This DEVICE's full derivation for the input (its origin + chain/index). */
	address_n: number[];
	prev_hash: string;
	prev_index: number;
	amount: string;
	script_type: TrezorMultisigInputScriptType;
	sequence: number;
	multisig: TrezorMultisig;
}

export type TrezorMultisigOutput =
	| { address: string; address_n?: undefined; amount: string; script_type: 'PAYTOADDRESS' }
	| {
			address?: undefined;
			address_n: number[];
			amount: string;
			script_type: TrezorMultisigChangeScriptType;
			multisig: TrezorMultisig;
	  };

export interface TrezorMultisigSignRequest {
	coin: 'btc';
	inputs: TrezorMultisigInput[];
	outputs: TrezorMultisigOutput[];
	refTxs?: TrezorRefTx[];
	version: number;
	locktime: number;
}

// SLIP-132 → standard-xpub rewriting lives in common.ts (normalizeXpub); this
// alias keeps the driver's historical vocabulary at its call sites. (Multisig
// rows store the xpub as the user pasted it, which may be ypub/zpub for
// single-sig-style prefixes or Ypub/Zpub for the multisig conventions.)
const normalizeMultisigXpub = normalizeXpub;

/** "m/48'/0'/0'/2'" (h/H/' markers, leading m/ optional) → hardened-offset
 *  index array; "m"/"" → []. */
function parseMultisigKeyPath(path: string, label: string): number[] {
	return parseKeyPath(path, label, trezorFail);
}

/** Hardened-offset index array → "m/48'/0'/0'/2'" (apostrophe markers). */
const formatMultisigKeyPath = formatKeyPath;

/**
 * Master fingerprint (8 lowercase hex) of an extended public key — hash160 of
 * the embedded pubkey, first 4 bytes. Given a depth-0 (m-level) xpub this is
 * the wallet's root fingerprint: the `xfp` used in PSBT key origins. Trezor
 * Connect never reports the master fingerprint directly (account-level
 * getPublicKey carries the PARENT's), so this recovers it from a silent
 * m-path xpub read — same convention as Bastion's xfpFromXpub.
 *
 * Exported for unit testing.
 */
export function xfpFromXpub(xpub: string): string {
	let node: HDKey;
	try {
		node = HDKey.fromExtendedKey(normalizeMultisigXpub(xpub));
	} catch (err) {
		throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected', {
			cause: err
		});
	}
	return (node.fingerprint >>> 0).toString(16).padStart(8, '0');
}

/**
 * The BIP-48 account path for a multisig cosigner key: m/48'/0'/{account}'/{script}'
 * where the script suffix is 2' for p2wsh and 1' for BOTH p2sh forms (BIP-48
 * gives p2sh and p2sh-p2wsh the same 1' — only native p2wsh gets 2'). Mainnet
 * only, matching the rest of Cairn. Exported for unit testing.
 */
export function multisigAccountPath(scriptType: MultisigScriptType, account = 0): string {
	return formatKeyPath(multisigAccountPathIndexes(scriptType, account, trezorFail));
}

/**
 * Parse an `OP_M <pubkey…> OP_N OP_CHECKMULTISIG` script into { m, pubkeys }
 * with the pubkeys in *script order* — for a sortedmulti multisig that IS the
 * BIP-67 order, recovered from the script itself rather than recomputed, so
 * the device is always shown exactly the script it must reproduce.
 *
 * Exported for unit testing.
 */
export function multisigScriptPubkeys(script: Uint8Array): { m: number; pubkeys: Uint8Array[] } {
	// OutScript's union carries TArg/TRet ArrayBuffer generics that don't
	// round-trip through a plain declaration — bridge them like addressFromScript.
	let decoded: { type: string; m?: number; pubkeys?: Uint8Array[] };
	try {
		decoded = OutScript.decode(script) as unknown as {
			type: string;
			m?: number;
			pubkeys?: Uint8Array[];
		};
	} catch (err) {
		throw new TrezorError('An input script could not be parsed as multisig.', 'bad_psbt', {
			cause: err
		});
	}
	if (decoded.type !== 'ms' || decoded.m === undefined || !decoded.pubkeys) {
		throw new TrezorError(
			`Expected a multisig script but found ${decoded.type} — this transaction was not built for this multisig.`,
			'bad_psbt'
		);
	}
	return { m: decoded.m, pubkeys: decoded.pubkeys.map((p) => Uint8Array.from(p)) };
}

/** Lexicographic byte order — the BIP-67 sort (used only for change outputs
 *  whose script is absent from the PSBT; inputs always use the script). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

interface ResolvedMultisigSignKey {
	hdkey: HDKey;
	/** Canonical xpub string (SLIP-132 normalized) — what Connect's `node` gets. */
	xpub: string;
	/** Parsed origin path (hardened offsets applied); [] when unknown ("m"). */
	origin: number[];
	/** Lowercase 8-hex fingerprint. */
	fingerprint: string;
}

function resolveMultisigSignKeys(params: {
	threshold: number;
	keys: MultisigSignKey[];
}): ResolvedMultisigSignKey[] {
	const keys = params.keys ?? [];
	if (keys.length === 0) {
		throw new TrezorError('This multisig has no keys.', 'unexpected');
	}
	if (
		!Number.isInteger(params.threshold) ||
		params.threshold < 1 ||
		params.threshold > keys.length
	) {
		throw new TrezorError(
			`Invalid multisig threshold ${params.threshold} for ${keys.length} keys.`,
			'unexpected'
		);
	}
	return keys.map((key, i) => {
		const label = `multisig key ${i + 1}`;
		const xpub = normalizeMultisigXpub(key.xpub);
		let hdkey: HDKey;
		try {
			hdkey = HDKey.fromExtendedKey(xpub);
		} catch (err) {
			throw new TrezorError(`${label}: unreadable extended public key.`, 'unexpected', {
				cause: err
			});
		}
		if (!/^[0-9a-fA-F]{8}$/.test(key.fingerprint)) {
			throw new TrezorError(`${label}: malformed fingerprint "${key.fingerprint}".`, 'unexpected');
		}
		return {
			hdkey,
			xpub: hdkey.publicExtendedKey,
			origin: parseMultisigKeyPath(key.path, label),
			fingerprint: key.fingerprint.toLowerCase()
		};
	});
}

/** The (chain, index) suffix shared by every bip32Derivation entry of an
 *  input/output. Throws if entries disagree or a suffix element is hardened. */
function multisigChainIndex(
	derivations: [Uint8Array | number[], { fingerprint: number; path: number[] }][],
	where: string
): [number, number] {
	let suffix: [number, number] | null = null;
	for (const [, meta] of derivations) {
		const path = meta.path;
		if (!path || path.length < 2) {
			throw new TrezorError(`${where} has an unexpected derivation path.`, 'bad_psbt');
		}
		const chain = path[path.length - 2];
		const index = path[path.length - 1];
		if (chain >= HARDENED || index >= HARDENED) {
			throw new TrezorError(`${where} has a hardened chain/index derivation.`, 'bad_psbt');
		}
		if (suffix && (suffix[0] !== chain || suffix[1] !== index)) {
			throw new TrezorError(`${where} mixes derivations of different addresses.`, 'bad_psbt');
		}
		suffix = [chain, index];
	}
	if (!suffix) throw new TrezorError(`${where} has no key-origin information.`, 'bad_psbt');
	return suffix;
}

/** Every cosigner's child pubkey at chain/index, in multisig-key order. */
function multisigChildPubkeys(
	resolved: ResolvedMultisigSignKey[],
	chain: number,
	index: number
): Uint8Array[] {
	return resolved.map((key, i) => {
		let pubkey: Uint8Array | null;
		try {
			pubkey = key.hdkey.deriveChild(chain).deriveChild(index).publicKey;
		} catch (err) {
			throw new TrezorError(`Key derivation failed for multisig key ${i + 1}.`, 'unexpected', {
				cause: err
			});
		}
		if (!pubkey) {
			throw new TrezorError(`Key derivation failed for multisig key ${i + 1}.`, 'unexpected');
		}
		return pubkey;
	});
}

/**
 * Build Connect's `multisig` field for one input/output. When `script` is
 * given (always, for inputs) the cosigner order is RECOVERED from it by
 * mapping each script pubkey back to the cosigner that derives it. When the
 * script is absent (tolerated only for change outputs, defensively) the
 * BIP-67 sort of the derived pubkeys is used — identical by construction for
 * a sortedmulti multisig, and the firmware independently verifies the resulting
 * script against the output anyway.
 */
function multisigMultisigField(
	resolved: ResolvedMultisigSignKey[],
	children: Uint8Array[],
	chain: number,
	index: number,
	script: Uint8Array | undefined,
	threshold: number,
	where: string
): TrezorMultisig {
	let order: number[];
	if (script) {
		const ms = multisigScriptPubkeys(script);
		if (ms.m !== threshold) {
			throw new TrezorError(
				`${where}: the script requires ${ms.m} signatures but this multisig's threshold is ${threshold}.`,
				'bad_psbt'
			);
		}
		if (ms.pubkeys.length !== resolved.length) {
			throw new TrezorError(
				`${where}: the script has ${ms.pubkeys.length} keys but this multisig has ${resolved.length}.`,
				'bad_psbt'
			);
		}
		const byHex = new Map(children.map((pk, ki) => [bytesToHex(pk), ki]));
		order = ms.pubkeys.map((pk) => {
			const ki = byHex.get(bytesToHex(pk));
			if (ki === undefined) {
				throw new TrezorError(
					`${where}: the multisig script contains a key that isn't derived from this multisig's cosigners.`,
					'bad_psbt'
				);
			}
			return ki;
		});
	} else {
		order = children.map((_, ki) => ki).sort((a, b) => compareBytes(children[a], children[b]));
	}
	return {
		pubkeys: order.map((ki) => ({ node: resolved[ki].xpub, address_n: [chain, index] })),
		signatures: order.map(() => ''),
		m: threshold
	};
}

/**
 * Translate a multisig PSBT into Connect signTransaction params for ONE cosigner
 * device (`deviceKeyIndex` into params.keys), plus the per-input pubkey the
 * device will be signing with (`devicePubkeys` — Trezor's signatures come back
 * positionally with no pubkey attached, so this is what the merge step
 * attributes them to).
 *
 * Exported for unit testing: this is the load-bearing pure logic.
 */
export function trezorMultisigSignRequest(
	params: MultisigSignParams,
	deviceKeyIndex: number
): { request: TrezorMultisigSignRequest; devicePubkeys: Uint8Array[] } {
	const resolved = resolveMultisigSignKeys(params);
	if (
		!Number.isInteger(deviceKeyIndex) ||
		deviceKeyIndex < 0 ||
		deviceKeyIndex >= resolved.length
	) {
		throw new TrezorError(`Invalid multisig key index ${deviceKeyIndex}.`, 'unexpected');
	}
	const spendType = MULTISIG_SPEND[params.scriptType];
	if (!spendType) {
		throw new TrezorError(`Unsupported multisig script type "${params.scriptType}".`, 'unexpected');
	}

	const tx = parsePsbt(params.unsignedPsbt);
	if (tx.inputsLength === 0) {
		throw new TrezorError('This transaction has no inputs to sign.', 'bad_psbt');
	}

	// Derive each address's cosigner set once — inputs often share (chain, index).
	const childCache = new Map<string, Uint8Array[]>();
	const childrenAt = (chain: number, index: number): Uint8Array[] => {
		const key = `${chain}/${index}`;
		let children = childCache.get(key);
		if (!children) {
			children = multisigChildPubkeys(resolved, chain, index);
			childCache.set(key, children);
		}
		return children;
	};

	const inputs: TrezorMultisigInput[] = [];
	const devicePubkeys: Uint8Array[] = [];
	const refTxs = new Map<string, TrezorRefTx>();

	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		const derivations = input.bip32Derivation;
		if (!derivations || derivations.length === 0) {
			throw new TrezorError(
				`Input ${i} is missing the key-origin information the Trezor needs. Re-create the draft from this multisig.`,
				'bad_psbt'
			);
		}
		const [chain, index] = multisigChainIndex(derivations, `Input ${i}`);
		const children = childrenAt(chain, index);

		// The multisig script itself: witnessScript for the wsh forms, the p2ms
		// redeemScript for legacy p2sh. This is the order source — never re-sorted.
		const script = params.scriptType === 'p2sh' ? input.redeemScript : input.witnessScript;
		if (!script) {
			throw new TrezorError(
				`Input ${i} is missing its ${params.scriptType === 'p2sh' ? 'redeemScript' : 'witnessScript'} — the Trezor can't reconstruct the multisig script. Re-create the draft.`,
				'bad_psbt'
			);
		}
		const multisig = multisigMultisigField(
			resolved,
			children,
			chain,
			index,
			script,
			params.threshold,
			`Input ${i}`
		);

		if (!input.txid || input.index === undefined || input.sequence === undefined) {
			throw new TrezorError('The transaction has an incomplete input.', 'bad_psbt');
		}

		// Input amount: segwit forms carry it in witnessUtxo; legacy p2sh proves it
		// via the full previous transaction (streamed to the firmware as a refTx).
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
			address_n: [...resolved[deviceKeyIndex].origin, chain, index],
			prev_hash: bytesToHex(input.txid),
			prev_index: input.index,
			amount: amount.toString(),
			script_type: spendType,
			sequence: input.sequence,
			multisig
		});
		devicePubkeys.push(children[deviceKeyIndex]);
	}

	const outputs: TrezorMultisigOutput[] = [];
	for (let o = 0; o < tx.outputsLength; o++) {
		const out = tx.getOutput(o);
		if (!out.script || out.amount === undefined) {
			throw new TrezorError('The transaction has an incomplete output.', 'bad_psbt');
		}
		const derivations = out.bip32Derivation;
		if (derivations && derivations.length > 0) {
			// Change back to this multisig: send address_n + the multisig field so the
			// device derives and verifies the change script itself instead of asking
			// the user to confirm paying an unfamiliar address. Anything that doesn't
			// cleanly resolve as multisig change (e.g. a deliberate send to another
			// wallet of ours) falls through to a plain address the user confirms.
			try {
				const [chain, index] = multisigChainIndex(derivations, `Output ${o}`);
				const children = childrenAt(chain, index);
				// Defensive: the PSBT builder should attach the change witnessScript,
				// but multisigMultisigField can fall back to the BIP-67 sort without it.
				const script = out.witnessScript ?? out.redeemScript;
				const multisig = multisigMultisigField(
					resolved,
					children,
					chain,
					index,
					script,
					params.threshold,
					`Output ${o}`
				);
				outputs.push({
					address_n: [...resolved[deviceKeyIndex].origin, chain, index],
					amount: out.amount.toString(),
					script_type: MULTISIG_PAYTO[params.scriptType],
					multisig
				});
				continue;
			} catch (e) {
				// Not multisig change after all — display it as a recipient below.
				// Leave a diagnostic trace: a genuine policy mismatch and a benign
				// "unrelated recipient" otherwise collapse into identical silence
				// (cairn-yaw1).
				console.warn(`Trezor: output ${o} not treated as multisig change:`, e);
			}
		}
		const address = addressFromScript(out.script);
		if (!address) {
			throw new TrezorError(
				'The transaction pays an output the Trezor cannot display as an address.',
				'bad_psbt'
			);
		}
		outputs.push({ address, amount: out.amount.toString(), script_type: 'PAYTOADDRESS' });
	}

	return {
		request: {
			coin: 'btc',
			inputs,
			outputs,
			...(refTxs.size > 0 ? { refTxs: [...refTxs.values()] } : {}),
			version: tx.version,
			locktime: tx.lockTime
		},
		devicePubkeys
	};
}

/**
 * Merge the device's positional multisig signatures into the source PSBT as
 * partialSig entries. Trezor returns one bare-DER signature per input (no
 * sighash byte, no pubkey), so each is completed with SIGHASH_ALL and
 * attributed to `devicePubkeys[i]` — this device's derived key for that input,
 * computed by trezorMultisigSignRequest — after checking that pubkey really is
 * declared in the input's bip32Derivation. Existing partialSig entries from
 * other cosigners are preserved (btc-signer merges keyed PSBT fields).
 *
 * Exported for unit testing.
 */
export function mergeTrezorMultisigSignatures(
	tx: Transaction,
	signatures: string[],
	devicePubkeys: Uint8Array[]
): void {
	if (signatures.length !== tx.inputsLength) {
		throw new TrezorError(
			`The Trezor returned ${signatures.length} signatures for ${tx.inputsLength} inputs.`,
			'unexpected'
		);
	}
	if (devicePubkeys.length !== tx.inputsLength) {
		throw new TrezorError(
			`Have ${devicePubkeys.length} device keys for ${tx.inputsLength} inputs.`,
			'unexpected'
		);
	}

	let applied = 0;
	signatures.forEach((sigHex, index) => {
		if (!sigHex) return; // input not signed by this device
		let sig: Uint8Array;
		try {
			sig = hexToBytes(sigHex); // throws on odd-length hex — never drop a nibble silently
		} catch (err) {
			throw new TrezorError(
				`The Trezor returned an unreadable signature for input ${index}.`,
				'unexpected',
				{ cause: err }
			);
		}
		if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30) {
			throw new TrezorError(
				`The Trezor returned a malformed signature for input ${index}.`,
				'unexpected'
			);
		}
		const withHashType = new Uint8Array(sig.length + 1);
		withHashType.set(sig);
		withHashType[sig.length] = SIGHASH_ALL;

		const pubkey = devicePubkeys[index];
		const derivations = tx.getInput(index).bip32Derivation;
		if (
			!derivations ||
			!derivations.some(([pk]) => bytesEqual(Uint8Array.from(pk), pubkey))
		) {
			throw new TrezorError(
				`The signature for input ${index} is from a key that isn't part of this multisig.`,
				'unexpected'
			);
		}
		tx.updateInput(index, { partialSig: [[pubkey, withHashType]] });
		applied++;
	});

	if (applied === 0) {
		throw new TrezorError('The Trezor returned no signatures for this multisig.', 'unexpected');
	}
}

/**
 * Decide which of the multisig's keys the connected device is. Primary match:
 * an account xpub read from the device equals a cosigner xpub (key material —
 * pubkey + chain code — so version prefixes and path bookkeeping can't cause
 * a false negative). Fallback: the device's master fingerprint equals a
 * cosigner's recorded (non-placeholder) fingerprint — covers keys imported
 * with an origin path of "m" whose xpub we can't ask the device to re-derive.
 *
 * Throws a `wrong_device` TrezorError naming both sides when nothing matches.
 * Exported for unit testing.
 */
export function selectMultisigKeyForDevice(
	keys: MultisigSignKey[],
	deviceAccounts: { xpub: string }[],
	deviceFingerprint: string | null
): number {
	const parsed = keys.map((k) => {
		try {
			return HDKey.fromExtendedKey(normalizeMultisigXpub(k.xpub));
		} catch (e) {
			// A malformed STORED cosigner xpub would otherwise surface only as a
			// generic wrong_device error, misleading the user into thinking they
			// plugged in the wrong device (cairn-yaw1).
			console.warn('Trezor: stored cosigner xpub failed to parse:', e);
			return null;
		}
	});
	for (const account of deviceAccounts) {
		let node: HDKey;
		try {
			node = HDKey.fromExtendedKey(normalizeMultisigXpub(account.xpub));
		} catch (e) {
			console.warn('Trezor: device account xpub failed to parse; skipping:', e);
			continue;
		}
		for (let i = 0; i < parsed.length; i++) {
			const key = parsed[i];
			if (
				key &&
				key.publicKey &&
				node.publicKey &&
				key.chainCode &&
				node.chainCode &&
				bytesEqual(Uint8Array.from(key.publicKey), Uint8Array.from(node.publicKey)) &&
				bytesEqual(Uint8Array.from(key.chainCode), Uint8Array.from(node.chainCode))
			) {
				return i;
			}
		}
	}

	const fp = deviceFingerprint?.toLowerCase();
	if (fp && fp !== '00000000') {
		const byFp = keys.findIndex((k) => k.fingerprint.toLowerCase() === fp);
		if (byFp >= 0) return byFp;
	}

	throw new TrezorError(
		`This Trezor isn't one of this multisig's keys — its fingerprint is ${deviceFingerprint ?? 'unknown'}, and the multisig expects ${keys
			.map((k) => k.fingerprint.toLowerCase())
			.join(', ')}. Connect one of the multisig's devices.`,
		'wrong_device'
	);
}

/**
 * Read a multisig cosigner key straight from a connected Trezor for the multisig
 * creation wizard: the BIP-48 account xpub at m/48'/0'/{account}'/{script}'
 * plus the device's MASTER fingerprint. Connect never reports the master
 * fingerprint, so it's recovered from a silent m-path xpub read (hash160 of
 * the master pubkey — xfpFromXpub). Both reads are silent single-round-trip
 * bundle entries; the m-level entry deliberately carries no `coin` because
 * Connect refuses to pair a coin with a depth-0 path.
 *
 * Returns exactly the { xpub, fingerprint, path } shape multisig keys store
 * (standard xpub form, apostrophe path notation).
 */
export async function readMultisigKeyFromTrezor(
	scriptType: MultisigScriptType,
	account = 0
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	if (!isTrezorConnectAvailable()) {
		throw new TrezorError(
			'Trezor Connect can only run in a web browser.',
			'unavailable'
		);
	}
	const path = multisigAccountPath(scriptType, account);
	const TrezorConnect = await ensureInit();

	let masterXpub: string;
	let accountXpub: string;
	try {
		const res = await TrezorConnect.getPublicKey({
			bundle: [
				{ path: 'm', showOnTrezor: false },
				{ path, coin: 'btc', showOnTrezor: false }
			]
		});
		if (!res.success) throw toTrezorError(res.payload);
		const payload = res.payload;
		if (!Array.isArray(payload) || payload.length < 2 || !payload[0]?.xpub || !payload[1]?.xpub) {
			throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected');
		}
		masterXpub = payload[0].xpub;
		accountXpub = payload[1].xpub;
	} catch (err) {
		throw toTrezorError(err);
	}

	return {
		xpub: normalizeMultisigXpub(accountXpub),
		fingerprint: xfpFromXpub(masterXpub),
		path
	};
}

// ------------------------------------------------------------------ single-sig
//
// SINGLE-SIG key reading for the standard-wallet creation wizard — the sibling
// of readMultisigKeyFromTrezor. Same device machinery (a silent getPublicKey
// bundle: m for the master fingerprint, the account node for the xpub), but a
// standard BIP44/49/84/86 single-sig account path and the SLIP-132 SINGLE-SIG
// xpub prefix family (xpub/ypub/zpub, p2tr→xpub — see xpub.ts's PUBLIC_VERSIONS)
// rather than the multisig Ypub/Zpub convention. Kept a separate function, not a
// parameterized merge, so each key kind reads exactly like its wizard.

/**
 * The standard single-sig account path for a script type:
 * m/44'/0'/{account}' (p2pkh), m/49'/0'/{account}' (p2sh-p2wpkh),
 * m/84'/0'/{account}' (p2wpkh), m/86'/0'/{account}' (p2tr). Mainnet only,
 * matching the rest of Cairn. Mirrors multisigAccountPath. Exported for unit
 * testing.
 */
export function singleSigAccountPath(scriptType: ScriptType, account = 0): string {
	return formatKeyPath(singleSigAccountPathIndexes(scriptType, account, trezorFail));
}

/**
 * Rewrite an account xpub to the SLIP-132 single-sig prefix for its script type
 * (xpub/ypub/zpub, p2tr→xpub). The device may return the key as a plain xpub or
 * already SLIP-132-prefixed depending on the path; either way this re-encodes
 * only the 4 version bytes so the stored key matches xpub.ts's PUBLIC_VERSIONS.
 * Anything that doesn't decode as a 78-byte extended key passes through unchanged
 * so the caller's parse produces the real error.
 */
function normalizeSingleSigXpub(input: string, scriptType: ScriptType): string {
	const version = SINGLE_SIG_VERSIONS[scriptType];
	if (version === undefined) {
		throw new TrezorError(`Unsupported single-sig script type "${scriptType}".`, 'unexpected');
	}
	return xpubWithVersion(input, version);
}

/**
 * Read a single-sig key straight from a connected Trezor for the standard wallet
 * creation wizard: the BIP44/49/84/86 account xpub at m/{44|49|84|86}'/0'/{account}'
 * plus the device's MASTER fingerprint. Connect never reports the master
 * fingerprint, so it's recovered from a silent m-path xpub read (xfpFromXpub).
 * Both reads are silent single-round-trip bundle entries; the m-level entry
 * deliberately carries no `coin` because Connect refuses to pair a coin with a
 * depth-0 path.
 *
 * Returns exactly the { xpub, fingerprint, path } shape single-sig wallets store
 * — the xpub in its SLIP-132 single-sig prefix (xpub/ypub/zpub), apostrophe path
 * notation.
 */
export async function readSingleSigKeyFromTrezor(
	scriptType: ScriptType,
	account = 0
): Promise<{ xpub: string; fingerprint: string; path: string }> {
	if (!isTrezorConnectAvailable()) {
		throw new TrezorError(
			'Trezor Connect can only run in a web browser.',
			'unavailable'
		);
	}
	const path = singleSigAccountPath(scriptType, account);
	const TrezorConnect = await ensureInit();

	let masterXpub: string;
	let accountXpub: string;
	try {
		const res = await TrezorConnect.getPublicKey({
			bundle: [
				{ path: 'm', showOnTrezor: false },
				{ path, coin: 'btc', showOnTrezor: false }
			]
		});
		if (!res.success) throw toTrezorError(res.payload);
		const payload = res.payload;
		if (!Array.isArray(payload) || payload.length < 2 || !payload[0]?.xpub || !payload[1]?.xpub) {
			throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected');
		}
		masterXpub = payload[0].xpub;
		accountXpub = payload[1].xpub;
	} catch (err) {
		throw toTrezorError(err);
	}

	return {
		xpub: normalizeSingleSigXpub(accountXpub, scriptType),
		fingerprint: xfpFromXpub(masterXpub),
		path
	};
}

/**
 * Read the BIP-45 collaborative-vault key: the xpub at m/45' — the ROOT
 * purpose node, deliberately NOT an account-level path (BIP-45 has no
 * coin_type/account/script_type fields; Bastion's battle-tested sharing read
 * hands the device the literal path "45'" the same way). Used by the
 * single-sig wizard's opt-in sharing prefetch (cairn-fdlf.1) so a later
 * collaborative-vault setup can reuse this key without another device touch.
 * Same silent two-entry bundle as the other readers (the m-level entry
 * recovers the master fingerprint via xfpFromXpub). The device returns a
 * plain xpub at this nonstandard path; normalizeXpub is a passthrough for it
 * and only guards against a SLIP-132-prefixed surprise.
 */
export async function readBip45KeyFromTrezor(): Promise<{
	xpub: string;
	fingerprint: string;
	path: string;
}> {
	if (!isTrezorConnectAvailable()) {
		throw new TrezorError(
			'Trezor Connect can only run in a web browser.',
			'unavailable'
		);
	}
	const path = "m/45'";
	const TrezorConnect = await ensureInit();

	let masterXpub: string;
	let purposeXpub: string;
	try {
		const res = await TrezorConnect.getPublicKey({
			bundle: [
				{ path: 'm', showOnTrezor: false },
				{ path, coin: 'btc', showOnTrezor: false }
			]
		});
		if (!res.success) throw toTrezorError(res.payload);
		const payload = res.payload;
		if (!Array.isArray(payload) || payload.length < 2 || !payload[0]?.xpub || !payload[1]?.xpub) {
			throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected');
		}
		masterXpub = payload[0].xpub;
		purposeXpub = payload[1].xpub;
	} catch (err) {
		throw toTrezorError(err);
	}

	return {
		xpub: normalizeXpub(purposeXpub),
		fingerprint: xfpFromXpub(masterXpub),
		path
	};
}

/**
 * Sign a multisig (M-of-N multisig) PSBT with a Trezor and return the PSBT with
 * this device's signatures merged in (other cosigners' partialSigs preserved).
 *
 * Flow:
 *   1. Validate + translate the PSBT into Connect params BEFORE touching the
 *      device (fail fast on a bad PSBT) — except cosigner selection, which
 *      needs the device: Connect never reports the master fingerprint, so the
 *      driver silently reads the m-path xpub (fingerprint) plus the account
 *      xpub at each cosigner origin path and matches them against the multisig's
 *      keys. No match → a clear `wrong_device` error naming both sides.
 *   2. signTransaction with per-input `multisig` fields whose cosigner nodes
 *      are in the SCRIPT's BIP-67 pubkey order (recovered from the PSBT's
 *      witnessScript/redeemScript — see the section comment). Change outputs
 *      carry address_n + multisig so the device verifies change ownership.
 *   3. Merge the positional signatures back into the ORIGINAL PSBT as
 *      partialSig entries attributed to this device's derived pubkeys.
 *
 * Throws a TrezorError (typed, plain-language) on every failure.
 */
export async function signMultisigPsbtWithTrezor(params: MultisigSignParams): Promise<string> {
	if (!isTrezorConnectAvailable()) {
		throw new TrezorError(
			'Trezor Connect can only run in a web browser.',
			'unavailable'
		);
	}

	// Fail fast on unreadable multisig keys / PSBT before any device interaction.
	const resolved = resolveMultisigSignKeys(params);
	const sourceTx = parsePsbt(params.unsignedPsbt);

	const TrezorConnect = await ensureInit();

	// Which cosigner is this device? Silent reads: master node (fingerprint)
	// plus the account node at each distinct cosigner origin path.
	const originPaths = [...new Set(resolved.filter((k) => k.origin.length > 0).map((k) => formatMultisigKeyPath(k.origin)))];
	let masterXpub: string;
	let accountReads: { xpub: string }[];
	try {
		const res = await TrezorConnect.getPublicKey({
			bundle: [
				{ path: 'm', showOnTrezor: false },
				...originPaths.map((p) => ({ path: p, coin: 'btc', showOnTrezor: false }))
			]
		});
		if (!res.success) throw toTrezorError(res.payload);
		const payload = res.payload;
		if (!Array.isArray(payload) || payload.length < 1 + originPaths.length || !payload[0]?.xpub) {
			throw new TrezorError('The Trezor returned an unexpected key response.', 'unexpected');
		}
		masterXpub = payload[0].xpub;
		accountReads = payload.slice(1).map((p) => ({ xpub: p.xpub }));
	} catch (err) {
		throw toTrezorError(err);
	}
	const deviceKeyIndex = selectMultisigKeyForDevice(params.keys, accountReads, xfpFromXpub(masterXpub));

	const { request, devicePubkeys } = trezorMultisigSignRequest(params, deviceKeyIndex);

	// The device shows each output on its own screen and blocks on approval.
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

	mergeTrezorMultisigSignatures(sourceTx, signatures, devicePubkeys);

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
