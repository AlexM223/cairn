import { describe, it, expect, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	isWebSerialAvailable,
	singleSigAccountPath,
	multisigAccountPathIndexes,
	formatPath,
	toSingleSigXpub,
	buildJadeMultisigDescriptor,
	sanitizeJadeMultisigName,
	jadeMultisigRegistrationName,
	jadeKeyIdentityMatches,
	toJadeError,
	JadeError,
	type MultisigSignKey
} from './jade';

const HARDENED = 0x80000000;
const b58check = createBase58check(sha256);

// Three deterministic cosigners at the BIP-48 p2wsh account path, exactly the
// { xpub, fingerprint, path } shape multisig keys store. Same seeds as the
// Ledger/Trezor fixtures so all drivers are exercised against identical material.
const MULTISIG_PATH = "m/48'/0'/0'/2'";
const MULTISIG_MASTERS = [1, 2, 3].map((fill) =>
	HDKey.fromMasterSeed(new Uint8Array(32).fill(fill))
);
const MULTISIG_ACCOUNTS = MULTISIG_MASTERS.map((m) => m.derive(MULTISIG_PATH));
const MULTISIG_KEYS: MultisigSignKey[] = MULTISIG_MASTERS.map((m, i) => ({
	xpub: MULTISIG_ACCOUNTS[i].publicExtendedKey,
	fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
	path: MULTISIG_PATH
}));

describe('isWebSerialAvailable', () => {
	it('is false in a Node/SSR environment with no navigator.serial', () => {
		expect(isWebSerialAvailable()).toBe(false);
	});
});

describe('singleSigAccountPath', () => {
	it('maps each script type to its standard BIP44/49/84/86 account path', () => {
		expect(singleSigAccountPath('p2pkh')).toEqual([44 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
		expect(singleSigAccountPath('p2sh-p2wpkh')).toEqual([49 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
		expect(singleSigAccountPath('p2wpkh')).toEqual([84 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
		expect(singleSigAccountPath('p2tr')).toEqual([86 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
	});

	it('honours a non-default account index', () => {
		expect(singleSigAccountPath('p2wpkh', 3)).toEqual([84 + HARDENED, 0 + HARDENED, 3 + HARDENED]);
	});

	it('rejects a bogus account index', () => {
		expect(() => singleSigAccountPath('p2wpkh', -1)).toThrow(JadeError);
		expect(() => singleSigAccountPath('p2wpkh', 1.5)).toThrow(JadeError);
		expect(() => singleSigAccountPath('p2wpkh', HARDENED)).toThrow(JadeError);
	});

	it('rejects an unknown script type', () => {
		expect(() => singleSigAccountPath('nonsense' as never)).toThrow(JadeError);
	});
});

describe('multisigAccountPathIndexes', () => {
	it("maps p2wsh to the BIP-48 2' suffix and both p2sh forms to 1'", () => {
		expect(multisigAccountPathIndexes('p2wsh')).toEqual([
			48 + HARDENED,
			0 + HARDENED,
			0 + HARDENED,
			2 + HARDENED
		]);
		expect(multisigAccountPathIndexes('p2sh-p2wsh')).toEqual([
			48 + HARDENED,
			0 + HARDENED,
			0 + HARDENED,
			1 + HARDENED
		]);
		expect(multisigAccountPathIndexes('p2sh')).toEqual([
			48 + HARDENED,
			0 + HARDENED,
			0 + HARDENED,
			1 + HARDENED
		]);
	});

	it('honours a non-default account index and rejects bogus ones', () => {
		expect(multisigAccountPathIndexes('p2wsh', 5)[2]).toBe(5 + HARDENED);
		expect(() => multisigAccountPathIndexes('p2wsh', -1)).toThrow(JadeError);
		expect(() => multisigAccountPathIndexes('bad' as never)).toThrow(JadeError);
	});
});

describe('formatPath', () => {
	it('renders a hardened-offset index array in apostrophe notation', () => {
		expect(formatPath([84 + HARDENED, 0 + HARDENED, 0 + HARDENED])).toBe("m/84'/0'/0'");
		expect(formatPath([48 + HARDENED, 0 + HARDENED, 3 + HARDENED, 2 + HARDENED])).toBe(
			"m/48'/0'/3'/2'"
		);
	});

	it('keeps non-hardened elements bare and renders [] as "m"', () => {
		expect(formatPath([0, 5])).toBe('m/0/5');
		expect(formatPath([])).toBe('m');
	});
});

describe('toSingleSigXpub', () => {
	// A real mainnet account xpub (BIP84 account 0 of the all-1s seed).
	const XPUB = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'")
		.publicExtendedKey;

	function versionOf(extKey: string): number {
		const raw = b58check.decode(extKey);
		return ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
	}

	it('rewrites a standard xpub to zpub for p2wpkh (BIP84)', () => {
		const out = toSingleSigXpub(XPUB, 'p2wpkh');
		expect(versionOf(out)).toBe(0x04b24746); // zpub
		// Round-trips back to the same key material as a plain xpub.
		const back = new Uint8Array(b58check.decode(out));
		back[0] = 0x04;
		back[1] = 0x88;
		back[2] = 0xb2;
		back[3] = 0x1e;
		expect(b58check.encode(back)).toBe(XPUB);
	});

	it('rewrites a standard xpub to ypub for p2sh-p2wpkh (BIP49)', () => {
		expect(versionOf(toSingleSigXpub(XPUB, 'p2sh-p2wpkh'))).toBe(0x049d7cb2); // ypub
	});

	it('keeps p2pkh (BIP44) and p2tr (BIP86) as a plain xpub', () => {
		expect(versionOf(toSingleSigXpub(XPUB, 'p2pkh'))).toBe(0x0488b21e); // xpub
		expect(versionOf(toSingleSigXpub(XPUB, 'p2tr'))).toBe(0x0488b21e); // xpub
	});

	it('passes non-extended-key input through unchanged (real error surfaces later)', () => {
		expect(toSingleSigXpub('not-an-xpub', 'p2wpkh')).toBe('not-an-xpub');
	});

	it('rejects an unknown script type', () => {
		expect(() => toSingleSigXpub(XPUB, 'bogus' as never)).toThrow(JadeError);
	});
});

describe('buildJadeMultisigDescriptor', () => {
	it('adapts a 2-of-3 p2wsh multisig into a sorted jadets descriptor', () => {
		const desc = buildJadeMultisigDescriptor({
			name: 'Family',
			threshold: 2,
			keys: MULTISIG_KEYS,
			scriptType: 'p2wsh'
		});
		expect(desc.variant).toBe('wsh(multi(k))');
		expect(desc.sorted).toBe(true);
		expect(desc.threshold).toBe(2);
		expect(desc.signers).toHaveLength(3);

		// Signer 0: fingerprint as 4 bytes, derivation as the BIP-48 index array,
		// xpub verbatim.
		const s0 = desc.signers[0];
		expect(Array.from(s0.fingerprint)).toEqual([
			parseInt(MULTISIG_KEYS[0].fingerprint.slice(0, 2), 16),
			parseInt(MULTISIG_KEYS[0].fingerprint.slice(2, 4), 16),
			parseInt(MULTISIG_KEYS[0].fingerprint.slice(4, 6), 16),
			parseInt(MULTISIG_KEYS[0].fingerprint.slice(6, 8), 16)
		]);
		expect(s0.derivation).toEqual([48 + HARDENED, 0 + HARDENED, 0 + HARDENED, 2 + HARDENED]);
		expect(s0.xpub).toBe(MULTISIG_KEYS[0].xpub);
	});

	it('wraps the other script forms in their multi() variants', () => {
		expect(
			buildJadeMultisigDescriptor({
				name: 'x',
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2sh'
			}).variant
		).toBe('sh(multi(k))');
		expect(
			buildJadeMultisigDescriptor({
				name: 'x',
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2sh-p2wsh'
			}).variant
		).toBe('sh(wsh(multi(k)))');
	});

	it('emits an empty derivation for a key with unknown origin ("m")', () => {
		const desc = buildJadeMultisigDescriptor({
			name: 'x',
			threshold: 1,
			keys: [{ ...MULTISIG_KEYS[0], path: 'm' }],
			scriptType: 'p2wsh'
		});
		expect(desc.signers[0].derivation).toEqual([]);
	});

	it('rejects a nonsense threshold', () => {
		expect(() =>
			buildJadeMultisigDescriptor({ name: 'x', threshold: 4, keys: MULTISIG_KEYS, scriptType: 'p2wsh' })
		).toThrow(JadeError);
		expect(() =>
			buildJadeMultisigDescriptor({ name: 'x', threshold: 0, keys: MULTISIG_KEYS, scriptType: 'p2wsh' })
		).toThrow(JadeError);
	});

	it('rejects an empty key set', () => {
		expect(() =>
			buildJadeMultisigDescriptor({ name: 'x', threshold: 1, keys: [], scriptType: 'p2wsh' })
		).toThrow(JadeError);
	});

	it('rejects a malformed fingerprint', () => {
		expect(() =>
			buildJadeMultisigDescriptor({
				name: 'x',
				threshold: 1,
				keys: [{ ...MULTISIG_KEYS[0], fingerprint: 'xyz' }],
				scriptType: 'p2wsh'
			})
		).toThrow(JadeError);
	});
});

describe('sanitizeJadeMultisigName', () => {
	it('strips non-printable / whitespace and keeps ASCII', () => {
		expect(sanitizeJadeMultisigName('Family 🏰')).toBe('Family');
		expect(sanitizeJadeMultisigName('  vault  ')).toBe('vault');
	});

	it('caps the name at 16 characters', () => {
		const name = sanitizeJadeMultisigName('a'.repeat(40));
		expect(name.length).toBeLessThanOrEqual(16);
		expect(name).toBe('a'.repeat(16));
	});

	it('falls back for empty / all-non-ASCII input', () => {
		expect(sanitizeJadeMultisigName('')).toBe('cairnms');
		expect(sanitizeJadeMultisigName('🏰🏰')).toBe('cairnms');
	});
});

describe('jadeMultisigRegistrationName', () => {
	const base = { threshold: 2, keys: MULTISIG_KEYS, scriptType: 'p2wsh' as const };

	it('stays within Jade\'s 16-char firmware limit', () => {
		const name = jadeMultisigRegistrationName({ ...base, name: 'Family Vault Multisig Primary' });
		expect(name.length).toBeLessThanOrEqual(16);
	});

	it('is deterministic — same wallet always yields the same name', () => {
		const a = jadeMultisigRegistrationName({ ...base, name: 'My Vault' });
		const b = jadeMultisigRegistrationName({ ...base, name: 'My Vault' });
		expect(a).toBe(b);
	});

	it('does NOT collide for two different wallets that share a 16-char name prefix', () => {
		// The exact cairn-1qkk scenario: both names sanitize to the same 16-char
		// prefix, but the wallets differ (different key sets → must differ).
		const primary = jadeMultisigRegistrationName({
			...base,
			name: 'Family Vault Multisig Primary',
			keys: MULTISIG_KEYS
		});
		const backup = jadeMultisigRegistrationName({
			...base,
			name: 'Family Vault Multisig Backup',
			keys: [MULTISIG_KEYS[2], MULTISIG_KEYS[0], MULTISIG_KEYS[1]].map((k, i) => ({
				...k,
				// Perturb one key so it is a genuinely different wallet.
				fingerprint: i === 0 ? 'deadbeef' : k.fingerprint
			}))
		});
		expect(primary).not.toBe(backup);
	});

	it('is independent of cosigner ordering (BIP-67 sorted semantics)', () => {
		const forward = jadeMultisigRegistrationName({ ...base, name: 'Vault', keys: MULTISIG_KEYS });
		const reversed = jadeMultisigRegistrationName({
			...base,
			name: 'Vault',
			keys: [...MULTISIG_KEYS].reverse()
		});
		expect(forward).toBe(reversed);
	});
});

describe('jadeKeyIdentityMatches', () => {
	const key = MULTISIG_KEYS[0];

	it('matches when the device account xpub equals the stored cosigner xpub', () => {
		expect(jadeKeyIdentityMatches(key, { xpub: key.xpub, fingerprint: '00000000' })).toBe(true);
	});

	it('matches on fingerprint fallback when the xpub cannot be compared', () => {
		expect(
			jadeKeyIdentityMatches(key, { xpub: 'not-an-xpub', fingerprint: key.fingerprint.toUpperCase() })
		).toBe(true);
	});

	it('rejects a different device (different xpub and fingerprint)', () => {
		expect(
			jadeKeyIdentityMatches(key, { xpub: MULTISIG_KEYS[1].xpub, fingerprint: MULTISIG_KEYS[1].fingerprint })
		).toBe(false);
	});

	it('does not match a placeholder fingerprint against a placeholder', () => {
		expect(
			jadeKeyIdentityMatches({ xpub: 'x', fingerprint: '00000000' }, { xpub: 'y', fingerprint: '00000000' })
		).toBe(false);
	});
});

describe('toJadeError', () => {
	it('passes a JadeError through unchanged', () => {
		const orig = new JadeError('x', 'bad_psbt');
		expect(toJadeError(orig)).toBe(orig);
	});

	it('classifies no-device-selected from a Web Serial NotFoundError', () => {
		expect(toJadeError({ name: 'NotFoundError', message: 'No port selected' }).code).toBe(
			'no_device'
		);
		expect(toJadeError(new Error('No serial port selected.')).code).toBe('no_device');
	});

	it('classifies an unsupported browser', () => {
		expect(toJadeError(new Error('Web Serial API is not supported in this browser.')).code).toBe(
			'unsupported-browser'
		);
	});

	it('classifies an on-device rejection', () => {
		expect(toJadeError(new Error('user rejected the request')).code).toBe('rejected');
	});

	it('classifies a PIN / auth failure', () => {
		expect(toJadeError(new Error('HTTP request function not provided')).code).toBe('auth_failed');
	});

	it('classifies a timeout', () => {
		expect(toJadeError(new Error('RPC call timed out')).code).toBe('unexpected');
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toJadeError(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});

// ---------------------------------------------------------- browser realism
//
// The module runs in the browser. Vitest runs under Node — so this deletes the
// Node Buffer global, re-imports the module from scratch, and exercises the
// pure logic, guarding against any future module-scope or pure-path Buffer
// usage (the class of bug that shipped the Ledger "Buffer is not defined"
// crash). The device flows import jadets — and whatever globals it needs —
// only inside their own functions, never at module scope.
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

	it('the module evaluates and its pure functions work without Buffer', async () => {
		await withoutBuffer(async () => {
			vi.resetModules();
			const mod = await import('./jade');
			expect(typeof mod.signPsbtWithJade).toBe('function');
			expect(typeof mod.readSingleSigKeyFromJade).toBe('function');

			expect(mod.singleSigAccountPath('p2wpkh')).toEqual([
				84 + HARDENED,
				0 + HARDENED,
				0 + HARDENED
			]);
			expect(mod.formatPath([84 + HARDENED, 0 + HARDENED, 0 + HARDENED])).toBe("m/84'/0'/0'");
			const desc = mod.buildJadeMultisigDescriptor({
				name: 'x',
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2wsh'
			});
			expect(desc.variant).toBe('wsh(multi(k))');
			expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
		});
	});
});

// ------------------------------------------------------ device-flow error path
//
// The device functions can't be exercised against real hardware here, but the
// no-browser guard IS testable: with no navigator.serial, every device entry
// point must fail fast with the typed 'unsupported-browser' error BEFORE trying
// to import or touch jadets.
describe('device functions reject without Web Serial', () => {
	it('readSingleSigKeyFromJade throws unsupported-browser', async () => {
		await expect(readSingleSigKeyFromJadeImport('p2wpkh')).rejects.toMatchObject({
			name: 'JadeError',
			code: 'unsupported-browser'
		});
	});

	it('signPsbtWithJade throws unsupported-browser', async () => {
		const { signPsbtWithJade } = await import('./jade');
		await expect(signPsbtWithJade('mainnet', new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
			name: 'JadeError',
			code: 'unsupported-browser'
		});
	});

	async function readSingleSigKeyFromJadeImport(scriptType: 'p2wpkh'): Promise<unknown> {
		const { readSingleSigKeyFromJade } = await import('./jade');
		return readSingleSigKeyFromJade(scriptType);
	}
});
