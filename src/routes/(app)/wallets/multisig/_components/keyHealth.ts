// Pure logic behind the key health check (KeyHealthRow.svelte), extracted so
// the account inference is unit-testable.

export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

/** Hardened-index ceiling: BIP-32 account numbers live below 2^31. */
const HARDENED = 0x80000000;

/**
 * The BIP-48 account index encoded in a stored key path — or null when the
 * path is not the standard BIP-48 layout for this multisig's script type.
 *
 * A device health check re-reads the key at m/48'/0'/{account}'/{script}'
 * (script suffix 2' for native p2wsh, 1' for both p2sh forms — see
 * multisigAccountPath in $lib/hw/ledger). That comparison only proves anything
 * when the re-read derivation is exactly the stored one, so a key imported
 * with any other path must NOT be silently probed at account 0: returning
 * null here routes the check to the manual receive-address flow instead.
 *
 * Accepts apostrophe/curly-quote/h/H hardening markers, matching how paths
 * arrive from the various import surfaces.
 */
export function accountFromPath(path: string, scriptType: MultisigScriptType): number | null {
	const m = /^m\/48['’hH]\/0['’hH]\/(\d+)['’hH]\/([12])['’hH]$/.exec(path.trim());
	if (!m) return null;
	const expectedScriptSuffix = scriptType === 'p2wsh' ? '2' : '1';
	if (m[2] !== expectedScriptSuffix) return null;
	const account = Number(m[1]);
	return Number.isSafeInteger(account) && account < HARDENED ? account : null;
}
