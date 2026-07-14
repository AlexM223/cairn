// Server side of the referral links system (cairn-sow7, cairn-jjnb):
//
//  - Per-device BUY urls: the settings k/v table holds an optional
//    `referral_device_<device>_url` override per hardware device; a blank or
//    missing override falls back to the official vendor store. Gated by the
//    `referral_links` feature flag at the load seam (getReferralBuyUrls).
//  - Managed multisig service referrals: admin-managed rows in the
//    multisig_service_referrals table, surfaced as a small card in the
//    multisig wizard. Only ACTIVE rows reach user surfaces.
//
// Official troubleshooting links deliberately do NOT live here — they are
// hardcoded client-safe constants in $lib/referrals.ts and never configurable.

import { db } from './db';
import { getSetting, setSetting } from './settings';
import { containsNulByte } from './textGuard';
import {
	OFFICIAL_STORE_URLS,
	REFERRAL_DEVICE_IDS,
	type ReferralBuyUrls,
	type ReferralDeviceId
} from '$lib/referrals';

// ---------- Per-device buy URLs ----------

/** Settings key holding the admin's referral override for one device. */
export function deviceBuyUrlSettingKey(device: ReferralDeviceId): string {
	return `referral_device_${device}_url`;
}

/**
 * The buy link for one device: the admin's non-blank override when set,
 * otherwise the official vendor store.
 */
export function getDeviceBuyUrl(device: ReferralDeviceId): string {
	const override = getSetting(deviceBuyUrlSettingKey(device))?.trim();
	return override ? override : OFFICIAL_STORE_URLS[device];
}

/** Resolved buy links for every device — what wizard/send loads serialize. */
export function getAllDeviceBuyUrls(): ReferralBuyUrls {
	const urls = {} as ReferralBuyUrls;
	for (const device of REFERRAL_DEVICE_IDS) urls[device] = getDeviceBuyUrl(device);
	return urls;
}

/**
 * The flag-gating seam every user-facing load goes through: resolved buy URLs
 * when the referral_links flag is on for this request's user, null when it's
 * off (so no referral URL ever reaches the client). Matches the UI convention
 * that only an explicit `false` disables a flag.
 */
export function getReferralBuyUrls(
	flags: Record<string, boolean> | undefined
): ReferralBuyUrls | null {
	if (flags?.referral_links === false) return null;
	return getAllDeviceBuyUrls();
}

/**
 * Persist one device's override. Blank (or whitespace) clears the override so
 * the official store URL applies again; anything else must be http(s).
 */
export function setDeviceBuyUrlOverride(device: ReferralDeviceId, url: string): void {
	const trimmed = url.trim();
	if (trimmed && !isHttpUrl(trimmed)) {
		throw new ReferralValidationError(
			`The ${device} link must start with http:// or https:// (leave it blank to use the official store).`
		);
	}
	setSetting(deviceBuyUrlSettingKey(device), trimmed);
}

/** The raw override values (possibly blank) for the admin form. */
export function getDeviceBuyUrlOverrides(): Record<ReferralDeviceId, string> {
	const overrides = {} as Record<ReferralDeviceId, string>;
	for (const device of REFERRAL_DEVICE_IDS) {
		overrides[device] = getSetting(deviceBuyUrlSettingKey(device))?.trim() ?? '';
	}
	return overrides;
}

// ---------- Managed multisig service referrals ----------

export interface MultisigServiceReferral {
	id: number;
	name: string;
	url: string;
	description: string | null;
	logoUrl: string | null;
	active: boolean;
	displayOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface MultisigServiceReferralInput {
	name: string;
	url: string;
	description?: string | null;
	logoUrl?: string | null;
	active?: boolean;
	displayOrder?: number;
}

/** Admin input that fails validation — surfaced verbatim as the form error. */
export class ReferralValidationError extends Error {}

function isHttpUrl(value: string): boolean {
	if (!/^https?:\/\//i.test(value)) return false;
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

interface ReferralRow {
	id: number;
	name: string;
	url: string;
	description: string | null;
	logo_url: string | null;
	active: number;
	display_order: number;
	created_at: string;
	updated_at: string;
}

function toReferral(row: ReferralRow): MultisigServiceReferral {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		description: row.description,
		logoUrl: row.logo_url,
		active: row.active === 1,
		displayOrder: row.display_order,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

/** Normalize + validate one service's fields. Throws ReferralValidationError. */
function normalizeInput(input: MultisigServiceReferralInput): {
	name: string;
	url: string;
	description: string | null;
	logoUrl: string | null;
	active: number;
	displayOrder: number;
} {
	const name = input.name?.trim() ?? '';
	const url = input.url?.trim() ?? '';
	const description = input.description?.trim() || null;
	const logoUrl = input.logoUrl?.trim() || null;
	const displayOrder = input.displayOrder ?? 0;

	if (!name) throw new ReferralValidationError('Give the service a name.');
	if (name.length > 100)
		throw new ReferralValidationError('The service name must be 100 characters or fewer.');
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// name/description at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(name)) {
		throw new ReferralValidationError(
			'The service name contains a NUL character (U+0000), which cannot be stored.'
		);
	}
	if (!url) throw new ReferralValidationError('Enter the service link.');
	if (!isHttpUrl(url))
		throw new ReferralValidationError('The service link must start with http:// or https://.');
	if (logoUrl && !isHttpUrl(logoUrl))
		throw new ReferralValidationError('The logo URL must start with http:// or https://.');
	if (description && description.length > 300)
		throw new ReferralValidationError('Keep the description to 300 characters or fewer.');
	if (description && containsNulByte(description)) {
		throw new ReferralValidationError(
			'The description contains a NUL character (U+0000), which cannot be stored.'
		);
	}
	if (!Number.isInteger(displayOrder))
		throw new ReferralValidationError('Display order must be a whole number.');

	return { name, url, description, logoUrl, active: input.active === false ? 0 : 1, displayOrder };
}

/** Every service row, inactive included — the admin management list. */
export function listMultisigServiceReferrals(): MultisigServiceReferral[] {
	const rows = db
		.prepare(
			'SELECT * FROM multisig_service_referrals ORDER BY display_order ASC, id ASC'
		)
		.all() as unknown as ReferralRow[];
	return rows.map(toReferral);
}

/** Active rows only, in display order — what user surfaces render. */
export function listActiveMultisigServiceReferrals(): MultisigServiceReferral[] {
	const rows = db
		.prepare(
			'SELECT * FROM multisig_service_referrals WHERE active = 1 ORDER BY display_order ASC, id ASC'
		)
		.all() as unknown as ReferralRow[];
	return rows.map(toReferral);
}

export function createMultisigServiceReferral(
	input: MultisigServiceReferralInput
): MultisigServiceReferral {
	const v = normalizeInput(input);
	const info = db
		.prepare(
			`INSERT INTO multisig_service_referrals (name, url, description, logo_url, active, display_order)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(v.name, v.url, v.description, v.logoUrl, v.active, v.displayOrder);
	const row = db
		.prepare('SELECT * FROM multisig_service_referrals WHERE id = ?')
		.get(Number(info.lastInsertRowid)) as unknown as ReferralRow;
	return toReferral(row);
}

export function updateMultisigServiceReferral(
	id: number,
	input: MultisigServiceReferralInput
): MultisigServiceReferral {
	const existing = db
		.prepare('SELECT * FROM multisig_service_referrals WHERE id = ?')
		.get(id) as unknown as ReferralRow | undefined;
	if (!existing) throw new ReferralValidationError('That service no longer exists.');

	const v = normalizeInput(input);
	db.prepare(
		`UPDATE multisig_service_referrals
		 SET name = ?, url = ?, description = ?, logo_url = ?, active = ?, display_order = ?,
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(v.name, v.url, v.description, v.logoUrl, v.active, v.displayOrder, id);

	const row = db
		.prepare('SELECT * FROM multisig_service_referrals WHERE id = ?')
		.get(id) as unknown as ReferralRow;
	return toReferral(row);
}

export function deleteMultisigServiceReferral(id: number): void {
	db.prepare('DELETE FROM multisig_service_referrals WHERE id = ?').run(id);
}
