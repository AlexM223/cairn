// Display labels shared by the vault list, wizard, and detail pages.

import type { VaultDeviceType, VaultKeyCategory, VaultScriptType } from '$lib/server/vaults';

export const VAULT_SCRIPT_LABELS: Record<VaultScriptType, string> = {
	p2wsh: 'Native SegWit',
	'p2sh-p2wsh': 'Nested SegWit',
	p2sh: 'Legacy multisig'
};

export const KEY_CATEGORY_LABELS: Record<VaultKeyCategory, string> = {
	hardware: 'Hardware key',
	mobile: 'Mobile key',
	recovery: 'Recovery key'
};

export const DEVICE_LABELS: Record<Exclude<VaultDeviceType, null>, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	coldcard: 'ColdCard',
	qr: 'QR signer',
	file: 'File / SD card'
};

export function quorumLabel(threshold: number, total: number): string {
	return `${threshold} of ${total}`;
}
