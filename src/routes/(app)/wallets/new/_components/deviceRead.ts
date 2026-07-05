// Client-side seam for reading a single-sig wallet key straight off a hardware
// device. The concrete readers — readSingleSigKeyFromTrezor /
// readSingleSigKeyFromLedger / readSingleSigKeyFromBitbox02 /
// readSingleSigKeyFromJade, each returning { xpub, fingerprint, path } at the
// standard BIP-44/49/84/86 account — live in src/lib/hw/{trezor,ledger,bitbox02,
// jade}.ts (added by the hardware-driver work). This module looks them up
// dynamically so the wizard degrades to manual paste, with instructions, when a
// reader hasn't shipped or the browser can't reach the device.
//
// Sibling to the multisig wizard's deviceRead.ts, same
// dynamic-import-with-graceful-fallback pattern — scoped to single-sig readers
// (ScriptType, not MultisigScriptType) and covering all four connectable
// devices rather than just Trezor/Ledger.

import type { ScriptType } from '$lib/types';

export interface DeviceKey {
	xpub: string;
	fingerprint: string;
	path: string;
}

type Device = 'trezor' | 'ledger' | 'bitbox02' | 'jade';

const DEVICE_LABELS: Record<Device, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	bitbox02: 'BitBox02',
	jade: 'Jade'
};

export class DeviceReadUnavailable extends Error {
	constructor(device: Device) {
		super(`Direct ${DEVICE_LABELS[device]} connection isn't available here.`);
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

async function callReader(
	device: Device,
	mod: Record<string, unknown>,
	name: string,
	scriptType: ScriptType
): Promise<DeviceKey> {
	const fn = mod[name];
	if (typeof fn !== 'function') throw new DeviceReadUnavailable(device);
	const result: unknown = await (fn as (s: ScriptType) => Promise<unknown>)(scriptType);
	if (!isDeviceKey(result)) {
		throw new Error(
			`The ${DEVICE_LABELS[device]} returned an unexpected response — try pasting the key instead.`
		);
	}
	return result;
}

/** Read the single-sig account key from a connected Trezor via Trezor Connect. */
export async function readKeyFromTrezor(scriptType: ScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/trezor')) as unknown as Record<string, unknown>;
	const available = mod.isTrezorConnectAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('trezor');
	}
	return callReader('trezor', mod, 'readSingleSigKeyFromTrezor', scriptType);
}

/** Read the single-sig account key from a connected Ledger via WebHID. */
export async function readKeyFromLedger(scriptType: ScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/ledger')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('ledger');
	}
	return callReader('ledger', mod, 'readSingleSigKeyFromLedger', scriptType);
}

/** Read the single-sig account key from a connected BitBox02 via WebHID. */
export async function readKeyFromBitbox02(scriptType: ScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/bitbox02')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('bitbox02');
	}
	return callReader('bitbox02', mod, 'readSingleSigKeyFromBitbox02', scriptType);
}

/** Read the single-sig account key from a connected Jade via Web Serial. */
export async function readKeyFromJade(scriptType: ScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/jade')) as unknown as Record<string, unknown>;
	const available = mod.isWebSerialAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('jade');
	}
	return callReader('jade', mod, 'readSingleSigKeyFromJade', scriptType);
}
