import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { deriveMultisigAddress, multisigTestAddress } from './bitcoin/multisig';
import { toMultisigConfig, type MultisigKeyRow, type MultisigRow } from './wallets/multisig';
import { multisigAddressAt } from './multisigScan';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path. Test-only keys, never a real wallet. (Same construction as
// multisig.test.ts so the two suites pin the same derivation universe.)
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

describe('multisigAddressAt', () => {
	const multisig = makeMultisig([1, 2, 3], 2);

	it('is deterministic: identical inputs give identical addresses, every call', () => {
		for (const [chain, index] of [
			[0, 0],
			[0, 1],
			[0, 19],
			[1, 0],
			[1, 7]
		] as const) {
			const a = multisigAddressAt(multisig, chain, index);
			const b = multisigAddressAt(multisig, chain, index);
			const c = multisigAddressAt(makeMultisig([1, 2, 3], 2), chain, index);
			expect(b).toBe(a);
			expect(c).toBe(a); // freshly-built equivalent row, same address
		}
	});

	it('matches the multisig library directly (single derivation code path)', () => {
		expect(multisigAddressAt(multisig, 0, 0)).toBe(
			deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address
		);
		expect(multisigAddressAt(multisig, 0, 0)).toBe(multisigTestAddress(toMultisigConfig(multisig)));
		expect(multisigAddressAt(multisig, 1, 5)).toBe(
			deriveMultisigAddress(toMultisigConfig(multisig), 1, 5).address
		);
	});

	it('key row order never changes the addresses (BIP-67 sorting)', () => {
		const shuffled = makeMultisig([3, 1, 2], 2);
		for (let index = 0; index < 10; index++) {
			expect(multisigAddressAt(shuffled, 0, index)).toBe(multisigAddressAt(multisig, 0, index));
			expect(multisigAddressAt(shuffled, 1, index)).toBe(multisigAddressAt(multisig, 1, index));
		}
	});

	it('receive and change chains are disjoint; consecutive indexes differ', () => {
		const seen = new Set<string>();
		for (let index = 0; index < 25; index++) {
			for (const chain of [0, 1] as const) {
				const addr = multisigAddressAt(multisig, chain, index);
				expect(seen.has(addr)).toBe(false);
				seen.add(addr);
			}
		}
		expect(seen.size).toBe(50);
	});

	it('different quorums and key sets give different addresses', () => {
		const threeOfFive = makeMultisig([1, 2, 3, 4, 5], 3);
		const twoOfThreeOtherKeys = makeMultisig([4, 5, 6], 2);
		const addr = multisigAddressAt(multisig, 0, 0);
		expect(multisigAddressAt(threeOfFive, 0, 0)).not.toBe(addr);
		expect(multisigAddressAt(twoOfThreeOtherKeys, 0, 0)).not.toBe(addr);
		// Same keys, different threshold: different script, different address.
		expect(multisigAddressAt(makeMultisig([1, 2, 3], 3), 0, 0)).not.toBe(addr);
	});

	it('derives native segwit p2wsh addresses (32-byte program bech32)', () => {
		const addr = multisigAddressAt(multisig, 0, 0);
		expect(addr.startsWith('bc1q')).toBe(true);
		expect(addr.length).toBe(62);
	});
});
