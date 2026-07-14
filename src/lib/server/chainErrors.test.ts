import { describe, it, expect, vi } from 'vitest';
import { classifyChainError, isConnectivityError, sanitizeChainError } from './chainErrors';

describe('isConnectivityError', () => {
	it('recognizes ECONNREFUSED', () => {
		expect(isConnectivityError(new Error('connect ECONNREFUSED 127.0.0.1:50001'))).toBe(true);
	});

	it('recognizes ETIMEDOUT', () => {
		expect(isConnectivityError(new Error('connect ETIMEDOUT 10.0.0.5:50001'))).toBe(true);
	});

	it('recognizes ENOTFOUND', () => {
		expect(isConnectivityError(new Error('getaddrinfo ENOTFOUND electrum.example.com'))).toBe(true);
	});

	it('recognizes EHOSTUNREACH', () => {
		expect(isConnectivityError(new Error('connect EHOSTUNREACH 10.0.0.5:50001'))).toBe(true);
	});

	it('recognizes the Electrum client\'s own "not connected" / "closed" wording', () => {
		expect(isConnectivityError(new Error('client is closed'))).toBe(true);
		expect(isConnectivityError(new Error('not connected'))).toBe(true);
	});

	it('does not flag an unrelated application error', () => {
		expect(isConnectivityError(new Error('electrum down'))).toBe(false);
		expect(isConnectivityError(new Error('insufficient funds'))).toBe(false);
	});
});

describe('classifyChainError', () => {
	it('collapses ECONNREFUSED to the friendly fallback', () => {
		expect(classifyChainError(new Error('connect ECONNREFUSED 127.0.0.1:50001'))).toBe(
			"Can't reach the Electrum server. Check your node's connection and try again in a moment."
		);
	});

	it('collapses ETIMEDOUT to the friendly fallback', () => {
		expect(classifyChainError(new Error('connect ETIMEDOUT 10.0.0.5:50001'))).toContain(
			"Can't reach the Electrum server"
		);
	});

	it('collapses ENOTFOUND to the friendly fallback', () => {
		expect(classifyChainError(new Error('getaddrinfo ENOTFOUND bitcoind.local'))).toContain(
			"Can't reach the Electrum server"
		);
	});

	it('collapses EHOSTUNREACH to the friendly fallback', () => {
		expect(classifyChainError(new Error('connect EHOSTUNREACH 10.0.0.5:50001'))).toContain(
			"Can't reach the Electrum server"
		);
	});

	it('lets a generic application Error pass through verbatim', () => {
		expect(classifyChainError(new Error('electrum down'))).toBe('electrum down');
	});

	it('uses a custom connectivity message when given one', () => {
		expect(
			classifyChainError(new Error('ECONNREFUSED'), "Can't reach your Bitcoin node.")
		).toBe("Can't reach your Bitcoin node.");
	});

	it('falls back for a non-Error throw', () => {
		expect(classifyChainError('just a string', undefined, 'Scan failed')).toBe('Scan failed');
	});

	it('falls back for an Error with an empty message', () => {
		expect(classifyChainError(new Error(''), undefined, 'Scan failed')).toBe('Scan failed');
	});
});

describe('sanitizeChainError', () => {
	it('logs the raw error and returns the sanitized message', () => {
		const warn = vi.fn();
		const raw = new Error('connect ECONNREFUSED 127.0.0.1:50001');
		const result = sanitizeChainError(raw, { warn }, { walletId: 7 }, 'wallet scan failed');

		expect(result).toBe(
			"Can't reach the Electrum server. Check your node's connection and try again in a moment."
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith({ err: raw, walletId: 7 }, 'wallet scan failed');
	});

	it('still logs the raw error for a non-connectivity message that passes through', () => {
		const warn = vi.fn();
		const raw = new Error('electrum down');
		const result = sanitizeChainError(raw, { warn }, { walletId: 7 }, 'wallet scan failed');

		expect(result).toBe('electrum down');
		expect(warn).toHaveBeenCalledWith({ err: raw, walletId: 7 }, 'wallet scan failed');
	});
});
