import { describe, it, expect } from 'vitest';
import { isCompleteSearchCandidate, HEIGHT_RE, HEX64_RE } from './searchShape';

// cairn-ioeg5: the Explorer search bar's live-suggestion dropdown must tell
// "still typing" apart from "complete candidate the backend couldn't
// resolve" — otherwise a genuinely nonexistent-but-well-formed txid gets the
// same "keep typing" hint as a 3-char fragment, an apparent dead end.
describe('isCompleteSearchCandidate', () => {
	it('is false for short fragments (still typing)', () => {
		expect(isCompleteSearchCandidate('a')).toBe(false);
		expect(isCompleteSearchCandidate('abc123')).toBe(false);
		expect(isCompleteSearchCandidate('f'.repeat(20))).toBe(false);
	});

	it('is false for garbage text', () => {
		expect(isCompleteSearchCandidate('what is bitcoin')).toBe(false);
	});

	it('is false for the empty/whitespace-only query', () => {
		expect(isCompleteSearchCandidate('')).toBe(false);
		expect(isCompleteSearchCandidate('   ')).toBe(false);
	});

	it('is true for a complete 64-hex candidate (the bead repro: 64x "f")', () => {
		expect(isCompleteSearchCandidate('f'.repeat(64))).toBe(true);
	});

	it('is true for a complete 64-hex candidate regardless of case', () => {
		expect(isCompleteSearchCandidate('A'.repeat(64))).toBe(true);
	});

	it('is true for a plain block-height candidate', () => {
		expect(isCompleteSearchCandidate('900002')).toBe(true);
	});

	it('trims surrounding whitespace before testing', () => {
		expect(isCompleteSearchCandidate(`  ${'f'.repeat(64)}  `)).toBe(true);
		expect(isCompleteSearchCandidate('  800000  ')).toBe(true);
	});

	it('is false for a too-long numeric string (not a plausible height)', () => {
		expect(isCompleteSearchCandidate('1234567890')).toBe(false);
	});

	it('stays in lockstep with the regexes classifySearch() imports from here', () => {
		expect(HEIGHT_RE.test('800000')).toBe(true);
		expect(HEX64_RE.test('f'.repeat(64))).toBe(true);
	});
});
