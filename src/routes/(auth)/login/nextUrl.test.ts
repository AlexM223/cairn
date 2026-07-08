import { describe, it, expect } from 'vitest';
import { isSafeInternalPath, resolveNextUrl } from './nextUrl';

describe('isSafeInternalPath', () => {
	it('accepts an ordinary same-origin path', () => {
		expect(isSafeInternalPath('/wallets')).toBe(true);
	});

	it('accepts a path with query and hash', () => {
		expect(isSafeInternalPath('/wallets/123?tab=activity#top')).toBe(true);
	});

	it('rejects a protocol-relative URL (cairn-9yw4)', () => {
		// A leading `//` is "same scheme, different host" — goto() would
		// navigate off-site.
		expect(isSafeInternalPath('//evil.com')).toBe(false);
	});

	it('rejects a backslash-prefixed URL', () => {
		// Backslashes normalize to forward slashes during URL parsing, so
		// `/\evil.com` is equivalent to `//evil.com` to a browser.
		expect(isSafeInternalPath('/\\evil.com')).toBe(false);
	});

	it('rejects an absolute URL with an explicit scheme', () => {
		expect(isSafeInternalPath('https://evil.com')).toBe(false);
	});

	it('rejects a value that is not path-rooted', () => {
		expect(isSafeInternalPath('evil.com')).toBe(false);
	});

	it('rejects an empty string', () => {
		expect(isSafeInternalPath('')).toBe(false);
	});
});

describe('resolveNextUrl', () => {
	it('passes through a safe path', () => {
		expect(resolveNextUrl('/wallets')).toBe('/wallets');
	});

	it('falls back to "/" for a protocol-relative URL', () => {
		expect(resolveNextUrl('//evil.com')).toBe('/');
	});

	it('falls back to "/" for a backslash-prefixed URL', () => {
		expect(resolveNextUrl('/\\evil.com')).toBe('/');
	});

	it('falls back to "/" when next is missing', () => {
		expect(resolveNextUrl(null)).toBe('/');
	});
});
