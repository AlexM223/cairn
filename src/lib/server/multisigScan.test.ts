import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { deriveMultisigAddress, multisigTestAddress, multisigToDescriptor } from './bitcoin/multisig';
import {
	toMultisigConfig,
	createMultisig,
	getMultisig,
	bumpReceiveCursor,
	type MultisigKeyRow,
	type MultisigRow,
	type NewMultisigKey
} from './wallets/multisig';
import {
	multisigAddressAt,
	nextMultisigReceiveAddress,
	primeMultisigScanCache,
	type MultisigScanResult
} from './multisigScan';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';

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

// ---- cairn-2qa4: concurrent receive-address issuance never double-hands-out --

function wipeDb(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

async function makeUser(email: string) {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	});
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

function makeStoredMultisig(userId: number, name: string, seedBytes: number[] = [21, 22, 23]): MultisigRow {
	return createMultisig(userId, {
		name,
		threshold: 2,
		keys: seedBytes.map((b, i) => newMultisigInputKey(b, `Key ${i + 1}`))
	});
}

function cacheKeyFor(multisig: MultisigRow): string {
	return multisigToDescriptor(toMultisigConfig(multisig));
}

const EMPTY_SCAN: MultisigScanResult = {
	addresses: [],
	txs: [],
	confirmed: 0,
	unconfirmed: 0,
	scanTruncated: false
};

describe('nextMultisigReceiveAddress concurrency and cursor safety (cairn-2qa4)', () => {
	beforeEach(() => {
		wipeDb();
		setSetting('registration_mode', 'open');
	});

	it('two concurrent calls for the same multisig serialize and hand out different indexes', async () => {
		const user = await makeUser('ms-race@example.com');
		const multisig = makeStoredMultisig(user.id, 'Race vault');
		// Prime the scan cache so the "next unused" lookup resolves instantly and
		// deterministically (no Electrum, no timing flakiness). Determinism here
		// comes from withLock's own promise-chaining (keyedLock.ts): the second
		// call's body cannot begin until the first has fully completed — including
		// its DB write — independent of how fast the scan itself resolves.
		primeMultisigScanCache(cacheKeyFor(multisig), EMPTY_SCAN);

		const [r1, r2] = await Promise.all([
			nextMultisigReceiveAddress(multisig),
			nextMultisigReceiveAddress(multisig)
		]);

		expect(r1.index).not.toBe(r2.index);
		expect([r1.index, r2.index].sort()).toEqual([0, 1]);
		expect(r1.address).not.toBe(r2.address);
		expect(getMultisig(user.id, multisig.id)!.receiveCursor).toBe(2);
	});

	it("re-reads the cursor under the lock instead of trusting the caller's stale row", async () => {
		const user = await makeUser('ms-stale@example.com');
		const multisig = makeStoredMultisig(user.id, 'Stale-row vault', [24, 25, 26]);
		primeMultisigScanCache(cacheKeyFor(multisig), EMPTY_SCAN);

		// The route pattern: one MultisigRow is loaded once, then reused across
		// calls (e.g. two requests racing on the same in-memory row). The first
		// call advances the DB cursor, but never mutates the caller's copy.
		const first = await nextMultisigReceiveAddress(multisig);
		expect(first.index).toBe(0);
		expect(multisig.receiveCursor).toBe(0); // caller's in-memory copy is untouched

		// A second call reusing that same stale row must still observe the DB's
		// advanced cursor and hand out a fresh index rather than repeat index 0.
		const second = await nextMultisigReceiveAddress(multisig);
		expect(second.index).toBe(1);
		expect(second.address).not.toBe(first.address);
	});

	it('bumpReceiveCursor writes MAX(): a lower/late write can never regress the cursor', async () => {
		const user = await makeUser('ms-monotonic@example.com');
		const multisig = makeStoredMultisig(user.id, 'Monotonic vault', [27, 28, 29]);

		bumpReceiveCursor(user.id, multisig.id, 10);
		expect(getMultisig(user.id, multisig.id)!.receiveCursor).toBe(11);

		// A late/out-of-order writer proposing a lower cursor must not win.
		bumpReceiveCursor(user.id, multisig.id, 2);
		expect(getMultisig(user.id, multisig.id)!.receiveCursor).toBe(11);

		// A genuinely higher write still advances it normally.
		bumpReceiveCursor(user.id, multisig.id, 15);
		expect(getMultisig(user.id, multisig.id)!.receiveCursor).toBe(16);
	});
});
