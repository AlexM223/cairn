// cairn-nohi — hostile-input sweep across user-writable, wallet-scoped and
// contact-scoped free-text fields, feeding the REAL service functions (not
// mocked): createWallet/setLabel (wallets.ts), createMultisig
// (wallets/multisig.ts), setAddressLabel (addressLabels.ts), saveAddress
// (addressBook.ts), and registerUser's displayName (auth.ts), which surfaces
// through contacts.ts's ContactSummary.
//
// The admin-surface half of cairn-nohi (announcements, operator name) was
// already swept live against a real Umbrel instance — see the bead comment
// dated 2026-07-12 — and came back CLEAN (Svelte auto-escaping holds,
// node:sqlite is parameterized). This file is the wallet/contact-scoped half
// the bead's coverage note flagged as still open, run against the same
// hostile payload set, at the service-function layer.
//
// Convention for a real defect/gap found here: pin it under a
// "KNOWN GAP (candidate bead)" describe block with an expected-vs-actual
// comment, per src/lib/server/bitcoin/sendBoundaryMatrix.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { db } from './db';
import { registerUser, AuthError } from './auth';
import { setSetting } from './settings';
import { createWallet, setLabel, TX_LABEL_MAX } from './wallets';
import { createMultisig } from './wallets/multisig';
import { MultisigError } from './bitcoin/multisig';
import { setAddressLabel, getAddressLabels, ADDRESS_LABEL_MAX as WALLET_LABEL_MAX } from './addressLabels';
import { saveAddress, AddressBookError, ADDRESS_LABEL_MAX as BOOK_LABEL_MAX } from './addressBook';
import { requestContact, respondToContact, listContacts } from './contacts';
import { TextInputError } from './textGuard';
import { setUserAgreement } from './disclosures';
import { createAnnouncement, AnnouncementValidationError } from './announcements';
import { createApiToken, ApiTokenError } from './apiTokens';
import { createInvites } from './admin';
import { createMultisigServiceReferral, ReferralValidationError } from './referrals';

// A real BIP84 doc-vector zpub (same fixture bitcoin/sendBoundaryMatrix.test.ts
// uses) — createWallet round-trips through the REAL parseXpub, so a syntactic
// placeholder string is rejected before the hostile name is ever exercised.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

// Real BIP-48 signer keys for createMultisig — it derives a real test address
// (multisigTestAddress) during creation, so fake/placeholder xpub strings
// throw before the hostile NAME is ever reached. Mirrors makeSigner() in
// bitcoin/sendBoundaryMatrix.test.ts.
const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	const fingerprint = (master.fingerprint >>> 0).toString(16).padStart(8, '0');
	return { xpub: account.publicExtendedKey, fingerprint, path: BIP48_PATH };
}
function makeMultisigKeys() {
	return [1, 2, 3].map((seed, i) => ({
		name: `Key ${i + 1}`,
		category: 'hardware' as const,
		...makeSigner(seed)
	}));
}

function wipe(): void {
	db.exec(
		'DELETE FROM address_labels; DELETE FROM tx_labels; DELETE FROM saved_addresses; ' +
			'DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; ' +
			'DELETE FROM contacts; DELETE FROM wallets; DELETE FROM events; DELETE FROM sessions; ' +
			'DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

// ── hostile payload set ─────────────────────────────────────────────────────

const EMOJI_ZWJ = '👨‍👩‍👧‍👦'; // family emoji, a ZWJ sequence of 4 codepoints/7 code units
const RTL_OVERRIDE = '‮evil‬.txt'; // U+202E RIGHT-TO-LEFT OVERRIDE ... U+202C POP
const ZERO_WIDTH = 'a​b‌c‍d'; // ZWSP, ZWNJ, ZWJ interleaved with ascii
const ZALGO = 'Z̸̧̡̛̯̜̫̈́̀͑͘a̷̡̢̛̛̜̯̘͊̊͌́l̶̰̊̌͝g̸̜͐̈ǒ̷̳̼'; // heavy combining marks
const TEN_K = 'x'.repeat(10_000);
const NULL_BYTE = 'abc\x00def';
const CRLF = 'line one\r\nline two\nline three';
const XSS_SCRIPT = "<script>alert('XSSbody')</script>";
const XSS_IMG = '<img src=x onerror=alert(1)>';
const SQLI_DROP = "'; DROP TABLE wallets;--";
const SQLI_OR = '" OR 1=1--';
const CJK = '你好世界';
const ACCENTED = 'café Übermensch';

// NUL is deliberately EXCLUDED from the byte-identical round-trip set: as
// found below, every text field truncates at an embedded NUL (a node:sqlite /
// C-string binding behavior, not per-field logic) — see the dedicated
// "KNOWN GAP: embedded NUL truncates stored text" section instead.
const HOSTILE_SHORT = [
	EMOJI_ZWJ,
	RTL_OVERRIDE,
	ZERO_WIDTH,
	ZALGO,
	CRLF,
	XSS_SCRIPT,
	XSS_IMG,
	SQLI_DROP,
	SQLI_OR,
	CJK,
	ACCENTED
];

/** Row counts for tables an injection attempt must never disturb. */
function tableCounts() {
	const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
	return { users: n('users'), wallets: n('wallets'), sessions: n('sessions'), settings: n('settings') };
}

// ── wallet name (createWallet, wallets.ts — trims + slice(0, 64), never rejects) ─

describe('hostile input: wallet name (createWallet)', () => {
	it.each(HOSTILE_SHORT)('accepts %j without crashing and round-trips it verbatim (under the 64 cap)', async (payload) => {
		const user = await makeUser('owner@example.com');
		const before = tableCounts();
		const summary = createWallet(user.id, { name: payload, xpub: ZPUB });
		expect(summary.name).toBe(payload);
		// Other tables untouched by an injection attempt disguised as a name.
		const after = tableCounts();
		expect(after.users).toBe(before.users);
		expect(after.sessions).toBe(before.sessions);
		expect(after.settings).toBe(before.settings);
	});

	it('SQLi payload as a wallet name is stored as inert data — wallets/users tables both survive', async () => {
		const user = await makeUser('owner@example.com');
		createWallet(user.id, { name: SQLI_DROP, xpub: ZPUB });
		// The DROP TABLE never executed: both tables are still queryable and intact.
		const wallets = db.prepare('SELECT name FROM wallets WHERE user_id = ?').all(user.id) as {
			name: string;
		}[];
		expect(wallets).toEqual([{ name: SQLI_DROP }]);
		expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
	});

	it('10,000-char name is silently truncated to 64 chars (KNOWN current behavior, not an error)', async () => {
		const user = await makeUser('owner@example.com');
		const summary = createWallet(user.id, { name: TEN_K, xpub: ZPUB });
		expect(summary.name).toBe('x'.repeat(64));
		expect(summary.name.length).toBe(64);
	});

	it('leading/trailing whitespace is trimmed, but zero-width/RTL marks are not whitespace and survive', async () => {
		const user = await makeUser('owner@example.com');
		const summary = createWallet(user.id, { name: `  ${ZERO_WIDTH}  `, xpub: ZPUB });
		expect(summary.name).toBe(ZERO_WIDTH);
	});
});

describe('FIXED (cairn-qmx8): wallet-name truncation no longer mangles a surrogate pair', () => {
	// createWallet's name cap used to be a raw `name.slice(0, 64)` — a UTF-16
	// code-unit slice with no surrogate awareness, so a name landing exactly on
	// an astral-plane character's pair boundary (emoji are 2 UTF-16 code units
	// each) was truncated mid-emoji, leaving a lone (unpaired) high surrogate.
	// That invalid UTF-16 round-tripped through node:sqlite's UTF-8-at-rest TEXT
	// storage as U+FFFD, the Unicode replacement character — the stored/returned
	// name's last character silently became a visible "�". truncateUtf16Safe
	// (textGuard.ts) now drops a dangling high surrogate instead of keeping it,
	// so the cap can land one code unit short of 64 but is always valid UTF-16.
	it('a name with 👍👍 straddling the 64-char cutoff drops the split emoji instead of corrupting into U+FFFD', async () => {
		const user = await makeUser('owner@example.com');
		const hostileName = 'a'.repeat(63) + '👍👍'; // 63 + 4 UTF-16 units = length 67
		const summary = createWallet(user.id, { name: hostileName, xpub: ZPUB });
		expect(summary.name).toBe('a'.repeat(63)); // the split 👍 is dropped, not corrupted
		expect(summary.name).not.toContain('�');
	});

	it('a name with 👍👍 landing WELL inside the cap keeps both emoji intact', async () => {
		const user = await makeUser('owner@example.com');
		const hostileName = 'a'.repeat(50) + '👍👍'; // 50 + 4 = 54, nowhere near the 64 cap
		const summary = createWallet(user.id, { name: hostileName, xpub: ZPUB });
		expect(summary.name).toBe(hostileName);
	});
});

// ── multisig name (createMultisig — trims, REJECTS >60 rather than truncating) ──

describe('hostile input: multisig name (createMultisig)', () => {
	it.each(HOSTILE_SHORT)('accepts %j verbatim as a multisig name (under the 60 cap)', async (payload) => {
		const user = await makeUser('owner@example.com');
		const ms = createMultisig(user.id, { name: payload, threshold: 2, keys: makeMultisigKeys() });
		expect(ms.name).toBe(payload);
	});

	it('rejects (does not truncate) a name over 60 characters, with a clean MultisigError — no crash', async () => {
		const user = await makeUser('owner@example.com');
		expect(() =>
			createMultisig(user.id, { name: TEN_K, threshold: 2, keys: makeMultisigKeys() })
		).toThrow(MultisigError);
		// Nothing was inserted on the rejected attempt.
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM multisigs WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('SQLi payload at exactly the 60-char cap is stored as inert data, multisigs table intact', async () => {
		const user = await makeUser('owner@example.com');
		const payload = (SQLI_DROP + 'x'.repeat(60)).slice(0, 60);
		const ms = createMultisig(user.id, { name: payload, threshold: 2, keys: makeMultisigKeys() });
		expect(ms.name).toBe(payload);
		const row = db.prepare('SELECT name FROM multisigs WHERE id = ?').get(ms.id) as { name: string };
		expect(row.name).toBe(payload);
	});
});

describe('FIXED (cairn-vgbv): multisig name length cap counts human characters, not UTF-16 units', () => {
	// createMultisig's `name.length > 60` check used to be plain JS UTF-16
	// length. An emoji-heavy name of just 16 visible family-emoji glyphs (7
	// code units each = 112) already exceeded the cap and was REJECTED, while
	// an ASCII name of 60 plain letters was accepted — same "character count"
	// to a user, wildly different code-unit count. graphemeLength()
	// (textGuard.ts, Intl.Segmenter-based) now counts user-perceived
	// characters instead, so this is accepted like any other 16-character name.
	it('16 repeated family-emoji glyphs (112 UTF-16 units, 16 visible glyphs) is accepted, not rejected as "too long"', async () => {
		const user = await makeUser('owner@example.com');
		const name = EMOJI_ZWJ.repeat(16);
		expect(name.length).toBeGreaterThan(60); // still true in raw UTF-16 units…
		const ms = createMultisig(user.id, { name, threshold: 2, keys: makeMultisigKeys() }); // …but no longer rejected
		expect(ms.name).toBe(name);
	});

	it('61 visible family-emoji glyphs (well over 60) is still rejected', async () => {
		const user = await makeUser('owner@example.com');
		const name = EMOJI_ZWJ.repeat(61);
		expect(() =>
			createMultisig(user.id, { name, threshold: 2, keys: makeMultisigKeys() })
		).toThrow(MultisigError);
	});
});

// ── wallet-scoped address label (setAddressLabel — trims + caps at 120) ─────

describe('hostile input: wallet address label (setAddressLabel)', () => {
	function makeWallet(userId: number): number {
		return Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
				.run(userId, `xpub-label-${Math.random()}`).lastInsertRowid
		);
	}

	it.each(HOSTILE_SHORT)('stores and reads back %j byte-identical (under the 120 cap)', async (payload) => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		setAddressLabel(user.id, 'wallet', walletId, 'bc1qhostile', payload);
		expect(getAddressLabels(user.id, 'wallet', walletId)).toEqual({ bc1qhostile: payload });
	});

	it('trims and caps a 10,000-char label at ADDRESS_LABEL_MAX (120), no crash', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		const r = setAddressLabel(user.id, 'wallet', walletId, 'bc1qhostile', `  ${TEN_K}  `);
		expect(r.label.length).toBe(WALLET_LABEL_MAX);
		expect(r.label).toBe('x'.repeat(WALLET_LABEL_MAX));
	});

	it('SQLi payload as a label is inert data — address_labels and wallets tables both intact', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		setAddressLabel(user.id, 'wallet', walletId, 'bc1qhostile', SQLI_OR);
		expect(getAddressLabels(user.id, 'wallet', walletId)).toEqual({ bc1qhostile: SQLI_OR });
		expect((db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number }).n).toBe(1);
	});
});

// ── address book label (saveAddress — trims, REJECTS >60 rather than truncating) ─

describe('hostile input: address book label (saveAddress)', () => {
	// A known-valid mainnet address (same fixture addressBook.test.ts uses).
	const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

	it.each(HOSTILE_SHORT)('stores and reads back %j byte-identical (under the 60 cap)', async (payload) => {
		const user = await makeUser('owner@example.com');
		const { entry } = saveAddress(user.id, { address: ADDR, label: payload });
		expect(entry.label).toBe(payload);
	});

	it('rejects (does not truncate) a label over 60 characters, with a clean AddressBookError', async () => {
		const user = await makeUser('owner@example.com');
		expect(() => saveAddress(user.id, { address: ADDR, label: TEN_K })).toThrow(AddressBookError);
		expect(
			(db.prepare('SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?').get(user.id) as {
				n: number;
			}).n
		).toBe(0);
	});

	// Embedded-NUL behavior for this field is pinned in the consolidated
	// "KNOWN GAP: embedded NUL truncates stored text" section below.
});

// ── tx label (setLabel, wallets.ts — trims + caps at TX_LABEL_MAX 120) ──────

describe('hostile input: transaction label (setLabel)', () => {
	function makeWallet(userId: number): number {
		return Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
				.run(userId, `xpub-txlabel-${Math.random()}`).lastInsertRowid
		);
	}

	it.each(HOSTILE_SHORT)('stores and reads back %j byte-identical (under the 120 cap)', async (payload) => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		const txid = '11'.repeat(32);
		const r = setLabel(user.id, walletId, txid, payload);
		expect(r).toEqual({ txid, label: payload });
		expect(getLabelsRoundtrip(user.id, walletId, txid)).toBe(payload);
	});

	function getLabelsRoundtrip(userId: number, walletId: number, txid: string): string | undefined {
		const row = db
			.prepare('SELECT label FROM tx_labels WHERE wallet_id = ? AND txid = ?')
			.get(walletId, txid) as { label: string } | undefined;
		return row?.label;
	}

	it('caps a 10,000-char tx label at TX_LABEL_MAX (120)', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		const r = setLabel(user.id, walletId, '22'.repeat(32), TEN_K);
		expect(r?.label.length).toBe(TX_LABEL_MAX);
	});
});

// ── contact display name (registerUser -> ContactSummary, contacts.ts) ─────

describe('hostile input: contact display name (registerUser -> listContacts)', () => {
	async function befriend(a: { id: number }, b: { id: number; email: string }) {
		requestContact(a.id, b.email);
		const row = db
			.prepare('SELECT id FROM contacts WHERE user_id = ? AND contact_user_id = ?')
			.get(a.id, b.id) as { id: number };
		respondToContact(b.id, row.id, true);
	}

	it.each(HOSTILE_SHORT)('a hostile display name (%j) round-trips verbatim into a contact listing', async (payload) => {
		const alice = await makeUser('alice@example.com');
		const bob = await registerUser({
			email: 'bob@example.com',
			password: 'correct horse battery',
			displayName: payload
		});
		await befriend(alice, bob);
		const friends = listContacts(alice.id).friends;
		expect(friends).toHaveLength(1);
		expect(friends[0].displayName).toBe(payload);
	});

	it('SQLi payload as a display name is inert — users table intact, exact row count', async () => {
		const alice = await makeUser('alice@example.com');
		await registerUser({
			email: 'bob@example.com',
			password: 'correct horse battery',
			displayName: SQLI_DROP
		});
		expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(2);
		const row = db.prepare('SELECT display_name FROM users WHERE email = ?').get('bob@example.com') as {
			display_name: string;
		};
		expect(row.display_name).toBe(SQLI_DROP);
	});
});

describe('FIXED (cairn-l04v): registration displayName is capped like every other name field', () => {
	// Was: auth.ts's assertCanRegister only checked `!displayName` (empty) after
	// trim — there was no length ceiling at all. A 10,000-char display name was
	// accepted, stored verbatim, and would be echoed into every one of the
	// app's widest-fanned-out surfaces (contacts list, admin user list, "New
	// account created" notification body, activity feed).
	// Now: capped at DISPLAY_NAME_MAX (60), counted in grapheme clusters (same
	// cairn-vgbv reasoning as the multisig name cap) — see textGuard.ts's
	// graphemeLength().
	it('a 10,000-char display name is rejected with a friendly AuthError, no account created', async () => {
		await expect(
			registerUser({
				email: 'huge-name@example.com',
				password: 'correct horse battery',
				displayName: TEN_K
			})
		).rejects.toThrow(AuthError);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('huge-name@example.com') as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('a display name at exactly the 60-char cap registers successfully', async () => {
		const name = 'a'.repeat(60);
		const user = await registerUser({
			email: 'at-cap@example.com',
			password: 'correct horse battery',
			displayName: name
		});
		expect(user.displayName).toBe(name);
	});

	it('a display name one over the cap (61 chars) is rejected', async () => {
		await expect(
			registerUser({
				email: 'over-cap@example.com',
				password: 'correct horse battery',
				displayName: 'a'.repeat(61)
			})
		).rejects.toThrow(AuthError);
	});

	it('60 repeated family-emoji glyphs (420 UTF-16 units, 60 visible glyphs) is accepted, not rejected as "too long"', async () => {
		const name = EMOJI_ZWJ.repeat(60);
		expect(name.length).toBeGreaterThan(60); // still true in raw UTF-16 units…
		const user = await registerUser({
			email: 'emoji-at-cap@example.com',
			password: 'correct horse battery',
			displayName: name
		}); // …but no longer rejected
		expect(user.displayName).toBe(name);
	});

	it('61 visible family-emoji glyphs (well over 60) is still rejected', async () => {
		await expect(
			registerUser({
				email: 'emoji-over-cap@example.com',
				password: 'correct horse battery',
				displayName: EMOJI_ZWJ.repeat(61)
			})
		).rejects.toThrow(AuthError);
	});
});

// ── consolidated: embedded NUL byte behavior, all fields (cairn-y73r/cairn-x5m9) ─

describe('FIXED (cairn-y73r/cairn-x5m9): embedded NUL bytes are rejected, not truncated', () => {
	// node:sqlite binds a JS string to a TEXT column as a NUL-terminated
	// C-string, so an embedded NUL byte used to silently truncate everything
	// after it at storage time ("abc\0def" stored/returned as "abc") with no
	// error anywhere in the call chain — a single shared cause (see
	// textGuard.ts) across every free-text write path in the app. Every path
	// below now runs the value through containsNulByte()/assertNoNulByte()
	// BEFORE the write and rejects it with a friendly, typed error instead —
	// nothing is written on a rejected attempt.

	it('wallet name (createWallet) — REJECTS the NUL, writes nothing', async () => {
		const user = await makeUser('owner@example.com');
		expect(() => createWallet(user.id, { name: NULL_BYTE, xpub: ZPUB })).toThrow(/NUL character/);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('multisig name (createMultisig) — REJECTS the NUL instead of truncating', async () => {
		const user = await makeUser('owner@example.com');
		expect(() =>
			createMultisig(user.id, { name: NULL_BYTE, threshold: 2, keys: makeMultisigKeys() })
		).toThrow(MultisigError);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM multisigs WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('wallet-scoped address label (setAddressLabel) — REJECTS the NUL, writes nothing', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
				.run(user.id, `xpub-nul-${Math.random()}`).lastInsertRowid
		);
		expect(() =>
			setAddressLabel(user.id, 'wallet', walletId, 'bc1qhostile', NULL_BYTE)
		).toThrow(TextInputError);
		expect(getAddressLabels(user.id, 'wallet', walletId)).toEqual({});
	});

	it('address book label (saveAddress) — REJECTS the NUL, writes nothing', async () => {
		const user = await makeUser('owner@example.com');
		expect(() =>
			saveAddress(user.id, {
				address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
				label: NULL_BYTE
			})
		).toThrow(AddressBookError);
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM saved_addresses WHERE user_id = ?')
			.get(user.id) as { n: number };
		expect(n).toBe(0);
	});

	it('transaction label (setLabel) — REJECTS the NUL, writes nothing', async () => {
		const user = await makeUser('owner@example.com');
		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
				.run(user.id, `xpub-nul-tx-${Math.random()}`).lastInsertRowid
		);
		const txid = '33'.repeat(32);
		expect(() => setLabel(user.id, walletId, txid, NULL_BYTE)).toThrow(TextInputError);
		const row = db
			.prepare('SELECT label FROM tx_labels WHERE wallet_id = ? AND txid = ?')
			.get(walletId, txid) as { label: string } | undefined;
		expect(row).toBeUndefined();
	});

	it('registration display name (registerUser) — REJECTS the NUL, creates no account', async () => {
		await expect(
			registerUser({
				email: 'nul-name@example.com',
				password: 'correct horse battery',
				displayName: NULL_BYTE
			})
		).rejects.toThrow(AuthError);
		const row = db.prepare('SELECT id FROM users WHERE email = ?').get('nul-name@example.com');
		expect(row).toBeUndefined();
	});
});

// ── additional free-text write paths swept for the same gap (cairn-x5m9) ───
// Found by grepping every db.prepare(...).run(...) write for genuinely
// user-chosen free text beyond the four call sites the bead named — each of
// these had the same zero-guard shape as the fields above and is fixed the
// same way (reuse the module's own typed validation error).

describe('FIXED (cairn-x5m9, additional gaps found in the same sweep)', () => {
	it('user agreement text/operator (disclosures.setUserAgreement) — REJECTS the NUL', () => {
		expect(() => setUserAgreement({ text: NULL_BYTE, operator: 'Op' })).toThrow(TextInputError);
		expect(() => setUserAgreement({ text: 'Fine text', operator: NULL_BYTE })).toThrow(
			TextInputError
		);
	});

	it('announcement title/body/linkText (announcements.createAnnouncement) — REJECTS the NUL', () => {
		const base = { type: 'info' as const, title: 'Title', body: 'Body' };
		expect(() => createAnnouncement({ ...base, title: NULL_BYTE })).toThrow(
			AnnouncementValidationError
		);
		expect(() => createAnnouncement({ ...base, body: NULL_BYTE })).toThrow(
			AnnouncementValidationError
		);
		expect(() =>
			createAnnouncement({ ...base, linkUrl: 'https://example.com', linkText: NULL_BYTE })
		).toThrow(AnnouncementValidationError);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM announcements').get() as { n: number };
		expect(n).toBe(0);
	});

	it('API token name (apiTokens.createApiToken) — REJECTS the NUL, mints nothing', async () => {
		const user = await makeUser('owner@example.com');
		expect(() => createApiToken(user.id, NULL_BYTE)).toThrow(ApiTokenError);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(0);
	});

	it('invite label (admin.createInvites) — REJECTS the NUL, creates no invite', async () => {
		const user = await makeUser('owner@example.com');
		expect(() => createInvites({ createdBy: user.id, count: 1, label: NULL_BYTE })).toThrow(
			AuthError
		);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number };
		expect(n).toBe(0);
	});

	it('referral service name/description (referrals.createMultisigServiceReferral) — REJECTS the NUL', () => {
		const base = { name: 'Service', url: 'https://example.com' };
		expect(() => createMultisigServiceReferral({ ...base, name: NULL_BYTE })).toThrow(
			ReferralValidationError
		);
		expect(() =>
			createMultisigServiceReferral({ ...base, description: NULL_BYTE })
		).toThrow(ReferralValidationError);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM multisig_service_referrals').get() as {
			n: number;
		};
		expect(n).toBe(0);
	});
});
