// Client-safe plumbing shared by every hardware-wallet driver (Ledger, Trezor,
// BitBox02, Jade) — typed-error base class, SLIP-132 extended-key version
// handling, and BIP32 path parsing/formatting.
//
// This module exists so the browser drivers can share logic WITHOUT importing
// server code: it depends only on @scure/@noble primitives and $lib/types, and
// must stay that way. Each driver used to carry its own verbatim copy of these
// helpers precisely to preserve that boundary; this file is the shared home
// that keeps the boundary intact.

import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ScriptType } from '$lib/types';

export const HARDENED = 0x80000000;

/**
 * Base class for the drivers' typed errors (LedgerError, TrezorError,
 * Bitbox02Error, JadeError). `code` lets the UI branch (e.g. offer "unlock
 * your device" vs "use a Chromium browser") without string-matching; each
 * driver narrows it to its own code union. Subclasses pass their class name so
 * `err.name` reads the same as before consolidation.
 */
export class HwError<Code extends string = string> extends Error {
	constructor(
		name: string,
		message: string,
		public readonly code: Code,
		options?: { cause?: unknown }
	) {
		super(message);
		this.name = name;
		if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
	}
}

// ---------------------------------------------------------- extended-key forms
//
// Cairn stores account xpubs as the user pasted them, which may carry any
// SLIP-132 mainnet prefix: ypub/zpub for the single-sig conventions, Ypub/Zpub
// for the multisig ones. Devices variously want the canonical xpub form
// (Ledger/Trezor/BitBox02 parsing) or a specific single-sig prefix per script
// type (what xpub.ts's PUBLIC_VERSIONS keys wallets by), so both directions
// live here.

/** Base58check codec for 78-byte BIP32 extended keys (shared instance). */
export const b58check = /* @__PURE__ */ createBase58check(sha256);

/** Standard BIP32 mainnet xpub version bytes. */
export const XPUB_VERSION = 0x0488b21e;

/** SLIP-132 mainnet public version bytes that normalizeXpub rewrites to xpub. */
export const SLIP132_VERSIONS: ReadonlySet<number> = new Set([
	0x049d7cb2, // ypub  (BIP49 single-sig)
	0x04b24746, // zpub  (BIP84 single-sig)
	0x0295b43f, // Ypub  (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub  (p2wsh multisig)
]);

/** SLIP-132 single-sig public version bytes per script type — the prefix family
 *  xpub.ts's PUBLIC_VERSIONS recognizes (xpub for p2pkh AND p2tr, ypub for
 *  p2sh-p2wpkh, zpub for p2wpkh). NOT the multisig Ypub/Zpub convention. */
export const SINGLE_SIG_VERSIONS: Record<ScriptType, number> = {
	p2pkh: 0x0488b21e, // xpub (BIP44)
	'p2sh-p2wpkh': 0x049d7cb2, // ypub (BIP49)
	p2wpkh: 0x04b24746, // zpub (BIP84)
	p2tr: 0x0488b21e // xpub (BIP86 — no dedicated SLIP-132 prefix)
};

/** BIP purpose (first hardened path element) per single-sig script type. */
export const SCRIPT_TYPE_PURPOSE: Record<ScriptType, number> = {
	p2pkh: 44, // BIP44
	'p2sh-p2wpkh': 49, // BIP49
	p2wpkh: 84, // BIP84
	p2tr: 86 // BIP86
};

/**
 * Re-encode an extended key under the given 4 version bytes. Anything that
 * doesn't decode as a 78-byte base58check payload passes through unchanged so
 * the caller's later parsing surfaces the real error.
 */
export function xpubWithVersion(input: string, version: number): string {
	const trimmed = input.trim();
	let raw: Uint8Array;
	try {
		raw = b58check.decode(trimmed);
	} catch {
		return trimmed;
	}
	if (raw.length !== 78) return trimmed;
	const out = new Uint8Array(raw);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return b58check.encode(out);
}

/**
 * Rewrite a SLIP-132 prefix (ypub/zpub/Ypub/Zpub) to standard xpub bytes;
 * anything else (including invalid input) passes through unchanged so later
 * parsing shows a real error.
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
	return xpubWithVersion(trimmed, XPUB_VERSION);
}

// ------------------------------------------------------------ derivation paths

/**
 * "m/48'/0'/0'/2'" (h/H/' markers, leading m/ optional) → hardened-offset
 * index array; "m"/"" → []. Malformed segments are reported through `fail`,
 * which builds the driver's own typed error (so a bad path in a Ledger flow
 * still throws a LedgerError, etc.).
 */
export function parseKeyPath(
	path: string,
	label: string,
	fail: (message: string) => Error
): number[] {
	const stripped = path.trim().replace(/^m\/?/i, '');
	if (stripped === '') return [];
	return stripped.split('/').map((p) => {
		const hardened = /['’hH]$/.test(p);
		const digits = hardened ? p.slice(0, -1) : p;
		if (!/^\d+$/.test(digits)) {
			throw fail(`${label}: bad derivation path segment "${p}".`);
		}
		const n = parseInt(digits, 10);
		if (n >= HARDENED) {
			throw fail(`${label}: derivation path segment out of range "${p}".`);
		}
		return hardened ? n + HARDENED : n;
	});
}

/** Hardened-offset index array → apostrophe-notation path string, e.g.
 *  [84',0',0'] → "m/84'/0'/0'". [] → "m". */
export function formatKeyPath(indexes: number[]): string {
	if (indexes.length === 0) return 'm';
	return `m/${indexes.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`)).join('/')}`;
}

// ----------------------------------------------------------------- key shapes

/** The three multisig script forms — mirrors multisig.ts's MultisigScriptType
 *  (duplicated here so the browser drivers never import server code). */
export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/** One cosigner key, exactly as the multisig stores it (MultisigKeyRow shape). */
export interface MultisigSignKey {
	/** Account xpub (SLIP-132 ypub/zpub/Ypub/Zpub accepted; standard xpub too). */
	xpub: string;
	/** Master fingerprint, 8 hex chars ("00000000" when unknown). */
	fingerprint: string;
	/** Account origin path, e.g. "m/48'/0'/0'/2'" ("m" when unknown). */
	path: string;
}

// ------------------------------------------------------------- account paths

/**
 * The BIP-48 account path for a multisig cosigner key, as hardened-offset
 * indexes: m/48'/0'/{account}'/{script}' where the script suffix is 2' for
 * p2wsh and 1' for BOTH p2sh forms (BIP-48 gives p2sh and p2sh-p2wsh the same
 * 1' — only native p2wsh gets 2'). Mainnet only, matching the rest of Cairn.
 */
export function multisigAccountPathIndexes(
	scriptType: MultisigScriptType,
	account: number,
	fail: (message: string) => Error
): number[] {
	if (scriptType !== 'p2wsh' && scriptType !== 'p2sh-p2wsh' && scriptType !== 'p2sh') {
		throw fail(`Unsupported multisig script type "${scriptType}".`);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw fail(`Invalid account index ${account}.`);
	}
	const sub = scriptType === 'p2wsh' ? 2 : 1;
	return [48 + HARDENED, 0 + HARDENED, account + HARDENED, sub + HARDENED];
}

/**
 * The standard single-sig BIP44/49/84/86 account path for a script type, as
 * hardened-offset indexes: purpose', 0' (mainnet coin type), account'.
 */
export function singleSigAccountPathIndexes(
	scriptType: ScriptType,
	account: number,
	fail: (message: string) => Error
): number[] {
	const purpose = SCRIPT_TYPE_PURPOSE[scriptType];
	if (purpose === undefined) {
		throw fail(`Unsupported single-sig script type "${scriptType}".`);
	}
	if (!Number.isInteger(account) || account < 0 || account >= HARDENED) {
		throw fail(`Invalid account index ${account}.`);
	}
	return [purpose + HARDENED, 0 + HARDENED, account + HARDENED];
}
