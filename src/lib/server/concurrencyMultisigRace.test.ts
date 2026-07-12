// Concurrent multi-user stress — MULTISIG signing/broadcast/bump race surfaces
// (test/qa-wave-2026-07-12, workstream-b; relates to cairn-a857).
//
// DESIGN NOTE — what "concurrent" actually means here. node:sqlite's
// DatabaseSync is SYNCHRONOUS and Node is single-threaded, so two in-process
// callers can only interleave at `await` points in the service layer. A service
// function with NO await between its read and its write is therefore atomic
// against every other in-process caller — there is no race to test, and a test
// that pretends otherwise is theatre. The two categories below are treated
// differently on purpose:
//
//   • attachMultisigSignature — FULLY SYNCHRONOUS (read stored PSBT → normalize
//     → combine → UPDATE → derive progress). Zero awaits. Two "concurrent"
//     cosigner submissions run one-strictly-after-the-other; the second reads
//     the first's already-persisted combined PSBT and unions onto it. Race-free
//     BY CONSTRUCTION. The tests here PIN that guarantee: even when both
//     cosigners independently sign the SAME original base PSBT and submit
//     together, both partial signatures survive and quorum counts correctly (no
//     lost update, no last-writer-wins clobber).
//
//   • buildMultisigDraft / broadcastMultisigTransaction / bumpMultisigTransaction
//     — genuinely ASYNC (they await Electrum/construction). These DO have real
//     interleaving windows, closed respectively by withLock('multisig-draft:id'),
//     the atomic broadcast-claim UPDATE, and the partial-UNIQUE replaces index.
//     The tests fire them via Promise.all and assert the guard holds under N-way
//     contention (disjoint coins / exactly-one-broadcast / one-replacement).
//
// Harness mirrors multisigTransactions.test.ts exactly (same mocks, fixtures,
// signWith) so only the concurrency assertions are new.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getMultisig, toMultisigConfig } from './wallets/multisig';
import { deriveMultisigAddress } from './bitcoin/multisig';
import { constructMultisigPsbt, finalizeMultisigPsbt } from './bitcoin/multisigPsbt';
import type { SpendableUtxo } from './bitcoin/psbt';
import {
	buildMultisigDraft,
	getMultisigTransaction,
	listMultisigTransactions,
	attachMultisigSignature,
	broadcastMultisigTransaction,
	bumpMultisigTransaction,
	multisigTransactionProgress
} from './multisigTransactions';

const { broadcastMock, getTxHexMock, getTxMock, utxosMock, changeIndexMock } = vi.hoisted(() => ({
	broadcastMock: vi.fn(),
	getTxHexMock: vi.fn(),
	getTxMock: vi.fn(),
	utxosMock: vi.fn(),
	changeIndexMock: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: { broadcast: broadcastMock },
		getTxHex: getTxHexMock,
		getTx: getTxMock,
		getTip: async () => ({ height: 900_000, hash: '00'.repeat(32) })
	})
}));
vi.mock('./multisigScan', () => ({
	getMultisigUtxos: utxosMock,
	nextMultisigChangeIndex: changeIndexMock
}));

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transaction_signers; DELETE FROM multisig_shares; DELETE FROM multisig_transactions; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	broadcastMock.mockReset();
	getTxHexMock.mockReset();
	getTxMock.mockReset();
	utxosMock.mockReset();
	changeIndexMock.mockReset();
	changeIndexMock.mockResolvedValue(0);
	setSetting('registration_mode', 'open');
});

const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		account,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		xpub: account.publicExtendedKey
	};
}
const SIGNERS = [1, 2, 3].map(makeSigner);
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

async function seedMultisig(email: string): Promise<{ userId: number; multisigId: number }> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const res = db
		.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'V', 2, 'p2wsh')")
		.run(user.id);
	const multisigId = Number(res.lastInsertRowid);
	const insert = db.prepare(
		`INSERT INTO multisig_keys (multisig_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, 'hardware', 'file', ?, ?, ?)`
	);
	SIGNERS.forEach((s, i) => insert.run(multisigId, i, `Key ${i + 1}`, s.xpub, s.fingerprint, BIP48_PATH));
	return { userId: user.id, multisigId };
}

function multisigUtxos(userId: number, multisigId: number, value = 200_000): SpendableUtxo[] {
	const multisig = getMultisig(userId, multisigId)!;
	return [
		{
			txid: '11'.repeat(32),
			vout: 0,
			value,
			height: 800_000,
			address: deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address,
			chain: 0,
			index: 0
		}
	];
}

async function seedDraft(userId: number, multisigId: number): Promise<{ txId: number; psbt: string }> {
	const multisig = getMultisig(userId, multisigId)!;
	const details = await constructMultisigPsbt({
		config: toMultisigConfig(multisig),
		utxos: multisigUtxos(userId, multisigId),
		recipients: [{ address: RECIPIENT, amount: 50_000 }],
		feeRate: 5,
		changeIndex: 0
	});
	const res = db
		.prepare(
			`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`
		)
		.run(multisigId, details.psbtBase64, RECIPIENT, 50_000, details.fee, details.feeRate, 0);
	return { txId: Number(res.lastInsertRowid), psbt: details.psbtBase64 };
}

function signWith(psbtBase64: string, signerIdx: number): string {
	const signer = SIGNERS[signerIdx];
	const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
	for (let i = 0; i < tx.inputsLength; i++) {
		for (const [pubkey, { path }] of tx.getInput(i).bip32Derivation ?? []) {
			const child = signer.account
				.deriveChild(path[path.length - 2])
				.deriveChild(path[path.length - 1]);
			if (child.publicKey && bytesToHex(child.publicKey) === bytesToHex(pubkey)) {
				tx.signIdx(child.privateKey!, i);
			}
		}
	}
	return base64.encode(tx.toPSBT());
}

function txidOf(rawHex: string): string {
	return Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id;
}

// ── 1. Two cosigners signing the SAME base PSBT concurrently ────────────────
describe('concurrent cosigner signatures on one multisig PSBT', () => {
	it('both partial signatures survive and quorum reaches 2 (no lost update)', async () => {
		const { userId, multisigId } = await seedMultisig('cosign-race@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const multisig = getMultisig(userId, multisigId)!;

		// Each cosigner signs the SAME original draft PSBT independently — exactly
		// what happens when two people open the signing screen at the same time,
		// before either submission lands. They submit together.
		const signedA = signWith(psbt, 0);
		const signedB = signWith(psbt, 1);
		const [ra, rb] = await Promise.all([
			Promise.resolve().then(() => attachMultisigSignature(userId, multisigId, txId, signedA)),
			Promise.resolve().then(() => attachMultisigSignature(userId, multisigId, txId, signedB))
		]);

		// Both calls succeed; whichever ran second observed quorum.
		expect(ra).not.toBeNull();
		expect(rb).not.toBeNull();
		const collectedSeen = [ra!.progress.collected, rb!.progress.collected].sort();
		expect(collectedSeen).toEqual([1, 2]);

		// Authoritative final state, re-read from the DB: both signatures unioned,
		// quorum met — the second attach combined onto the first's persisted PSBT
		// rather than clobbering it.
		const finalTx = getMultisigTransaction(userId, multisigId, txId)!;
		const progress = multisigTransactionProgress(multisig, finalTx)!;
		expect(progress.collected).toBe(2);
		expect(progress.complete).toBe(true);
		expect(progress.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint].sort()
		);
	});

	it('the same signature double-submitted concurrently is idempotent (stays 1)', async () => {
		const { userId, multisigId } = await seedMultisig('double-sig@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const signed = signWith(psbt, 0);

		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				Promise.resolve().then(() => attachMultisigSignature(userId, multisigId, txId, signed))
			)
		);
		for (const r of results) expect(r).not.toBeNull();
		// One signer, one slot — never double-counted no matter how many landed.
		const finalTx = getMultisigTransaction(userId, multisigId, txId)!;
		expect(multisigTransactionProgress(getMultisig(userId, multisigId)!, finalTx)!.collected).toBe(1);
	});
});

// ── 2. Concurrent draft builds must reserve disjoint coins (withLock) ───────
describe('concurrent buildMultisigDraft coin reservation', () => {
	function twoFundedCoins(userId: number, multisigId: number) {
		const config = toMultisigConfig(getMultisig(userId, multisigId)!);
		const addrA = deriveMultisigAddress(config, 0, 0).address;
		const addrB = deriveMultisigAddress(config, 0, 1).address;
		const fundA = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundA.addInput({ txid: '00'.repeat(32), index: 0 });
		fundA.addOutputAddress(addrA, 200_000n, NETWORK);
		const fundB = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundB.addInput({ txid: '00'.repeat(32), index: 1 });
		fundB.addOutputAddress(addrB, 150_000n, NETWORK);
		utxosMock.mockResolvedValue([
			{ txid: fundA.id, vout: 0, value: 200_000, height: 800_000, address: addrA, chain: 0, index: 0 },
			{ txid: fundB.id, vout: 0, value: 150_000, height: 800_000, address: addrB, chain: 0, index: 1 }
		]);
		getTxHexMock.mockImplementation(async (txid: string) => {
			if (txid === fundA.id) return fundA.hex;
			if (txid === fundB.id) return fundB.hex;
			throw new Error(`unexpected txid ${txid}`);
		});
	}

	it('two builds fired together select non-overlapping inputs', async () => {
		const { userId, multisigId } = await seedMultisig('concurrent-build@example.com');
		twoFundedCoins(userId, multisigId);

		const [r1, r2] = await Promise.all([
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 }),
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		]);

		const keys1 = new Set(r1.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		const keys2 = new Set(r2.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		expect(keys1.size).toBeGreaterThan(0);
		expect(keys2.size).toBeGreaterThan(0);
		for (const k of keys2) expect(keys1.has(k)).toBe(false);

		// Two distinct persisted drafts, no coin double-reserved across them.
		const drafts = listMultisigTransactions(userId, multisigId)!;
		expect(drafts).toHaveLength(2);
	});
});

// ── 3. N-way concurrent broadcast → exactly one reaches the network ─────────
describe('concurrent broadcastMultisigTransaction (atomic claim)', () => {
	async function signedToQuorum(userId: number, multisigId: number): Promise<number> {
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		attachMultisigSignature(userId, multisigId, txId, signWith(first.transaction.psbt, 1));
		return txId;
	}

	it('four simultaneous broadcasts: one completes, three are refused, network hit once', async () => {
		const { userId, multisigId } = await seedMultisig('bcast-storm@example.com');
		const txId = await signedToQuorum(userId, multisigId);
		const want = finalizeMultisigPsbt(getMultisigTransaction(userId, multisigId, txId)!.psbt).txid;

		// Honest server: echoes the real txid of whatever bytes it is handed. Only
		// the single claim-winner should ever call it.
		broadcastMock.mockImplementation((rawHex: string) => Promise.resolve(txidOf(rawHex)));

		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () => broadcastMultisigTransaction(userId, multisigId, txId))
		);
		const fulfilled = settled.filter((s) => s.status === 'fulfilled');
		const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

		expect(fulfilled).toHaveLength(1);
		expect((fulfilled[0] as PromiseFulfilledResult<{ txid: string }>).value.txid).toBe(want);
		expect(rejected).toHaveLength(3);
		for (const r of rejected) expect(r.reason).toMatchObject({ code: 'already_sent' });
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(getMultisigTransaction(userId, multisigId, txId)!.status).toBe('completed');
	});
});

// ── 4. Concurrent RBF bumps of one original → one live replacement ──────────
describe('concurrent bumpMultisigTransaction (partial-UNIQUE replaces guard)', () => {
	async function seedBroadcast(userId: number, multisigId: number): Promise<{ txId: number }> {
		const multisig = getMultisig(userId, multisigId)!;
		const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, 200_000n, NETWORK);
		const details = await constructMultisigPsbt({
			config: toMultisigConfig(multisig),
			utxos: [{ txid: fundTx.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		const res = db
			.prepare(
				`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, txid)
				 VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(multisigId, details.psbtBase64, RECIPIENT, 50_000, details.fee, details.feeRate, 0, 'aa'.repeat(32));
		getTxHexMock.mockResolvedValue(fundTx.hex);
		return { txId: Number(res.lastInsertRowid) };
	}

	it('two bumps of the same original: exactly one replacement, the loser gets already_replaced', async () => {
		const { userId, multisigId } = await seedMultisig('bump-race@example.com');
		const { txId } = await seedBroadcast(userId, multisigId);

		const settled = await Promise.allSettled([
			bumpMultisigTransaction(userId, multisigId, txId, 25),
			bumpMultisigTransaction(userId, multisigId, txId, 40)
		]);
		const fulfilled = settled.filter((s) => s.status === 'fulfilled');
		const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toMatchObject({ code: 'already_replaced' });

		// Only ONE replacement draft ever lands (the partial-UNIQUE index on
		// (multisig_id, replaces_txid) is the atomic guard, not the friendly SELECT).
		const replacements = listMultisigTransactions(userId, multisigId)!.filter((t) => t.replacesTxid);
		expect(replacements).toHaveLength(1);
	});
});
