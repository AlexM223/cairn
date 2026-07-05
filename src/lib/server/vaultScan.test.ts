import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { deriveVaultAddress, vaultTestAddress } from './bitcoin/multisig';
import { toVaultConfig, type VaultKeyRow, type VaultRow } from './vaults';
import { vaultAddressAt } from './vaultScan';

// Deterministic cosigner fixtures: master seeds 0x01…, accounts at the BIP-48
// wsh path. Test-only keys, never a real wallet. (Same construction as
// multisig.test.ts so the two suites pin the same derivation universe.)
const BIP48_PATH = "m/48'/0'/0'/2'";

function makeKeyRow(seedByte: number, position: number): VaultKeyRow {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		id: position + 1,
		vaultId: 1,
		position,
		name: `Key ${position + 1}`,
		category: 'hardware',
		deviceType: null,
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH
	};
}

function makeVault(seedBytes: number[], threshold: number): VaultRow {
	return {
		id: 1,
		userId: 1,
		name: 'Test vault',
		threshold,
		scriptType: 'p2wsh',
		receiveCursor: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		keys: seedBytes.map((b, i) => makeKeyRow(b, i))
	};
}

describe('vaultAddressAt', () => {
	const vault = makeVault([1, 2, 3], 2);

	it('is deterministic: identical inputs give identical addresses, every call', () => {
		for (const [chain, index] of [
			[0, 0],
			[0, 1],
			[0, 19],
			[1, 0],
			[1, 7]
		] as const) {
			const a = vaultAddressAt(vault, chain, index);
			const b = vaultAddressAt(vault, chain, index);
			const c = vaultAddressAt(makeVault([1, 2, 3], 2), chain, index);
			expect(b).toBe(a);
			expect(c).toBe(a); // freshly-built equivalent row, same address
		}
	});

	it('matches the multisig library directly (single derivation code path)', () => {
		expect(vaultAddressAt(vault, 0, 0)).toBe(
			deriveVaultAddress(toVaultConfig(vault), 0, 0).address
		);
		expect(vaultAddressAt(vault, 0, 0)).toBe(vaultTestAddress(toVaultConfig(vault)));
		expect(vaultAddressAt(vault, 1, 5)).toBe(
			deriveVaultAddress(toVaultConfig(vault), 1, 5).address
		);
	});

	it('key row order never changes the addresses (BIP-67 sorting)', () => {
		const shuffled = makeVault([3, 1, 2], 2);
		for (let index = 0; index < 10; index++) {
			expect(vaultAddressAt(shuffled, 0, index)).toBe(vaultAddressAt(vault, 0, index));
			expect(vaultAddressAt(shuffled, 1, index)).toBe(vaultAddressAt(vault, 1, index));
		}
	});

	it('receive and change chains are disjoint; consecutive indexes differ', () => {
		const seen = new Set<string>();
		for (let index = 0; index < 25; index++) {
			for (const chain of [0, 1] as const) {
				const addr = vaultAddressAt(vault, chain, index);
				expect(seen.has(addr)).toBe(false);
				seen.add(addr);
			}
		}
		expect(seen.size).toBe(50);
	});

	it('different quorums and key sets give different addresses', () => {
		const threeOfFive = makeVault([1, 2, 3, 4, 5], 3);
		const twoOfThreeOtherKeys = makeVault([4, 5, 6], 2);
		const addr = vaultAddressAt(vault, 0, 0);
		expect(vaultAddressAt(threeOfFive, 0, 0)).not.toBe(addr);
		expect(vaultAddressAt(twoOfThreeOtherKeys, 0, 0)).not.toBe(addr);
		// Same keys, different threshold: different script, different address.
		expect(vaultAddressAt(makeVault([1, 2, 3], 3), 0, 0)).not.toBe(addr);
	});

	it('derives native segwit p2wsh addresses (32-byte program bech32)', () => {
		const addr = vaultAddressAt(vault, 0, 0);
		expect(addr.startsWith('bc1q')).toBe(true);
		expect(addr.length).toBe(62);
	});
});
