// Client-side seam for reading a multisig cosigner key straight off a hardware
// device. The concrete readers — readMultisigKeyFromTrezor / readMultisigKeyFromLedger
// / readMultisigKeyFromBitbox02 / readMultisigKeyFromJade, returning
// { xpub, fingerprint, path } at the BIP-48 account — live in src/lib/hw/*.ts
// (added by the hardware-driver work). This module looks them up dynamically so
// the wizard degrades to manual paste, with instructions, when a reader hasn't
// shipped or the browser can't reach the device.

/** The USB/serial devices the wizard can read a key from directly. */
type ReadDevice = 'trezor' | 'ledger' | 'bitbox02' | 'jade';

export interface DeviceKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

export class DeviceReadUnavailable extends Error {
	constructor(device: ReadDevice) {
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

type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';

async function callReader(
	device: ReadDevice,
	mod: Record<string, unknown>,
	name: string,
	scriptType: MultisigScriptType
): Promise<DeviceKey> {
	const fn = mod[name];
	if (typeof fn !== 'function') throw new DeviceReadUnavailable(device);
	const result: unknown = await (fn as (s: MultisigScriptType) => Promise<unknown>)(scriptType);
	if (!isDeviceKey(result)) {
		throw new Error(`The ${device} returned an unexpected response — try pasting the key instead.`);
	}
	return result;
}

/** Read the BIP-48 account key from a connected Trezor via Trezor Connect. */
export async function readKeyFromTrezor(scriptType: MultisigScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/trezor')) as unknown as Record<string, unknown>;
	const available = mod.isTrezorConnectAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('trezor');
	}
	return callReader('trezor', mod, 'readMultisigKeyFromTrezor', scriptType);
}

/** Read the BIP-48 account key from a connected Ledger via WebHID. */
export async function readKeyFromLedger(scriptType: MultisigScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/ledger')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('ledger');
	}
	return callReader('ledger', mod, 'readMultisigKeyFromLedger', scriptType);
}

/** Read the BIP-48 account key from a connected BitBox02 via WebHID. Throws the
 *  driver's own typed error for plain-P2SH multisig (the device can't do it). */
export async function readKeyFromBitbox02(scriptType: MultisigScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/bitbox02')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('bitbox02');
	}
	return callReader('bitbox02', mod, 'readMultisigKeyFromBitbox02', scriptType);
}

/** Read the BIP-48 account key from a connected Jade over Web Serial. */
export async function readKeyFromJade(scriptType: MultisigScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/jade')) as unknown as Record<string, unknown>;
	const available = mod.isWebSerialAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('jade');
	}
	return callReader('jade', mod, 'readMultisigKeyFromJade', scriptType);
}
