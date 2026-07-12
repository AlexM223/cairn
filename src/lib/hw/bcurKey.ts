// BC-UR crypto-hdkey / crypto-account decode for scanning a cosigner's
// extended public key off an air-gapped device's QR screen — the multisig
// wizard's Caravan-informed QR import (CARAVAN-QR-REFERENCE.md).
//
// This REUSES jadeUr.ts's bytewords codec and BCR-2020-005 multipart-array
// framing (crc32 / bytewordsDecode / decodePart / ParsedPart / concat, all
// exported from there for exactly this purpose) rather than duplicating it —
// both codecs share the same BC-UR transport layer and differ only in what
// CBOR shape the reassembled payload carries (a lone byte string for
// crypto-psbt; a map/array of typed fields for crypto-hdkey/crypto-account).
//
// Library decision (mirrors jadeUr.ts's, restated here since this module
// extends into richer CBOR shapes that file's header explicitly reserved
// for): a full `@ngraveio/bc-ur` / `@keystonehq/bc-ur-registry` dependency
// still isn't worth this build's fragility risk for what's really a small,
// fully-specified slice of two CBOR structures (BCR-2020-007 crypto-hdkey,
// BCR-2020-015 crypto-account). A minimal generic CBOR item decoder — enough
// for unsigned/negative ints, byte/text strings, arrays, maps, tags, and
// bool/null — covers both, and every other cosigner-key export shape a real
// device produces nests inside those primitives.
//
// The xpub is RECONSTRUCTED from the raw key-data/chain-code/depth/parent-
// fingerprint components using Heartwood's OWN mainnet version bytes, never
// the device's — mirroring Caravan's `processHDKey` (see
// CARAVAN-QR-REFERENCE.md §2/§5): a device that mislabels its export
// (ypub/zpub/tpub) can't produce a wrong-network xpub here, because the
// network byte is never read from the wire.

import { crc32, bytewordsDecode, decodePart, concat, type ParsedPart } from './jadeUr';
import { b58check, XPUB_VERSION, HARDENED } from './common';

// ── UR envelope (BCR-2020-005), generalized across UR type ──────────────────

export type BcurKeyUrType = 'crypto-hdkey' | 'crypto-account';
const UR_TYPES: readonly BcurKeyUrType[] = ['crypto-hdkey', 'crypto-account'];

interface ParsedUrEnvelope {
	type: BcurKeyUrType;
	seqNum: number | null;
	seqLen: number | null;
	body: string;
}

/** Parse `ur:crypto-hdkey/…` or `ur:crypto-account/…` (single or multipart);
 *  null for anything else (a foreign QR, a crypto-psbt frame, plain text). */
export function parseBcurKeyFrame(frame: string): ParsedUrEnvelope | null {
	const s = String(frame ?? '').trim().toLowerCase();
	if (!s.startsWith('ur:')) return null;
	const rest = s.slice(3);
	const slash = rest.indexOf('/');
	if (slash === -1) return null;
	const type = rest.slice(0, slash);
	if (!UR_TYPES.includes(type as BcurKeyUrType)) return null;
	const after = rest.slice(slash + 1);
	if (after.length === 0) return null;
	const slash2 = after.indexOf('/');
	if (slash2 === -1) {
		// Single-part: "ur:crypto-hdkey/<bytewords>".
		return { type: type as BcurKeyUrType, seqNum: null, seqLen: null, body: after };
	}
	const m = /^(\d+)-(\d+)$/.exec(after.slice(0, slash2));
	if (!m) return null;
	const body = after.slice(slash2 + 1);
	if (body.length === 0) return null;
	return { type: type as BcurKeyUrType, seqNum: Number(m[1]), seqLen: Number(m[2]), body };
}

/** Cheap shape check for the QrScanner "is this frame mine?" gate. */
export function looksLikeBcurKeyFrame(s: string): boolean {
	return parseBcurKeyFrame(s) !== null;
}

/** The wizard's existing plain-text key acceptance (pre-dates this BC-UR
 *  upgrade): a bare xpub/Zpub/etc, or a `[fingerprint/path]xpub…` fragment.
 *  Kept so ONE scanner covers both a BC-UR-speaking device and one that just
 *  shows its xpub as an ordinary text QR (still common on older firmware). */
export function looksLikePlainKeyText(s: string): boolean {
	const t = s.trim();
	return /pub/i.test(t) || t.startsWith('[');
}

// ── Result shapes ────────────────────────────────────────────────────────────

/** A scanned key, normalized the way the wizard's add-key form wants it. */
export interface ScannedKeyImport {
	kind: 'plain' | 'bcur';
	/** Only present for kind:'bcur' — which UR type produced it. */
	urType?: BcurKeyUrType;
	xpub: string;
	/** 8 lowercase hex chars, or null when the QR carried none. */
	fingerprint: string | null;
	/** "m/48'/0'/0'/2'" form, or null when the QR carried no origin path. */
	bip32Path: string | null;
	/** True when the BC-UR payload's own use-info said "testnet" — the xpub
	 *  above is still a valid mainnet xpub (rebuilt with Heartwood's own
	 *  version bytes); this only drives the visible "converted" notice. */
	convertedFromTestnet: boolean;
}

// ── Minimal generic CBOR decoder ─────────────────────────────────────────────
// Just enough of RFC 8949 to walk crypto-hdkey (a map) and crypto-account (an
// array of tagged output descriptors wrapping a crypto-hdkey) — unsigned/
// negative ints, byte/text strings, arrays, maps (int keys only — all BC-UR
// crypto-* maps use small int keys), tags, and bool/null. Floats/doubles
// aren't needed by either structure and are deliberately unsupported.

export type CborValue =
	| { kind: 'uint'; value: number }
	| { kind: 'nint'; value: number }
	| { kind: 'bytes'; value: Uint8Array }
	| { kind: 'text'; value: string }
	| { kind: 'array'; value: CborValue[] }
	| { kind: 'map'; value: Map<number, CborValue> }
	| { kind: 'tag'; tag: number; value: CborValue }
	| { kind: 'bool'; value: boolean }
	| { kind: 'null' };

interface CborHeader {
	majorType: number;
	length: number;
	next: number;
}

function readCborHeader(cbor: Uint8Array, off: number): CborHeader {
	if (off >= cbor.length) throw new Error('Unexpected end of the scanned key data.');
	const b = cbor[off];
	const majorType = b >> 5;
	const info = b & 0x1f;
	if (info < 24) return { majorType, length: info, next: off + 1 };
	if (info === 24) return { majorType, length: cbor[off + 1], next: off + 2 };
	if (info === 25) return { majorType, length: (cbor[off + 1] << 8) | cbor[off + 2], next: off + 3 };
	if (info === 26) {
		return {
			majorType,
			length:
				((cbor[off + 1] << 24) | (cbor[off + 2] << 16) | (cbor[off + 3] << 8) | cbor[off + 4]) >>> 0,
			next: off + 5
		};
	}
	throw new Error("The scanned key data uses a CBOR field width Heartwood doesn't support.");
}

export function decodeCborValue(cbor: Uint8Array, off = 0): { value: CborValue; next: number } {
	const h = readCborHeader(cbor, off);
	switch (h.majorType) {
		case 0:
			return { value: { kind: 'uint', value: h.length }, next: h.next };
		case 1:
			return { value: { kind: 'nint', value: -1 - h.length }, next: h.next };
		case 2: {
			const end = h.next + h.length;
			if (end > cbor.length) throw new Error('The scanned key data is truncated (byte string).');
			return { value: { kind: 'bytes', value: cbor.slice(h.next, end) }, next: end };
		}
		case 3: {
			const end = h.next + h.length;
			if (end > cbor.length) throw new Error('The scanned key data is truncated (text string).');
			return { value: { kind: 'text', value: new TextDecoder().decode(cbor.slice(h.next, end)) }, next: end };
		}
		case 4: {
			let next = h.next;
			const items: CborValue[] = [];
			for (let i = 0; i < h.length; i++) {
				const r = decodeCborValue(cbor, next);
				items.push(r.value);
				next = r.next;
			}
			return { value: { kind: 'array', value: items }, next };
		}
		case 5: {
			let next = h.next;
			const map = new Map<number, CborValue>();
			for (let i = 0; i < h.length; i++) {
				const k = decodeCborValue(cbor, next);
				next = k.next;
				const v = decodeCborValue(cbor, next);
				next = v.next;
				const key = k.value.kind === 'uint' || k.value.kind === 'nint' ? k.value.value : NaN;
				map.set(key, v.value);
			}
			return { value: { kind: 'map', value: map }, next };
		}
		case 6: {
			const inner = decodeCborValue(cbor, h.next);
			return { value: { kind: 'tag', tag: h.length, value: inner.value }, next: inner.next };
		}
		case 7:
			if (h.length === 20) return { value: { kind: 'bool', value: false }, next: h.next };
			if (h.length === 21) return { value: { kind: 'bool', value: true }, next: h.next };
			if (h.length === 22 || h.length === 23) return { value: { kind: 'null' }, next: h.next };
			throw new Error("The scanned key data uses a CBOR value Heartwood doesn't support.");
		default:
			throw new Error('The scanned key data has an unrecognized CBOR type.');
	}
}

function mapGet(map: Map<number, CborValue>, key: number): CborValue | undefined {
	return map.get(key);
}

function fpHex(n: number): string {
	return (n >>> 0).toString(16).padStart(8, '0');
}

// ── crypto-keypath (tag 304, BCR-2020-007) ──────────────────────────────────

interface DecodedKeypath {
	path: string | null;
	sourceFingerprint: string | null;
	/** Hardened-offset index array (empty for the master key / no origin). */
	indices: number[];
}

/** [index, isHardened, index, isHardened, …] -> "m/48'/0'/0'/2'" (or null for
 *  an empty/absent components array — the master key itself). */
function decodeKeypath(value: CborValue): DecodedKeypath {
	if (value.kind !== 'map') return { path: null, sourceFingerprint: null, indices: [] };
	const componentsItem = mapGet(value.value, 1);
	const indices: number[] = [];
	if (componentsItem?.kind === 'array') {
		const arr = componentsItem.value;
		for (let i = 0; i + 1 < arr.length; i += 2) {
			const idxItem = arr[i];
			const hardenedItem = arr[i + 1];
			const idx = idxItem.kind === 'uint' ? idxItem.value : 0;
			const hardened = hardenedItem.kind === 'bool' ? hardenedItem.value : false;
			indices.push(hardened ? idx + HARDENED : idx);
		}
	}
	const path =
		indices.length === 0
			? null
			: `m/${indices.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`)).join('/')}`;
	const fpItem = mapGet(value.value, 2);
	const sourceFingerprint = fpItem?.kind === 'uint' ? fpHex(fpItem.value) : null;
	return { path, sourceFingerprint, indices };
}

// ── crypto-hdkey (tag 303, BCR-2020-007) ────────────────────────────────────

function decodeCryptoHDKeyMap(map: Map<number, CborValue>): Omit<ScannedKeyImport, 'kind' | 'urType'> {
	const keyDataItem = mapGet(map, 3);
	if (!keyDataItem || keyDataItem.kind !== 'bytes') {
		throw new Error('That QR code is missing its public key data.');
	}
	// BCR-2020-007 pads an ECDSA key-data field to 33 bytes with a leading
	// 0x00 for a key that would otherwise decode as 32 (never happens for a
	// real compressed pubkey, but guard rather than silently mis-slicing).
	const pubkey = keyDataItem.value;
	if (pubkey.length !== 33) {
		throw new Error("That QR code's public key isn't a standard compressed key — Heartwood can't use it.");
	}

	const chainCodeItem = mapGet(map, 4);
	if (!chainCodeItem || chainCodeItem.kind !== 'bytes' || chainCodeItem.value.length !== 32) {
		throw new Error(
			"That QR code's key has no chain code, so it can't derive further — Heartwood needs the account-level extended public key (xpub), not a single address key."
		);
	}
	const chainCode = chainCodeItem.value;

	let parentFingerprint = 0;
	const pfItem = mapGet(map, 8);
	if (pfItem?.kind === 'uint') parentFingerprint = pfItem.value;

	let path: string | null = null;
	let sourceFingerprint: string | null = null;
	let indices: number[] = [];
	const originItem = mapGet(map, 6);
	if (originItem?.kind === 'tag') {
		const decoded = decodeKeypath(originItem.value);
		path = decoded.path;
		sourceFingerprint = decoded.sourceFingerprint;
		indices = decoded.indices;
	}

	let convertedFromTestnet = false;
	const useInfoItem = mapGet(map, 5);
	if (useInfoItem?.kind === 'tag' && useInfoItem.value.kind === 'map') {
		const networkItem = mapGet(useInfoItem.value.value, 2);
		if (networkItem?.kind === 'uint' && networkItem.value === 1) convertedFromTestnet = true;
	}

	// depth + this key's own "child number" field in the rebuilt extended key
	// come straight from the origin path — 0/0 for a master/no-origin export.
	const depth = indices.length;
	const lastIndex = indices.length > 0 ? indices[indices.length - 1] : 0;

	const xpub = buildXpub(depth, parentFingerprint, lastIndex, chainCode, pubkey);

	return {
		xpub,
		fingerprint: sourceFingerprint,
		bip32Path: path,
		convertedFromTestnet
	};
}

/** Rebuild a standard xpub from raw BIP-32 components under HEARTWOOD'S OWN
 *  mainnet version bytes — never the scanned data's own (there isn't one to
 *  read here; crypto-hdkey carries no version-byte field at all, only the
 *  raw key material). Mirrors Caravan's processHDKey (CARAVAN-QR-REFERENCE.md
 *  §2/§5): the coordinator, not the device, decides what network label a key
 *  wears. */
function buildXpub(
	depth: number,
	parentFingerprint: number,
	childIndex: number,
	chainCode: Uint8Array,
	pubkey: Uint8Array
): string {
	const raw = new Uint8Array(78);
	raw[0] = (XPUB_VERSION >>> 24) & 0xff;
	raw[1] = (XPUB_VERSION >>> 16) & 0xff;
	raw[2] = (XPUB_VERSION >>> 8) & 0xff;
	raw[3] = XPUB_VERSION & 0xff;
	raw[4] = depth & 0xff;
	raw[5] = (parentFingerprint >>> 24) & 0xff;
	raw[6] = (parentFingerprint >>> 16) & 0xff;
	raw[7] = (parentFingerprint >>> 8) & 0xff;
	raw[8] = parentFingerprint & 0xff;
	raw[9] = (childIndex >>> 24) & 0xff;
	raw[10] = (childIndex >>> 16) & 0xff;
	raw[11] = (childIndex >>> 8) & 0xff;
	raw[12] = childIndex & 0xff;
	raw.set(chainCode, 13);
	raw.set(pubkey, 45);
	return b58check.encode(raw);
}

// ── crypto-account (tag 311, BCR-2020-015) ──────────────────────────────────
//
// A crypto-account wraps one master-fingerprint plus a list of "output
// descriptors" (BCR-2020-010) — a script-function tag tree (sh/wsh/multi/…)
// that eventually contains one or more crypto-hdkeys. Rather than modeling
// every BCR-2020-010 script tag (only relevant for multi-key output
// descriptors, not a single cosigner's own account export), this walks the
// FIRST descriptor's CBOR tree looking for the first embedded crypto-hdkey —
// the same simplification Caravan's own decoder makes (getOutputDescriptors()
// [0].getCryptoKey()), which is exactly the shape a per-cosigner xpub export
// uses in practice.
const CRYPTO_HDKEY_TAG = 303;

function findHDKeyMap(value: CborValue): Map<number, CborValue> | null {
	if (value.kind === 'tag') {
		if (value.tag === CRYPTO_HDKEY_TAG && value.value.kind === 'map') return value.value.value;
		return findHDKeyMap(value.value);
	}
	if (value.kind === 'map') {
		if (value.value.has(3) && value.value.has(4)) return value.value; // key-data + chain-code
		for (const v of value.value.values()) {
			const found = findHDKeyMap(v);
			if (found) return found;
		}
		return null;
	}
	if (value.kind === 'array') {
		for (const v of value.value) {
			const found = findHDKeyMap(v);
			if (found) return found;
		}
		return null;
	}
	return null;
}

function decodeCryptoAccountMap(map: Map<number, CborValue>): Omit<ScannedKeyImport, 'kind' | 'urType'> {
	const descriptorsItem = mapGet(map, 2);
	if (!descriptorsItem || descriptorsItem.kind !== 'array' || descriptorsItem.value.length === 0) {
		throw new Error('That QR code has no keys in its wallet-account export.');
	}
	const hdKeyMap = findHDKeyMap(descriptorsItem.value[0]);
	if (!hdKeyMap) {
		throw new Error("Couldn't find a public key inside that QR code's wallet-account export.");
	}
	const decoded = decodeCryptoHDKeyMap(hdKeyMap);
	// crypto-account's own master-fingerprint (field 1) is the authoritative
	// root fingerprint for the whole export, per BCR-2020-015 — prefer it
	// over whatever (possibly absent) per-key origin fingerprint the nested
	// hdkey carried.
	const masterFpItem = mapGet(map, 1);
	if (masterFpItem?.kind === 'uint') {
		return { ...decoded, fingerprint: fpHex(masterFpItem.value) };
	}
	return decoded;
}

/** Decode a reassembled `ur:crypto-hdkey` or `ur:crypto-account` CBOR payload
 *  into the wizard's normalized scanned-key shape. */
export function decodeScannedKeyCbor(type: BcurKeyUrType, cbor: Uint8Array): ScannedKeyImport {
	const { value } = decodeCborValue(cbor, 0);
	const unwrapped = value.kind === 'tag' ? value.value : value;
	if (unwrapped.kind !== 'map') {
		throw new Error('That QR code did not contain a recognizable key export.');
	}
	const decoded =
		type === 'crypto-hdkey' ? decodeCryptoHDKeyMap(unwrapped.value) : decodeCryptoAccountMap(unwrapped.value);
	return { kind: 'bcur', urType: type, ...decoded };
}

// ── Animated (multi-part) accumulator — mirrors jadeUr.ts's PsbtQrJoiner ────
//
// One reader for BOTH the new BC-UR path and the wizard's pre-existing plain-
// text acceptance (a bare xpub or a `[fingerprint/path]xpub…` fragment —
// still what some air-gapped signers show instead of an animated BC-UR
// sequence), so one QrScanner mount covers everything the wizard's QR method
// ever accepted, old and new. `result()` returns a JSON string (not the raw
// value) so this still satisfies QrScanner's generic string-returning
// QrJoinerLike contract — the caller JSON.parses it back into
// ScannedKeyImport-shaped data.
export class BcurKeyJoiner {
	private plainResult: string | null = null;
	private urType: BcurKeyUrType | null = null;
	private singleMessage: Uint8Array | null = null;
	private seqLen: number | null = null;
	private messageLen: number | null = null;
	private checksum: number | null = null;
	private fragmentLen: number | null = null;
	private fragments = new Map<number, Uint8Array>();

	add(frame: string): { complete: boolean; progress: { have: number; total: number } } {
		const trimmed = String(frame ?? '').trim();

		if (this.urType === null && this.plainResult === null && looksLikePlainKeyText(trimmed)) {
			this.plainResult = trimmed;
			return { complete: true, progress: { have: 1, total: 1 } };
		}

		const parsed = parseBcurKeyFrame(trimmed);
		if (!parsed) {
			throw new Error('That QR code is not a recognized public-key export.');
		}
		if (this.urType === null) this.urType = parsed.type;
		else if (this.urType !== parsed.type) {
			throw new Error('These QR frames are from two different key exports — rescan just one.');
		}

		if (parsed.seqNum === null || parsed.seqLen === null) {
			this.singleMessage = bytewordsDecode(parsed.body);
			this.seqLen = 1;
			return { complete: true, progress: { have: 1, total: 1 } };
		}

		const part: ParsedPart = decodePart(bytewordsDecode(parsed.body));
		if (this.seqLen === null) {
			this.seqLen = part.seqLen;
			this.messageLen = part.messageLen;
			this.checksum = part.checksum;
			this.fragmentLen = part.fragment.length;
		} else if (
			this.seqLen !== part.seqLen ||
			this.messageLen !== part.messageLen ||
			this.checksum !== part.checksum
		) {
			throw new Error('These QR frames belong to two different key exports — rescan just one.');
		}
		if (part.seqNum >= 1 && part.seqNum <= part.seqLen) {
			this.fragments.set(part.seqNum - 1, part.fragment);
		}
		return { complete: this.isComplete(), progress: this.progress() };
	}

	isComplete(): boolean {
		if (this.plainResult !== null || this.singleMessage !== null) return true;
		return this.seqLen !== null && this.fragments.size === this.seqLen;
	}

	progress(): { have: number; total: number } {
		if (this.plainResult !== null || this.singleMessage !== null) return { have: 1, total: 1 };
		return { have: this.fragments.size, total: this.seqLen ?? 0 };
	}

	reset(): void {
		this.plainResult = null;
		this.urType = null;
		this.singleMessage = null;
		this.seqLen = null;
		this.messageLen = null;
		this.checksum = null;
		this.fragmentLen = null;
		this.fragments.clear();
	}

	/** JSON-encoded ScannedKeyImport (kind:'plain' or kind:'bcur'). */
	result(): string {
		if (this.plainResult !== null) {
			const scanned: ScannedKeyImport = {
				kind: 'plain',
				xpub: this.plainResult,
				fingerprint: null,
				bip32Path: null,
				convertedFromTestnet: false
			};
			return JSON.stringify(scanned);
		}
		if (!this.urType) throw new Error('No key has been scanned yet.');

		let message: Uint8Array;
		if (this.singleMessage !== null) {
			message = this.singleMessage;
		} else {
			if (!this.isComplete()) {
				const missing = (this.seqLen ?? 0) - this.fragments.size;
				throw new Error(`BC-UR sequence incomplete — ${missing} frame(s) still missing.`);
			}
			const fragLen = this.fragmentLen ?? 0;
			const joined = new Uint8Array((this.seqLen ?? 0) * fragLen);
			for (let i = 0; i < (this.seqLen ?? 0); i++) {
				const f = this.fragments.get(i);
				if (f === undefined) throw new Error(`Missing BC-UR fragment ${i}.`);
				joined.set(f, i * fragLen);
			}
			message = joined.slice(0, this.messageLen ?? joined.length);
			if (this.checksum !== null && crc32(message) !== this.checksum) {
				throw new Error('Reassembled key data failed its checksum — rescan.');
			}
		}
		return JSON.stringify(decodeScannedKeyCbor(this.urType, message));
	}
}

// concat is re-exported for parity with jadeUr.ts's public surface even
// though this module's own reassembly loop above builds fragments inline;
// kept available for a future caller that wants the raw multipart primitives
// without going through BcurKeyJoiner.
export { concat };
