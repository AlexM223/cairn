// GET /api/admin/logs?level=&q=&limit= — recent server log entries for the
// admin log viewer's auto-refresh. Admin-only; reads Cairn's own log file.

import { json, requireAdmin } from '$lib/server/api';
import { readLogEntries, type LevelFilter } from '$lib/server/logStore';
import type { RequestHandler } from './$types';

const LEVELS: LevelFilter[] = ['all', 'debug', 'info', 'warn', 'error'];

export const GET: RequestHandler = (event) => {
	requireAdmin(event);
	const levelParam = event.url.searchParams.get('level') as LevelFilter | null;
	const level = levelParam && LEVELS.includes(levelParam) ? levelParam : 'all';
	const q = event.url.searchParams.get('q') ?? '';
	const limit = Number(event.url.searchParams.get('limit')) || 1000;
	return json(readLogEntries({ level, q, limit }));
};
