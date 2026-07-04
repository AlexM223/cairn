import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	listSavedAddresses,
	saveAddress,
	deleteSavedAddress,
	AddressBookError,
	ADDRESS_LABEL_MAX
} from './addressBook';

// Known-valid mainnet addresses (same fixtures the xpub validation tests use).
const ADDR_A = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ADDR_B = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function wipe(): void {
	db.exec(
		'DELETE FROM saved_addresses; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

describe('address book', () => {
	it('listSavedAddresses returns an empty list for a fresh user', () => {
		const user = makeUser('owner@example.com');
		expect(listSavedAddresses(user.id)).toEqual([]);
	});

	it('saveAddress creates an entry with a trimmed label and lists it back', () => {
		const user = makeUser('owner@example.com');
		const { entry, created } = saveAddress(user.id, { address: ` ${ADDR_A} `, label: '  Cold storage  ' });

		expect(created).toBe(true);
		expect(entry.label).toBe('Cold storage');
		expect(entry.address).toBe(ADDR_A);
		expect(entry.lastUsedAt).toBeNull();
		expect(listSavedAddresses(user.id)).toEqual([entry]);
	});

	it('saveAddress rejects invalid or empty addresses', () => {
		const user = makeUser('owner@example.com');
		for (const address of ['', '   ', 'not an address', ADDR_A.slice(0, -1) + 'b']) {
			try {
				saveAddress(user.id, { address, label: 'nope' });
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(AddressBookError);
				expect((e as AddressBookError).code).toBe('invalid_address');
			}
		}
		expect(listSavedAddresses(user.id)).toEqual([]);
	});

	it(`saveAddress requires a 1–${ADDRESS_LABEL_MAX} character label for a new address`, () => {
		const user = makeUser('owner@example.com');
		for (const label of [undefined, '', '   ', 'x'.repeat(ADDRESS_LABEL_MAX + 1)]) {
			try {
				saveAddress(user.id, { address: ADDR_A, label });
				expect.unreachable('should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(AddressBookError);
				expect((e as AddressBookError).code).toBe('invalid_label');
			}
		}
		// Exactly at the cap is fine.
		const { entry } = saveAddress(user.id, { address: ADDR_A, label: 'x'.repeat(ADDRESS_LABEL_MAX) });
		expect(entry.label).toHaveLength(ADDRESS_LABEL_MAX);
	});

	it('re-saving an existing address touches it instead of duplicating', () => {
		const user = makeUser('owner@example.com');
		const first = saveAddress(user.id, { address: ADDR_A, label: 'Cold storage' });

		// Pure touch (no label): bumps last_used_at, keeps the label.
		const touched = saveAddress(user.id, { address: ADDR_A });
		expect(touched.created).toBe(false);
		expect(touched.entry.id).toBe(first.entry.id);
		expect(touched.entry.label).toBe('Cold storage');
		expect(touched.entry.lastUsedAt).not.toBeNull();

		// With a label: renames the entry.
		const renamed = saveAddress(user.id, { address: ADDR_A, label: 'Vault' });
		expect(renamed.created).toBe(false);
		expect(renamed.entry.label).toBe('Vault');

		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?')
			.get(user.id) as { n: number };
		expect(n).toBe(1);
	});

	it('the (user_id, address) uniqueness constraint holds at the database level', () => {
		const user = makeUser('owner@example.com');
		saveAddress(user.id, { address: ADDR_A, label: 'Cold storage' });
		expect(() =>
			db
				.prepare('INSERT INTO saved_addresses (user_id, label, address) VALUES (?, ?, ?)')
				.run(user.id, 'dupe', ADDR_A)
		).toThrow(/UNIQUE/i);
	});

	it('entries are isolated per user: two users may save the same address', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');

		const a = saveAddress(alice.id, { address: ADDR_A, label: 'Exchange' });
		const b = saveAddress(bob.id, { address: ADDR_A, label: 'My exchange' });
		expect(a.created).toBe(true);
		expect(b.created).toBe(true);

		expect(listSavedAddresses(alice.id)).toEqual([a.entry]);
		expect(listSavedAddresses(bob.id)).toEqual([b.entry]);

		// Bob cannot delete Alice's entry.
		expect(deleteSavedAddress(bob.id, a.entry.id)).toBe(false);
		expect(listSavedAddresses(alice.id)).toEqual([a.entry]);
	});

	it('deleteSavedAddress removes an owned entry and is false otherwise', () => {
		const user = makeUser('owner@example.com');
		const { entry } = saveAddress(user.id, { address: ADDR_A, label: 'Cold storage' });

		expect(deleteSavedAddress(user.id, entry.id)).toBe(true);
		expect(listSavedAddresses(user.id)).toEqual([]);
		expect(deleteSavedAddress(user.id, entry.id)).toBe(false);
		expect(deleteSavedAddress(user.id, 9999)).toBe(false);
	});

	it('lists recently used entries first, then never-used ones by label', () => {
		const user = makeUser('owner@example.com');
		saveAddress(user.id, { address: ADDR_A, label: 'Zebra fund' });
		saveAddress(user.id, { address: ADDR_B, label: 'Alpha fund' });

		// Never used: alphabetical by label.
		expect(listSavedAddresses(user.id).map((e) => e.label)).toEqual(['Alpha fund', 'Zebra fund']);

		// Touch Zebra — it jumps ahead of the never-used entry.
		saveAddress(user.id, { address: ADDR_A });
		expect(listSavedAddresses(user.id).map((e) => e.label)).toEqual(['Zebra fund', 'Alpha fund']);
	});
});
