// cairn-a857 — mid-operation disruption: two LIVE SESSIONS for the same user
// acting simultaneously (two browser tabs / two devices signed into the same
// account).
//
// sessionEdges.test.ts already covers the session-VALIDITY half of this
// (concurrent logins are allowed by design, don't revoke each other, and
// destroyUserSessions is the only thing that kills all of them at once — see
// its "concurrent logins" describe block). This file covers the other half
// the bead asks for: when both live sessions actually SUBMIT MUTATIONS at the
// same time (both resolve via getSessionUser to the same userId, then both
// write), does the app crash, corrupt state, or silently lose one write? Every
// write path exercised here is a single synchronous statement (setWalletDevice
// / setLabel — see wallets.ts), so — same reasoning as
// concurrencyMultisigRace.test.ts's file-header design note — node:sqlite's
// synchronous, single-threaded execution makes each individual write atomic;
// what's actually being tested is that the LAST one committed wins cleanly,
// neither session's own token is disturbed by the other's write, and nothing
// throws.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { db } from './db';
import { registerUser, createSession, getSessionUser } from './auth';
import { setSetting } from './settings';
import { createWallet, getWallet, setWalletDevice, setLabel, getLabels } from './wallets';
import { buildDraft, listTransactions } from './transactions';
import { addressToScripthash } from './bitcoin/xpub';

const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	findNextUnusedIndex: vi.fn(),
	listUnspent: vi.fn(),
	getTxHex: vi.fn(),
	getTip: vi.fn(),
	getCpfpInfo: vi.fn()
}));
vi.mock('./bitcoin/walletScan', () => ({
	scanWallet: mocks.scanWallet,
	findNextUnusedIndex: mocks.findNextUnusedIndex,
	invalidateWalletCache: vi.fn(),
	primeWalletScanCache: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: {
			listUnspent: mocks.listUnspent,
			batchRequest: (items: { method: string; params: unknown[] }[]) =>
				Promise.all(items.map((it) => mocks.listUnspent(it.params[0])))
		},
		getTxHex: mocks.getTxHex,
		getTip: mocks.getTip,
		getCpfpInfo: mocks.getCpfpInfo
	})
}));

function wipe(): void {
	db.exec(
		`DELETE FROM transactions; DELETE FROM tx_labels; DELETE FROM wallets;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	mocks.getTip.mockResolvedValue({ height: 900_000 });
	mocks.getCpfpInfo.mockResolvedValue(null);
});

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

async function seedUserWithTwoSessions(email: string): Promise<{
	userId: number;
	walletId: number;
	tokenA: string;
	tokenB: string;
}> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const w = createWallet(user.id, { name: 'W', xpub: ZPUB });
	const a = createSession(user.id);
	const b = createSession(user.id);
	return { userId: user.id, walletId: w.id, tokenA: a.token, tokenB: b.token };
}

// ═══════════════════════════════ 1. two sessions racing the same settings write

describe('two concurrent sessions writing the SAME field', () => {
	it('setWalletDevice from two sessions at once: no crash, final value is one of the two, never a hybrid/corrupt value', async () => {
		const { walletId, tokenA, tokenB } = await seedUserWithTwoSessions('two-sessions-device@example.com');

		// Both requests resolve their acting user off their OWN session token —
		// exactly what two browser tabs' hooks.server.ts handle() would do.
		const userFromA = getSessionUser(tokenA)!;
		const userFromB = getSessionUser(tokenB)!;
		expect(userFromA.id).toBe(userFromB.id);

		const [resA, resB] = await Promise.all([
			Promise.resolve().then(() => setWalletDevice(userFromA.id, walletId, 'trezor')),
			Promise.resolve().then(() => setWalletDevice(userFromB.id, walletId, 'ledger'))
		]);
		expect(resA).not.toBeNull();
		expect(resB).not.toBeNull();

		const final = getWallet(userFromA.id, walletId)!;
		expect(['trezor', 'ledger']).toContain(final.device_type);

		// Both sessions are STILL independently valid after the race — one
		// session's write does not touch, revoke, or corrupt the other's token.
		expect(getSessionUser(tokenA)).not.toBeNull();
		expect(getSessionUser(tokenB)).not.toBeNull();
	});

	it('setLabel from two sessions on the SAME txid: no crash, last commit wins, upsert never duplicates a row', async () => {
		const { userId, walletId, tokenA, tokenB } = await seedUserWithTwoSessions(
			'two-sessions-label@example.com'
		);
		const txid = 'a'.repeat(64);
		const userFromA = getSessionUser(tokenA)!;
		const userFromB = getSessionUser(tokenB)!;

		const [resA, resB] = await Promise.all([
			Promise.resolve().then(() => setLabel(userFromA.id, walletId, txid, 'From tab A')),
			Promise.resolve().then(() => setLabel(userFromB.id, walletId, txid, 'From tab B'))
		]);
		expect(resA).not.toBeNull();
		expect(resB).not.toBeNull();

		const labels = getLabels(userId, walletId)!;
		// Exactly one label survives for this txid (the ON CONFLICT upsert never
		// leaves two rows for the same (wallet_id, txid)), and it's one of the
		// two submitted values, not a torn/mixed string.
		expect(['From tab A', 'From tab B']).toContain(labels[txid]);
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM tx_labels WHERE wallet_id = ? AND txid = ?')
			.get(walletId, txid) as { n: number };
		expect(n).toBe(1);
	});
});

// ═══════════════════════════════ 2. two sessions both drafting a send at once

describe('two concurrent sessions both building a send from the same wallet', () => {
	it('reserves disjoint coins across sessions (same underlying guarantee as concurrencySingleSigRace, exercised via two real session tokens)', async () => {
		const { walletId, tokenA, tokenB } = await seedUserWithTwoSessions('two-sessions-send@example.com');
		const { parseXpub, deriveAddress } = await import('./bitcoin/xpub');
		const parsed = parseXpub(ZPUB);
		const a0 = deriveAddress(parsed, 0, 0);
		const a1 = deriveAddress(parsed, 0, 1);
		const fundingTx = (address: string, value: number) => {
			const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
			tx.addInput({ txid: '00'.repeat(32), index: 0 });
			tx.addOutputAddress(address, BigInt(value), NETWORK);
			return { hex: tx.hex, txid: tx.id };
		};
		const fund0 = fundingTx(a0.address, 200_000);
		const fund1 = fundingTx(a1.address, 150_000);
		mocks.scanWallet.mockResolvedValue({
			addresses: [
				{ address: a0.address, derivationPath: 'm/0/0', index: 0, change: false, used: true, balance: 200_000, txCount: 1 },
				{ address: a1.address, derivationPath: 'm/0/1', index: 1, change: false, used: true, balance: 150_000, txCount: 1 }
			],
			txs: [],
			confirmed: 350_000,
			unconfirmed: 0
		});
		mocks.findNextUnusedIndex.mockResolvedValue(2);
		mocks.listUnspent.mockImplementation(async (sh: string) => {
			if (sh === addressToScripthash(a0.address))
				return [{ tx_hash: fund0.txid, tx_pos: 0, value: 200_000, height: 800_000 }];
			if (sh === addressToScripthash(a1.address))
				return [{ tx_hash: fund1.txid, tx_pos: 0, value: 150_000, height: 800_000 }];
			return [];
		});
		mocks.getTxHex.mockImplementation(async (txid: string) => {
			if (txid === fund0.txid) return fund0.hex;
			if (txid === fund1.txid) return fund1.hex;
			throw new Error(`no such tx ${txid}`);
		});

		const userFromA = getSessionUser(tokenA)!;
		const userFromB = getSessionUser(tokenB)!;
		const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

		const [r1, r2] = await Promise.all([
			buildDraft(userFromA.id, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 }),
			buildDraft(userFromB.id, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		]);

		const keys1 = new Set(r1.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		const keys2 = new Set(r2.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		for (const k of keys2) expect(keys1.has(k)).toBe(false);
		expect(listTransactions(userFromA.id, walletId)!).toHaveLength(2);
	});
});

// ═══════════════════════════════ 3. logout in one tab doesn't corrupt the other

describe('one session logging out while the other is mid-write', () => {
	it('destroying session A concurrently with session B writing does not crash, corrupt B, or affect the write', async () => {
		const { walletId, tokenA, tokenB } = await seedUserWithTwoSessions('two-sessions-logout-race@example.com');
		const userFromB = getSessionUser(tokenB)!;
		const { destroySession } = await import('./auth');

		const [, writeRes] = await Promise.all([
			Promise.resolve().then(() => destroySession(tokenA)),
			Promise.resolve().then(() => setWalletDevice(userFromB.id, walletId, 'coldcard'))
		]);

		expect(writeRes).not.toBeNull();
		expect(getWallet(userFromB.id, walletId)!.device_type).toBe('coldcard');
		// A is gone, B is untouched — exactly sessionEdges.test.ts's guarantee,
		// re-verified here under an actual concurrent write on B.
		expect(getSessionUser(tokenA)).toBeNull();
		expect(getSessionUser(tokenB)).not.toBeNull();
	});
});
