// Self-service data rights (cairn-5u2i.3/.4): the read side of "what does this
// server hold about ME" — a full JSON export of the caller's own data, plus the
// session/device listing + revoke actions behind Settings → Your devices.
//
// Everything here is scoped to ONE user id at the query level (never trust the
// route to filter afterwards), uses explicit column lists in the spirit of
// backup.ts (no password/recovery hashes, no session token hashes, no other
// users' rows), and redacts notification-channel secrets through the same
// redactChannelConfig every API response uses.

import { db } from './db';
import { redactChannelConfig, type ConfigurableChannel } from './notifyConfig';
import { describeUserAgent } from './deviceTracking';

type Row = Record<string, unknown>;

function all(sql: string, ...params: (string | number)[]): Row[] {
	return db.prepare(sql).all(...params) as Row[];
}

// ------------------------------------------------------------------ export

/**
 * Everything Cairn stores about this user, per the 2026-07-06 data audit §11:
 * profile, wallet/multisig metadata (xpubs — never private keys, Cairn has
 * none), transaction history, address book + labels, notification preferences
 * and (secret-redacted) channel config, activity feed, agreement acceptances,
 * and this user's sessions/known devices. Raw PSBTs and secret material are
 * deliberately excluded.
 */
export function buildAccountExport(userId: number): Record<string, unknown> {
	const ownedWalletIds = (all('SELECT id FROM wallets WHERE user_id = ?', userId) as {
		id: number;
	}[]).map((r) => r.id);
	const ownedMultisigIds = (all('SELECT id FROM multisigs WHERE user_id = ?', userId) as {
		id: number;
	}[]).map((r) => r.id);

	const inWallet = ownedWalletIds.length
		? `IN (${ownedWalletIds.map(() => '?').join(', ')})`
		: 'IN (NULL)';
	const inMultisig = ownedMultisigIds.length
		? `IN (${ownedMultisigIds.map(() => '?').join(', ')})`
		: 'IN (NULL)';

	return {
		format: 'cairn-account-export',
		version: 1,
		profile: all(
			'SELECT email, display_name, is_admin, created_at, last_login FROM users WHERE id = ?',
			userId
		)[0] ?? null,
		wallets: all(
			`SELECT id, name, type, xpub, script_type, master_fingerprint, derivation_path,
			        device_type, created_at
			   FROM wallets WHERE user_id = ?`,
			userId
		),
		multisigs: all(
			'SELECT id, name, threshold, script_type, created_at FROM multisigs WHERE user_id = ?',
			userId
		).map((m) => ({
			...m,
			keys: all(
				'SELECT position, name, category, device_type, xpub, fingerprint, path FROM multisig_keys WHERE multisig_id = ? ORDER BY position',
				m.id as number
			)
		})),
		// Multisigs OTHERS shared with this user — their role only; the wallet
		// itself (keys, xpubs) belongs to its owner's export, not this one.
		multisigSharesReceived: all(
			`SELECT s.multisig_id, m.name AS multisig_name, s.role, s.created_at
			   FROM multisig_shares s JOIN multisigs m ON m.id = s.multisig_id
			  WHERE s.shared_with_id = ?`,
			userId
		),
		// Transaction history for owned wallets — the working PSBT blob is
		// excluded (bulky, derivable from the txid once broadcast).
		transactions: all(
			`SELECT wallet_id, status, txid, recipient, amount, recipients, fee, fee_rate,
			        replaces_txid, created_at, updated_at
			   FROM transactions WHERE wallet_id ${inWallet}`,
			...ownedWalletIds
		),
		multisigTransactions: all(
			`SELECT multisig_id, status, txid, recipient, amount, recipients, fee, fee_rate,
			        replaces_txid, created_at, updated_at
			   FROM multisig_transactions WHERE multisig_id ${inMultisig}`,
			...ownedMultisigIds
		),
		savedAddresses: all(
			'SELECT label, address, created_at, last_used_at FROM saved_addresses WHERE user_id = ?',
			userId
		),
		txLabels: all(
			`SELECT wallet_id, txid, label, created_at FROM tx_labels WHERE wallet_id ${inWallet}`,
			...ownedWalletIds
		),
		addressLabels: [
			...all(
				`SELECT wallet_kind, wallet_id, address, label, created_at FROM address_labels
				  WHERE wallet_kind = 'wallet' AND wallet_id ${inWallet}`,
				...ownedWalletIds
			),
			...all(
				`SELECT wallet_kind, wallet_id, address, label, created_at FROM address_labels
				  WHERE wallet_kind = 'multisig' AND wallet_id ${inMultisig}`,
				...ownedMultisigIds
			)
		],
		notificationPreferences: all(
			'SELECT event_type, channel, enabled, config FROM notification_preferences WHERE user_id = ?',
			userId
		),
		notificationChannels: all(
			'SELECT channel, config, verified_at, updated_at FROM notification_channel_config WHERE user_id = ?',
			userId
		).map((r) => {
			let cfg: Record<string, unknown> = {};
			try {
				cfg = JSON.parse(String(r.config)) as Record<string, unknown>;
			} catch {
				cfg = {};
			}
			return {
				channel: r.channel,
				// Same redaction as every API response: secrets → presence booleans.
				config: redactChannelConfig(r.channel as ConfigurableChannel, cfg),
				verifiedAt: r.verified_at,
				updatedAt: r.updated_at
			};
		}),
		activity: all(
			'SELECT type, level, message, detail, created_at FROM events WHERE user_id = ?',
			userId
		),
		contacts: all(
			`SELECT c.status, c.created_at, u.email AS contact_email
			   FROM contacts c JOIN users u ON u.id = c.contact_user_id
			  WHERE c.user_id = ?`,
			userId
		),
		agreementAcceptances: all(
			'SELECT version, accepted_at, ip FROM user_agreement_acceptances WHERE user_id = ?',
			userId
		),
		sessions: all(
			'SELECT created_at, expires_at, user_agent, ip_address FROM sessions WHERE user_id = ?',
			userId
		),
		knownDevices: all(
			'SELECT fingerprint, user_agent, first_seen, last_seen FROM known_devices WHERE user_id = ?',
			userId
		)
	};
}

// ------------------------------------------------------- sessions & devices

export interface UserSessionInfo {
	id: number;
	createdAt: string;
	expiresAt: string;
	/** Human label (browser + OS), derived server-side from the stored UA. */
	device: string;
	current: boolean;
}

export interface KnownDeviceInfo {
	fingerprint: string;
	device: string;
	firstSeen: string;
	lastSeen: string;
}

/** The caller's active sessions, newest first. The raw IP stays server-side —
 *  the page shows when/what, not where from (cairn-5u2i.4). */
export function listUserSessions(userId: number, currentSessionId: number | null): UserSessionInfo[] {
	const rows = all(
		`SELECT id, created_at, expires_at, user_agent FROM sessions
		  WHERE user_id = ? ORDER BY created_at DESC, id DESC`,
		userId
	) as { id: number; created_at: string; expires_at: string; user_agent: string | null }[];
	return rows.map((r) => ({
		id: r.id,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		device: r.user_agent ? describeUserAgent(r.user_agent) : 'Unknown device',
		current: r.id === currentSessionId
	}));
}

/** Revoke ONE of the caller's own sessions. Scoped by user_id in the DELETE
 *  itself, so a guessed foreign session id is a no-op (returns false). */
export function revokeUserSession(userId: number, sessionId: number): boolean {
	const res = db
		.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
		.run(sessionId, userId);
	return res.changes > 0;
}

/** The caller's remembered devices, most recently seen first. */
export function listKnownDevices(userId: number): KnownDeviceInfo[] {
	const rows = all(
		`SELECT fingerprint, user_agent, first_seen, last_seen FROM known_devices
		  WHERE user_id = ? ORDER BY last_seen DESC`,
		userId
	) as { fingerprint: string; user_agent: string | null; first_seen: string; last_seen: string }[];
	return rows.map((r) => ({
		fingerprint: r.fingerprint,
		device: r.user_agent ? describeUserAgent(r.user_agent) : 'Unknown device',
		firstSeen: r.first_seen,
		lastSeen: r.last_seen
	}));
}

/** Forget ONE of the caller's own known devices (its next sign-in reads as a
 *  new device again and re-fires the alert). Scoped like revokeUserSession. */
export function forgetKnownDevice(userId: number, fingerprint: string): boolean {
	const res = db
		.prepare('DELETE FROM known_devices WHERE user_id = ? AND fingerprint = ?')
		.run(userId, fingerprint);
	return res.changes > 0;
}
