import { describe, it, expect } from 'vitest';
import { blockPageTitle } from './blockTitle';

describe('blockPageTitle', () => {
	it('shows the block height when the block loaded', () => {
		expect(
			blockPageTitle({
				block: { height: 800_123 },
				loading: false,
				notFound: false,
				chainError: null,
				coreRpcConfigured: true
			})
		).toBe('Block 800,123');
	});

	it('shows a loading state while the streamed block is still in flight', () => {
		expect(
			blockPageTitle({
				block: null,
				loading: true,
				notFound: false,
				chainError: null,
				coreRpcConfigured: true
			})
		).toBe('Loading block');
	});

	it('shows a genuine not-found state', () => {
		expect(
			blockPageTitle({
				block: null,
				loading: false,
				notFound: true,
				chainError: null,
				coreRpcConfigured: true
			})
		).toBe('Block not found');
	});

	// Mirrors the tx page's txPageTitle fix: the body renders CoreRpcRequiredNotice
	// when a chain error hits an Electrum-only instance, so the title should say so
	// instead of a bare, uninformative "Block".
	it('names the real reason when a chain error hits an unconfigured Core RPC', () => {
		expect(
			blockPageTitle({
				block: null,
				loading: false,
				notFound: false,
				chainError: 'connection refused',
				coreRpcConfigured: false
			})
		).toBe('Block — needs Bitcoin Core');
	});

	it('falls back to a plain label for a live chain error when Core RPC IS configured', () => {
		expect(
			blockPageTitle({
				block: null,
				loading: false,
				notFound: false,
				chainError: 'connection refused',
				coreRpcConfigured: true
			})
		).toBe('Block');
	});
});
