// Admin → Feature flags (docs/FEATURE-FLAGS-PLAN.md §3.1). Instance-wide toggle
// grid, grouped by category, one form action per flag. The DB stores only
// deviations from the registry default, so an untouched flag shows its default
// (always on) and writing a row is what pins it.
//
// The route lives under /admin, so the admin layout's isAdmin gate protects the
// page; the toggle action re-checks requireAdmin for defense in depth.

import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/api';
import { recordActivity } from '$lib/server/activity';
import { FEATURE_FLAGS, FEATURE_FLAGS_BY_KEY } from '$lib/server/featureFlags/registry';
import {
	getGlobalFlags,
	overrideCountsByFlag,
	setGlobalFlag
} from '$lib/server/featureFlags/admin';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const globals = getGlobalFlags();
	const overrideCounts = overrideCountsByFlag();

	// Every registered flag, with its resolved global value (row if set, else the
	// registry default) and how many users have pinned it away from that value.
	const flags = FEATURE_FLAGS.map((def) => ({
		key: def.key,
		label: def.label,
		description: def.description,
		category: def.category,
		enabled: globals.get(def.key) ?? def.defaultEnabled,
		overrideCount: overrideCounts.get(def.key) ?? 0
	}));

	return { flags };
};

export const actions: Actions = {
	toggle: async (event) => {
		const admin = requireAdmin(event);
		const form = await event.request.formData();
		const key = String(form.get('key') ?? '');
		const enabled = form.get('enabled') === 'true';
		const def = FEATURE_FLAGS_BY_KEY.get(key);
		if (!def) return fail(400, { error: 'Unknown feature flag.' });

		// Capture the prior global value BEFORE writing, for the audit trail.
		// undefined = no row yet → the flag was inheriting its registry default (on).
		const prevRow = getGlobalFlags().get(key);
		const from = prevRow === undefined ? 'default(on)' : prevRow ? 'on' : 'off';
		const to = enabled ? 'on' : 'off';

		try {
			setGlobalFlag(key, enabled, admin.id);
		} catch {
			return fail(400, { error: 'Unknown feature flag.' });
		}

		// Audit trail in the events table (surfaced in /admin/activity). Disabling a
		// feature is the consequential direction, so it lands at warn.
		recordActivity({
			type: 'admin_feature_flag',
			userId: null,
			level: enabled ? 'info' : 'warn',
			message: `${admin.email} ${enabled ? 'enabled' : 'disabled'} "${def.label}" instance-wide`,
			detail: { adminId: admin.id, flag: key, scope: 'global', from, to }
		});
		return { ok: true };
	}
};
