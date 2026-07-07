// Vault-intent validation for the multisig creation wizard (cairn-fdlf.4/.5).
//
// The wizard asks, once per vault, whether the vault is SHARED with other
// people (collaborative custody → every key on the BIP-45 path m/45') or
// PERSONAL (all the user's own keys → BIP-48 with the wallet's script-type
// suffix). This module holds the pure decision logic behind that question so
// the `key` and `knownKeys` actions and their tests share one implementation:
//
//   • validateKeyForIntent — accept/reject one key's declared path against the
//     declared intent, mirroring createMultisig's server-side enforcement
//     (cairn-1kc3.6) so a bad key fails at ADD time with an actionable message
//     instead of at the very end of the wizard.
//   • reusableDeviceKeys — which known-device-keys registry rows
//     (src/lib/server/deviceKeys.ts) may be offered for reuse in THIS vault.
//
// Server-only (`.server.ts`): it leans on $lib/server/bitcoin/multisig, which
// must never reach the client bundle.

import {
	MultisigError,
	cosignerPathPurpose,
	validateCosignerKeyPath,
	type MultisigScriptType
} from '$lib/server/bitcoin/multisig';

/** The declared vault mode; null = never declared (import prefills, and key
 *  sets the user edited after importing — no mode enforcement, only the
 *  universal path checks). */
export type VaultIntent = 'collaborative' | 'personal' | null;

/** Parse the wizard's `intent` form field. Anything unrecognized (including
 *  the empty string the wizard sends before the question is answered) is
 *  "undeclared" — never a guess. */
export function parseVaultIntent(raw: unknown): VaultIntent {
	return raw === 'collaborative' || raw === 'personal' ? raw : null;
}

/** The device-keys registry purpose a declared intent reuses ('45'
 *  collaborative, '48' personal) — cairn-fdlf.4's reuse-before-fresh-read. */
export function intentPurpose(intent: 'collaborative' | 'personal'): '45' | '48' {
	return intent === 'collaborative' ? '45' : '48';
}

/** How to actually produce an m/45' export by hand — the bridging tools.
 *  Trezor Suite / Ledger Live's own consumer apps expose no custom-path xpub
 *  export, so the copy must never point there (bead cairn-fdlf.5's vendor
 *  verification note). */
const BIP45_EXPORT_HELP =
	"To export it: Electrum reads multisig hardware keys at m/45' by default (pick the \"legacy\" multisig type), or in Sparrow / Specter set the derivation path to m/45' when adding the keystore.";

/**
 * Validate one cosigner key's declared origin path against the vault's
 * declared intent, throwing a MultisigError (message safe to show verbatim)
 * on rejection.
 *
 * Always runs the universal path check first (validateCosignerKeyPath —
 * single-sig purposes hard-rejected, BIP-48 suffix must match the script
 * type), then layers the intent rule on top:
 *
 *   • collaborative → purpose MUST be 45'. A BIP-48 key and an unknown-origin
 *     key are both rejected here because createMultisig (cairn-1kc3.6) hard-
 *     rejects them at creation anyway — letting them into the key list would
 *     only move the failure to the end of the wizard. The unknown-origin
 *     message steers toward the full `[fingerprint/45']xpub` paste form.
 *   • personal → purpose 45' rejected (m/45' marks a key as shared); BIP-48
 *     and unknown-origin keys keep today's behavior.
 *   • null (undeclared) → universal checks only, today's permissive behavior.
 */
export function validateKeyForIntent(
	path: string,
	scriptType: MultisigScriptType,
	intent: VaultIntent,
	label: string
): void {
	validateCosignerKeyPath(path, scriptType, label);
	if (intent === null) return;

	const purpose = cosignerPathPurpose(path);
	const shown = path.trim() || 'm';
	if (intent === 'collaborative') {
		if (purpose === 45) return;
		if (purpose === 48) {
			throw new MultisigError(
				`${label}: this key was exported for a personal multisig (its path "${shown}" starts with 48'), but this vault is shared — every key needs the m/45' export. ${BIP45_EXPORT_HELP}`,
				'invalid_key'
			);
		}
		throw new MultisigError(
			`${label}: this key doesn't say which path it was exported from, so Cairn can't confirm it's the m/45' key a shared vault needs. Paste the full form — [fingerprint/45']xpub… — instead of the bare key. ${BIP45_EXPORT_HELP}`,
			'invalid_key'
		);
	}
	// personal
	if (purpose === 45) {
		throw new MultisigError(
			`${label}: m/45' marks a key as shared for collaborative custody, but this vault is personal — use the standard multisig export (a BIP-48 path like m/48'/0'/0'/2') instead. If this vault IS shared with other people, remove the keys and change the vault type first.`,
			'invalid_key'
		);
	}
}

/** The subset of a device-keys registry row the reuse offer needs. */
export interface ReusableDeviceKey {
	fingerprint: string;
	purpose: '45' | '48';
	xpub: string;
	path: string;
	deviceType: string | null;
}

/**
 * Which registry rows can actually be offered for reuse in THIS vault: rows of
 * the intent's purpose whose stored path also passes the full intent + script
 * type validation (a '48' row read for a p2wsh wallet, …/2', is useless in a
 * p2sh-p2wsh wallet, which needs …/1').
 *
 * Privacy invariant (cairn-fdlf.3): callers pass ONLY multisig-purpose rows
 * (listDeviceKeys with the single intent purpose) — this filter never widens
 * the set, so single-sig-purpose registry rows can't leak into the wizard.
 */
export function reusableDeviceKeys<T extends ReusableDeviceKey>(
	rows: T[],
	scriptType: MultisigScriptType,
	intent: 'collaborative' | 'personal'
): T[] {
	const purpose = intentPurpose(intent);
	return rows.filter((row) => {
		if (row.purpose !== purpose) return false;
		try {
			validateKeyForIntent(row.path, scriptType, intent, 'key');
			return true;
		} catch {
			return false;
		}
	});
}
