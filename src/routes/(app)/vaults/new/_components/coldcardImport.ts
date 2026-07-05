// Parse a ColdCard "Generic JSON" wallet export (Advanced/Tools → Export
// Wallet → Generic JSON → coldcard-export.json on the microSD card). The file
// carries every account the device supports; the multisig cosigner key lives
// under bip48_2 (native segwit, m/48'/0'/0'/2') or bip48_1 (wrapped/legacy,
// m/48'/0'/0'/1'), each with its own xpub, derivation and master fingerprint.

import type { VaultScriptType } from '$lib/server/vaults';

export interface ColdcardKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

const NOT_EXPORT_MSG =
	"That file doesn't look like the ColdCard wallet export. On the ColdCard choose " +
	'Advanced/Tools → Export Wallet → Generic JSON, then upload coldcard-export.json from the microSD card.';

export function parseColdcardExport(text: string, scriptType: VaultScriptType): ColdcardKey {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new Error(NOT_EXPORT_MSG);
	}
	if (typeof doc !== 'object' || doc === null) throw new Error(NOT_EXPORT_MSG);
	const root = doc as Record<string, unknown>;

	// BIP-48 script sub-account: 2' is P2WSH only; 1' covers both wrapped types.
	const section = scriptType === 'p2wsh' ? 'bip48_2' : 'bip48_1';
	const node = root[section];
	if (typeof node !== 'object' || node === null) {
		throw new Error(
			`The export has no multisig section (${section}) — make sure the ColdCard firmware is current and you chose Generic JSON.`
		);
	}
	const entry = node as Record<string, unknown>;
	const xpub = typeof entry.xpub === 'string' ? entry.xpub : null;
	if (!xpub) throw new Error(NOT_EXPORT_MSG);

	const rawFp = typeof entry.xfp === 'string' ? entry.xfp : typeof root.xfp === 'string' ? root.xfp : '';
	const fingerprint = /^[0-9a-fA-F]{8}$/.test(rawFp) ? rawFp.toLowerCase() : '00000000';
	const path =
		typeof entry.deriv === 'string' && entry.deriv.trim()
			? entry.deriv.trim()
			: scriptType === 'p2wsh'
				? "m/48'/0'/0'/2'"
				: "m/48'/0'/0'/1'";

	return { xpub, fingerprint, path };
}
