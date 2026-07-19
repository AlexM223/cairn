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

	// Regression coverage for cairn-37gfa: a syntactically valid txid must route
	// to the tx page even when the backend can't confirm it exists — e.g. a
	// public Electrum server (Blockstream's included) rejecting verbose calls,
	// or an unconfigured Core RPC. Only a genuine "not found" should fall
	// through to the block-hash lookup below.
	describe('cairn-37gfa — non-not-found getTx errors still route to tx', () => {
		it('routes to tx (not unknown) when getTx fails with an Electrum verbose-unsupported error', async () => {
			mockChain.getTx.mockRejectedValue(
				new Error('verbose transactions are currently unsupported')
			);
			const res = await classifySearch(TXID_LIKE);
			expect(res.type).toBe('tx');
			expect(res.redirect).toBe(`/explorer/tx/${TXID_LIKE}`);
			// Must not have fallen through to a block-hash lookup.
			expect(mockChain.getBlock).not.toHaveBeenCalled();
		});

		it('routes to tx even when the block-hash fallback would have resolved', async () => {
			// Guards against a regression that keeps trying getBlock() as a
			// fallback for ANY getTx error instead of only genuine misses.
			mockChain.getTx.mockRejectedValue(new Error('verbose transactions are currently unsupported'));
			mockChain.getBlock.mockResolvedValue({ hash: TXID_LIKE });
			const res = await classifySearch(TXID_LIKE);
			expect(res.type).toBe('tx');
			expect(mockChain.getBlock).not.toHaveBeenCalled();
		});

		it('still falls through to block-hash / unknown on a genuine not-found error', async () => {
			mockChain.getTx.mockRejectedValue(new Error('Transaction not found'));
			const res = await classifySearch(TXID_LIKE);
			expect(res.type).toBe('unknown');
			expect(mockChain.getBlock).toHaveBeenCalledWith(TXID_LIKE);
		});

		it('reproduces the bead: real mainnet txid misrouted against a verbose-unsupported Electrum backend', async () => {
			const reproTxid = '68f71dcb03ce2f7c7034d89c86ea61dbdbc52f4c2b486aa78fe760a4072db3e0';
			mockChain.getTx.mockRejectedValue(
				new Error('verbose transactions are currently unsupported')
			);
			const res = await classifySearch(reproTxid);
			expect(res).toEqual({
				type: 'tx',
				redirect: `/explorer/tx/${reproTxid}`,
				query: reproTxid
			});
		});
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

// The persistent search pill (cairn-6efi.9) lives on every explorer page —
// including on testnet/regtest dev + QA instances — so its routing must resolve
// the same non-mainnet and taproot addresses the address page itself accepts
// (regression guard for cairn-i8vr, where the pill returned "unknown" for a
// valid testnet address that /explorer/address/<addr> rendered fine).
describe('classifySearch — persistent pill routing across networks', () => {
	it('routes a testnet (tb1) v0 address to the address page', async () => {
		const addr = 'tb1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5r7fxez';
		const res = await classifySearch(addr);
		expect(res).toEqual({ type: 'address', redirect: `/explorer/address/${addr}`, query: addr });
	});

	it('routes a regtest (bcrt1) v0 address to the address page', async () => {
		const addr = 'bcrt1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5phstwt';
		const res = await classifySearch(addr);
		expect(res.type).toBe('address');
		expect(res.redirect).toBe(`/explorer/address/${addr}`);
	});

	it('routes a taproot (bech32m v1) address to the address page', async () => {
		const addr = 'bc1pqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rusqwk0jyn';
		const res = await classifySearch(addr);
		expect(res.type).toBe('address');
		expect(res.redirect).toBe(`/explorer/address/${addr}`);
	});

	it('resolves address classification without any chain round-trip', async () => {
		// The pill must never block first paint on chain calls for a plainly-valid
		// address — routing is purely syntactic (no getTip/getTx/getBlock).
		await classifySearch('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
		expect(mockChain.getTip).not.toHaveBeenCalled();
		expect(mockChain.getTx).not.toHaveBeenCalled();
		expect(mockChain.getBlock).not.toHaveBeenCalled();
	});
});
