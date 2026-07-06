// cairn-o1dp.4 — address-label ACCESS TIERS on the multisig route: every
// participant (owner/cosigner/viewer) reads the shared annotations, but writes
// are cosigner/owner-only; a viewer gets an explicit 403 on PUT (not 404 — GET
// already reveals the wallet to them). Non-participants get the uniform 404.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { GET, PUT } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM address_labels; DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let owner: number;
let cosigner: number;
let viewer: number;
let outsider: number;
let multisigId: number;

function makeUser(email: string): number {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	}).id;
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	owner = makeUser('owner@example.com');
	cosigner = makeUser('cosigner@example.com');
	viewer = makeUser('viewer@example.com');
	outsider = makeUser('outsider@example.com');
	multisigId = Number(
		db
			.prepare("INSERT INTO multisigs (user_id, name, threshold) VALUES (?, 'Vault', 2)")
			.run(owner).lastInsertRowid
	);
	const share = db.prepare(
		'INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)'
	);
	share.run(multisigId, owner, cosigner, 'cosigner');
	share.run(multisigId, owner, viewer, 'viewer');
});

function event(userId: number, body?: unknown): Parameters<typeof PUT>[0] {
	return {
		locals: { user: { id: userId, email: 'x@example.com', isAdmin: false } },
		params: { id: String(multisigId) },
		request: new Request(`http://localhost/api/wallets/multisig/${multisigId}/address-labels`, {
			method: body === undefined ? 'GET' : 'PUT',
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

const LABEL_BODY = { address: 'bcrt1qexampleaddress', label: 'exchange deposit' };

describe('multisig address-labels access tiers (cairn-o1dp.4)', () => {
	it('owner and cosigner can PUT; the label round-trips on GET for every participant', async () => {
		expect((await PUT(event(owner, LABEL_BODY))).status).toBe(200);
		expect(
			(await PUT(event(cosigner, { address: 'bcrt1qother', label: 'cold storage' }))).status
		).toBe(200);

		for (const uid of [owner, cosigner, viewer]) {
			const res = await GET(event(uid));
			expect(res.status).toBe(200);
			const { labels } = await res.json();
			expect(labels).toMatchObject({
				bcrt1qexampleaddress: 'exchange deposit',
				bcrt1qother: 'cold storage'
			});
		}
	});

	it('a viewer can GET but gets 403 on PUT — and the label is not written', async () => {
		const res = await PUT(event(viewer, LABEL_BODY));
		expect(res.status).toBe(403);

		const read = await GET(event(viewer));
		expect(read.status).toBe(200);
		expect(Object.keys((await read.json()).labels)).toHaveLength(0);
	});

	it('a non-participant gets the uniform 404 on both methods', async () => {
		expect((await GET(event(outsider))).status).toBe(404);
		expect((await PUT(event(outsider, LABEL_BODY))).status).toBe(404);
	});
});
