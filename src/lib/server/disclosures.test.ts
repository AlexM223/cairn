// cairn-5u2i.1 — the user agreement must disclose server-side data handling
// (IP logging, activity feed, admin log/backup access, retention), and revising
// the DEFAULT text must re-prompt users who accepted the old default: the
// stored version bumps once at startup for instances still on stock text,
// while a customized agreement is left entirely to its operator's own edits.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { getSetting, setSetting } from './settings';
import {
	DEFAULT_USER_AGREEMENT,
	DEFAULT_AGREEMENT_VERSION,
	getUserAgreement,
	setUserAgreement,
	ensureDefaultAgreementVersion,
	recordUserAgreement,
	hasAcceptedCurrentAgreement
} from './disclosures';

function wipe(): void {
	db.exec(
		'DELETE FROM user_agreement_acceptances; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string): number {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	}).id;
}

describe('default agreement content (cairn-5u2i.1)', () => {
	it('discloses data handling: logging, admin visibility, backups, retention', () => {
		expect(DEFAULT_USER_AGREEMENT).toContain('WHAT THIS SERVER LOGS');
		expect(DEFAULT_USER_AGREEMENT).toMatch(/IP address/);
		expect(DEFAULT_USER_AGREEMENT).toMatch(/activity feed/i);
		expect(DEFAULT_USER_AGREEMENT).toMatch(/full-instance backup/i);
		expect(DEFAULT_USER_AGREEMENT).toMatch(/ever includes private keys/i);
		expect(DEFAULT_USER_AGREEMENT).toMatch(/purged after 30 days/i);
	});
});

describe('ensureDefaultAgreementVersion', () => {
	it('bumps a stock instance to the current default version — and re-prompts prior acceptors', () => {
		// A user accepted back when the stored version was the implicit 1.
		const uid = makeUser('user@example.com');
		expect(getUserAgreement().version).toBe(1);
		recordUserAgreement(uid, '198.51.100.7');
		expect(hasAcceptedCurrentAgreement(uid)).toBe(true);

		ensureDefaultAgreementVersion();

		expect(getUserAgreement().version).toBe(DEFAULT_AGREEMENT_VERSION);
		expect(hasAcceptedCurrentAgreement(uid)).toBe(false); // re-prompted

		// Accepting the revised agreement settles it again.
		recordUserAgreement(uid, '198.51.100.7');
		expect(hasAcceptedCurrentAgreement(uid)).toBe(true);
	});

	it('is idempotent', () => {
		ensureDefaultAgreementVersion();
		const v = getSetting('user_agreement_version');
		ensureDefaultAgreementVersion();
		expect(getSetting('user_agreement_version')).toBe(v);
	});

	it('leaves a CUSTOMIZED agreement alone — the operator owns its versioning', () => {
		const saved = setUserAgreement({ text: 'My own terms.', operator: 'Alex' });
		ensureDefaultAgreementVersion();
		expect(getUserAgreement().version).toBe(saved.version);
		expect(getUserAgreement().text).toBe('My own terms.');
	});
});

describe('setUserAgreement versioning (existing mechanism)', () => {
	it('bumps on a real change, not on a no-op save', () => {
		ensureDefaultAgreementVersion();
		const before = getUserAgreement();
		const noop = setUserAgreement({ text: before.text, operator: before.operator });
		expect(noop.version).toBe(before.version);
		const changed = setUserAgreement({ text: 'New terms.', operator: before.operator });
		expect(changed.version).toBe(before.version + 1);
	});
});
