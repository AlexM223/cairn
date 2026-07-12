import { describe, it, expect } from 'vitest';
import { resolveScanFill } from './scanFill';

const BECH32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

describe('resolveScanFill — address only (no amount involved)', () => {
	it('resolves a bare address with amountSats null', () => {
		expect(resolveScanFill(BECH32, '')).toEqual({ address: BECH32, amountSats: null });
	});

	it('resolves a BIP21 URI with no amount= param with amountSats null', () => {
		expect(resolveScanFill(`bitcoin:${BECH32}?label=Coffee`, '')).toEqual({
			address: BECH32,
			amountSats: null
		});
	});

	it('returns null for junk / unrecognized text', () => {
		expect(resolveScanFill('not an address', '')).toBeNull();
		expect(resolveScanFill('', '')).toBeNull();
	});
});

describe('resolveScanFill — amount prefill never clobbers a typed amount', () => {
	it('prefills amountSats when the URI carries an amount AND the row is empty', () => {
		expect(resolveScanFill(`bitcoin:${BECH32}?amount=0.0001`, '')).toEqual({
			address: BECH32,
			amountSats: 10_000
		});
	});

	it('prefills when the current amount text is only whitespace', () => {
		expect(resolveScanFill(`bitcoin:${BECH32}?amount=0.0001`, '   ')).toEqual({
			address: BECH32,
			amountSats: 10_000
		});
	});

	it('does NOT prefill when the row already has user-typed amount text — address still fills', () => {
		expect(resolveScanFill(`bitcoin:${BECH32}?amount=0.0001`, '0.5')).toEqual({
			address: BECH32,
			amountSats: null
		});
	});

	it('ignores a zero amount= (never meaningful to prefill)', () => {
		expect(resolveScanFill(`bitcoin:${BECH32}?amount=0`, '')).toEqual({
			address: BECH32,
			amountSats: null
		});
	});
});
