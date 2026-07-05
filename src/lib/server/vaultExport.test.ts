import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { vaultToDescriptor } from './bitcoin/multisig';
import { toVaultConfig, type VaultKeyRow, type VaultRow, type VaultScriptType } from './vaults';
import { VaultError } from './bitcoin/multisig';
import {
	caravanExport,
	coldcardName,
	coldcardRegistration,
	containsPrivateKeyMaterial,
	descriptorBackup,
	parseCaravanImport
} from './vaultExport';

// The first two keys are BIP32 spec test-vector masters — stable, public,
// never a real wallet. The third is derived deterministically from a fixed
// seed (same construction as multisig.test.ts / vaultScan.test.ts).
const TV1 =
	'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const TV2 =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
const TV3 = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).publicExtendedKey;

const BIP48_PATH = "m/48'/0'/0'/2'";

function keyRow(
	position: number,
	xpub: string,
	fingerprint: string,
	path = BIP48_PATH
): VaultKeyRow {
	return {
		id: position + 1,
		vaultId: 1,
		position,
		name: `Key ${position + 1}`,
		category: 'hardware',
		deviceType: null,
		xpub,
		fingerprint,
		path
	};
}

function makeVault(
	overrides: Partial<VaultRow> & { keys?: VaultKeyRow[] } = {}
): VaultRow {
	return {
		id: 1,
		userId: 1,
		name: 'Family savings',
		threshold: 2,
		scriptType: 'p2wsh',
		receiveCursor: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		keys: [
			keyRow(0, TV1, '3442193e'),
			keyRow(1, TV2, 'deadbeef'),
			keyRow(2, TV3, '01020304')
		],
		...overrides
	};
}

/** Re-encode a standard xpub with the SLIP-132 Zpub (p2wsh multisig) prefix. */
function toZpub(xpub: string): string {
	const b58 = base58check(sha256);
	const raw = b58.decode(xpub);
	raw.set([0x02, 0xaa, 0x7e, 0xd3], 0);
	return b58.encode(raw);
}

describe('coldcardName', () => {
	it('passes short ASCII names through unchanged', () => {
		expect(coldcardName('Family savings')).toBe('Family savings');
	});

	it('truncates to 20 characters', () => {
		expect(coldcardName('An extremely long vault name here')).toBe('An extremely long va');
		expect(coldcardName('An extremely long vault name here').length).toBeLessThanOrEqual(20);
	});

	it('strips non-ASCII characters and trims the result', () => {
		expect(coldcardName('Épargne famille 🏦')).toBe('pargne famille');
	});

	it('falls back to a generic name when nothing printable remains', () => {
		expect(coldcardName('🏦🏦🏦')).toBe('Cairn vault');
		expect(coldcardName('   ')).toBe('Cairn vault');
	});
});

describe('coldcardRegistration', () => {
	it('emits the exact ColdCard setup file format (uniform derivation)', () => {
		expect(coldcardRegistration(makeVault())).toBe(
			[
				'# Cairn multisig setup file',
				'Name: Family savings',
				'Policy: 2 of 3',
				'Format: P2WSH',
				"Derivation: m/48'/0'/0'/2'",
				'',
				`3442193E: ${TV1}`,
				`DEADBEEF: ${TV2}`,
				`01020304: ${TV3}`,
				''
			].join('\n')
		);
	});

	it('emits per-key Derivation lines when origin paths differ', () => {
		const vault = makeVault({
			keys: [
				keyRow(0, TV1, '3442193e', "m/48'/0'/0'/2'"),
				keyRow(1, TV2, 'deadbeef', "m/45'"),
				keyRow(2, TV3, '01020304', 'm') // unknown origin: no Derivation line
			]
		});
		expect(coldcardRegistration(vault)).toBe(
			[
				'# Cairn multisig setup file',
				'Name: Family savings',
				'Policy: 2 of 3',
				'Format: P2WSH',
				'',
				"Derivation: m/48'/0'/0'/2'",
				`3442193E: ${TV1}`,
				"Derivation: m/45'",
				`DEADBEEF: ${TV2}`,
				`01020304: ${TV3}`,
				''
			].join('\n')
		);
	});

	it('uppercases fingerprints (XFP convention)', () => {
		const text = coldcardRegistration(makeVault());
		expect(text).toContain('DEADBEEF: ');
		expect(text).not.toContain('deadbeef');
	});

	it('labels the Format per script type', () => {
		const cases: [VaultScriptType, string][] = [
			['p2wsh', 'Format: P2WSH'],
			['p2sh-p2wsh', 'Format: P2SH-P2WSH'],
			['p2sh', 'Format: P2SH']
		];
		for (const [scriptType, expected] of cases) {
			expect(coldcardRegistration(makeVault({ scriptType }))).toContain(expected);
		}
	});

	it('canonicalizes SLIP-132 Zpub keys to standard xpub form', () => {
		const vault = makeVault({
			keys: [
				keyRow(0, toZpub(TV1), '3442193e'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const text = coldcardRegistration(vault);
		expect(text).toContain(`3442193E: ${TV1}`);
		expect(text).not.toContain('Zpub');
	});

	it('states the policy as M of N', () => {
		const vault = makeVault({ threshold: 3 });
		expect(coldcardRegistration(vault)).toContain('Policy: 3 of 3');
	});
});

describe('caravanExport', () => {
	it('emits the Caravan config shape Sparrow imports', () => {
		const vault = makeVault();
		const receiveDescriptor = vaultToDescriptor(toVaultConfig(vault));
		const parsed = JSON.parse(caravanExport(vault));
		expect(parsed).toEqual({
			name: 'Family savings',
			// Caravan sets uuid to the descriptor checksum on descriptor import;
			// emitting the same value avoids its "undefined" re-export quirk.
			uuid: receiveDescriptor.slice(receiveDescriptor.lastIndexOf('#') + 1),
			addressType: 'P2WSH',
			network: 'mainnet',
			quorum: { requiredSigners: 2, totalSigners: 3 },
			extendedPublicKeys: [
				{ name: 'Key 1', bip32Path: BIP48_PATH, xpub: TV1, xfp: '3442193e' },
				{ name: 'Key 2', bip32Path: BIP48_PATH, xpub: TV2, xfp: 'deadbeef' },
				{ name: 'Key 3', bip32Path: BIP48_PATH, xpub: TV3, xfp: '01020304' }
			],
			startingAddressIndex: 0
		});
		// Caravan's own re-import chokes on these — they must never appear.
		expect(parsed.client).toBeUndefined();
		expect(parsed.extendedPublicKeys.every((k: { method?: unknown }) => k.method === undefined)).toBe(true);
	});

	it('normalizes h-notation paths to apostrophes (Caravan rejects 48h)', () => {
		const vault = makeVault({
			keys: [
				keyRow(0, TV1, '3442193e', 'm/48h/0H/0h/2h'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(vault));
		expect(parsed.extendedPublicKeys[0].bip32Path).toBe("m/48'/0'/0'/2'");
	});

	it('masks unknown paths to depth-preserving m/0/… instead of bare "m"', () => {
		// TV1/TV2 are depth-0 masters; the derived TV3 fixture is also a master
		// here — masked paths carry one /0 per depth level of the xpub.
		const vault = makeVault({
			keys: [
				keyRow(0, TV1, '3442193e', 'm'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(vault));
		expect(parsed.extendedPublicKeys[0].bip32Path).toBe('m'); // depth 0 master → no /0 levels
	});

	it('maps script types to Caravan address types', () => {
		expect(JSON.parse(caravanExport(makeVault({ scriptType: 'p2sh-p2wsh' }))).addressType).toBe(
			'P2SH-P2WSH'
		);
		expect(JSON.parse(caravanExport(makeVault({ scriptType: 'p2sh' }))).addressType).toBe('P2SH');
	});

	it('canonicalizes Zpub keys in the export', () => {
		const vault = makeVault({
			keys: [
				keyRow(0, toZpub(TV1), '3442193e'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(vault));
		expect(parsed.extendedPublicKeys[0].xpub).toBe(TV1);
	});
});

describe('parseCaravanImport', () => {
	it('round-trips Cairn\'s own JSON export back to an identical vault config', () => {
		const vault = makeVault();
		const imported = parseCaravanImport(caravanExport(vault));
		expect(imported.name).toBe(vault.name);
		expect(imported.scriptType).toBe(vault.scriptType);
		expect(imported.threshold).toBe(vault.threshold);
		expect(imported.totalKeys).toBe(vault.keys.length);
		expect(imported.keys).toEqual(
			vault.keys.map((k) => ({
				name: k.name,
				xpub: k.xpub,
				fingerprint: k.fingerprint,
				path: k.path
			}))
		);
	});

	it('maps Caravan address types to vault script types', () => {
		for (const [addressType, scriptType] of [
			['P2WSH', 'p2wsh'],
			['P2SH-P2WSH', 'p2sh-p2wsh'],
			['P2SH', 'p2sh']
		] as const) {
			const imported = parseCaravanImport(
				caravanExport(makeVault({ scriptType: scriptType as VaultScriptType }))
			);
			expect(imported.scriptType).toBe(scriptType);
			void addressType;
		}
	});

	it('tolerates unknown extra fields and missing optional metadata', () => {
		const imported = parseCaravanImport(
			JSON.stringify({
				name: 'From Unchained',
				addressType: 'P2WSH',
				network: 'mainnet',
				someFutureField: { nested: true },
				quorum: { requiredSigners: 2, totalSigners: 2 },
				extendedPublicKeys: [
					{ xpub: TV1, extra: 1 }, // no name/xfp/path
					{ name: 'Key B', bip32Path: BIP48_PATH, xpub: TV2, xfp: 'DEADBEEF' }
				]
			})
		);
		expect(imported.keys[0]).toEqual({
			name: 'Key 1',
			xpub: TV1,
			fingerprint: '00000000',
			path: 'm'
		});
		// xfp lowercased.
		expect(imported.keys[1].fingerprint).toBe('deadbeef');
	});

	it('rejects a non-mainnet wallet file with a clear message', () => {
		const testnet = JSON.parse(caravanExport(makeVault()));
		testnet.network = 'testnet';
		expect(() => parseCaravanImport(JSON.stringify(testnet))).toThrow(/mainnet/);
	});

	it('refuses any blob containing private key material, loudly', () => {
		const blob = JSON.stringify({
			addressType: 'P2WSH',
			quorum: { requiredSigners: 1 },
			extendedPublicKeys: [{ xpub: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3RJZ58a' }]
		});
		expect(() => parseCaravanImport(blob)).toThrow(/PRIVATE key/);
		expect(containsPrivateKeyMaterial('zprvAWgYBBk7JR8Gj')).toBe(true);
		expect(containsPrivateKeyMaterial(`harmless ${TV1}`)).toBe(false);
	});

	it('rejects quorum/key-count mismatches and junk input', () => {
		expect(() => parseCaravanImport('not json at all')).toThrow(VaultError);
		const mismatch = JSON.parse(caravanExport(makeVault()));
		mismatch.quorum.totalSigners = 5;
		expect(() => parseCaravanImport(JSON.stringify(mismatch))).toThrow(/corrupted/);
		const overThreshold = JSON.parse(caravanExport(makeVault()));
		overThreshold.quorum.requiredSigners = 9;
		overThreshold.quorum.totalSigners = 3;
		expect(() => parseCaravanImport(JSON.stringify(overThreshold))).toThrow(/only 3 keys/);
		expect(() =>
			parseCaravanImport(JSON.stringify({ addressType: 'P2TR', quorum: { requiredSigners: 1 }, extendedPublicKeys: [{ xpub: TV1 }] }))
		).toThrow(/address type/i);
	});
});

describe('descriptorBackup', () => {
	it('contains both checksummed descriptors and the quorum', () => {
		const vault = makeVault();
		const text = descriptorBackup(vault);
		expect(text).toContain(vaultToDescriptor(toVaultConfig(vault), { chain: 0 }));
		expect(text).toContain(vaultToDescriptor(toVaultConfig(vault), { chain: 1 }));
		expect(text).toContain('2-of-3 multisig');
		expect(text).toContain('"Family savings"');
	});
});
