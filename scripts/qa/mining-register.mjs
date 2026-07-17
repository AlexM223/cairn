// Registers the .ts resolve hook (mining-ts-loader.mjs) into the module system.
// Passed to node via `--import` so the hook is active before any harness code
// runs: `node --experimental-transform-types --import ./scripts/qa/mining-register.mjs ...`.
import { register } from 'node:module';

register(new URL('./mining-ts-loader.mjs', import.meta.url));
