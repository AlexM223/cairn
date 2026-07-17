// ESM resolve hook: let plain .mjs harnesses import the REAL TypeScript mining
// engine (src/lib/server/mining/*.ts) directly, so the QA drivers exercise the
// exact production job builder / Stratum server / coordinator rather than a
// reimplementation.
//
// Node's native TS support (--experimental-transform-types, which also handles
// tipPoller.ts's parameter-property constructor) strips the types, but it will
// NOT resolve TypeScript's extensionless relative imports (`from './job'`).
// This hook appends `.ts` for extensionless relative specifiers that resolve to
// a real .ts file on disk; everything else falls through to the default
// resolver. Registered by mining-register.mjs.
import { existsSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
	if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
		try {
			const candidate = new URL(specifier + '.ts', context.parentURL);
			if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
		} catch {
			/* fall through to the default resolver */
		}
	}
	return nextResolve(specifier, context);
}
