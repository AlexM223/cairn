import { fail } from '@sveltejs/kit';
import {
	createMultisigServiceReferral,
	deleteMultisigServiceReferral,
	getDeviceBuyUrlOverrides,
	listMultisigServiceReferrals,
	ReferralValidationError,
	setDeviceBuyUrlOverride,
	updateMultisigServiceReferral
} from '$lib/server/referrals';
import { REFERRAL_DEVICE_IDS, type ReferralDeviceId } from '$lib/referrals';
import type { Actions, PageServerLoad } from './$types';

// The admin layout already 403s non-admins, but form actions don't run layout
// loads first — so every mutating action re-checks explicitly (same posture as
// the settings page's sensitive actions).
function requireAdmin(locals: App.Locals): void {
	if (!locals.user?.isAdmin) throw new AdminError();
}
class AdminError extends Error {}

export const load: PageServerLoad = async () => {
	return {
		// Raw override values (blank = official default applies) for the form.
		buyUrlOverrides: getDeviceBuyUrlOverrides(),
		// ALL services, inactive included — this is the management surface.
		services: listMultisigServiceReferrals()
	};
};

function readServiceForm(form: FormData) {
	const displayOrderRaw = String(form.get('displayOrder') ?? '').trim();
	const displayOrder = displayOrderRaw === '' ? 0 : Number(displayOrderRaw);
	return {
		name: String(form.get('name') ?? ''),
		url: String(form.get('url') ?? ''),
		description: String(form.get('description') ?? ''),
		logoUrl: String(form.get('logoUrl') ?? ''),
		active: form.get('active') === 'on',
		// A non-numeric display order fails validation inside normalizeInput.
		displayOrder: Number.isInteger(displayOrder) ? displayOrder : NaN
	};
}

export const actions: Actions = {
	/** Section 1: the five per-device buy-URL overrides, saved together. */
	saveDeviceUrls: async ({ request, locals }) => {
		try {
			requireAdmin(locals);
			const form = await request.formData();
			// Validate ALL fields before persisting ANY, so one bad URL doesn't
			// leave the form half-saved.
			const values = new Map<ReferralDeviceId, string>();
			for (const device of REFERRAL_DEVICE_IDS) {
				values.set(device, String(form.get(`url_${device}`) ?? ''));
			}
			for (const [, url] of values) {
				const trimmed = url.trim();
				if (trimmed && !/^https?:\/\//i.test(trimmed)) {
					return fail(400, {
						deviceUrlError:
							'Buy links must start with http:// or https:// — leave a field blank to use the official store.'
					});
				}
			}
			for (const [device, url] of values) setDeviceBuyUrlOverride(device, url);
			return { deviceUrlsSaved: true };
		} catch (e) {
			if (e instanceof AdminError) return fail(403, { deviceUrlError: 'Admin access required.' });
			if (e instanceof ReferralValidationError) return fail(400, { deviceUrlError: e.message });
			throw e;
		}
	},

	/** Section 2: add a managed multisig service. */
	createService: async ({ request, locals }) => {
		try {
			requireAdmin(locals);
			const form = await request.formData();
			createMultisigServiceReferral(readServiceForm(form));
			return { serviceSaved: true };
		} catch (e) {
			if (e instanceof AdminError) return fail(403, { serviceError: 'Admin access required.' });
			if (e instanceof ReferralValidationError) return fail(400, { serviceError: e.message });
			throw e;
		}
	},

	/** Section 2: update one service row (all fields travel together). */
	updateService: async ({ request, locals }) => {
		try {
			requireAdmin(locals);
			const form = await request.formData();
			const id = Number(form.get('id'));
			if (!Number.isInteger(id)) return fail(400, { serviceError: 'Invalid service id.' });
			updateMultisigServiceReferral(id, readServiceForm(form));
			return { serviceSaved: true };
		} catch (e) {
			if (e instanceof AdminError) return fail(403, { serviceError: 'Admin access required.' });
			if (e instanceof ReferralValidationError) return fail(400, { serviceError: e.message });
			throw e;
		}
	},

	deleteService: async ({ request, locals }) => {
		try {
			requireAdmin(locals);
			const form = await request.formData();
			const id = Number(form.get('id'));
			if (!Number.isInteger(id)) return fail(400, { serviceError: 'Invalid service id.' });
			deleteMultisigServiceReferral(id);
			return { serviceDeleted: true };
		} catch (e) {
			if (e instanceof AdminError) return fail(403, { serviceError: 'Admin access required.' });
			throw e;
		}
	}
};
