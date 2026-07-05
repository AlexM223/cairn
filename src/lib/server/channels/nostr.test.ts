import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { db } from '../db';
import { registerUser } from '../auth';
import { getSetting, setSetting } from '../settings';
import { getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

// --- Mock the relay pool so no real WebSockets are opened. -------------------
// publish() returns one Promise<string> per relay; we control resolve/reject
// per test via the `publishImpl` hook below.
let publishImpl: (relays: string[], event: unknown) => Promise<string>[];
const closeSpy = vi.fn();

vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		publish(relays: string[], event: unknown): Promise<string>[] {
			return publishImpl(relays, event);
		}
		close(relays: string[]): void {
			closeSpy(relays);
		}
	}
}));

// Import AFTER the mock is registered.
import nostrChannel, { _internals } from './nostr';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const PASSWORD = 'correct horse battery staple';
function makeUser(email: string): number {
	setSetting('registration_mode', 'open');
	return registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] }).id;
}

/** A known recipient identity we can decrypt against to prove the DM is real. */
const RECIPIENT_SK = 'a'.repeat(64);
const RECIPIENT_PUBKEY = getPublicKey(hexToBytes(RECIPIENT_SK));

function saveConfig(userId: number, config: Record<string, unknown>): void {
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config)
		 VALUES (?, 'nostr', ?)`
	).run(userId, JSON.stringify(config));
}

const payload = {
	type: 'tx_received' as const,
	userId: 1,
	level: 'info' as const,
	title: 'Payment received',
	body: '0.01 BTC to Savings',
	link: '/wallets/3'
};

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	// Default: every relay accepts.
	publishImpl = (relays) => relays.map(() => Promise.resolve('ok'));
});

describe('config + isConfigured', () => {
	it('is not configured with no row', () => {
		const u = makeUser('a@example.com');
		expect(nostrChannel.isConfigured(u)).toBe(false);
	});

	it('is not configured when recipientPubkey is missing or empty', () => {
		const u = makeUser('b@example.com');
		saveConfig(u, { relays: ['wss://relay.example'] });
		expect(nostrChannel.isConfigured(u)).toBe(false);
		db.prepare('DELETE FROM notification_channel_config').run();
		saveConfig(u, { recipientPubkey: '   ' });
		expect(nostrChannel.isConfigured(u)).toBe(false);
	});

	it('is configured with a valid hex pubkey', () => {
		const u = makeUser('c@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY });
		expect(nostrChannel.isConfigured(u)).toBe(true);
	});

	it('rejects an unparseable pubkey (not hex, not npub)', () => {
		const u = makeUser('d@example.com');
		saveConfig(u, { recipientPubkey: 'definitely-not-a-key' });
		expect(nostrChannel.isConfigured(u)).toBe(false);
	});
});

describe('normalizePubkey', () => {
	it('passes through lowercased 64-hex', () => {
		expect(_internals.normalizePubkey(RECIPIENT_PUBKEY.toUpperCase())).toBe(RECIPIENT_PUBKEY);
	});
	it('rejects a short/invalid hex', () => {
		expect(_internals.normalizePubkey('abcd')).toBeNull();
	});
	it('rejects a malformed npub', () => {
		expect(_internals.normalizePubkey('npub1notreal')).toBeNull();
	});
});

describe('instance sender identity', () => {
	it('generates and persists a sender key on first use', () => {
		expect(getSetting('nostr_sender_privkey')).toBeNull();
		const sk = _internals.getOrCreateSenderSecretKey();
		expect(sk).not.toBeNull();
		const stored = getSetting('nostr_sender_privkey');
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
		// Stable across calls.
		const again = _internals.getOrCreateSenderSecretKey();
		expect(getSetting('nostr_sender_privkey')).toBe(stored);
		expect(Array.from(again!)).toEqual(Array.from(sk!));
	});
});

describe('send() — publish semantics', () => {
	it('succeeds and the DM decrypts back to the payload text', async () => {
		const u = makeUser('e@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://r1', 'wss://r2'] });

		let capturedEvent: { content: string; tags: string[][]; pubkey: string } | undefined;
		publishImpl = (relays, event) => {
			capturedEvent = event as typeof capturedEvent;
			return relays.map(() => Promise.resolve('ok'));
		};

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(true);
		expect(capturedEvent).toBeDefined();
		expect(capturedEvent!.tags).toContainEqual(['p', RECIPIENT_PUBKEY]);

		// Decrypt from the recipient's side to prove we built a real NIP-44 DM.
		const convKey = nip44.v2.utils.getConversationKey(hexToBytes(RECIPIENT_SK), capturedEvent!.pubkey);
		const plaintext = nip44.decrypt(capturedEvent!.content, convKey);
		expect(plaintext).toContain('Payment received');
		expect(plaintext).toContain('0.01 BTC to Savings');
		expect(plaintext).toContain('/wallets/3');
		// Pool cleanup ran.
		expect(closeSpy).toHaveBeenCalled();
	});

	it('is ok when at least one relay accepts (others reject)', async () => {
		const u = makeUser('f@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://good', 'wss://bad'] });
		publishImpl = () => [Promise.resolve('ok'), Promise.reject(new Error('relay down'))];

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(true);
	});

	it('fails retryably when EVERY relay rejects', async () => {
		const u = makeUser('g@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://a', 'wss://b'] });
		publishImpl = () => [
			Promise.reject(new Error('timeout')),
			Promise.reject(new Error('refused'))
		];

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
		expect(res.error).toMatch(/relay/i);
	});

	it('falls back to instance default relays when the user set none', async () => {
		const u = makeUser('h@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY });
		setSetting('nostr_default_relays', JSON.stringify(['wss://default-relay']));

		let seen: string[] = [];
		publishImpl = (relays) => {
			seen = relays;
			return relays.map(() => Promise.resolve('ok'));
		};
		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(true);
		expect(seen).toEqual(['wss://default-relay']);
	});

	it('returns a non-retryable config error when not configured', async () => {
		const u = makeUser('i@example.com');
		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});

	it('returns a non-retryable error on an invalid pubkey', async () => {
		const u = makeUser('j@example.com');
		saveConfig(u, { recipientPubkey: 'garbage' });
		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});
});

describe('test()', () => {
	it('reports "published to at least one relay" on success', async () => {
		const u = makeUser('k@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://r'] });
		const res = await nostrChannel.test(u);
		expect(res.ok).toBe(true);
		expect(res.error).toMatch(/published to at least one relay/i);
	});

	it('surfaces a retryable failure when no relay accepts', async () => {
		const u = makeUser('l@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://r'] });
		publishImpl = () => [Promise.reject(new Error('down'))];
		const res = await nostrChannel.test(u);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});
