import { describe, it, expect, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	isWebHidAvailable,
	isBitbox02Available,
	singleSigAccountPath,
	multisigAccountPath,
	normalizeXpub,
	bitbox02SupportsScriptType,
	bitbox02SupportsMultisigScriptType,
	buildSimpleScriptConfig,
	buildMultisigScriptConfig,
	bitboxKeyIdentityMatches,
	toBitbox02Error,
	Bitbox02Error,
	type MultisigSignKey
} from './bitbox02';

const b58check = createBase58check(sha256);

// A deterministic account xpub (BIP-84-ish account node from a fixed seed).
const ACCOUNT = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'");
const XPUB = ACCOUNT.publicExtendedKey;

/** Re-encode a standard xpub under a SLIP-132 version prefix (for normalize tests). */
function withVersion(xpub: string, version: number): string {
	const raw = b58check.decode(xpub);
	const out = new Uint8Array(raw);
	out[0] = (version >>> 24) & 0xff;
	out[1] = (version >>> 16) & 0xff;
	out[2] = (version >>> 8) & 0xff;
	out[3] = version & 0xff;
	return b58check.encode(out);
}

describe('isWebHidAvailable', () => {
	it('is false in a Node/SSR environment with no navigator.hid', () => {
		expect(isWebHidAvailable()).toBe(false);
	});
});

describe('isBitbox02Available', () => {
	it('is false in a Node/SSR environment with no window', () => {
		expect(isBitbox02Available()).toBe(false);
	});

	it('is true in any browser (window present), even without WebHID — the BitBoxBridge path remains', () => {
		vi.stubGlobal('window', {});
		try {
			expect(isBitbox02Available()).toBe(true);
			expect(isWebHidAvailable()).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('bitbox02SupportsScriptType (single-sig)', () => {
	it('supports SegWit and Taproot but NOT legacy p2pkh (BIP-44)', () => {
		expect(bitbox02SupportsScriptType('p2pkh')).toBe(false);
		expect(bitbox02SupportsScriptType('p2sh-p2wpkh')).toBe(true);
		expect(bitbox02SupportsScriptType('p2wpkh')).toBe(true);
		expect(bitbox02SupportsScriptType('p2tr')).toBe(true);
	});
});

describe('singleSigAccountPath', () => {
	it('maps each supported script type to its BIP-49/84/86 account path', () => {
		expect(singleSigAccountPath('p2sh-p2wpkh')).toBe("m/49'/0'/0'");
		expect(singleSigAccountPath('p2wpkh')).toBe("m/84'/0'/0'");
		expect(singleSigAccountPath('p2tr')).toBe("m/86'/0'/0'");
	});

	it('honours a non-default account index', () => {
		expect(singleSigAccountPath('p2wpkh', 3)).toBe("m/84'/0'/3'");
	});

	it('rejects legacy p2pkh with unsupported_script_type', () => {
		try {
			singleSigAccountPath('p2pkh');
			expect.unreachable('expected a rejection');
		} catch (e) {
			expect(e).toBeInstanceOf(Bitbox02Error);
			expect((e as Bitbox02Error).code).toBe('unsupported_script_type');
		}
	});

	it('rejects a bogus account index', () => {
		expect(() => singleSigAccountPath('p2wpkh', -1)).toThrow(Bitbox02Error);
		expect(() => singleSigAccountPath('p2wpkh', 1.5)).toThrow(Bitbox02Error);
	});
});

describe('bitbox02SupportsMultisigScriptType', () => {
	it('supports p2wsh and p2sh-p2wsh but NOT plain p2sh', () => {
		expect(bitbox02SupportsMultisigScriptType('p2wsh')).toBe(true);
		expect(bitbox02SupportsMultisigScriptType('p2sh-p2wsh')).toBe(true);
		expect(bitbox02SupportsMultisigScriptType('p2sh')).toBe(false);
	});
});

describe('multisigAccountPath (BitBox02)', () => {
	it("maps p2wsh to the BIP-48 2' suffix and p2sh-p2wsh to 1'", () => {
		expect(multisigAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");
		expect(multisigAccountPath('p2sh-p2wsh')).toBe("m/48'/0'/0'/1'");
	});

	it('honours a non-default account index', () => {
		expect(multisigAccountPath('p2wsh', 5)).toBe("m/48'/0'/5'/2'");
	});

	it('rejects plain p2sh multisig with unsupported_script_type', () => {
		try {
			multisigAccountPath('p2sh');
			expect.unreachable('expected a rejection');
		} catch (e) {
			expect(e).toBeInstanceOf(Bitbox02Error);
			expect((e as Bitbox02Error).code).toBe('unsupported_script_type');
		}
	});
});

describe('normalizeXpub', () => {
	it('leaves a standard xpub unchanged', () => {
		expect(normalizeXpub(XPUB)).toBe(XPUB);
	});

	it('rewrites SLIP-132 single-sig prefixes (ypub/zpub) to standard xpub', () => {
		expect(normalizeXpub(withVersion(XPUB, 0x049d7cb2))).toBe(XPUB); // ypub
		expect(normalizeXpub(withVersion(XPUB, 0x04b24746))).toBe(XPUB); // zpub
	});

	it('rewrites SLIP-132 multisig prefixes (Ypub/Zpub) to standard xpub', () => {
		expect(normalizeXpub(withVersion(XPUB, 0x0295b43f))).toBe(XPUB); // Ypub
		expect(normalizeXpub(withVersion(XPUB, 0x02aa7ed3))).toBe(XPUB); // Zpub
	});

	it('trims and passes through non-base58 garbage unchanged (real error later)', () => {
		expect(normalizeXpub('  not-a-key  ')).toBe('not-a-key');
	});
});

describe('bitboxKeyIdentityMatches', () => {
	const expected: MultisigSignKey = { xpub: XPUB, fingerprint: 'd34db33f', path: "m/48'/0'/0'/2'" };

	it('matches identical account xpubs', () => {
		expect(bitboxKeyIdentityMatches(expected, { xpub: XPUB, fingerprint: '00000000' })).toBe(true);
	});

	it('matches a SLIP-132 alias of the same key (Zpub == xpub)', () => {
		expect(
			bitboxKeyIdentityMatches(expected, { xpub: withVersion(XPUB, 0x02aa7ed3), fingerprint: '00000000' })
		).toBe(true);
	});

	it('matches on fingerprint fallback when the xpub differs', () => {
		expect(
			bitboxKeyIdentityMatches(expected, { xpub: 'unreadable', fingerprint: 'D34DB33F' })
		).toBe(true);
	});

	it('rejects a wholly different device', () => {
		const other = HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive("m/48'/0'/0'/2'");
		expect(
			bitboxKeyIdentityMatches(expected, { xpub: other.publicExtendedKey, fingerprint: 'aaaaaaaa' })
		).toBe(false);
	});

	it('does not treat placeholder fingerprints as a match', () => {
		expect(
			bitboxKeyIdentityMatches(
				{ xpub: 'a', fingerprint: '00000000' },
				{ xpub: 'b', fingerprint: '00000000' }
			)
		).toBe(false);
	});
});

describe('buildSimpleScriptConfig', () => {
	it('builds the device simpleType for each supported script type', () => {
		expect(buildSimpleScriptConfig('p2sh-p2wpkh')).toEqual({ simpleType: 'p2wpkhP2sh' });
		expect(buildSimpleScriptConfig('p2wpkh')).toEqual({ simpleType: 'p2wpkh' });
		expect(buildSimpleScriptConfig('p2tr')).toEqual({ simpleType: 'p2tr' });
	});

	it('rejects p2pkh', () => {
		expect(() => buildSimpleScriptConfig('p2pkh')).toThrow(Bitbox02Error);
	});
});

describe('buildMultisigScriptConfig', () => {
	const KEYS: MultisigSignKey[] = [1, 2, 3].map((fill) => {
		const m = HDKey.fromMasterSeed(new Uint8Array(32).fill(fill));
		const acct = m.derive("m/48'/0'/0'/2'");
		return {
			xpub: acct.publicExtendedKey,
			fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
			path: "m/48'/0'/0'/2'"
		};
	});

	it('builds the device multisig config with the ordered xpub set and our index', () => {
		const cfg = buildMultisigScriptConfig(KEYS, 1, 2, 'p2wsh');
		expect(cfg.multisig.threshold).toBe(2);
		expect(cfg.multisig.ourXpubIndex).toBe(1);
		expect(cfg.multisig.scriptType).toBe('p2wsh');
		expect(cfg.multisig.xpubs).toEqual(KEYS.map((k) => k.xpub));
	});

	it('maps p2sh-p2wsh to the device p2wshP2sh script type', () => {
		expect(buildMultisigScriptConfig(KEYS, 0, 2, 'p2sh-p2wsh').multisig.scriptType).toBe(
			'p2wshP2sh'
		);
	});

	it('canonicalizes SLIP-132 cosigner xpubs to standard xpub', () => {
		const zpubKeys = KEYS.map((k) => ({ ...k, xpub: withVersion(k.xpub, 0x02aa7ed3) }));
		const cfg = buildMultisigScriptConfig(zpubKeys, 0, 2, 'p2wsh');
		expect(cfg.multisig.xpubs).toEqual(KEYS.map((k) => k.xpub));
	});

	it('rejects plain p2sh multisig', () => {
		try {
			buildMultisigScriptConfig(KEYS, 0, 2, 'p2sh');
			expect.unreachable('expected a rejection');
		} catch (e) {
			expect((e as Bitbox02Error).code).toBe('unsupported_script_type');
		}
	});

	it('rejects a nonsense threshold and a bad device index', () => {
		expect(() => buildMultisigScriptConfig(KEYS, 0, 4, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig(KEYS, 0, 0, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig(KEYS, 5, 2, 'p2wsh')).toThrow(Bitbox02Error);
		expect(() => buildMultisigScriptConfig([], 0, 1, 'p2wsh')).toThrow(Bitbox02Error);
	});
});

describe('toBitbox02Error', () => {
	it('passes a Bitbox02Error through unchanged', () => {
		const orig = new Bitbox02Error('x', 'bad_psbt');
		expect(toBitbox02Error(orig)).toBe(orig);
	});

	it('classifies an on-device user abort via the library predicate', () => {
		const e = toBitbox02Error(new Error('boom'), { isUserAbort: () => true });
		expect(e.code).toBe('rejected');
	});

	it('classifies a user-abort by the typed error code', () => {
		const e = toBitbox02Error(
			{ code: 'user-abort', message: 'aborted' },
			{ ensureError: (x) => x as { code: string; message: string } }
		);
		expect(e.code).toBe('rejected');
	});

	it('classifies a locked device', () => {
		const e = toBitbox02Error({ code: 'locked', message: 'device is locked' });
		expect(e.code).toBe('device_locked');
	});

	it('classifies a no-device WebHID NotFoundError', () => {
		const e = toBitbox02Error({ name: 'NotFoundError', message: 'no device selected' });
		expect(e.code).toBe('no_device');
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toBitbox02Error(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});

// ---------------------------------------------------------- browser realism
//
// Regression guard mirroring ledger.test.ts's "without a Node Buffer global"
// suite (bead cairn-ivq): bitbox02.ts runs in the browser, where Node's Buffer
// global does not exist. Vitest runs under Node — where Buffer is always
// present — which is exactly how that class of bug ships. These tests delete
// globalThis.Buffer, re-import the module from scratch, and exercise the pure
// logic, so any future module-scope or pure-path Buffer usage fails CI instead
// of production. The device flows lazy-load the WASM module themselves; the
// pure path (paths, xpub normalization, scriptConfig build, error map) must be
// Buffer-free.
describe('without a Node Buffer global (browser environment)', () => {
	async function withoutBuffer<T>(fn: () => Promise<T>): Promise<T> {
		const g = globalThis as { Buffer?: unknown };
		const saved = g.Buffer;
		delete g.Buffer;
		try {
			return await fn();
		} finally {
			g.Buffer = saved;
			vi.resetModules();
		}
	}

	it('the module itself evaluates without Buffer', async () => {
		await withoutBuffer(async () => {
			vi.resetModules();
			const mod = await import('./bitbox02');
			expect(typeof mod.readSingleSigKeyFromBitbox02).toBe('function');
			expect(typeof mod.signPsbtWithBitbox02).toBe('function');
			expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
		});
	});

	it('the pure functions work end-to-end without Buffer', async () => {
		await withoutBuffer(async () => {
			vi.resetModules();
			const mod = await import('./bitbox02');

			// Path derivation.
			expect(mod.singleSigAccountPath('p2wpkh')).toBe("m/84'/0'/0'");
			expect(mod.multisigAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");

			// xpub normalization (base58check without Buffer).
			expect(mod.normalizeXpub(withVersion(XPUB, 0x04b24746))).toBe(XPUB);

			// scriptConfig construction.
			expect(mod.buildSimpleScriptConfig('p2tr')).toEqual({ simpleType: 'p2tr' });
			const keys: MultisigSignKey[] = [1, 2].map((fill) => {
				const m = HDKey.fromMasterSeed(new Uint8Array(32).fill(fill));
				return {
					xpub: m.derive("m/48'/0'/0'/2'").publicExtendedKey,
					fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
					path: "m/48'/0'/0'/2'"
				};
			});
			const cfg = mod.buildMultisigScriptConfig(keys, 0, 2, 'p2wsh');
			expect(cfg.multisig.ourXpubIndex).toBe(0);

			// The p2sh exclusion helper.
			expect(mod.bitbox02SupportsMultisigScriptType('p2sh')).toBe(false);

			// Error mapping is Buffer-free too.
			expect(mod.toBitbox02Error({ code: 'locked', message: 'locked' }).code).toBe(
				'device_locked'
			);
			expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
		});
	});
});

// -------------------------------------------------------- device-flow guards
//
// The device flows are exercised only for their up-front guards (a bad script
// type or empty PSBT must fail BEFORE any device I/O). The bitbox-api WASM
// module is mocked so no real WASM/WebHID is touched — same spirit as
// ledger.test.ts mocking its transport. `window` is absent under Vitest, so
// unstubbed connect flows surface `unavailable` before any device I/O.
describe('device-flow guards (no hardware)', () => {
	it('readSingleSigKeyFromBitbox02 rejects p2pkh before connecting', async () => {
		const { readSingleSigKeyFromBitbox02 } = await import('./bitbox02');
		await expect(readSingleSigKeyFromBitbox02('p2pkh')).rejects.toMatchObject({
			name: 'Bitbox02Error',
			code: 'unsupported_script_type'
		});
	});

	it('readMultisigKeyFromBitbox02 rejects plain p2sh before connecting', async () => {
		const { readMultisigKeyFromBitbox02 } = await import('./bitbox02');
		await expect(readMultisigKeyFromBitbox02('p2sh')).rejects.toMatchObject({
			name: 'Bitbox02Error',
			code: 'unsupported_script_type'
		});
	});

	it('signPsbtWithBitbox02 rejects an empty PSBT before connecting', async () => {
		const { signPsbtWithBitbox02, buildSimpleScriptConfig } = await import('./bitbox02');
		await expect(
			signPsbtWithBitbox02('   ', {
				scriptConfig: buildSimpleScriptConfig('p2wpkh'),
				keypath: "m/84'/0'/0'"
			})
		).rejects.toMatchObject({ name: 'Bitbox02Error', code: 'bad_psbt' });
	});

	// ── multisig registration before signing (cairn-5kth / audit F6) ───────────
	//
	// A BitBox02 must have a multisig script config REGISTERED (user-approved
	// on-device) before it will sign for it. These stub the full connect→pair→sign
	// chain to assert signPsbtWithBitbox02 checks registration and registers when
	// needed BEFORE it ever calls btcSignPSBT.

	const MS_KEYS: MultisigSignKey[] = [0, 1, 2].map((i) => ({
		xpub: XPUB,
		fingerprint: `0000000${i}`,
		path: "m/48'/0'/0'/2'"
	}));

	/** A fake PairedBitBox recording the order device calls happen in. */
	function makePaired(registered: boolean) {
		const calls: string[] = [];
		const paired = {
			btcIsScriptConfigRegistered: vi.fn(async () => {
				calls.push('check');
				return registered;
			}),
			btcRegisterScriptConfig: vi.fn(async () => {
				calls.push('register');
			}),
			btcSignPSBT: vi.fn(async () => {
				calls.push('sign');
				return 'SIGNED_PSBT';
			}),
			close: vi.fn()
		};
		return { paired, calls };
	}

	/** bitbox-api mock whose connect chain yields the given fake paired device. */
	function bitboxMock(paired: unknown) {
		return {
			bitbox02ConnectAuto: vi.fn(async () => ({
				unlockAndPair: async () => ({
					getPairingCode: () => undefined, // already paired — no code
					waitConfirm: async () => paired
				})
			})),
			ensureError: (e: unknown) => e,
			isUserAbort: () => false
		};
	}

	async function runSign(
		registered: boolean,
		scriptType: 'multisig' | 'simple'
	): Promise<{ calls: string[]; paired: ReturnType<typeof makePaired>['paired']; out: string }> {
		const { paired, calls } = makePaired(registered);
		vi.doMock('bitbox-api', () => bitboxMock(paired));
		vi.stubGlobal('window', {}); // make the browser check pass
		vi.stubGlobal('navigator', { hid: {} }); // make WebHID look available
		try {
			vi.resetModules();
			const { signPsbtWithBitbox02, buildMultisigScriptConfig, buildSimpleScriptConfig } =
				await import('./bitbox02');
			const params =
				scriptType === 'multisig'
					? {
							scriptConfig: buildMultisigScriptConfig(MS_KEYS, 0, 2, 'p2wsh' as const),
							keypath: "m/48'/0'/0'/2'",
							walletName: 'My Vault'
						}
					: { scriptConfig: buildSimpleScriptConfig('p2wpkh'), keypath: "m/84'/0'/0'" };
			const out = await signPsbtWithBitbox02('cHNidP8=', params);
			return { calls, paired, out };
		} finally {
			vi.doUnmock('bitbox-api');
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	}

	it('registers an unregistered multisig on-device BEFORE signing (check → register → sign)', async () => {
		const { calls, paired, out } = await runSign(false, 'multisig');
		expect(out).toBe('SIGNED_PSBT');
		expect(calls).toEqual(['check', 'register', 'sign']);
		expect(paired.btcRegisterScriptConfig).toHaveBeenCalledOnce();
		expect(paired.close).toHaveBeenCalled();
	});

	it('skips registration when the multisig is already registered (check → sign)', async () => {
		const { calls, paired } = await runSign(true, 'multisig');
		expect(calls).toEqual(['check', 'sign']);
		expect(paired.btcRegisterScriptConfig).not.toHaveBeenCalled();
	});

	it('never checks or registers for a single-sig config (sign only)', async () => {
		const { calls, paired } = await runSign(false, 'simple');
		expect(calls).toEqual(['sign']);
		expect(paired.btcIsScriptConfigRegistered).not.toHaveBeenCalled();
		expect(paired.btcRegisterScriptConfig).not.toHaveBeenCalled();
	});

	it('a supported-scriptType read surfaces unavailable outside a browser (no window)', async () => {
		// Mock the WASM module so import() never loads real WASM; the connect guard
		// throws unavailable first because Vitest has no window.
		vi.doMock('bitbox-api', () => ({
			bitbox02ConnectAuto: vi.fn(),
			ensureError: (e: unknown) => e,
			isUserAbort: () => false
		}));
		try {
			vi.resetModules();
			const { readSingleSigKeyFromBitbox02 } = await import('./bitbox02');
			await expect(readSingleSigKeyFromBitbox02('p2wpkh')).rejects.toMatchObject({
				name: 'Bitbox02Error',
				code: 'unavailable'
			});
		} finally {
			vi.doUnmock('bitbox-api');
			vi.resetModules();
		}
	});

	it('a failed connect on a bridge-only browser (window, no WebHID) explains the BitBoxBridge', async () => {
		// Browser present but navigator.hid absent — the Umbrel plain-HTTP case.
		// ConnectAuto rejecting then means "no bridge either": the error must
		// name the BitBoxBridge instead of a bare connect failure.
		vi.doMock('bitbox-api', () => ({
			bitbox02ConnectAuto: vi.fn(async () => {
				throw new Error('could not connect');
			}),
			ensureError: (e: unknown) => e,
			isUserAbort: () => false
		}));
		vi.stubGlobal('window', {});
		try {
			vi.resetModules();
			const { readSingleSigKeyFromBitbox02 } = await import('./bitbox02');
			await expect(readSingleSigKeyFromBitbox02('p2wpkh')).rejects.toMatchObject({
				name: 'Bitbox02Error',
				code: 'unsupported-browser',
				message: expect.stringContaining('BitBoxBridge')
			});
		} finally {
			vi.doUnmock('bitbox-api');
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	});
});
