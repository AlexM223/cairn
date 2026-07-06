import { describe, it, expect, afterEach } from 'vitest';
import { absoluteNotificationLink } from './notifyLinks';

// env is process.env under the test alias (src/tests/env-stub.ts).
const ORIGINAL = process.env.CAIRN_ORIGIN;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.CAIRN_ORIGIN;
	else process.env.CAIRN_ORIGIN = ORIGINAL;
});

describe('absoluteNotificationLink', () => {
	it('returns null for an empty/absent link', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com';
		expect(absoluteNotificationLink(undefined)).toBeNull();
		expect(absoluteNotificationLink(null)).toBeNull();
		expect(absoluteNotificationLink('')).toBeNull();
	});

	it('omits the link entirely when CAIRN_ORIGIN is unset (better than a broken one)', () => {
		delete process.env.CAIRN_ORIGIN;
		expect(absoluteNotificationLink('/wallets/3')).toBeNull();
	});

	it('joins a relative path against the origin', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com';
		expect(absoluteNotificationLink('/wallets/3')).toBe('https://cairn.example.com/wallets/3');
	});

	it('handles a trailing slash on the origin without doubling', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com/';
		expect(absoluteNotificationLink('/admin/users')).toBe('https://cairn.example.com/admin/users');
	});

	it('passes an already-absolute link through', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com';
		expect(absoluteNotificationLink('https://other.example/x')).toBe('https://other.example/x');
	});

	it('passes an absolute link through even when CAIRN_ORIGIN is unset', () => {
		delete process.env.CAIRN_ORIGIN;
		expect(absoluteNotificationLink('https://other.example/x')).toBe('https://other.example/x');
	});

	it('returns null when the origin is not a valid URL base', () => {
		process.env.CAIRN_ORIGIN = 'not a url';
		expect(absoluteNotificationLink('/wallets/3')).toBeNull();
	});
});
