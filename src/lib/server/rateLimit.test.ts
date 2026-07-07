import { describe, it, expect } from 'vitest';
import { clientIpFor } from './rateLimit';

describe('clientIpFor', () => {
	it('returns the adapter-resolved address when available', () => {
		expect(clientIpFor({ getClientAddress: () => '203.0.113.7' })).toBe('203.0.113.7');
	});

	it("folds a throwing getClientAddress into the 'unknown' bucket (cairn-kfis)", () => {
		// adapter-node throws when ADDRESS_HEADER is configured but absent from
		// the request — true for every request on the direct HTTPS listener.
		// This must never 500 an auth endpoint.
		expect(
			clientIpFor({
				getClientAddress: () => {
					throw new Error(
						'Address header was specified with ADDRESS_HEADER=x-forwarded-for but is absent from request'
					);
				}
			})
		).toBe('unknown');
	});
});
