// cairn-wrph, cairn-9njl — fill-when-absent x-forwarded-proto helper.
// Exercises the standalone module (scripts/serverProto.mjs) that server.mjs's
// two listeners (http/https) use to give adapter-node a real per-listener
// protocol signal for unconfigured (bare-node, no ORIGIN/PROTOCOL_HEADER)
// deployments — without this, adapter-node's get_origin() defaults every
// request to "https" regardless of which listener it hit, so a login over
// plain HTTP got a Secure session cookie the browser silently drops.
import { describe, it, expect } from 'vitest';
import { fillForwardedProto } from '../../scripts/serverProto.mjs';

describe('fillForwardedProto', () => {
	it('fills x-forwarded-proto with the listener protocol when absent', () => {
		const headers: Record<string, string | undefined> = { host: 'umbrel.local:3000' };
		fillForwardedProto(headers, 'http');
		expect(headers['x-forwarded-proto']).toBe('http');
	});

	it('preserves an inbound x-forwarded-proto (reverse-proxy topology regression guard)', () => {
		const headers: Record<string, string | undefined> = {
			host: 'umbrel.local:3000',
			'x-forwarded-proto': 'https'
		};
		fillForwardedProto(headers, 'http');
		expect(headers['x-forwarded-proto']).toBe('https');
	});

	it('https listener fills "https" when absent', () => {
		const headers: Record<string, string | undefined> = {};
		fillForwardedProto(headers, 'https');
		expect(headers['x-forwarded-proto']).toBe('https');
	});

	it('never mutates any header other than x-forwarded-proto', () => {
		const headers: Record<string, string | undefined> = {
			host: 'umbrel.local:3000',
			cookie: 'cairn_session=abc123',
			'user-agent': 'test-agent'
		};
		const before = { ...headers };
		fillForwardedProto(headers, 'http');
		expect(headers.host).toBe(before.host);
		expect(headers.cookie).toBe(before.cookie);
		expect(headers['user-agent']).toBe(before['user-agent']);
	});

	it('returns the same headers object it was given', () => {
		const headers: Record<string, string | undefined> = {};
		expect(fillForwardedProto(headers, 'http')).toBe(headers);
	});
});
