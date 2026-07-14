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
	resetChainHealthForTests,
	getCoreHealth,
	recordCoreOk,
	recordCoreError,
	resetCoreHealth,
	getNetworkHealth
} from './chainHealth';
import { db } from './db';
import { setSetting } from './settings';

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

// cairn-7zjo — neverConfigured is settings.ts's isChainNeverConfigured()
// mirrored onto the health snapshot so the banner components don't need a
// second settings read. It must be computed fresh on every getChainHealth()
// call and must be entirely independent of the transport-derived `healthy`
// flag: an instance can be simultaneously "never configured" AND "healthy"
// (defaults just work) or "never configured" AND "unhealthy" (defaults are
// currently unreachable) — either way the calm first-run banner, not the
// scary unreachable one, is what should render.
describe('neverConfigured (cairn-7zjo)', () => {
	beforeEach(() => {
		// resetChainHealthForTests() only resets the in-memory health snapshot;
		// the settings table is a separate store that can leak state from
		// sibling test files, so clear it explicitly too.
		db.exec('DELETE FROM settings;');
	});

	it('is true fresh (before any connection_mode or chain_provisioned_by is set)', () => {
		expect(getChainHealth().neverConfigured).toBe(true);
	});

	it('is false once connection_mode is set to public', () => {
		setSetting('connection_mode', 'public');
		expect(getChainHealth().neverConfigured).toBe(false);
	});

	it('is false once chain_provisioned_by is set (umbrel probe auto-seed)', () => {
		setSetting('chain_provisioned_by', 'umbrel-probe');
		expect(getChainHealth().neverConfigured).toBe(false);
	});

	it('is computed independently of `healthy` — true both before and after transport failures', () => {
		expect(getChainHealth().neverConfigured).toBe(true);
		expect(getChainHealth().healthy).toBe(true);

		recordChainError(new Error('x'));
		recordChainError(new Error('x'));
		const h = getChainHealth();
		expect(h.healthy).toBe(false); // transport is down…
		expect(h.neverConfigured).toBe(true); // …but that's unrelated to provisioning state
	});
});

// cairn-7qmw — Bitcoin Core RPC is a first-class chain backend post-Esplora, so
// it carries its OWN reachability signal, fed by the CoreRpcClient's per-call
// onResult sink. This is what lets NodeTrust honestly claim "Verified by your
// Bitcoin Core node" when Core is the live source even while Electrum is down.
describe('Core RPC health (cairn-7qmw)', () => {
	beforeEach(() => {
		db.exec('DELETE FROM settings;');
		resetCoreHealth();
	});

	it('starts healthy with nothing recorded; reports configured from settings', () => {
		const c = getCoreHealth();
		expect(c.healthy).toBe(true);
		expect(c.lastOkAt).toBeNull();
		expect(c.configured).toBe(false);

		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		expect(getCoreHealth().configured).toBe(true);
	});

	it('records ok/error independently of the Electrum signal', () => {
		// Electrum goes fully down…
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		expect(getChainHealth().healthy).toBe(false);
		// …but a successful Core call keeps Core healthy with a fresh lastOkAt.
		recordCoreOk();
		const c = getCoreHealth();
		expect(c.healthy).toBe(true);
		expect(c.lastOkAt).not.toBeNull();
	});

	it('tolerates a single Core blip but flips unhealthy past the threshold', () => {
		recordCoreError(new Error('ECONNREFUSED'));
		expect(getCoreHealth().healthy).toBe(true);
		recordCoreError(new Error('ECONNREFUSED'));
		const c = getCoreHealth();
		expect(c.healthy).toBe(false);
		expect(c.lastError).toMatch(/ECONNREFUSED/);
	});

	it('resetCoreHealth clears the Core signal without touching Electrum', () => {
		recordCoreOk();
		recordChainOk();
		resetCoreHealth();
		expect(getCoreHealth().lastOkAt).toBeNull();
		// Electrum's own lastOkAt is untouched by a Core reset.
		expect(getChainHealth().lastOkAt).not.toBeNull();
	});
});

// cairn-7qmw — the instance-wide "can't reach the Bitcoin network" banner reads
// the UNION: an Electrum-only outage must not raise it when Core RPC is
// configured and reachable (the operator's own node still serves the explorer).
describe('getNetworkHealth — honest backend union (cairn-7qmw)', () => {
	beforeEach(() => {
		db.exec('DELETE FROM settings;');
		resetCoreHealth();
	});

	it('is healthy when Electrum is healthy regardless of Core', () => {
		expect(getNetworkHealth().healthy).toBe(true);
	});

	it('stays healthy when Electrum is down but Core is configured and reachable', () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		expect(getChainHealth().healthy).toBe(false); // Electrum-only signal is down…
		recordCoreOk(); // …but Core answered.
		expect(getNetworkHealth().healthy).toBe(true);
	});

	it('reports unreachable when Electrum is down and Core is NOT configured', () => {
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		recordCoreOk(); // a stray Core ok must not rescue the banner when Core isn't configured
		expect(getNetworkHealth().healthy).toBe(false);
	});

	it('reports unreachable when BOTH Electrum and Core are down', () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		recordCoreError(new Error('core down'));
		recordCoreError(new Error('core down'));
		expect(getNetworkHealth().healthy).toBe(false);
	});
});
