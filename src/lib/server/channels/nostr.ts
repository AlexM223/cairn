// Nostr channel — encrypted direct messages (NIP-44) to the user's own pubkey.
// See docs/NOTIFICATION-PLAN.md §2.5 (Unit 6).
//
// WHAT THIS DOES
//   Cairn holds a single instance-wide Nostr identity (a secp256k1 secret key,
//   generated once and persisted in the `settings` table under
//   `nostr_sender_privkey`). For each user who has configured this channel with
//   their own pubkey, we build a NIP-44-encrypted event addressed to that
//   pubkey, containing the notification title + body (+ deep-link), and publish
//   it to a set of relays. The recipient's Nostr client decrypts and shows it.
//
// WHY NIP-44 (and NOT hand-rolled crypto)
//   All encryption/signing goes through nostr-tools' own helpers
//   (`nip44.v2.utils.getConversationKey` + `nip44.encrypt`, `finalizeEvent`).
//   We never touch raw ChaCha/secp ourselves — rolling crypto here would be a
//   footgun. The encrypted payload is carried on a kind:4 event (the
//   long-established DM kind) whose `content` is a NIP-44 ciphertext and whose
//   single `p` tag is the recipient. This is deliberately simple and widely
//   readable; NIP-17 gift-wrapping is a possible fast-follow but not needed for
//   a one-way server→user notification.
//
// DELIVERY SEMANTICS
//   Nostr is publish-to-many by design. A send is OK if AT LEAST ONE relay
//   accepted the event. We only report failure (retryable) when EVERY relay
//   rejected or was unreachable. There is no delivery confirmation possible —
//   "published to at least one relay" is the strongest signal we can give, and
//   test()'s success copy says exactly that.
//
// CONFIG SHAPES
//   Per-user  (notification_channel_config, channel='nostr'):
//     { "recipientPubkey": "<hex or npub…>", "relays"?: ["wss://…", …] }
//   Instance  (settings table, raw keys):
//     nostr_sender_privkey  — 64-hex secret key; generated on first use if absent
//     nostr_default_relays  — JSON array of relay URLs (used when the user gives none)

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { nip44 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { db } from '../db';
import { childLogger } from '../logger';
import { getSetting, setSetting } from '../settings';
import type {
	ChannelSendResult,
	NotificationChannelPlugin,
	NotificationPayload
} from '../notifyTypes';
import { absoluteNotificationLink } from '../notifyLinks';

const log = childLogger('notify:nostr');

/** kind:4 — encrypted direct message. Content here is a NIP-44 ciphertext. */
const KIND_ENCRYPTED_DM = 4;

/** Fallback relays when neither the user nor the instance configured any. */
const BUILTIN_DEFAULT_RELAYS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.nostr.band'
];

interface NostrUserConfig {
	recipientPubkey: string;
	relays?: string[];
}

/** Read + parse a user's saved nostr config row. Returns null if absent/invalid. */
function readUserConfig(userId: number): NostrUserConfig | null {
	let raw: string | undefined;
	try {
		const row = db
			.prepare(
				`SELECT config FROM notification_channel_config
				  WHERE user_id = ? AND channel = 'nostr'`
			)
			.get(userId) as { config: string } | undefined;
		raw = row?.config;
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read nostr channel config');
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<NostrUserConfig>;
		if (!parsed || typeof parsed.recipientPubkey !== 'string') return null;
		const recipientPubkey = parsed.recipientPubkey.trim();
		if (!recipientPubkey) return null;
		const relays = Array.isArray(parsed.relays)
			? parsed.relays.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
			: undefined;
		return { recipientPubkey, relays };
	} catch (e) {
		log.error({ err: e, userId }, 'nostr channel config is not valid JSON');
		return null;
	}
}

/**
 * Normalize a recipient pubkey to 64-char lowercase hex. Accepts either raw hex
 * or a bech32 `npub…`. Returns null on anything we can't decode — a bad key is a
 * non-retryable config error, not a transport failure.
 */
function normalizePubkey(input: string): string | null {
	const value = input.trim();
	if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
	if (value.startsWith('npub1')) {
		try {
			const decoded = nip19.decode(value as `npub1${string}`);
			if (decoded.type === 'npub' && typeof decoded.data === 'string') {
				return decoded.data.toLowerCase();
			}
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * The instance Nostr secret key, as a Uint8Array. Generated (via nostr-tools'
 * generateSecretKey) and persisted on first use if the setting is absent — this
 * key never leaves the server and there is no legitimate reason to export it.
 * Returns null only if persistence itself failed.
 */
function getOrCreateSenderSecretKey(): Uint8Array | null {
	const existing = getSetting('nostr_sender_privkey');
	if (existing && /^[0-9a-fA-F]{64}$/.test(existing.trim())) {
		try {
			return hexToBytes(existing.trim().toLowerCase());
		} catch {
			// fall through to regenerate — a corrupt stored key is unusable
		}
	}
	try {
		const sk = generateSecretKey();
		setSetting('nostr_sender_privkey', bytesToHex(sk));
		log.info('generated a new instance Nostr identity');
		return sk;
	} catch (e) {
		log.error({ err: e }, 'failed to generate/persist instance Nostr identity');
		return null;
	}
}

/** Instance-default relay list from settings, falling back to the built-ins. */
function instanceDefaultRelays(): string[] {
	const raw = getSetting('nostr_default_relays');
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				const relays = parsed.filter(
					(r): r is string => typeof r === 'string' && r.trim().length > 0
				);
				if (relays.length > 0) return relays;
			}
		} catch (e) {
			log.warn({ err: e }, 'nostr_default_relays is not valid JSON; using built-in defaults');
		}
	}
	return BUILTIN_DEFAULT_RELAYS;
}

/** Compose the human-readable plaintext of the DM from a payload. */
function composeMessage(payload: NotificationPayload): string {
	const parts = [payload.title];
	if (payload.body) parts.push(payload.body);
	// A relative path is inert text in a Nostr DM — send the absolute URL
	// (cairn-5gpv.1). Omitted when CAIRN_ORIGIN is unset.
	const link = absoluteNotificationLink(payload.link);
	if (link) parts.push(link);
	return parts.filter(Boolean).join('\n\n');
}

/**
 * Publish an already-composed plaintext to the given relays as an encrypted DM.
 * Returns ok:true if any relay accepted; retryable failure only if all failed.
 * Split out from send()/test() so both share the exact same publish path.
 */
async function publishEncryptedDM(
	recipientPubkeyHex: string,
	relays: string[],
	plaintext: string
): Promise<ChannelSendResult> {
	const senderSk = getOrCreateSenderSecretKey();
	if (!senderSk) {
		return { ok: false, error: 'Server Nostr identity unavailable', retryable: true };
	}

	let ciphertext: string;
	try {
		const conversationKey = nip44.v2.utils.getConversationKey(senderSk, recipientPubkeyHex);
		ciphertext = nip44.encrypt(plaintext, conversationKey);
	} catch (e) {
		log.error({ err: e }, 'NIP-44 encryption failed');
		return { ok: false, error: 'Failed to encrypt notification', retryable: false };
	}

	let signedEvent;
	try {
		signedEvent = finalizeEvent(
			{
				kind: KIND_ENCRYPTED_DM,
				created_at: Math.floor(Date.now() / 1000),
				tags: [['p', recipientPubkeyHex]],
				content: ciphertext
			},
			senderSk
		);
	} catch (e) {
		log.error({ err: e }, 'failed to sign Nostr event');
		return { ok: false, error: 'Failed to sign notification', retryable: false };
	}

	const pool = createPool();
	try {
		// publish() returns one Promise<string> per relay: resolve = accepted,
		// reject = that relay refused/was unreachable. We succeed if ANY resolves.
		const results = await Promise.allSettled(pool.publish(relays, signedEvent));
		const accepted = results.filter((r) => r.status === 'fulfilled').length;
		const failures = results
			.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
			.map((r) => String(r.reason));

		if (accepted > 0) {
			if (failures.length > 0) {
				log.warn(
					{ accepted, failed: failures.length, relays: relays.length },
					'Nostr DM published to some relays; others failed'
				);
			}
			return { ok: true };
		}

		log.error({ failures, relays: relays.length }, 'Nostr DM rejected by every relay');
		return {
			ok: false,
			error:
				failures.length > 0
					? `All relays failed: ${failures.slice(0, 3).join('; ')}`
					: 'No relays accepted the event',
			retryable: true
		};
	} catch (e) {
		log.error({ err: e }, 'Nostr publish threw');
		return { ok: false, error: 'Nostr publish failed', retryable: true };
	} finally {
		try {
			pool.close(relays);
		} catch {
			/* best-effort cleanup */
		}
	}
}

/**
 * Factory for the relay pool. Isolated so tests can mock the transport (via
 * vi.mock('nostr-tools/pool')) without spinning up real WebSockets. Node 22.5+
 * exposes a global WebSocket, which nostr-tools uses automatically.
 */
function createPool(): SimplePool {
	return new SimplePool();
}

const nostrChannel: NotificationChannelPlugin = {
	id: 'nostr',
	label: 'Nostr',

	isConfigured(userId: number): boolean {
		const config = readUserConfig(userId);
		if (!config) return false;
		return normalizePubkey(config.recipientPubkey) !== null;
	},

	async send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult> {
		const config = readUserConfig(userId);
		if (!config) {
			return { ok: false, error: 'Nostr channel not configured', retryable: false };
		}
		const recipientHex = normalizePubkey(config.recipientPubkey);
		if (!recipientHex) {
			return { ok: false, error: 'Invalid recipient pubkey', retryable: false };
		}
		const relays =
			config.relays && config.relays.length > 0 ? config.relays : instanceDefaultRelays();
		if (relays.length === 0) {
			return { ok: false, error: 'No relays configured', retryable: false };
		}
		return publishEncryptedDM(recipientHex, relays, composeMessage(payload));
	},

	async test(userId: number): Promise<ChannelSendResult> {
		const config = readUserConfig(userId);
		if (!config) {
			return { ok: false, error: 'Nostr channel not configured', retryable: false };
		}
		const recipientHex = normalizePubkey(config.recipientPubkey);
		if (!recipientHex) {
			return { ok: false, error: 'Invalid recipient pubkey', retryable: false };
		}
		const relays =
			config.relays && config.relays.length > 0 ? config.relays : instanceDefaultRelays();
		if (relays.length === 0) {
			return { ok: false, error: 'No relays configured', retryable: false };
		}
		const result = await publishEncryptedDM(
			recipientHex,
			relays,
			'Cairn test notification — if you can read this, your Nostr channel works.'
		);
		if (result.ok) {
			// No delivery confirmation is possible on Nostr — be honest about it.
			return { ok: true, error: 'Published to at least one relay' };
		}
		return result;
	}
};

/** Exposed for tests only — never import these from application code. */
export const _internals = {
	readUserConfig,
	normalizePubkey,
	getOrCreateSenderSecretKey,
	instanceDefaultRelays,
	composeMessage,
	getSenderPublicKey: (): string | null => {
		const sk = getOrCreateSenderSecretKey();
		return sk ? getPublicKey(sk) : null;
	}
};

export default nostrChannel;
