// The single server-side logging module for Cairn.
//
// Cairn is self-hosted and privacy-first: logs stay on the operator's machine.
// There is NO third-party telemetry here and there must never be — this module
// only ever writes to stdout (so `docker logs` / journald pick it up) and,
// optionally, to a local rotating file that the in-app admin log viewer reads.
//
// Output shape:
//   • dev  → pretty, colourised, human lines on stdout
//   • prod → newline-delimited JSON on stdout (for log shippers / journald)
//   • file → always JSON (the admin viewer parses it), size-rotated in-process
//
// Usage:
//   import { logger } from '$lib/server/logger';
//   logger.info({ userId }, 'wallet imported');
//   const log = childLogger('electrum');   // tags every line with { tag }
//   log.warn('reconnecting');

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { env } from '$env/dynamic/private';
import pino from 'pino';
import pretty from 'pino-pretty';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

// --------------------------------------------------------------- configuration

// Dev/test detection via Vite's compile-time env — resolved statically in the
// SvelteKit build and available under Vitest, unlike $app/environment (which
// the test runner can't resolve, and this module is imported deep in the server
// graph). dev → pretty stdout; test → silent, no file writes.
const dev = import.meta.env.DEV;
const isTest = import.meta.env.MODE === 'test';

/**
 * LOG_LEVEL env overrides the default (debug in dev, info in prod, off in
 * test). Exported (Wave 1 / log-request.md §5) so hooks.server.ts's startup
 * summary line can report the effective logging config alongside the rest of
 * the honored env.
 */
export const LEVEL: string = (
	env.LOG_LEVEL ?? (isTest ? 'silent' : dev ? 'debug' : 'info')
).toLowerCase();

/**
 * Where the rotating log file lives. Defaults under data/ (which is gitignored
 * and the same volume the SQLite DB uses) so the admin viewer works out of the
 * box. Set HEARTWOOD_LOG_FILE (post-rebrand alias) or CAIRN_LOG_FILE to
 * relocate it, or CAIRN_LOG_TO_FILE=false to write to stdout only (e.g. when an
 * external collector already captures stdout). CAIRN_LOG_FILE stays supported
 * indefinitely — existing self-hosted installs set it in their Docker env.
 */
export const LOG_FILE: string =
	env.HEARTWOOD_LOG_FILE ??
	env.CAIRN_LOG_FILE ??
	path.join(process.cwd(), 'data', 'logs', 'cairn.log');

// Exported alongside LOG_FILE/LEVEL (Wave 1 startup summary — same rationale).
export const FILE_ENABLED = !isTest && env.CAIRN_LOG_TO_FILE !== 'false';

/** Rotate when the active file passes this size, keeping this many old files. */
export const MAX_FILE_BYTES = numberFromEnv(env.CAIRN_LOG_MAX_SIZE, 10 * 1024 * 1024);
export const MAX_FILES = Math.max(1, numberFromEnv(env.CAIRN_LOG_MAX_FILES, 5));

function numberFromEnv(raw: string | undefined, fallback: number): number {
	const n = raw == null ? NaN : Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ------------------------------------------------------ rotating file destination

/**
 * A minimal, dependency-free size-rotating file sink.
 *
 * Appends JSON log lines synchronously (logging volume is low for a self-hosted
 * instance, and synchronous writes keep rotation atomic and correct). When the
 * active file passes MAX_FILE_BYTES it shifts cairn.log → cairn.log.1 → … up to
 * MAX_FILES, dropping the oldest. A logging failure must never take the app
 * down, so every filesystem operation is wrapped and degrades to silence.
 */
class RotatingFileStream extends Writable {
	private fd: number | null = null;
	private size = 0;
	private broken = false;

	constructor(
		private readonly filePath: string,
		private readonly maxBytes: number,
		private readonly maxFiles: number
	) {
		super();
		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			this.open();
		} catch {
			// Can't create the log dir/file — carry on with stdout only.
			this.broken = true;
		}
	}

	private open(): void {
		this.fd = fs.openSync(this.filePath, 'a');
		try {
			this.size = fs.fstatSync(this.fd).size;
		} catch {
			this.size = 0;
		}
	}

	private rotate(): void {
		if (this.fd !== null) {
			try {
				fs.closeSync(this.fd);
			} catch {
				/* ignore */
			}
			this.fd = null;
		}
		// Shift backups: drop the oldest, then .{n-1} → .{n}, … , base → .1
		try {
			const oldest = `${this.filePath}.${this.maxFiles}`;
			if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
			for (let i = this.maxFiles - 1; i >= 1; i--) {
				const from = `${this.filePath}.${i}`;
				const to = `${this.filePath}.${i + 1}`;
				if (fs.existsSync(from)) fs.renameSync(from, to);
			}
			if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
		} catch {
			// A rotation hiccup shouldn't stop logging; just reopen and continue.
		}
		this.open();
	}

	override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
		if (this.broken) return cb();
		try {
			const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			if (this.fd !== null && this.size + buf.length > this.maxBytes && this.size > 0) {
				this.rotate();
			}
			if (this.fd !== null) {
				fs.writeSync(this.fd, buf);
				this.size += buf.length;
			}
		} catch {
			// Never let a log write crash a request. Mark broken so we stop trying.
			this.broken = true;
		}
		cb();
	}
}

// --------------------------------------------------------------- pino assembly

function buildStreams(): pino.StreamEntry[] {
	const streams: pino.StreamEntry[] = [];

	// stdout: pretty in dev, raw JSON in prod.
	if (dev) {
		streams.push({
			level: LEVEL as pino.Level,
			stream: pretty({
				colorize: true,
				translateTime: 'SYS:HH:MM:ss.l',
				ignore: 'pid,hostname',
				messageFormat: '{tag} {msg}'
			})
		});
	} else {
		streams.push({ level: LEVEL as pino.Level, stream: process.stdout });
	}

	// Optional local file (always JSON) for the admin log viewer + standalone installs.
	if (FILE_ENABLED) {
		streams.push({
			level: LEVEL as pino.Level,
			stream: new RotatingFileStream(LOG_FILE, MAX_FILE_BYTES, MAX_FILES)
		});
	}

	return streams;
}

// Secret-bearing field names to redact from any logged object (top level and one
// level of nesting). Kept broad on purpose — defense-in-depth, not a promise that
// these are ever logged today.
const REDACT_KEYS = [
	'password',
	'pass',
	'passEnc',
	'newPassword',
	'oldPassword',
	'smtpPass',
	'smtp_pass',
	'core_rpc_pass',
	'coreRpcPass',
	'secret',
	'token',
	'accessToken',
	'botToken',
	'telegram_bot_token',
	'sessionToken',
	'apiKey',
	'privateKey',
	'privkey',
	'nostr_sender_privkey',
	'xprv',
	'mnemonic',
	'phrase',
	'recoveryPhrase',
	'seed',
	'psbt',
	'challenge',
	// PII (cairn-o1dp.7): /admin/logs is readable by EVERY admin on a
	// multi-admin instance, so raw emails/IPs from ordinary login, recovery, and
	// invite traffic don't belong in it. userId keeps events traceable.
	'email',
	'ip'
];

/**
 * The exact redact options handed to pino below — exported so tests can build a
 * capturing logger with the SAME configuration and pin the redaction behavior
 * (cairn-5tp3). Covers each key at the top level and one nesting down.
 */
export const REDACT_OPTIONS = {
	paths: REDACT_KEYS.flatMap((k) => [k, `*.${k}`]),
	censor: '[redacted]'
};

/**
 * The base logger. Prefer {@link childLogger} to tag a subsystem, and always
 * pass structured context as the first arg:
 *   logger.error({ err, walletId }, 'scan failed')
 * NEVER log secrets — passwords, session tokens, raw PSBTs, xprvs. See
 * hooks.server.ts for how request paths are redacted before they reach here.
 */
export const logger = pino(
	{
		level: LEVEL,
		// Render Error objects (message + stack) instead of "{}".
		serializers: { err: pino.stdSerializers.err },
		base: undefined, // no pid/hostname noise — this is a single-tenant box
		// Defense-in-depth redaction (cairn-byoz): no call site is known to log a
		// secret, but /admin/logs serves data/logs/cairn.log over HTTP, so a future
		// logger.*({ ... }) that accidentally includes a credential must never leak
		// it. Covers common secret-bearing keys at the top level and one nesting
		// down (e.g. { config: { pass } }, { smtp: { accessToken } }). Values are
		// replaced with [redacted]; `err` is intentionally NOT redacted.
		redact: REDACT_OPTIONS
	},
	pino.multistream(buildStreams())
);

/** A child logger that tags every line with { tag } (e.g. 'http', 'electrum'). */
export function childLogger(tag: string): pino.Logger {
	return logger.child({ tag });
}
