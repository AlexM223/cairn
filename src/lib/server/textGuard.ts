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
