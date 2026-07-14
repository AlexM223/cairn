export interface SignupFields {
	displayName: string;
	email: string;
	password: string;
	needsInvite: boolean;
	/** May be undefined when the page loads without an ?invite= link. */
	inviteCode?: string | null;
}

/** Display name cap, in grapheme clusters — mirrors the server-side
 *  DISPLAY_NAME_MAX in $lib/server/auth.ts (cairn-l04v). Duplicated here
 *  (rather than imported) because this file is bundled client-side and
 *  $lib/server modules cannot be imported from client code. */
export const DISPLAY_NAME_MAX = 60;

/** Count `value` in user-perceived characters ("grapheme clusters") rather
 *  than raw UTF-16 code units — same reasoning as the server-side
 *  graphemeLength() in $lib/server/textGuard.ts (cairn-vgbv). */
function graphemeLength(value: string): number {
	return Array.from(new Intl.Segmenter().segment(value)).length;
}

/**
 * Client-side pre-submit validation for the signup form. Returns a
 * plain-language error message for the first failing field, or null when
 * every field is acceptable.
 *
 * Extracted into a pure function so the required-field feedback can be unit
 * tested independently of the Svelte component (cairn-m06l): an all-empty
 * submit must always return a visible message rather than silently doing
 * nothing. Also hardens the invite-code branch against an undefined value
 * (data.invite is undefined when no ?invite= link is present), which would
 * otherwise throw on `.trim()` when an instance requires an invite.
 */
export function validateSignup(fields: SignupFields): string | null {
	if (!fields.displayName.trim()) return 'Enter a display name.';
	if (graphemeLength(fields.displayName.trim()) > DISPLAY_NAME_MAX)
		return `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`;
	if (!fields.email.trim()) return 'Enter your email address.';
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()))
		return 'Enter a valid email address.';
	if (fields.password.length < 8) return 'Password must be at least 8 characters.';
	if (fields.needsInvite && !(fields.inviteCode ?? '').trim())
		return 'This instance requires an invite code to join.';
	return null;
}
