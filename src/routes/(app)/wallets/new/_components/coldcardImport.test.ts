import { describe, it, expect } from 'vitest';
import { parseColdcardSingleSigExport } from './coldcardImport';

// A realistic ColdCard "Generic JSON" single-sig export, matching the shape
// produced by firmware's generate_generic_export (shared/export.py): top-level
// chain/xfp/account/xpub, plus a bip44/bip49/bip84 section each carrying its own
// name/xfp/deriv/xpub (and, for segwit types, a SLIP-132 _pub we deliberately
// ignore in favour of the classic xpub). Public test keys only.
const EXPORT = JSON.stringify({
	chain: 'BTC',
	xfp: '0F056943',
	account: 0,
	xpub: 'xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga',
	bip44: {
		name: 'p2pkh',
		xfp: '76A4A3E9',
		deriv: 'm/44h/0h/0h',
		xpub: 'xpub6C44P1ZReKN4qyTaSp82Jj7ZxvUwbTC5jz1TijXvUCkC5EU1YrqZzXNKRUKms2fXCcz3ZLuUwFGKdvC9EQ8Y4WxTr6RXwT2m2QzVTb9J6M',
		desc: 'pkh([76a4a3e9/44h/0h/0h]xpub…)',
		first: '1abc…'
	},
	bip49: {
		name: 'p2sh-p2wpkh',
		xfp: '76A4A3E9',
		deriv: 'm/49h/0h/0h',
		xpub: 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V',
		_pub: 'ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP',
		desc: 'sh(wpkh([76a4a3e9/49h/0h/0h]xpub…))',
		first: '3abc…'
	},
	bip84: {
		name: 'p2wpkh',
		xfp: '76A4A3E9',
		deriv: 'm/84h/0h/0h',
		xpub: 'xpub6BiVtCpG9fQPxnPmHXG8PhtzQdWC2Su4qWu6XW9tpWFYhxydCLJGrWBJZ5H6qTAHdPQ7pQhtpjiYZVZARo14qHiay2fvrX996ZMGKgBezh6',
		_pub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
		desc: 'wpkh([76a4a3e9/84h/0h/0h]xpub…)',
		first: 'bc1abc…'
	}
});

describe('parseColdcardSingleSigExport', () => {
	it('reads the native-segwit (bip84) key for p2wpkh, preferring classic xpub', () => {
		const key = parseColdcardSingleSigExport(EXPORT, 'p2wpkh');
		expect(key.xpub).toBe(
			'xpub6BiVtCpG9fQPxnPmHXG8PhtzQdWC2Su4qWu6XW9tpWFYhxydCLJGrWBJZ5H6qTAHdPQ7pQhtpjiYZVZARo14qHiay2fvrX996ZMGKgBezh6'
		);
		// section xfp, lowercased
		expect(key.fingerprint).toBe('76a4a3e9');
		// `h` hardened markers normalized to apostrophes
		expect(key.path).toBe("m/84'/0'/0'");
	});

	it('reads the nested-segwit (bip49) key for p2sh-p2wpkh', () => {
		const key = parseColdcardSingleSigExport(EXPORT, 'p2sh-p2wpkh');
		expect(key.xpub.startsWith('xpub')).toBe(true);
		expect(key.path).toBe("m/49'/0'/0'");
	});

	it('reads the legacy (bip44) key for p2pkh', () => {
		const key = parseColdcardSingleSigExport(EXPORT, 'p2pkh');
		expect(key.path).toBe("m/44'/0'/0'");
		expect(key.fingerprint).toBe('76a4a3e9');
	});

	it('falls back to the top-level xfp when the section has none', () => {
		const noSectionFp = JSON.stringify({
			xfp: '0F056943',
			bip84: {
				deriv: 'm/84h/0h/0h',
				xpub: 'xpub6BiVtCpG9fQPxnPmHXG8PhtzQdWC2Su4qWu6XW9tpWFYhxydCLJGrWBJZ5H6qTAHdPQ7pQhtpjiYZVZARo14qHiay2fvrX996ZMGKgBezh6'
			}
		});
		const key = parseColdcardSingleSigExport(noSectionFp, 'p2wpkh');
		expect(key.fingerprint).toBe('0f056943');
	});

	it('uses the 00000000 placeholder when no valid fingerprint is present', () => {
		const noFp = JSON.stringify({
			bip84: {
				xpub: 'xpub6BiVtCpG9fQPxnPmHXG8PhtzQdWC2Su4qWu6XW9tpWFYhxydCLJGrWBJZ5H6qTAHdPQ7pQhtpjiYZVZARo14qHiay2fvrX996ZMGKgBezh6'
			}
		});
		const key = parseColdcardSingleSigExport(noFp, 'p2wpkh');
		expect(key.fingerprint).toBe('00000000');
		// no deriv → default path for the script type
		expect(key.path).toBe("m/84'/0'/0'");
	});

	it('throws a clear taproot-specific error when bip86 is absent', () => {
		expect(() => parseColdcardSingleSigExport(EXPORT, 'p2tr')).toThrow(/Taproot/);
	});

	it('throws for the requested section being missing', () => {
		const onlyBip44 = JSON.stringify({ xfp: '0F056943', bip44: { xpub: 'xpub…' } });
		expect(() => parseColdcardSingleSigExport(onlyBip44, 'p2wpkh')).toThrow(/Native SegWit/);
	});

	it('rejects non-JSON input', () => {
		expect(() => parseColdcardSingleSigExport('not json', 'p2wpkh')).toThrow();
	});
});
