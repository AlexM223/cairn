// The vault-intent decision logic (cairn-fdlf.4/.5): which purpose a declared
// intent derives/reuses, and which keys/registry rows are accepted or rejected
// against it. These are the paths the wizard's `key` and `knownKeys` actions
// stand on — the parts of the collaborative-custody UX that are testable
// without a physical device.

import { describe, it, expect } from 'vitest';
import {
	parseVaultIntent,
	intentPurpose,
	validateKeyForIntent,
	reusableDeviceKeys,
	type ReusableDeviceKey
} from './vaultIntent.server';
import { MultisigError } from '$lib/server/bitcoin/multisig';

describe('parseVaultIntent', () => {
	it('accepts exactly the two declared modes', () => {
		expect(parseVaultIntent('collaborative')).toBe('collaborative');
		expect(parseVaultIntent('personal')).toBe('personal');
	});

	it('treats everything else as undeclared, never a guess', () => {
		expect(parseVaultIntent('')).toBeNull();
		expect(parseVaultIntent(null)).toBeNull();
		expect(parseVaultIntent(undefined)).toBeNull();
		expect(parseVaultIntent('COLLABORATIVE')).toBeNull();
		expect(parseVaultIntent('shared')).toBeNull();
		expect(parseVaultIntent(45)).toBeNull();
	});
});

describe('intentPurpose', () => {
	it("maps collaborative → '45' and personal → '48'", () => {
		expect(intentPurpose('collaborative')).toBe('45');
		expect(intentPurpose('personal')).toBe('48');
	});
});

describe('validateKeyForIntent', () => {
	const label = 'Test key';

	// --- collaborative intent: purpose MUST be 45' ---

	it("collaborative accepts m/45' (and deeper BIP-45 paths)", () => {
		expect(() => validateKeyForIntent("m/45'", 'p2wsh', 'collaborative', label)).not.toThrow();
		expect(() => validateKeyForIntent("m/45'/0", 'p2wsh', 'collaborative', label)).not.toThrow();
	});

	it("collaborative accepts m/45' regardless of the vault's script type (no script-type subfield)", () => {
		expect(() =>
			validateKeyForIntent("m/45'", 'p2sh-p2wsh', 'collaborative', label)
		).not.toThrow();
		expect(() => validateKeyForIntent("m/45'", 'p2sh', 'collaborative', label)).not.toThrow();
	});

	it('collaborative rejects a BIP-48 key with the re-export guidance', () => {
		expect(() =>
			validateKeyForIntent("m/48'/0'/0'/2'", 'p2wsh', 'collaborative', label)
		).toThrow(/m\/45'/);
		try {
			validateKeyForIntent("m/48'/0'/0'/2'", 'p2wsh', 'collaborative', label);
			expect.unreachable('should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(MultisigError);
			const msg = (e as Error).message;
			expect(msg).toContain(label);
			expect(msg).toMatch(/Electrum/);
			expect(msg).toMatch(/Sparrow/);
		}
	});

	it('collaborative rejects an unknown-origin key, steering to the full paste form', () => {
		// createMultisig (cairn-1kc3.6) hard-rejects unknown-origin keys in a
		// collaborative vault at creation — rejecting here at ADD time, with the
		// [fingerprint/45']xpub steer, is what keeps that from being a dead end.
		for (const path of ['m', '', 'm/0/0/0/0']) {
			expect(() => validateKeyForIntent(path, 'p2wsh', 'collaborative', label)).toThrow(
				/\[fingerprint\/45'\]xpub/
			);
		}
	});

	// --- personal intent: purpose 45' rejected, today's behavior otherwise ---

	it("personal accepts the wallet's matching BIP-48 path", () => {
		expect(() => validateKeyForIntent("m/48'/0'/0'/2'", 'p2wsh', 'personal', label)).not.toThrow();
		expect(() =>
			validateKeyForIntent("m/48'/0'/0'/1'", 'p2sh-p2wsh', 'personal', label)
		).not.toThrow();
	});

	it('personal keeps unknown-origin keys permissive (today\'s behavior)', () => {
		expect(() => validateKeyForIntent('m', 'p2wsh', 'personal', label)).not.toThrow();
		expect(() => validateKeyForIntent('', 'p2wsh', 'personal', label)).not.toThrow();
	});

	it("personal rejects m/45' — that marks a key as shared", () => {
		expect(() => validateKeyForIntent("m/45'", 'p2wsh', 'personal', label)).toThrow(
			/collaborative custody/
		);
	});

	// --- universal rules run first, for every intent (incl. undeclared) ---

	it('single-sig purposes are hard-rejected regardless of intent', () => {
		for (const intent of ['collaborative', 'personal', null] as const) {
			for (const path of ["m/44'/0'/0'", "m/49'/0'/0'", "m/84'/0'/0'", "m/86'/0'/0'"]) {
				expect(() => validateKeyForIntent(path, 'p2wsh', intent, label)).toThrow(MultisigError);
			}
		}
	});

	it('the BIP-48 script-type-suffix check still applies under personal intent', () => {
		// …/2' is the p2wsh suffix; a p2sh-p2wsh wallet needs …/1'.
		expect(() =>
			validateKeyForIntent("m/48'/0'/0'/2'", 'p2sh-p2wsh', 'personal', label)
		).toThrow(/script type/);
	});

	it('undeclared intent applies only the universal checks', () => {
		expect(() => validateKeyForIntent("m/45'", 'p2wsh', null, label)).not.toThrow();
		expect(() => validateKeyForIntent("m/48'/0'/0'/2'", 'p2wsh', null, label)).not.toThrow();
		expect(() => validateKeyForIntent('m', 'p2wsh', null, label)).not.toThrow();
	});
});

describe('reusableDeviceKeys', () => {
	const XPUB =
		'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';

	const row = (over: Partial<ReusableDeviceKey>): ReusableDeviceKey => ({
		fingerprint: 'a1b2c3d4',
		purpose: '45',
		xpub: XPUB,
		path: "m/45'",
		deviceType: 'trezor',
		...over
	});

	it("collaborative reuse offers only '45' rows", () => {
		const rows = [
			row({ fingerprint: '11111111', purpose: '45', path: "m/45'" }),
			row({ fingerprint: '22222222', purpose: '48', path: "m/48'/0'/0'/2'" })
		];
		expect(reusableDeviceKeys(rows, 'p2wsh', 'collaborative').map((r) => r.fingerprint)).toEqual([
			'11111111'
		]);
	});

	it("personal reuse offers only '48' rows whose path matches the wallet's script type", () => {
		const rows = [
			row({ fingerprint: '11111111', purpose: '48', path: "m/48'/0'/0'/2'" }), // p2wsh suffix
			row({ fingerprint: '22222222', purpose: '48', path: "m/48'/0'/0'/1'" }), // p2sh(-p2wsh) suffix
			row({ fingerprint: '33333333', purpose: '45', path: "m/45'" })
		];
		expect(reusableDeviceKeys(rows, 'p2wsh', 'personal').map((r) => r.fingerprint)).toEqual([
			'11111111'
		]);
		expect(reusableDeviceKeys(rows, 'p2sh-p2wsh', 'personal').map((r) => r.fingerprint)).toEqual([
			'22222222'
		]);
	});

	it("a '45' row is reusable in a collaborative vault of any script type", () => {
		const rows = [row({})];
		for (const st of ['p2wsh', 'p2sh-p2wsh', 'p2sh'] as const) {
			expect(reusableDeviceKeys(rows, st, 'collaborative')).toHaveLength(1);
		}
	});

	it('a row with a corrupt path is silently skipped, never offered', () => {
		const rows = [row({ path: 'not-a-path' }), row({ fingerprint: '55555555' })];
		expect(
			reusableDeviceKeys(rows, 'p2wsh', 'collaborative').map((r) => r.fingerprint)
		).toEqual(['55555555']);
	});
});
