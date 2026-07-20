/** Barrel for the SV2 listener (plan §a.8) — the only import surface
 *  mining/miningPool.ts and mining/index.ts need from sv2/. */
export { Sv2Server, SV2_ERRORS } from './sv2Server';
export type { Sv2ServerOptions, Sv2AuthorityMaterial } from './sv2Server';
