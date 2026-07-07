import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	isNewerVersion,
	refreshLatestRelease,
	getUpdateNotice,
	resetUpdateCheckCache,
	CURRENT_VERSION
} from './updateCheck';

function fakeFetch(body: unknown, status = 200): typeof fetch {
	return vi.fn(async () =>
		new Response(JSON.stringify(body), { status })
	) as unknown as typeof fetch;
}

/** Bump the patch segment of the running version — always strictly newer. */
function newerThanCurrent(): string {
	const [maj, min, pat] = CURRENT_VERSION.split('.').map(Number);
	return `v${maj}.${min}.${pat + 1}`;
}

beforeEach(() => {
	resetUpdateCheckCache();
	// getUpdateNotice() may kick off a background refresh — keep it off the
	// real network in tests.
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw new Error('network disabled in tests');
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isNewerVersion', () => {
	it('compares semver segments numerically', () => {
		expect(isNewerVersion('0.1.5', '0.1.4')).toBe(true);
		expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
		expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
		expect(isNewerVersion('0.1.4', '0.1.4')).toBe(false);
		expect(isNewerVersion('0.1.3', '0.1.4')).toBe(false);
		expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true); // not lexicographic
	});

	it('tolerates a leading v on either side', () => {
		expect(isNewerVersion('v0.1.5', '0.1.4')).toBe(true);
		expect(isNewerVersion('0.1.5', 'v0.1.4')).toBe(true);
	});

	it('treats unparseable input as not-newer (fail silent)', () => {
		expect(isNewerVersion('latest', '0.1.4')).toBe(false);
		expect(isNewerVersion('', '0.1.4')).toBe(false);
		expect(isNewerVersion('0.1.5', 'garbage')).toBe(false);
	});
});

describe('getUpdateNotice', () => {
	it('reports a notice when a newer release exists', async () => {
		const tag = newerThanCurrent();
		await refreshLatestRelease(
			fakeFetch({ tag_name: tag, html_url: `https://github.com/AlexM223/cairn/releases/tag/${tag}` })
		);
		const notice = getUpdateNotice();
		expect(notice).not.toBeNull();
		expect(notice!.currentVersion).toBe(CURRENT_VERSION);
		expect(notice!.latestVersion).toBe(tag.replace(/^v/, ''));
		expect(notice!.releaseUrl).toContain('/releases/tag/');
	});

	it('reports nothing when already on the latest release', async () => {
		await refreshLatestRelease(fakeFetch({ tag_name: `v${CURRENT_VERSION}`, html_url: 'x' }));
		expect(getUpdateNotice()).toBeNull();
	});

	it('reports nothing (fail silent) when the check errors', async () => {
		await refreshLatestRelease(fakeFetch({ message: 'rate limited' }, 403));
		expect(getUpdateNotice()).toBeNull();

		resetUpdateCheckCache();
		const throwing = vi.fn(async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		await refreshLatestRelease(throwing);
		expect(getUpdateNotice()).toBeNull();
	});

	it('never blocks: answers null instantly before any check has completed', () => {
		// Fresh cache, no awaited fetch — the load-path call must return at once.
		expect(getUpdateNotice()).toBeNull();
	});
});
