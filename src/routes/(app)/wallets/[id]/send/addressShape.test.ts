import { describe, it, expect } from 'vitest';
import { classifyRecipientAddress, looksLikeAddress } from './addressShape';

describe('classifyRecipientAddress', () => {
	it('classifies mainnet bech32 / bech32m (bc1...)', () => {
		expect(classifyRecipientAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(
			'mainnet'
		);
		// taproot bech32m
		expect(
			classifyRecipientAddress(
				'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
			)
		).toBe('mainnet');
	});

	it('classifies mainnet legacy P2PKH (1...) and P2SH (3...)', () => {
		expect(classifyRecipientAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('mainnet');
		expect(classifyRecipientAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('mainnet');
	});

	it('classifies testnet/signet bech32 (tb1...) as testnet', () => {
		expect(classifyRecipientAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(
			'testnet'
		);
	});

	it('classifies regtest bech32 (bcrt1...) as testnet', () => {
		expect(classifyRecipientAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBe(
			'testnet'
		);
	});

	it('classifies legacy testnet P2PKH (m/n) and P2SH (2) as testnet', () => {
		expect(classifyRecipientAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe('testnet');
		expect(classifyRecipientAddress('n2ZNV88uQbede7C5M5jzi6SyG4GVuPpng6')).toBe('testnet');
		expect(classifyRecipientAddress('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc')).toBe('testnet');
	});

	it('classifies empty / whitespace as empty', () => {
		expect(classifyRecipientAddress('')).toBe('empty');
		expect(classifyRecipientAddress('   ')).toBe('empty');
	});

	it('classifies random garbage as unknown', () => {
		expect(classifyRecipientAddress('hello world')).toBe('unknown');
		expect(classifyRecipientAddress('0x1234abcd')).toBe('unknown');
		expect(classifyRecipientAddress('not-an-address')).toBe('unknown');
		// too short to be a plausible legacy testnet address
		expect(classifyRecipientAddress('m123')).toBe('unknown');
	});

	it('looksLikeAddress stays true only for mainnet', () => {
		expect(looksLikeAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
		expect(looksLikeAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
		expect(looksLikeAddress('garbage')).toBe(false);
	});
});
