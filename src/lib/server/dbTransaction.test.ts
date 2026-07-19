// cairn-fzqpe: withTransaction is the crash-atomicity primitive behind the
// address watcher's "claim txid as notified" + "enqueue notification" pair. A
// process death between those two synchronous writes used to leave a claimed-
// but-never-sent alert (permanently suppressed by alreadyNotified). The wrapped
// unit either fully commits or fully rolls back — these tests pin that
// contract, since the crash itself can't be simulated in-process.

import { describe, it, expect, beforeEach } from 'vitest';
import { db, withTransaction } from './db';

const count = () =>
	(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'txtest_%'").get() as { n: number })
		.n;
const put = (k: string) =>
	db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`txtest_${k}`, 'v');

beforeEach(() => {
	db.exec("DELETE FROM settings WHERE key LIKE 'txtest_%'");
});

describe('withTransaction (cairn-fzqpe)', () => {
	it('commits every write when fn returns', () => {
		const result = withTransaction(() => {
			put('a');
			put('b');
			return 42;
		});
		expect(result).toBe(42);
		expect(count()).toBe(2);
	});

	it('rolls back EVERY write when fn throws mid-way — the first write does not survive', () => {
		expect(() =>
			withTransaction(() => {
				put('a');
				throw new Error('simulated death mid-unit');
			})
		).toThrow('simulated death mid-unit');
		expect(count()).toBe(0); // the claim-analog rolled back with the failure
	});

	it('a nested call defers to the outer transaction (no premature commit, one atomic unit)', () => {
		expect(() =>
			withTransaction(() => {
				put('outer');
				withTransaction(() => {
					put('inner');
				}); // must NOT commit here
				throw new Error('outer dies after inner returned');
			})
		).toThrow('outer dies after inner returned');
		// Both rolled back together: the inner unit belonged to the outer one.
		expect(count()).toBe(0);
	});

	it('leaves the connection usable after a rollback', () => {
		try {
			withTransaction(() => {
				put('a');
				throw new Error('boom');
			});
		} catch {
			/* expected */
		}
		put('after');
		expect(count()).toBe(1);
	});
});
