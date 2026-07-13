// Copy for the key-check result UI (MULTISIG-KEY-AUDIT-DESIGN §2), pulled out
// as named constants so the mandated wording is unit-testable and can't
// silently drift when the surrounding template is edited. Wave 1 consumes
// these from KeyHealthRow.svelte (post-creation); Wave 2's wizard verify
// block is expected to reuse the same strings (a shared result presentation,
// per the design's §7 note).

/** MATCH result headline — design: "prominent green confirmation". */
export const KEY_MATCH_HEADLINE = "This key matches — you're good.";

// NO-MATCH (fingerprint differs): explain BOTH causes plainly and equally —
// a wrong seed, or a BIP39 passphrase deriving an entirely different tree.
// Fingerprint alone can't distinguish the two, so both are always shown together.
export const WRONG_SEED_HEADLINE = 'Wrong seed phrase.';
export const WRONG_SEED_BODY =
	'This device (or the key you pasted) is set up with a different seed than the one used to ' +
	'create this wallet — a reset, a restore from a different backup, or simply the wrong device.';

export const PASSPHRASE_CAUSE_HEADLINE = 'A BIP39 passphrase is switched on.';
export const PASSPHRASE_CAUSE_BODY =
	'The "passphrase" feature (sometimes called the "25th word" or a "hidden wallet") makes a ' +
	'device derive a completely different set of keys from the very same seed. If this key was ' +
	'originally added with a passphrase, try again with the exact same passphrase entered.';

/**
 * PROMINENT loss-of-funds passphrase warning — EXACT mandated wording
 * (MULTISIG-KEY-AUDIT-DESIGN §2 / task spec). Never paraphrase this string;
 * keyCheckCopy.test.ts pins it verbatim.
 */
export const PASSPHRASE_LOSS_WARNING =
	'Using a passphrase creates a single point of failure. If you forget it, you could permanently ' +
	'lose access to your funds.';

/** Plain statement that passphrase + multisig is not a recommended combination. */
export const PASSPHRASE_NOT_RECOMMENDED = 'Using a passphrase with multisig is not recommended.';

/**
 * PROACTIVE passphrase caution — shown while ADDING a cosigner key, before any
 * mismatch has happened (MULTISIG-KEY-AUDIT-DESIGN §4). Lighter than the
 * loss-of-funds warning above: a one-line nudge to keep the anti-pattern
 * visible up front, in the creation wizard's add-key sub-wizard, rather than
 * only after someone has already locked themselves out.
 */
export const PROACTIVE_PASSPHRASE_NOTE =
	"If this device uses a BIP39 passphrase, make sure it's the same one every time you connect it " +
	'— a passphrase with multisig is an easy way to lock yourself out, since it derives a completely ' +
	'different set of keys.';

/**
 * Neutral (non-alarming) note shown alongside a MATCH result when the stored
 * key never had a real fingerprint on record — added as a bare xpub with no
 * [fingerprint/path] origin (cairn-9p6z). The xpub still matched, which is a
 * genuine verification, but the fingerprint half of the check was skipped
 * rather than passed, so this is deliberately lower-key than
 * KEY_MATCH_HEADLINE — a nudge, not a warning.
 */
export const NO_FINGERPRINT_ON_RECORD_NOTE =
	'This key had no fingerprint on record, so only its public key could be checked — consider ' +
	"re-adding it with its origin info (e.g. [a1b2c3d4/48'/0'/0'/2']xpub…) for a fuller check next time.";
