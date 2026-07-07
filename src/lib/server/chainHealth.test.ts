// Unit tests for the chain-transport health signal (cairn-hy8z): the cheap,
// in-memory last-known state derived from Electrum connection outcomes that
// drives the instance-wide "can't reach the Bitcoin network" banner and the
// admin settings proxy indicator.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	getChainHealth,
	recordChainOk,
	recordChainError,
	noteProxyConfigured,
	resetChainHealth,
	resetChainHealthForTests
} from './chainHealth';

beforeEach(() => resetChainHealthForTests());

describe('chainHealth (cairn-hy8z)', () => {
	it('starts healthy with nothing recorded and no proxy', () => {
		const h = getChainHealth();
		expect(h.healthy).toBe(true);
		expect(h.lastError).toBeNull();
		expect(h.lastErrorAt).toBeNull();
		expect(h.lastOkAt).toBeNull();
		expect(h.proxyConfigured).toBe(false);
	});

	it('tolerates a single transient failure but flips unhealthy past the threshold', () => {
		recordChainError(new Error('socket closed'));
		expect(getChainHealth().healthy).toBe(true); // one blip < threshold

		recordChainError(new Error('Socks5 proxy rejected connection - Failure'));
		const h = getChainHealth();
		expect(h.healthy).toBe(false);
		expect(h.lastError).toMatch(/proxy rejected/);
		expect(h.lastErrorAt).not.toBeNull();
	});

	it('does not surface an error message while still healthy', () => {
		recordChainError(new Error('blip'));
		expect(getChainHealth().lastError).toBeNull();
	});

	it('a success resets the failure count and clears the error', () => {
		recordChainError(new Error('down'));
		recordChainError(new Error('down'));
		expect(getChainHealth().healthy).toBe(false);

		recordChainOk();
		const h = getChainHealth();
		expect(h.healthy).toBe(true);
		expect(h.lastError).toBeNull();
		expect(h.lastOkAt).not.toBeNull();
	});

	it('coerces a non-Error rejection to a string message', () => {
		recordChainError('raw string failure');
		recordChainError('raw string failure');
		expect(getChainHealth().lastError).toBe('raw string failure');
	});

	it('reflects a configured proxy and keeps it across a health reset', () => {
		noteProxyConfigured(true);
		expect(getChainHealth().proxyConfigured).toBe(true);

		recordChainError(new Error('x'));
		recordChainError(new Error('x'));
		expect(getChainHealth().healthy).toBe(false);

		// reconfigureChain calls resetChainHealth: failures clear, but the proxy fact
		// is re-noted by the next ChainService constructor, so it should survive here.
		resetChainHealth();
		const h = getChainHealth();
		expect(h.healthy).toBe(true);
		expect(h.lastError).toBeNull();
		expect(h.proxyConfigured).toBe(true);
	});
});
