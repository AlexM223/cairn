import { describe, it, expect } from 'vitest';
import { parseBip21 } from './bip21';

// BIP173 test-vector bech32 address, same one bbqr.test.ts uses as RECIPIENT —
// keeps fixtures consistent across the codebase.
const BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BECH32_UPPER = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4';
const LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

describe('parseBip21 — bare address (non-URI)', () => {
	it('accepts a plain bech32 address with no scheme', () => {
		expect(parseBip21(BECH32)).toEqual({ address: BECH32 });
	});

	it('accepts an all-uppercase bech32 address (QR alphanumeric-mode form)', () => {
		expect(parseBip21(BECH32_UPPER)).toEqual({ address: BECH32_UPPER });
	});

	it('accepts a legacy base58 address', () => {
		expect(parseBip21(LEGACY)).toEqual({ address: LEGACY });
	});

	it('trims surrounding whitespace', () => {
		expect(parseBip21(`  ${BECH32}  `)).toEqual({ address: BECH32 });
	});
});

describe('parseBip21 — bitcoin: URI', () => {
	it('parses a bare bitcoin: URI with no query', () => {
		expect(parseBip21(`bitcoin:${BECH32}`)).toEqual({ address: BECH32 });
	});

	it('parses amount, converting decimal BTC to integer satoshis', () => {
		expect(parseBip21(`bitcoin:${BECH32}?amount=0.0001`)).toEqual({
			address: BECH32,
			amountSats: 10_000
		});
		expect(parseBip21(`bitcoin:${BECH32}?amount=1`)).toEqual({
			address: BECH32,
			amountSats: 100_000_000
		});
		expect(parseBip21(`bitcoin:${BECH32}?amount=0.00000001`)).toEqual({
			address: BECH32,
			amountSats: 1
		});
	});

	it('parses label and message, decoding percent-encoding and +-as-space', () => {
		expect(parseBip21(`bitcoin:${BECH32}?label=Coffee+Shop&message=Thanks%21`)).toEqual({
			address: BECH32,
			label: 'Coffee Shop',
			message: 'Thanks!'
		});
	});

	it('parses amount + label + message together', () => {
		expect(
			parseBip21(`bitcoin:${BECH32}?amount=0.5&label=Alice&message=Invoice%20142`)
		).toEqual({
			address: BECH32,
			amountSats: 50_000_000,
			label: 'Alice',
			message: 'Invoice 142'
		});
	});

	it('ignores pj= (payjoin) and r= (BIP70) params entirely', () => {
		const uri = `bitcoin:${BECH32}?amount=0.001&pj=https://example.com/pj&r=https://example.com/req`;
		const result = parseBip21(uri);
		expect(result).toEqual({ address: BECH32, amountSats: 100_000 });
		expect(Object.keys(result!).sort()).toEqual(['address', 'amountSats']);
	});

	it('omits amountSats (but keeps the address) when precision exceeds a satoshi', () => {
		expect(parseBip21(`bitcoin:${BECH32}?amount=0.123456789`)).toEqual({ address: BECH32 });
	});

	it('omits amountSats when the amount is not a plain decimal', () => {
		expect(parseBip21(`bitcoin:${BECH32}?amount=not-a-number`)).toEqual({ address: BECH32 });
		expect(parseBip21(`bitcoin:${BECH32}?amount=-1`)).toEqual({ address: BECH32 });
	});
});

describe('parseBip21 — uppercase (QR alphanumeric-mode) URIs', () => {
	it('parses an all-uppercase scheme + address', () => {
		expect(parseBip21(`BITCOIN:${BECH32_UPPER}`)).toEqual({ address: BECH32_UPPER });
	});

	it('parses an all-uppercase URI including uppercase param KEYS', () => {
		expect(parseBip21(`BITCOIN:${BECH32_UPPER}?AMOUNT=0.5&LABEL=COFFEE`)).toEqual({
			address: BECH32_UPPER,
			amountSats: 50_000_000,
			label: 'COFFEE'
		});
	});

	it('accepts mixed-case bitcoin: scheme', () => {
		expect(parseBip21(`Bitcoin:${BECH32}`)).toEqual({ address: BECH32 });
	});
});

describe('parseBip21 — invalid input → null', () => {
	it('rejects empty / whitespace-only input', () => {
		expect(parseBip21('')).toBeNull();
		expect(parseBip21('   ')).toBeNull();
	});

	it('rejects an unrelated string', () => {
		expect(parseBip21('hello world')).toBeNull();
	});

	it('rejects a non-bitcoin URI scheme', () => {
		expect(parseBip21('ethereum:0xdeadbeef000000000000000000000000deadbeef')).toBeNull();
	});

	it('rejects a bitcoin: URI with an empty address', () => {
		expect(parseBip21('bitcoin:')).toBeNull();
		expect(parseBip21('bitcoin:?amount=0.1')).toBeNull();
	});

	it('rejects a bitcoin: URI whose address does not look like an address', () => {
		expect(parseBip21('bitcoin:not-an-address')).toBeNull();
	});

	it('rejects malformed percent-encoding without throwing', () => {
		expect(() => parseBip21('bitcoin:%')).not.toThrow();
		expect(parseBip21('bitcoin:%')).toBeNull();
	});
});
