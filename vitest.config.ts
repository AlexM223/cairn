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
		include: ['src/**/*.test.ts'],
		setupFiles: ['src/tests/setup.ts']
	}
});
