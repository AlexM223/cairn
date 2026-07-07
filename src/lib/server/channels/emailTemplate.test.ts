import { describe, it, expect } from 'vitest';
import { renderEmail, renderText, renderHtml } from './emailTemplate';

describe('email template (cairn-5gpv.2)', () => {
	const base = {
		title: 'Payment received',
		body: '0.01 BTC to Savings',
		link: 'https://cairn.example/wallets/3',
		level: 'info' as const
	};

	it('renders both a text and an html alternative', () => {
		const { text, html } = renderEmail(base);
		expect(text).toContain('Payment received');
		expect(text).toContain('0.01 BTC to Savings');
		expect(text).toContain('https://cairn.example/wallets/3');
		expect(html).toContain('<html');
		expect(html).toContain('Heartwood'); // branded header
	});

	it('includes a View in Heartwood button linking the absolute url when a link is present', () => {
		const html = renderHtml(base);
		expect(html).toContain('View in Heartwood');
		expect(html).toContain('href="https://cairn.example/wallets/3"');
	});

	it('omits the button when there is no link', () => {
		const html = renderHtml({ ...base, link: null });
		expect(html).not.toContain('View in Heartwood');
	});

	it('text alternative omits the link line when there is no link (PGP-path parity)', () => {
		const text = renderText({ ...base, link: null });
		expect(text).toBe('Payment received\n\n0.01 BTC to Savings');
	});

	it('escapes html-special characters in the body', () => {
		const html = renderHtml({ ...base, body: 'a < b & c > d "q"' });
		expect(html).toContain('a &lt; b &amp; c &gt; d &quot;q&quot;');
		expect(html).not.toContain('a < b & c > d "q"');
	});

	it('uses an urgent accent colour for warn/error levels', () => {
		const warn = renderHtml({ ...base, level: 'warn' });
		const info = renderHtml(base);
		expect(warn).not.toBe(info); // different accent stripe/button colour
	});
});
