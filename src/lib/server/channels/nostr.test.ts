import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { db } from '../db';
import { registerUser } from '../auth';
import { getSetting, setSetting } from '../settings';
import { getPublicKey } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';

// Mock DNS so the relay SSRF gate (checkRelayUrl → checkTargetHost in ./ssrf) is
// deterministic and never resolves the wss://r1-style test hostnames for real.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args)
}));

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
import nostrChannel, { _internals, rotateSenderSecretKey } from './nostr';
import { bytesToHex } from 'nostr-tools/utils';
import { decryptSecret } from '../secretKey';
import { migratePlaintextSecretsAtRest } from '../secretsMigration';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;'
	);
}

/** Raw at-rest form of the sender identity (instance_secrets since cairn-e9mz.4). */
function storedSenderKey(): string | null {
	const row = db
		.prepare("SELECT value_enc FROM instance_secrets WHERE key = 'nostr_sender_privkey'")
		.get() as { value_enc: string } | undefined;
	return row?.value_enc ?? null;
}

const PASSWORD = 'correct horse battery staple';
async function makeUser(email: string): Promise<number> {
	setSetting('registration_mode', 'open');
	const user = await registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] });
	return user.id;
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
	// Default DNS: every relay hostname resolves to a public address so it clears
	// the SSRF gate. Individual tests override this to exercise blocked ranges.
	lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	// Default: every relay accepts.
	publishImpl = (relays) => relays.map(() => Promise.resolve('ok'));
});

describe('config + isConfigured', () => {
	it('is not configured with no row', async () => {
		const u = await makeUser('a@example.com');
		expect(nostrChannel.isConfigured(u)).toBe(false);
	});

	it('is not configured when recipientPubkey is missing or empty', async () => {
		const u = await makeUser('b@example.com');
		saveConfig(u, { relays: ['wss://relay.example'] });
		expect(nostrChannel.isConfigured(u)).toBe(false);
		db.prepare('DELETE FROM notification_channel_config').run();
		saveConfig(u, { recipientPubkey: '   ' });
		expect(nostrChannel.isConfigured(u)).toBe(false);
	});

	it('is configured with a valid hex pubkey', async () => {
		const u = await makeUser('c@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY });
		expect(nostrChannel.isConfigured(u)).toBe(true);
	});

	it('rejects an unparseable pubkey (not hex, not npub)', async () => {
		const u = await makeUser('d@example.com');
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
	it('generates and persists a sender key ENCRYPTED at rest on first use (cairn-o6y5)', () => {
		expect(storedSenderKey()).toBeNull();
		const sk = _internals.getOrCreateSenderSecretKey();
		expect(sk).not.toBeNull();
		const stored = storedSenderKey()!;
		// The raw private key must NOT sit in the DB in plaintext — and never in
		// the plain settings table at all (cairn-e9mz.4).
		expect(stored).not.toMatch(/^[0-9a-f]{64}$/);
		expect(getSetting('nostr_sender_privkey')).toBeNull();
		// It's a versioned encrypted envelope that decrypts back to the key hex.
		expect(decryptSecret(stored)).toBe(bytesToHex(sk!));
		// Stable across calls, no needless re-write.
		const again = _internals.getOrCreateSenderSecretKey();
		expect(storedSenderKey()).toBe(stored);
		expect(Array.from(again!)).toEqual(Array.from(sk!));
	});

	it('keeps working from a legacy PLAINTEXT settings row; startup migration encrypts + moves it', () => {
		// Simulate a pre-encryption instance: a bare 64-hex key in `settings`.
		const legacyHex = 'b'.repeat(64);
		setSetting('nostr_sender_privkey', legacyHex);
		const sk = _internals.getOrCreateSenderSecretKey();
		expect(sk).not.toBeNull();
		expect(bytesToHex(sk!)).toBe(legacyHex); // identity preserved

		// The startup migration relocates + encrypts it (nostr.ts no longer does
		// this lazily — secretsMigration.ts owns legacy upgrades).
		migratePlaintextSecretsAtRest();
		expect(getSetting('nostr_sender_privkey')).toBeNull();
		expect(decryptSecret(storedSenderKey()!)).toBe(legacyHex);
		const after = _internals.getOrCreateSenderSecretKey();
		expect(bytesToHex(after!)).toBe(legacyHex); // identity survives the move
	});

	it('fails closed on an undecryptable stored key rather than silently changing identity', () => {
		db.prepare("INSERT INTO instance_secrets (key, value_enc) VALUES ('nostr_sender_privkey', ?)").run(
			JSON.stringify({ v: 1, iv: 'x', tag: 'y', data: 'z' })
		);
		expect(_internals.getOrCreateSenderSecretKey()).toBeNull();
	});

	it('rotate generates a NEW encrypted identity and reports the new pubkey', () => {
		const first = _internals.getOrCreateSenderSecretKey();
		const before = storedSenderKey();
		const result = rotateSenderSecretKey();
		expect(result?.pubkey).toMatch(/^[0-9a-f]{64}$/);
		const after = storedSenderKey()!;
		expect(after).not.toBe(before); // a new key was written
		expect(after).not.toMatch(/^[0-9a-f]{64}$/); // still encrypted
		const rotated = _internals.getOrCreateSenderSecretKey();
		expect(Array.from(rotated!)).not.toEqual(Array.from(first!)); // key actually changed
	});
});

describe('send() — publish semantics', () => {
	it('succeeds and the DM decrypts back to the payload text', async () => {
		const u = await makeUser('e@example.com');
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
		const u = await makeUser('f@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://good', 'wss://bad'] });
		publishImpl = () => [Promise.resolve('ok'), Promise.reject(new Error('relay down'))];

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(true);
	});

	it('fails retryably when EVERY relay rejects', async () => {
		const u = await makeUser('g@example.com');
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
		const u = await makeUser('h@example.com');
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
		const u = await makeUser('i@example.com');
		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});

	it('returns a non-retryable error on an invalid pubkey', async () => {
		const u = await makeUser('j@example.com');
		saveConfig(u, { recipientPubkey: 'garbage' });
		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
	});
});

describe('relay SSRF guard (cairn-zn7z)', () => {
	it('drops a relay that RESOLVES to a private range and never publishes to it', async () => {
		const u = await makeUser('ssrf-a@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://good', 'wss://internal'] });
		// good → public, internal → LAN. Only the public one should be dialled.
		lookupMock.mockImplementation((host: string) =>
			host === 'internal'
				? Promise.resolve([{ address: '10.0.0.5', family: 4 }])
				: Promise.resolve([{ address: '93.184.216.34', family: 4 }])
		);

		let seen: string[] = [];
		publishImpl = (relays) => {
			seen = relays;
			return relays.map(() => Promise.resolve('ok'));
		};

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(true);
		expect(seen).toEqual(['wss://good']); // the blocked relay was filtered out
	});

	it('fails NON-retryably when every relay is blocked, and never opens a socket', async () => {
		const u = await makeUser('ssrf-b@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://loopback'] });
		lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

		const publishSpy = vi.fn(() => [] as Promise<string>[]);
		publishImpl = publishSpy;

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toMatch(/blocked|private|loopback/i);
		expect(publishSpy).not.toHaveBeenCalled();
	});

	it('rejects a relay literal in the CGNAT range 100.64.0.0/10 (cairn-pihb)', async () => {
		const u = await makeUser('ssrf-c@example.com');
		// A literal Tailscale CGNAT IP — checked directly, no DNS.
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://100.100.100.100:4848'] });

		const publishSpy = vi.fn(() => [] as Promise<string>[]);
		publishImpl = publishSpy;

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(publishSpy).not.toHaveBeenCalled();
	});

	it('rejects a non-ws scheme relay', async () => {
		const u = await makeUser('ssrf-d@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['https://not-a-relay.example'] });

		const publishSpy = vi.fn(() => [] as Promise<string>[]);
		publishImpl = publishSpy;

		const res = await nostrChannel.send(u, payload);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(publishSpy).not.toHaveBeenCalled();
	});
});

describe('relay publish timeout (cairn-49qw)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('treats a relay that never ACKs as a per-relay failure without blocking a relay that does', async () => {
		const u = await makeUser('timeout-a@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://hangs', 'wss://good'] });
		// One relay never settles (simulates a completed handshake that never ACKs);
		// the other accepts immediately.
		publishImpl = () => [new Promise(() => {}), Promise.resolve('ok')];

		vi.useFakeTimers();
		const resultPromise = nostrChannel.send(u, payload);
		await vi.advanceTimersByTimeAsync(_internals.RELAY_PUBLISH_TIMEOUT_MS);
		const res = await resultPromise;

		expect(res.ok).toBe(true); // the responsive relay's accept still counts
		expect(closeSpy).toHaveBeenCalled(); // pool torn down even though one relay hung
	});

	it('fails retryably instead of hanging forever when every relay stalls', async () => {
		const u = await makeUser('timeout-b@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://hangs1', 'wss://hangs2'] });
		publishImpl = () => [new Promise(() => {}), new Promise(() => {})];

		vi.useFakeTimers();
		const resultPromise = nostrChannel.send(u, payload);
		await vi.advanceTimersByTimeAsync(_internals.RELAY_PUBLISH_TIMEOUT_MS);
		const res = await resultPromise;

		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});

describe('test()', () => {
	it('reports "published to at least one relay" on success', async () => {
		const u = await makeUser('k@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://r'] });
		const res = await nostrChannel.test(u);
		expect(res.ok).toBe(true);
		expect(res.error).toMatch(/published to at least one relay/i);
	});

	it('surfaces a retryable failure when no relay accepts', async () => {
		const u = await makeUser('l@example.com');
		saveConfig(u, { recipientPubkey: RECIPIENT_PUBKEY, relays: ['wss://r'] });
		publishImpl = () => [Promise.reject(new Error('down'))];
		const res = await nostrChannel.test(u);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});
