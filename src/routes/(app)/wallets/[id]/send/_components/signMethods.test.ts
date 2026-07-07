// cairn-34nl — Sign-step method-list wiring. Pins the regression fixed by
// cairn-5i3: Ledger, ColdCard and QR must be REAL, selectable entries in the
// send page's method grid (not "coming soon" seams), and a method whose
// browser-capability guard fails must render disabled-with-a-reason rather
// than vanish from the list.
import { describe, it, expect } from 'vitest';
import {
	deviceSignMethods,
	type DeviceSignMethodKey,
	type SignMethodCapabilities
} from './signMethods';

const ALL_ON: SignMethodCapabilities = {
	trezorConnectAvailable: () => true,
	webHidAvailable: () => true,
	bitbox02Available: () => true,
	webSerialAvailable: () => true,
	bitbox02SupportsScriptType: () => true
};

const NO_BROWSER_APIS: SignMethodCapabilities = {
	trezorConnectAvailable: () => false,
	webHidAvailable: () => false,
	bitbox02Available: () => false,
	webSerialAvailable: () => false,
	// Script-type support is a device property, not a browser one — keep it
	// true so the reason distinguishes "browser can't" from "device can't".
	bitbox02SupportsScriptType: () => true
};

function byKey(methods: ReturnType<typeof deviceSignMethods>, key: DeviceSignMethodKey) {
	const m = methods.find((entry) => entry.key === key);
	if (!m) throw new Error(`method ${key} missing from the list`);
	return m;
}

describe('deviceSignMethods (cairn-34nl)', () => {
	it('offers all four wired device methods — Ledger, Trezor, ColdCard, QR — plus the rest of the grid', () => {
		const methods = deviceSignMethods('p2wpkh', ALL_ON);
		const keys = methods.map((m) => m.key);
		// The four the bead names…
		expect(keys).toContain('ledger');
		expect(keys).toContain('trezor');
		expect(keys).toContain('coldcard');
		expect(keys).toContain('qr');
		// …and the full grid, exactly once each, in the page's tile order.
		expect(keys).toEqual(['trezor', 'ledger', 'bitbox02', 'jade', 'jade-qr', 'coldcard', 'qr']);
	});

	it('marks nothing "coming soon" — every method is live and selectable in a capable browser', () => {
		const methods = deviceSignMethods('p2wpkh', ALL_ON);
		for (const m of methods) {
			// Live: the capability thunk answers true, so the tile is selectable.
			expect(m.available(), `${m.key} should be selectable`).toBe(true);
			// No "coming soon" copy anywhere on the tile.
			for (const text of [m.name, m.blurb, m.unavailableReason]) {
				expect(text.toLowerCase()).not.toContain('coming soon');
			}
			// Each tile has the copy the grid renders.
			expect(m.name.length).toBeGreaterThan(0);
			expect(m.blurb.length).toBeGreaterThan(0);
			expect(m.icon.length).toBeGreaterThan(0);
		}
	});

	it('a false capability guard yields disabled-with-reason — the entry never vanishes', () => {
		const methods = deviceSignMethods('p2wpkh', NO_BROWSER_APIS);
		// Same grid, same order — nothing dropped.
		expect(methods.map((m) => m.key)).toEqual(
			deviceSignMethods('p2wpkh', ALL_ON).map((m) => m.key)
		);
		// Every browser-gated method is present but disabled, with a reason.
		for (const key of ['trezor', 'ledger', 'bitbox02', 'jade'] as const) {
			const m = byKey(methods, key);
			expect(m.available(), `${key} should be gated off`).toBe(false);
			expect(m.unavailableReason.length, `${key} needs a reason`).toBeGreaterThan(0);
		}
	});

	it('air-gapped methods (ColdCard, QR, Jade QR) never gate on browser capabilities', () => {
		const methods = deviceSignMethods('p2wpkh', NO_BROWSER_APIS);
		for (const key of ['coldcard', 'qr', 'jade-qr'] as const) {
			expect(byKey(methods, key).available(), `${key} is always available`).toBe(true);
		}
	});

	it('disables BitBox02 for a legacy p2pkh wallet with the legacy-specific reason, even when reachable', () => {
		const caps: SignMethodCapabilities = {
			...ALL_ON,
			bitbox02SupportsScriptType: (scriptType) => scriptType !== 'p2pkh'
		};
		const legacy = byKey(deviceSignMethods('p2pkh', caps), 'bitbox02');
		expect(legacy.available()).toBe(false);
		expect(legacy.unavailableReason).toMatch(/P2PKH/i);

		// A supported script type keeps the browser-flavoured reason and stays live.
		const segwit = byKey(deviceSignMethods('p2wpkh', caps), 'bitbox02');
		expect(segwit.available()).toBe(true);
		expect(segwit.unavailableReason).toMatch(/browser/i);
	});

	it('default probes are SSR-safe: in Node the USB methods report unavailable instead of throwing', () => {
		// No caps injected — the real driver feature checks run, with no window/
		// navigator present (exactly the page's pre-mount posture).
		const methods = deviceSignMethods('p2wpkh');
		expect(methods).toHaveLength(7);
		for (const key of ['trezor', 'ledger', 'bitbox02', 'jade'] as const) {
			expect(byKey(methods, key).available()).toBe(false);
		}
		for (const key of ['coldcard', 'qr', 'jade-qr'] as const) {
			expect(byKey(methods, key).available()).toBe(true);
		}
	});
});
