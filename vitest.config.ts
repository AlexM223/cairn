import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve(import.meta.dirname, 'src/lib'),
			'$env/dynamic/private': path.resolve(import.meta.dirname, 'src/tests/env-stub.ts')
		}
	},
	test: {
		// scripts/**/*.test.mjs added for the mining forced-solve harness's
		// pure-logic unit tests (cairn-vn43.2); no bitcoind/docker involved.
		include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
		setupFiles: ['src/tests/setup.ts']
	}
});
