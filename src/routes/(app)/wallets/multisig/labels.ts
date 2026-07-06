// Display labels shared by the multisig list, wizard, and detail pages.

import type { MultisigDeviceType, MultisigKeyCategory, MultisigScriptType } from '$lib/server/wallets/multisig';

export const MULTISIG_SCRIPT_LABELS: Record<MultisigScriptType, string> = {
	p2wsh: 'Native SegWit',
	'p2sh-p2wsh': 'Nested SegWit',
	p2sh: 'Legacy multisig'
};

export const KEY_CATEGORY_LABELS: Record<MultisigKeyCategory, string> = {
	hardware: 'Hardware key',
	mobile: 'Mobile key',
	recovery: 'Recovery key'
};

export const DEVICE_LABELS: Record<Exclude<MultisigDeviceType, null>, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	coldcard: 'ColdCard',
	bitbox02: 'BitBox02',
	jade: 'Jade',
	qr: 'QR signer',
	file: 'File / SD card'
};

export function quorumLabel(threshold: number, total: number): string {
	return `${threshold} of ${total}`;
}
