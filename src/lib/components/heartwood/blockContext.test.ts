// Unit tests for the pure block-context copy/badge helpers
// (docs/TX-BLOCK-CONTEXT-DESIGN.md §9 "Unit (pure)"). No Svelte, no chain.

import { describe, it, expect } from 'vitest';
import { summaryLine, confirmationBadge } from './blockContext';
import type { BlockContext } from '$lib/types';

/** A confirmed full-tier context; override per case. */
function ctx(over: Partial<BlockContext> = {}): BlockContext {
	return {
		richness: 'full',
		confirmed: true,
		height: 948_197,
		confirmations: 98, // 97 blocks ago
		tipHeight: 948_294,
		position: 42,
		positionTotal: 2_500,
		positionEstimated: false,
		neighbors: [],
		vsize: 110,
		fee: 224,
		feeRate: 2,
		coreConfigured: true,
		...over
	};
}

describe('summaryLine', () => {
	it('full tier: blocks-ago, height, size, fee rate and fee', () => {
		expect(summaryLine(ctx())).toBe(
			'Confirmed 97 blocks ago on block 948,197. With a size of 110 vB and a fee rate of 2 sat/vB, paying a 224 sat fee.'
		);
	});

	it('basic tier (no fee/feeRate) drops the fee clauses but keeps the known vsize', () => {
		expect(summaryLine(ctx({ richness: 'basic', fee: null, feeRate: null }))).toBe(
			'Confirmed 97 blocks ago on block 948,197. With a size of 110 vB.'
		);
	});

	it('basic tier with nothing but the block keeps a clean sentence', () => {
		expect(summaryLine(ctx({ richness: 'basic', vsize: null, fee: null, feeRate: null }))).toBe(
			'Confirmed 97 blocks ago on block 948,197.'
		);
	});

	it('single confirmation reads as the latest block', () => {
		expect(summaryLine(ctx({ confirmations: 1, vsize: null, fee: null, feeRate: null }))).toBe(
			'Confirmed in the latest block, 948,197.'
		);
	});

	it('unconfirmed reads as waiting in the mempool', () => {
		expect(summaryLine(ctx({ confirmed: false, richness: 'basic' }))).toBe(
			'Waiting in the mempool — not in a block yet.'
		);
	});

	it('missing vsize but present fee still names the fee', () => {
		expect(summaryLine(ctx({ vsize: null, feeRate: null, fee: 224 }))).toBe(
			'Confirmed 97 blocks ago on block 948,197. It paid a 224 sat fee.'
		);
	});

	it('singular "block ago" at two confirmations', () => {
		expect(summaryLine(ctx({ confirmations: 2, vsize: null, fee: null, feeRate: null }))).toBe(
			'Confirmed 1 block ago on block 948,197.'
		);
	});
});

describe('confirmationBadge', () => {
	it('unconfirmed → amber "Unconfirmed"', () => {
		expect(confirmationBadge(ctx({ confirmed: false }))).toEqual({
			label: 'Unconfirmed',
			tone: 'unconfirmed'
		});
	});

	it('one confirmation → neutral singular', () => {
		expect(confirmationBadge(ctx({ confirmations: 1 }))).toEqual({
			label: '1 confirmation',
			tone: 'partial'
		});
	});

	it('five confirmations → neutral plural (still burying)', () => {
		expect(confirmationBadge(ctx({ confirmations: 5 }))).toEqual({
			label: '5 confirmations',
			tone: 'partial'
		});
	});

	it('exactly six → green "6+ confirmations" (settled threshold)', () => {
		expect(confirmationBadge(ctx({ confirmations: 6 }))).toEqual({
			label: '6+ confirmations',
			tone: 'sealed'
		});
	});

	it('many → still green "6+ confirmations"', () => {
		expect(confirmationBadge(ctx({ confirmations: 100 }))).toEqual({
			label: '6+ confirmations',
			tone: 'sealed'
		});
	});

	it('confirmed flag but zero confirmations → treated as unconfirmed', () => {
		expect(confirmationBadge(ctx({ confirmed: true, confirmations: 0 }))).toEqual({
			label: 'Unconfirmed',
			tone: 'unconfirmed'
		});
	});
});
