import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';

const DB_PATH = env.CAIRN_DB ?? path.join(process.cwd(), 'data', 'cairn.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
	PRAGMA busy_timeout = 5000;

	CREATE TABLE IF NOT EXISTS users (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		display_name  TEXT NOT NULL,
		is_admin      INTEGER NOT NULL DEFAULT 0,
		disabled      INTEGER NOT NULL DEFAULT 0,
		created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		last_login    TEXT
	);

	CREATE TABLE IF NOT EXISTS sessions (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		token_hash TEXT NOT NULL UNIQUE,
		user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		expires_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

	CREATE TABLE IF NOT EXISTS wallets (
		id             INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name           TEXT NOT NULL,
		type           TEXT NOT NULL DEFAULT 'xpub',
		xpub           TEXT NOT NULL,
		script_type    TEXT NOT NULL,
		receive_cursor INTEGER NOT NULL DEFAULT 0,
		created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		UNIQUE (user_id, xpub)
	);
	CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);

	CREATE TABLE IF NOT EXISTS invites (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		code       TEXT NOT NULL UNIQUE,
		label      TEXT,
		created_by INTEGER NOT NULL REFERENCES users(id),
		max_uses   INTEGER NOT NULL DEFAULT 1,
		used_count INTEGER NOT NULL DEFAULT 0,
		revoked    INTEGER NOT NULL DEFAULT 0,
		expires_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	);

	CREATE TABLE IF NOT EXISTS settings (
		key   TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
`);
