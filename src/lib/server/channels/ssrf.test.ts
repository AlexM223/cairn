import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db';
import { setSetting } from '../settings';

// Mock DNS so hostname-based checks are deterministic (no real lookups).
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args)
}));

import {
	isBlockedIPv4,
	isBlockedAddress,
	checkTargetHost,
	checkTargetUrl,
	checkRelayUrl
} from './ssrf';

function wipeSettings(): void {
	db.exec('DELETE FROM settings;');
}

beforeEach(() => {
	wipeSettings();
	vi.clearAllMocks();
	// Default: hostnames resolve to a public address.
	lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isBlockedIPv4 — CGNAT 100.64.0.0/10 (cairn-pihb)', () => {
	it('blocks the whole 100.64.0.0/10 range (incl. Tailscale)', () => {
		for (const ip of ['100.64.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255']) {
			expect(isBlockedIPv4(ip), `${ip} should be blocked`).toBe(true);
			expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
		}
	});

	it('does NOT block the public addresses just outside 100.64.0.0/10', () => {
		// 100.63.x and 100.128.x are ordinary public space — must stay allowed.
		for (const ip of ['100.63.255.255', '100.128.0.0', '100.200.0.1']) {
			expect(isBlockedIPv4(ip), `${ip} should be allowed`).toBe(false);
		}
	});

	it('still blocks the pre-existing ranges', () => {
		for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0']) {
			expect(isBlockedIPv4(ip)).toBe(true);
		}
	});
});

describe('checkTargetHost — bare host (SMTP relay, cairn-ruxo)', () => {
	it('rejects a literal blocked IP without any DNS lookup', async () => {
		const res = await checkTargetHost('10.0.0.5');
		expect(res.ok).toBe(false);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it('rejects a literal CGNAT IP (100.64.0.0/10)', async () => {
		const res = await checkTargetHost('100.100.100.100');
		expect(res.ok).toBe(false);
	});

	it('allows a literal public IP', async () => {
		const res = await checkTargetHost('93.184.216.34');
		expect(res.ok).toBe(true);
	});

	it('rejects a hostname that RESOLVES into a blocked range', async () => {
		lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
		const res = await checkTargetHost('smtp.internal.example');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/blocked/i);
	});

	it('rejects if ANY resolved address is blocked (mixed records)', async () => {
		lookupMock.mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '100.100.0.1', family: 4 } // CGNAT
		]);
		const res = await checkTargetHost('mixed.example');
		expect(res.ok).toBe(false);
	});

	it('allows a private host when the admin escape hatch is on', async () => {
		setSetting('webhook_allow_private_targets', 'true');
		const res = await checkTargetHost('10.0.0.5');
		expect(res.ok).toBe(true);
	});
});

describe('checkRelayUrl — Nostr relays over ws/wss (cairn-zn7z)', () => {
	it('accepts a wss:// relay resolving to a public address', async () => {
		const res = await checkRelayUrl('wss://relay.example');
		expect(res.ok).toBe(true);
	});

	it('accepts a plain ws:// relay', async () => {
		const res = await checkRelayUrl('ws://relay.example');
		expect(res.ok).toBe(true);
	});

	it('rejects a wss:// relay pointed at a loopback literal before connecting', async () => {
		const res = await checkRelayUrl('wss://127.0.0.1:4848');
		expect(res.ok).toBe(false);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it('rejects a wss:// relay that RESOLVES into a blocked range', async () => {
		lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
		const res = await checkRelayUrl('wss://internal.relay');
		expect(res.ok).toBe(false);
	});

	it('rejects a non-ws scheme (http) as an unsupported scheme', async () => {
		const res = await checkRelayUrl('https://relay.example');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/scheme/i);
	});
});

describe('checkTargetUrl — scheme modes stay segregated', () => {
	it('default (http) mode still rejects a ws:// URL', async () => {
		const res = await checkTargetUrl('wss://relay.example');
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/scheme/i);
	});

	it('default (http) mode accepts https and rejects file://', async () => {
		const ok = await checkTargetUrl('https://example.com/x');
		expect(ok.ok).toBe(true);
		const bad = await checkTargetUrl('file:///etc/passwd');
		expect(bad.ok).toBe(false);
	});

	it('ws mode rejects an http:// URL', async () => {
		const res = await checkTargetUrl('http://example.com', { scheme: 'ws' });
		expect(res.ok).toBe(false);
	});
});
