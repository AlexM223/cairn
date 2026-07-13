// Mining-pool identification from a block's coinbase transaction (T-C, cairn-6efi.4).
//
// A block's coinbase carries two fingerprints of who mined it:
//   1. the coinbase input's scriptSig — pools stamp a human-readable tag here
//      (e.g. "Foundry USA Pool", "/ViaBTC/"), and
//   2. the coinbase OUTPUT addresses — the pool's payout address(es).
// We match both against a vendored table (known-pools.json) and return a POSITIVE
// identification only. An unknown coinbase resolves to null: the UI shows nothing
// rather than a wrong pool ("Likely <Pool>" is only ever rendered when we are sure).
//
// ─────────────────────────────────────────────────────────────────────────────
// QUARTERLY REFRESH PROCEDURE (known-pools.json)
// ─────────────────────────────────────────────────────────────────────────────
// The pool landscape drifts — pools rename, rotate payout addresses, appear and
// disappear. Refresh the vendored table about once a quarter:
//
//   1. Fetch the upstream source of truth:
//        https://raw.githubusercontent.com/mempool/mining-pools/master/pools-v2.json
//   2. It uses the SAME schema as known-pools.json:
//        { "coinbase_tags":   { "<tag substring/pattern>": { "name", "link" }, … },
//          "payout_addresses":{ "<address>":               { "name", "link" }, … } }
//   3. We vendor a CURATED SUBSET (top ~25 pools by hashrate) rather than the full
//      file — it keeps the asset small and the match loop cheap on ARM/Umbrel, and
//      the long tail of tiny/defunct pools adds little coverage. Merge new
//      high-hashrate pools in; drop ones that have gone dark. Keep the leading
//      "_comment" key (ignored at load — see below).
//   4. Tag keys wrapped in slashes (e.g. "/ViaBTC/") are mempool's regex markers;
//      we treat them as plain substrings after stripping the slashes, which is
//      sufficient for real coinbase tags and avoids per-block regex compilation.
//   5. Run `npm run test -- pools` — the fixtures assert the well-known tags still
//      resolve. Update fixtures if a canonical name changed.
//
// This module does ZERO network work: it only decodes bytes we were already given
// and looks them up in the in-memory table. All chain calls that produce the
// coinbase (getblock + getrawtransaction) live in chain/index.ts's enrichment path,
// which is immutable-cached by block hash — never in a load().

import { childLogger } from '../logger';
import type { BlockPool } from '$lib/types';
import knownPools from './known-pools.json';

const log = childLogger('pools');

interface PoolEntry {
	name: string;
	link?: string;
}
interface PoolsFile {
	coinbase_tags: Record<string, PoolEntry>;
	payout_addresses: Record<string, PoolEntry>;
}

const pools = knownPools as unknown as PoolsFile;

/** Normalized coinbase-tag matchers, precomputed once. mempool wraps some keys in
 *  `/…/` as regex markers; we strip those and substring-match, which covers real
 *  coinbase stamps without compiling a regex per block. `_comment` and any other
 *  non-object keys are skipped. */
const tagMatchers: { needle: string; pool: PoolEntry }[] = Object.entries(pools.coinbase_tags ?? {})
	.filter(([, v]) => v && typeof v === 'object' && typeof v.name === 'string')
	.map(([key, pool]) => {
		const needle = key.length > 1 && key.startsWith('/') && key.endsWith('/') ? key.slice(1, -1) : key;
		return { needle, pool };
	})
	.filter((m) => m.needle.length > 0);

const payoutAddresses: Record<string, PoolEntry> = pools.payout_addresses ?? {};

/** Decode a coinbase scriptSig hex blob to a printable ASCII string. Pool tags are
 *  plain ASCII embedded in the coinbase; non-printable bytes become spaces so a tag
 *  butted against binary height/extranonce data still matches. */
function coinbaseAscii(coinbaseHex: string): string {
	if (!coinbaseHex) return '';
	let out = '';
	for (let i = 0; i + 1 < coinbaseHex.length; i += 2) {
		const byte = parseInt(coinbaseHex.slice(i, i + 2), 16);
		if (Number.isNaN(byte)) continue;
		out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' ';
	}
	return out;
}

function toBlockPool(entry: PoolEntry): BlockPool {
	return entry.link ? { name: entry.name, link: entry.link } : { name: entry.name };
}

/**
 * Identify the mining pool for a block from its coinbase.
 *
 * @param coinbaseHex   the coinbase input's scriptSig (`vin[0].coinbase`) as hex.
 * @param outputAddrs   the coinbase transaction's output addresses.
 * @returns the matched pool, or null when the coinbase matches no known pool.
 *
 * Payout-address matches are checked first (an exact address is a stronger signal
 * than a substring), then coinbase-tag substrings. Returns on the first hit.
 */
export function identifyPool(
	coinbaseHex: string | null | undefined,
	outputAddrs: (string | null | undefined)[] = []
): BlockPool | null {
	// 1. Payout address — exact, high-confidence.
	for (const addr of outputAddrs) {
		if (!addr) continue;
		const hit = payoutAddresses[addr];
		if (hit) return toBlockPool(hit);
	}

	// 2. Coinbase tag — substring of the decoded scriptSig ASCII.
	const ascii = coinbaseAscii(coinbaseHex ?? '');
	if (ascii) {
		for (const { needle, pool } of tagMatchers) {
			if (ascii.includes(needle)) return toBlockPool(pool);
		}
	}

	return null;
}

/** Count of loaded pool matchers — surfaced for the loaded-table sanity check. */
export function poolTableSize(): number {
	return tagMatchers.length + Object.keys(payoutAddresses).length;
}

// A malformed vendored file would silently disable pool ID; log once at load so an
// operator sees it rather than wondering why every block shows no pool.
if (tagMatchers.length === 0 && Object.keys(payoutAddresses).length === 0) {
	log.warn('known-pools.json produced no matchers — pool identification disabled');
}
