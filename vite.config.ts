import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		port: Number(process.env.PORT) || 5173
	},
	optimizeDeps: {
		// The Ledger driver (src/lib/hw/ledger.ts) and everything under it — the
		// @ledgerhq client modules plus the CJS bitcoinjs-lib / events / buffer
		// chain they pull in — are reachable ONLY through dynamic import() on the
		// first "Connect Ledger" click. Left to discovery, Vite meets ~10 new
		// dependencies mid-session, re-optimizes, and the in-flight dynamic import
		// dies with 504 "Outdated Optimize Dep" (surfaced in the browser as
		// "Failed to fetch dynamically imported module: …/src/lib/hw/ledger.ts").
		// Pre-bundle the whole graph at server start instead. `buffer` is also the
		// polyfill ledger.ts installs as the global Buffer for those libraries.
		include: [
			'@ledgerhq/hw-transport-webhid',
			'@ledgerhq/hw-app-btc/lib/newops/appClient',
			'@ledgerhq/hw-app-btc/lib/newops/policy',
			'@ledgerhq/hw-app-btc/lib/newops/clientCommands',
			'@ledgerhq/hw-app-btc/lib/newops/merkle',
			'@ledgerhq/hw-app-btc/lib/varint',
			'@ledgerhq/psbtv2',
			'buffer',
			'@scure/btc-signer',
			'@scure/base',
			'@scure/bip32',
			'@noble/hashes/sha2.js',
			'@noble/hashes/utils.js',
			// Trezor Connect is loaded through the same lazy-import pattern and
			// would hit the identical first-click re-optimization otherwise.
			'@trezor/connect-web'
		]
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter()
		})
	]
});
