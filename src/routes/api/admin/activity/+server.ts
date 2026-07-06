// GET /api/admin/activity — the filtered/paginated admin activity log. Admin-only.
// Query params: type, level, userId (number, or 'instance' for instance-wide),
// search, limit, offset. Powers the /admin/activity page's live filtering.

import { json, requireAdmin } from '$lib/server/api';
import { listAllActivity, type AdminActivityFilters } from '$lib/server/activity';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	requireAdmin(event);
	const p = event.url.searchParams;

	const filters: AdminActivityFilters = {};
	if (p.get('type')) filters.type = p.get('type')!;
	if (p.get('level')) filters.level = p.get('level')!;
	const userId = p.get('userId');
	if (userId === 'instance') filters.userId = null;
	else if (userId && Number.isInteger(Number(userId))) filters.userId = Number(userId);
	if (p.get('search')) filters.search = p.get('search')!;
	if (p.get('limit')) filters.limit = Number(p.get('limit'));
	if (p.get('offset')) filters.offset = Number(p.get('offset'));
	// Raw event detail is opt-in (cairn-o1dp.5) — the UI never renders it, so the
	// default response matches what the page shows.
	if (p.get('includeDetail') === 'true') filters.includeDetail = true;

	return json(listAllActivity(filters));
};
