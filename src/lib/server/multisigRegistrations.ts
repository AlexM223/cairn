// Ledger multisig-policy registrations: the per-device HMAC a Ledger returns
// after its one-time on-device review of a multisig's BIP-388 wallet policy
// (see src/lib/hw/ledger.ts registerMultisigPolicy). The HMAC is NOT a secret —
// the device only uses it to skip re-approving a policy it has already shown
// the user — but rows are still strictly ownership-scoped: every function
// takes the caller's locals.user.id and verifies the multisig belongs to them
// against the multisigs table directly (deliberately not via multisigs.ts, so this
// module stays a leaf with no service-layer coupling).
//
// One registration per device (master fingerprint) per multisig, enforced by the
// UNIQUE(multisig_id, master_fp) constraint; re-registering the same device
// upserts (a device wiped and re-seeded, or a renamed multisig, yields a fresh
// HMAC that must replace the stale one).

import { db } from './db';

export interface LedgerMultisigRegistration {
	id: number;
	multisigId: number;
	/** The device's master fingerprint, 8 lowercase hex chars. */
	masterFp: string;
	/** The exact policy name registered on-device (the HMAC covers it). */
	policyName: string;
	/** 64 hex chars (32 bytes) — pass to signMultisigPsbtWithLedger. */
	policyHmac: string;
	/** sha256 of the policy serialization, 64 hex chars; informational. */
	policyId: string | null;
	createdAt: string;
}

export class MultisigRegistrationError extends Error {
	code: 'multisig_not_found' | 'invalid_registration';

	constructor(message: string, code: 'multisig_not_found' | 'invalid_registration') {
		super(message);
		this.name = 'MultisigRegistrationError';
		this.code = code;
	}
}

interface Row {
	id: number;
	multisig_id: number;
	master_fp: string;
	policy_name: string;
	policy_hmac: string;
	policy_id: string | null;
	created_at: string;
}

const COLUMNS = 'id, multisig_id, master_fp, policy_name, policy_hmac, policy_id, created_at';

function toRegistration(row: Row): LedgerMultisigRegistration {
	return {
		id: row.id,
		multisigId: row.multisig_id,
		masterFp: row.master_fp,
		policyName: row.policy_name,
		policyHmac: row.policy_hmac,
		policyId: row.policy_id ?? null,
		createdAt: row.created_at
	};
}

/** Ownership gate: does this multisig exist AND belong to this user? Queried
 *  against the multisigs table directly (see the module comment). */
function ownsMultisig(userId: number, multisigId: number): boolean {
	if (!Number.isInteger(multisigId) || multisigId <= 0) return false;
	const row = db
		.prepare('SELECT 1 AS ok FROM multisigs WHERE id = ? AND user_id = ?')
		.get(multisigId, userId);
	return row !== undefined;
}

const FP_RE = /^[0-9a-fA-F]{8}$/;
const HMAC_RE = /^[0-9a-fA-F]{64}$/;
export const POLICY_NAME_MAX = 64; // the Ledger app's own limit

/**
 * The stored registration for one device (by master fingerprint), or null when
 * the multisig isn't the caller's, the fingerprint is malformed, or that device
 * has never registered this multisig.
 */
export function getLedgerRegistration(
	userId: number,
	multisigId: number,
	masterFp: string
): LedgerMultisigRegistration | null {
	const fp = String(masterFp ?? '').trim().toLowerCase();
	if (!FP_RE.test(fp)) return null;
	if (!Number.isInteger(multisigId) || multisigId <= 0) return null;
	const row = db
		.prepare(
			`SELECT r.id, r.multisig_id, r.master_fp, r.policy_name, r.policy_hmac, r.policy_id, r.created_at
			 FROM ledger_multisig_registrations r
			 JOIN multisigs v ON v.id = r.multisig_id
			 WHERE r.multisig_id = ? AND v.user_id = ? AND r.master_fp = ?`
		)
		.get(multisigId, userId, fp) as unknown as Row | undefined;
	return row ? toRegistration(row) : null;
}

/**
 * Every device registration for a multisig, oldest first. Null (not []) when the
 * multisig doesn't exist or isn't the caller's — the same not-found/empty split
 * listMultisigTransactions uses, so routes can 404 correctly.
 */
export function listLedgerRegistrations(
	userId: number,
	multisigId: number
): LedgerMultisigRegistration[] | null {
	if (!ownsMultisig(userId, multisigId)) return null;
	const rows = db
		.prepare(
			`SELECT ${COLUMNS} FROM ledger_multisig_registrations
			 WHERE multisig_id = ? ORDER BY created_at ASC, id ASC`
		)
		.all(multisigId) as unknown as Row[];
	return rows.map(toRegistration);
}

/**
 * Persist (or refresh) a device's registration. Upserts on (multisig_id,
 * master_fp): re-registering the same Ledger replaces the stored policy
 * name/HMAC — exactly what a device reset or multisig rename requires.
 *
 * Throws {@link MultisigRegistrationError}: `multisig_not_found` when the multisig
 * isn't the caller's, `invalid_registration` on malformed fields.
 */
export function saveLedgerRegistration(
	userId: number,
	multisigId: number,
	input: { masterFp?: unknown; policyName?: unknown; policyHmac?: unknown; policyId?: unknown }
): LedgerMultisigRegistration {
	if (!ownsMultisig(userId, multisigId)) {
		throw new MultisigRegistrationError('Multisig not found.', 'multisig_not_found');
	}

	const masterFp = String(input.masterFp ?? '').trim().toLowerCase();
	if (!FP_RE.test(masterFp) || masterFp === '00000000') {
		throw new MultisigRegistrationError(
			'The device fingerprint must be 8 hex characters (and not the 00000000 placeholder).',
			'invalid_registration'
		);
	}

	const policyName = String(input.policyName ?? '').trim();
	if (policyName.length < 1 || policyName.length > POLICY_NAME_MAX) {
		throw new MultisigRegistrationError(
			`The policy name must be 1–${POLICY_NAME_MAX} characters.`,
			'invalid_registration'
		);
	}

	const policyHmac = String(input.policyHmac ?? '').trim().toLowerCase();
	if (!HMAC_RE.test(policyHmac)) {
		throw new MultisigRegistrationError(
			'The registration HMAC must be 64 hex characters.',
			'invalid_registration'
		);
	}

	let policyId: string | null = null;
	if (input.policyId != null && String(input.policyId).trim() !== '') {
		policyId = String(input.policyId).trim().toLowerCase();
		if (!HMAC_RE.test(policyId)) {
			throw new MultisigRegistrationError(
				'The policy id must be 64 hex characters when provided.',
				'invalid_registration'
			);
		}
	}

	db.prepare(
		`INSERT INTO ledger_multisig_registrations (multisig_id, master_fp, policy_name, policy_hmac, policy_id)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (multisig_id, master_fp) DO UPDATE SET
		   policy_name = excluded.policy_name,
		   policy_hmac = excluded.policy_hmac,
		   policy_id   = excluded.policy_id`
	).run(multisigId, masterFp, policyName, policyHmac, policyId);

	const saved = getLedgerRegistration(userId, multisigId, masterFp);
	if (!saved) throw new Error('Ledger multisig registration insert failed');
	return saved;
}
