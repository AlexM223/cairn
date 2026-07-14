import { describe, it, expect, beforeEach, vi } from 'vitest';

// Explorer tx-detail loader — error-UI branches NOT covered by the existing
// page.server.test.ts (which owns the cache hit/miss/timeout SWR behavior).
// This file pins the two "honest branch" cases the .svelte template derives
// from load()'s output (see +page.svelte L656-660: `!data.coreRpcConfigured`
// renders CoreRpcRequiredNotice via the in-page notFound state) on a CACHE
// MISS with no prior snapshot:
//   1. Core RPC unconfigured + chain.getTx throws a non-notFound error =>
//      notFound:true (in-page honest state), never a route-level throw.
//   2. Core RPC configured + chain.getTx throws a genuine (non-notFound)
//      error => a route-level error(502) — the ONE branch on this route that
//      is allowed to reject, and it's SvelteKit's own controlled error-page
//      mechanism (an HttpError), not a hang or an unhandled rejection.
//   3. A syntactically-valid txid with a genuine not-found response (no RBF
//      replacement) => in-page notFound:true with tx:null, regardless of
//      coreRpcConfigured.
// ChainService is fully stubbed; no Electrum/Core network calls.

const h = vi.hoisted(() => {
	const chain = {
		getTx: vi.fn(),
		getTxRbfInfo: vi.fn(async (): Promise<{ chain: { txid: string }[] } | null> => null),
		getFeeEstimates: vi.fn(async () => null),
		getCpfpInfo: vi.fn(async () => null),
		getTxHex: vi.fn(async () => null)
	};
	return { chain };
});

vi.mock('$lib/server/chain', () => ({ getChain: () => h.chain }));

import { db } from '$lib/server/db';
import { setSetting } from '$lib/server/settings';
import { __resetTxSnapshotForTests } from '$lib/server/txSnapshot';
import { load } from './+page.server';

const TXID = 'e'.repeat(64);

function loadEvent(txid: string, search = '') {
	return {
		params: { txid },
		url: new URL(`http://localhost/explorer/tx/${txid}${search}`),
		depends: vi.fn(),
		locals: {}
	} as unknown as Parameters<typeof load>[0];
}

beforeEach(() => {
	db.exec("DELETE FROM tx_snapshots; DELETE FROM settings; DELETE FROM instance_secrets;");
	__resetTxSnapshotForTests();
	h.chain.getTx.mockReset();
	h.chain.getTxRbfInfo.mockReset().mockResolvedValue(null);
});

describe('explorer tx load() — Core RPC unconfigured, genuine backend error (cache miss)', () => {
	it('degrades to an in-page notFound:true (CoreRpcRequiredNotice), never a route throw', async () => {
		// No core_rpc_url set => coreRpcConfigured() is false.
		h.chain.getTx.mockRejectedValue(new Error('Core RPC not configured for tx lookups'));

		const data = (await load(loadEvent(TXID))) as {
			notFound: boolean;
			loading: boolean;
			tx: unknown;
			coreRpcConfigured: boolean;
		};

		expect(data.coreRpcConfigured).toBe(false);
		expect(data.notFound).toBe(true);
		expect(data.loading).toBe(false);
		expect(data.tx).toBeNull();
	});
});

describe('explorer tx load() — Core RPC configured, genuine backend outage (cache miss)', () => {
	it('surfaces a route-level error(502) — a controlled SvelteKit error, not a silent hang', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getTx.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8332'));

		let caught: unknown = null;
		try {
			await load(loadEvent(TXID));
		} catch (e) {
			caught = e;
		}

		expect(caught).not.toBeNull();
		// SvelteKit's error() throws an object carrying { status, body }.
		expect((caught as { status?: number }).status).toBe(502);
		expect(JSON.stringify(caught)).toContain('ECONNREFUSED');
	});
});

describe('explorer tx load() — genuine not-found, no RBF replacement (cache miss)', () => {
	it('renders in-page notFound:true with tx:null regardless of coreRpcConfigured', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getTx.mockRejectedValue(new Error('Transaction not found'));
		h.chain.getTxRbfInfo.mockResolvedValue(null);

		const data = (await load(loadEvent(TXID))) as {
			notFound: boolean;
			loading: boolean;
			tx: unknown;
			coreRpcConfigured: boolean;
		};

		expect(data.coreRpcConfigured).toBe(true);
		expect(data.notFound).toBe(true);
		expect(data.tx).toBeNull();
	});

	it('a not-found txid that WAS replaced redirects (302) instead of rendering notFound', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getTx.mockRejectedValue(new Error('Transaction not found'));
		const replacement = 'f'.repeat(64);
		h.chain.getTxRbfInfo.mockResolvedValue({ chain: [{ txid: TXID }, { txid: replacement }] });

		let caught: unknown = null;
		try {
			await load(loadEvent(TXID));
		} catch (e) {
			caught = e;
		}

		expect((caught as { status?: number }).status).toBe(302);
		expect((caught as { location?: string }).location).toBe(
			`/explorer/tx/${replacement}?replaced=${TXID}`
		);
	});
});

describe('explorer tx load() — malformed txid stays a synchronous route 404 (no chain call)', () => {
	it('throws error(404) for a non-hex/wrong-length txid without touching the chain', async () => {
		h.chain.getTx.mockRejectedValue(new Error('should never be called'));

		let caught: unknown = null;
		try {
			await load(loadEvent('not-a-real-txid'));
		} catch (e) {
			caught = e;
		}

		expect((caught as { status?: number }).status).toBe(404);
		expect(h.chain.getTx).not.toHaveBeenCalled();
	});
});
