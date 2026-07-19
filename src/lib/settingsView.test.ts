import { describe, it, expect } from 'vitest';
import { showContactsRow } from './settingsView';

describe('showContactsRow (Settings → Advanced, spec §2.6c)', () => {
	it('renders the Contacts row when team mode is on', () => {
		expect(showContactsRow('team')).toBe(true);
	});

	it('hides the Contacts row entirely in solo mode', () => {
		expect(showContactsRow('solo')).toBe(false);
	});

	it('hides the Contacts row when the mode is missing', () => {
		expect(showContactsRow(null)).toBe(false);
		expect(showContactsRow(undefined)).toBe(false);
	});
});
