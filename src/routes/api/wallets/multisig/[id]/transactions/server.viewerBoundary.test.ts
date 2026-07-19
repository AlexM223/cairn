// cairn-2fx1f — ROUTE-LEVEL regression lock for the multisig viewer-role
// boundary. The service-layer gates (getViewableMultisig / getSignableMultisig
// / listMultisigTransactions / listMultisigTransactionSummaries / ...) are
// already unit-tested directly in multisigAccess.test.ts — this file instead
// calls the ACTUAL exported route handlers (the +server.ts files under this
// directory and its siblings), because the historical bug class here was "the
// gate function existed and was correct, but nothing on the route actually
// called it" (cairn-xkpd). If a future edit swaps a route's access check for
// the wrong gate (or drops it), these tests fail even though the gate
// function itself still passes its own unit tests.
//
// Only the network edges (Electrum/chain, the multisig scan) are faked —
// same convention as multisigTransactions.test.ts — so the real access-gate
// code inside buildMultisigDraft / getMultisigDetail actually runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
	getMultisigUtxosMock,
	nextMultisigChangeIndexMock,
	getMultisigDetailMock,
	getMinFeeRateMock,
	getTipMock
} = vi.hoisted(() => ({
	getMultisigUtxosMock: vi.fn(),
	nextMultisigChangeIndexMock: vi.fn(),
	getMultisigDetailMock: vi.fn(),
	getMinFeeRateMock: vi.fn(),
	getTipMock: vi.fn()
}));

// buildMultisigDraft (POST /psbt) reads getMinFeeRate (and getTip only when a
// coinbase UTXO is present, which never happens here since utxos are empty).
vi.mock('$lib/server/chain', () => ({
	getChain: () => ({
		getMinFeeRate: getMinFeeRateMock,
		getRelayFeeFloor: getMinFeeRateMock,
		getTip: getTipMock,
		getTxHex: vi.fn(),
		getTx: vi.fn(),
		electrum: { broadcast: vi.fn(), broadcastPackage: vi.fn() }
	})
}));

// Preserve everything else (toMultisigSummary, invalidateMultisigCache, ...)
// for real — only the three functions that would otherwise dial a live
// Electrum server are swapped out.
vi.mock('$lib/server/multisigScan', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/multisigScan')>();
	return {
		...actual,
		getMultisigUtxos: getMultisigUtxosMock,
		nextMultisigChangeIndex: nextMultisigChangeIndexMock,
		getMultisigDetail: getMultisigDetailMock
	};
});

import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { shareMultisig } from '$lib/server/multisigShares';

import { GET as listGET } from './+server';
import { GET as txGET, PATCH as txPATCH, DELETE as txDELETE } from './[txId]/+server';
import { GET as fileGET } from './[txId]/file/+server';
import { POST as psbtPOST } from '../psbt/+server';
import { GET as walletGET } from '../+server';

const PSBT = 'cHNidP8BAF4CAAAAAA==';
const RECIPIENT = 'bc1qexample';
const AMOUNT = 100_000;

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transactions; DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM contacts; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

async function makeUser(email: string): Promise<number> {
	return (
		await registerUser({
			email,
			password: 'correct horse battery',
			displayName: email.split('@')[0]
		})
	).id;
}

/** An accepted, bidirectional contact relationship (what shareMultisig requires). */
function befriend(a: number, b: number): void {
	db.prepare(
		"INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')"
	).run(a, b);
}

/** A 2-of-3 multisig owned by ownerId with three keys; returns ids. */
function makeMultisig(ownerId: number): { msId: number; keyIds: number[] } {
	const msId = Number(
		db
			.prepare(
				"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, ?)"
			)
			.run(ownerId, 'Family vault', 'p2wsh').lastInsertRowid
	);
	const keyIds = [0, 1, 2].map((i) =>
		Number(
			db
				.prepare(
					'INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run(msId, i, `Key ${i}`, 'hardware', `xpub${i}`, `0000000${i}`, `m/48'/0'/0'/2'/${i}`)
				.lastInsertRowid
		)
	);
	return { msId, keyIds };
}

let owner: number;
let viewer: number;
let cosigner: number;
let outsider: number;
let multisigId: number;
let txId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');

	getMultisigUtxosMock.mockReset().mockResolvedValue([]);
	nextMultisigChangeIndexMock.mockReset().mockResolvedValue(0);
	getMinFeeRateMock.mockReset().mockResolvedValue(1);
	getTipMock.mockReset().mockResolvedValue({ height: 900_000, hash: '00'.repeat(32) });
	getMultisigDetailMock.mockReset().mockResolvedValue({
		balance: { confirmed: 0, unconfirmed: 0 },
		utxos: [],
		addresses: [],
		history: [],
		scanTruncated: false
	});

	owner = await makeUser('owner@example.com');
	viewer = await makeUser('viewer@example.com');
	cosigner = await makeUser('cosigner@example.com');
	outsider = await makeUser('outsider@example.com');

	const { msId, keyIds } = makeMultisig(owner);
	multisigId = msId;
	befriend(owner, viewer);
	befriend(owner, cosigner);
	shareMultisig(owner, msId, viewer, 'viewer');
	shareMultisig(owner, msId, cosigner, 'cosigner', [keyIds[2]]);

	txId = Number(
		db
			.prepare(
				`INSERT INTO multisig_transactions
				   (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
				 VALUES (?, 'awaiting_signature', ?, ?, ?, 500, 5)`
			)
			.run(multisigId, PSBT, RECIPIENT, AMOUNT).lastInsertRowid
	);
});

function user(userId: number) {
	return { id: userId, email: 'x@example.com', isAdmin: false };
}

function listEvent(userId: number) {
	const url = `http://localhost/api/wallets/multisig/${multisigId}/transactions`;
	return {
		locals: { user: user(userId) },
		params: { id: String(multisigId) },
		request: new Request(url)
	} as unknown as Parameters<typeof listGET>[0];
}

function txEvent(userId: number, init?: RequestInit) {
	const url = `http://localhost/api/wallets/multisig/${multisigId}/transactions/${txId}`;
	return {
		locals: { user: user(userId) },
		params: { id: String(multisigId), txId: String(txId) },
		request: new Request(url, init)
	} as unknown as Parameters<typeof txGET>[0];
}

function fileEvent(userId: number) {
	const url = `http://localhost/api/wallets/multisig/${multisigId}/transactions/${txId}/file`;
	return {
		locals: { user: user(userId) },
		params: { id: String(multisigId), txId: String(txId) },
		request: new Request(url)
	} as unknown as Parameters<typeof fileGET>[0];
}

const SPEND_BODY = { recipients: [{ address: 'bcrt1qexampleaddress', amount: 10_000 }], feeRate: 5 };

function psbtEvent(userId: number, body: unknown = SPEND_BODY) {
	const url = `http://localhost/api/wallets/multisig/${multisigId}/psbt`;
	return {
		locals: { user: user(userId) },
		params: { id: String(multisigId) },
		url: new URL(url),
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof psbtPOST>[0];
}

function walletEvent(userId: number) {
	const url = `http://localhost/api/wallets/multisig/${multisigId}`;
	return {
		locals: { user: user(userId) },
		params: { id: String(multisigId) },
		request: new Request(url)
	} as unknown as Parameters<typeof walletGET>[0];
}

async function assertNoLeak(res: Response): Promise<void> {
	const text = await res.text();
	expect(text).not.toContain(PSBT);
	expect(text).not.toContain(RECIPIENT);
	expect(text).not.toContain(String(AMOUNT));
}

function transactionCount(): number {
	return (
		db.prepare('SELECT COUNT(*) AS n FROM multisig_transactions').get() as { n: number }
	).n;
}

function txRowSnapshot(): { status: string; psbt: string } {
	return db
		.prepare('SELECT status, psbt FROM multisig_transactions WHERE id = ?')
		.get(txId) as { status: string; psbt: string };
}

describe('cairn-2fx1f: multisig transactions route-level viewer boundary', () => {
	it('GET /transactions (list): owner + cosigner get the list with the psbt; viewer + outsider get a uniform rejection with no leak', async () => {
		for (const uid of [owner, cosigner]) {
			const res = await listGET(listEvent(uid));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.transactions).toHaveLength(1);
			expect(body.transactions[0].psbt).toBe(PSBT);
			expect(body.transactions[0].recipient).toBe(RECIPIENT);
		}

		for (const uid of [viewer, outsider]) {
			const res = await listGET(listEvent(uid));
			expect([403, 404]).toContain(res.status);
			await assertNoLeak(res);
		}
	});

	it('GET /transactions/[txId]: owner + cosigner get the full transaction; viewer + outsider get a uniform rejection with no leak', async () => {
		for (const uid of [owner, cosigner]) {
			const res = await txGET(txEvent(uid));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.transaction.psbt).toBe(PSBT);
		}

		for (const uid of [viewer, outsider]) {
			const res = await txGET(txEvent(uid));
			expect([403, 404]).toContain(res.status);
			await assertNoLeak(res);
		}
	});

	it('GET /transactions/[txId]/file: owner + cosigner get the binary PSBT download; viewer + outsider are rejected with no leak', async () => {
		for (const uid of [owner, cosigner]) {
			const res = await fileGET(fileEvent(uid));
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('application/octet-stream');
			const buf = new Uint8Array(await res.arrayBuffer());
			// Re-decoding the response bytes back to base64 round-trips to the
			// stored PSBT — the actual file content, not just a status code.
			expect(Buffer.from(buf).toString('base64')).toBe(PSBT);
		}

		for (const uid of [viewer, outsider]) {
			// This route throws SvelteKit's error() rather than returning a Response.
			await expect(fileGET(fileEvent(uid))).rejects.toMatchObject({ status: 404 });
		}
	});

	it('POST /psbt: viewer + outsider are rejected before any draft is built (no new row); owner + cosigner get past the access gate', async () => {
		const before = transactionCount();

		for (const uid of [viewer, outsider]) {
			const res = await psbtPOST(psbtEvent(uid));
			expect(res.status).toBe(404); // buildMultisigDraft's own gate → PsbtError('construction_failed')
			await assertNoLeak(res);
		}
		expect(transactionCount()).toBe(before); // no row was inserted for the rejected attempts

		for (const uid of [owner, cosigner]) {
			const res = await psbtPOST(psbtEvent(uid));
			// Past the access gate: with no UTXOs mocked in, construction itself
			// fails (insufficient funds / no UTXOs) — but that's a validation
			// error, not an access rejection. The point is it is NOT 403/404.
			expect([403, 404]).not.toContain(res.status);
		}
	});

	it('PATCH /transactions/[txId] as viewer: rejected, row unchanged', async () => {
		const snapshotBefore = txRowSnapshot();
		const res = await txPATCH(
			txEvent(viewer, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status: 'draft' })
			})
		);
		expect(res.status).toBe(404);
		expect(txRowSnapshot()).toEqual(snapshotBefore);
	});

	it('DELETE /transactions/[txId] as viewer: rejected, row unchanged (and NOT deleted)', async () => {
		const res = await txDELETE(txEvent(viewer, { method: 'DELETE' }));
		// deleteMultisigTransaction gates on getMultisig (owner-only — see the
		// route's own comment: "Draft management is owner-only"), so it returns
		// a boolean rather than null; the route maps that to 400, not 404/403.
		// Assert the row survives regardless of the exact status code.
		expect(res.status).not.toBe(200);
		expect(transactionCount()).toBe(1);
		expect(
			db.prepare('SELECT 1 FROM multisig_transactions WHERE id = ?').get(txId)
		).toBeTruthy();
	});

	it('sanity check: viewer CAN still hit a read-tier route (GET /api/wallets/multisig/[id]) successfully — proves the 404s above are role-based, not a broken fixture', async () => {
		const res = await walletGET(walletEvent(viewer));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.role).toBe('viewer');
		expect(body.multisig.id).toBe(multisigId);
	});
});
