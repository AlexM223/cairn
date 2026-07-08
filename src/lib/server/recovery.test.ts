import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from './db';
import { registerUser, addCredential, hasNoCredentials } from './auth';
import {
	generateRecoveryPhrase,
	verifyRecoveryPhrase,
	generateRecoveryCodes,
	consumeRecoveryCode,
	mintAdminRecoveryCode,
	hasRecoverySetup,
	normalizePhrase,
	normalizeCode,
	createRecoveryGrant,
	peekRecoveryGrant,
	consumeRecoveryGrant,
	tryAdminBreakGlass,
	breakGlassAdmin,
	RECOVERY_CODE_COUNT
} from './recovery';
import {
	recoveryRetryAfter,
	noteRecoveryAttempt,
	clearRecovery
} from './rateLimit';

function wipe(): void {
	db.exec(
		'DELETE FROM sessions; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings; DELETE FROM account_recovery_phrases; DELETE FROM account_recovery_codes; DELETE FROM recovery_grants;'
	);
}

beforeEach(wipe);

function registerAdmin() {
	return registerUser({ email: 'admin@example.com', displayName: 'Admin' });
}

function addPasskey(userId: number, id = 'cred-a') {
	addCredential(userId, {
		credentialId: id,
		publicKey: new Uint8Array([1, 2, 3, 4]),
		counter: 0,
		transports: ['internal'],
		deviceType: 'multiDevice',
		backedUp: true,
		name: 'Phone'
	});
}

// ------------------------------------------------------------- recovery phrase

describe('recovery phrase', () => {
	it('generates a 12-word BIP39 mnemonic that round-trips generate -> verify', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryPhrase();
		expect(gen.phrase.split(' ')).toHaveLength(12);
		await gen.store(admin.id);
		expect(await verifyRecoveryPhrase(admin.id, gen.phrase)).toBe(true);
	});

	it('rejects a wrong phrase', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryPhrase();
		await gen.store(admin.id);
		const other = generateRecoveryPhrase().phrase;
		expect(await verifyRecoveryPhrase(admin.id, other)).toBe(false);
	});

	it('normalizes case and spacing: differing case / extra spaces still verify', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryPhrase();
		await gen.store(admin.id);
		const messy = ('   ' + gen.phrase.toUpperCase().replace(/ /g, '   ') + '  ').replace(
			/\t/g,
			' '
		);
		expect(normalizePhrase(messy)).toBe(gen.phrase);
		expect(await verifyRecoveryPhrase(admin.id, messy)).toBe(true);
	});

	it('is reusable — verifying twice both succeed', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryPhrase();
		await gen.store(admin.id);
		expect(await verifyRecoveryPhrase(admin.id, gen.phrase)).toBe(true);
		expect(await verifyRecoveryPhrase(admin.id, gen.phrase)).toBe(true);
	});

	it('regeneration replaces the previous phrase', async () => {
		const admin = await registerAdmin();
		const first = generateRecoveryPhrase();
		await first.store(admin.id);
		const second = generateRecoveryPhrase();
		await second.store(admin.id);
		expect(await verifyRecoveryPhrase(admin.id, second.phrase)).toBe(true);
		expect(await verifyRecoveryPhrase(admin.id, first.phrase)).toBe(false);
		// Still exactly one row.
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM account_recovery_phrases WHERE user_id = ?')
			.get(admin.id) as { n: number };
		expect(n).toBe(1);
	});

	it('unknown user / no phrase stored verifies false without throwing', async () => {
		const admin = await registerAdmin(); // no phrase stored
		expect(await verifyRecoveryPhrase(admin.id, 'any words here')).toBe(false);
		expect(await verifyRecoveryPhrase(999999, 'any words here')).toBe(false);
	});
});

// -------------------------------------------------------------- recovery codes

describe('recovery codes', () => {
	it('generates 8 codes and stores hashes only (never plaintext)', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryCodes();
		expect(gen.codes).toHaveLength(RECOVERY_CODE_COUNT);
		await gen.store(admin.id);
		const rows = db
			.prepare('SELECT code_hash FROM account_recovery_codes WHERE user_id = ?')
			.all(admin.id) as { code_hash: string }[];
		expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
		// Stored value is a scrypt hash, not the plaintext code.
		for (const r of rows) {
			expect(r.code_hash).toMatch(/^scrypt:/);
			expect(gen.codes).not.toContain(r.code_hash);
		}
	});

	it('consumes a code once; the second use fails', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryCodes();
		await gen.store(admin.id);
		const code = gen.codes[0];
		expect(await consumeRecoveryCode(admin.id, code)).toBe(true);
		expect(await consumeRecoveryCode(admin.id, code)).toBe(false);
	});

	it('accepts a code typed without the dash / different case', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryCodes();
		await gen.store(admin.id);
		const messy = gen.codes[1].toLowerCase().replace(/-/g, ' ');
		expect(normalizeCode(messy)).toBe(gen.codes[1].replace(/-/g, ''));
		expect(await consumeRecoveryCode(admin.id, messy)).toBe(true);
	});

	it('a wrong code does not consume anything and returns false', async () => {
		const admin = await registerAdmin();
		const gen = generateRecoveryCodes();
		await gen.store(admin.id);
		expect(await consumeRecoveryCode(admin.id, 'ZZZZZ-ZZZZZ')).toBe(false);
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(RECOVERY_CODE_COUNT);
	});

	it('concurrent double-use of the same code succeeds exactly once', async () => {
		// node:sqlite is synchronous, so simulate the race by re-implementing the
		// guarded spend: both calls confirm the hash matches, but only the first
		// UPDATE ... WHERE used_at IS NULL changes a row. consumeRecoveryCode uses
		// that exact guard, so calling it twice models two racers where the second
		// finds the row already spent.
		const admin = await registerAdmin();
		const gen = generateRecoveryCodes();
		await gen.store(admin.id);
		const results = await Promise.all([
			consumeRecoveryCode(admin.id, gen.codes[0]),
			consumeRecoveryCode(admin.id, gen.codes[0])
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it('regeneration replaces the whole set (old codes stop working)', async () => {
		const admin = await registerAdmin();
		const first = generateRecoveryCodes();
		await first.store(admin.id);
		const second = generateRecoveryCodes();
		await second.store(admin.id);
		expect(await consumeRecoveryCode(admin.id, first.codes[0])).toBe(false);
		expect(await consumeRecoveryCode(admin.id, second.codes[0])).toBe(true);
		// Exactly the new set existed (8 total, 1 now used).
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM account_recovery_codes WHERE user_id = ?')
			.get(admin.id) as { n: number };
		expect(n).toBe(RECOVERY_CODE_COUNT);
	});

	it('unknown user / no codes returns false without throwing', async () => {
		const admin = await registerAdmin();
		expect(await consumeRecoveryCode(admin.id, 'ABCDE-FGHJK')).toBe(false);
		expect(await consumeRecoveryCode(999999, 'ABCDE-FGHJK')).toBe(false);
	});
});

// --------------------------------------------------------- admin-minted codes

describe('mintAdminRecoveryCode (cairn-j1q9)', () => {
	it('mints exactly one redeemable code', async () => {
		const admin = await registerAdmin();
		const code = await mintAdminRecoveryCode(admin.id);
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(1);
		expect(await consumeRecoveryCode(admin.id, code)).toBe(true);
	});

	it('never lets the unused count exceed RECOVERY_CODE_COUNT (deletes unused before inserting)', async () => {
		const admin = await registerAdmin();
		// Mint the same user a code 10 times in a row — if this didn't delete the
		// prior unused code first, unused rows would pile up past
		// RECOVERY_CODE_COUNT and consumeRecoveryCode's constant-work scan (which
		// iterates exactly that many rows) could never reach the newest one.
		let last = '';
		for (let i = 0; i < RECOVERY_CODE_COUNT + 2; i++) {
			last = await mintAdminRecoveryCode(admin.id);
		}
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(1);
		expect(await consumeRecoveryCode(admin.id, last)).toBe(true);
	});

	it('leaves an existing regular-generated set intact in count but supersedes it — old codes stop working', async () => {
		const admin = await registerAdmin();
		const original = generateRecoveryCodes();
		await original.store(admin.id);
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(RECOVERY_CODE_COUNT);

		const minted = await mintAdminRecoveryCode(admin.id);
		// All the original unused codes were replaced by the single minted one.
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(1);
		expect(await consumeRecoveryCode(admin.id, original.codes[0])).toBe(false);
		expect(await consumeRecoveryCode(admin.id, minted)).toBe(true);
	});

	it('does not disturb an already-USED code row (only unused ones are cleared)', async () => {
		const admin = await registerAdmin();
		const original = generateRecoveryCodes();
		await original.store(admin.id);
		expect(await consumeRecoveryCode(admin.id, original.codes[0])).toBe(true); // now used

		await mintAdminRecoveryCode(admin.id);
		// The used row from before is untouched (still 1 used + 1 new unused).
		const { used, total } = db
			.prepare(
				'SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used FROM account_recovery_codes WHERE user_id = ?'
			)
			.get(admin.id) as { used: number; total: number };
		expect(total).toBe(2);
		expect(used).toBe(1);
	});
});

// ----------------------------------------------------------- hasRecoverySetup

describe('hasRecoverySetup', () => {
	it('reflects phrase presence and remaining unused codes', async () => {
		const admin = await registerAdmin();
		expect(hasRecoverySetup(admin.id)).toEqual({ phrase: false, codesRemaining: 0 });

		await generateRecoveryPhrase().store(admin.id);
		const codes = generateRecoveryCodes();
		await codes.store(admin.id);
		expect(hasRecoverySetup(admin.id)).toEqual({
			phrase: true,
			codesRemaining: RECOVERY_CODE_COUNT
		});

		await consumeRecoveryCode(admin.id, codes.codes[0]);
		expect(hasRecoverySetup(admin.id).codesRemaining).toBe(RECOVERY_CODE_COUNT - 1);
	});
});

// ------------------------------------------------------------- recovery grants

describe('recovery grants', () => {
	it('peek resolves the user without consuming; consume is single-use', async () => {
		const admin = await registerAdmin();
		const { token } = createRecoveryGrant(admin.id);
		expect(peekRecoveryGrant(token)?.userId).toBe(admin.id);
		// Peek again still works (not consumed).
		expect(peekRecoveryGrant(token)?.userId).toBe(admin.id);
		expect(consumeRecoveryGrant(token)?.userId).toBe(admin.id);
		// Now consumed.
		expect(consumeRecoveryGrant(token)).toBeNull();
		expect(peekRecoveryGrant(token)).toBeNull();
	});

	it('rejects an unknown / undefined token', () => {
		expect(peekRecoveryGrant(undefined)).toBeNull();
		expect(peekRecoveryGrant('nope')).toBeNull();
		expect(consumeRecoveryGrant('nope')).toBeNull();
	});

	it('an expired grant does not resolve', async () => {
		const admin = await registerAdmin();
		const { token } = createRecoveryGrant(admin.id);
		// Force the stored grant into the past.
		db.prepare('UPDATE recovery_grants SET expires_at = ? WHERE user_id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			admin.id
		);
		expect(peekRecoveryGrant(token)).toBeNull();
	});

	it('minting a new grant supersedes the prior one', async () => {
		const admin = await registerAdmin();
		const first = createRecoveryGrant(admin.id);
		const second = createRecoveryGrant(admin.id);
		expect(peekRecoveryGrant(first.token)).toBeNull();
		expect(peekRecoveryGrant(second.token)?.userId).toBe(admin.id);
	});
});

// -------------------------------------------------------- admin break-glass

describe('admin break-glass', () => {
	const ENV_KEYS = ['CAIRN_ADMIN_RECOVERY', 'CAIRN_ADMIN_PASSWORD', 'APP_PASSWORD'] as const;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('is OFF when the env flag is unset (returns null regardless of inputs)', async () => {
		const admin = await registerAdmin();
		process.env.CAIRN_ADMIN_PASSWORD = 'operator-pass';
		// Flag NOT set.
		expect(
			tryAdminBreakGlass(admin.email, 'operator-pass', hasNoCredentials)
		).toBeNull();
	});

	it('is OFF when no password env var is configured', async () => {
		const admin = await registerAdmin();
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		expect(tryAdminBreakGlass(admin.email, 'anything', hasNoCredentials)).toBeNull();
	});

	it('lets a locked-out admin in with the right password when enabled', async () => {
		const admin = await registerAdmin(); // no passkeys → locked out
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = 'operator-pass';
		expect(hasNoCredentials(admin.id)).toBe(true);
		const res = tryAdminBreakGlass(admin.email, 'operator-pass', hasNoCredentials);
		expect(res?.userId).toBe(admin.id);
	});

	it('rejects a wrong password even when enabled', async () => {
		const admin = await registerAdmin();
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = 'operator-pass';
		expect(tryAdminBreakGlass(admin.email, 'wrong', hasNoCredentials)).toBeNull();
	});

	it('refuses when the admin still has a usable passkey', async () => {
		const admin = await registerAdmin();
		addPasskey(admin.id);
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = 'operator-pass';
		expect(hasNoCredentials(admin.id)).toBe(false);
		expect(tryAdminBreakGlass(admin.email, 'operator-pass', hasNoCredentials)).toBeNull();
	});

	it('refuses a non-admin account even with the right password', async () => {
		await registerAdmin(); // first user is the admin
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.CAIRN_ADMIN_PASSWORD = 'operator-pass';
		// A different email that isn't the break-glass admin.
		expect(
			tryAdminBreakGlass('someone-else@example.com', 'operator-pass', hasNoCredentials)
		).toBeNull();
	});

	it('falls back to APP_PASSWORD when CAIRN_ADMIN_PASSWORD is unset', async () => {
		const admin = await registerAdmin();
		process.env.CAIRN_ADMIN_RECOVERY = 'true';
		process.env.APP_PASSWORD = 'legacy-app-pass';
		expect(tryAdminBreakGlass(admin.email, 'legacy-app-pass', hasNoCredentials)?.userId).toBe(
			admin.id
		);
	});

	it('breakGlassAdmin targets the first (bootstrap) admin', async () => {
		const admin = await registerAdmin();
		expect(breakGlassAdmin()?.id).toBe(admin.id);
	});
});

// --------------------------------------------------------------- rate limiting

describe('recovery rate limit', () => {
	const IP = '203.0.113.9';
	const EMAIL = 'ratelimit@example.com';

	beforeEach(() => clearRecovery(IP, EMAIL));
	afterEach(() => clearRecovery(IP, EMAIL));

	it('allows 5 attempts then blocks the 6th within the window', () => {
		for (let i = 0; i < 5; i++) {
			expect(recoveryRetryAfter(IP, EMAIL)).toBeNull();
			noteRecoveryAttempt(IP, EMAIL);
		}
		// 6th attempt is blocked.
		expect(recoveryRetryAfter(IP, EMAIL)).not.toBeNull();
	});

	it('blocks by email even from a different IP', () => {
		for (let i = 0; i < 5; i++) noteRecoveryAttempt(IP, EMAIL);
		// Different IP, same email → still blocked by the email bucket.
		expect(recoveryRetryAfter('198.51.100.1', EMAIL)).not.toBeNull();
		clearRecovery('198.51.100.1', EMAIL);
	});

	it('blocks by IP even for a different email', () => {
		for (let i = 0; i < 5; i++) noteRecoveryAttempt(IP, 'a@example.com');
		expect(recoveryRetryAfter(IP, 'b@example.com')).not.toBeNull();
		clearRecovery(IP, 'a@example.com');
		clearRecovery(IP, 'b@example.com');
	});
});
