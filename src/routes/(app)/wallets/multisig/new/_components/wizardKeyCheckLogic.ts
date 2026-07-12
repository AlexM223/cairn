// Pure compare logic behind the wizard's per-key "Verify this key" affordance
// (WizardKeyCheck.svelte) — MULTISIG-KEY-AUDIT-DESIGN §7 Wave 2.
//
// The wizard has no persisted keyId yet (the multisig doesn't exist until the
// final Create step), so it can't hit the post-creation
// `/keys/[keyId]/verified` endpoint (KeyHealthRow.svelte's Method A/B). It
// compares CLIENT-SIDE instead, using the same canonicalization the server's
// compareMultisigKey applies (normalizeXpub — SLIP-132 ypub/zpub/Ypub/Zpub ->
// standard xpub) so a re-derived or re-pasted key that merely uses a
// different but equivalent prefix still matches. Extracted to a plain module
// (not inline in the .svelte file) so it's unit-testable — this repo's vitest
// config has no Svelte plugin, mirroring keyHealth.ts / qrScannerLogic.ts.

import { normalizeXpub } from '$lib/hw/common';

export interface WizardKeyCompareResult {
	/** Master fingerprints agree (case-insensitive, whitespace-trimmed). */
	fingerprintMatch: boolean;
	/** Extended keys agree after SLIP-132 canonicalization. */
	xpubMatch: boolean;
	/** Both agree — the re-derived/re-pasted key is the one this wizard slot holds. */
	verified: boolean;
}

/**
 * Compare a freshly re-derived (device) or re-pasted key against the one
 * already sitting in a wizard key slot. Mirrors compareMultisigKey's
 * fingerprint/xpub semantics (multisig.ts, server-side) exactly, so a key
 * verified here and again after creation behaves identically.
 */
export function compareWizardKey(
	stored: { xpub: string; fingerprint: string },
	reading: { xpub: string; fingerprint: string }
): WizardKeyCompareResult {
	const fingerprintMatch =
		stored.fingerprint.trim().toLowerCase() === reading.fingerprint.trim().toLowerCase();
	const xpubMatch = normalizeXpub(stored.xpub.trim()) === normalizeXpub(reading.xpub.trim());
	return { fingerprintMatch, xpubMatch, verified: fingerprintMatch && xpubMatch };
}
