import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const libAlias = path.resolve(import.meta.dirname, 'src/lib');

export default defineConfig({
	test: {
		// Two projects: plain node unit tests (the historical setup, unchanged)
		// and a jsdom + real Svelte compiler project for component-mount tests
		// (added for cairn-et5a0 — a duplicate-each-key bug that only surfaces
		// when a component actually mounts, which node-environment tests can't
		// exercise at all).
		projects: [
			{
				resolve: {
					alias: {
						$lib: libAlias,
						'$env/dynamic/private': path.resolve(import.meta.dirname, 'src/tests/env-stub.ts')
					}
				},
				test: {
					name: 'node',
					// scripts/**/*.test.mjs added for the mining forced-solve harness's
					// pure-logic unit tests (cairn-vn43.2); no bitcoind/docker involved.
					include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
					exclude: ['**/*.dom.test.ts'],
					setupFiles: ['src/tests/setup.ts']
				}
			},
			{
				plugins: [
					svelte({
						compilerOptions: { runes: true },
						preprocess: vitePreprocess()
					})
				],
				resolve: {
					alias: {
						$lib: libAlias,
						'$app/environment': path.resolve(
							import.meta.dirname,
							'src/tests/app-environment-stub.ts'
						)
					},
					// jsdom project: resolve packages (including Svelte itself) via their
					// browser/client build rather than the default node/ssr condition, so
					// `mount()` from 'svelte' is the real client runtime — the server
					// build has no `mount` export and throws instead of ever reaching the
					// each_key_duplicate check this test exists to catch.
					conditions: ['browser']
				},
				test: {
					name: 'dom',
					include: ['src/**/*.dom.test.ts'],
					environment: 'jsdom'
				}
			}
		]
	}
});
