// Reads Cairn's own JSON log file for the admin log viewer. This is the read
// side of logger.ts's rotating file sink — it never touches the network and is
// admin-gated at the route layer. Tails the active file so a huge log can't
// blow up memory; only the most recent slice is parsed.

import fs from 'node:fs';
import { LOG_FILE } from './logger';

/** Only ever read this much from the tail of the file, regardless of its size. */
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

/** pino numeric levels → names. */
const LEVEL_NAME: Record<number, string> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal'
};

export type LevelFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

/** Severity floor for each filter (entries at or above are kept). */
const LEVEL_MIN: Record<Exclude<LevelFilter, 'all'>, number> = {
	debug: 20,
	info: 30,
	warn: 40,
	error: 50
};

export interface LogEntry {
	/** epoch ms, or null when the line had no parseable timestamp. */
	time: number | null;
	level: number;
	levelName: string;
	tag?: string;
	msg: string;
	/** Remaining structured fields (err, method, path, …), if any. */
	fields?: Record<string, unknown>;
	/** The original JSON line, for search and copy. */
	raw: string;
}

export interface LogReadResult {
	entries: LogEntry[];
	/** Absolute path being read (shown to the operator). */
	file: string;
	/** False when no log file exists yet (fresh install / file logging off). */
	available: boolean;
}

/** Read the tail of a file as UTF-8, dropping a partial leading line. */
function readTail(file: string, maxBytes: number): string {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return '';
		const buf = Buffer.alloc(length);
		fs.readSync(fd, buf, 0, length, start);
		let text = buf.toString('utf8');
		if (start > 0) {
			// We started mid-file; the first line is probably a fragment.
			const nl = text.indexOf('\n');
			if (nl >= 0) text = text.slice(nl + 1);
		}
		return text;
	} finally {
		fs.closeSync(fd);
	}
}

function parseLine(line: string): LogEntry {
	try {
		const o = JSON.parse(line) as Record<string, unknown>;
		const level = typeof o.level === 'number' ? o.level : 30;
		// Strip the keys we surface explicitly (and the pid/hostname noise, though
		// this logger already omits those) so `fields` holds only the extras.
		const { level: _l, time: _t, msg: _m, tag: _tag, pid: _p, hostname: _h, ...rest } = o;
		return {
			time: typeof o.time === 'number' ? o.time : null,
			level,
			levelName: LEVEL_NAME[level] ?? String(level),
			tag: typeof o.tag === 'string' ? o.tag : undefined,
			msg: typeof o.msg === 'string' ? o.msg : '',
			fields: Object.keys(rest).length > 0 ? rest : undefined,
			raw: line
		};
	} catch {
		// Not JSON (shouldn't happen for the file sink) — surface it verbatim.
		return { time: null, level: 30, levelName: 'raw', msg: line, raw: line };
	}
}

/**
 * The most recent log entries, newest first, after applying an optional
 * severity floor and case-insensitive substring search. `limit` defaults to
 * 1000 and is clamped to 5000.
 */
export function readLogEntries(
	opts: { limit?: number; level?: LevelFilter; q?: string } = {}
): LogReadResult {
	const limit = Math.min(Math.max(1, Math.floor(opts.limit || 0) || 1000), 5000);
	const level = opts.level ?? 'all';
	const minLevel = level === 'all' ? 0 : LEVEL_MIN[level];
	const q = (opts.q ?? '').trim().toLowerCase();

	let text = '';
	let available = false;
	try {
		if (fs.existsSync(LOG_FILE)) {
			text = readTail(LOG_FILE, MAX_TAIL_BYTES);
			available = true;
		}
	} catch {
		available = false;
	}

	const lines = text.split('\n');
	const entries: LogEntry[] = [];
	for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
		const line = lines[i];
		if (line.trim().length === 0) continue;
		if (q && !line.toLowerCase().includes(q)) continue;
		const entry = parseLine(line);
		if (entry.level < minLevel) continue;
		entries.push(entry);
	}
	return { entries, file: LOG_FILE, available };
}
