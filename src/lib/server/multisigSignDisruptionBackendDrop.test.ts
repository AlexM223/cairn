// cairn-a857 — mid-operation disruption: chain backend (Electrum/Core RPC)
// dies WHILE a multisig signing session is in progress (between cosigner
// signature submissions).
//
// Harness mirrors concurrencyMultisigRace.test.ts / multisigTransactions.test.ts
// exactly (same mocks/fixtures/signWith). The key structural fact this file
// pins (see multisigTransactions.ts's own file header): attachMultisigSignature
// is FULLY SYNCHRONOUS — read stored PSBT -> normalize -> combine -> UPDATE ->
// derive progress — with NO network call anywhere in it. So "the chain backend
// dies between cosigner signature submissions" cannot corrupt or block
// signature collection at all; only buildMultisigDraft (needs live UTXOs) and
// broadcastMultisigTransaction (needs to actually send bytes) touch the chain.
// The tests below prove that split empirically rather than assuming it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Transaction } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getMultisig, toMultisigConfig } from './wallets/multisig';
import { constructMultisigPsbt, finalizeMultisigPsbt } from './bitcoin/multisigPsbt';
import {
	buildMultisigDraft,
	getMultisigTransaction,
	attachMultisigSignature,
	broadcastMultisigTransaction,
	multisigTransactionProgress
} from './multisigTransactions';
import { BroadcastError } from './transactions';

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
		getTip: async () => ({ height: 900_000, hash: '00'.repeat(32) }),
		getMinFeeRate: async () => 1
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

function multisigUtxos(userId: number, multisigId: number, value = 200_000) {
	const multisig = getMultisig(userId, multisigId)!;
	return [
		{
			txid: '11'.repeat(32),
			vout: 0,
			value,
			height: 800_000,
			address: undefined as unknown as string, // filled below via deriveMultisigAddress
			chain: 0 as const,
			index: 0
		}
	];
}

async function seedDraft(userId: number, multisigId: number): Promise<{ txId: number; psbt: string }> {
	const multisig = getMultisig(userId, multisigId)!;
	const config = toMultisigConfig(multisig);
	const { deriveMultisigAddress } = await import('./bitcoin/multisig');
	const utxos = multisigUtxos(userId, multisigId).map((u) => ({
		...u,
		address: deriveMultisigAddress(config, 0, 0).address
	}));
	const details = await constructMultisigPsbt({
		config,
		utxos,
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

/** Every chain call this multisig flow could make fails, mimicking a fully
 *  dead Electrum/Core RPC backend. */
function killBackend(): void {
	utxosMock.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));
	getTxHexMock.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));
	getTxMock.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));
	broadcastMock.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));
}

// ═══════════════════════ 1. building a NEW draft needs the chain — fails loudly

describe('backend dead before a draft even exists (buildMultisigDraft)', () => {
	it('a dead backend at draft-build time throws cleanly and writes no row', async () => {
		const { userId, multisigId } = await seedMultisig('ms-build-dead@example.com');
		killBackend();

		await expect(
			buildMultisigDraft(userId, multisigId, {
				recipients: [{ address: RECIPIENT, amount: 10_000 }],
				feeRate: 5
			})
		).rejects.toThrow(/ECONNRESET|connection/i);

		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM multisig_transactions WHERE multisig_id = ?')
			.get(multisigId) as { n: number };
		expect(n).toBe(0);
	});
});

// ═══════════════ 2. backend dies AFTER the draft exists, WHILE signatures collect

describe('backend dies between cosigner signature submissions (the bead\'s core scenario)', () => {
	it('GREEN: attachMultisigSignature has ZERO network dependency — signing proceeds normally with the backend fully dead', async () => {
		const { userId, multisigId } = await seedMultisig('ms-sign-dead-backend@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const multisig = getMultisig(userId, multisigId)!;

		// The draft was built while the backend was healthy; NOW it dies, mid
		// signing session — exactly the bead's scenario.
		killBackend();

		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0));
		expect(first).not.toBeNull();
		expect(first!.progress.collected).toBe(1);
		expect(first!.transaction.status).toBe('awaiting_signature');

		const second = attachMultisigSignature(userId, multisigId, txId, signWith(first!.transaction.psbt, 1));
		expect(second).not.toBeNull();
		expect(second!.progress.collected).toBe(2);
		expect(second!.progress.complete).toBe(true);
		// Quorum is complete, but broadcast hasn't happened — still the
		// pre-broadcast status, not silently anything else.
		expect(second!.transaction.status).toBe('awaiting_signature');

		// No chain call was ever made by either attach.
		expect(utxosMock).not.toHaveBeenCalled();
		expect(getTxHexMock).not.toHaveBeenCalled();
		expect(broadcastMock).not.toHaveBeenCalled();

		// The PSBT is not corrupted: re-reading it and recomputing progress from
		// scratch agrees with what attach returned.
		const reread = getMultisigTransaction(userId, multisigId, txId)!;
		const progress = multisigTransactionProgress(multisig, reread)!;
		expect(progress.collected).toBe(2);
		expect(progress.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint].sort()
		);
	});

	it('a quorum-complete PSBT cannot broadcast while the backend is dead — clean BroadcastError, stays awaiting_signature', async () => {
		const { userId, multisigId } = await seedMultisig('ms-sign-then-broadcast-dead@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		attachMultisigSignature(userId, multisigId, txId, signWith(first.transaction.psbt, 1));

		killBackend();

		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toBeInstanceOf(
			BroadcastError
		);

		const row = db
			.prepare('SELECT status, txid, broadcast_started_at FROM multisig_transactions WHERE id = ?')
			.get(txId) as { status: string; txid: string | null; broadcast_started_at: string | null };
		expect(row.status).toBe('awaiting_signature');
		expect(row.txid).toBeNull();
		// The claim was released — not stuck "in flight" because the network
		// call itself never got a chance to run.
		expect(row.broadcast_started_at).toBeNull();
	});

	it('the flow resumes cleanly once the backend returns: same fully-signed PSBT broadcasts on retry', async () => {
		const { userId, multisigId } = await seedMultisig('ms-sign-then-recover@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		attachMultisigSignature(userId, multisigId, txId, signWith(first.transaction.psbt, 1));

		killBackend();
		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toBeInstanceOf(
			BroadcastError
		);

		// Backend recovers.
		const want = finalizeMultisigPsbt(getMultisigTransaction(userId, multisigId, txId)!.psbt).txid;
		broadcastMock.mockImplementation((rawHex: string) => Promise.resolve(txidOf(rawHex)));

		const result = await broadcastMultisigTransaction(userId, multisigId, txId);
		expect(result.txid).toBe(want);
		expect(getMultisigTransaction(userId, multisigId, txId)!.status).toBe('completed');
	});

	it('a THIRD signer can still attach after a failed broadcast attempt (over-collection stays harmless)', async () => {
		// Sanity that a failed broadcast attempt in between doesn't somehow lock
		// out further attaches on a 2-of-3 multisig with a spare signer.
		const { userId, multisigId } = await seedMultisig('ms-third-signer@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		const second = attachMultisigSignature(userId, multisigId, txId, signWith(first.transaction.psbt, 1))!;
		expect(second.progress.complete).toBe(true);

		killBackend();
		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toBeInstanceOf(
			BroadcastError
		);

		// A third signature (belt-and-suspenders redundancy) still attaches
		// without error even though quorum was already met and a broadcast
		// attempt already failed in between.
		const third = attachMultisigSignature(userId, multisigId, txId, signWith(second.transaction.psbt, 2));
		expect(third).not.toBeNull();
		expect(third!.progress.collected).toBe(3);
	});
});
