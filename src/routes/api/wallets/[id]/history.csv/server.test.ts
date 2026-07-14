// cairn-cdbb (follow-up to cairn-sgtr, 3eeb7ea) — history.csv calls scanWallet
// directly (same shape as walletSync.ts's doWalletScan), so a raw Electrum/
// socket error (e.g. "connect ECONNREFUSED 127.0.0.1:50001") used to reach the
// client verbatim in the 502's error body. Verifies the route now runs it
// through sanitizeChainError: a connectivity-class failure collapses to the
// stable plain-language message and the raw error is still logged
// server-side; a non-connectivity Error's own message still passes through
// (it's usually the actionable one).

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
	scanWallet: vi.fn(),
	getWallet: vi.fn(),
	getLabels: vi.fn()
}));

vi.mock('$lib/server/logger', () => ({
	childLogger: () => logMock,
	logger: logMock,
	LOG_FILE: 'test.log',
	REDACT_OPTIONS: {}
}));
vi.mock('$lib/server/bitcoin/walletScan', () => ({
	scanWallet: mocks.scanWallet
}));
vi.mock('$lib/server/wallets', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/wallets')>()),
	getWallet: mocks.getWallet,
	getLabels: mocks.getLabels
}));

import { GET } from './+server';

type Ev = Parameters<typeof GET>[0];

/** Fake RequestEvent: signed-in user, csv_export feature enabled. */
function makeEvent(id: string): Ev {
	const url = `http://localhost/api/wallets/${id}/history.csv`;
	return {
		locals: {
			user: { id: 1, email: 'user@example.com', isAdmin: false },
			flags: { csv_export: true }
		},
		params: { id },
		url: new URL(url),
		request: new Request(url)
	} as unknown as Ev;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getWallet.mockReturnValue({ id: 7, userId: 1, name: 'Cold storage', xpub: 'xpub-fake' });
	mocks.getLabels.mockReturnValue({});
});

describe('history.csv scan failure → sanitized error (cairn-cdbb)', () => {
	it('collapses a raw connectivity error to the stable message and logs the raw one', async () => {
		mocks.scanWallet.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:50001'));

		await expect(GET(makeEvent('7'))).rejects.toMatchObject({
			status: 502,
			body: {
				message: "Can't reach the Electrum server. Check your node's connection and try again in a moment."
			}
		});

		expect(logMock.warn).toHaveBeenCalledTimes(1);
		expect(logMock.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error), walletId: 7 }),
			'wallet history.csv scan failed'
		);
	});

	it('lets a non-connectivity application error message pass through', async () => {
		mocks.scanWallet.mockRejectedValue(new Error('gap limit exceeded'));

		await expect(GET(makeEvent('7'))).rejects.toMatchObject({
			status: 502,
			body: { message: 'gap limit exceeded' }
		});
	});

	it('falls back to the generic message for a non-Error throw', async () => {
		mocks.scanWallet.mockRejectedValue('boom');

		await expect(GET(makeEvent('7'))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Could not scan the wallet.' }
		});
	});
});
