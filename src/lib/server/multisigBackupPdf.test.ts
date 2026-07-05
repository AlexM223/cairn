import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { buildMultisigBackupPdf } from './multisigBackupPdf';
import type { MultisigKeyRow, MultisigRow } from './wallets/multisig';

// The first two keys are BIP32 spec test-vector masters — stable, public, never
// a real wallet. The third is derived deterministically from a fixed seed. Same
// construction the other multisig export tests use, so the config is valid and
// its descriptor/QR build cleanly.
const TV1 =
	'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const TV2 =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
const TV3 = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).publicExtendedKey;

const BIP48_PATH = "m/48'/0'/0'/2'";

function keyRow(position: number, xpub: string, fingerprint: string): MultisigKeyRow {
	return {
		id: position + 1,
		multisigId: 1,
		position,
		name: `Key ${position + 1}`,
		category: 'hardware',
		deviceType: null,
		xpub,
		fingerprint,
		path: BIP48_PATH
	};
}

const FIXTURE: MultisigRow = {
	id: 1,
	userId: 1,
	name: 'Family savings',
	threshold: 2,
	scriptType: 'p2wsh',
	receiveCursor: 0,
	createdAt: '2026-07-05T12:00:00.000Z',
	source: 'created',
	keys: [
		keyRow(0, TV1, 'aabbccdd'),
		keyRow(1, TV2, '11223344'),
		keyRow(2, TV3, '99887766')
	]
};

describe('buildMultisigBackupPdf', () => {
	it('produces a valid, non-trivial PDF for a 2-of-3 multisig', async () => {
		const bytes = await buildMultisigBackupPdf(FIXTURE);

		expect(bytes).toBeInstanceOf(Uint8Array);
		// "%PDF" magic header.
		expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
		// A real page with an embedded QR image is many KB — guard against an
		// empty/degenerate document.
		expect(bytes.length).toBeGreaterThan(5000);
	});
});
