import { describe, it, expect } from 'vitest';
import {
	secureUrlFor,
	shouldAttemptSecureRedirect,
	SECURE_REDIRECT_SUPPRESS_KEY,
	SECURE_REDIRECT_OPT_OUT_PARAM
} from './secureRedirect';

function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v)
	};
}

describe('secureUrlFor', () => {
	it('keeps path, query and hash on the secure origin', () => {
		expect(
			secureUrlFor(
				{ hostname: 'umbrel.local', pathname: '/wallets/3/send', search: '?draft=1', hash: '#sign' },
				3212
			)
		).toBe('https://umbrel.local:3212/wallets/3/send?draft=1#sign');
	});

	it('handles the bare root path', () => {
		expect(secureUrlFor({ hostname: 'umbrel.local', pathname: '/', search: '', hash: '' }, 3212)).toBe(
			'https://umbrel.local:3212/'
		);
	});
});

describe('shouldAttemptSecureRedirect', () => {
	const base = {
		isSecureContext: false,
		httpsPort: 3212,
		searchParams: new URLSearchParams(),
		storage: fakeStorage()
	};

	it('attempts on an insecure page with an advertised port', () => {
		expect(shouldAttemptSecureRedirect({ ...base, storage: fakeStorage() })).toBe(true);
	});

	it('never attempts on a secure context (includes localhost)', () => {
		expect(shouldAttemptSecureRedirect({ ...base, isSecureContext: true })).toBe(false);
	});

	it('never attempts without an advertised port', () => {
		expect(shouldAttemptSecureRedirect({ ...base, httpsPort: null })).toBe(false);
	});

	it('honors the tab-scoped suppress flag', () => {
		const storage = fakeStorage({ [SECURE_REDIRECT_SUPPRESS_KEY]: '1' });
		expect(shouldAttemptSecureRedirect({ ...base, storage })).toBe(false);
	});

	it('?insecure=1 suppresses AND persists the flag for the tab', () => {
		const storage = fakeStorage();
		const searchParams = new URLSearchParams(`?${SECURE_REDIRECT_OPT_OUT_PARAM}=1`);
		expect(shouldAttemptSecureRedirect({ ...base, searchParams, storage })).toBe(false);
		expect(storage.getItem(SECURE_REDIRECT_SUPPRESS_KEY)).toBe('1');
	});

	it('a bare ?insecure (no value) also opts out', () => {
		const searchParams = new URLSearchParams(`?${SECURE_REDIRECT_OPT_OUT_PARAM}`);
		expect(
			shouldAttemptSecureRedirect({ ...base, searchParams, storage: fakeStorage() })
		).toBe(false);
	});

	it('survives a storage that throws (private mode)', () => {
		const broken = {
			getItem() {
				throw new Error('denied');
			},
			setItem() {
				throw new Error('denied');
			}
		};
		expect(shouldAttemptSecureRedirect({ ...base, storage: broken })).toBe(true);
		const searchParams = new URLSearchParams(`?${SECURE_REDIRECT_OPT_OUT_PARAM}=1`);
		expect(shouldAttemptSecureRedirect({ ...base, searchParams, storage: broken })).toBe(false);
	});

	it('works with no storage at all', () => {
		expect(shouldAttemptSecureRedirect({ ...base, storage: null })).toBe(true);
	});
});
