// cairn-1muh: walletApi.ts is the shared plumbing behind the wallet-scoped API
// resource pairs — most relevantly the spend/PSBT-build request path, which is
// an untrusted external entry point. These tests pin down what it actually
// validates today:
//
//   - readSpendRequest: how it shapes an arbitrary JSON body into a SpendRequest
//     (legacy single-recipient vs batch, amount coercion, coin-control UTXO
//     sanitization) and WHICH branches trip the coin_control / batch_transactions
//     feature gates. Malformed / oversized input must be rejected cleanly (a
//     typed 400/413 HttpError the router turns into a response) — never a crash.
//   - psbtBuildErrorResponse: the shared PsbtError -> HTTP status mapping. A
//     malformed/failed downstream build must surface as a clean 400/404/502,
//     never an unhandled 500.
//   - classifyUtxoMasses: the lazy + cached + individually-tolerant parent-mass
//     classification (an unfetchable parent is simply absent, not a throw).
//   - backupFileResponse: the dated descriptor-download response shape.
//
// NOTE ON SCOPE: this module does NOT itself parse a PSBT or match a PSBT to a
// wallet/xpub — that validation lives downstream in the psbt builder/service.
// These tests cover what THIS file does; the "wrong-wallet PSBT" rejection is
// out of scope here by construction.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ---- Mock the chain source + signing-mass cache so classifyUtxoMasses is
// deterministic without a live Electrum/esplora backend. Everything else
// (api.ts feature gates, the real PsbtError, walletExport slug) stays real.
const chainMock = vi.hoisted(() => ({ getTxHex: vi.fn() }));
vi.mock('./chain', () => ({
	getChain: () => ({
		getTxHex: chainMock.getTxHex,
		getTip: async () => ({ height: 0, hash: '' }),
		getTx: async () => ({})
	})
}));

const massMock = vi.hoisted(() => ({
	cache: new Map<string, { vsize: number; source: string }>()
}));
vi.mock('./bitcoin/signingMass', () => ({
	getCachedParentMass: (txid: string) => massMock.cache.get(txid),
	classifyAndCacheParent: (txid: string) => {
		// Model a successful classify: parent lands in the cache as "fetched".
		massMock.cache.set(txid, { vsize: 200, source: 'fetched' });
	},
	tierForVsize: (vsize: number) => (vsize > 100 ? 'heavy' : 'light')
}));

import {
	readSpendRequest,
	psbtBuildErrorResponse,
	classifyUtxoMasses,
	backupFileResponse
} from './walletApi';
import { PsbtError } from './bitcoin/psbt';

const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);

type Flags = Record<string, boolean>;
const ALL_ON: Flags = { coin_control: true, batch_transactions: true };

function spendEvent(
	body: unknown,
	opts: { flags?: Flags; rawBody?: string; withUser?: boolean } = {}
): RequestEvent {
	const { flags = ALL_ON, rawBody, withUser = true } = opts;
	const payload = rawBody ?? JSON.stringify(body);
	return {
		request: new Request('http://localhost/api/wallets/1/psbt', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: payload
		}),
		url: new URL('http://localhost/api/wallets/1/psbt'),
		getClientAddress: () => '10.0.0.1',
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		locals: {
			user: withUser ? { id: 1, email: 'u@example.com', displayName: 'U', isAdmin: false } : undefined,
			flags
		}
	} as unknown as RequestEvent;
}

describe('readSpendRequest — request shaping', () => {
	it('accepts the legacy single-recipient shape as a length-1 recipients array', async () => {
		const req = await readSpendRequest(
			spendEvent({ recipient: 'bc1qexample', amount: 50_000, feeRate: 12 })
		);
		expect(req.recipients).toEqual([{ address: 'bc1qexample', amount: 50_000 }]);
		expect(req.feeRate).toBe(12);
		// One recipient, no coin control → no feature gate consulted, onlyUtxos absent.
		expect(req.onlyUtxos).toBeUndefined();
	});

	it('accepts a multi-recipient batch and preserves order + amounts', async () => {
		const req = await readSpendRequest(
			spendEvent({
				recipients: [
					{ address: 'addr1', amount: 1000 },
					{ address: 'addr2', amount: 'max' }
				],
				feeRate: 5
			})
		);
		expect(req.recipients).toEqual([
			{ address: 'addr1', amount: 1000 },
			{ address: 'addr2', amount: 'max' }
		]);
	});

	it("preserves the 'max' amount sentinel and coerces stringy numbers via Number()", async () => {
		const req = await readSpendRequest(
			spendEvent({ recipient: 'addr', amount: 'max', feeRate: '15' })
		);
		expect(req.recipients[0].amount).toBe('max');
		expect(req.feeRate).toBe(15); // '15' → Number → 15
	});

	it('sanitizes onlyUtxos: drops bad txids, non-integer and negative vouts', async () => {
		const req = await readSpendRequest(
			spendEvent({
				recipient: 'addr',
				amount: 100,
				feeRate: 1,
				onlyUtxos: [
					{ txid: TXID_A, vout: 0 }, // valid
					{ txid: TXID_B, vout: 2 }, // valid
					{ txid: 'not-a-txid', vout: 0 }, // bad txid
					{ txid: TXID_A, vout: -1 }, // negative vout
					{ txid: TXID_A, vout: 1.5 } // non-integer vout
				]
			})
		);
		expect(req.onlyUtxos).toEqual([
			{ txid: TXID_A, vout: 0 },
			{ txid: TXID_B, vout: 2 }
		]);
	});

	it('when every onlyUtxos entry is invalid, onlyUtxos is undefined and coin_control is NOT enforced', async () => {
		// All entries filtered out → the coin-control gate must not fire even if the
		// flag is off, because no coin control is actually being exercised.
		const req = await readSpendRequest(
			spendEvent(
				{
					recipient: 'addr',
					amount: 100,
					feeRate: 1,
					onlyUtxos: [{ txid: 'bad', vout: 0 }]
				},
				{ flags: { coin_control: false, batch_transactions: true } }
			)
		);
		expect(req.onlyUtxos).toBeUndefined();
	});

	it('rejects a malformed JSON body with a clean 400 (no crash)', async () => {
		await expect(
			readSpendRequest(spendEvent(null, { rawBody: '{ this is not json' }))
		).rejects.toMatchObject({ status: 400 });
	});

	it('rejects an oversized body with a clean 413 (self-DoS guard)', async () => {
		const huge = 'x'.repeat(1_000_001); // just over the 1 MB cap in api.ts
		await expect(
			readSpendRequest(spendEvent(null, { rawBody: huge }))
		).rejects.toMatchObject({ status: 413 });
	});
});

describe('readSpendRequest — feature gates', () => {
	it('a real coin-control request is rejected 403 when coin_control is disabled', async () => {
		await expect(
			readSpendRequest(
				spendEvent(
					{ recipient: 'addr', amount: 100, feeRate: 1, onlyUtxos: [{ txid: TXID_A, vout: 0 }] },
					{ flags: { coin_control: false, batch_transactions: true } }
				)
			)
		).rejects.toMatchObject({ status: 403 });
	});

	it('a batch (multi-recipient) request is rejected 403 when batch_transactions is disabled', async () => {
		await expect(
			readSpendRequest(
				spendEvent(
					{
						recipients: [
							{ address: 'a', amount: 1 },
							{ address: 'b', amount: 2 }
						],
						feeRate: 1
					},
					{ flags: { coin_control: true, batch_transactions: false } }
				)
			)
		).rejects.toMatchObject({ status: 403 });
	});

	it('a gate-triggering request from an unauthenticated caller is rejected 401 before anything else', async () => {
		await expect(
			readSpendRequest(
				spendEvent(
					{
						recipients: [
							{ address: 'a', amount: 1 },
							{ address: 'b', amount: 2 }
						],
						feeRate: 1
					},
					{ withUser: false }
				)
			)
		).rejects.toMatchObject({ status: 401 });
	});

	it('an ordinary single-recipient auto-select spend needs no feature and no user', async () => {
		// Neither gate is exercised, so this must succeed even with both flags off
		// and no user in locals — the common-case path is never gated.
		const req = await readSpendRequest(
			spendEvent(
				{ recipient: 'addr', amount: 100, feeRate: 1 },
				{ flags: { coin_control: false, batch_transactions: false }, withUser: false }
			)
		);
		expect(req.recipients).toHaveLength(1);
	});
});

describe('psbtBuildErrorResponse — shared error mapping', () => {
	async function bodyOf(res: Response) {
		return (await res.json()) as { error?: string; code?: string };
	}

	it("maps a 'construction_failed' PsbtError to 404 with its code", async () => {
		const res = psbtBuildErrorResponse(
			new PsbtError('Spending from p2tr wallets is not supported yet.', 'construction_failed'),
			{ walletId: 7 }
		);
		expect(res.status).toBe(404);
		expect(await bodyOf(res)).toMatchObject({ code: 'construction_failed' });
	});

	it('maps other PsbtErrors to 400 with the code and message', async () => {
		const res = psbtBuildErrorResponse(new PsbtError('Not enough funds.', 'insufficient_funds'), {
			multisigId: 3
		});
		expect(res.status).toBe(400);
		expect(await bodyOf(res)).toEqual({
			error: 'Not enough funds.',
			code: 'insufficient_funds'
		});
	});

	it('maps a generic Error to 502 with house-standard copy that still surfaces the raw message (qa-findings-R8.md X1)', async () => {
		const res = psbtBuildErrorResponse(
			new Error('Electrum connection error (127.0.0.1:60401): connect ECONNREFUSED 127.0.0.1:60401'),
			{ walletId: 1 }
		);
		expect(res.status).toBe(502);
		const body = await bodyOf(res);
		// What happened + what to do (UX-PLAN §5.1), not a bare transport string.
		expect(body.error).toMatch(/^Couldn't reach the Bitcoin network to build this transaction:/);
		expect(body.error).toContain('Check your node');
		// The raw detail is kept verbatim, never the only thing shown.
		expect(body.error).toContain(
			'Electrum connection error (127.0.0.1:60401): connect ECONNREFUSED 127.0.0.1:60401'
		);
	});

	it('maps a non-Error throw to 502 with a safe generic message, still in house-standard form', async () => {
		const res = psbtBuildErrorResponse('a bare string was thrown', { walletId: 1 });
		expect(res.status).toBe(502);
		const body = await bodyOf(res);
		expect(body.error).toMatch(/^Couldn't reach the Bitcoin network to build this transaction:/);
		expect(body.error).toContain('a bare string was thrown');
	});
});

describe('classifyUtxoMasses — lazy, cached, individually tolerant', () => {
	beforeEach(() => {
		massMock.cache.clear();
		chainMock.getTxHex.mockReset();
	});

	it('omits a UTXO whose parent cannot be fetched (tolerated, not thrown)', async () => {
		chainMock.getTxHex.mockRejectedValue(new Error('parent unavailable'));
		const out = await classifyUtxoMasses([{ txid: TXID_A, vout: 0 }]);
		expect(out).toEqual([]);
		expect(chainMock.getTxHex).toHaveBeenCalledWith(TXID_A);
	});

	it('classifies a freshly fetched parent and reports its tier + source', async () => {
		chainMock.getTxHex.mockResolvedValue('00'.repeat(100));
		const out = await classifyUtxoMasses([{ txid: TXID_A, vout: 3 }]);
		expect(out).toEqual([
			{ txid: TXID_A, vout: 3, parentVsize: 200, tier: 'heavy', source: 'fetched' }
		]);
	});

	it('uses the process-wide cache and never re-fetches a known parent', async () => {
		massMock.cache.set(TXID_A, { vsize: 50, source: 'cache' });
		const out = await classifyUtxoMasses([{ txid: TXID_A, vout: 0 }]);
		expect(out).toEqual([
			{ txid: TXID_A, vout: 0, parentVsize: 50, tier: 'light', source: 'cache' }
		]);
		expect(chainMock.getTxHex).not.toHaveBeenCalled();
	});
});

describe('backupFileResponse — descriptor download', () => {
	it('sets a text/plain attachment with a dated descriptor filename and echoes the body', async () => {
		const res = backupFileResponse('wsh(sortedmulti(2,...))', 'My Cold Wallet');
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		const cd = res.headers.get('content-disposition') ?? '';
		expect(cd).toMatch(/attachment; filename="cairn-.*-backup-\d{4}-\d{2}-\d{2}-descriptor\.txt"/);
		expect(await res.text()).toBe('wsh(sortedmulti(2,...))');
	});

	it('adds cache-control no-store only when requested', async () => {
		expect(backupFileResponse('x', 'W').headers.get('cache-control')).toBeNull();
		expect(backupFileResponse('x', 'W', { noStore: true }).headers.get('cache-control')).toBe(
			'no-store'
		);
	});
});
