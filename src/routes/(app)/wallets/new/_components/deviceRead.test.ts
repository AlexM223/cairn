// The sharing-key prefetch gate (cairn-fdlf.1): only Ledger and Trezor
// support the extra m/45' read (Bastion's hardware-verified gating) — the
// wizard uses this to skip BitBox02/Jade with an honest notice instead of
// attempting a read the drivers don't implement.

import { describe, it, expect } from 'vitest';
import { supportsSharedKeyRead } from './deviceRead';

describe('supportsSharedKeyRead', () => {
	it('allows exactly the devices with a BIP-45 driver read', () => {
		expect(supportsSharedKeyRead('trezor')).toBe(true);
		expect(supportsSharedKeyRead('ledger')).toBe(true);
		expect(supportsSharedKeyRead('bitbox02')).toBe(false);
		expect(supportsSharedKeyRead('jade')).toBe(false);
		expect(supportsSharedKeyRead('coldcard')).toBe(false);
		expect(supportsSharedKeyRead('qr')).toBe(false);
		expect(supportsSharedKeyRead('paste')).toBe(false);
	});
});
