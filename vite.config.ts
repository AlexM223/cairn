import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	server: {
		port: Number(process.env.PORT) || 5173
	},
	build: {
		// bitbox-api's WASM glue uses top-level await. Every browser Cairn can
		// actually run in supports TLA natively (hardware signing needs
		// WebUSB/WebHID, which set a far higher floor), so emit it as-is instead
		// of down-leveling. This also sidesteps vite-plugin-top-level-await,
		// whose esbuild re-transform of rolldown output breaks the prod build.
		target: 'esnext'
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
		],
		// bitbox-api is a Rust core compiled to WASM with generated TS bindings
		// (src/lib/hw/bitbox02.ts loads it lazily). WASM packages must NOT be
		// esbuild-prebundled — vite-plugin-wasm handles the .wasm asset itself.
		exclude: ['bitbox-api']
	},
	plugins: [
		// Required by bitbox-api's WASM bindings (see its README-npm.md): the
		// glue module uses top-level await around the wasm instantiation —
		// supported natively via build.target 'esnext' above.
		wasm(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: adapter(),

			// CSP (cairn-ed01, fixing cairn-ia2y/25c9a8f). SvelteKit always injects its
			// own inline hydration-bootstrap `<script>` into every rendered page — its
			// contents are per-response-dynamic (embeds page data), so no fixed hash
			// can allow-list it. A `script-src 'self'` CSP with no nonce/hash blocks
			// that script outright, which is exactly what 25c9a8f shipped: hydration
			// silently never ran, on every page, in every deployment. `mode: 'auto'`
			// is SvelteKit's own fix for this — it stamps a per-response nonce onto
			// that generated script and the matching `Content-Security-Policy` header
			// itself (no app.html change needed; nothing here is prerendered today,
			// but 'auto' also covers that case with a hash instead of a nonce). The
			// directives below are the same set as the `CSP` constant in
			// src/hooks.server.ts — that copy is now only the fallback for responses
			// that never go through SvelteKit's page-render pipeline (assets,
			// +server.ts endpoints), so keep the two lists in sync if either changes.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'connect-src': ['self'],
					'frame-ancestors': ['none'],
					'base-uri': ['self'],
					'form-action': ['self']
				}
			}
		})
	]
});
