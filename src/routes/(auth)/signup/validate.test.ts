import { describe, it, expect } from 'vitest';
import { validateSignup } from './validate';

const ok = {
	displayName: 'Ada',
	email: 'ada@example.com',
	password: 'hunter2hunter2',
	needsInvite: false,
	inviteCode: ''
};

describe('validateSignup', () => {
	it('flags an all-empty submit with a display-name message (cairn-m06l)', () => {
		expect(
			validateSignup({ displayName: '', email: '', password: '', needsInvite: false })
		).toBe('Enter a display name.');
	});

	it('treats whitespace-only fields as empty', () => {
		expect(validateSignup({ ...ok, displayName: '   ' })).toBe('Enter a display name.');
	});

	it('asks for an email when only the name is filled', () => {
		expect(validateSignup({ ...ok, email: '' })).toBe('Enter your email address.');
	});

	it('rejects a malformed email', () => {
		expect(validateSignup({ ...ok, email: 'not-an-email' })).toBe('Enter a valid email address.');
	});

	it('rejects a password shorter than 8 characters', () => {
		expect(validateSignup({ ...ok, password: 'short' })).toBe(
			'Password must be at least 8 characters.'
		);
	});

	it('requires an invite code when the instance needs one', () => {
		expect(validateSignup({ ...ok, needsInvite: true, inviteCode: '' })).toBe(
			'This instance requires an invite code to join.'
		);
	});

	it('does not throw when an invite is required but inviteCode is undefined', () => {
		expect(validateSignup({ ...ok, needsInvite: true, inviteCode: undefined })).toBe(
			'This instance requires an invite code to join.'
		);
	});

	it('accepts a fully valid open-registration submission', () => {
		expect(validateSignup(ok)).toBeNull();
	});

	it('accepts a valid submission with an invite code', () => {
		expect(
			validateSignup({ ...ok, needsInvite: true, inviteCode: 'CAIRN-ABCD-1234' })
		).toBeNull();
	});
});
