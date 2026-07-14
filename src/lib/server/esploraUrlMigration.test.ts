// migrateDropEsploraUrl() drops the dead `esplora_url` settings row left by
// installs upgraded from a version that stored one (Esplora fully removed,
// cairn-zoz8.16). Idempotent, non-throwing, and must touch only that one key.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import { migrateDropEsploraUrl } from './esploraUrlMigration';

function wipeSettings(): void {
	db.exec('DELETE FROM settings;');
}

beforeEach(() => {
	wipeSettings();
});

describe('migrateDropEsploraUrl', () => {
	it('removes a stored esplora_url row', () => {
		setSetting('esplora_url', 'https://mempool.space/api');
		expect(getSetting('esplora_url')).toBe('https://mempool.space/api');

		migrateDropEsploraUrl();

		expect(getSetting('esplora_url')).toBeNull();
	});

	it('is a no-op (no throw) when no esplora_url row exists', () => {
		expect(() => migrateDropEsploraUrl()).not.toThrow();
		expect(getSetting('esplora_url')).toBeNull();
	});

	it('is idempotent — running twice leaves the key absent', () => {
		setSetting('esplora_url', 'https://esplora.example');
		migrateDropEsploraUrl();
		migrateDropEsploraUrl();
		expect(getSetting('esplora_url')).toBeNull();
	});

	it('touches ONLY esplora_url — every other setting survives', () => {
		setSetting('esplora_url', 'https://esplora.example');
		setSetting('electrum_host', 'my.node');
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		setSetting('connection_mode', 'custom');

		migrateDropEsploraUrl();

		expect(getSetting('esplora_url')).toBeNull();
		expect(getSetting('electrum_host')).toBe('my.node');
		expect(getSetting('core_rpc_url')).toBe('http://127.0.0.1:8332');
		expect(getSetting('connection_mode')).toBe('custom');
	});
});
