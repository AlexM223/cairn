import { describe, it, expect } from 'vitest';
import { accountFromPath } from './keyHealth';

// The device health check (KeyHealthRow) re-reads a Trezor/Ledger key at
// m/48'/0'/{account}'/{script}'. accountFromPath decides which account — and,
// critically, returns null (route to the manual check) instead of guessing
// account 0 for any path the re-read could not faithfully reproduce.
describe('accountFromPath', () => {
	it('extracts the account from standard BIP-48 paths', () => {
		expect(accountFromPath("m/48'/0'/0'/2'", 'p2wsh')).toBe(0);
		expect(accountFromPath("m/48'/0'/3'/2'", 'p2wsh')).toBe(3);
		expect(accountFromPath("m/48'/0'/7'/1'", 'p2sh-p2wsh')).toBe(7);
		expect(accountFromPath("m/48'/0'/12'/1'", 'p2sh')).toBe(12);
	});

	it('accepts h/H/curly-quote hardening markers and surrounding whitespace', () => {
		expect(accountFromPath('m/48h/0h/5h/2h', 'p2wsh')).toBe(5);
		expect(accountFromPath('m/48H/0H/2H/2H', 'p2wsh')).toBe(2);
		expect(accountFromPath('m/48’/0’/1’/2’', 'p2wsh')).toBe(1);
		expect(accountFromPath("  m/48'/0'/4'/2'  ", 'p2wsh')).toBe(4);
	});

	it('returns null (never a silent 0) for non-standard paths', () => {
		expect(accountFromPath('m', 'p2wsh')).toBeNull();
		expect(accountFromPath('', 'p2wsh')).toBeNull();
		expect(accountFromPath("m/45'", 'p2sh')).toBeNull(); // BIP-45 style
		expect(accountFromPath("m/84'/0'/0'", 'p2wsh')).toBeNull(); // singlesig purpose
		expect(accountFromPath("m/48'/1'/0'/2'", 'p2wsh')).toBeNull(); // testnet coin
		expect(accountFromPath("m/48'/0'/0'", 'p2wsh')).toBeNull(); // missing script level
		expect(accountFromPath("m/48'/0'/0'/2'/0", 'p2wsh')).toBeNull(); // extra depth
		expect(accountFromPath("m/48'/0'/0'/2", 'p2wsh')).toBeNull(); // unhardened script
		expect(accountFromPath("m/48'/0'/0/2'", 'p2wsh')).toBeNull(); // unhardened account
		expect(accountFromPath("m/48'/0'/0'/3'", 'p2wsh')).toBeNull(); // unknown script suffix
	});

	it('returns null when the script suffix does not match the wallet script type', () => {
		// The re-read derives 2' for p2wsh and 1' for both p2sh forms; a stored
		// path with the other suffix would be probed at the wrong derivation.
		expect(accountFromPath("m/48'/0'/0'/1'", 'p2wsh')).toBeNull();
		expect(accountFromPath("m/48'/0'/0'/2'", 'p2sh-p2wsh')).toBeNull();
		expect(accountFromPath("m/48'/0'/0'/2'", 'p2sh')).toBeNull();
	});

	it('rejects account indexes outside the hardened-index range', () => {
		expect(accountFromPath("m/48'/0'/2147483647'/2'", 'p2wsh')).toBe(2147483647);
		expect(accountFromPath("m/48'/0'/2147483648'/2'", 'p2wsh')).toBeNull(); // 2^31
		expect(accountFromPath("m/48'/0'/99999999999999999999'/2'", 'p2wsh')).toBeNull();
	});
});
