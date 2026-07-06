// Dual-layer legal disclosure: the operator's one-time infrastructure
// acknowledgement, and a per-user clickwrap agreement whose text the operator
// customizes. Enforcement is a gate in (app)/+layout.server.ts; the acceptance
// screens live at top-level /disclosure and /agreement.
//
// Storage: acceptances in their own tables (see db.ts); the editable agreement
// text, operator name, and current version live in `settings` (key-value).

import { db } from './db';
import { getSetting, setSetting } from './settings';

const K_TEXT = 'user_agreement_text';
const K_OPERATOR = 'user_agreement_operator';
const K_VERSION = 'user_agreement_version';

/** Fallback operator name until the admin sets one. */
export const DEFAULT_OPERATOR = 'the operator of this Cairn instance';

/**
 * Default user agreement — direct, covers the real risks, not lawyer-speak
 * (BlueWallet-style tone). The operator name is shown separately above this
 * body, so the text refers to "the operator" generically and stays valid even
 * if the admin renames themselves.
 */
export const DEFAULT_USER_AGREEMENT = `By using this Cairn instance, you agree to the following.

NOT A CUSTODIAN. This service never holds your private keys or your bitcoin. Your keys stay on your own devices — hardware wallets, signing apps, or backups you control. Neither the operator of this instance nor the Cairn software can move, freeze, or recover your funds.

YOUR BACKUPS ARE YOUR RESPONSIBILITY. This server stores your wallet configuration — your public keys, labels, and settings — so it can show balances and help you build transactions. It does NOT store anything that can spend. You must keep your own backups: your seed phrases, and for a multisig wallet, every public key and the wallet descriptor. Download your wallet backup files and store them somewhere safe. If you lose them and this server becomes unavailable, you may permanently lose access to your funds.

TRANSACTIONS ARE IRREVERSIBLE. Once you sign and broadcast a transaction it cannot be undone, cancelled, or refunded. Always verify the destination address and the amount on your own device before you approve.

THE OPERATOR IS NOT RESPONSIBLE FOR YOUR FUNDS. This instance is run by an individual or organization providing infrastructure — not a bank, exchange, or financial service. The operator is not responsible for lost keys, lost backups, lost funds, mistaken transactions, or any financial loss. The operator does not guarantee the service will be available and may take it offline at any time.

WHAT THIS SERVER LOGS, AND WHO CAN SEE IT. To operate, this server keeps records on the server itself: your account email; the IP address you sign in from and the one you accept this agreement from; an activity feed of wallet events (transactions detected, broadcasts, scans); delivery records for any notification channels you set up; and operational server logs. Every administrator of this instance — not only the operator — can view the server logs and the cross-user activity log, and can generate a full-instance backup that includes every user's wallet configuration: public keys, addresses, labels, and address book. None of this ever includes private keys or anything that can spend your funds. Old records are cleaned up automatically: expired sessions are deleted, delivered notifications are purged after 30 days, and balance history is thinned after 30 days and removed after roughly 13 months. If you are not comfortable with the operator and admins of this instance seeing this information, do not use this instance.

NO FINANCIAL ADVICE. Nothing here is investment, financial, legal, or tax advice.

YOU ACCEPT ALL RISK. You alone are responsible for the security of your keys and backups, for verifying every transaction, and for any loss that results. If you do not agree, do not use this service.`;

/**
 * Version of DEFAULT_USER_AGREEMENT itself. Bump this alongside any edit to the
 * default text above so instances still running the stock agreement re-prompt
 * their users (see ensureDefaultAgreementVersion). History:
 *   1 — original custody/liability text
 *   2 — added the "What this server logs" data-handling section (cairn-5u2i.1)
 */
export const DEFAULT_AGREEMENT_VERSION = 2;

/**
 * The operator-facing disclosure, shown once during first-run before the admin
 * can do anything else. Fixed text (not customizable) — it protects the Cairn
 * project and sets the operator's expectations. Rendered on /disclosure.
 */
export const ADMIN_DISCLOSURE = `You are setting up Bitcoin infrastructure.

Cairn is software you run yourself. By operating this instance you are providing infrastructure — not custody, and not a financial service.

YOU NEVER HOLD KEYS OR FUNDS. Cairn stores only public keys and wallet configuration. It cannot spend, and neither can you on your users' behalf. Your users' private keys stay on their own devices.

YOU ARE RESPONSIBLE FOR THIS SERVER. Keeping it running, securing it, backing up its data, and communicating downtime or data loss to your users is on you. If this server's data is lost and a user has not kept their own backup, they may permanently lose access to their funds.

YOU ARE RESPONSIBLE FOR YOUR USERS. If you invite others onto this instance, you are the operator they rely on. You should establish your own terms of service with them — Cairn gives you a customizable user agreement to start from, which you can edit in Settings.

THE CAIRN SOFTWARE IS PROVIDED AS-IS. It comes with no warranty of any kind. The Cairn project and its contributors are not a party to your instance and are not responsible for any claim a user makes against you, for any loss of funds, or for how you operate this server.`;

export interface UserAgreement {
	text: string;
	operator: string;
	version: number;
}

/** The current user agreement — stored values, falling back to the defaults. */
export function getUserAgreement(): UserAgreement {
	const text = getSetting(K_TEXT) ?? DEFAULT_USER_AGREEMENT;
	const operator = getSetting(K_OPERATOR) ?? DEFAULT_OPERATOR;
	const version = Number(getSetting(K_VERSION) ?? '1') || 1;
	return { text, operator, version };
}

/**
 * Startup migration (called from hooks.server.ts): an instance still on the
 * STOCK agreement (no customized text saved) picks up edits to
 * DEFAULT_USER_AGREEMENT automatically — but the stored version must bump too,
 * or users who accepted the old default would never be re-prompted. A
 * customized agreement is left entirely alone: its operator's own edits drive
 * the version via setUserAgreement.
 */
export function ensureDefaultAgreementVersion(): void {
	if (getSetting(K_TEXT) !== null) return;
	const stored = Number(getSetting(K_VERSION) ?? '1') || 1;
	if (stored < DEFAULT_AGREEMENT_VERSION) {
		setSetting(K_VERSION, String(DEFAULT_AGREEMENT_VERSION));
	}
}

/**
 * Save the agreement. Bumps the version whenever the text OR the operator name
 * actually changes, so a substantive edit forces every user to re-accept on
 * their next visit. A no-op save leaves the version (and everyone's acceptance)
 * untouched. Returns the new state.
 */
export function setUserAgreement(input: { text: string; operator: string }): UserAgreement {
	const current = getUserAgreement();
	const text = input.text.trim() || DEFAULT_USER_AGREEMENT;
	const operator = input.operator.trim() || DEFAULT_OPERATOR;
	const changed = text !== current.text || operator !== current.operator;
	const version = changed ? current.version + 1 : current.version;

	setSetting(K_TEXT, text);
	setSetting(K_OPERATOR, operator);
	setSetting(K_VERSION, String(version));
	return { text, operator, version };
}

// ------------------------------------------------------------- admin disclosure

export function hasAcceptedAdminDisclosure(userId: number): boolean {
	return !!db
		.prepare('SELECT 1 FROM admin_disclosure_acceptances WHERE user_id = ?')
		.get(userId);
}

export function recordAdminDisclosure(userId: number): void {
	db.prepare(
		`INSERT INTO admin_disclosure_acceptances (user_id) VALUES (?)
		 ON CONFLICT (user_id) DO NOTHING`
	).run(userId);
}

// -------------------------------------------------------------- user agreement

/** The highest agreement version this user has accepted (0 = never). */
export function acceptedAgreementVersion(userId: number): number {
	const row = db
		.prepare(
			'SELECT MAX(version) AS v FROM user_agreement_acceptances WHERE user_id = ?'
		)
		.get(userId) as { v: number | null };
	return row.v ?? 0;
}

/** Has the user accepted the CURRENT agreement version? */
export function hasAcceptedCurrentAgreement(userId: number): boolean {
	return acceptedAgreementVersion(userId) >= getUserAgreement().version;
}

/** Record acceptance of the current version (with best-effort client IP). */
export function recordUserAgreement(userId: number, ip: string | null): number {
	const version = getUserAgreement().version;
	db.prepare(
		`INSERT INTO user_agreement_acceptances (user_id, version, ip) VALUES (?, ?, ?)
		 ON CONFLICT (user_id, version) DO NOTHING`
	).run(userId, version, ip);
	return version;
}
