// Pins the mandated key-check copy (MULTISIG-KEY-AUDIT-DESIGN §2): the exact
// passphrase loss-of-funds warning, the plain "not recommended" statement,
// and that both no-match causes (wrong seed / passphrase) are distinct,
// present, and clearly attributed. A drift here is a copy regression.

import { describe, it, expect } from 'vitest';
import {
	KEY_MATCH_HEADLINE,
	WRONG_SEED_HEADLINE,
	WRONG_SEED_BODY,
	PASSPHRASE_CAUSE_HEADLINE,
	PASSPHRASE_CAUSE_BODY,
	PASSPHRASE_LOSS_WARNING,
	PASSPHRASE_NOT_RECOMMENDED,
	PROACTIVE_PASSPHRASE_NOTE
} from './keyCheckCopy';

describe('key-check copy (MULTISIG-KEY-AUDIT-DESIGN §2)', () => {
	it('MATCH headline reads exactly "This key matches — you\'re good."', () => {
		expect(KEY_MATCH_HEADLINE).toBe("This key matches — you're good.");
	});

	it('the no-match copy explains BOTH causes, plainly and equally', () => {
		expect(WRONG_SEED_HEADLINE.toLowerCase()).toContain('seed');
		expect(WRONG_SEED_BODY.toLowerCase()).toContain('different seed');

		expect(PASSPHRASE_CAUSE_HEADLINE.toLowerCase()).toContain('passphrase');
		expect(PASSPHRASE_CAUSE_BODY.toLowerCase()).toContain('different set of keys');
		expect(PASSPHRASE_CAUSE_BODY).toContain('25th word');
	});

	it('the passphrase loss-of-funds warning matches the mandated wording verbatim', () => {
		expect(PASSPHRASE_LOSS_WARNING).toBe(
			'Using a passphrase creates a single point of failure. If you forget it, you could permanently lose access to your funds.'
		);
	});

	it('states plainly that passphrase + multisig is not recommended', () => {
		expect(PASSPHRASE_NOT_RECOMMENDED).toBe('Using a passphrase with multisig is not recommended.');
	});

	it('the proactive add-key passphrase note mentions BIP39/passphrase and the lockout risk (§4)', () => {
		expect(PROACTIVE_PASSPHRASE_NOTE.toLowerCase()).toContain('passphrase');
		expect(PROACTIVE_PASSPHRASE_NOTE.toLowerCase()).toContain('lock yourself out');
	});

	it('none of the copy strings are empty (a hollow constant would still "pass" a truthy check elsewhere)', () => {
		for (const s of [
			KEY_MATCH_HEADLINE,
			WRONG_SEED_HEADLINE,
			WRONG_SEED_BODY,
			PASSPHRASE_CAUSE_HEADLINE,
			PASSPHRASE_CAUSE_BODY,
			PASSPHRASE_LOSS_WARNING,
			PASSPHRASE_NOT_RECOMMENDED,
			PROACTIVE_PASSPHRASE_NOTE
		]) {
			expect(s.length).toBeGreaterThan(0);
		}
	});
});
