import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import {
	persistScanResult,
	loadPersistedScans,
	deletePersistedScan,
	clearPersistedScans
} from './scanCachePersist';

// Round-trip the persisted portfolio scan cache (cairn-er1k) without a network
// or a real scan: persist → load → assert the JSON survives, and prove
// invalidation (single-key + whole-kind) actually removes rows so a deleted
// wallet's stale scan can never be re-seeded.

function wipe(): void {
	db.exec('DELETE FROM wallet_scan_cache;');
}

beforeEach(wipe);

const WALLET_RESULT = {
	addresses: [{ address: 'bc1qexample', derivationPath: "m/84'/0'/0'/0/0", index: 0, change: false, used: true, balance: 1000, txCount: 1 }],
	txs: [{ txid: 'a'.repeat(64), height: 800000, time: 1700000000, delta: 1000, fee: 200 }],
	confirmed: 1000,
	unconfirmed: 0
};

const MULTISIG_RESULT = {
	addresses: [{ address: 'bc1qmsexample', chain: 0 as const, index: 0, used: true, balance: 5000, txCount: 2 }],
	txs: [{ txid: 'b'.repeat(64), height: 800001, time: 1700000001, delta: 5000, fee: 300 }],
	confirmed: 5000,
	unconfirmed: -100
};

describe('scanCachePersist round-trip', () => {
	it('persists and reloads a wallet scan result verbatim', () => {
		persistScanResult('wallet', 'zpubWALLET', WALLET_RESULT);
		const rows = loadPersistedScans<typeof WALLET_RESULT>('wallet');
		expect(rows.length).toBe(1);
		expect(rows[0].key).toBe('zpubWALLET');
		expect(rows[0].result).toEqual(WALLET_RESULT);
		expect(rows[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('keeps wallet and multisig kinds in separate key spaces', () => {
		persistScanResult('wallet', 'keyA', WALLET_RESULT);
		persistScanResult('multisig', 'keyB', MULTISIG_RESULT);
		expect(loadPersistedScans('wallet').map((r) => r.key)).toEqual(['keyA']);
		expect(loadPersistedScans('multisig').map((r) => r.key)).toEqual(['keyB']);
	});

	it('upserts on the same key rather than duplicating', () => {
		persistScanResult('wallet', 'dup', { ...WALLET_RESULT, confirmed: 1 });
		persistScanResult('wallet', 'dup', { ...WALLET_RESULT, confirmed: 2 });
		const rows = loadPersistedScans<typeof WALLET_RESULT>('wallet');
		expect(rows.length).toBe(1);
		expect(rows[0].result.confirmed).toBe(2);
	});

	it('deletePersistedScan removes exactly one key (trims whitespace)', () => {
		persistScanResult('wallet', 'gone', WALLET_RESULT);
		persistScanResult('wallet', 'stays', WALLET_RESULT);
		deletePersistedScan('  gone  ');
		expect(loadPersistedScans('wallet').map((r) => r.key)).toEqual(['stays']);
	});

	it('clearPersistedScans drops a whole kind, leaving the other', () => {
		persistScanResult('wallet', 'w1', WALLET_RESULT);
		persistScanResult('multisig', 'm1', MULTISIG_RESULT);
		clearPersistedScans('wallet');
		expect(loadPersistedScans('wallet').length).toBe(0);
		expect(loadPersistedScans('multisig').length).toBe(1);
	});

	it('skips a corrupt result row instead of throwing', () => {
		db.prepare(
			"INSERT INTO wallet_scan_cache (cache_key, kind, result, updated_at) VALUES ('bad', 'wallet', '{not json', '2026-01-01T00:00:00Z')"
		).run();
		persistScanResult('wallet', 'good', WALLET_RESULT);
		const rows = loadPersistedScans('wallet');
		expect(rows.map((r) => r.key)).toEqual(['good']);
	});
});
