// cairn-gt05.11 — review-step verification copy contract. The review heading
// must be a first-person verification act (destination-focused), never a
// generic "Review"; the own-node line is a mechanism fact with no badges,
// seals, or reassurance adjectives.

import { describe, it, expect } from 'vitest';
import { REVIEW_HEADING, OWN_NODE_BROADCAST_LINE } from './sendCopy';

describe('review verification copy (gt05.11)', () => {
	it('the review heading is a verification act aimed at the destination', () => {
		expect(REVIEW_HEADING).toMatch(/right place|going to/i);
		// Not a generic label.
		expect(REVIEW_HEADING.trim().toLowerCase()).not.toBe('review');
		expect(REVIEW_HEADING).not.toMatch(/^review\b/i);
	});

	it('the own-node line states the mechanism, not reassurance', () => {
		expect(OWN_NODE_BROADCAST_LINE).toMatch(/your own node/i);
		expect(OWN_NODE_BROADCAST_LINE).toMatch(/no third party/i);
		// No badge/seal/reassurance-adjective register.
		expect(OWN_NODE_BROADCAST_LINE).not.toMatch(/secure|safe|guaranteed|trusted|protected/i);
	});
});
