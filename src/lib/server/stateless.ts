// Stateless multisig operations (bead cairn-jk1): the Caravan-style escape hatch.
// Everything the persistent multisig flow does — scan, PSBT construction,
// signature combining, quorum-gated broadcast — driven entirely from a config
// the caller pastes (an output descriptor or a Caravan/Unchained wallet JSON).
// NOTHING is persisted: no multisig row, no draft row, no signature state. The
// client holds the PSBT between calls and re-posts the source with every
// request, exactly like Caravan's config-file-only model.
//
// Ephemeral-MultisigRow findings (verified against multisigScan.ts / multisigs.ts):
// scanMultisig, getMultisigUtxos, getMultisigDetail and nextMultisigChangeIndex consume a
// MultisigRow purely as a bag of {threshold, scriptType, keys[]} — scanning is
// Electrum-side and the scan cache is keyed on the RECEIVE DESCRIPTOR (via
// toMultisigConfig), never on multisig/user ids. The only DB writes in multisigScan.ts
// live in nextMultisigReceiveAddress (bumpReceiveCursor) and the only reads in
// listMultisigSummaries — neither is called here. The single remaining DB contact
// is the module-load side effect of db.ts (importing multisigs.ts opens the
// sqlite file), which happens in any server process anyway. So a MultisigRow-
// shaped object with id 0 / userId 0 scans exactly like a stored multisig, and
// two users pasting the same config even share one 60s scan cache entry —
// correctly, since they would share addresses too.
//
// Double-submit note: unlike the persistent flows there is no transactions row
// to hang an atomic broadcast claim on. Protection against double-submitting
// the SAME finalized transaction is the network's own duplicate rejection
// (Electrum returns "transaction already in block chain"/"already known"), and
// a transaction cannot double-spend itself. That is acceptable for an
// explicitly stateless tool; anyone who wants claim semantics wants a
// persistent multisig.

import { parseDescriptor, multisigTestAddress, multisigToDescriptor, MultisigError } from './bitcoin/multisig';
import {
	containsPrivateKeyMaterial,
	parseCaravanImport,
	coldcardRegistration,
	PRIVATE_KEY_REFUSAL,
	type CaravanImport
} from './multisigExport';
import { toMultisigConfig, type MultisigRow, type MultisigScriptType } from './wallets/multisig';
import { getMultisigDetail, getMultisigUtxos, nextMultisigChangeIndex } from './multisigScan';
import {
	constructMultisigPsbt,
	combineMultisigPsbts,
	multisigPsbtProgress,
	finalizeMultisigPsbt,
	MultisigPsbtError,
	type ConstructedMultisigPsbt,
	type MultisigSigningProgress
} from './bitcoin/multisigPsbt';
import { PsbtError, type RecipientSpec } from './bitcoin/psbt';
import { normalizePsbt, InvalidPsbtError } from './transactions';
import { getChain } from './chain';

/** How many receive addresses the scan response lists for eyeballing. */
const ADDRESS_PREVIEW_COUNT = 10;

/** The parsed config echoed back to the client — everything the signing UI
 *  needs (key roster with fingerprints/paths for chips and USB drivers). */
export interface StatelessConfig {
	/** Name carried by a Caravan JSON; '' for a bare descriptor. */
	name: string;
	scriptType: MultisigScriptType;
	threshold: number;
	totalKeys: number;
	keys: { name: string; xpub: string; fingerprint: string; path: string }[];
}

/**
 * Parse a pasted source — Caravan/Unchained wallet JSON or an output
 * descriptor — into the echo config plus the ephemeral MultisigRow the scanning
 * and PSBT layers consume. Refuses private key material before any parsing.
 *
 * Near-duplicate of /api/wallets/multisig/import's parseSource (a route module, not
 * importable here) with one improvement: descriptors keep their actual parsed
 * script type (sh(wsh(…)) / sh(…)) instead of assuming p2wsh.
 */
export function parseStatelessSource(source: string): { config: StatelessConfig; multisig: MultisigRow } {
	const text = String(source ?? '').trim();
	if (containsPrivateKeyMaterial(text)) {
		throw new MultisigError(PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (text === '') {
		throw new MultisigError(
			'Paste a descriptor or a Caravan wallet JSON to get started.',
			'invalid_descriptor'
		);
	}

	let parsed: CaravanImport;
	if (text.startsWith('{')) {
		parsed = parseCaravanImport(text);
	} else {
		const desc = parseDescriptor(text);
		parsed = {
			name: '',
			scriptType: (desc.scriptType ?? 'p2wsh') as MultisigScriptType,
			threshold: desc.threshold,
			totalKeys: desc.keys.length,
			keys: desc.keys.map((k, i) => ({
				name: `Key ${i + 1}`,
				xpub: k.xpub,
				fingerprint: k.fingerprint,
				path: k.path
			})),
			// A bare descriptor carries no receive cursor.
			startingAddressIndex: 0,
			// This branch never calls validateMultisigKeyPaths (pre-existing —
			// stateless descriptor import has always been acceptance-agnostic here,
			// unlike the persistent import routes), so there's nothing to collect.
			warnings: []
		};
	}

	const config: StatelessConfig = {
		name: parsed.name,
		scriptType: parsed.scriptType,
		threshold: parsed.threshold,
		totalKeys: parsed.keys.length,
		keys: parsed.keys
	};

	// The ephemeral row: id/userId 0 mark it as never-persisted. createdAt is
	// fixed (not "now") so the row is a pure function of the source text.
	const multisig: MultisigRow = {
		id: 0,
		userId: 0,
		name: parsed.name || 'Stateless multisig',
		threshold: parsed.threshold,
		scriptType: parsed.scriptType,
		receiveCursor: 0,
		createdAt: '1970-01-01T00:00:00.000Z',
		keys: parsed.keys.map((k, i) => ({
			id: i + 1,
			multisigId: 0,
			position: i,
			name: k.name,
			category: 'hardware',
			deviceType: null,
			xpub: k.xpub,
			fingerprint: k.fingerprint,
			path: k.path
		}))
	};

	// Validate the whole config cryptographically up front (threshold bounds,
	// xpub parseability, duplicate keys) — the same gate createMultisig applies —
	// so every later phase can trust the config. Throws MultisigError.
	multisigTestAddress(toMultisigConfig(multisig));

	return { config, multisig };
}

export interface StatelessScanResult {
	config: StatelessConfig;
	balance: { confirmed: number; unconfirmed: number };
	utxos: {
		txid: string;
		vout: number;
		value: number;
		height: number;
		address: string;
		chain: 0 | 1;
		index: number;
	}[];
	/** First ~10 receive-chain addresses with used flags — the eyeball check. */
	addresses: { address: string; index: number; used: boolean }[];
	/** Address 0/0 — cross-check it against another descriptor tool. */
	testAddress: string;
	/** The receive descriptor (checksummed) — display + provenance. */
	descriptor: string;
	/** ColdCard-format registration file content, for client-side downloads
	 *  (air-gapped devices refuse to co-sign for an unregistered multisig). */
	registration: string;
}

/** Scan a pasted config over Electrum and report balance + coins. Nothing is
 *  stored; repeat calls within 60s share multisigScan's in-process cache. */
export async function scanStatelessSource(source: string): Promise<StatelessScanResult> {
	const { config, multisig } = parseStatelessSource(source);
	const detail = await getMultisigDetail(multisig);

	const receive = detail.addresses
		.filter((a) => a.chain === 0)
		.sort((a, b) => a.index - b.index)
		.slice(0, ADDRESS_PREVIEW_COUNT)
		.map((a) => ({ address: a.address, index: a.index, used: a.used }));

	return {
		config,
		balance: detail.balance,
		utxos: detail.utxos,
		addresses: receive,
		testAddress: multisigTestAddress(toMultisigConfig(multisig)),
		descriptor: multisigToDescriptor(toMultisigConfig(multisig)),
		registration: coldcardRegistration(multisig)
	};
}

export interface StatelessBuildInput {
	recipients: RecipientSpec[];
	feeRate: number;
	/** Manual coin control: restrict selection to these coins. */
	onlyUtxos?: { txid: string; vout: number }[];
}

/**
 * Build an unsigned multisig PSBT from the pasted config's live UTXOs. Identical
 * construction to buildMultisigDraft (same change derivation, same fetchRawTx
 * wiring, same signingMass block) minus the draft INSERT — the client keeps
 * the PSBT.
 */
export async function buildStatelessPsbt(
	source: string,
	input: StatelessBuildInput
): Promise<{ config: StatelessConfig; details: ConstructedMultisigPsbt; progress: MultisigSigningProgress }> {
	const { config, multisig } = parseStatelessSource(source);

	const utxos = await getMultisigUtxos(multisig);
	const changeIndex = await nextMultisigChangeIndex(multisig);
	// Coinbase-maturity guard for the stateless send path too — fetch the tip only
	// when a coinbase coin is present, guarded so a tip hiccup never blocks a send.
	let tipHeight: number | undefined;
	if (utxos.some((u) => u.coinbase)) {
		try {
			tipHeight = (await getChain().getTip()).height;
		} catch {
			tipHeight = undefined;
		}
	}

	const details = await constructMultisigPsbt({
		config: toMultisigConfig(multisig),
		utxos,
		recipients: input.recipients,
		feeRate: input.feeRate,
		changeIndex,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		onlyUtxos: input.onlyUtxos,
		tipHeight
	});

	return { config, details, progress: multisigPsbtProgress(details.psbtBase64, config.threshold) };
}

/** normalizePsbt, with every non-PSBT failure (including base64 decoder
 *  errors on plain garbage) folded into one presentable InvalidPsbtError —
 *  a bad paste must never read as a 502 chain failure. */
function normalizeOrRefuse(input: string): string {
	try {
		return normalizePsbt(input);
	} catch (e) {
		if (e instanceof InvalidPsbtError) throw e;
		throw new InvalidPsbtError("That doesn't look like a valid PSBT.");
	}
}

/**
 * Merge one signer's output into the client-held PSBT — the stateless attach.
 * Same guards as attachMultisigSignature (normalize anything a signer hands
 * back, same-transaction check, multisig-key membership per signature,
 * idempotent re-submission) with the result returned instead of persisted.
 */
export function combineStatelessPsbts(
	source: string,
	basePsbt: string,
	incomingPsbt: string
): { psbt: string; progress: MultisigSigningProgress } {
	const { config } = parseStatelessSource(source);
	const base = normalizeOrRefuse(basePsbt);
	const incoming = normalizeOrRefuse(incomingPsbt);
	const combined = combineMultisigPsbts(base, incoming);
	return { psbt: combined, progress: multisigPsbtProgress(combined, config.threshold) };
}

/**
 * Quorum-check, finalize, and broadcast a client-held PSBT. Refuses below
 * quorum with the same "X of M signatures collected" message the persistent
 * flow uses — quorum is judged from the PSBT itself. See the module header
 * for why there is no atomic broadcast claim here.
 */
export async function broadcastStatelessPsbt(
	source: string,
	psbt: string
): Promise<{ txid: string }> {
	const { config } = parseStatelessSource(source);
	const normalized = normalizeOrRefuse(psbt);

	const progress = multisigPsbtProgress(normalized, config.threshold);
	if (!progress.complete) {
		throw new MultisigPsbtError(
			`Only ${progress.collected} of ${progress.required} signatures collected — this multisig needs ${progress.required} signatures to spend.`,
			'not_enough_signatures'
		);
	}

	const finalized = finalizeMultisigPsbt(normalized);
	const reportedTxid = await getChain().electrum.broadcast(finalized.rawHex);

	// The real txid is the double-SHA256 of the exact bytes we broadcast
	// (finalized.txid) — recomputed locally, it can't be forged. If a malicious or
	// misbehaving Electrum server reports a different txid for a broadcast it never
	// performed, refuse to hand that bogus txid back to the caller (cairn-ziwm).
	if (reportedTxid.trim().toLowerCase() !== finalized.txid.toLowerCase()) {
		throw new MultisigPsbtError(
			'The server acknowledged the broadcast with a different transaction id than the one we signed — refusing to trust it. Check your Electrum server and try again.',
			'combine_failed'
		);
	}
	return { txid: finalized.txid };
}

/** Map the errors this module (and the layers under it) throws onto the JSON
 *  error responses the /api/stateless routes return. Anything unrecognized is
 *  a chain-source failure → 502. */
export function statelessErrorInfo(e: unknown): { status: number; message: string; code?: string } {
	if (e instanceof MultisigError) return { status: 400, message: e.message, code: e.code };
	if (e instanceof PsbtError) return { status: 400, message: e.message, code: e.code };
	if (e instanceof MultisigPsbtError) return { status: 400, message: e.message, code: e.code };
	if (e instanceof InvalidPsbtError) return { status: 400, message: e.message, code: 'invalid_psbt' };
	if (e instanceof Error && (e.message === 'Empty PSBT' || e.message === 'Not a PSBT')) {
		return { status: 400, message: "That doesn't look like a valid PSBT.", code: 'invalid_psbt' };
	}
	// Unknown/unclassified failure: return a generic message rather than forwarding
	// raw exception text (which may carry driver/connection detail) to the client.
	// The stateless routes log the raw error at >=500, so nothing is lost for the
	// operator (cairn-6y98).
	return {
		status: 502,
		message: 'The chain source could not be reached.'
	};
}
