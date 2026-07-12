import { describe, it, expect, afterEach, vi } from 'vitest';
import { isCameraScanAvailable, cameraScanUnavailableReason } from './qrScan';

// A stand-in BarcodeDetector constructor — its shape doesn't matter here, only
// that `globalThis.BarcodeDetector` is defined (that's all `barcodeDetectorCtor()`
// checks for).
class FakeBarcodeDetector {
	async detect() {
		return [];
	}
}

function stubSecureChromium() {
	vi.stubGlobal('window', { isSecureContext: true });
	vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
	vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isCameraScanAvailable / cameraScanUnavailableReason — Node/SSR baseline', () => {
	it('is unavailable with no window/navigator stubs (matches jade.test.ts\'s isWebSerialAvailable precedent)', () => {
		expect(isCameraScanAvailable()).toBe(false);
		expect(cameraScanUnavailableReason()).toBe('no-camera');
	});
});

describe('cameraScanUnavailableReason', () => {
	it("reports 'ok' when secure context + mediaDevices + BarcodeDetector are all present", () => {
		stubSecureChromium();
		expect(cameraScanUnavailableReason()).toBe('ok');
		expect(isCameraScanAvailable()).toBe(true);
	});

	it("reports 'insecure-context' first, even if mediaDevices/BarcodeDetector look present", () => {
		// Real browsers withhold navigator.mediaDevices entirely on an insecure
		// origin, but the check must not RELY on that — isSecureContext is
		// checked directly and wins regardless of what else is stubbed.
		vi.stubGlobal('window', { isSecureContext: false });
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
		vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
		expect(cameraScanUnavailableReason()).toBe('insecure-context');
	});

	it("reports 'unsupported-browser' on a secure context with getUserMedia but no BarcodeDetector (Firefox/Safari)", () => {
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
		expect(cameraScanUnavailableReason()).toBe('unsupported-browser');
		expect(isCameraScanAvailable()).toBe(false);
	});

	it("reports 'no-camera' on a secure context with no mediaDevices at all", () => {
		vi.stubGlobal('window', { isSecureContext: true });
		vi.stubGlobal('navigator', {});
		vi.stubGlobal('BarcodeDetector', FakeBarcodeDetector);
		expect(cameraScanUnavailableReason()).toBe('no-camera');
		expect(isCameraScanAvailable()).toBe(false);
	});
});
