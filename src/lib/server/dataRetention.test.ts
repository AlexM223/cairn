// Pins the retention-sweep dispatcher contract (cairn-zui7.1): every registered
// step runs, in order, and one step throwing or rejecting is contained — it is
// reported failed but never prevents the remaining steps from running.

import { describe, it, expect, vi } from 'vitest';
import { runRetentionSweep, type RetentionStep } from './dataRetention';

describe('runRetentionSweep', () => {
	it('runs every step in registration order', async () => {
		const order: string[] = [];
		const steps: RetentionStep[] = ['a', 'b', 'c'].map((name) => ({
			name,
			run: () => {
				order.push(name);
			}
		}));

		const results = await runRetentionSweep(steps);
		expect(order).toEqual(['a', 'b', 'c']);
		expect(results).toEqual([
			{ name: 'a', ok: true },
			{ name: 'b', ok: true },
			{ name: 'c', ok: true }
		]);
	});

	it('a throwing step is contained — later steps still run', async () => {
		const after = vi.fn();
		const results = await runRetentionSweep([
			{
				name: 'boom',
				run: () => {
					throw new Error('purge failed');
				}
			},
			{ name: 'after', run: after }
		]);

		expect(after).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			{ name: 'boom', ok: false },
			{ name: 'after', ok: true }
		]);
	});

	it('a rejecting async step is contained too', async () => {
		const after = vi.fn(async () => {});
		const results = await runRetentionSweep([
			{ name: 'reject', run: async () => Promise.reject(new Error('nope')) },
			{ name: 'after', run: after }
		]);

		expect(after).toHaveBeenCalledTimes(1);
		expect(results.map((r) => r.ok)).toEqual([false, true]);
	});

	it('an empty step list is a no-op', async () => {
		expect(await runRetentionSweep([])).toEqual([]);
	});
});
