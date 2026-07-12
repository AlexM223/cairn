import { describe, it, expect } from 'vitest';
import { detectMultisigConfig } from './multisigDetect';

// A realistic Caravan-style wallet config export (2-of-2), public test keys only.
const CARAVAN_JSON = JSON.stringify({
	name: 'P2WSH-M',
	addressType: 'P2WSH',
	network: 'mainnet',
	client: { type: 'public' },
	quorum: { requiredSigners: 2, totalSigners: 2 },
	extendedPublicKeys: [
		{
			name: 'six',
			bip32Path: "m/48'/0'/100'/2'",
			xpub: 'xpub6EwJjKaiocGvqSuM2jRZSuQ9HEddiFUFu9RdjE47zG7kXVNDQpJ3GyvskwYiLmvU4SBTNZyv8UH53QcmFEE23YwozE61V3dwzZJEFQr6H2b',
			xfp: '00000006'
		},
		{
			name: 'osw',
			bip32Path: "m/48'/0'/100'/2'",
			xpub: 'xpub6DcqYQxnbefzFkaRBK63FSE2GzNuNnNhFGw1xV9RioVG7av6r3JDf1aELqBSq5gt5487CtNxvVtaiJjQU2HQWzgG5NzLyTPbYav6otW8qEc',
			xfp: 'f57ec65d'
		}
	],
	startingAddressIndex: 0
});

describe('detectMultisigConfig', () => {
	it('detects a Caravan-style 2-of-2 JSON config', () => {
		expect(detectMultisigConfig(CARAVAN_JSON)).toEqual({ isMultisig: true, m: 2, n: 2 });
	});

	it('detects a wsh(sortedmulti(...)) descriptor', () => {
		const desc =
			"wsh(sortedmulti(2,[00000006/48'/0'/100'/2']xpub6EwJj.../0/*,[f57ec65d/48'/0'/100'/2']xpub6Dcq.../0/*))";
		expect(detectMultisigConfig(desc)).toEqual({ isMultisig: true, m: 2 });
	});

	it('detects "Policy: 2 of 3" plain text', () => {
		expect(detectMultisigConfig('Policy: 2 of 3\nDerivation: ...')).toEqual({
			isMultisig: true,
			m: 2,
			n: 3
		});
	});

	it('does not flag a single-sig cairn-wallet-config backup', () => {
		const backup = JSON.stringify({
			format: 'cairn-wallet-config',
			type: 'single-sig',
			xpub: 'xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga',
			name: 'My wallet'
		});
		expect(detectMultisigConfig(backup)).toEqual({ isMultisig: false });
	});

	it('does not flag garbage text', () => {
		expect(detectMultisigConfig('not a wallet config at all, just some notes')).toEqual({
			isMultisig: false
		});
	});

	it('does not flag empty input', () => {
		expect(detectMultisigConfig('')).toEqual({ isMultisig: false });
		expect(detectMultisigConfig('   ')).toEqual({ isMultisig: false });
	});

	// Finding 11 (test-units): multisigDetect.ts:11 `const t = text.trim()`.
	// String.prototype.trim() DOES strip a leading U+FEFF BOM, so a BOM-prefixed
	// Caravan export still detects correctly AND JSON.parse succeeds (a raw
	// JSON.parse('﻿{}') throws — the trim is load-bearing here). Hardware/OS
	// exporters routinely prepend a UTF-8 BOM. Regression-locked: if `.trim()`
	// is ever swapped for a custom trimmer that misses BOM, this test catches it.
	it('detects a BOM-prefixed Caravan JSON export (regression lock on trim() stripping U+FEFF)', () => {
		expect(detectMultisigConfig('﻿' + CARAVAN_JSON)).toEqual({ isMultisig: true, m: 2, n: 2 });
	});

	it('still detects a descriptor after leading newlines/tabs', () => {
		const desc =
			"wsh(sortedmulti(2,[00000006/48'/0'/100'/2']xpub6EwJj.../0/*,[f57ec65d/48'/0'/100'/2']xpub6Dcq.../0/*))";
		expect(detectMultisigConfig('\n\t' + desc)).toEqual({ isMultisig: true, m: 2 });
	});

	// Finding 12 (test-units): multisigDetect.ts:9 promises to never throw. A
	// corrupt/partial upload that starts with '{' but fails to parse must
	// degrade to {isMultisig:false} via the catch, not throw.
	it('does not throw on truncated JSON that starts with "{", and reports not-multisig', () => {
		expect(() => detectMultisigConfig('{"quorum":{"requiredSigners":2')).not.toThrow();
		expect(detectMultisigConfig('{"quorum":{"requiredSigners":2')).toEqual({ isMultisig: false });
	});

	// Finding 13 (test-units): non-integer signer counts (Number('two') -> NaN)
	// must surface as `m: undefined`, not a NaN leaking into the payload.
	it('reports m: undefined (not NaN) for a non-integer requiredSigners', () => {
		const cfg = JSON.stringify({ quorum: { requiredSigners: 'two', totalSigners: 3 } });
		expect(detectMultisigConfig(cfg)).toEqual({ isMultisig: true, m: undefined, n: 3 });
	});

	// Finding 14 (test-units): detection purely via the `format` field. Pins
	// CURRENT behavior only — the `o.format !== 'string'` clause (multisigDetect.ts:24)
	// reads like a typo (compares the format VALUE to the literal word "string")
	// and is a decision-gated investigation (Wave 8), not something this test-only
	// wave may change.
	it('flags a JSON config as multisig purely from an unrecognized format field', () => {
		expect(detectMultisigConfig(JSON.stringify({ format: 'caravan' }))).toEqual({ isMultisig: true });
	});

	// Finding 15 (test-units, test-only half): no size cap exists today
	// (client-side UX code) — a multi-MB paste must still resolve without
	// throwing rather than locking up or crashing the tab.
	it('does not throw on a huge (~2MB) non-JSON blob', () => {
		const huge = 'not a wallet config, just filler. '.repeat(60_000); // ~2.1MB
		expect(() => detectMultisigConfig(huge)).not.toThrow();
		expect(detectMultisigConfig(huge)).toEqual({ isMultisig: false });
	});

	it('does not throw on a huge (~2MB) JSON blob', () => {
		const huge = JSON.stringify({
			type: 'single-sig',
			notes: 'x'.repeat(2_000_000)
		});
		expect(() => detectMultisigConfig(huge)).not.toThrow();
	});

	// Finding 16 (test-units): documents heuristic precedence and known
	// over-match behavior — lower priority, test-only (no source change).
	describe('heuristic precedence + over-match (documents current behavior)', () => {
		it('a text containing both sortedmulti(...) and a Policy line resolves via the sortedmulti branch first (no n)', () => {
			const mixed = 'sortedmulti(2,[abc]xpub1,[def]xpub2)\nPolicy: 2 of 3';
			expect(detectMultisigConfig(mixed)).toEqual({ isMultisig: true, m: 2 });
		});

		it('prose containing "multi(" false-positives as multisig with m: undefined', () => {
			expect(detectMultisigConfig('I like multi(sig) wallets')).toEqual({
				isMultisig: true,
				m: undefined
			});
		});

		it('detects sortedmulti with internal spacing around the count', () => {
			const desc =
				"wsh(sortedmulti( 2 , [00000006/48'/0'/100'/2']xpub6EwJj.../0/*, [f57ec65d/48'/0'/100'/2']xpub6Dcq.../0/*))";
			expect(detectMultisigConfig(desc)).toEqual({ isMultisig: true, m: 2 });
		});
	});
});
