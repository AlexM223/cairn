// cairn-9v9g — send-flow boundary matrix, HTTP layer: the send form's actual
// entry point is this route's POST handler (and its multisig twin). Confirms
// every boundary rejection from buildDraft/buildMultisigDraft — zero balance,
// dust, insufficient funds, invalid (too-low/too-high) fee rate — reaches the
// client as a 400 with the ORIGINAL plain-language PsbtError message intact
// (never re-wrapped into raw jargon), and that a genuinely unexpected failure
// still gets the generic "couldn't reach the network" 502 copy, never a raw
// exception string (mirrors broadcast/server.test.ts's pattern: only the
// service seam is mocked, the real error classes and psbtBuildErrorResponse
// mapping run for real).

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
	return log as Record<string, ReturnType<typeof vi.fn>> & { child: () => unknown };
});

const mocks = vi.hoisted(() => ({
	buildDraft: vi.fn(),
	buildMultisigDraft: vi.fn(),
	getSignableMultisig: vi.fn(),
	recordActivity: vi.fn(),
	multisigTransactionProgress: vi.fn()
}));

vi.mock('$lib/server/logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log',
	REDACT_OPTIONS: {}
}));
vi.mock('$lib/server/transactions', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/transactions')>()),
	buildDraft: mocks.buildDraft
}));
vi.mock('$lib/server/multisigTransactions', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/multisigTransactions')>()),
	buildMultisigDraft: mocks.buildMultisigDraft,
	multisigTransactionProgress: mocks.multisigTransactionProgress
}));
vi.mock('$lib/server/wallets/multisig', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/wallets/multisig')>()),
	getSignableMultisig: mocks.getSignableMultisig
}));
vi.mock('$lib/server/activity', () => ({ recordActivity: mocks.recordActivity }));

import { PsbtError } from '$lib/server/bitcoin/psbt';
import { POST as singleSigPOST } from './+server';
import { POST as multisigPOST } from '../../multisig/[id]/psbt/+server';

type Ev = Parameters<typeof singleSigPOST>[0];
type MsEv = Parameters<typeof multisigPOST>[0];

function makeEvent(id: string, body: Record<string, unknown>): Ev {
	const url = 'http://localhost/api/wallets/psbt-under-test';
	return {
		locals: { user: { id: 1, email: 'user@example.com', isAdmin: false }, flags: { send: true } },
		params: { id },
		url: new URL(url),
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Ev;
}
function makeMsEvent(id: string, body: Record<string, unknown>): MsEv {
	return makeEvent(id, body) as unknown as MsEv;
}

const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const SPEND_BODY = { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 };

/** All PsbtError `code` tokens — must never leak verbatim as the message text
 *  the send form would render. */
const ERROR_CODES = [
	'invalid_recipient',
	'invalid_amount',
	'insufficient_funds',
	'no_utxos',
	'immature_coinbase',
	'construction_failed'
];
function expectPlainLanguage(message: string): void {
	expect(message.length).toBeGreaterThan(0);
	for (const code of ERROR_CODES) expect(message).not.toContain(code);
	expect(message).toMatch(/[.!?]$/);
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ═══════════════════════ boundary rejections → 400, plain language preserved

describe('single-sig POST /api/wallets/[id]/psbt — boundary rejections surface as plain 400s', () => {
	const cases: { name: string; err: PsbtError }[] = [
		{ name: 'zero balance', err: new PsbtError('This wallet has no spendable coins right now.', 'no_utxos') },
		{
			name: 'insufficient funds (amount+fee exceeds balance)',
			err: new PsbtError('Not enough funds to cover that amount plus the network fee.', 'insufficient_funds')
		},
		{
			name: 'sweep result below dust',
			err: new PsbtError('After fees there would be nothing left to send at this fee rate.', 'insufficient_funds')
		},
		{
			name: 'fee rate below the min-relay floor',
			err: new PsbtError('Fee rate must be at least 1 sat/vB.', 'invalid_amount')
		},
		{
			name: 'fee rate above the fat-finger ceiling',
			err: new PsbtError(
				'A fee rate above 1000 sat/vB is almost certainly a mistake — refusing to build this transaction.',
				'invalid_amount'
			)
		}
	];

	for (const { name, err } of cases) {
		it(`${name} → 400 with the original plain-language message and code, unmodified`, async () => {
			mocks.buildDraft.mockRejectedValue(err);
			const res = await singleSigPOST(makeEvent('7', SPEND_BODY));
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body).toEqual({ error: err.message, code: err.code });
			expectPlainLanguage(body.error);
		});
	}

	it('an unexpected (non-PsbtError) failure maps to 502 with a plain "couldn\'t reach the network" sentence, and logs context', async () => {
		mocks.buildDraft.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:50001'));
		const res = await singleSigPOST(makeEvent('7', SPEND_BODY));
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain("Couldn't reach the Bitcoin network");
		expect(body.error).toContain('Check your node');
		// The raw detail is kept (never the ONLY thing shown) but wrapped in a
		// full explanatory sentence, not surfaced bare.
		expect(body.error).not.toBe('connect ECONNREFUSED 127.0.0.1:50001');
		expect(logMock.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), walletId: 7 }),
			'wallet psbt build failed'
		);
	});

	it('construction_failed maps to 404 (the resource itself, e.g. the wallet, could not be found/built)', async () => {
		mocks.buildDraft.mockRejectedValue(new PsbtError('Wallet not found.', 'construction_failed'));
		const res = await singleSigPOST(makeEvent('999', SPEND_BODY));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'Wallet not found.', code: 'construction_failed' });
	});

	it('a successful build returns 201 with the draft/details payload', async () => {
		mocks.buildDraft.mockResolvedValue({
			draft: { id: 42, status: 'draft' },
			details: { amount: 10_000, fee: 500 },
			chainDepthWarning: null,
			reservationWarning: null
		});
		const res = await singleSigPOST(makeEvent('7', SPEND_BODY));
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ draft: { id: 42 } });
	});
});

describe('multisig POST /api/wallets/multisig/[id]/psbt — boundary rejections surface as plain 400s', () => {
	const cases: { name: string; err: PsbtError }[] = [
		{ name: 'zero balance', err: new PsbtError('This multisig has no spendable coins right now.', 'no_utxos') },
		{
			name: 'insufficient confirmed funds',
			err: new PsbtError('Not enough confirmed funds to cover that amount plus the network fee.', 'insufficient_funds')
		},
		{
			name: 'fee rate below the min-relay floor',
			err: new PsbtError('Fee rate must be at least 1 sat/vB.', 'invalid_amount')
		}
	];

	for (const { name, err } of cases) {
		it(`${name} → 400 with the original plain-language message and code, unmodified`, async () => {
			mocks.buildMultisigDraft.mockRejectedValue(err);
			const res = await multisigPOST(makeMsEvent('3', SPEND_BODY));
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body).toEqual({ error: err.message, code: err.code });
			expectPlainLanguage(body.error);
			// buildMultisigDraft's own rejection must short-circuit before any
			// activity is recorded for a spend that was never actually built.
			expect(mocks.recordActivity).not.toHaveBeenCalled();
		});
	}

	it('an unexpected (non-PsbtError) failure maps to 502 with a plain sentence, and logs multisigId context', async () => {
		mocks.buildMultisigDraft.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:50001'));
		const res = await multisigPOST(makeMsEvent('3', SPEND_BODY));
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toContain("Couldn't reach the Bitcoin network");
		expect(logMock.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), multisigId: 3 }),
			'wallet psbt build failed'
		);
	});

	it('a successful build returns 201 with draft/details/progress', async () => {
		mocks.buildMultisigDraft.mockResolvedValue({
			draft: { id: 9, status: 'draft' },
			details: { amount: 10_000, fee: 500 },
			chainDepthWarning: null,
			reservationWarning: null
		});
		mocks.getSignableMultisig.mockReturnValue({ id: 3, name: 'Vault', threshold: 2, keys: [1, 2, 3] });
		mocks.multisigTransactionProgress.mockReturnValue({ required: 2, collected: 0, complete: false });

		const res = await multisigPOST(makeMsEvent('3', SPEND_BODY));
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toMatchObject({ draft: { id: 9 }, progress: { required: 2, collected: 0 } });
		expect(mocks.recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 1, type: 'signing_started' })
		);
	});
});

// ═══════════════════════════ malformed / missing body still fails cleanly

describe('malformed body handling (shared by both routes via readSpendRequest/readJson)', () => {
	it('single-sig: an invalid JSON body is rejected before buildDraft is ever called', async () => {
		const url = 'http://localhost/api/wallets/psbt-under-test';
		const ev = {
			locals: { user: { id: 1, email: 'user@example.com', isAdmin: false }, flags: { send: true } },
			params: { id: '7' },
			url: new URL(url),
			request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
		} as unknown as Ev;

		await expect(singleSigPOST(ev)).rejects.toMatchObject({ status: 400 });
		expect(mocks.buildDraft).not.toHaveBeenCalled();
	});
});
