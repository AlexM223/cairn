// cairn-vyxt — broadcast routes must 400 on a malformed JSON body (fix
// cairn-1yw7: they previously did readJson(event).catch(() => ({ psbt:
// undefined })), silently proceeding to broadcast the SAVED psbt as if no body
// had been sent — a silent no-op of the user's intent on an irreversible action).
//
// cairn-ajki — broadcast route error paths must log.error with walletId/txId
// context before returning the generic 502 (fix in d5f9c73; previously the
// underlying error was swallowed with no server-side trace).
//
// Covers BOTH routes: this one (single-sig) and the multisig equivalent.
//
// Note on seams: every network-level broadcast failure inside
// broadcastTransaction is wrapped into BroadcastError (mapped to 4xx, no
// log.error), so the routes' 502-plus-log path is only reachable when the
// service throws something unexpected — hence the service seam is mocked to
// throw a plain Error, and no wallet/tx DB fixtures are needed (the JSON parse
// and the service call both happen before any wallet lookup in the route).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Logger seam: each route creates `const log = childLogger('wallet')` at import
// time, so the mock must be installed before the routes load (vi.mock hoists).
const logMock = vi.hoisted(() => {
	const log: Record<string, unknown> = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn()
	};
	log.child = () => log;
	return log as {
		warn: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
		fatal: ReturnType<typeof vi.fn>;
		child: () => unknown;
	};
});

const mocks = vi.hoisted(() => ({
	broadcastTransaction: vi.fn(),
	broadcastMultisigTransaction: vi.fn()
}));

vi.mock('$lib/server/logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log',
	REDACT_OPTIONS: {}
}));
// Keep BroadcastError (and everything else) real; replace only the service
// entry point each route calls.
vi.mock('$lib/server/transactions', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/transactions')>()),
	broadcastTransaction: mocks.broadcastTransaction
}));
vi.mock('$lib/server/multisigTransactions', () => ({
	broadcastMultisigTransaction: mocks.broadcastMultisigTransaction
}));

import { BroadcastError } from '$lib/server/transactions';
import { POST as singleSigPOST } from './+server';
import { POST as multisigPOST } from '../../../../multisig/[id]/transactions/[txId]/broadcast/+server';

type Ev = Parameters<typeof singleSigPOST>[0];
type MsEv = Parameters<typeof multisigPOST>[0];

/** Fake RequestEvent: signed-in user, 'send' feature enabled, given raw body. */
function makeEvent(params: { id: string; txId: string }, rawBody: string | null): Ev {
	const url = 'http://localhost/api/wallets/broadcast-under-test';
	return {
		locals: {
			user: { id: 1, email: 'user@example.com', isAdmin: false },
			flags: { send: true }
		},
		params,
		url: new URL(url),
		request: new Request(
			url,
			rawBody === null
				? { method: 'POST' }
				: { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody }
		)
	} as unknown as Ev;
}

/** Same fake event, typed for the multisig route (identical shape, different route id). */
function makeMsEvent(params: { id: string; txId: string }, rawBody: string | null): MsEv {
	return makeEvent(params, rawBody) as unknown as MsEv;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('malformed JSON body → 400, never a silent no-op (cairn-vyxt, fix cairn-1yw7)', () => {
	it('single-sig broadcast rejects invalid JSON with 400 and does NOT broadcast', async () => {
		await expect(singleSigPOST(makeEvent({ id: '7', txId: '9' }, '{nope'))).rejects.toMatchObject({
			status: 400,
			body: { message: 'Invalid JSON body' }
		});
		expect(mocks.broadcastTransaction).not.toHaveBeenCalled();
	});

	it('multisig broadcast rejects invalid JSON with 400 and does NOT broadcast', async () => {
		await expect(multisigPOST(makeMsEvent({ id: '3', txId: '4' }, '{nope'))).rejects.toMatchObject({
			status: 400,
			body: { message: 'Invalid JSON body' }
		});
		expect(mocks.broadcastMultisigTransaction).not.toHaveBeenCalled();
	});

	it('an EMPTY body is still legitimate — broadcasts the saved draft with no fresh psbt', async () => {
		mocks.broadcastTransaction.mockResolvedValue({
			txid: 'ab'.repeat(32),
			transaction: { id: 9 }
		});
		const res = await singleSigPOST(makeEvent({ id: '7', txId: '9' }, null));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ txid: 'ab'.repeat(32) });
		expect(mocks.broadcastTransaction).toHaveBeenCalledWith(1, 7, 9, undefined);
	});

	it('a valid body with a string psbt forwards it to the service', async () => {
		mocks.broadcastTransaction.mockResolvedValue({
			txid: 'cd'.repeat(32),
			transaction: { id: 9 }
		});
		const res = await singleSigPOST(
			makeEvent({ id: '7', txId: '9' }, JSON.stringify({ psbt: 'cHNidP8BAF4CAAAA' }))
		);
		expect(res.status).toBe(200);
		expect(mocks.broadcastTransaction).toHaveBeenCalledWith(1, 7, 9, 'cHNidP8BAF4CAAAA');
	});
});

describe('unexpected failure → 502 AND log.error with ids (cairn-ajki, fix d5f9c73)', () => {
	it('single-sig: a non-BroadcastError yields 502 and logs walletId/txId context', async () => {
		mocks.broadcastTransaction.mockRejectedValue(new Error('electrum socket exploded'));

		const res = await singleSigPOST(makeEvent({ id: '7', txId: '9' }, null));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'electrum socket exploded' });
		expect(logMock.error).toHaveBeenCalledTimes(1);
		expect(logMock.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), walletId: 7, txId: 9 }),
			'wallet broadcast failed'
		);
	});

	it('multisig: a non-BroadcastError yields 502 and logs multisigId/txId context', async () => {
		mocks.broadcastMultisigTransaction.mockRejectedValue(new Error('electrum socket exploded'));

		const res = await multisigPOST(makeMsEvent({ id: '3', txId: '4' }, null));

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'electrum socket exploded' });
		expect(logMock.error).toHaveBeenCalledTimes(1);
		expect(logMock.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), multisigId: 3, txId: 4 }),
			'wallet broadcast failed'
		);
	});

	it('a KNOWN BroadcastError maps to its 4xx and does not hit the unexpected-error log', async () => {
		mocks.broadcastTransaction.mockRejectedValue(
			new BroadcastError('The network rejected this transaction: dust', 'rejected')
		);

		const res = await singleSigPOST(makeEvent({ id: '7', txId: '9' }, null));

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'rejected' });
		expect(logMock.error).not.toHaveBeenCalled();
	});
});
