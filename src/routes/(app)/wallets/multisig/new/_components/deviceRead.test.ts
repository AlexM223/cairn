// The collaborative (m/45') read gate (cairn-fdlf.4): only Trezor and Ledger
// have a BIP-45 driver read (readBip45KeyFrom*). BitBox02's firmware
// whitelists standard keypath schemas (m/45' isn't one), and Jade's m/45'
// read has never been hardware-verified — the wizard routes both to the
// manual-paste fallback with export instructions instead of attempting a
// read the drivers don't implement. Mirrors the single-sig wizard's
// supportsSharedKeyRead gate (same devices, same reasoning).

import { describe, it, expect } from 'vitest';
import { supportsCollaborativeRead } from './deviceRead';

describe('supportsCollaborativeRead', () => {
	it('allows exactly the devices with a BIP-45 driver read', () => {
		expect(supportsCollaborativeRead('trezor')).toBe(true);
		expect(supportsCollaborativeRead('ledger')).toBe(true);
		expect(supportsCollaborativeRead('bitbox02')).toBe(false);
		expect(supportsCollaborativeRead('jade')).toBe(false);
		expect(supportsCollaborativeRead('coldcard')).toBe(false);
		expect(supportsCollaborativeRead('qr')).toBe(false);
		expect(supportsCollaborativeRead('paste')).toBe(false);
	});
});
