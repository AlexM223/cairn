// Mining-pool identification (chain/pools.ts, cairn-6efi.4) + the immutable
// pool-tag cache (chain/cache.ts). identifyPool is a pure decode-and-lookup over
// the vendored known-pools.json, so these run with no chain/RPC mocking.

import { describe, it, expect, beforeEach } from 'vitest';
import { identifyPool, poolTableSize } from './pools';
import { getCachedPool, cachePool, poolCacheSize, clearPoolCache } from './cache';

/** ASCII → coinbase scriptSig hex (what Core's getrawtransaction vin[0].coinbase is). */
function asciiToHex(s: string): string {
	let hex = '';
	for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(2, '0');
	return hex;
}

describe('identifyPool — coinbase tag matching', () => {
	it('identifies a pool from a plain coinbase tag stamped in the scriptSig', () => {
		// Real coinbases prefix a height/extranonce blob; binary bytes become spaces.
		const coinbase = 'deadbeef' + asciiToHex('\x03abc/Foundry USA Pool #dropgold/');
		const pool = identifyPool(coinbase, []);
		expect(pool).toEqual({ name: 'Foundry USA', link: 'https://foundrydigital.com' });
	});

	it('matches a slash-wrapped regex-marker tag as a plain substring (/ViaBTC/)', () => {
		const coinbase = asciiToHex('mined by /ViaBTC/yay');
		expect(identifyPool(coinbase, [])?.name).toBe('ViaBTC');
	});

	it('matches AntPool from its coinbase tag', () => {
		expect(identifyPool(asciiToHex('....AntPool....'), [])?.name).toBe('AntPool');
	});

	it('returns null for a coinbase that matches no known pool (never a wrong guess)', () => {
		expect(identifyPool(asciiToHex('some unknown solo miner vanity'), [])).toBeNull();
	});

	it('returns null for empty / missing coinbase and no output addresses', () => {
		expect(identifyPool('', [])).toBeNull();
		expect(identifyPool(null, [])).toBeNull();
		expect(identifyPool(undefined, [])).toBeNull();
	});
});

describe('identifyPool — payout address matching', () => {
	it('identifies a pool from a known coinbase payout address', () => {
		const pool = identifyPool('', ['1CK6KHY6MHgYvmRQ4PAafKYDrg1ejbH1cE']);
		expect(pool?.name).toBe('SlushPool');
	});

	it('payout address is checked even when the coinbase tag is unknown', () => {
		const pool = identifyPool(asciiToHex('gibberish'), [
			null,
			'12dRugNcdxK39288NjcDV4GX7rMsKCGn6B'
		]);
		expect(pool?.name).toBe('AntPool');
	});

	it('ignores null/undefined output addresses', () => {
		expect(identifyPool(asciiToHex('nope'), [null, undefined, ''])).toBeNull();
	});
});

describe('identifyPool — table loaded', () => {
	it('loaded a non-trivial number of matchers from known-pools.json', () => {
		expect(poolTableSize()).toBeGreaterThan(10);
	});
});

describe('pool cache (immutable, per block hash)', () => {
	beforeEach(() => clearPoolCache());

	it('misses before caching, hits after', () => {
		expect(getCachedPool('hashA')).toBeUndefined();
		cachePool('hashA', { name: 'F2Pool' });
		expect(getCachedPool('hashA')).toEqual({ pool: { name: 'F2Pool' } });
	});

	it('caches a null "no known pool" result distinctly from a miss', () => {
		cachePool('hashNull', null);
		// A miss is undefined; a cached no-pool is { pool: null } — never re-derived.
		expect(getCachedPool('hashNull')).toEqual({ pool: null });
		expect(getCachedPool('neverCached')).toBeUndefined();
	});

	it('evicts the least-recently-used entry past the cap', () => {
		// Fill well past the 300 cap; the earliest inserted must be evicted.
		for (let i = 0; i < 350; i++) cachePool(`h${i}`, { name: `p${i}` });
		expect(poolCacheSize()).toBeLessThanOrEqual(300);
		expect(getCachedPool('h0')).toBeUndefined();
		expect(getCachedPool('h349')).toEqual({ pool: { name: 'p349' } });
	});

	it('refreshes recency on read so a recently-read entry survives eviction', () => {
		clearPoolCache();
		for (let i = 0; i < 300; i++) cachePool(`k${i}`, { name: `p${i}` });
		// Touch k0 so it is no longer the oldest, then push one more over the cap.
		expect(getCachedPool('k0')).toEqual({ pool: { name: 'p0' } });
		cachePool('k300', { name: 'p300' });
		expect(getCachedPool('k0')).toEqual({ pool: { name: 'p0' } });
		// k1 (now the oldest) was evicted instead.
		expect(getCachedPool('k1')).toBeUndefined();
	});
});
