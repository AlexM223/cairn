// Regression test for cairn-j412: the Node overview's `node` field used to be
// an unawaited, streamed promise wrapping a LIVE Electrum round-trip
// (getChain().getNodeInfo()). On a real instance that promise could fail to
// ever reach the client (the streamed chunk never arriving), leaving the page
// frozen on its "Checking connection…" skeleton forever — tip 000,000, ring
// 000 forming, "Server host.example:50002" — even while Explorer/Home showed
// correct, live data from the same chain state at the very same time.
//
// The fix sources `node` synchronously from the SAME signals Explorer/Home
// already read reliably: the background-synced chain snapshot
// (chainSnapshot.ts) and the in-memory transport-health signal
// (chainHealth.ts). This pins down that `load()` returns real, immediately-
// usable data in each of the three states the UI distinguishes: connected,
// genuinely still starting up (never attempted), and tried-and-failed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/chainHealth', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/chainHealth')>();
	return { ...mod, getNetworkHealth: vi.fn() };
});

vi.mock('$lib/server/chainSnapshot', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/chainSnapshot')>();
	return { ...mod, readChainSnapshot: vi.fn() };
});

import { getNetworkHealth } from '$lib/server/chainHealth';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { load } from './+page.server';
import type { NodeInfo } from '$lib/types';

const mockHealth = vi.mocked(getNetworkHealth);
const mockSnapshot = vi.mocked(readChainSnapshot);

function snapshotWith(tipHeight: number | null, hash: string | null = null) {
	return {
		data: {
			blocks: hash ? [{ hash }] : [],
			tipHeight,
			tipTime: null,
			hashrate: null,
			mempoolSummary: null,
			fees: null,
			difficultyInfo: null,
			difficultyHistory: null,
			mempoolBlocks: null,
			feeHistogram: null,
			mempoolTrend: null
		},
		lastSyncedAt: Date.now()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function noEvent(): any {
	return {};
}

describe('/admin load — node overview data path (cairn-j412)', () => {
	beforeEach(() => {
		mockHealth.mockReset();
		mockSnapshot.mockReset();
	});

	it('reports connected with the live tip once the chain is healthy and a snapshot exists — no promise, resolved synchronously in load()', async () => {
		mockHealth.mockReturnValue({
			healthy: true,
			proxyConfigured: false,
			lastError: null,
			lastErrorAt: null,
			lastOkAt: 1000,
			neverConfigured: false
		});
		mockSnapshot.mockReturnValue(snapshotWith(668, 'abcd1234'));

		const data = (await load(noEvent())) as { node: NodeInfo };

		// The old bug: `node` was a Promise, so even a correct backend answer
		// could sit unresolved on the client forever. It must now be a plain
		// value the page can render on the very first paint.
		expect(data.node).not.toHaveProperty('then');
		expect(data.node).toMatchObject({
			connected: true,
			tipHeight: 668,
			tipHash: 'abcd1234',
			error: undefined
		});
	});

	it('reports a real, honest error once a connection has actually been attempted and failed — not a stuck "checking" state', async () => {
		mockHealth.mockReturnValue({
			healthy: false,
			proxyConfigured: false,
			lastError: 'Electrum connect to electrum.blockstream.info:50002 timed out after 15000ms',
			lastErrorAt: 2000,
			lastOkAt: null,
			neverConfigured: false
		});
		mockSnapshot.mockReturnValue(null);

		const data = (await load(noEvent())) as { node: NodeInfo };

		expect(data.node.connected).toBe(false);
		expect(data.node.tipHeight).toBeNull();
		expect(data.node.error).toMatch(/timed out/);
	});

	it('leaves error undefined (the genuine "Checking connection…" transient) only when no attempt has ever been recorded and no snapshot exists yet', async () => {
		mockHealth.mockReturnValue({
			healthy: true,
			proxyConfigured: false,
			lastError: null,
			lastErrorAt: null,
			lastOkAt: null,
			neverConfigured: true
		});
		mockSnapshot.mockReturnValue(null);

		const data = (await load(noEvent())) as { node: NodeInfo };

		expect(data.node.connected).toBe(false);
		expect(data.node.tipHeight).toBeNull();
		expect(data.node.error).toBeUndefined();
	});

	it('never reports connected when the snapshot is stale/missing even if the transport itself is healthy — tip must come from real data, not assumed from health alone', async () => {
		mockHealth.mockReturnValue({
			healthy: true,
			proxyConfigured: false,
			lastError: null,
			lastErrorAt: null,
			lastOkAt: 500,
			neverConfigured: false
		});
		mockSnapshot.mockReturnValue(snapshotWith(null));

		const data = (await load(noEvent())) as { node: NodeInfo };

		expect(data.node.connected).toBe(false);
		expect(data.node.tipHeight).toBeNull();
	});
});
