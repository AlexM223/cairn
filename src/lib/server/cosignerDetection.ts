// Auto cosigner detection on multisig import (cairn-jaev).
//
// When a user imports a multisig config (Caravan JSON, descriptor, ColdCard
// file), one of its cosigner keys may be a key an EXISTING CONTACT of theirs
// already holds — the on-platform collaborative-custody case. Surfacing that
// ("a key in this wallet may belong to <contact> — invite them?") smooths
// onboarding a pre-existing multisig.
//
// Anti-enumeration posture (mirrors contacts.ts): we ONLY match against the
// importer's ACCEPTED contacts, never all instance users. Matching a stranger's
// fingerprint and revealing who they are would let an importer enumerate which
// fingerprints/identities exist on the instance. A contact is someone the user
// already knows and can already see, so surfacing a match there leaks nothing
// new. Matching is by FINGERPRINT ONLY, not full xpub: one master seed produces
// different xpubs at different derivation paths, so a fingerprint match is the
// right (and only reliable) signal that "this might be their key". The result is
// a non-committing suggestion — it never auto-shares; the user still has to
// invite/share explicitly through the existing contact-scoped share flow.

import { db } from './db';
import { canonicalXpub } from './bitcoin/multisig';

/** The unknown-fingerprint sentinel (see db.ts multisig_keys) — never matched. */
const UNKNOWN_FINGERPRINT = '00000000';

export interface CosignerMatch {
	/** The cosigner-key fingerprint (8 lowercase hex) that matched. */
	fingerprint: string;
	/** The contact who already holds a key with this fingerprint. */
	contactUserId: number;
	displayName: string;
	email: string;
}

/**
 * For the given cosigner fingerprints, return which of the importer's accepted
 * contacts already hold a key (single-sig wallet OR multisig cosigner key) with a
 * matching fingerprint. Empty when nothing matches — including when the importer
 * has no contacts, which is the common case. Never throws; a DB hiccup yields [].
 */
export function detectCosignerContacts(
	userId: number,
	fingerprints: string[]
): CosignerMatch[] {
	// Normalize + drop the unknown sentinel and blanks; dedupe.
	const fps = [
		...new Set(
			fingerprints
				.map((f) => String(f ?? '').trim().toLowerCase())
				.filter((f) => /^[0-9a-f]{8}$/.test(f) && f !== UNKNOWN_FINGERPRINT)
		)
	];
	if (fps.length === 0) return [];

	try {
		// Accepted contacts of this user, mapped to the "other" side's id + identity.
		const contacts = db
			.prepare(
				`SELECT CASE WHEN c.user_id = ? THEN c.contact_user_id ELSE c.user_id END AS other_id,
				        u.display_name AS display_name, u.email AS email
				 FROM contacts c
				 JOIN users u ON u.id = CASE WHEN c.user_id = ? THEN c.contact_user_id ELSE c.user_id END
				 WHERE c.status = 'accepted' AND (c.user_id = ? OR c.contact_user_id = ?)`
			)
			.all(userId, userId, userId, userId) as {
			other_id: number;
			display_name: string;
			email: string;
		}[];
		if (contacts.length === 0) return [];

		const contactById = new Map(contacts.map((c) => [c.other_id, c]));
		const contactIds = [...contactById.keys()];

		const fpPlaceholders = fps.map(() => '?').join(',');
		const idPlaceholders = contactIds.map(() => '?').join(',');

		// Every (user_id, fingerprint) a contact holds that matches — from BOTH their
		// single-sig wallets (master_fingerprint) and their multisig cosigner keys.
		const rows = db
			.prepare(
				`SELECT user_id, LOWER(fp) AS fp FROM (
					SELECT w.user_id AS user_id, w.master_fingerprint AS fp
					  FROM wallets w
					 WHERE w.user_id IN (${idPlaceholders}) AND LOWER(w.master_fingerprint) IN (${fpPlaceholders})
					UNION
					SELECT m.user_id AS user_id, k.fingerprint AS fp
					  FROM multisig_keys k
					  JOIN multisigs m ON m.id = k.multisig_id
					 WHERE m.user_id IN (${idPlaceholders}) AND LOWER(k.fingerprint) IN (${fpPlaceholders})
				)`
			)
			.all(...contactIds, ...fps, ...contactIds, ...fps) as { user_id: number; fp: string }[];

		// Dedupe to one suggestion per (fingerprint, contact).
		const seen = new Set<string>();
		const out: CosignerMatch[] = [];
		for (const r of rows) {
			const contact = contactById.get(r.user_id);
			if (!contact) continue;
			const key = `${r.fp}:${r.user_id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				fingerprint: r.fp,
				contactUserId: r.user_id,
				displayName: contact.display_name,
				email: contact.email
			});
		}
		return out;
	} catch {
		return []; // detection is a convenience — never break an import over it
	}
}

// ------------------------------------------- cross-wallet xpub reuse (cairn-1kc3.4)

/** One place a to-be-added cosigner xpub is ALREADY stored for the same user. */
export interface XpubReuseMatch {
	/** Canonical form of the xpub that is already stored elsewhere. */
	xpub: string;
	/** Where it already lives: a single-sig wallet or another multisig. */
	kind: 'wallet' | 'multisig';
	walletId: number;
	walletName: string;
}

/**
 * Detect when a key offered for a new multisig is already committed elsewhere
 * for the SAME user — as a single-sig wallet's xpub or as a cosigner key in
 * another multisig (cairn-1kc3.4). Nothing in the schema stops this (both
 * UNIQUE constraints are scoped to one wallet), and reusing one account key
 * across derivation contexts is exactly the cross-contamination BIP-48 path
 * separation exists to prevent tooling from silently accepting.
 *
 * Comparison is on CANONICAL xpubs, so a SLIP-132 Ypub/Zpub alias of a stored
 * key still matches. Own-user data only — no enumeration surface. The result
 * is a non-blocking warning (reuse can be deliberate, e.g. watching one key
 * two ways) but must never be silent. Never throws; a DB hiccup yields [].
 */
export function detectXpubReuse(userId: number, xpubs: string[]): XpubReuseMatch[] {
	const wanted = new Set(
		xpubs.map((x) => canonicalXpub(x)).filter((x): x is string => x !== null)
	);
	if (wanted.size === 0) return [];

	try {
		const out: XpubReuseMatch[] = [];
		const seen = new Set<string>();
		const collect = (
			rows: { id: number; name: string; xpub: string }[],
			kind: XpubReuseMatch['kind']
		) => {
			for (const row of rows) {
				const canon = canonicalXpub(row.xpub);
				if (!canon || !wanted.has(canon)) continue;
				const dedupe = `${kind}:${row.id}:${canon}`;
				if (seen.has(dedupe)) continue;
				seen.add(dedupe);
				out.push({ xpub: canon, kind, walletId: row.id, walletName: row.name });
			}
		};

		collect(
			db.prepare('SELECT id, name, xpub FROM wallets WHERE user_id = ?').all(userId) as {
				id: number;
				name: string;
				xpub: string;
			}[],
			'wallet'
		);
		collect(
			db
				.prepare(
					`SELECT m.id AS id, m.name AS name, k.xpub AS xpub
					 FROM multisig_keys k
					 JOIN multisigs m ON m.id = k.multisig_id
					 WHERE m.user_id = ?`
				)
				.all(userId) as { id: number; name: string; xpub: string }[],
			'multisig'
		);
		return out;
	} catch {
		return []; // a warning helper must never break wallet creation
	}
}
