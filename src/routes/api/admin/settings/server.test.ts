// cairn-qmo5 — PUT /api/admin/settings must apply the same validation as the
// admin settings form action. Pre-fix the API route persisted whatever a
// scripted admin sent: a garbage registration_mode matched neither the invite
// nor the closed check in signup (silently falling through to fully-open
// registration), and a non-numeric electrum port became NaN and broke the node
// connection. Also pins cairn-q40v at the API surface: neither GET nor PUT may
// echo the stored Core RPC password.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting, getSetting } from '$lib/server/settings';
import { GET, PUT } from './+server';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;');
}

const PASSWORD = 'correct horse battery';
let admin: { id: number; email: string; displayName: string; isAdmin: boolean };

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	const u = await registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'admin' });
	admin = { id: u.id, email: u.email, displayName: u.displayName, isAdmin: true };
});

function putEvent(body: unknown): Parameters<typeof PUT>[0] {
	return {
		locals: { user: admin },
		params: {},
		request: new Request('http://localhost/api/admin/settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

async function put(body: unknown) {
	const res = await PUT(putEvent(body));
	return { status: res.status, body: await res.json() };
}

async function get() {
	const res = await GET({ locals: { user: admin }, params: {} } as unknown as Parameters<typeof GET>[0]);
	return { status: res.status, body: await res.json() };
}

describe('PUT /api/admin/settings validation (cairn-qmo5)', () => {
	it('rejects an invalid registrationMode with 400 and persists nothing', async () => {
		const { status } = await put({ registrationMode: 'wide-open' });
		expect(status).toBe(400);
		expect(getSetting('registration_mode')).toBe('open'); // untouched
	});

	it('rejects an invalid connectionMode with 400 and persists nothing', async () => {
		const { status } = await put({ connectionMode: 'sideways' });
		expect(status).toBe(400);
		expect(getSetting('connection_mode')).toBeNull();
	});

	it('rejects out-of-range or non-numeric electrumPort values with 400', async () => {
		for (const electrumPort of ['abc', 0, -1, 65536, 3.5]) {
			const { status } = await put({ electrumPort });
			expect(status, `port ${electrumPort}`).toBe(400);
		}
		expect(getSetting('electrum_port')).toBeNull();
	});

	it('rejects an out-of-range electrumPoolSize with 400', async () => {
		for (const electrumPoolSize of [0, 5, 'lots']) {
			const { status } = await put({ electrumPoolSize });
			expect(status, `pool size ${electrumPoolSize}`).toBe(400);
		}
		expect(getSetting('electrum_pool_size')).toBeNull();
	});

	it('rejects an invalid socks5Port with 400', async () => {
		expect((await put({ socks5Port: 'not-a-port' })).status).toBe(400);
		expect(getSetting('socks5_port')).toBeNull();
	});

	// Esplora is fully removed (cairn-zoz8.16): esploraUrl is no longer a known key,
	// so a stray one (old client, scripted caller) is silently ignored — not an
	// error, and never persisted.
	it('ignores a stray esploraUrl instead of persisting it', async () => {
		const { status } = await put({ esploraUrl: 'https://mempool.example' });
		expect(status).toBe(200);
		expect(getSetting('esplora_url')).toBeNull();
	});

	it('an invalid field rejects the WHOLE body — valid keys alongside it must not persist', async () => {
		const { status } = await put({ registrationMode: 'closed', electrumPort: 999999 });
		expect(status).toBe(400);
		expect(getSetting('registration_mode')).toBe('open'); // the valid key did not land
	});

	it('a valid PUT returns 200, persists, and echoes the new settings', async () => {
		const { status, body } = await put({
			registrationMode: 'closed',
			connectionMode: 'custom',
			electrumHost: 'node.local',
			electrumPort: 50001
		});
		expect(status).toBe(200);
		expect(getSetting('registration_mode')).toBe('closed');
		expect(getSetting('connection_mode')).toBe('custom');
		expect(getSetting('electrum_host')).toBe('node.local');
		expect(getSetting('electrum_port')).toBe('50001');
		expect(body.settings).toMatchObject({
			registrationMode: 'closed',
			connectionMode: 'custom',
			electrumHost: 'node.local',
			electrumPort: 50001
		});
	});
});

describe('Core RPC password never round-trips through the API (cairn-q40v)', () => {
	const SECRET = 'super-secret-rpc-pass';

	it('GET replaces the stored password with hasCoreRpcPass and never leaks the raw value', async () => {
		setSetting('core_rpc_pass', SECRET);
		const { status, body } = await get();
		expect(status).toBe(200);
		expect(body.settings.hasCoreRpcPass).toBe(true);
		expect('coreRpcPass' in body.settings).toBe(false);
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});

	it('GET reports hasCoreRpcPass: false when no password is stored', async () => {
		const { body } = await get();
		expect(body.settings.hasCoreRpcPass).toBe(false);
	});

	it('PUT with a blank coreRpcPass keeps the stored secret and does not echo it', async () => {
		setSetting('core_rpc_pass', SECRET);
		const { status, body } = await put({ coreRpcPass: '', coreRpcUser: 'rpcuser' });
		expect(status).toBe(200);
		expect(getSetting('core_rpc_pass')).toBe(SECRET); // blank = keep
		expect(JSON.stringify(body)).not.toContain(SECRET);
	});
});
