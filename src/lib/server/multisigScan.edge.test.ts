// Edge-case tests for multisigScan.ts (cairn-czi0): the scanner's core paths
// (scanMultisig / doScan, getMultisigUtxos, listMultisigSummaries) plus
// multisigAddressDetailAt's malformed-input handling. Companion to
// multisigScan.test.ts (multisigAddressAt determinism + the cairn-2qa4
// concurrency suite) — a separate file so this suite's Electrum mocking
// doesn't have to coexist with the other file's real-DB-only tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';

const { batchRequestMock, getTxMock, getTxHexMock, getBlockTimeAtHeightMock } = vi.hoisted(() => ({
	batchRequestMock: vi.fn(),
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn(),
	getBlockTimeAtHeightMock: vi.fn()
}));

vi.mock('./chain/index', () => ({
	getChain: () => ({
		electrum: { batchRequest: batchRequestMock },
		getTx: getTxMock,
		getTxHex: getTxHexMock,
		getBlockTimeAtHeight: getBlockTimeAtHeightMock
	})
}));

import { deriveMultisigAddress, MultisigError } from './bitcoin/multisig';
import { addressToScripthash } from './bitcoin/xpub';
import {
	toMultisigConfig,
	createMultisig,
	type MultisigKeyRow,
	type MultisigRow,
	type NewMultisigKey
} from './wallets/multisig';
import {
	multisigAddressAt,
	multisigAddressDetailAt,
	scanMultisig,
	getMultisigUtxos,
	listMultisigSummaries,
	primeMultisigScanCache,
	type MultisigScanResult
} from './multisigScan';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';

const BIP48_PATH = "m/48'/0'/0'/2'";

function makeKeyRow(seedByte: number, position: number): MultisigKeyRow {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		id: position + 1,
		multisigId: 1,
		position,
		name: `Key ${position + 1}`,
		category: 'hardware',
		deviceType: null,
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH
	};
}

function makeMultisig(seedBytes: number[], threshold: number): MultisigRow {
	return {
		id: 1,
		userId: 1,
		name: 'Test multisig',
		threshold,
		scriptType: 'p2wsh',
		receiveCursor: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		keys: seedBytes.map((b, i) => makeKeyRow(b, i))
	};
}

function newMultisigInputKey(seedByte: number, name: string): NewMultisigKey {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		name,
		category: 'hardware',
		deviceType: 'trezor',
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH
	};
}

function makeStoredMultisig(userId: number, name: string, seedBytes: number[]): MultisigRow {
	return createMultisig(userId, {
		name,
		threshold: 2,
		keys: seedBytes.map((b, i) => newMultisigInputKey(b, `Key ${i + 1}`))
	});
}

function wipeDb(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM wallet_scan_cache;'
	);
}

async function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Wire the mocked Electrum layer to answer get_history/get_balance/listunspent
 *  for a specific multisig's addresses on both chains within [0, precompute).
 *  `unspent` optionally maps "<chain>:<index>" to the listunspent rows to
 *  return for that address (only consulted for used addresses). */
function wireMultisigElectrum(
	multisig: MultisigRow,
	usedByChain: { 0: Set<number>; 1: Set<number> },
	precompute: number,
	unspent: Map<string, { tx_hash: string; tx_pos: number; value: number; height: number }[]> = new Map()
): void {
	const shToInfo = new Map<string, { chain: 0 | 1; index: number }>();
	for (const chain of [0, 1] as const) {
		for (let i = 0; i < precompute; i++) {
			shToInfo.set(addressToScripthash(multisigAddressAt(multisig, chain, i)), { chain, index: i });
		}
	}
	batchRequestMock.mockImplementation(async (reqs: { method: string; params: string[] }[]) =>
		reqs.map((r) => {
			const info = shToInfo.get(r.params[0]);
			const used = info !== undefined && usedByChain[info.chain].has(info.index);
			if (r.method === 'blockchain.scripthash.get_history') {
				return used ? [{ tx_hash: `${info!.chain}${info!.index}`.padStart(64, '0'), height: 100 }] : [];
			}
			if (r.method === 'blockchain.scripthash.listunspent') {
				if (!used) return [];
				return unspent.get(`${info!.chain}:${info!.index}`) ?? [];
			}
			return used ? { confirmed: 10_000, unconfirmed: 0 } : { confirmed: 0, unconfirmed: 0 };
		})
	);
}

beforeEach(() => {
	wipeDb();
	setSetting('registration_mode', 'open');
	batchRequestMock.mockReset();
	getTxMock.mockReset().mockRejectedValue(new Error('not stubbed in this test'));
	getTxHexMock.mockReset().mockRejectedValue(new Error('not stubbed in this test'));
	getBlockTimeAtHeightMock.mockReset().mockResolvedValue(null);
});

// ─────────────────────────────────── multisigAddressDetailAt (cairn-czi0) ──

describe('multisigAddressDetailAt — verification detail + malformed input', () => {
	const multisig = makeMultisig([1, 2, 3], 2);

	it('matches deriveMultisigAddress and reports every cosigner key path', () => {
		const detail = multisigAddressDetailAt(multisig, 0, 3);
		const derived = deriveMultisigAddress(toMultisigConfig(multisig), 0, 3);
		expect(detail.address).toBe(derived.address);
		expect(detail.witnessScript).toBe(Buffer.from(derived.witnessScript!).toString('hex'));
		expect(detail.sortedPubkeys).toHaveLength(3);
		expect(detail.keys).toHaveLength(3);
		for (const k of detail.keys) {
			expect(k.fullPath).toBe(`${BIP48_PATH}/0/3`);
		}
	});

	it("an origin-less key ('m') reports fullPath as just m/<chain>/<index>", () => {
		const withMaskedKey = makeMultisig([1, 2, 3], 2);
		withMaskedKey.keys[0] = { ...withMaskedKey.keys[0], path: 'm' };
		const detail = multisigAddressDetailAt(withMaskedKey, 1, 7);
		expect(detail.keys[0].fullPath).toBe('m/1/7');
		expect(detail.keys[1].fullPath).toBe(`${BIP48_PATH}/1/7`);
	});

	it('throws MultisigError(derivation_failed) for an invalid chain value', () => {
		expect(() => multisigAddressDetailAt(multisig, 2 as unknown as 0 | 1, 0)).toThrow(MultisigError);
		try {
			multisigAddressDetailAt(multisig, 2 as unknown as 0 | 1, 0);
		} catch (e) {
			expect((e as MultisigError).code).toBe('derivation_failed');
		}
	});

	it('throws MultisigError(derivation_failed) for a negative index', () => {
		expect(() => multisigAddressDetailAt(multisig, 0, -1)).toThrow(MultisigError);
	});

	it('throws MultisigError(derivation_failed) for an index at/above the hardened boundary (0x80000000)', () => {
		expect(() => multisigAddressDetailAt(multisig, 0, 0x80000000)).toThrow(MultisigError);
	});

	it('throws MultisigError(derivation_failed) for a non-integer index', () => {
		expect(() => multisigAddressDetailAt(multisig, 0, 1.5)).toThrow(MultisigError);
	});

	it('throws MultisigError(invalid_key) for a malformed cosigner xpub in the multisig row', () => {
		const malformed = makeMultisig([1, 2, 3], 2);
		malformed.keys[1] = { ...malformed.keys[1], xpub: 'not-a-real-xpub' };
		expect(() => multisigAddressDetailAt(malformed, 0, 0)).toThrow(MultisigError);
		try {
			multisigAddressDetailAt(malformed, 0, 0);
		} catch (e) {
			expect((e as MultisigError).code).toBe('invalid_key');
		}
	});
});

// ───────────────────────────────────────── scanMultisig / doScan (cairn-czi0)

describe('scanMultisig — core scan paths', () => {
	it('an empty multisig (never used on either chain) scans cleanly to zero balance', async () => {
		const user = await makeUser('ms-empty@example.com');
		const multisig = makeStoredMultisig(user.id, 'Empty vault', [5, 6, 7]);
		wireMultisigElectrum(multisig, { 0: new Set(), 1: new Set() }, 20);

		const result = await scanMultisig(multisig);
		expect(result.confirmed).toBe(0);
		expect(result.unconfirmed).toBe(0);
		expect(result.addresses.length).toBeGreaterThan(0); // the unused lookahead batches
		expect(result.addresses.every((a) => !a.used)).toBe(true);
	});

	it('a populated multisig reports the used addresses and their confirmed balance', async () => {
		const user = await makeUser('ms-populated@example.com');
		const multisig = makeStoredMultisig(user.id, 'Populated vault', [8, 9, 10]);
		wireMultisigElectrum(multisig, { 0: new Set([0]), 1: new Set() }, 40);

		const result = await scanMultisig(multisig);
		expect(result.confirmed).toBe(10_000);
		const usedAddr = result.addresses.find((a) => a.chain === 0 && a.index === 0);
		expect(usedAddr?.used).toBe(true);
	});

	it('caches for the TTL: a second scanMultisig call within it does not touch Electrum again; forceRefresh does', async () => {
		const user = await makeUser('ms-cache@example.com');
		const multisig = makeStoredMultisig(user.id, 'Cache vault', [11, 12, 13]);
		wireMultisigElectrum(multisig, { 0: new Set(), 1: new Set() }, 20);

		await scanMultisig(multisig);
		const callsAfterFirst = batchRequestMock.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		await scanMultisig(multisig);
		expect(batchRequestMock.mock.calls.length).toBe(callsAfterFirst); // cache hit, no new calls

		await scanMultisig(multisig, { forceRefresh: true });
		expect(batchRequestMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});
});

// ─────────────────────────────────────────── getMultisigUtxos (cairn-czi0) ──

describe('getMultisigUtxos', () => {
	it('an empty multisig returns no UTXOs', async () => {
		const user = await makeUser('ms-utxo-empty@example.com');
		const multisig = makeStoredMultisig(user.id, 'No coins vault', [14, 15, 16]);
		wireMultisigElectrum(multisig, { 0: new Set(), 1: new Set() }, 20);

		const utxos = await getMultisigUtxos(multisig);
		expect(utxos).toEqual([]);
	});

	it('returns a live UTXO for a used address, attributed to the right chain/index', async () => {
		const user = await makeUser('ms-utxo-live@example.com');
		const multisig = makeStoredMultisig(user.id, 'Coins vault', [17, 18, 19]);
		const unspent = new Map([
			[
				'0:0',
				[{ tx_hash: 'ab'.repeat(32), tx_pos: 0, value: 250_000, height: 800_000 }]
			]
		]);
		wireMultisigElectrum(multisig, { 0: new Set([0]), 1: new Set() }, 40, unspent);

		const utxos = await getMultisigUtxos(multisig);
		expect(utxos).toHaveLength(1);
		expect(utxos[0]).toMatchObject({
			txid: 'ab'.repeat(32),
			vout: 0,
			value: 250_000,
			chain: 0,
			index: 0
		});
	});
});

// ────────────────────────────────────── listMultisigSummaries (cairn-czi0) ──

const EMPTY_SCAN: MultisigScanResult = { addresses: [], txs: [], confirmed: 0, unconfirmed: 0 };

describe('listMultisigSummaries — per-multisig scan-failure isolation', () => {
	it('one multisig failing to scan never throws and never blocks the others — it lands in errors[] with a zeroed balance', async () => {
		const user = await makeUser('ms-partial@example.com');
		const good = makeStoredMultisig(user.id, 'Good vault', [21, 22, 23]);
		const bad = makeStoredMultisig(user.id, 'Bad vault', [24, 25, 26]);

		// Prime the good multisig's cache so it never touches the (about-to-fail)
		// Electrum mock; the bad one is left unprimed so it hits the reject below.
		primeMultisigScanCache(
			(await import('./bitcoin/multisig')).multisigToDescriptor(toMultisigConfig(good)),
			EMPTY_SCAN
		);
		batchRequestMock.mockRejectedValue(new Error('electrum unreachable'));

		const { multisigs, errors } = await listMultisigSummaries(user.id);
		expect(multisigs).toHaveLength(2);

		const goodSummary = multisigs.find((m) => m.id === good.id);
		const badSummary = multisigs.find((m) => m.id === bad.id);
		expect(goodSummary?.balance).toBe(0);
		expect(badSummary?.balance).toBe(0); // degraded, not thrown
		expect(badSummary?.unconfirmed).toBe(0);
		expect(errors[bad.id]).toContain('electrum unreachable');
		expect(errors[good.id]).toBeUndefined();
	});

	it('a user with zero multisigs gets an empty list and no errors, not a crash', async () => {
		const user = await makeUser('ms-none@example.com');
		const { multisigs, errors } = await listMultisigSummaries(user.id);
		expect(multisigs).toEqual([]);
		expect(errors).toEqual({});
	});
});
