// The Sign step's device-method list + capability gating, extracted from
// +page.svelte so the wiring is unit-testable (cairn-34nl; the Ledger/ColdCard/
// QR entries themselves were wired into the grid by cairn-5i3).
//
// Pure function of its inputs: the wallet's script type plus the browser
// capability probes. The probes are injectable for tests; the defaults are the
// real feature checks from each driver. `available` stays a THUNK (not a
// boolean) on purpose — the page evaluates it client-side after mount, because
// none of the navigator.* / window.* capabilities exist during SSR.

import { isWebHidAvailable } from '$lib/hw/ledger';
import { isTrezorConnectAvailable } from '$lib/hw/trezor';
import { isBitbox02Available, bitbox02SupportsScriptType } from '$lib/hw/bitbox02';
import { isWebSerialAvailable } from '$lib/hw/jade';
import type { ScriptType } from '$lib/types';
import type { DeviceMethod } from './signerContract';

/** Every non-file signing method the Sign step offers. Matches the page's
 *  SignMethod set (=== WalletDeviceType) minus the generic 'file' card, which
 *  is rendered separately and is always available. */
export type DeviceSignMethodKey =
	| 'trezor'
	| 'ledger'
	| 'coldcard'
	| 'bitbox02'
	| 'jade'
	| 'jade-qr'
	| 'qr';

export interface DeviceSignMethod extends DeviceMethod {
	key: DeviceSignMethodKey;
	icon: string;
	/** Why the method can't run here — shown on the disabled tile. Empty for
	 *  methods that are always available. */
	unavailableReason: string;
}

/** The capability probes the method list gates on. Injectable so tests can
 *  simulate any browser; the defaults are the real driver feature checks. */
export interface SignMethodCapabilities {
	/** A browser at all — the Trezor Connect popup carries its own transport. */
	trezorConnectAvailable: () => boolean;
	/** WebHID (Ledger). */
	webHidAvailable: () => boolean;
	/** BitBox02 reachability: WebHID or the BitBoxBridge (any browser). */
	bitbox02Available: () => boolean;
	/** Web Serial (Jade over USB). */
	webSerialAvailable: () => boolean;
	/** Whether the BitBox02 firmware can sign this wallet's script type. */
	bitbox02SupportsScriptType: (scriptType: ScriptType) => boolean;
}

const DEFAULT_CAPABILITIES: SignMethodCapabilities = {
	trezorConnectAvailable: isTrezorConnectAvailable,
	webHidAvailable: isWebHidAvailable,
	bitbox02Available: isBitbox02Available,
	webSerialAvailable: isWebSerialAvailable,
	bitbox02SupportsScriptType
};

/**
 * The device signing methods the Sign step's grid offers, gated per the
 * DeviceMethod contract. A method whose capability guard fails is NEVER
 * dropped from the list — it stays present with `available() === false` and a
 * human-readable `unavailableReason`, so the tile renders disabled-with-reason
 * instead of silently vanishing.
 */
export function deviceSignMethods(
	walletScriptType: ScriptType,
	caps: SignMethodCapabilities = DEFAULT_CAPABILITIES
): DeviceSignMethod[] {
	return [
		{
			key: 'trezor',
			name: 'Trezor',
			blurb: 'Sign on-device over USB via Trezor Connect — approve in the Connect popup',
			icon: 'shield',
			available: () => caps.trezorConnectAvailable(),
			unavailableReason: 'The Trezor Connect popup can only open from a web browser.'
		},
		{
			key: 'ledger',
			name: 'Ledger',
			blurb: 'Sign on-device over USB (WebHID) — nothing leaves the device but signatures',
			icon: 'shield',
			available: () => caps.webHidAvailable(),
			unavailableReason:
				'Needs WebHID, which is only in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost.'
		},
		{
			key: 'bitbox02',
			name: 'BitBox02',
			blurb: 'Sign on-device over USB — directly, or through the BitBoxBridge app',
			icon: 'shield',
			// Reachable in any browser (WebHID or the BitBoxBridge) — but the
			// script type must be one the device supports (no legacy p2pkh).
			available: () => caps.bitbox02Available() && caps.bitbox02SupportsScriptType(walletScriptType),
			unavailableReason: !caps.bitbox02SupportsScriptType(walletScriptType)
				? "The BitBox02 doesn't support legacy (P2PKH) single-sig wallets — use the file method."
				: 'The BitBox02 can only connect from a web browser.'
		},
		{
			key: 'jade',
			name: 'Jade (USB)',
			blurb: 'Sign on-device over USB (Web Serial) — nothing leaves the device but signatures',
			icon: 'shield',
			available: () => caps.webSerialAvailable(),
			unavailableReason:
				'Needs Web Serial, which is only in Chromium desktop browsers (Chrome, Edge, Brave) over HTTPS or localhost.'
		},
		{
			key: 'jade-qr',
			name: 'Jade (QR)',
			blurb: 'Air-gapped signing with the Jade camera — QR codes cross the gap in both directions',
			icon: 'qr',
			// Displaying the unsigned QR always works; the signer falls back to a
			// paste box when the browser can't camera-scan the signature back.
			available: () => true,
			unavailableReason: ''
		},
		{
			key: 'coldcard',
			name: 'ColdCard (microSD)',
			blurb: 'Air-gapped signing over a microSD card — no cable, no connection',
			icon: 'shield',
			// Pure file round-trip: works in any browser that can download + upload.
			available: () => true,
			unavailableReason: ''
		},
		{
			key: 'qr',
			name: 'Animated QR (SeedSigner, Passport, Jade)',
			blurb: 'Air-gapped signing over the camera — QR codes cross the gap in both directions',
			icon: 'qr',
			// Displaying the unsigned QR always works; the signer itself falls back
			// to a paste box when the browser can't camera-scan the signature back.
			available: () => true,
			unavailableReason: ''
		}
	];
}
