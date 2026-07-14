import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { multisigToDescriptor } from './bitcoin/multisig';
import { toMultisigConfig, type MultisigKeyRow, type MultisigRow, type MultisigScriptType } from './wallets/multisig';
import { MultisigError } from './bitcoin/multisig';
import {
	caravanExport,
	coldcardName,
	coldcardRegistration,
	containsPrivateKeyMaterial,
	descriptorBackup,
	parseCaravanImport
} from './multisigExport';
// Verbatim golden configs from caravan-bitcoin/caravan
// apps/coordinator/fixtures/caravan/bitcoin-2-of-2-P2WSH_{MAINNET,TESTNET}.json.
// Their keys derive from Caravan's published test mnemonic (root xfp f57ec65d)
// — public test fixtures, never a real wallet.
import caravanMainnetFixture from './__fixtures__/caravan-2-of-2-P2WSH_MAINNET.json';
import caravanTestnetFixture from './__fixtures__/caravan-2-of-2-P2WSH_TESTNET.json';

// The first two keys are BIP32 spec test-vector masters — stable, public,
// never a real wallet. The third is derived deterministically from a fixed
// seed (same construction as multisig.test.ts / multisigScan.test.ts).
const TV1 =
	'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';
const TV2 =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
const TV3 = HDKey.fromMasterSeed(new Uint8Array(32).fill(3)).publicExtendedKey;
// A realistic cosigner xpub derived to depth 2 (NOT a master) — used to exercise
// the unknown-origin masking round-trip (cairn-o7zy): a non-zero depth means the
// mask carries "/0" levels, unlike the depth-0 masters above.
const TV_DEEP = HDKey.fromMasterSeed(new Uint8Array(32).fill(9))
	.deriveChild(0)
	.deriveChild(0).publicExtendedKey;

const BIP48_PATH = "m/48'/0'/0'/2'";

function keyRow(
	position: number,
	xpub: string,
	fingerprint: string,
	path = BIP48_PATH
): MultisigKeyRow {
	return {
		id: position + 1,
		multisigId: 1,
		position,
		name: `Key ${position + 1}`,
		category: 'hardware',
		deviceType: null,
		xpub,
		fingerprint,
		path
	};
}

function makeMultisig(
	overrides: Partial<MultisigRow> & { keys?: MultisigKeyRow[] } = {}
): MultisigRow {
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
		expect(coldcardName('An extremely long multisig name here')).toBe('An extremely long mu');
		expect(coldcardName('An extremely long multisig name here').length).toBeLessThanOrEqual(20);
	});

	it('strips non-ASCII characters and trims the result', () => {
		expect(coldcardName('Épargne famille 🏦')).toBe('pargne famille');
	});

	it('falls back to a generic name when nothing printable remains', () => {
		expect(coldcardName('🏦🏦🏦')).toBe('Heartwood multisig');
		expect(coldcardName('   ')).toBe('Heartwood multisig');
	});
});

describe('coldcardRegistration', () => {
	it('emits the exact ColdCard setup file format (uniform derivation)', () => {
		expect(coldcardRegistration(makeMultisig())).toBe(
			[
				'# Heartwood multisig setup file',
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
		const multisig = makeMultisig({
			keys: [
				keyRow(0, TV1, '3442193e', "m/48'/0'/0'/2'"),
				keyRow(1, TV2, 'deadbeef', "m/45'"),
				keyRow(2, TV3, '01020304', 'm') // unknown origin: no Derivation line
			]
		});
		expect(coldcardRegistration(multisig)).toBe(
			[
				'# Heartwood multisig setup file',
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
		const text = coldcardRegistration(makeMultisig());
		expect(text).toContain('DEADBEEF: ');
		expect(text).not.toContain('deadbeef');
	});

	it('labels the Format per script type', () => {
		const cases: [MultisigScriptType, string][] = [
			['p2wsh', 'Format: P2WSH'],
			['p2sh-p2wsh', 'Format: P2SH-P2WSH'],
			['p2sh', 'Format: P2SH']
		];
		for (const [scriptType, expected] of cases) {
			expect(coldcardRegistration(makeMultisig({ scriptType }))).toContain(expected);
		}
	});

	it('canonicalizes SLIP-132 Zpub keys to standard xpub form', () => {
		const multisig = makeMultisig({
			keys: [
				keyRow(0, toZpub(TV1), '3442193e'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const text = coldcardRegistration(multisig);
		expect(text).toContain(`3442193E: ${TV1}`);
		expect(text).not.toContain('Zpub');
	});

	it('states the policy as M of N', () => {
		const multisig = makeMultisig({ threshold: 3 });
		expect(coldcardRegistration(multisig)).toContain('Policy: 3 of 3');
	});
});

describe('caravanExport', () => {
	it('emits the Caravan config shape Sparrow imports', () => {
		const multisig = makeMultisig();
		const receiveDescriptor = multisigToDescriptor(toMultisigConfig(multisig));
		const parsed = JSON.parse(caravanExport(multisig));
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
		const multisig = makeMultisig({
			keys: [
				keyRow(0, TV1, '3442193e', 'm/48h/0H/0h/2h'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(multisig));
		expect(parsed.extendedPublicKeys[0].bip32Path).toBe("m/48'/0'/0'/2'");
	});

	it('masks unknown paths to depth-preserving m/0/… instead of bare "m"', () => {
		// TV1/TV2 are depth-0 masters; the derived TV3 fixture is also a master
		// here — masked paths carry one /0 per depth level of the xpub.
		const multisig = makeMultisig({
			keys: [
				keyRow(0, TV1, '3442193e', 'm'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(multisig));
		expect(parsed.extendedPublicKeys[0].bip32Path).toBe('m'); // depth 0 master → no /0 levels
	});

	it('maps script types to Caravan address types', () => {
		expect(JSON.parse(caravanExport(makeMultisig({ scriptType: 'p2sh-p2wsh' }))).addressType).toBe(
			'P2SH-P2WSH'
		);
		expect(JSON.parse(caravanExport(makeMultisig({ scriptType: 'p2sh' }))).addressType).toBe('P2SH');
	});

	it('canonicalizes Zpub keys in the export', () => {
		const multisig = makeMultisig({
			keys: [
				keyRow(0, toZpub(TV1), '3442193e'),
				keyRow(1, TV2, 'deadbeef'),
				keyRow(2, TV3, '01020304')
			]
		});
		const parsed = JSON.parse(caravanExport(multisig));
		expect(parsed.extendedPublicKeys[0].xpub).toBe(TV1);
	});
});

describe('parseCaravanImport', () => {
	it('round-trips Cairn\'s own JSON export back to an identical multisig config', () => {
		const multisig = makeMultisig();
		const imported = parseCaravanImport(caravanExport(multisig));
		expect(imported.name).toBe(multisig.name);
		expect(imported.scriptType).toBe(multisig.scriptType);
		expect(imported.threshold).toBe(multisig.threshold);
		expect(imported.totalKeys).toBe(multisig.keys.length);
		expect(imported.keys).toEqual(
			multisig.keys.map((k) => ({
				name: k.name,
				xpub: k.xpub,
				fingerprint: k.fingerprint,
				path: k.path
			}))
		);
	});

	it('round-trips an unknown-origin key LOSSLESSLY: export masks depth, import restores unknown "m" (cairn-o7zy)', () => {
		// Before the fix, export masked an unknown-origin key to depth-preserving
		// "m/0/0" and import read that literally — silently hardening "unknown"
		// into a concrete (wrong) path. Now the mask is recognized on the way in.
		const multisig = makeMultisig({
			keys: [
				keyRow(0, TV_DEEP, 'aabbccdd', 'm'), // unknown origin, depth-2 xpub
				keyRow(1, TV1, '3442193e', "m/48'/0'/0'/2'"), // real origin, preserved
				keyRow(2, TV2, 'deadbeef') // real origin (BIP-48 default)
			]
		});

		const exported = JSON.parse(caravanExport(multisig));
		// Export masks the unknown key's real depth (2 → "m/0/0") so bare "m"
		// doesn't trip downstream consumers, and leaves real origins untouched.
		expect(exported.extendedPublicKeys[0].bip32Path).toBe('m/0/0');
		expect(exported.extendedPublicKeys[1].bip32Path).toBe("m/48'/0'/0'/2'");

		const imported = parseCaravanImport(caravanExport(multisig));
		// The unknown-origin key comes back as unknown 'm', NOT the literal mask;
		// real origins survive verbatim.
		expect(imported.keys.map((k) => k.path)).toEqual([
			'm',
			"m/48'/0'/0'/2'",
			"m/48'/0'/0'/2'"
		]);
		// Full deep-equal on the load-bearing key fields: name, xpub, fingerprint
		// AND path all round-trip (the fingerprints are the interop-critical bit
		// this bead also names).
		expect(imported.keys).toEqual(
			multisig.keys.map((k) => ({
				name: k.name,
				xpub: k.xpub,
				fingerprint: k.fingerprint,
				path: k.path === '' || k.path === 'm' ? 'm' : k.path
			}))
		);
	});

	it('round-trips a non-zero receive cursor via startingAddressIndex (cairn-u161)', () => {
		const multisig = makeMultisig({ receiveCursor: 50 });
		const json = JSON.parse(caravanExport(multisig));
		expect(json.startingAddressIndex).toBe(50);
		expect(parseCaravanImport(caravanExport(multisig)).startingAddressIndex).toBe(50);
		// A fresh (cursor 0) wallet still exports 0, and an omitted field parses to 0.
		expect(JSON.parse(caravanExport(makeMultisig())).startingAddressIndex).toBe(0);
		const noField = JSON.parse(caravanExport(makeMultisig()));
		delete noField.startingAddressIndex;
		expect(parseCaravanImport(JSON.stringify(noField)).startingAddressIndex).toBe(0);
	});

	it('rejects a duplicate xpub inline with key attribution (cairn-xxjf)', () => {
		const blob = JSON.stringify({
			addressType: 'P2WSH',
			network: 'mainnet',
			quorum: { requiredSigners: 2, totalSigners: 2 },
			extendedPublicKeys: [
				{ name: 'A', xpub: TV1, xfp: '3442193e', bip32Path: BIP48_PATH },
				{ name: 'B', xpub: TV1, xfp: '3442193e', bip32Path: BIP48_PATH }
			]
		});
		expect(() => parseCaravanImport(blob)).toThrow(/Key 2.*distinct/i);
	});

	it('rejects a garbage xpub inline with key attribution (cairn-xxjf)', () => {
		const blob = JSON.stringify({
			addressType: 'P2WSH',
			network: 'mainnet',
			quorum: { requiredSigners: 1, totalSigners: 1 },
			extendedPublicKeys: [{ name: 'A', xpub: 'not-an-xpub', xfp: '3442193e' }]
		});
		expect(() => parseCaravanImport(blob)).toThrow(/Key 1/);
	});

	it('maps Caravan address types to multisig script types', () => {
		// Keys must carry the matching BIP-48 suffix per script type: 2' for
		// p2wsh, 1' for p2sh-p2wsh — a contradicting suffix is rejected on
		// import (cairn-1kc3.1). Bare p2sh has no BIP-48 suffix of its own; 0'
		// is Trezor firmware's accepted extension for it (1' is p2sh-p2wsh's
		// slot and is rejected there — cairn-acft), so these fixtures declare
		// honest paths per script type.
		for (const [addressType, scriptType] of [
			['P2WSH', 'p2wsh'],
			['P2SH-P2WSH', 'p2sh-p2wsh'],
			['P2SH', 'p2sh']
		] as const) {
			const path =
				scriptType === 'p2wsh' ? BIP48_PATH : scriptType === 'p2sh-p2wsh' ? "m/48'/0'/0'/1'" : "m/48'/0'/0'/0'";
			const imported = parseCaravanImport(
				caravanExport(
					makeMultisig({
						scriptType: scriptType as MultisigScriptType,
						keys: [
							keyRow(0, TV1, '3442193e', path),
							keyRow(1, TV2, 'deadbeef', path),
							keyRow(2, TV3, '01020304', path)
						]
					})
				)
			);
			expect(imported.scriptType).toBe(scriptType);
			void addressType;
		}
	});

	// ── Cosigner path acceptance on import (cairn-1kc3.1 / .3 / .5) ─────────

	function blobWithPaths(addressType: string, paths: (string | undefined)[]): string {
		const xpubs = [TV1, TV2, TV3];
		const xfps = ['3442193e', 'deadbeef', '01020304'];
		return JSON.stringify({
			name: 'Pathological',
			addressType,
			network: 'mainnet',
			quorum: { requiredSigners: 2, totalSigners: paths.length },
			extendedPublicKeys: paths.map((bip32Path, i) => ({
				name: `Key ${i + 1}`,
				xpub: xpubs[i],
				xfp: xfps[i],
				...(bip32Path ? { bip32Path } : {})
			}))
		});
	}

	it('rejects a single-sig bip32Path with per-key attribution (cairn-1kc3.3)', () => {
		const blob = blobWithPaths('P2WSH', [BIP48_PATH, "m/84'/0'/0'"]);
		expect(() => parseCaravanImport(blob)).toThrow(MultisigError);
		expect(() => parseCaravanImport(blob)).toThrow(/Key 2/);
		expect(() => parseCaravanImport(blob)).toThrow(/single-sig/);
		// A full receive path is just as rejected.
		expect(() => parseCaravanImport(blobWithPaths('P2WSH', ["m/84'/0'/0'/0/0", BIP48_PATH]))).toThrow(
			/single-sig/
		);
	});

	it("rejects a BIP-48 suffix contradicting the file's addressType (cairn-1kc3.1)", () => {
		// The audit's concrete case: P2WSH file, P2SH-suffix (1') path.
		const blob = blobWithPaths('P2WSH', [BIP48_PATH, "m/48'/0'/0'/1'"]);
		expect(() => parseCaravanImport(blob)).toThrow(/Key 2/);
		expect(() => parseCaravanImport(blob)).toThrow(/p2wsh/);
		// And the mirror image: P2SH file, p2wsh-suffix (2') path.
		expect(() =>
			parseCaravanImport(blobWithPaths('P2SH', ["m/48'/0'/0'/2'", "m/48'/0'/0'/1'"]))
		).toThrow(/Key 1/);
	});

	it("tolerates a legacy-P2SH key's historical 1'-suffix label on import instead of rejecting it (cairn-acft)", () => {
		// Older Cairn HW drivers genuinely derived bare-p2sh keys at the
		// P2SH-P2WSH slot (48'/…/1') — a real bug, fixed for NEW keys only. An
		// existing wallet — and Cairn's own "Download backup" export of it —
		// can legitimately carry that label, so import accepts it (with a
		// warning) rather than dangling "re-export at m/45'" in front of a user
		// for whom that would derive a DIFFERENT, wrong xpub.
		const blob = blobWithPaths('P2SH', ["m/48'/0'/0'/1'", "m/48'/0'/0'/1'"]);
		const imported = parseCaravanImport(blob);
		expect(imported.scriptType).toBe('p2sh');
		expect(imported.keys.map((k) => k.path)).toEqual(["m/48'/0'/0'/1'", "m/48'/0'/0'/1'"]);
		expect(imported.warnings).toHaveLength(2);
		expect(imported.warnings[0]).toMatch(/Key 1/);
		expect(imported.warnings[0]).toMatch(/earlier version of Heartwood/);
	});

	it('rejects a testnet coin type inside a mainnet file (cairn-1kc3.5)', () => {
		const blob = blobWithPaths('P2WSH', ["m/48'/1'/0'/2'", BIP48_PATH]);
		expect(() => parseCaravanImport(blob)).toThrow(/Key 1/);
		expect(() => parseCaravanImport(blob)).toThrow(/coin type 1/);
		expect(() => parseCaravanImport(blob)).toThrow(/mainnet/);
	});

	it("accepts BIP-45 paths and normalizes masked all-zero paths back to unknown 'm' on import (cairn-o7zy)", () => {
		const imported = parseCaravanImport(
			blobWithPaths('P2WSH', ["m/45'", undefined, 'm/0/0/0/0'])
		);
		// 45' is a real origin (kept); an omitted path is unknown 'm'; and
		// Caravan's masked all-zero, all-unhardened "m/0/0/0/0" is recognized as
		// the unknown-origin mask and restored to 'm' rather than read literally
		// as a concrete (wrong) derivation path.
		expect(imported.keys.map((k) => k.path)).toEqual(["m/45'", 'm', 'm']);
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
		const testnet = JSON.parse(caravanExport(makeMultisig()));
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
		expect(() => parseCaravanImport('not json at all')).toThrow(MultisigError);
		const mismatch = JSON.parse(caravanExport(makeMultisig()));
		mismatch.quorum.totalSigners = 5;
		expect(() => parseCaravanImport(JSON.stringify(mismatch))).toThrow(/corrupted/);
		const overThreshold = JSON.parse(caravanExport(makeMultisig()));
		overThreshold.quorum.requiredSigners = 9;
		overThreshold.quorum.totalSigners = 3;
		expect(() => parseCaravanImport(JSON.stringify(overThreshold))).toThrow(/only 3 keys/);
		expect(() =>
			parseCaravanImport(JSON.stringify({ addressType: 'P2TR', quorum: { requiredSigners: 1 }, extendedPublicKeys: [{ xpub: TV1 }] }))
		).toThrow(/address type/i);
	});

	it('rejects an oversized key array up front, before any per-key parsing', () => {
		// Entries are deliberately junk (no xpub): the bound check must fire
		// before the per-key mapping ever looks at them.
		const oversized = JSON.stringify({
			addressType: 'P2WSH',
			network: 'mainnet',
			quorum: { requiredSigners: 2, totalSigners: 5000 },
			extendedPublicKeys: Array.from({ length: 5000 }, () => ({}))
		});
		expect(() => parseCaravanImport(oversized)).toThrow(MultisigError);
		expect(() => parseCaravanImport(oversized)).toThrow(/at most 15/);
		expect(() => parseCaravanImport(oversized)).toThrow(/5000 keys/);

		// Exactly the limit is still allowed through the bound check (it fails
		// later, on the junk keys themselves — proving the bound is not off by one).
		const atLimit = JSON.stringify({
			addressType: 'P2WSH',
			network: 'mainnet',
			quorum: { requiredSigners: 2, totalSigners: 15 },
			extendedPublicKeys: Array.from({ length: 15 }, () => ({}))
		});
		expect(() => parseCaravanImport(atLimit)).toThrow(/has no xpub/);
	});
});

describe('Caravan interop (real caravan-bitcoin golden fixtures)', () => {
	// The mainnet fixture ships with client:{type:"public"} and
	// startingAddressIndex — fields Cairn ignores on import. Nothing in the
	// fixture is modified; both files are byte-for-byte from the Caravan repo.
	const EXPECTED_MAINNET_KEYS = [
		{
			name: 'six',
			xpub: 'xpub6EwJjKaiocGvqSuM2jRZSuQ9HEddiFUFu9RdjE47zG7kXVNDQpJ3GyvskwYiLmvU4SBTNZyv8UH53QcmFEE23YwozE61V3dwzZJEFQr6H2b',
			fingerprint: '00000006',
			path: "m/48'/0'/100'/2'"
		},
		{
			name: 'osw',
			xpub: 'xpub6DcqYQxnbefzFkaRBK63FSE2GzNuNnNhFGw1xV9RioVG7av6r3JDf1aELqBSq5gt5487CtNxvVtaiJjQU2HQWzgG5NzLyTPbYav6otW8qEc',
			fingerprint: 'f57ec65d',
			path: "m/48'/0'/100'/2'"
		}
	];

	/** Build a MultisigRow the way the import wizard would, from a parsed config. */
	function multisigFromImport(imported: ReturnType<typeof parseCaravanImport>): MultisigRow {
		return makeMultisig({
			name: imported.name,
			threshold: imported.threshold,
			scriptType: imported.scriptType,
			keys: imported.keys.map((k, i) => ({
				...keyRow(i, k.xpub, k.fingerprint, k.path),
				name: k.name
			}))
		});
	}

	it('imports the real Caravan mainnet P2WSH export faithfully', () => {
		const imported = parseCaravanImport(JSON.stringify(caravanMainnetFixture));
		expect(imported.name).toBe('P2WSH-M');
		expect(imported.scriptType).toBe('p2wsh');
		expect(imported.threshold).toBe(2);
		expect(imported.totalKeys).toBe(2);
		expect(imported.keys).toEqual(EXPECTED_MAINNET_KEYS);
	});

	it('tolerates Caravan metadata Cairn does not use (uuid, client, ledgerPolicyHmacs, method, startingAddressIndex)', () => {
		const decorated = JSON.parse(JSON.stringify(caravanMainnetFixture));
		decorated.uuid = 'q8w0julw';
		decorated.ledgerPolicyHmacs = [{ xfp: 'f57ec65d', policyHmac: 'ab'.repeat(32) }];
		decorated.extendedPublicKeys = decorated.extendedPublicKeys.map(
			(k: Record<string, unknown>) => ({ ...k, method: 'text' })
		);
		// client + startingAddressIndex are already present in the real fixture.
		expect(decorated.client).toEqual({ type: 'public' });
		expect(decorated.startingAddressIndex).toBe(0);
		expect(parseCaravanImport(JSON.stringify(decorated))).toEqual(
			parseCaravanImport(JSON.stringify(caravanMainnetFixture))
		);
	});

	it('round-trips the Caravan fixture: import → export → import is semantically identical', () => {
		// Byte identity with Caravan's file is not the contract (field order and
		// uuid differ); the parsed multisig config must be identical.
		const imported = parseCaravanImport(JSON.stringify(caravanMainnetFixture));
		const reimported = parseCaravanImport(caravanExport(multisigFromImport(imported)));
		expect(reimported).toEqual(imported);
	});

	it('exports a fixture-derived multisig meeting the studied Caravan import contract', () => {
		const multisig = multisigFromImport(parseCaravanImport(JSON.stringify(caravanMainnetFixture)));
		const parsed = JSON.parse(caravanExport(multisig));

		// Both quorum fields — Caravan's coordinator requires totalSigners.
		expect(parsed.quorum).toEqual({ requiredSigners: 2, totalSigners: 2 });
		// No client field: Caravan's own unknown-client shape fails its re-import.
		expect('client' in parsed).toBe(false);
		// uuid present (Caravan sets it to the descriptor checksum; so do we).
		const receiveDescriptor = multisigToDescriptor(toMultisigConfig(multisig));
		expect(parsed.uuid).toBe(receiveDescriptor.slice(receiveDescriptor.lastIndexOf('#') + 1));
		expect(parsed.network).toBe('mainnet');
		for (const key of parsed.extendedPublicKeys as Record<string, unknown>[]) {
			// No per-key method — unknown values fail Caravan's import.
			expect('method' in key).toBe(false);
			// Canonical xpub prefix (SLIP-132 zpub/ypub rejected by Caravan).
			expect(key.xpub).toMatch(/^xpub/);
			// Apostrophe hardening only — Caravan rejects h-notation.
			expect(key.bip32Path).toMatch(/^m(\/\d+'?)*$/);
			expect(key.bip32Path).not.toMatch(/\d[hH]/);
			// xfp lowercase 8-hex (or Caravan's 00000000 placeholder).
			expect(key.xfp).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	it('rejects the real Caravan testnet fixture with a clear network-mismatch message', () => {
		const raw = JSON.stringify(caravanTestnetFixture);
		expect(() => parseCaravanImport(raw)).toThrow(MultisigError);
		expect(() => parseCaravanImport(raw)).toThrow(/built for testnet/);
		expect(() => parseCaravanImport(raw)).toThrow(/mainnet/);
	});
});

describe('descriptorBackup', () => {
	it('contains both checksummed descriptors and the quorum', () => {
		const multisig = makeMultisig();
		const text = descriptorBackup(multisig);
		expect(text).toContain(multisigToDescriptor(toMultisigConfig(multisig), { chain: 0 }));
		expect(text).toContain(multisigToDescriptor(toMultisigConfig(multisig), { chain: 1 }));
		expect(text).toContain('2-of-3 multisig');
		expect(text).toContain('"Family savings"');
	});
});
