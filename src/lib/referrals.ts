// Referral links & official device resources (cairn-sow7). CLIENT-SAFE — this
// module is imported by Svelte components (signing cards, wizards, the wallet
// detail page) and must never pull in server code.
//
// Two conceptually separate kinds of links live around these constants:
//
//  (a) REFERRAL / BUY links — promotional, admin-configurable per device via
//      the settings table (see $lib/server/referrals.ts), and gated by the
//      `referral_links` feature flag. The OFFICIAL_STORE_URLS below are only
//      the *defaults* the server falls back to when no override is set.
//  (b) OFFICIAL TROUBLESHOOTING links — OFFICIAL_SUPPORT_URLS. Hardcoded,
//      never admin-configurable, not promotional, and ALWAYS shown regardless
//      of the flag: a user stuck with a misbehaving device gets help, full stop.

import type { WalletDeviceType } from '$lib/types';

/**
 * The hardware devices Cairn can point a "buy one" or "get help" link at —
 * the subset of WalletDeviceType that names a specific vendor ('jade-qr'
 * collapses into 'jade'; 'qr' and 'file' are vendor-agnostic).
 */
export type ReferralDeviceId = Extract<
	WalletDeviceType,
	'trezor' | 'ledger' | 'coldcard' | 'bitbox02' | 'jade'
>;

export const REFERRAL_DEVICE_IDS: readonly ReferralDeviceId[] = [
	'trezor',
	'ledger',
	'coldcard',
	'bitbox02',
	'jade'
] as const;

/** Human names, matching WALLET_DEVICE_LABELS for the same ids. */
export const REFERRAL_DEVICE_LABELS: Record<ReferralDeviceId, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	coldcard: 'ColdCard',
	bitbox02: 'BitBox02',
	jade: 'Jade'
};

/** Official vendor stores — the DEFAULT buy links when no admin override is set. */
export const OFFICIAL_STORE_URLS: Record<ReferralDeviceId, string> = {
	trezor: 'https://trezor.io',
	ledger: 'https://shop.ledger.com',
	coldcard: 'https://store.coinkite.com',
	bitbox02: 'https://shiftcrypto.ch',
	jade: 'https://blockstream.com/jade'
};

/**
 * Official vendor troubleshooting/support resources. Hardcoded on purpose —
 * these are never admin-configurable and never hidden by the referral flag.
 */
export const OFFICIAL_SUPPORT_URLS: Record<ReferralDeviceId, string> = {
	trezor: 'https://trezor.io/support',
	ledger: 'https://support.ledger.com',
	coldcard: 'https://coldcard.com/docs',
	bitbox02: 'https://shiftcrypto.ch/support',
	jade: 'https://help.blockstream.com'
};

/**
 * Map a wallet's recorded device type to the vendor its links live under.
 * 'jade-qr' is still a Jade; 'qr' / 'file' / null name no vendor → null.
 */
export function referralDeviceId(
	deviceType: WalletDeviceType | string | null | undefined
): ReferralDeviceId | null {
	if (!deviceType) return null;
	if (deviceType === 'jade-qr') return 'jade';
	return (REFERRAL_DEVICE_IDS as readonly string[]).includes(deviceType)
		? (deviceType as ReferralDeviceId)
		: null;
}

/**
 * The shape send-flow/wizard loads put on page data (as `referralBuyUrls`)
 * when the referral_links flag is on; absent/null when it's off — so client
 * code shows a buy link exactly when a URL is present, no separate flag check.
 */
export type ReferralBuyUrls = Record<ReferralDeviceId, string>;
