import { describe, it, expect } from 'vitest';
import { txPageTitle } from './txTitle';

const TXID = 'a'.repeat(64);

describe('txPageTitle', () => {
	it('shows the truncated txid when the transaction loaded', () => {
		expect(txPageTitle({ tx: { txid: TXID }, loading: false, coreRpcConfigured: true })).toBe(
			`Tx ${TXID.slice(0, 8)}…${TXID.slice(-8)}`
		);
	});

	it('shows a looking-up state while the "looking this up" shell polls', () => {
		expect(txPageTitle({ tx: null, loading: true, coreRpcConfigured: true })).toBe(
			'Looking up transaction'
		);
	});

	// The bug this guards against: the body correctly renders CoreRpcRequiredNotice
	// when no Bitcoin Core node is configured, but the title used to hardcode
	// "Transaction not found" regardless — misleading on Electrum-only instances.
	it('names the real reason when Core RPC is not configured, not a bare "not found"', () => {
		expect(txPageTitle({ tx: null, loading: false, coreRpcConfigured: false })).toBe(
			'Transaction — needs Bitcoin Core'
		);
	});

	it('is a genuine "not found" only when Core RPC IS configured and nothing loaded', () => {
		expect(txPageTitle({ tx: null, loading: false, coreRpcConfigured: true })).toBe(
			'Transaction not found'
		);
	});
});
