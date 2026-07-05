import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getVault, toVaultConfig } from './vaults';
import { deriveVaultAddress } from './bitcoin/multisig';
import { constructVaultPsbt, VaultPsbtError } from './bitcoin/vaultPsbt';
import type { SpendableUtxo } from './bitcoin/psbt';
import {
	buildVaultDraft,
	getVaultTransaction,
	listVaultTransactions,
	attachVaultSignature,
	deleteVaultTransaction,
	broadcastVaultTransaction,
	vaultTransactionProgress
} from './vaultTransactions';
import { BroadcastError } from './transactions';

// Only the network edges are faked: the chain source and the vault scanner
// (whose UTXOs would otherwise come from Electrum). Everything else — vault
// rows, PSBT construction, signature merging, quorum math, the broadcast
// claim — runs the real code path.
const { broadcastMock, getTxHexMock, utxosMock, changeIndexMock } = vi.hoisted(() => ({
	broadcastMock: vi.fn(),
	getTxHexMock: vi.fn(),
	utxosMock: vi.fn(),
	changeIndexMock: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: { broadcast: broadcastMock },
		getTxHex: getTxHexMock
	})
}));
vi.mock('./vaultScan', () => ({
	getVaultUtxos: utxosMock,
	nextVaultChangeIndex: changeIndexMock
}));

function wipe(): void {
	db.exec(
		'DELETE FROM vault_transactions; DELETE FROM vault_keys; DELETE FROM vaults; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	broadcastMock.mockReset();
	getTxHexMock.mockReset();
	utxosMock.mockReset();
	changeIndexMock.mockReset();
	changeIndexMock.mockResolvedValue(0);
	setSetting('registration_mode', 'open');
});

// ── fixtures: a real 2-of-3 vault whose keys the tests can actually sign with
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

function seedVault(email: string): { userId: number; vaultId: number } {
	const user = registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const res = db
		.prepare("INSERT INTO vaults (user_id, name, threshold, script_type) VALUES (?, 'V', 2, 'p2wsh')")
		.run(user.id);
	const vaultId = Number(res.lastInsertRowid);
	const insert = db.prepare(
		`INSERT INTO vault_keys (vault_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, 'hardware', 'file', ?, ?, ?)`
	);
	SIGNERS.forEach((s, i) => insert.run(vaultId, i, `Key ${i + 1}`, s.xpub, s.fingerprint, BIP48_PATH));
	return { userId: user.id, vaultId };
}

/** A confirmed coin sitting on the vault's real 0/0 address. */
function vaultUtxos(userId: number, vaultId: number, value = 200_000): SpendableUtxo[] {
	const vault = getVault(userId, vaultId)!;
	return [
		{
			txid: '11'.repeat(32),
			vout: 0,
			value,
			height: 800_000,
			address: deriveVaultAddress(toVaultConfig(vault), 0, 0).address,
			chain: 0,
			index: 0
		}
	];
}

async function seedDraft(
	userId: number,
	vaultId: number
): Promise<{ txId: number; psbt: string }> {
	const vault = getVault(userId, vaultId)!;
	const details = await constructVaultPsbt({
		config: toVaultConfig(vault),
		utxos: vaultUtxos(userId, vaultId),
		recipients: [{ address: RECIPIENT, amount: 50_000 }],
		feeRate: 5,
		changeIndex: 0
	});
	const res = db
		.prepare(
			`INSERT INTO vault_transactions (vault_id, status, psbt, recipient, amount, fee, fee_rate, change_index)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`
		)
		.run(vaultId, details.psbtBase64, RECIPIENT, 50_000, details.fee, details.feeRate, 0);
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

describe('vault transaction lifecycle', () => {
	it('scopes reads to the owning user', async () => {
		const alice = seedVault('alice@example.com');
		const bob = seedVault('bob@example.com');
		const { txId } = await seedDraft(alice.userId, alice.vaultId);

		expect(getVaultTransaction(alice.userId, alice.vaultId, txId)).not.toBeNull();
		expect(getVaultTransaction(bob.userId, bob.vaultId, txId)).toBeNull();
		expect(getVaultTransaction(bob.userId, alice.vaultId, txId)).toBeNull();
		expect(listVaultTransactions(bob.userId, alice.vaultId)).toBeNull();
	});

	it('builds and persists a draft from scanned UTXOs (buildVaultDraft)', async () => {
		const { userId, vaultId } = seedVault('build@example.com');
		// buildVaultDraft attaches full previous transactions (fee-lying
		// protection), so the mocked coin must reference a REAL funding tx whose
		// id verifies against the returned hex.
		const vault = getVault(userId, vaultId)!;
		const address = deriveVaultAddress(toVaultConfig(vault), 0, 0).address;
		const fundTx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		fundTx.addInput({ txid: '00'.repeat(32), index: 0 });
		fundTx.addOutputAddress(address, 200_000n, NETWORK);
		utxosMock.mockResolvedValue([
			{ txid: fundTx.id, vout: 0, value: 200_000, height: 800_000, address, chain: 0, index: 0 }
		]);
		getTxHexMock.mockResolvedValue(fundTx.hex);
		changeIndexMock.mockResolvedValue(3);

		const { draft, details } = await buildVaultDraft(userId, vaultId, {
			recipients: [{ address: RECIPIENT, amount: 40_000 }],
			feeRate: 5
		});
		expect(draft.status).toBe('draft');
		expect(draft.amount).toBe(40_000);
		expect(draft.recipient).toBe(RECIPIENT);
		expect(draft.changeIndex).toBe(3);
		expect(details.change?.index).toBe(3);
		expect(vaultTransactionProgress(vault, draft)).toMatchObject({
			required: 2,
			collected: 0,
			complete: false
		});
	});

	it('deletes drafts but keeps completed transactions', async () => {
		const { userId, vaultId } = seedVault('del@example.com');
		const { txId } = await seedDraft(userId, vaultId);
		const done = await seedDraft(userId, vaultId);
		db.prepare(
			"UPDATE vault_transactions SET status = 'completed', txid = ? WHERE id = ?"
		).run('ff'.repeat(32), done.txId);

		expect(deleteVaultTransaction(userId, vaultId, txId)).toBe(true);
		expect(getVaultTransaction(userId, vaultId, txId)).toBeNull();
		expect(deleteVaultTransaction(userId, vaultId, done.txId)).toBe(false);
		expect(getVaultTransaction(userId, vaultId, done.txId)).not.toBeNull();
	});

	it('cascades vault deletion to its transactions', async () => {
		const { userId, vaultId } = seedVault('cascade@example.com');
		const { txId } = await seedDraft(userId, vaultId);
		db.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM vault_transactions WHERE id = ?').get(txId)
		).toMatchObject({ n: 0 });
	});
});

// ── attach (per-key signature merging) ───────────────────────────────────────

describe('attachVaultSignature', () => {
	it('merges one signature at a time and reports live quorum progress', async () => {
		const { userId, vaultId } = seedVault('attach@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);

		const first = attachVaultSignature(userId, vaultId, txId, signWith(psbt, 0))!;
		expect(first.transaction.status).toBe('awaiting_signature');
		expect(first.progress).toMatchObject({ required: 2, collected: 1, complete: false });
		expect(first.progress.signedFingerprints).toEqual([SIGNERS[0].fingerprint]);

		// The second key signs the CURRENT stored PSBT (prior signature intact).
		const second = attachVaultSignature(
			userId,
			vaultId,
			txId,
			signWith(first.transaction.psbt, 1)
		)!;
		expect(second.progress).toMatchObject({ required: 2, collected: 2, complete: true });
		expect(second.progress.signedFingerprints.sort()).toEqual(
			[SIGNERS[0].fingerprint, SIGNERS[1].fingerprint].sort()
		);
	});

	it('is idempotent when the same signed PSBT is submitted twice', async () => {
		const { userId, vaultId } = seedVault('idem@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);
		const signed = signWith(psbt, 0);
		const once = attachVaultSignature(userId, vaultId, txId, signed)!;
		const twice = attachVaultSignature(userId, vaultId, txId, signed)!;
		expect(once.progress.collected).toBe(1);
		expect(twice.progress.collected).toBe(1);
	});

	it('refuses a signed PSBT for a different transaction (substitution guard)', async () => {
		const { userId, vaultId } = seedVault('subst@example.com');
		const { txId } = await seedDraft(userId, vaultId);
		const vault = getVault(userId, vaultId)!;
		const other = await constructVaultPsbt({
			config: toVaultConfig(vault),
			utxos: vaultUtxos(userId, vaultId),
			recipients: [{ address: RECIPIENT, amount: 60_000 }], // different amount
			feeRate: 5,
			changeIndex: 0
		});
		expect(() =>
			attachVaultSignature(userId, vaultId, txId, signWith(other.psbtBase64, 0))
		).toThrow(VaultPsbtError);
		// And nothing was stored: progress stays at zero.
		const tx = getVaultTransaction(userId, vaultId, txId)!;
		expect(vaultTransactionProgress(vault, tx)?.collected).toBe(0);
	});

	it('refuses corrupt uploads with the corruption message', async () => {
		const { userId, vaultId } = seedVault('corrupt@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);
		const corrupt = base64.encode(base64.decode(psbt).slice(0, 20));
		expect(() => attachVaultSignature(userId, vaultId, txId, corrupt)).toThrow(
			/truncated or corrupted/
		);
	});

	it('refuses attaching to an already-broadcast transaction', async () => {
		const { userId, vaultId } = seedVault('late@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);
		db.prepare(
			"UPDATE vault_transactions SET status = 'completed', txid = ? WHERE id = ?"
		).run('aa'.repeat(32), txId);
		expect(() => attachVaultSignature(userId, vaultId, txId, signWith(psbt, 0))).toThrow(
			BroadcastError
		);
	});
});

// ── broadcast (quorum gate + atomic claim) ───────────────────────────────────

describe('broadcastVaultTransaction', () => {
	async function signedToQuorum(userId: number, vaultId: number) {
		const { txId, psbt } = await seedDraft(userId, vaultId);
		const first = attachVaultSignature(userId, vaultId, txId, signWith(psbt, 0))!;
		attachVaultSignature(userId, vaultId, txId, signWith(first.transaction.psbt, 1));
		return txId;
	}

	it('refuses to broadcast below quorum with "X of M signatures collected"', async () => {
		const { userId, vaultId } = seedVault('quorum@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);
		attachVaultSignature(userId, vaultId, txId, signWith(psbt, 0)); // 1 of 2

		const p = broadcastVaultTransaction(userId, vaultId, txId);
		await expect(p).rejects.toMatchObject({ code: 'incomplete' });
		await expect(broadcastVaultTransaction(userId, vaultId, txId)).rejects.toThrow(
			/1 of 2 signatures collected/
		);
		expect(broadcastMock).not.toHaveBeenCalled();
	});

	it('broadcasts a quorum-complete transaction and records the txid', async () => {
		const { userId, vaultId } = seedVault('send@example.com');
		const txId = await signedToQuorum(userId, vaultId);
		broadcastMock.mockResolvedValueOnce('cc'.repeat(32));

		const { txid, transaction } = await broadcastVaultTransaction(userId, vaultId, txId);
		expect(txid).toBe('cc'.repeat(32));
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe('cc'.repeat(32));
		expect(broadcastMock).toHaveBeenCalledTimes(1);
	});

	it('accepts the final signature riding along with the broadcast call', async () => {
		const { userId, vaultId } = seedVault('ride@example.com');
		const { txId, psbt } = await seedDraft(userId, vaultId);
		const first = attachVaultSignature(userId, vaultId, txId, signWith(psbt, 0))!;
		broadcastMock.mockResolvedValueOnce('dd'.repeat(32));

		const { txid } = await broadcastVaultTransaction(
			userId,
			vaultId,
			txId,
			signWith(first.transaction.psbt, 2) // key 3 completes the quorum here
		);
		expect(txid).toBe('dd'.repeat(32));
	});

	it('lets exactly one of two concurrent broadcasts through (atomic claim)', async () => {
		const { userId, vaultId } = seedVault('race@example.com');
		const txId = await signedToQuorum(userId, vaultId);

		let resolveBroadcast!: (txid: string) => void;
		broadcastMock.mockImplementationOnce(
			() => new Promise<string>((res) => (resolveBroadcast = res))
		);
		const first = broadcastVaultTransaction(userId, vaultId, txId);
		const second = broadcastVaultTransaction(userId, vaultId, txId);
		await expect(second).rejects.toMatchObject({ code: 'already_sent' });

		resolveBroadcast('ee'.repeat(32));
		const winner = await first;
		expect(winner.txid).toBe('ee'.repeat(32));
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(getVaultTransaction(userId, vaultId, txId)?.status).toBe('completed');
	});

	it('releases the claim when the network rejects, so a retry works', async () => {
		const { userId, vaultId } = seedVault('retry@example.com');
		const txId = await signedToQuorum(userId, vaultId);

		broadcastMock.mockRejectedValueOnce(new Error('mempool full'));
		await expect(broadcastVaultTransaction(userId, vaultId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		const afterFailure = getVaultTransaction(userId, vaultId, txId);
		expect(afterFailure?.txid).toBeNull();
		expect(afterFailure?.status).not.toBe('completed');

		broadcastMock.mockResolvedValueOnce('ab'.repeat(32));
		const retry = await broadcastVaultTransaction(userId, vaultId, txId);
		expect(retry.txid).toBe('ab'.repeat(32));
	});

	it('refuses double-broadcast of a completed transaction before touching the network', async () => {
		const { userId, vaultId } = seedVault('done@example.com');
		const txId = await signedToQuorum(userId, vaultId);
		broadcastMock.mockResolvedValueOnce('cd'.repeat(32));
		await broadcastVaultTransaction(userId, vaultId, txId);
		broadcastMock.mockClear();

		await expect(broadcastVaultTransaction(userId, vaultId, txId)).rejects.toMatchObject({
			code: 'already_sent'
		});
		expect(broadcastMock).not.toHaveBeenCalled();
	});
});
