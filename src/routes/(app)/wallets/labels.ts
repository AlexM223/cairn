import type { ScriptType, WalletDeviceType } from '$lib/types';

/** Human names for address script types, shown as badges across wallet pages. */
export const SCRIPT_TYPE_LABELS: Record<ScriptType, string> = {
	p2wpkh: 'Native SegWit',
	'p2sh-p2wpkh': 'Nested SegWit',
	p2pkh: 'Legacy',
	p2tr: 'Taproot'
};

/** Human names for the signing device that holds a wallet's key. */
export const WALLET_DEVICE_LABELS: Record<WalletDeviceType, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	coldcard: 'ColdCard',
	bitbox02: 'BitBox02',
	jade: 'Jade',
	qr: 'Air-gapped signer',
	file: 'File / SD card'
};

/**
 * How to name a wallet by the device on record. A recognised hardware device
 * gives "Trezor wallet"; an air-gapped signer reads more naturally as
 * "Air-gapped wallet"; anything generic (file/unspecified) is just "Wallet".
 * Deliberately never "watch-only" — the wallet can always sign.
 */
export function walletTypeLabel(deviceType: WalletDeviceType | null): string {
	switch (deviceType) {
		case 'trezor':
			return 'Trezor wallet';
		case 'ledger':
			return 'Ledger wallet';
		case 'coldcard':
			return 'ColdCard wallet';
		case 'bitbox02':
			return 'BitBox02 wallet';
		case 'jade':
			return 'Jade wallet';
		case 'qr':
			return 'Air-gapped wallet';
		default:
			return 'Wallet';
	}
}
