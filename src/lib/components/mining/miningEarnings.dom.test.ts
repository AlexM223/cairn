// Mount-based regression test for cairn-et5a0: Svelte 5 throws
// `each_key_duplicate` (crashing client render/hydration of the whole
// dashboard subtree, silently) when a keyed {#each} key collides. The old key
// here was `${row.height}:${row.vout}` — but vout is always 0 for coinbase
// outputs, and regtest/reorg churn legitimately records multiple blocksFound
// rows at the same height (a rejected/reorged-out submit followed by the
// block that actually stuck, or repeated resubmits), so height:vout is NOT
// unique. The fix keys on `row.txid ?? `${row.height}:${row.vout}:${i}``
// instead (row.txid is unique per found block; the index fallback only
// applies to null-txid rejected-submit rows, and index+the composite is
// unique enough there because those rows are never reordered).
//
// This test only exists in the jsdom project (vitest.config.ts) because the
// bug is unreachable from a node-environment unit test: it requires an actual
// Svelte client mount to trigger the each-block's key-uniqueness check.
import { describe, expect, it } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import MiningEarnings from './MiningEarnings.svelte';

function makeFixture() {
	// Real prod shape (per getUserMiningView): several rows share height 284,
	// vout 0 — three distinct successful finds plus a same-height rejected
	// resubmit with txid: null — and height 154 has one mature + one rejected
	// row, also colliding on height:vout under the old key.
	const blocksFound = [
		{
			height: 284,
			txid: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-07-01T12:00:00.000Z',
			status: 'mature' as const
		},
		{
			height: 284,
			txid: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-07-01T12:05:00.000Z',
			status: 'maturing' as const
		},
		{
			height: 284,
			txid: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-07-01T12:10:00.000Z',
			status: 'maturing' as const
		},
		{
			height: 154,
			txid: null,
			vout: 0,
			reward: 312500000,
			foundAt: '2026-06-20T08:00:00.000Z',
			status: 'rejected' as const
		},
		{
			height: 154,
			txid: 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-06-20T08:02:00.000Z',
			status: 'mature' as const
		},
		{
			height: 90,
			txid: null,
			vout: 0,
			reward: 312500000,
			foundAt: '2026-06-10T00:00:00.000Z',
			status: 'rejected' as const
		},
		{
			height: 60,
			txid: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-06-01T00:00:00.000Z',
			status: 'mature' as const
		},
		{
			height: 12,
			txid: 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
			vout: 0,
			reward: 312500000,
			foundAt: '2026-05-20T00:00:00.000Z',
			status: 'mature' as const
		}
	];

	return {
		blocksFound,
		totalMaturedSats: 937500000,
		totalPendingSats: 625000000
	};
}

describe('MiningEarnings (cairn-et5a0)', () => {
	it('mounts without each_key_duplicate on duplicate height:vout rows', () => {
		const fixture = makeFixture();
		const target = document.body.appendChild(document.createElement('div'));

		let app: Record<string, unknown> | undefined;
		expect(() => {
			app = mount(MiningEarnings, { target, props: { ...fixture } });
			flushSync();
		}).not.toThrow();

		const rowEls = target.querySelectorAll('.block-row');
		expect(rowEls.length).toBe(fixture.blocksFound.length);

		if (app) unmount(app);
	});
});
