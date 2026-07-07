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

/** Read the BIP-48 account key from a connected BitBox02 (WebHID or the
 *  BitBoxBridge — the driver picks whichever this browser can use). Throws the
 *  driver's own typed error for plain-P2SH multisig (the device can't do it). */
export async function readKeyFromBitbox02(scriptType: MultisigScriptType): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/bitbox02')) as unknown as Record<string, unknown>;
	const available = mod.isBitbox02Available;
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

// ------------------------------------------------- collaborative (BIP-45) reads
//
// Shared-vault (collaborative custody) reads at m/45' (cairn-fdlf.4): when the
// wizard's vault-mode question was answered "shared with other people", every
// fresh device read targets the BIP-45 purpose node m/45' — no account fields,
// no script-type branching (BIP-45 has no script-type subfield). The concrete
// readers (readBip45KeyFromTrezor / readBip45KeyFromLedger) were built for the
// single-sig wizard's sharing-key prefetch (cairn-fdlf.1) and are reused here.
//
// Device support mirrors the single-sig wizard's supportsSharedKeyRead gate,
// which follows Bastion's hardware-verified gating (Trezor/Ledger only):
//   • Trezor / Ledger — Trezor Connect's getPublicKey and Ledger's
//     getExtendedPubkey both export an xpub at any caller-supplied path,
//     including the depth-1 m/45' node. Supported.
//   • BitBox02 — bitbox-api's btcXpub() forwards the keypath to the firmware,
//     which whitelists standard keypath schemas (BIP-44/49/84/86 single-sig,
//     BIP-48 multisig); the depth-1 m/45' node is not among them, so the device
//     refuses the read. NOT supported — the wizard routes the user to the
//     manual-paste fallback with m/45' export instructions instead.
//   • Jade — jadets' getXpub() takes arbitrary path indexes and the firmware is
//     believed more permissive, but an m/45' read has never been verified
//     against real hardware (Bastion gated Jade off too). Kept unsupported
//     rather than shipping an unverified device ceremony; same paste fallback.
//     Revisit if a hardware-verified report lands.

/** Devices whose drivers support the m/45' collaborative-vault read. */
const COLLAB_READ_DEVICES: readonly ReadDevice[] = ['trezor', 'ledger'];

/** Whether the wizard can read the shared-vault key (m/45') from this device. */
export function supportsCollaborativeRead(device: string): boolean {
	return (COLLAB_READ_DEVICES as readonly string[]).includes(device);
}

async function callBip45Reader(
	device: ReadDevice,
	mod: Record<string, unknown>,
	name: string
): Promise<DeviceKey> {
	const fn = mod[name];
	if (typeof fn !== 'function') throw new DeviceReadUnavailable(device);
	const result: unknown = await (fn as () => Promise<unknown>)();
	if (!isDeviceKey(result)) {
		throw new Error(`The ${device} returned an unexpected response — try pasting the key instead.`);
	}
	return result;
}

/** Read the shared-vault (m/45') key from a connected Trezor. */
export async function readCollabKeyFromTrezor(): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/trezor')) as unknown as Record<string, unknown>;
	const available = mod.isTrezorConnectAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('trezor');
	}
	return callBip45Reader('trezor', mod, 'readBip45KeyFromTrezor');
}

/** Read the shared-vault (m/45') key from a connected Ledger. */
export async function readCollabKeyFromLedger(): Promise<DeviceKey> {
	const mod = (await import('$lib/hw/ledger')) as unknown as Record<string, unknown>;
	const available = mod.isWebHidAvailable;
	if (typeof available === 'function' && !(available as () => boolean)()) {
		throw new DeviceReadUnavailable('ledger');
	}
	return callBip45Reader('ledger', mod, 'readBip45KeyFromLedger');
}
