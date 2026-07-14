// Honesty-matrix tests for NodeTrust (cairn-6efi.3, Explorer-redesign Wave 2
// track T-B). Every cell of Cardinal rule 2's matrix is asserted here, plus the
// structural invariants that make the matrix impossible to violate:
//
//   • "Verified" / verified:true appears for EXACTLY ONE input combination
//     (Core RPC configured AND connected).
//   • No public-mode input can ever produce a "your node" / core claim.
//   • ownInfrastructure (the "nothing came from a third party" gate) is true
//     iff the source is the operator's own Core/Electrum, never on public/none.
//
// deriveNodeTrust is pure over an explicit input struct, so no server/db is
// needed for the matrix — the gatherNodeTrust smoke test at the end exercises
// the cached-signal wiring.

import { describe, it, expect, beforeEach } from 'vitest';
import { deriveNodeTrust, nodeTrustKind, gatherNodeTrust } from './nodeTrust';
import type { NodeTrustInputs } from './nodeTrust';
import type { NodeTrustKind } from '$lib/types';
import {
	resetChainHealthForTests,
	recordChainOk,
	recordChainError,
	recordCoreOk,
	recordCoreError
} from '../chainHealth';
import { setSetting } from '../settings';
import { db } from '../db';

/** A fully-specified baseline; each case overrides only the axes under test. */
function inputs(over: Partial<NodeTrustInputs> = {}): NodeTrustInputs {
	return {
		neverConfigured: false,
		mode: 'public',
		coreConfigured: false,
		connected: true,
		tipHeight: 860_000,
		lastSyncedAt: 1_700_000_000_000,
		electrumServer: 'electrum.example:50002',
		coreServer: '10.21.21.8:8332',
		provisionedBy: null,
		syncPhase: 'synced',
		...over
	};
}

describe('nodeTrustKind — the honesty matrix decision function', () => {
	const cases: Array<{ name: string; over: Partial<NodeTrustInputs>; kind: NodeTrustKind }> = [
		// Core RPC configured — the ONLY path to a "verified" claim.
		{ name: 'core configured + connected', over: { coreConfigured: true, connected: true }, kind: 'core-verified' },
		{ name: 'core configured + disconnected', over: { coreConfigured: true, connected: false }, kind: 'core-unreachable' },
		// Core wins even in nominally "public" electrum mode (Core is custom-only).
		{ name: 'core configured overrides public electrum mode', over: { coreConfigured: true, connected: true, mode: 'public' }, kind: 'core-verified' },
		// Core wins even over a never-configured electrum connection.
		{ name: 'core configured overrides never-configured', over: { coreConfigured: true, connected: true, neverConfigured: true }, kind: 'core-verified' },
		// Custom Electrum, no Core.
		{ name: 'custom electrum + connected', over: { mode: 'custom', connected: true }, kind: 'electrum-custom' },
		{ name: 'custom electrum + disconnected', over: { mode: 'custom', connected: false }, kind: 'electrum-custom-unreachable' },
		// Public default.
		{ name: 'public + connected', over: { mode: 'public', connected: true }, kind: 'public' },
		{ name: 'public + disconnected', over: { mode: 'public', connected: false }, kind: 'public-unreachable' },
		// Never configured (and no Core).
		{ name: 'never configured', over: { neverConfigured: true, connected: false }, kind: 'unconfigured' },
		{ name: 'never configured beats public even if "connected"', over: { neverConfigured: true, connected: true }, kind: 'unconfigured' }
	];

	for (const c of cases) {
		it(c.name + ` -> ${c.kind}`, () => {
			expect(nodeTrustKind(inputs(c.over))).toBe(c.kind);
		});
	}
});

describe('deriveNodeTrust — per-cell copy + flags', () => {
	it('core-verified: the one and only "Verified by your Bitcoin Core node"', () => {
		const t = deriveNodeTrust(inputs({ coreConfigured: true, connected: true }));
		expect(t.kind).toBe('core-verified');
		expect(t.label).toBe('Verified by your Bitcoin Core node');
		expect(t.verified).toBe(true);
		expect(t.source).toBe('core');
		expect(t.ownInfrastructure).toBe(true);
		expect(t.tone).toBe('verified');
		// Core kinds surface the Core host, not the Electrum server.
		expect(t.server).toBe('10.21.21.8:8332');
	});

	it('core-unreachable: configured but cannot claim verified', () => {
		const t = deriveNodeTrust(inputs({ coreConfigured: true, connected: false }));
		expect(t.kind).toBe('core-unreachable');
		expect(t.verified).toBe(false);
		expect(t.label).not.toMatch(/verified/i);
		expect(t.label).toBe('Your Bitcoin Core node is unreachable');
		expect(t.tone).toBe('warning');
		expect(t.ownInfrastructure).toBe(true);
	});

	it('electrum-custom: "served", never "verified"', () => {
		const t = deriveNodeTrust(inputs({ mode: 'custom', connected: true }));
		expect(t.kind).toBe('electrum-custom');
		expect(t.label).toBe('Served by your Electrum server');
		expect(t.label).not.toMatch(/verified/i);
		expect(t.verified).toBe(false);
		expect(t.source).toBe('electrum');
		expect(t.ownInfrastructure).toBe(true);
		expect(t.server).toBe('electrum.example:50002');
	});

	it('electrum-custom-unreachable', () => {
		const t = deriveNodeTrust(inputs({ mode: 'custom', connected: false }));
		expect(t.kind).toBe('electrum-custom-unreachable');
		expect(t.verified).toBe(false);
		expect(t.tone).toBe('warning');
		expect(t.ownInfrastructure).toBe(true);
	});

	it('public: never claims "your node" and is not own infrastructure', () => {
		const t = deriveNodeTrust(inputs({ mode: 'public', connected: true }));
		expect(t.kind).toBe('public');
		expect(t.label).toBe('Using the public default server');
		expect(t.label).not.toMatch(/your (node|bitcoin core|electrum)/i);
		expect(t.verified).toBe(false);
		expect(t.source).toBe('public');
		expect(t.ownInfrastructure).toBe(false);
	});

	it('public-unreachable', () => {
		const t = deriveNodeTrust(inputs({ mode: 'public', connected: false }));
		expect(t.kind).toBe('public-unreachable');
		expect(t.ownInfrastructure).toBe(false);
		expect(t.verified).toBe(false);
		expect(t.tone).toBe('warning');
	});

	it('unconfigured: "not connected to a node yet", no server', () => {
		const t = deriveNodeTrust(inputs({ neverConfigured: true, connected: false }));
		expect(t.kind).toBe('unconfigured');
		expect(t.label).toBe('Not connected to a node yet');
		expect(t.source).toBe('none');
		expect(t.server).toBeNull();
		expect(t.verified).toBe(false);
		expect(t.ownInfrastructure).toBe(false);
	});

	it('passes through display-only fields verbatim', () => {
		const t = deriveNodeTrust(
			inputs({ tipHeight: 861_234, lastSyncedAt: 42, provisionedBy: 'umbrel-env', syncPhase: 'history' })
		);
		expect(t.tipHeight).toBe(861_234);
		expect(t.lastSyncedAt).toBe(42);
		expect(t.provisionedBy).toBe('umbrel-env');
		expect(t.syncPhase).toBe('history');
	});
});

describe('structural honesty invariants (over the full input space)', () => {
	// Enumerate every boolean/mode combination of the four decision axes.
	const bools = [true, false];
	const modes = ['public', 'custom'] as const;
	const all: NodeTrustInputs[] = [];
	for (const neverConfigured of bools)
		for (const coreConfigured of bools)
			for (const connected of bools)
				for (const mode of modes)
					all.push(inputs({ neverConfigured, coreConfigured, connected, mode }));

	it('verified:true iff Core RPC configured AND connected — never otherwise', () => {
		for (const i of all) {
			const t = deriveNodeTrust(i);
			expect(t.verified).toBe(i.coreConfigured && i.connected);
			// The literal word "Verified" is coupled to the flag.
			expect(/^verified/i.test(t.label)).toBe(t.verified);
		}
	});

	it('a public-source claim never says "your node" and is never own infrastructure', () => {
		for (const i of all) {
			const t = deriveNodeTrust(i);
			if (t.source === 'public') {
				expect(t.ownInfrastructure).toBe(false);
				expect(t.label).not.toMatch(/your (node|bitcoin core|electrum)/i);
				expect(t.verified).toBe(false);
			}
		}
	});

	it('ownInfrastructure iff source is core or electrum (own), never public/none', () => {
		for (const i of all) {
			const t = deriveNodeTrust(i);
			expect(t.ownInfrastructure).toBe(t.source === 'core' || t.source === 'electrum');
		}
	});

	it('a "core" claim is only reachable when Core RPC is configured', () => {
		for (const i of all) {
			const t = deriveNodeTrust(i);
			if (t.source === 'core') expect(i.coreConfigured).toBe(true);
		}
	});

	it('every input yields a defined label and headline', () => {
		for (const i of all) {
			const t = deriveNodeTrust(i);
			expect(typeof t.label).toBe('string');
			expect(t.label.length).toBeGreaterThan(0);
			expect(t.headline.length).toBeGreaterThan(0);
		}
	});
});

describe('gatherNodeTrust — cached-signal wiring (no chain calls)', () => {
	beforeEach(() => {
		resetChainHealthForTests();
	});

	it('reports unconfigured + connecting on a fresh instance', () => {
		// Fresh test DB: no connection_mode / chain_provisioned_by, no recorded
		// health (lastOkAt null) → not connected → connecting.
		const t = gatherNodeTrust();
		expect(t.connected).toBe(false);
		expect(['connecting', 'unreachable']).toContain(t.syncPhase);
		// With nothing configured the honest state is unconfigured/public — never a
		// verified/core claim.
		expect(t.verified).toBe(false);
		expect(t.source).not.toBe('core');
	});

	it('never reports connected until an actual handshake was recorded', () => {
		// Even with a custom server configured, connected stays false until
		// chainHealth records a successful handshake (cached, non-probing signal).
		setSetting('connection_mode', 'custom');
		expect(gatherNodeTrust().connected).toBe(false);
		recordChainOk();
		expect(gatherNodeTrust().connected).toBe(true);
	});
});

// cairn-7qmw regression — when Core RPC is the configured backend, the trust
// chip must read CORE reachability, not the Electrum-only signal. A working
// Core node with a dead Electrum earns "Verified by your Bitcoin Core node";
// it is never falsely reported unreachable.
describe('gatherNodeTrust — per-backend health honesty (cairn-7qmw)', () => {
	beforeEach(() => {
		db.exec('DELETE FROM settings;');
		resetChainHealthForTests();
	});

	it('Core up + Electrum down → connected with Core provenance (the verified badge)', () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		// Electrum is fully down — the OLD behaviour would mislabel this unreachable.
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		// Core answered.
		recordCoreOk();

		const t = gatherNodeTrust();
		expect(t.connected).toBe(true);
		expect(t.source).toBe('core');
		expect(t.kind).toBe('core-verified');
		expect(t.verified).toBe(true);
	});

	it('Core configured but not yet answering → core-unreachable (never falsely verified)', () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		// Even a healthy Electrum must not lend Core a "verified" it hasn't earned.
		recordChainOk();
		const t = gatherNodeTrust();
		expect(t.connected).toBe(false);
		expect(t.kind).toBe('core-unreachable');
		expect(t.verified).toBe(false);
	});

	it('both backends down → unreachable, not verified', () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		recordChainError(new Error('electrum down'));
		recordChainError(new Error('electrum down'));
		recordCoreError(new Error('core down'));
		recordCoreError(new Error('core down'));
		const t = gatherNodeTrust();
		expect(t.connected).toBe(false);
		expect(t.kind).toBe('core-unreachable');
		expect(t.verified).toBe(false);
	});
});
