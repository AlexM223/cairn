import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifySearch } from './search';

// classifySearch resolves the chain via getChain(); stub the whole chain
// module so no settings/db/network code loads.
const mockChain = {
	getTip: vi.fn<() => Promise<{ height: number }>>(),
	getTx: vi.fn<(txid: string) => Promise<unknown>>(),
	getBlock: vi.fn<(hash: string) => Promise<unknown>>()
};

vi.mock('$lib/server/chain', () => ({
	getChain: () => mockChain
}));

const TXID_LIKE = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const BLOCKHASH_LIKE = '000000000000000000026b8e4f5c4f0d1a7a52bb90e6bcedb37c9a53f4f9e8a1';

beforeEach(() => {
	vi.resetAllMocks();
	mockChain.getTip.mockResolvedValue({ height: 900000 });
	mockChain.getTx.mockRejectedValue(new Error('Transaction not found'));
	mockChain.getBlock.mockRejectedValue(new Error('Block not found'));
});

describe('classifySearch — block heights', () => {
	it('classifies a plain number at or below the tip as block-height', async () => {
		const res = await classifySearch('800000');
		expect(res).toEqual({
			type: 'block-height',
			redirect: '/explorer/block/800000',
			query: '800000'
		});
	});

	it('accepts tip + 1 (a block that may just have been found)', async () => {
		const res = await classifySearch('900001');
		expect(res.type).toBe('block-height');
		expect(res.redirect).toBe('/explorer/block/900001');
	});

	it('rejects heights beyond tip + 1', async () => {
		const res = await classifySearch('900002');
		expect(res).toEqual({ type: 'unknown', redirect: null, query: '900002' });
	});

	it('classifies optimistically as block-height when the tip is unreachable', async () => {
		mockChain.getTip.mockRejectedValue(new Error('down'));
		const res = await classifySearch('123456');
		expect(res.type).toBe('block-height');
	});

	it('trims whitespace around the query', async () => {
		const res = await classifySearch('  800000  ');
		expect(res.type).toBe('block-height');
		expect(res.query).toBe('800000');
	});
});

describe('classifySearch — 64-hex ids', () => {
	it('classifies 8+ leading zero nibbles as block-hash without a chain lookup', async () => {
		const res = await classifySearch(BLOCKHASH_LIKE);
		expect(res.type).toBe('block-hash');
		expect(res.redirect).toBe(`/explorer/block/${BLOCKHASH_LIKE}`);
		expect(mockChain.getTx).not.toHaveBeenCalled();
		expect(mockChain.getBlock).not.toHaveBeenCalled();
	});

	it('lowercases uppercase hex in the redirect', async () => {
		const res = await classifySearch(BLOCKHASH_LIKE.toUpperCase());
		expect(res.type).toBe('block-hash');
		expect(res.redirect).toBe(`/explorer/block/${BLOCKHASH_LIKE}`);
	});

	it('classifies as tx when getTx resolves', async () => {
		mockChain.getTx.mockResolvedValue({ txid: TXID_LIKE });
		const res = await classifySearch(TXID_LIKE);
		expect(res.type).toBe('tx');
		expect(res.redirect).toBe(`/explorer/tx/${TXID_LIKE}`);
		expect(mockChain.getTx).toHaveBeenCalledWith(TXID_LIKE);
	});

	it('falls back to block-hash when getTx fails but getBlock resolves', async () => {
		mockChain.getBlock.mockResolvedValue({ hash: TXID_LIKE });
		const res = await classifySearch(TXID_LIKE);
		expect(res.type).toBe('block-hash');
		expect(res.redirect).toBe(`/explorer/block/${TXID_LIKE}`);
	});

	it('is unknown when neither tx nor block resolve', async () => {
		const res = await classifySearch(TXID_LIKE);
		expect(res).toEqual({ type: 'unknown', redirect: null, query: TXID_LIKE });
	});
});

describe('classifySearch — addresses and garbage', () => {
	it('classifies a valid bech32 address', async () => {
		const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
		const res = await classifySearch(addr);
		expect(res).toEqual({ type: 'address', redirect: `/explorer/address/${addr}`, query: addr });
	});

	it('classifies a valid legacy address', async () => {
		const addr = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
		const res = await classifySearch(addr);
		expect(res.type).toBe('address');
	});

	it('returns unknown for garbage', async () => {
		const res = await classifySearch('what is bitcoin');
		expect(res).toEqual({ type: 'unknown', redirect: null, query: 'what is bitcoin' });
	});

	it('returns unknown for empty and whitespace-only queries', async () => {
		expect(await classifySearch('')).toEqual({ type: 'unknown', redirect: null, query: '' });
		expect(await classifySearch('   ')).toEqual({ type: 'unknown', redirect: null, query: '' });
	});
});
