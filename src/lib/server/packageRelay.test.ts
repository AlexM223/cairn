// Package-relay orchestrator (cairn-u9ob.8). The Electrum edge is mocked so the
// support-probe caching and degrade-silently semantics are testable without a
// server that implements broadcast_package.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { broadcastPackageMock } = vi.hoisted(() => ({ broadcastPackageMock: vi.fn() }));

vi.mock('./chain', () => ({
	getChain: () => ({ electrum: { broadcastPackage: broadcastPackageMock } })
}));

import {
	broadcastPackage,
	resetPackageRelaySupport,
	packageRelaySupportState
} from './packageRelay';

const PARENT = '01'.repeat(40);
const CHILD = '02'.repeat(40);

beforeEach(() => {
	broadcastPackageMock.mockReset();
	resetPackageRelaySupport();
});

describe('broadcastPackage', () => {
	it('reports sent and caches support on success', async () => {
		broadcastPackageMock.mockResolvedValue(['txidA', 'txidB']);
		const r = await broadcastPackage([PARENT, CHILD]);
		expect(r).toEqual({ status: 'sent', response: ['txidA', 'txidB'] });
		expect(packageRelaySupportState()).toBe(true);
	});

	it('marks unsupported (cached) on an unknown-method error and short-circuits', async () => {
		broadcastPackageMock.mockRejectedValueOnce(new Error('unknown method')).mockResolvedValue(null);
		const first = await broadcastPackage([PARENT, CHILD]);
		expect(first).toEqual({ status: 'unsupported' });
		expect(packageRelaySupportState()).toBe(false);

		// A second call must NOT hit the network — support is cached false.
		const second = await broadcastPackage([PARENT, CHILD]);
		expect(second).toEqual({ status: 'unsupported' });
		expect(broadcastPackageMock).toHaveBeenCalledTimes(1);
	});

	it('reports failed (not unsupported) when the node rejects the package itself', async () => {
		broadcastPackageMock
			.mockRejectedValueOnce(new Error('package-fee-too-low'))
			.mockResolvedValue(null);
		const r = await broadcastPackage([PARENT, CHILD]);
		expect(r.status).toBe('failed');
		// The method exists — support stays true so a better-fee retry is allowed.
		expect(packageRelaySupportState()).toBe(true);
	});

	it('refuses a package of fewer than two txs', async () => {
		const r = await broadcastPackage([CHILD]);
		expect(r.status).toBe('failed');
		expect(broadcastPackageMock).not.toHaveBeenCalled();
	});

	it('resetPackageRelaySupport re-enables probing after a backend change', async () => {
		broadcastPackageMock.mockRejectedValueOnce(new Error('method not found')).mockResolvedValue('ok');
		await broadcastPackage([PARENT, CHILD]); // caches unsupported
		expect(packageRelaySupportState()).toBe(false);
		resetPackageRelaySupport();
		expect(packageRelaySupportState()).toBe(null);
		const r = await broadcastPackage([PARENT, CHILD]); // probes again
		expect(r.status).toBe('sent');
	});
});
