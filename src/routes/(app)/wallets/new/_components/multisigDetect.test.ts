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
});
