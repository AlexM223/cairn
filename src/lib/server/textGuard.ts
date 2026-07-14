// Shared free-text input guards for user-writable string fields.
//
// node:sqlite binds a JS string to a TEXT column as a NUL-terminated C-string,
// so an embedded NUL byte (U+0000) silently truncates everything after it at
// STORAGE time — "abc\0def" is written and read back as "abc", with no error
// anywhere in the call chain. That is silent data loss: a user who pastes a NUL
// (a botched copy-paste, a QR mis-scan, or a deliberate attempt to truncate what
// a cosigner/admin later sees) gets an unexpectedly shortened value and no
// indication anything was dropped. The single shared cause gets a single shared
// screen (cairn-y73r): every free-text write path should run its input through
// `containsNulByte`/`assertNoNulByte` BEFORE persisting, and reject rather than
// silently truncate. Callers that already throw a typed domain error map the
// predicate to their own error; callers without one can throw TextInputError.

/** The NUL byte (U+0000) — the one character node:sqlite cannot store in a TEXT
 *  column without silently truncating the string at it. */
const NUL = String.fromCharCode(0);

/** True when `value` contains a NUL byte (U+0000). */
export function containsNulByte(value: string): boolean {
	return value.includes(NUL);
}

/** Error thrown by {@link assertNoNulByte} for callers that don't already carry
 *  a typed domain error of their own. */
export class TextInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TextInputError';
	}
}

/**
 * Throw {@link TextInputError} when `value` contains a NUL byte. `fieldLabel`
 * names the field in the message (e.g. "Wallet name"). Callers that raise a
 * typed domain error (MultisigError, AddressBookError, …) should instead branch
 * on {@link containsNulByte} and throw their own error, so the failure carries
 * the code the rest of that module's callers expect.
 */
export function assertNoNulByte(value: string, fieldLabel = 'This field'): void {
	if (containsNulByte(value)) {
		throw new TextInputError(
			`${fieldLabel} contains a NUL character (U+0000), which cannot be stored. Remove it and try again.`
		);
	}
}

/**
 * Cap `value` at `maxLen` UTF-16 code units — same shape as `value.slice(0,
 * maxLen)` — but never leave a lone (unpaired) surrogate dangling at the cut
 * point (cairn-qmx8). A plain `.slice()` cares nothing about surrogate-pair
 * boundaries: an astral-plane character (emoji, many CJK extension-B/etc.
 * glyphs) is TWO UTF-16 code units, and a cut landing between them keeps only
 * the lone high surrogate — invalid UTF-16 that node:sqlite's UTF-8-at-rest
 * TEXT storage cannot represent, so it silently round-trips back as U+FFFD
 * (the replacement character) instead of the original glyph, and with no
 * error raised anywhere. Dropping the dangling high surrogate instead keeps
 * the result one code unit shorter than the cap, but always valid UTF-16.
 */
export function truncateUtf16Safe(value: string, maxLen: number): string {
	const sliced = value.slice(0, maxLen);
	const lastCode = sliced.length > 0 ? sliced.charCodeAt(sliced.length - 1) : NaN;
	// High surrogates are 0xD800–0xDBFF; a lone one at the very end (with no
	// low surrogate following, because that's exactly what got cut off) means
	// the cap split a surrogate pair in half.
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) return sliced.slice(0, -1);
	return sliced;
}

/**
 * Count `value` in user-perceived characters ("grapheme clusters") rather
 * than raw UTF-16 code units (cairn-vgbv). A plain `string.length` counts
 * code UNITS: an astral-plane character (most emoji) is 2, and a ZWJ
 * sequence like a "family" emoji — several codepoints joined by U+200D into
 * one visible glyph — is 7+. A "60-character" cap built on `.length` rejects
 * a name of just a handful of visible emoji as "too long" while accepting 60
 * plain ASCII letters, the same perceived length to whoever typed it.
 * Intl.Segmenter's grapheme granularity is exactly "how many things a user
 * would count by pointing at the string," so it tracks the human-visible
 * length regardless of script or how many UTF-16 units a glyph costs.
 */
export function graphemeLength(value: string): number {
	return Array.from(new Intl.Segmenter().segment(value)).length;
}
