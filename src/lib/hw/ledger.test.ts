import { describe, it, expect, vi } from 'vitest';
import { Transaction, p2wpkh, p2ms, p2wsh, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
	isWebHidAvailable,
	accountOriginFromPsbt,
	fingerprintToBuffer,
	mergeSignatures,
	toLedgerError,
	LedgerError,
	buildMultisigPolicy,
	compareMultisigPolicyKeys,
	sanitizeMultisigPolicyName,
	multisigAccountPath,
	multisigDevicePubkeys,
	mergeMultisigSignatures,
	signMultisigPsbtWithLedger,
	type MultisigSignKey
} from './ledger';

// A deterministic compressed pubkey (secp256k1 generator, X-only prefixed 0x02).
const PUBKEY = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const HARDENED = 0x80000000;

// Build a minimal single-input p2wpkh PSBT carrying bip32Derivation exactly as
// src/lib/server/bitcoin/psbt.ts embeds it: [pubkey, { fingerprint: uint32, path }].
function makePsbt({
	fingerprint = 0x1a2b3c4d,
	accountPath = [84 + HARDENED, 0 + HARDENED, 0 + HARDENED],
	chain = 0,
	index = 4
}: {
	fingerprint?: number;
	accountPath?: number[];
	chain?: number;
	index?: number;
} = {}): string {
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n },
		bip32Derivation: [[PUBKEY, { fingerprint, path: [...accountPath, chain, index] }]]
	});
	tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('isWebHidAvailable', () => {
	it('is false in a Node/SSR environment with no navigator.hid', () => {
		expect(isWebHidAvailable()).toBe(false);
	});
});

describe('fingerprintToBuffer', () => {
	it('renders a uint32 as 4-byte big-endian', () => {
		expect(Array.from(fingerprintToBuffer(0x1a2b3c4d))).toEqual([0x1a, 0x2b, 0x3c, 0x4d]);
	});
	it('handles the high bit without sign issues', () => {
		expect(Array.from(fingerprintToBuffer(0xf0000001))).toEqual([0xf0, 0x00, 0x00, 0x01]);
	});
});

describe('accountOriginFromPsbt', () => {
	it('recovers fingerprint, account path (chain/index stripped), and wpkh template', () => {
		const origin = accountOriginFromPsbt(makePsbt());
		expect(origin.fingerprint).toBe(0x1a2b3c4d);
		expect(origin.accountPath).toEqual([84 + HARDENED, 0 + HARDENED, 0 + HARDENED]);
		expect(origin.template).toBe('wpkh(@0/**)');
	});

	it('maps each BIP purpose to its Ledger descriptor template', () => {
		const cases: [number, string][] = [
			[44, 'pkh(@0/**)'],
			[49, 'sh(wpkh(@0/**))'],
			[84, 'wpkh(@0/**)'],
			[86, 'tr(@0/**)']
		];
		for (const [purpose, template] of cases) {
			const psbt = makePsbt({
				accountPath: [purpose + HARDENED, 0 + HARDENED, 0 + HARDENED]
			});
			expect(accountOriginFromPsbt(psbt).template).toBe(template);
		}
	});

	it('honours a non-default account index (m/84\'/0\'/3\')', () => {
		const psbt = makePsbt({
			accountPath: [84 + HARDENED, 0 + HARDENED, 3 + HARDENED]
		});
		expect(accountOriginFromPsbt(psbt).accountPath[2]).toBe(3 + HARDENED);
	});

	it('throws bad_psbt when the input has no bip32Derivation', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('b'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
		const psbt = base64.encode(tx.toPSBT());
		expect(() => accountOriginFromPsbt(psbt)).toThrow(LedgerError);
		try {
			accountOriginFromPsbt(psbt);
		} catch (e) {
			expect((e as LedgerError).code).toBe('bad_psbt');
		}
	});

	it('throws bad_psbt for a non-standard purpose', () => {
		const psbt = makePsbt({ accountPath: [99 + HARDENED, 0 + HARDENED, 0 + HARDENED] });
		expect(() => accountOriginFromPsbt(psbt)).toThrow(/not a standard single-sig/);
	});

	it('throws bad_psbt on garbage input', () => {
		expect(() => accountOriginFromPsbt('not-a-psbt')).toThrow(LedgerError);
	});
});

describe('mergeSignatures', () => {
	it('attaches a partial signature to the input pubkey and preserves the commitment', () => {
		const psbt = makePsbt();
		const tx = Transaction.fromPSBT(base64.decode(psbt));

		// A dummy DER-ish signature blob (content is opaque to the merge step).
		const sig = new Uint8Array([0x30, 0x44, ...new Array(68).fill(0x11)]);
		mergeSignatures(tx, new Map([[0, Buffer.from(sig)]]));

		const input = tx.getInput(0);
		expect(input.partialSig).toBeDefined();
		expect(input.partialSig!.length).toBe(1);
		const [pk, s] = input.partialSig![0];
		expect(Array.from(pk)).toEqual(Array.from(PUBKEY));
		expect(Array.from(s)).toEqual(Array.from(sig));

		// Inputs and outputs (the commitment) are unchanged by signing.
		const before = Transaction.fromPSBT(base64.decode(psbt));
		expect(tx.inputsLength).toBe(before.inputsLength);
		expect(tx.outputsLength).toBe(before.outputsLength);
		expect(Number(tx.getOutput(0).amount)).toBe(90_000);
	});

	it('throws when a signature targets an input with no key-origin', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('c'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
		expect(() => mergeSignatures(tx, new Map([[0, Buffer.from([1, 2, 3])]]))).toThrow(LedgerError);
	});
});

describe('toLedgerError', () => {
	it('passes a LedgerError through unchanged', () => {
		const orig = new LedgerError('x', 'bad_psbt');
		expect(toLedgerError(orig)).toBe(orig);
	});

	it('classifies the app-not-open status code', () => {
		expect(toLedgerError({ statusCode: 0x6e01 }).code).toBe('app_not_open');
	});

	it('classifies user rejection', () => {
		expect(toLedgerError({ statusCode: 0x6985 }).code).toBe('rejected');
	});

	it('classifies a locked device', () => {
		expect(toLedgerError({ statusCode: 0x5515 }).code).toBe('device_locked');
	});

	it('classifies no-device-selected from a WebHID NotFoundError', () => {
		expect(toLedgerError({ name: 'NotFoundError', message: 'no device selected' }).code).toBe(
			'no_device'
		);
	});

	it('falls back to unexpected with the raw message', () => {
		const e = toLedgerError(new Error('weird failure'));
		expect(e.code).toBe('unexpected');
		expect(e.message).toContain('weird failure');
	});
});

// ------------------------------------------------------------------- multisigs

// Three deterministic cosigners at the BIP-48 p2wsh account path, exactly the
// { xpub, fingerprint, path } shape multisig keys store. Same seeds as the Trezor
// fixtures so both drivers are exercised against identical material.
const MULTISIG_PATH = "m/48'/0'/0'/2'";
const MULTISIG_ORIGIN = [48 + HARDENED, 0 + HARDENED, 0 + HARDENED, 2 + HARDENED];
const MULTISIG_MASTERS = [1, 2, 3].map((fill) =>
	HDKey.fromMasterSeed(new Uint8Array(32).fill(fill))
);
const MULTISIG_ACCOUNTS = MULTISIG_MASTERS.map((m) => m.derive(MULTISIG_PATH));
const MULTISIG_KEYS: MultisigSignKey[] = MULTISIG_MASTERS.map((m, i) => ({
	xpub: MULTISIG_ACCOUNTS[i].publicExtendedKey,
	fingerprint: (m.fingerprint >>> 0).toString(16).padStart(8, '0'),
	path: MULTISIG_PATH
}));

function multisigChild(k: number, chain: number, index: number): Uint8Array {
	return MULTISIG_ACCOUNTS[k].deriveChild(chain).deriveChild(index).publicKey!;
}

/** A 2-of-3 p2wsh multisig PSBT: one input at 0/5, one plain output. */
function makeMultisigPsbt(): string {
	const sorted = [0, 1, 2]
		.map((k) => multisigChild(k, 0, 5))
		.sort((a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : 1));
	const payment = p2wsh(p2ms(2, sorted), NETWORK);
	const tx = new Transaction();
	tx.addInput({
		txid: hexToBytes('a'.repeat(64)),
		index: 0,
		witnessUtxo: { script: payment.script, amount: 100_000n },
		witnessScript: payment.witnessScript,
		bip32Derivation: [0, 1, 2].map((k) => [
			multisigChild(k, 0, 5),
			{
				fingerprint: parseInt(MULTISIG_KEYS[k].fingerprint, 16) >>> 0,
				path: [...MULTISIG_ORIGIN, 0, 5]
			}
		])
	});
	tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 60_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('buildMultisigPolicy', () => {
	// Pinned against the exact strings the device will hash into the HMAC
	// preimage: apostrophe-hardened origins, no /branch/* suffix, and the keys
	// CASE-SENSITIVELY sorted by their xpub substring (6D < 6E < 6F here).
	const EXPECTED_KEYS = [
		"[4ba43603/48'/0'/0'/2']xpub6DknhdAsmeDQc7uaCcTBvPM5HJ2sN2gaBmNiJJtpczK3hMQWdKeodaBUSgi9qJrMKqPLqPuNFa7egPzCn8oJ7uU1zzhgAeHvzgYpxqchsQS",
		"[56c4fac3/48'/0'/0'/2']xpub6Ewx2N9hNSArJyF35CUGhaZLuZxQPNmJzWVwmpoV9U7Xu5wqka93nd3zEzokew9MzkNV4u6TCVDkHHR6QHQuYEFaasKzWkrkncXHMXGNdZP",
		"[8dfc9b34/48'/0'/0'/2']xpub6FAQRNJPfe8DZextv3BwkyE9GovxWr6NPx5DFosrY4WDdAeu96gcry37PJrV9agkn2pRsLieS487vaom77nSinfuerwfz926ZaNwkjUbhdt"
	];

	it('builds the exact 2-of-3 p2wsh template and key-origin strings', () => {
		const policy = buildMultisigPolicy({
			policyName: 'Family multisig',
			threshold: 2,
			keys: MULTISIG_KEYS,
			scriptType: 'p2wsh'
		});
		expect(policy.name).toBe('Family multisig');
		expect(policy.template).toBe('wsh(sortedmulti(2,@0/**,@1/**,@2/**))');
		expect(policy.keys).toEqual(EXPECTED_KEYS);
	});

	it('sorts by xpub regardless of the order the keys are passed in', () => {
		const shuffled = [MULTISIG_KEYS[2], MULTISIG_KEYS[0], MULTISIG_KEYS[1]];
		const policy = buildMultisigPolicy({
			policyName: 'x',
			threshold: 2,
			keys: shuffled,
			scriptType: 'p2wsh'
		});
		expect(policy.keys).toEqual(EXPECTED_KEYS);
	});

	it('wraps the other script forms in sh() / sh(wsh())', () => {
		expect(
			buildMultisigPolicy({ policyName: 'x', threshold: 2, keys: MULTISIG_KEYS, scriptType: 'p2sh' })
				.template
		).toBe('sh(sortedmulti(2,@0/**,@1/**,@2/**))');
		expect(
			buildMultisigPolicy({
				policyName: 'x',
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2sh-p2wsh'
			}).template
		).toBe('sh(wsh(sortedmulti(2,@0/**,@1/**,@2/**)))');
	});

	it('emits a key with an unknown origin ("m") as [xfp]xpub', () => {
		const keys = [{ ...MULTISIG_KEYS[0], path: 'm' }];
		const policy = buildMultisigPolicy({ policyName: 'x', threshold: 1, keys, scriptType: 'p2wsh' });
		expect(policy.keys[0]).toBe(`[${MULTISIG_KEYS[0].fingerprint}]${MULTISIG_KEYS[0].xpub}`);
	});

	it('rejects a nonsense threshold', () => {
		expect(() =>
			buildMultisigPolicy({ policyName: 'x', threshold: 4, keys: MULTISIG_KEYS, scriptType: 'p2wsh' })
		).toThrow(LedgerError);
		expect(() =>
			buildMultisigPolicy({ policyName: 'x', threshold: 0, keys: MULTISIG_KEYS, scriptType: 'p2wsh' })
		).toThrow(LedgerError);
	});
});

describe('compareMultisigPolicyKeys', () => {
	it('compares the xpub substring case-SENSITIVELY (never normalize case)', () => {
		// ASCII 'B' (0x42) < 'a' (0x61): case-sensitive order puts xpubB first,
		// while a case-insensitive comparison would reverse the pair. The HMAC
		// preimage depends on this order, so it must never change.
		expect(compareMultisigPolicyKeys('[aaaaaaaa]xpubB', '[bbbbbbbb]xpuba')).toBeLessThan(0);
		expect(compareMultisigPolicyKeys('[bbbbbbbb]xpuba', '[aaaaaaaa]xpubB')).toBeGreaterThan(0);
		// …and it ignores the origin bracket entirely (compares xpubs only).
		expect(compareMultisigPolicyKeys('[ffffffff]xpubA', '[00000000]xpubB')).toBeLessThan(0);
	});
});

describe('sanitizeMultisigPolicyName', () => {
	it('strips non-ASCII and trims', () => {
		expect(sanitizeMultisigPolicyName('Family Multisig 🏰')).toBe('Family Multisig');
		expect(sanitizeMultisigPolicyName('  padded  ')).toBe('padded');
	});

	it('truncates to at most 64 chars with an ASCII marker', () => {
		const long = 'v'.repeat(80);
		const name = sanitizeMultisigPolicyName(long);
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toBe(`${'v'.repeat(61)}...`);
	});

	it('falls back for an empty or all-non-ASCII name', () => {
		expect(sanitizeMultisigPolicyName('')).toBe('Cairn multisig');
		expect(sanitizeMultisigPolicyName('🏰🏰🏰')).toBe('Cairn multisig');
	});
});

describe('multisigAccountPath (Ledger)', () => {
	it("maps p2wsh to the BIP-48 2' suffix and both p2sh forms to 1'", () => {
		expect(multisigAccountPath('p2wsh')).toBe("m/48'/0'/0'/2'");
		expect(multisigAccountPath('p2sh-p2wsh')).toBe("m/48'/0'/0'/1'");
		expect(multisigAccountPath('p2sh')).toBe("m/48'/0'/0'/1'");
	});

	it('honours a non-default account index and rejects bogus ones', () => {
		expect(multisigAccountPath('p2wsh', 3)).toBe("m/48'/0'/3'/2'");
		expect(() => multisigAccountPath('p2wsh', -1)).toThrow(LedgerError);
	});
});

describe('multisigDevicePubkeys', () => {
	it("derives this device's per-input pubkey from its account xpub", () => {
		const pubkeys = multisigDevicePubkeys(makeMultisigPsbt(), MULTISIG_KEYS[1]);
		expect(pubkeys).toHaveLength(1);
		expect(bytesToHex(pubkeys[0])).toBe(bytesToHex(multisigChild(1, 0, 5)));
	});

	it("rejects a PSBT that doesn't include the key (wasn't built for this multisig)", () => {
		const stranger: MultisigSignKey = {
			xpub: HDKey.fromMasterSeed(new Uint8Array(32).fill(9)).derive(MULTISIG_PATH)
				.publicExtendedKey,
			fingerprint: 'deadbeef',
			path: MULTISIG_PATH
		};
		try {
			multisigDevicePubkeys(makeMultisigPsbt(), stranger);
			expect.unreachable('expected a rejection');
		} catch (e) {
			expect(e).toBeInstanceOf(LedgerError);
			expect((e as LedgerError).code).toBe('bad_psbt');
			expect((e as LedgerError).message).toMatch(/wasn't built for this multisig/);
		}
	});

	it('rejects an input with no key-origin information', () => {
		const tx = new Transaction();
		tx.addInput({
			txid: hexToBytes('b'.repeat(64)),
			index: 0,
			witnessUtxo: { script: p2wpkh(PUBKEY, NETWORK).script, amount: 100_000n }
		});
		tx.addOutputAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 90_000n, NETWORK);
		expect(() => multisigDevicePubkeys(base64.encode(tx.toPSBT()), MULTISIG_KEYS[0])).toThrow(
			LedgerError
		);
	});
});

describe('mergeMultisigSignatures', () => {
	// Ledger signatures arrive WITH their sighash byte — merged verbatim.
	const SIG = Buffer.from([
		0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20, ...new Array(32).fill(0x22),
		0x01
	]);

	it('attaches the signature to the device pubkey for that input', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		const pubkeys = multisigDevicePubkeys(makeMultisigPsbt(), MULTISIG_KEYS[0]);

		mergeMultisigSignatures(tx, new Map([[0, SIG]]), pubkeys);

		const sigs = tx.getInput(0).partialSig!;
		expect(sigs).toHaveLength(1);
		expect(bytesToHex(Uint8Array.from(sigs[0][0]))).toBe(bytesToHex(multisigChild(0, 0, 5)));
		expect(Array.from(sigs[0][1])).toEqual(Array.from(SIG));
	});

	it("preserves another cosigner's existing partialSig (combined-PSBT merge)", () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		tx.updateInput(0, { partialSig: [[multisigChild(2, 0, 5), Uint8Array.from(SIG)]] });

		mergeMultisigSignatures(tx, new Map([[0, SIG]]), [multisigChild(0, 0, 5)]);

		const sigs = tx.getInput(0).partialSig!;
		expect(sigs).toHaveLength(2);
	});

	it('rejects a signature whose pubkey is not declared in the input derivations', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		expect(() => mergeMultisigSignatures(tx, new Map([[0, SIG]]), [PUBKEY])).toThrow(
			/isn't part of this multisig/
		);
	});

	it('rejects an empty result and a nonexistent input index', () => {
		const tx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
		const pubkeys = [multisigChild(0, 0, 5)];
		expect(() => mergeMultisigSignatures(tx, new Map(), pubkeys)).toThrow(/no signatures/);
		expect(() => mergeMultisigSignatures(tx, new Map([[7, SIG]]), pubkeys)).toThrow(
			/nonexistent input/
		);
	});
});

// ---------------------------------------------------------- browser realism
//
// Regression guard for the P1 "Buffer is not defined" crash (bead cairn-ivq):
// ledger.ts runs in the browser, where Node's Buffer global does not exist.
// Vitest runs under Node — where Buffer is always present — which is exactly
// how the bug shipped. These tests delete globalThis.Buffer, re-import the
// module from scratch, and exercise the pure logic, so any future module-scope
// or pure-path Buffer usage fails CI instead of production. (The device flows
// install the `buffer` polyfill themselves before loading the vendor modules.)
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
			const mod = await import('./ledger');
			expect(typeof mod.signPsbtWithLedger).toBe('function');
			expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
		});
	});

	it('the pure functions work end-to-end without Buffer', async () => {
		await withoutBuffer(async () => {
			vi.resetModules();
			const mod = await import('./ledger');

			// PSBT → account origin (the vault key-import path that crashed).
			const origin = mod.accountOriginFromPsbt(makePsbt());
			expect(origin.template).toBe('wpkh(@0/**)');
			expect(Array.from(mod.fingerprintToBuffer(origin.fingerprint))).toEqual([
				0x1a, 0x2b, 0x3c, 0x4d
			]);

			// Signature merge-back with plain Uint8Array signatures.
			const tx = Transaction.fromPSBT(base64.decode(makePsbt()));
			const sig = new Uint8Array([0x30, 0x44, ...new Array(68).fill(0x11)]);
			mod.mergeSignatures(tx, new Map([[0, sig]]));
			expect(tx.getInput(0).partialSig![0][1]).toEqual(sig);

			// Multisig policy construction + per-input key derivation + merge.
			const policy = mod.buildMultisigPolicy({
				policyName: 'Family multisig',
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2wsh'
			});
			expect(policy.template).toBe('wsh(sortedmulti(2,@0/**,@1/**,@2/**))');
			const mtx = Transaction.fromPSBT(base64.decode(makeMultisigPsbt()));
			const pubkeys = mod.multisigDevicePubkeys(makeMultisigPsbt(), MULTISIG_KEYS[0]);
			// A DER-ish signature with its sighash byte, as the app emits it.
			const msig = new Uint8Array([
				0x30, 0x44, 0x02, 0x20, ...new Array(32).fill(0x11), 0x02, 0x20,
				...new Array(32).fill(0x22), 0x01
			]);
			mod.mergeMultisigSignatures(mtx, new Map([[0, msig]]), pubkeys);
			expect(mtx.getInput(0).partialSig).toHaveLength(1);

			// Error mapping is Buffer-free too.
			expect(mod.toLedgerError({ statusCode: 0x6e01 }).code).toBe('app_not_open');
			expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
		});
	});
});

describe('signMultisigPsbtWithLedger', () => {
	it('rejects up-front with policy_unregistered when no HMAC is stored', async () => {
		await expect(
			signMultisigPsbtWithLedger({
				unsignedPsbt: makeMultisigPsbt(),
				threshold: 2,
				keys: MULTISIG_KEYS,
				scriptType: 'p2wsh',
				policyName: 'Family multisig',
				policyHmac: null
			})
		).rejects.toMatchObject({ name: 'LedgerError', code: 'policy_unregistered' });
	});
});
