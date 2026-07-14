// Admin → Users → one user (docs/FEATURE-FLAGS-PLAN.md §3.2). Per-user feature
// overrides: a tri-state Inherit / Force on / Force off control per flag. The
// list page (../+page.svelte) has no room for a 20+ row grid, hence this detail
// route.
//
// Under /admin, so the admin layout's isAdmin gate protects the page; the
// mutating actions re-check requireAdmin for defense in depth. Also gated on
// assertTeamMode() (cairn-7xlf): this is part of the same Users/Invites
// multi-user MANAGEMENT surface as the list page (../+page.server.ts), which
// already 404s in solo mode — the detail route must match or the admin
// layout's own doc comment ("the routes themselves 404 via assertTeamMode()
// regardless of this list") is false.

import { error, fail } from '@sveltejs/kit';
import { assertTeamMode, requireAdmin } from '$lib/server/api';
import { recordActivity } from '$lib/server/activity';
import { getUser } from '$lib/server/admin';
import { FEATURE_FLAGS, FEATURE_FLAGS_BY_KEY } from '$lib/server/featureFlags/registry';
import { resolveAllFlags } from '$lib/server/featureFlags/resolve';
import {
	getGlobalFlags,
	getUserOverrides,
	setUserOverride,
	clearUserOverride
} from '$lib/server/featureFlags/admin';
import type { Actions, PageServerLoad } from './$types';

function parseUserId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'User not found');
	return id;
}

export const load: PageServerLoad = async ({ params }) => {
	assertTeamMode();
	const userId = parseUserId(params.id);
	const user = getUser(userId);
	if (!user) error(404, 'User not found');

	const globals = getGlobalFlags();
	const overrides = getUserOverrides(userId);
	const resolved = resolveAllFlags(userId);

	// Per flag: the effective global value (what "Inherit" resolves to), whether
	// this user has an explicit override and to what, and the final resolved
	// boolean. The UI shows the override state as the source of truth for the
	// control and the resolved value as the outcome.
	const flags = FEATURE_FLAGS.map((def) => {
		const hasOverride = overrides.has(def.key);
		return {
			key: def.key,
			label: def.label,
			description: def.description,
			category: def.category,
			globalEnabled: globals.get(def.key) ?? def.defaultEnabled,
			override: hasOverride ? (overrides.get(def.key) as boolean) : null, // null = inherit
			resolved: resolved[def.key]
		};
	});

	return { subject: user, flags };
};

export const actions: Actions = {
	// Force a flag on/off (state = 'on' | 'off') or clear back to inherit
	// (state = 'inherit') for this user.
	setOverride: async (event) => {
		const admin = requireAdmin(event);
		assertTeamMode();
		const userId = parseUserId(event.params.id!);
		const target = getUser(userId);
		if (!target) return fail(404, { error: 'User not found.' });

		const form = await event.request.formData();
		const key = String(form.get('key') ?? '');
		const state = String(form.get('state') ?? '');
		if (state !== 'inherit' && state !== 'on' && state !== 'off') {
			return fail(400, { error: 'Invalid override state.' });
		}
		const def = FEATURE_FLAGS_BY_KEY.get(key);
		if (!def) return fail(400, { error: 'Unknown feature flag.' });

		// Capture the prior override BEFORE writing, for the audit trail.
		// undefined = no row → the user was inheriting the global/registry value.
		const prev = getUserOverrides(userId).get(key);
		const from = prev === undefined ? 'inherit' : prev ? 'on' : 'off';

		try {
			if (state === 'inherit') clearUserOverride(userId, key);
			else if (state === 'on') setUserOverride(userId, key, true, admin.id);
			else setUserOverride(userId, key, false, admin.id);
		} catch {
			return fail(400, { error: 'Unknown feature flag.' });
		}

		// Audit trail in the events table (surfaced in /admin/activity). Forcing a
		// feature off for a user is the consequential direction, so it lands at warn.
		recordActivity({
			type: 'admin_feature_flag_override',
			userId: null,
			level: state === 'off' ? 'warn' : 'info',
			message: `${admin.email} set "${def.label}" to ${state} for ${target.email}`,
			detail: { adminId: admin.id, flag: key, targetUserId: userId, from, to: state }
		});
		return { ok: true };
	}
};
