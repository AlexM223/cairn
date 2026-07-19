import { describe, it, expect } from 'vitest';
import { deriveHealth, STORAGE_ATTENTION_PCT } from './health';

describe('deriveHealth — the shared Health object (spec §2.6a/b)', () => {
	const allGood = {
		chainHealthy: true as boolean | null,
		unbackedCount: 0,
		configBackupStale: false,
		storagePctFull: 42,
		users: { total: 1, admins: 1 }
	};

	it('reads all-healthy when every duty is fine', () => {
		const h = deriveHealth(allGood);
		expect(h.ok).toBe(true);
		expect(h.issueCount).toBe(0);
		expect(h.headline).toBe('All systems healthy');
		expect(h.homeLabel).toBe('Health · All good');
		expect(h.node.status).toBe('ok');
		expect(h.backups.status).toBe('ok');
		expect(h.storage.status).toBe('ok');
		expect(h.users.status).toBe('ok');
	});

	it('flags an unbacked wallet as one amber backups issue', () => {
		const h = deriveHealth({ ...allGood, unbackedCount: 1 });
		expect(h.ok).toBe(false);
		expect(h.issueCount).toBe(1);
		expect(h.headline).toBe('1 thing needs your attention');
		expect(h.backups).toEqual({ status: 'attention', issues: 1 });
	});

	it('counts each unbacked wallet as its own issue (matches the Home line)', () => {
		const h = deriveHealth({ ...allGood, unbackedCount: 3 });
		expect(h.issueCount).toBe(3);
		expect(h.headline).toBe('3 things need your attention');
		expect(h.homeLabel).toBe('Health · 3 needs attention');
	});

	it('adds one more backups issue when the instance config backup is stale', () => {
		const h = deriveHealth({ ...allGood, unbackedCount: 1, configBackupStale: true });
		expect(h.backups).toEqual({ status: 'attention', issues: 2 });
		expect(h.issueCount).toBe(2);
	});

	it('flags a stale config backup alone (no unbacked wallets)', () => {
		const h = deriveHealth({ ...allGood, configBackupStale: true });
		expect(h.backups).toEqual({ status: 'attention', issues: 1 });
		expect(h.ok).toBe(false);
	});

	it('flags an unreachable chain transport as one node issue', () => {
		const h = deriveHealth({ ...allGood, chainHealthy: false });
		expect(h.node).toEqual({ status: 'attention', issues: 1 });
		expect(h.issueCount).toBe(1);
	});

	it('treats a not-yet-determined transport (null) as unknown, never an alarm', () => {
		const h = deriveHealth({ ...allGood, chainHealthy: null });
		expect(h.node).toEqual({ status: 'unknown', issues: 0 });
		expect(h.ok).toBe(true);
	});

	it(`turns Storage amber at ${STORAGE_ATTENTION_PCT}% full`, () => {
		expect(deriveHealth({ ...allGood, storagePctFull: STORAGE_ATTENTION_PCT }).storage).toEqual({
			status: 'attention',
			issues: 1
		});
		expect(
			deriveHealth({ ...allGood, storagePctFull: STORAGE_ATTENTION_PCT - 0.1 }).storage.status
		).toBe('ok');
	});

	it('reports unknown (zero issues) for duties this altitude cannot see', () => {
		// Home's altitude: only chain + unbacked are observable.
		const h = deriveHealth({ chainHealthy: true, unbackedCount: 0 });
		expect(h.storage.status).toBe('unknown');
		expect(h.users.status).toBe('unknown');
		expect(h.ok).toBe(true);
		expect(h.issueCount).toBe(0);
	});

	it('sums issues across duties into one headline count', () => {
		const h = deriveHealth({
			chainHealthy: false,
			unbackedCount: 2,
			configBackupStale: true,
			storagePctFull: 95,
			users: { total: 4, admins: 1 }
		});
		expect(h.issueCount).toBe(5);
		expect(h.headline).toBe('5 things need your attention');
		expect(h.ok).toBe(false);
	});

	it('user counts are informational and never contribute issues', () => {
		const h = deriveHealth({ ...allGood, users: { total: 90, admins: 12 } });
		expect(h.users).toEqual({ status: 'ok', issues: 0 });
		expect(h.issueCount).toBe(0);
	});

	it('never goes negative on a malformed unbacked count', () => {
		const h = deriveHealth({ ...allGood, unbackedCount: -5 });
		expect(h.issueCount).toBe(0);
		expect(h.ok).toBe(true);
	});
});
