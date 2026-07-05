// Client-side seam for reading a vault cosigner key straight off a hardware
// device. The concrete readers — readVaultKeyFromTrezor / readVaultKeyFromLedger,
// returning { xpub, fingerprint, path } at the BIP-48 account — live in
// src/lib/hw/trezor.ts and src/lib/hw/ledger.ts (added by the hardware-driver
// work). This module looks them up dynamically so the wizard degrades to
// manual paste, with instructions, when a reader hasn't shipped or the
// browser can't reach the device.

export interface DeviceKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

export class DeviceReadUnavailable extends Error {
	constructor(device: 'trezor' | 'ledger') {
		super(`Direct ${device} connection isn't available here.`);
		this.name = 'DeviceReadUnavailable';
	}
}

function isDeviceKey(v: unknown): v is DeviceKey {
	if (typeof v !== 'object' || v === null) return false;
	const k = v as Record<string, unknown>;
	return (
		typeof k.xpub === 'string' && typeof k.fingerprint === 'string' && typeof k.path === 'string'
	);
}

type VaultScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

async function callReader(
	device: 'trezor' | 'ledger',
	mod: Record<string, unknown>,
	name: string,
	scriptType: VaultScriptType
): Promise<DeviceKey> {
	const fn = mod[name];
	if (typeof fn !== 'function') throw new DeviceReadUnavailable(device);
	const result: unknown = await (fn as (s: VaultScriptType) => Promise<unknown>)(scriptType);
	if (!isDeviceKey(result)) {
		throw new Error(`The ${device} returned an unexpected response — try pasting the key instead.`);
	}
	return result;
}

/** Read the BIP-48 account key from a connected Trezor via Trezor Connect. */
export async function readKeyFromTrezor(scriptType: VaultScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/trezor')) as unknown as Record<string, unknown>;
	const available = mod.isTrezorConnectAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('trezor');
	}
	return callReader('trezor', mod, 'readVaultKeyFromTrezor', scriptType);
}

/** Read the BIP-48 account key from a connected Ledger via WebHID. */
export async function readKeyFromLedger(scriptType: VaultScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/ledger')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('ledger');
	}
	return callReader('ledger', mod, 'readVaultKeyFromLedger', scriptType);
}
