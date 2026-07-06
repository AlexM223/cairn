// Referral links system (cairn-ph3g): buy-URL precedence, the flag-gating
// seam the wizard/send loads consume, multisig-service CRUD + active
// filtering, and admin-action validation (bad input → failure, nothing
// persisted).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import {
	createMultisigServiceReferral,
	deleteMultisigServiceReferral,
	getAllDeviceBuyUrls,
	getDeviceBuyUrl,
	getDeviceBuyUrlOverrides,
	getReferralBuyUrls,
	listActiveMultisigServiceReferrals,
	listMultisigServiceReferrals,
	ReferralValidationError,
	setDeviceBuyUrlOverride,
	updateMultisigServiceReferral
} from './referrals';
import { OFFICIAL_STORE_URLS, REFERRAL_DEVICE_IDS } from '$lib/referrals';
import { actions } from '../../routes/(app)/admin/referral-settings/+page.server';

function wipe(): void {
	db.exec('DELETE FROM multisig_service_referrals; DELETE FROM settings;');
}

beforeEach(wipe);

// ---------------------------------------------------------------- buy URLs

describe('getDeviceBuyUrl precedence', () => {
	it('falls back to the official store when no override is set', () => {
		for (const device of REFERRAL_DEVICE_IDS) {
			expect(getDeviceBuyUrl(device)).toBe(OFFICIAL_STORE_URLS[device]);
		}
	});

	it('uses the admin override when one is set', () => {
		setSetting('referral_device_trezor_url', 'https://shop.example/trezor?ref=cairn');
		expect(getDeviceBuyUrl('trezor')).toBe('https://shop.example/trezor?ref=cairn');
		// Other devices are unaffected.
		expect(getDeviceBuyUrl('ledger')).toBe(OFFICIAL_STORE_URLS.ledger);
	});

	it('treats a blank or whitespace-only override as "use the official store"', () => {
		setSetting('referral_device_ledger_url', '');
		setSetting('referral_device_jade_url', '   ');
		expect(getDeviceBuyUrl('ledger')).toBe(OFFICIAL_STORE_URLS.ledger);
		expect(getDeviceBuyUrl('jade')).toBe(OFFICIAL_STORE_URLS.jade);
	});

	it('getAllDeviceBuyUrls resolves every device, overrides included', () => {
		setSetting('referral_device_coldcard_url', 'https://shop.example/coldcard');
		const urls = getAllDeviceBuyUrls();
		expect(urls.coldcard).toBe('https://shop.example/coldcard');
		expect(urls.bitbox02).toBe(OFFICIAL_STORE_URLS.bitbox02);
		expect(Object.keys(urls).sort()).toEqual([...REFERRAL_DEVICE_IDS].sort());
	});

	it('setDeviceBuyUrlOverride rejects a non-http(s) url and clears on blank', () => {
		expect(() => setDeviceBuyUrlOverride('trezor', 'ftp://nope.example')).toThrow(
			ReferralValidationError
		);
		expect(getSetting('referral_device_trezor_url')).toBeNull(); // nothing persisted

		setDeviceBuyUrlOverride('trezor', 'https://shop.example/t');
		expect(getDeviceBuyUrl('trezor')).toBe('https://shop.example/t');
		setDeviceBuyUrlOverride('trezor', '   ');
		expect(getDeviceBuyUrl('trezor')).toBe(OFFICIAL_STORE_URLS.trezor);
		expect(getDeviceBuyUrlOverrides().trezor).toBe('');
	});
});

// ------------------------------------------------- flag-gating (load seam)

describe('getReferralBuyUrls — the seam wizard/send loads consume', () => {
	it('returns null when the referral_links flag is explicitly off', () => {
		expect(getReferralBuyUrls({ referral_links: false })).toBeNull();
	});

	it('returns resolved URLs when the flag is on or unresolved', () => {
		setSetting('referral_device_trezor_url', 'https://shop.example/t');
		expect(getReferralBuyUrls({ referral_links: true })?.trezor).toBe('https://shop.example/t');
		// Absent key / absent flags object follows the UI convention: only an
		// explicit false disables.
		expect(getReferralBuyUrls({})?.ledger).toBe(OFFICIAL_STORE_URLS.ledger);
		expect(getReferralBuyUrls(undefined)).not.toBeNull();
	});
});

// ------------------------------------------------ multisig service CRUD

describe('multisig service referral CRUD', () => {
	it('creates and lists a service with defaults (active, order 0)', () => {
		const created = createMultisigServiceReferral({
			name: 'Casa',
			url: 'https://casa.example'
		});
		expect(created).toMatchObject({
			name: 'Casa',
			url: 'https://casa.example',
			description: null,
			logoUrl: null,
			active: true,
			displayOrder: 0
		});
		expect(listMultisigServiceReferrals()).toHaveLength(1);
	});

	it('listActive excludes inactive rows; the admin list keeps them', () => {
		createMultisigServiceReferral({ name: 'Casa', url: 'https://casa.example' });
		createMultisigServiceReferral({
			name: 'Paused Co',
			url: 'https://paused.example',
			active: false
		});

		expect(listMultisigServiceReferrals()).toHaveLength(2);
		const active = listActiveMultisigServiceReferrals();
		expect(active).toHaveLength(1);
		expect(active[0].name).toBe('Casa');
	});

	it('sorts by display_order (then id) in both lists', () => {
		createMultisigServiceReferral({ name: 'Last', url: 'https://c.example', displayOrder: 9 });
		createMultisigServiceReferral({ name: 'First', url: 'https://a.example', displayOrder: 1 });
		createMultisigServiceReferral({ name: 'Middle', url: 'https://b.example', displayOrder: 5 });

		expect(listActiveMultisigServiceReferrals().map((s) => s.name)).toEqual([
			'First',
			'Middle',
			'Last'
		]);
		expect(listMultisigServiceReferrals().map((s) => s.name)).toEqual([
			'First',
			'Middle',
			'Last'
		]);
	});

	it('update rewrites fields and toggles active', () => {
		const created = createMultisigServiceReferral({ name: 'Casa', url: 'https://casa.example' });
		const updated = updateMultisigServiceReferral(created.id, {
			name: 'Casa (US)',
			url: 'https://casa.example/us',
			description: 'Managed multisig with support.',
			logoUrl: 'https://casa.example/logo.png',
			active: false,
			displayOrder: 3
		});
		expect(updated).toMatchObject({
			id: created.id,
			name: 'Casa (US)',
			description: 'Managed multisig with support.',
			logoUrl: 'https://casa.example/logo.png',
			active: false,
			displayOrder: 3
		});
		expect(listActiveMultisigServiceReferrals()).toHaveLength(0);
	});

	it('delete removes the row; updating a missing id fails', () => {
		const created = createMultisigServiceReferral({ name: 'Casa', url: 'https://casa.example' });
		deleteMultisigServiceReferral(created.id);
		expect(listMultisigServiceReferrals()).toHaveLength(0);
		expect(() => updateMultisigServiceReferral(created.id, { name: 'X', url: 'https://x.example' })).toThrow(
			ReferralValidationError
		);
	});

	it('validation: name and http(s) url are required; nothing persists on failure', () => {
		expect(() => createMultisigServiceReferral({ name: '', url: 'https://x.example' })).toThrow(
			ReferralValidationError
		);
		expect(() => createMultisigServiceReferral({ name: 'X', url: '' })).toThrow(
			ReferralValidationError
		);
		expect(() =>
			createMultisigServiceReferral({ name: 'X', url: 'javascript:alert(1)' })
		).toThrow(ReferralValidationError);
		expect(() =>
			createMultisigServiceReferral({
				name: 'X',
				url: 'https://x.example',
				logoUrl: 'not-a-url'
			})
		).toThrow(ReferralValidationError);
		expect(listMultisigServiceReferrals()).toHaveLength(0);
	});
});

// ------------------------------------------------- admin action validation

type ActionEvent = Parameters<(typeof actions)['createService']>[0];

function actionEvent(fields: Record<string, string>, isAdmin = true): ActionEvent {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	return {
		locals: { user: { id: 1, email: 'admin@example.com', isAdmin } },
		request: new Request('http://localhost/admin/referral-settings', {
			method: 'POST',
			body: form
		})
	} as unknown as ActionEvent;
}

describe('admin referral-settings actions', () => {
	it('createService rejects a bad url with 400 and persists nothing', async () => {
		const result = await actions.createService(
			actionEvent({ name: 'Casa', url: 'notaurl', active: 'on' })
		);
		expect(result).toMatchObject({ status: 400 });
		expect(listMultisigServiceReferrals()).toHaveLength(0);
	});

	it('createService rejects a missing name with 400 and persists nothing', async () => {
		const result = await actions.createService(
			actionEvent({ name: '   ', url: 'https://casa.example' })
		);
		expect(result).toMatchObject({ status: 400 });
		expect(listMultisigServiceReferrals()).toHaveLength(0);
	});

	it('createService persists a valid service (active + order)', async () => {
		const result = await actions.createService(
			actionEvent({
				name: 'Casa',
				url: 'https://casa.example',
				description: 'Managed multisig.',
				displayOrder: '2',
				active: 'on'
			})
		);
		expect(result).toMatchObject({ serviceSaved: true });
		const rows = listMultisigServiceReferrals();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'Casa', active: true, displayOrder: 2 });
	});

	it('saveDeviceUrls rejects one bad url and persists NONE of the fields', async () => {
		const result = await actions.saveDeviceUrls(
			actionEvent({
				url_trezor: 'https://good.example/trezor',
				url_ledger: 'ftp://bad.example'
			})
		);
		expect(result).toMatchObject({ status: 400 });
		// The valid field must not have landed either — all-or-nothing.
		expect(getSetting('referral_device_trezor_url')).toBeNull();
		expect(getDeviceBuyUrl('trezor')).toBe(OFFICIAL_STORE_URLS.trezor);
	});

	it('saveDeviceUrls saves overrides and blanks clear back to official', async () => {
		const ok = await actions.saveDeviceUrls(
			actionEvent({ url_trezor: 'https://shop.example/t', url_ledger: '' })
		);
		expect(ok).toMatchObject({ deviceUrlsSaved: true });
		expect(getDeviceBuyUrl('trezor')).toBe('https://shop.example/t');
		expect(getDeviceBuyUrl('ledger')).toBe(OFFICIAL_STORE_URLS.ledger);

		const cleared = await actions.saveDeviceUrls(actionEvent({ url_trezor: '   ' }));
		expect(cleared).toMatchObject({ deviceUrlsSaved: true });
		expect(getDeviceBuyUrl('trezor')).toBe(OFFICIAL_STORE_URLS.trezor);
	});

	it('non-admin callers get 403 from every mutating action', async () => {
		const create = await actions.createService(
			actionEvent({ name: 'Casa', url: 'https://casa.example' }, false)
		);
		expect(create).toMatchObject({ status: 403 });

		const save = await actions.saveDeviceUrls(
			actionEvent({ url_trezor: 'https://shop.example/t' }, false)
		);
		expect(save).toMatchObject({ status: 403 });
		expect(getSetting('referral_device_trezor_url')).toBeNull();
		expect(listMultisigServiceReferrals()).toHaveLength(0);
	});
});
