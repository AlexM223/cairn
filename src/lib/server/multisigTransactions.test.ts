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
import { constructMultisigPsbt, MultisigPsbtError, finalizeMultisigPsbt } from './bitcoin/multisigPsbt';
import type { SpendableUtxo } from './bitcoin/psbt';
import {
	buildMultisigDraft,
	getMultisigTransaction,
	listMultisigTransactions,
	attachMultisigSignature,
	deleteMultisigTransaction,
	broadcastMultisigTransaction,
	bumpMultisigTransaction,
	buildMultisigCpfpDraft,
	detectMultisigUnconfirmedInflows,
	multisigTransactionProgress
} from './multisigTransactions';
import { BroadcastError, BumpError, CpfpError } from './transactions';
import { isRosterMember } from './multisigRoster';

// Only the network edges are faked: the chain source and the multisig scanner
// (whose UTXOs would otherwise come from Electrum). Everything else — multisig
// rows, PSBT construction, signature merging, quorum math, the broadcast
// claim — runs the real code path.
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
		// buildMultisigDraft reads the tip for the coinbase-maturity guard.
		getTip: async () => ({ height: 900_000, hash: '00'.repeat(32) })
	})
}));
vi.mock('./multisigScan', () => ({
	getMultisigUtxos: utxosMock,
	nextMultisigChangeIndex: changeIndexMock
}));

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transactions; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
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

// ── fixtures: a real 2-of-3 multisig whose keys the tests can actually sign with
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

/** A confirmed coin sitting on the multisig's real 0/0 address. */
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

async function seedDraft(
	userId: number,
	multisigId: number
): Promise<{ txId: number; psbt: string }> {
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

/** Sign every input with one cosigner via the embedded derivations. */
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

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('multisig transaction lifecycle', () => {
	it('scopes reads to the owning user', async () => {
		const alice = await seedMultisig('alice@example.com');
		const bob = await seedMultisig('bob@example.com');
		const { txId } = await seedDraft(alice.userId, alice.multisigId);

		expect(getMultisigTransaction(alice.userId, alice.multisigId, txId)).not.toBeNull();
		expect(getMultisigTransaction(bob.userId, bob.multisigId, txId)).toBeNull();
		expect(getMultisigTransaction(bob.userId, alice.multisigId, txId)).toBeNull();
		expect(listMultisigTransactions(bob.userId, alice.multisigId)).toBeNull();
	});

	it('builds and persists a draft from scanned UTXOs (buildMultisigDraft)', async () => {
		const { userId, multisigId } = await seedMultisig('build@example.com');
		// buildMultisigDraft attaches full previous transactions (fee-lying
		// protection), so the mocked coin must reference a REAL funding tx whose
		// id verifies against the returned hex.
		const multisig = getMultisig(userId, multisigId)!;
		const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, 200_000n, NETWORK);
		utxosMock.mockResolvedValue([
			{ txid: fundTx.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }
		]);
		getTxHexMock.mockResolvedValue(fundTx.hex);
		changeIndexMock.mockResolvedValue(3);

		const { draft, details } = await buildMultisigDraft(userId, multisigId, {
			recipients: [{ address: RECIPIENT, amount: 40_000 }],
			feeRate: 5
		});
		expect(draft.status).toBe('draft');
		expect(draft.amount).toBe(40_000);
		expect(draft.recipient).toBe(RECIPIENT);
		expect(draft.changeIndex).toBe(3);
		expect(details.change?.index).toBe(3);
		expect(multisigTransactionProgress(multisig, draft)).toMatchObject({
			required: 2,
			collected: 0,
			complete: false
		});
	});

	it('deletes drafts but keeps completed transactions', async () => {
		const { userId, multisigId } = await seedMultisig('del@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		const done = await seedDraft(userId, multisigId);
		db.prepare(
			"UPDATE multisig_transactions SET status = 'completed', txid = ? WHERE id = ?"
		).run('ff'.repeat(32), done.txId);

		expect(deleteMultisigTransaction(userId, multisigId, txId)).toBe(true);
		expect(getMultisigTransaction(userId, multisigId, txId)).toBeNull();
		expect(deleteMultisigTransaction(userId, multisigId, done.txId)).toBe(false);
		expect(getMultisigTransaction(userId, multisigId, done.txId)).not.toBeNull();
	});

	// cairn-up0q: the old check-then-delete raced broadcastMultisigTransaction's
	// atomic claim — a delete could land between the claim and the trailing
	// status='completed' update, wiping a row for a tx already on the
	// network. Simulate the claim directly and assert the delete is refused.
	it('refuses to delete a multisig transaction with an in-flight broadcast claim', async () => {
		const { userId, multisigId } = await seedMultisig('claim@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		db.prepare(
			"UPDATE multisig_transactions SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
		).run(txId);

		expect(deleteMultisigTransaction(userId, multisigId, txId)).toBe(false);
		expect(getMultisigTransaction(userId, multisigId, txId)).not.toBeNull();
	});

	// cairn-up0q: deleteMultisigTransaction used to only exclude 'completed',
	// unlike single-sig deleteTransaction which excludes 'completed' and
	// 'superseded'. A superseded tx was broadcast too (its replacement is what
	// actually confirms) — deleting it erases that history the same way
	// deleting a completed tx would.
	it('refuses to delete a superseded multisig transaction', async () => {
		const { userId, multisigId } = await seedMultisig('superseded@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		db.prepare(
			"UPDATE multisig_transactions SET status = 'superseded', txid = ? WHERE id = ?"
		).run('ee'.repeat(32), txId);

		expect(deleteMultisigTransaction(userId, multisigId, txId)).toBe(false);
		expect(getMultisigTransaction(userId, multisigId, txId)).not.toBeNull();
	});

	it('cascades multisig deletion to its transactions', async () => {
		const { userId, multisigId } = await seedMultisig('cascade@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		db.prepare('DELETE FROM multisigs WHERE id = ?').run(multisigId);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM multisig_transactions WHERE id = ?').get(txId)
		).toMatchObject({ n: 0 });
	});
});

// ── attach (per-key signature merging) ───────────────────────────────────────

describe('attachMultisigSignature', () => {
	it('merges one signature at a time and reports live quorum progress', async () => {
		const { userId, multisigId } = await seedMultisig('attach@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);

		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		expect(first.transaction.status).toBe('awaiting_signature');
		expect(first.progress).toMatchObject({ required: 2, collected: 1, complete: false });
		expect(first.progress.signedFingerprints).toEqual([SIGNERS[0].fingerprint]);

		// The second key signs the CURRENT stored PSBT (prior signature intact).
		const second = attachMultisigSignature(
			userId,
			multisigId,
			txId,
			signWith(first.transaction.psbt, 1)
		)!;
		expect(second.progress).toMatchObject({ required: 2, collected: 2, complete: true });
		expect(second.progress.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint].sort()
		);
	});

	it('is idempotent when the same signed PSBT is submitted twice', async () => {
		const { userId, multisigId } = await seedMultisig('idem@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const signed = signWith(psbt, 0);
		const once = attachMultisigSignature(userId, multisigId, txId, signed)!;
		const twice = attachMultisigSignature(userId, multisigId, txId, signed)!;
		expect(once.progress.collected).toBe(1);
		expect(twice.progress.collected).toBe(1);
	});

	it('refuses a signed PSBT for a different transaction (substitution guard)', async () => {
		const { userId, multisigId } = await seedMultisig('subst@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		const multisig = getMultisig(userId, multisigId)!;
		const other = await constructMultisigPsbt({
			config: toMultisigConfig(multisig),
			utxos: multisigUtxos(userId, multisigId),
			recipients: [{ address: RECIPIENT, amount: 60_000 }], // different amount
			feeRate: 5,
			changeIndex: 0
		});
		expect(() =>
			attachMultisigSignature(userId, multisigId, txId, signWith(other.psbtBase64, 0))
		).toThrow(MultisigPsbtError);
		// And nothing was stored: progress stays at zero.
		const tx = getMultisigTransaction(userId, multisigId, txId)!;
		expect(multisigTransactionProgress(multisig, tx)?.collected).toBe(0);
	});

	it('refuses corrupt uploads with the corruption message', async () => {
		const { userId, multisigId } = await seedMultisig('corrupt@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const corrupt = base64.encode(base64.decode(psbt).slice(0, 20));
		expect(() => attachMultisigSignature(userId, multisigId, txId, corrupt)).toThrow(
			/truncated or corrupted/
		);
	});

	it('refuses attaching to an already-broadcast transaction', async () => {
		const { userId, multisigId } = await seedMultisig('late@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		db.prepare(
			"UPDATE multisig_transactions SET status = 'completed', txid = ? WHERE id = ?"
		).run('aa'.repeat(32), txId);
		expect(() => attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))).toThrow(
			BroadcastError
		);
	});
});

// ── broadcast (quorum gate + atomic claim) ───────────────────────────────────

describe('broadcastMultisigTransaction', () => {
	async function signedToQuorum(userId: number, multisigId: number) {
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		attachMultisigSignature(userId, multisigId, txId, signWith(first.transaction.psbt, 1));
		return txId;
	}

	/** The true txid of a raw tx — what an honest Electrum server echoes back on
	 *  broadcast (equals the locally-computed finalized.txid the code now checks). */
	function txidOf(rawHex: string): string {
		return Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id;
	}

	/** Make the broadcast mock behave like an honest server: return the real txid
	 *  of whatever bytes it is handed, so it matches the code's local computation. */
	function honestBroadcastOnce(): void {
		broadcastMock.mockImplementationOnce((rawHex: string) => Promise.resolve(txidOf(rawHex)));
	}

	it('refuses to broadcast below quorum with "X of M signatures collected"', async () => {
		const { userId, multisigId } = await seedMultisig('quorum@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0)); // 1 of 2

		const p = broadcastMultisigTransaction(userId, multisigId, txId);
		await expect(p).rejects.toMatchObject({ code: 'incomplete' });
		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toThrow(
			/1 of 2 signatures collected/
		);
		expect(broadcastMock).not.toHaveBeenCalled();
	});

	it('broadcasts a quorum-complete transaction and records the LOCALLY-computed txid', async () => {
		const { userId, multisigId } = await seedMultisig('send@example.com');
		const txId = await signedToQuorum(userId, multisigId);
		honestBroadcastOnce();

		const { txid, transaction } = await broadcastMultisigTransaction(userId, multisigId, txId);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe(txid);
		expect(broadcastMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a broadcast whose server-reported txid differs from ours (cairn-ziwm)', async () => {
		const { userId, multisigId } = await seedMultisig('forge@example.com');
		const txId = await signedToQuorum(userId, multisigId);
		// A server claiming success with an invented txid for a broadcast it never did.
		broadcastMock.mockResolvedValueOnce('cc'.repeat(32));

		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		const after = getMultisigTransaction(userId, multisigId, txId);
		expect(after?.txid).toBeNull();
		expect(after?.status).not.toBe('completed');
	});

	it('accepts the final signature riding along with the broadcast call', async () => {
		const { userId, multisigId } = await seedMultisig('ride@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);
		const first = attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 0))!;
		honestBroadcastOnce();

		const { txid } = await broadcastMultisigTransaction(
			userId,
			multisigId,
			txId,
			signWith(first.transaction.psbt, 2) // key 3 completes the quorum here
		);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('lets exactly one of two concurrent broadcasts through (atomic claim)', async () => {
		const { userId, multisigId } = await seedMultisig('race@example.com');
		const txId = await signedToQuorum(userId, multisigId);

		// The honest txid the server will echo back (matches the code's local check).
		const want = finalizeMultisigPsbt(getMultisigTransaction(userId, multisigId, txId)!.psbt).txid;
		let resolveBroadcast!: (txid: string) => void;
		broadcastMock.mockImplementationOnce(
			() => new Promise<string>((res) => (resolveBroadcast = res))
		);
		const first = broadcastMultisigTransaction(userId, multisigId, txId);
		const second = broadcastMultisigTransaction(userId, multisigId, txId);
		await expect(second).rejects.toMatchObject({ code: 'already_sent' });

		resolveBroadcast(want);
		const winner = await first;
		expect(winner.txid).toBe(want);
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(getMultisigTransaction(userId, multisigId, txId)?.status).toBe('completed');
	});

	it('releases the claim when the network rejects, so a retry works', async () => {
		const { userId, multisigId } = await seedMultisig('retry@example.com');
		const txId = await signedToQuorum(userId, multisigId);

		broadcastMock.mockRejectedValueOnce(new Error('mempool full'));
		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		const afterFailure = getMultisigTransaction(userId, multisigId, txId);
		expect(afterFailure?.txid).toBeNull();
		expect(afterFailure?.status).not.toBe('completed');

		honestBroadcastOnce();
		const retry = await broadcastMultisigTransaction(userId, multisigId, txId);
		expect(retry.txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses double-broadcast of a completed transaction before touching the network', async () => {
		const { userId, multisigId } = await seedMultisig('done@example.com');
		const txId = await signedToQuorum(userId, multisigId);
		honestBroadcastOnce();
		await broadcastMultisigTransaction(userId, multisigId, txId);
		broadcastMock.mockClear();

		await expect(broadcastMultisigTransaction(userId, multisigId, txId)).rejects.toMatchObject({
			code: 'already_sent'
		});
		expect(broadcastMock).not.toHaveBeenCalled();
	});
});

// ── RBF fee bump (cairn-mklv) ────────────────────────────────────────────────
describe('bumpMultisigTransaction (RBF)', () => {
	// A COMPLETED (broadcast) multisig tx whose stored PSBT carries a real,
	// recoverable coin, so the bump can reconstruct it verbatim. getTxHexMock is
	// primed with the coin's funding tx (the rebuild attaches it as nonWitnessUtxo).
	async function seedBroadcast(userId: number, multisigId: number) {
		const multisig = getMultisig(userId, multisigId)!;
		const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, 200_000n, NETWORK);
		const details = await constructMultisigPsbt({
			config: toMultisigConfig(multisig),
			utxos: [
				{ txid: fundTx.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }
			],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		const txid = 'aa'.repeat(32);
		const res = db
			.prepare(
				`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, txid)
				 VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(multisigId, details.psbtBase64, RECIPIENT, 50_000, details.fee, details.feeRate, 0, txid);
		getTxHexMock.mockResolvedValue(fundTx.hex);
		return { txId: Number(res.lastInsertRowid), txid, fee: details.fee, rate: details.feeRate, fundTx };
	}

	it('builds a higher-fee replacement: same inputs/recipients, replaces_txid set', async () => {
		const { userId, multisigId } = await seedMultisig('bump@example.com');
		const orig = await seedBroadcast(userId, multisigId);
		const { draft, details } = await bumpMultisigTransaction(userId, multisigId, orig.txId, 25);
		expect(draft.status).toBe('draft');
		expect(draft.replacesTxid).toBe(orig.txid);
		expect(draft.recipient).toBe(RECIPIENT);
		expect(draft.amount).toBe(50_000);
		expect(details.fee).toBeGreaterThan(orig.fee);
		// Exactly the original's single input, reproduced.
		expect(details.inputs).toHaveLength(1);
		expect(details.inputs[0].txid).toBe(orig.fundTx.id);
	});

	it('rejects a fee rate not higher than the original', async () => {
		const { userId, multisigId } = await seedMultisig('low@example.com');
		const orig = await seedBroadcast(userId, multisigId);
		await expect(
			bumpMultisigTransaction(userId, multisigId, orig.txId, orig.rate)
		).rejects.toThrow(BumpError);
	});

	it('refuses to bump a draft that was never broadcast', async () => {
		const { userId, multisigId } = await seedMultisig('draft@example.com');
		const { txId } = await seedDraft(userId, multisigId);
		await expect(bumpMultisigTransaction(userId, multisigId, txId, 25)).rejects.toMatchObject({
			code: 'not_bumpable'
		});
	});

	it('allows only one live replacement per original', async () => {
		const { userId, multisigId } = await seedMultisig('dup@example.com');
		const orig = await seedBroadcast(userId, multisigId);
		await bumpMultisigTransaction(userId, multisigId, orig.txId, 25);
		await expect(bumpMultisigTransaction(userId, multisigId, orig.txId, 40)).rejects.toMatchObject({
			code: 'already_replaced'
		});
	});

	it('marks the original superseded once the replacement broadcasts', async () => {
		const { userId, multisigId } = await seedMultisig('sup@example.com');
		const orig = await seedBroadcast(userId, multisigId);
		const { draft } = await bumpMultisigTransaction(userId, multisigId, orig.txId, 25);
		// Sign the replacement to quorum and broadcast it honestly.
		const first = attachMultisigSignature(userId, multisigId, draft.id, signWith(draft.psbt, 0))!;
		attachMultisigSignature(userId, multisigId, draft.id, signWith(first.transaction.psbt, 1));
		broadcastMock.mockImplementation(async (rawHex: string) =>
			Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, disableScriptCheck: true }).id
		);
		await broadcastMultisigTransaction(userId, multisigId, draft.id);
		expect(getMultisigTransaction(userId, multisigId, orig.txId)?.status).toBe('superseded');
	});
});

describe('buildMultisigCpfpDraft (CPFP parity, cairn-u9ob.6)', () => {
	/** An UNCONFIRMED coin on the multisig's 0/0 address, funded by a REAL parent
	 *  tx (so the CPFP builder can attach its nonWitnessUtxo). Primes getTxHexMock
	 *  with the parent hex and returns its real txid. */
	function stubUnconfirmedParent(
		userId: number,
		multisigId: number,
		value = 200_000
	): { parentTxid: string; utxos: SpendableUtxo[] } {
		const multisig = getMultisig(userId, multisigId)!;
		const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, BigInt(value), NETWORK);
		getTxHexMock.mockResolvedValue(fundTx.hex);
		return {
			parentTxid: fundTx.id,
			utxos: [{ txid: fundTx.id, vout: 0, value, height: 0, address, chain: 0, index: 0 }]
		};
	}

	it('forces the stuck output as input and prices the package at the target rate', async () => {
		const { userId, multisigId } = await seedMultisig('cpfp@example.com');
		const { parentTxid, utxos } = stubUnconfirmedParent(userId, multisigId);
		utxosMock.mockResolvedValue(utxos);
		// Parent: 200 vB @ 200 sat (1 sat/vB), still unconfirmed.
		getTxMock.mockResolvedValue({ confirmed: false, rbf: true, vsize: 200, fee: 200 });

		const { draft, details, cpfp } = await buildMultisigCpfpDraft(userId, multisigId, parentTxid, 10);

		// The child spends exactly the qualifying unconfirmed output.
		expect(details.inputs).toHaveLength(1);
		expect(details.inputs[0].txid).toBe(parentTxid);
		// Package (parent + child) averages the 10 sat/vB target.
		expect((cpfp.parentFee + details.fee) / (cpfp.parentVsize + details.vsize)).toBeCloseTo(10, 1);
		// Persisted as a fresh draft (no replaces_txid — CPFP is not a replacement).
		expect(draft.replacesTxid).toBeNull();
		expect(draft.status).toBe('draft');
	});

	it('refuses when the vault has no unconfirmed output on that transaction', async () => {
		const { userId, multisigId } = await seedMultisig('cpfp-none@example.com');
		const PARENT = 'ac'.repeat(32);
		// The only coin is CONFIRMED — nothing to CPFP.
		utxosMock.mockResolvedValue(multisigUtxos(userId, multisigId));
		getTxMock.mockResolvedValue({ confirmed: false, rbf: true, vsize: 200, fee: 200 });
		await expect(
			buildMultisigCpfpDraft(userId, multisigId, PARENT, 10)
		).rejects.toMatchObject({ code: 'no_unconfirmed_output' });
	});

	it('refuses to CPFP an already-confirmed parent', async () => {
		const { userId, multisigId } = await seedMultisig('cpfp-conf@example.com');
		const { parentTxid, utxos } = stubUnconfirmedParent(userId, multisigId);
		utxosMock.mockResolvedValue(utxos);
		getTxMock.mockResolvedValue({ confirmed: true, rbf: true, vsize: 200, fee: 200 });
		await expect(
			buildMultisigCpfpDraft(userId, multisigId, parentTxid, 10)
		).rejects.toBeInstanceOf(CpfpError);
	});

	it('detects the unconfirmed inflow and routes our own tx to RBF', async () => {
		const { userId, multisigId } = await seedMultisig('cpfp-detect@example.com');
		const { parentTxid, utxos } = stubUnconfirmedParent(userId, multisigId);
		utxosMock.mockResolvedValue(utxos);
		getTxMock.mockResolvedValue({ confirmed: false, rbf: true, vsize: 200, fee: 200 });
		// Record the parent as a tx this vault broadcast, so it's our own change.
		db.prepare(
			"INSERT INTO multisig_transactions (multisig_id, status, psbt, txid, recipient, amount, fee, fee_rate) VALUES (?, 'completed', '', ?, ?, 1, 1, 1)"
		).run(multisigId, parentTxid, RECIPIENT);
		const inflows = (await detectMultisigUnconfirmedInflows(userId, multisigId))!;
		expect(inflows).toHaveLength(1);
		expect(inflows[0].txid).toBe(parentTxid);
		expect(inflows[0].action).toBe('rbf'); // ours + signals RBF
	});
});

// ── cross-actor authorization (cairn-idgc) ───────────────────────────────────
//
// broadcast / bump / delete are OWNER-ONLY (they gate on getMultisig directly,
// which matches only the owner's user_id), even though building and signing are
// cosigner-reachable. attachMultisigSignature adds a per-transaction ROSTER gate
// on top of the wallet-level signable gate: a wallet cosigner may only sign a
// transaction whose FROZEN roster they are actually on. Every existing test runs
// as the owner, so these assert the non-owner / off-roster paths are refused.
describe('cross-actor authorization (cairn-idgc)', () => {
	/** Register a second user and share the multisig with them as a cosigner. */
	async function addCosigner(
		ownerId: number,
		multisigId: number,
		email: string
	): Promise<number> {
		const cosigner = await registerUser({
			email,
			password: 'correct horse battery',
			displayName: 'cosigner'
		});
		db.prepare(
			"INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, 'cosigner')"
		).run(multisigId, ownerId, cosigner.id);
		return cosigner.id;
	}

	/** A quorum-complete (2-of-3) draft, signed by keys 1 and 2 as the owner. */
	async function seedQuorumDraft(ownerId: number, multisigId: number): Promise<number> {
		const { txId, psbt } = await seedDraft(ownerId, multisigId);
		const first = attachMultisigSignature(ownerId, multisigId, txId, signWith(psbt, 0))!;
		attachMultisigSignature(ownerId, multisigId, txId, signWith(first.transaction.psbt, 1));
		return txId;
	}

	/** A COMPLETED (broadcast) tx with a recoverable coin, so bump can rebuild it —
	 *  mirrors seedBroadcast in the bump describe. */
	async function seedBroadcastTx(
		userId: number,
		multisigId: number
	): Promise<{ txId: number; txid: string }> {
		const multisig = getMultisig(userId, multisigId)!;
		const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, 200_000n, NETWORK);
		const details = await constructMultisigPsbt({
			config: toMultisigConfig(multisig),
			utxos: [
				{ txid: fundTx.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }
			],
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5,
			changeIndex: 0
		});
		const txid = 'ab'.repeat(32);
		const res = db
			.prepare(
				`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, txid)
				 VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(multisigId, details.psbtBase64, RECIPIENT, 50_000, details.fee, details.feeRate, 0, txid);
		getTxHexMock.mockResolvedValue(fundTx.hex);
		return { txId: Number(res.lastInsertRowid), txid };
	}

	it('refuses a cosigner (non-owner) from broadcasting; the owner still can', async () => {
		const { userId, multisigId } = await seedMultisig('owner-bcast@example.com');
		const cosignerId = await addCosigner(userId, multisigId, 'cos-bcast@example.com');
		const txId = await seedQuorumDraft(userId, multisigId);

		// The cosigner is refused at the owner-only gate before touching the network.
		await expect(
			broadcastMultisigTransaction(cosignerId, multisigId, txId)
		).rejects.toMatchObject({ code: 'not_found' });
		expect(broadcastMock).not.toHaveBeenCalled();

		// Proof the transaction is otherwise broadcastable: the owner succeeds.
		broadcastMock.mockImplementationOnce((rawHex: string) =>
			Promise.resolve(
				Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id
			)
		);
		const { txid } = await broadcastMultisigTransaction(userId, multisigId, txId);
		expect(txid).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a cosigner (non-owner) from fee-bumping; the owner reaches the tx', async () => {
		const { userId, multisigId } = await seedMultisig('owner-bump@example.com');
		const cosignerId = await addCosigner(userId, multisigId, 'cos-bump@example.com');
		const { txId } = await seedBroadcastTx(userId, multisigId);

		// Cosigner: refused at the owner-only gate → 'not_found'.
		await expect(
			bumpMultisigTransaction(cosignerId, multisigId, txId, 25)
		).rejects.toMatchObject({ code: 'not_found' });

		// Owner: passes the gate and actually builds the replacement (distinct
		// outcome — proves the cosigner was stopped by authorization, not a missing
		// or un-bumpable tx).
		const { draft } = await bumpMultisigTransaction(userId, multisigId, txId, 25);
		expect(draft.replacesTxid).not.toBeNull();
	});

	it('refuses a cosigner (non-owner) from deleting a draft; the owner can', async () => {
		const { userId, multisigId } = await seedMultisig('owner-del@example.com');
		const cosignerId = await addCosigner(userId, multisigId, 'cos-del@example.com');
		const { txId } = await seedDraft(userId, multisigId);

		// Cosigner: refused (returns false) and the row survives.
		expect(deleteMultisigTransaction(cosignerId, multisigId, txId)).toBe(false);
		expect(getMultisigTransaction(userId, multisigId, txId)).not.toBeNull();

		// Owner: allowed.
		expect(deleteMultisigTransaction(userId, multisigId, txId)).toBe(true);
	});

	it('denies an off-roster signer at attach, and allows them once on the roster', async () => {
		const { userId, multisigId } = await seedMultisig('owner-roster@example.com');
		const cosignerId = await addCosigner(userId, multisigId, 'cos-roster@example.com');
		const { txId, psbt } = await seedDraft(userId, multisigId);

		// This draft was inserted directly (no freezeRosterAndNotify), so the
		// cosigner is a wallet-level cosigner but NOT on this transaction's roster:
		// attach is denied even with an otherwise-valid signature.
		expect(attachMultisigSignature(cosignerId, multisigId, txId, signWith(psbt, 0))).toBeNull();

		// Add them to the frozen roster; now the same signature is accepted — proof
		// the roster gate (not the signature or the wallet-level gate) was the block.
		db.prepare(
			"INSERT INTO multisig_transaction_signers (transaction_id, user_id, assigned_key_ids) VALUES (?, ?, '[]')"
		).run(txId, cosignerId);
		const attached = attachMultisigSignature(cosignerId, multisigId, txId, signWith(psbt, 0));
		expect(attached).not.toBeNull();
		expect(attached!.progress.collected).toBe(1);

		// Sanity: the owner is always an implicit roster member regardless.
		expect(isRosterMember(txId, userId)).toBe(false); // owner not inserted...
		expect(attachMultisigSignature(userId, multisigId, txId, signWith(psbt, 1))).not.toBeNull(); // ...but still allowed
	});
});
