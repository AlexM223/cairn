// Settings → Notifications (Unit 9, §4). Loads everything the page needs for its
// first paint: each channel's redacted connection config + configured/verified
// state, the uploaded PGP key's fingerprint, the user's saved event-preference
// rows plus the DEFAULT_PREFERENCES fallback, and the instance defaults the UI
// pre-fills (email address, ntfy default server, Nostr default relays). All
// mutations go through the /api/notifications/* routes; this loader is read-only.

import { db } from '$lib/server/db';
import { getSetting } from '$lib/server/settings';
import { DEFAULT_PREFERENCES } from '$lib/server/notifications';
import { redactChannelConfig, type ConfigurableChannel } from '$lib/server/notifyConfig';
import { getQuietHours } from '$lib/server/quietHours';
import { NOTIFICATION_EVENT_TYPES } from '$lib/server/notifyTypes';
import type { PageServerLoad } from './$types';

type ExternalChannel = ConfigurableChannel;
const EXTERNAL_CHANNELS: ExternalChannel[] = ['email', 'telegram', 'ntfy', 'nostr', 'webhook'];

interface ChannelConfigRow {
	channel: string;
	config: string;
	verified_at: string | null;
}

interface PrefRow {
	event_type: string;
	channel: string;
	enabled: number;
	config: string | null;
}

function safeParse(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function safeParseArray(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

// Secret-field redaction is shared with the channel API route via notifyConfig.ts
// (cairn-ofna) so a new secret field is redacted everywhere from one edit.
const redact = redactChannelConfig;

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const uid = user.id;

	// --- Channel connection config (redacted) --------------------------------
	const cfgRows = db
		.prepare('SELECT channel, config, verified_at FROM notification_channel_config WHERE user_id = ?')
		.all(uid) as unknown as ChannelConfigRow[];
	const byChannel = new Map(cfgRows.map((r) => [r.channel, r]));

	const channels = EXTERNAL_CHANNELS.map((channel) => {
		const row = byChannel.get(channel);
		const stored = row ? safeParse(row.config) : {};
		return {
			channel,
			configured: !!row,
			verifiedAt: row?.verified_at ?? null,
			config: redact(channel, stored)
		};
	});

	// --- Instance defaults the UI pre-fills / placeholders -------------------
	const defaults = {
		emailAddress: user.email,
		ntfyServer: getSetting('ntfy_default_server') ?? '',
		nostrRelays: safeParseArray(getSetting('nostr_default_relays'))
	};

	// --- PGP key -------------------------------------------------------------
	const pgpRow = db
		.prepare('SELECT fingerprint, created_at FROM user_pgp_keys WHERE user_id = ?')
		.get(uid) as { fingerprint: string; created_at: string } | undefined;
	const pgp = pgpRow ? { fingerprint: pgpRow.fingerprint, createdAt: pgpRow.created_at } : null;

	// --- Event preferences ---------------------------------------------------
	const prefRows = db
		.prepare('SELECT event_type, channel, enabled, config FROM notification_preferences WHERE user_id = ?')
		.all(uid) as unknown as PrefRow[];
	const preferences = prefRows.map((r) => ({
		eventType: r.event_type,
		channel: r.channel,
		enabled: r.enabled === 1,
		config: safeParse(r.config)
	}));

	return {
		isAdmin: user.isAdmin,
		eventTypes: NOTIFICATION_EVENT_TYPES,
		channels,
		defaults,
		pgp,
		preferences,
		defaultPreferences: DEFAULT_PREFERENCES,
		quietHours: getQuietHours(uid)
	};
};
