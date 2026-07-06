import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import {
	getAddressLabels,
	setAddressLabel,
	deleteAddressLabels,
	ADDRESS_LABEL_MAX
} from './addressLabels';

function wipe(): void {
	db.exec('DELETE FROM address_labels;');
}
beforeEach(wipe);

const ADDR_A = 'bc1qaddressa';
const ADDR_B = 'bc1qaddressb';

describe('addressLabels', () => {
	it('sets and reads a label back', () => {
		setAddressLabel('wallet', 1, ADDR_A, 'exchange deposit');
		expect(getAddressLabels('wallet', 1)).toEqual({ [ADDR_A]: 'exchange deposit' });
	});

	it('upserts on the same address rather than duplicating', () => {
		setAddressLabel('wallet', 1, ADDR_A, 'first');
		const r = setAddressLabel('wallet', 1, ADDR_A, 'second');
		expect(r).toEqual({ address: ADDR_A, label: 'second' });
		expect(getAddressLabels('wallet', 1)).toEqual({ [ADDR_A]: 'second' });
	});

	it('clears a label when set to empty/whitespace', () => {
		setAddressLabel('wallet', 1, ADDR_A, 'temp');
		const r = setAddressLabel('wallet', 1, ADDR_A, '   ');
		expect(r).toEqual({ address: ADDR_A, label: '' });
		expect(getAddressLabels('wallet', 1)).toEqual({});
	});

	it('trims and caps at ADDRESS_LABEL_MAX', () => {
		const long = 'x'.repeat(ADDRESS_LABEL_MAX + 50);
		const r = setAddressLabel('wallet', 1, ADDR_A, `  ${long}  `);
		expect(r.label.length).toBe(ADDRESS_LABEL_MAX);
	});

	it('keeps wallet and multisig kinds separate for the same id', () => {
		setAddressLabel('wallet', 1, ADDR_A, 'w-label');
		setAddressLabel('multisig', 1, ADDR_A, 'm-label');
		expect(getAddressLabels('wallet', 1)).toEqual({ [ADDR_A]: 'w-label' });
		expect(getAddressLabels('multisig', 1)).toEqual({ [ADDR_A]: 'm-label' });
	});

	it('deleteAddressLabels drops only the given wallet/kind', () => {
		setAddressLabel('wallet', 1, ADDR_A, 'a');
		setAddressLabel('wallet', 1, ADDR_B, 'b');
		setAddressLabel('wallet', 2, ADDR_A, 'other');
		setAddressLabel('multisig', 1, ADDR_A, 'ms');
		deleteAddressLabels('wallet', 1);
		expect(getAddressLabels('wallet', 1)).toEqual({});
		expect(getAddressLabels('wallet', 2)).toEqual({ [ADDR_A]: 'other' });
		expect(getAddressLabels('multisig', 1)).toEqual({ [ADDR_A]: 'ms' });
	});
});
