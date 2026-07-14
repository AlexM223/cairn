// Admin announcement/banner system (cairn-km01). Instance-wide messages —
// maintenance notices, warnings, promotions — that the admin writes once and
// every signed-in user sees as a banner. DISTINCT from the per-user events/
// notifications system (activity.ts): announcements are broadcast, not per-user.
//
// Body is PLAIN TEXT in v1 — no markdown/HTML rendering anywhere, so there is
// no XSS surface; the optional CTA link (link_url/link_text) covers the "link"
// use case. Dismissals mirror the backup-reminder pattern (per-user rows), with
// one twist: a NON-dismissible announcement ignores dismissal rows entirely, so
// an announcement that was dismissed while dismissible and later made
// non-dismissible (e.g. escalating maintenance notice) reappears for everyone.
//
// See db.ts (announcements / announcement_dismissals) and the feature flag
// `announcement_banners`, which gates both user rendering and the admin page.

import { db } from './db';
import { containsNulByte } from './textGuard';

export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'urgent', 'promotion'] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export interface Announcement {
	id: number;
	type: AnnouncementType;
	title: string;
	body: string;
	linkUrl: string | null;
	linkText: string | null;
	dismissible: boolean;
	active: boolean;
	/** ISO UTC timestamp after which the banner stops showing, or null = never. */
	expiresAt: string | null;
	displayOrder: number;
	createdAt: string;
	updatedAt: string;
}

/** What the admin CRUD writes. Everything a row has except timestamps/id. */
export interface AnnouncementInput {
	type: AnnouncementType;
	title: string;
	body: string;
	linkUrl?: string | null;
	linkText?: string | null;
	dismissible?: boolean;
	active?: boolean;
	expiresAt?: string | null;
	displayOrder?: number;
}

/** Invalid admin input (bad type, empty title, non-http(s) link, …). Actions
 *  catch this and surface e.message as a form error — it must stay friendly. */
export class AnnouncementValidationError extends Error {}

interface AnnouncementRow {
	id: number;
	type: string;
	title: string;
	body: string;
	link_url: string | null;
	link_text: string | null;
	dismissible: number;
	active: number;
	expires_at: string | null;
	display_order: number;
	created_at: string;
	updated_at: string;
}

function mapRow(row: AnnouncementRow): Announcement {
	return {
		id: row.id,
		type: row.type as AnnouncementType,
		title: row.title,
		body: row.body,
		linkUrl: row.link_url,
		linkText: row.link_text,
		dismissible: row.dismissible === 1,
		active: row.active === 1,
		expiresAt: row.expires_at,
		displayOrder: row.display_order,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

/** Character caps — a banner is a sentence or two, not a blog post. Generous
 *  enough for real maintenance notices, tight enough to keep the layout sane. */
const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_LINK_TEXT = 60;

/**
 * Validate + normalize admin input. Throws AnnouncementValidationError with a
 * user-facing message on anything off. Returns the row-shaped values to bind.
 *
 * Link safety: the CTA href is the ONE place admin input becomes a URL, so it
 * must be http(s) or a site-relative path starting with "/" — never
 * javascript:/data:/etc. Expiry is normalized to ISO UTC so SQL string
 * comparison against strftime('now') is correct regardless of the admin's
 * timezone (datetime-local inputs arrive zone-less).
 */
function normalizeInput(input: AnnouncementInput): {
	type: AnnouncementType;
	title: string;
	body: string;
	linkUrl: string | null;
	linkText: string | null;
	dismissible: number;
	active: number;
	expiresAt: string | null;
	displayOrder: number;
} {
	if (!ANNOUNCEMENT_TYPES.includes(input.type)) {
		throw new AnnouncementValidationError('Choose a valid announcement type.');
	}

	const title = (input.title ?? '').trim();
	if (!title) throw new AnnouncementValidationError('A title is required.');
	if (title.length > MAX_TITLE) {
		throw new AnnouncementValidationError(`Keep the title under ${MAX_TITLE} characters.`);
	}
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// title at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(title)) {
		throw new AnnouncementValidationError(
			'The title contains a NUL character (U+0000), which cannot be stored.'
		);
	}

	const body = (input.body ?? '').trim();
	if (!body) throw new AnnouncementValidationError('A message is required.');
	if (body.length > MAX_BODY) {
		throw new AnnouncementValidationError(`Keep the message under ${MAX_BODY} characters.`);
	}
	if (containsNulByte(body)) {
		throw new AnnouncementValidationError(
			'The message contains a NUL character (U+0000), which cannot be stored.'
		);
	}

	let linkUrl = (input.linkUrl ?? '').trim() || null;
	if (linkUrl && !linkUrl.startsWith('/')) {
		let parsed: URL;
		try {
			parsed = new URL(linkUrl);
		} catch {
			throw new AnnouncementValidationError(
				'The link must be a full http(s) address or a path starting with "/".'
			);
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new AnnouncementValidationError('The link must use http or https.');
		}
	}
	// Link text without a link is meaningless — normalize it away.
	let linkText = (input.linkText ?? '').trim() || null;
	if (!linkUrl) linkText = null;
	if (linkText && linkText.length > MAX_LINK_TEXT) {
		throw new AnnouncementValidationError(`Keep the link text under ${MAX_LINK_TEXT} characters.`);
	}
	if (linkText && containsNulByte(linkText)) {
		throw new AnnouncementValidationError(
			'The link text contains a NUL character (U+0000), which cannot be stored.'
		);
	}

	let expiresAt: string | null = null;
	if (input.expiresAt) {
		const ms = Date.parse(input.expiresAt);
		if (Number.isNaN(ms)) {
			throw new AnnouncementValidationError("That expiry date doesn't look valid.");
		}
		expiresAt = new Date(ms).toISOString();
	}

	const displayOrder = input.displayOrder ?? 0;
	if (!Number.isInteger(displayOrder)) {
		throw new AnnouncementValidationError('Display order must be a whole number.');
	}

	return {
		type: input.type,
		title,
		body,
		linkUrl,
		linkText,
		dismissible: (input.dismissible ?? true) ? 1 : 0,
		active: (input.active ?? true) ? 1 : 0,
		expiresAt,
		displayOrder
	};
}

// ------------------------------------------------------------- admin CRUD

/** Every announcement, current or not, in the order users would see them —
 *  the admin list view (which labels inactive/expired itself). */
export function listAnnouncements(): Announcement[] {
	const rows = db
		.prepare('SELECT * FROM announcements ORDER BY display_order ASC, id ASC')
		.all() as unknown as AnnouncementRow[];
	return rows.map(mapRow);
}

/** One announcement by id, or null. */
export function getAnnouncement(id: number): Announcement | null {
	const row = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id) as
		| AnnouncementRow
		| undefined;
	return row ? mapRow(row) : null;
}

/** Create an announcement. Throws AnnouncementValidationError on bad input. */
export function createAnnouncement(input: AnnouncementInput): Announcement {
	const v = normalizeInput(input);
	const info = db
		.prepare(
			`INSERT INTO announcements
			   (type, title, body, link_url, link_text, dismissible, active, expires_at, display_order)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			v.type,
			v.title,
			v.body,
			v.linkUrl,
			v.linkText,
			v.dismissible,
			v.active,
			v.expiresAt,
			v.displayOrder
		);
	return getAnnouncement(Number(info.lastInsertRowid))!;
}

/** Full-row update (the admin editor always posts every field). Returns the
 *  updated announcement, or null if the id doesn't exist. Existing dismissal
 *  rows are deliberately KEPT — editing a typo shouldn't re-show a banner to
 *  everyone who already dismissed it; toggling `dismissible` off is the lever
 *  for "everyone must see this again". */
export function updateAnnouncement(id: number, input: AnnouncementInput): Announcement | null {
	const v = normalizeInput(input);
	const info = db
		.prepare(
			`UPDATE announcements SET
			   type = ?, title = ?, body = ?, link_url = ?, link_text = ?,
			   dismissible = ?, active = ?, expires_at = ?, display_order = ?,
			   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ?`
		)
		.run(
			v.type,
			v.title,
			v.body,
			v.linkUrl,
			v.linkText,
			v.dismissible,
			v.active,
			v.expiresAt,
			v.displayOrder,
			id
		);
	if (info.changes === 0) return null;
	return getAnnouncement(id);
}

/** Flip just active on/off (the list view's quick toggle). Returns false when
 *  the id doesn't exist. */
export function setAnnouncementActive(id: number, active: boolean): boolean {
	const info = db
		.prepare(
			`UPDATE announcements SET active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ?`
		)
		.run(active ? 1 : 0, id);
	return info.changes > 0;
}

/** Delete an announcement (dismissal rows cascade). Returns false if absent. */
export function deleteAnnouncement(id: number): boolean {
	const info = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
	return info.changes > 0;
}

// ------------------------------------------------------- user-facing reads

/**
 * The announcements to render for one signed-in user: active, not expired,
 * ordered by display_order then id — minus the ones THIS user dismissed.
 *
 * Non-dismissible announcements ignore dismissal state entirely: a stale
 * dismissal row (from before the admin flipped dismissible off) must not hide
 * a banner the admin now wants everyone to see.
 */
export function listActiveAnnouncementsFor(userId: number): Announcement[] {
	const rows = db
		.prepare(
			`SELECT a.* FROM announcements a
			 WHERE a.active = 1
			   AND (a.expires_at IS NULL OR a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			   AND (
			     a.dismissible = 0
			     OR NOT EXISTS (
			       SELECT 1 FROM announcement_dismissals d
			       WHERE d.user_id = ? AND d.announcement_id = a.id
			     )
			   )
			 ORDER BY a.display_order ASC, a.id ASC`
		)
		.all(userId) as unknown as AnnouncementRow[];
	return rows.map(mapRow);
}

export type DismissResult = 'dismissed' | 'not_found' | 'not_dismissible';

/**
 * Record that a user dismissed an announcement. Idempotent (upsert; repeat
 * dismissals just refresh the timestamp).
 *
 * Chosen semantics for non-dismissible announcements: the dismissal is
 * REFUSED — no row is written and 'not_dismissible' is returned, which the
 * API route turns into a 409. Refusing (rather than recording-but-ignoring)
 * keeps the table an honest record of dismissals that actually took effect.
 */
export function dismissAnnouncement(userId: number, announcementId: number): DismissResult {
	const row = db
		.prepare('SELECT dismissible FROM announcements WHERE id = ?')
		.get(announcementId) as { dismissible: number } | undefined;
	if (!row) return 'not_found';
	if (row.dismissible !== 1) return 'not_dismissible';

	db.prepare(
		`INSERT INTO announcement_dismissals (user_id, announcement_id) VALUES (?, ?)
		 ON CONFLICT (user_id, announcement_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`
	).run(userId, announcementId);
	return 'dismissed';
}
