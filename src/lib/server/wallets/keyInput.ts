// Shared normalization for one multisig key's raw input — the wizard's paste
// box and the API's { xpub, fingerprint, path } key fields both funnel through
// here so the two creation paths can't disagree on the same input (cairn-mvtf).

import {
	parseDescriptor,
	multisigToDescriptor,
	MultisigError,
	type MultisigConfig
} from '../bitcoin/multisig';
import { containsPrivateKeyMaterial } from '../multisigExport';

export const PASTED_PRIVATE_KEY_REFUSAL =
	"That's a private key. Never paste it anywhere. Export the public key instead (look for 'xpub' in your wallet).";

/**
 * Normalize one pasted/imported key. Accepts a bare xpub, a SLIP-132
 * Ypub/Zpub, or a descriptor-style `[fingerprint/path]xpub` expression —
 * whatever the multisig library's key parsing accepts, by wrapping the paste
 * in a 1-of-1 sortedmulti descriptor. Separate fingerprint/path fields fill
 * in whatever the paste itself didn't carry.
 *
 * When the paste embeds its own origin (bracket notation), that
 * descriptor-derived fingerprint/path wins over a separately declared field
 * that might contradict it — the bracket travelled with the key material
 * itself, a declared field alongside it is just metadata (cairn-mvtf).
 */
export function normalizeMultisigKeyInput(paste: string, fpField: string, pathField: string) {
	const raw = paste.replace(/\s+/g, '');
	if (!raw) {
		throw new MultisigError('Paste the key first — it starts with xpub, Zpub or [.', 'invalid_key');
	}
	if (containsPrivateKeyMaterial(raw)) {
		throw new MultisigError(PASTED_PRIVATE_KEY_REFUSAL, 'invalid_key');
	}
	if (/^(wsh|sh)\(/i.test(raw)) {
		throw new MultisigError(
			'That looks like a full multisig descriptor — use "Import an existing multisig" instead.',
			'invalid_descriptor'
		);
	}
	const parsed = parseDescriptor(`wsh(sortedmulti(1,${raw}))`).keys[0];

	let fingerprint = parsed.fingerprint;
	let path = parsed.path;
	const fp = fpField.trim().toLowerCase();
	const p = pathField.trim();
	if (fingerprint === '00000000' && fp) fingerprint = fp;
	if (path === 'm' && p) path = p;

	// Full validation (fingerprint format, path syntax, key parses) plus
	// SLIP-132 canonicalization, via a descriptor round-trip — one code path.
	const single: MultisigConfig = { threshold: 1, keys: [{ xpub: parsed.xpub, fingerprint, path }] };
	const canonical = parseDescriptor(multisigToDescriptor(single)).keys[0].xpub;
	return { xpub: canonical, fingerprint, path };
}

/** True when a raw xpub field is itself a `[fingerprint/path]xpub`-style
 *  key-origin expression (same bracket the wizard's paste box accepts) rather
 *  than a bare account-level xpub. Only in this shape does the input embed
 *  its own fingerprint the server can verify — a bare xpub cannot yield the
 *  true device master fingerprint by itself (cairn-mvtf). */
export function looksLikeKeyOriginExpression(rawXpub: string): boolean {
	return rawXpub.trim().startsWith('[');
}
