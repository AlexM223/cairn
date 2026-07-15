// Guards the pre-paint theme bootstrap inline script in src/app.html
// (cairn-sdx5.7): it reads localStorage 'hw.theme' and — synchronously,
// before the stylesheet paints — sets documentElement's data-theme attribute
// so there's no flash of the wrong theme. There's no jsdom/happy-dom
// dependency in this repo (see qrScannerLogic.test.ts's note), so rather than
// mounting a real DOM we extract the actual script text out of app.html and
// run it in a Node `vm` sandbox against a minimal documentElement/localStorage
// stub — this exercises the real shipped source, not a reimplementation of it.
//
// Also regression-guards cairn-sdx5.10/cairn-iad9: SvelteKit's %sveltekit.*%
// template substitution is a first-match-only string replace, so a second
// literal copy of a placeholder token earlier in app.html silently steals the
// substitution meant for the real spot. Asserting exactly one occurrence of
// each placeholder catches that class of bug even if nobody touches this
// script again.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const APP_HTML_PATH = path.resolve(import.meta.dirname, '../app.html');
const appHtml = fs.readFileSync(APP_HTML_PATH, 'utf-8');

function extractThemeBootstrapScript(html: string): string {
	const match = html.match(/<script>([\s\S]*?)<\/script>/);
	if (!match) throw new Error('app.html: no inline <script> found to extract the theme bootstrap from');
	return match[1];
}

// A minimal documentElement stand-in: the real script only ever calls
// setAttribute('data-theme', …), so this mirrors just enough of the
// attribute/dataset relationship (data-theme <-> dataset.theme) to observe it.
function makeFakeDocumentElement() {
	const dataset: Record<string, string> = {};
	return {
		dataset,
		setAttribute(name: string, value: string) {
			if (name === 'data-theme') dataset.theme = value;
		}
	};
}

function runThemeBootstrap(storedValue: string | null): Record<string, string> {
	const documentElement = makeFakeDocumentElement();
	const localStorageStub = {
		getItem(key: string) {
			return key === 'hw.theme' ? storedValue : null;
		}
	};
	const context = vm.createContext({
		document: { documentElement },
		localStorage: localStorageStub
	});
	vm.runInContext(extractThemeBootstrapScript(appHtml), context);
	return documentElement.dataset;
}

describe('app.html theme bootstrap script (pre-paint, cairn-sdx5.7)', () => {
	let script: string;

	beforeAll(() => {
		script = extractThemeBootstrapScript(appHtml);
	});

	it('extracts a non-empty inline script from app.html', () => {
		expect(script.trim().length).toBeGreaterThan(0);
	});

	it("sets data-theme to 'light' when localStorage holds 'light'", () => {
		expect(runThemeBootstrap('light').theme).toBe('light');
	});

	it("sets data-theme to 'dark' when localStorage holds 'dark'", () => {
		expect(runThemeBootstrap('dark').theme).toBe('dark');
	});

	it('leaves data-theme unset when there is no stored value (falls through to prefers-color-scheme)', () => {
		expect(runThemeBootstrap(null).theme).toBeUndefined();
	});

	it("leaves data-theme unset for a stored value that isn't 'dark'/'light' (e.g. 'system')", () => {
		expect(runThemeBootstrap('system').theme).toBeUndefined();
	});
});

describe('app.html SvelteKit placeholders (regression guard for cairn-sdx5.10/cairn-iad9)', () => {
	it('contains exactly one literal %sveltekit.head% (a second copy would steal the first-match-only substitution)', () => {
		const occurrences = appHtml.match(/%sveltekit\.head%/g) ?? [];
		expect(occurrences).toHaveLength(1);
	});

	it('contains exactly one literal %sveltekit.body%', () => {
		const occurrences = appHtml.match(/%sveltekit\.body%/g) ?? [];
		expect(occurrences).toHaveLength(1);
	});
});
