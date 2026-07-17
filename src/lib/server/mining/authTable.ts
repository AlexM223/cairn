/**
 * In-memory authorization snapshot for the Stratum engine (implements
 * AuthProvider). The engine calls {@link AuthTable.resolve} INSIDE the socket
 * data handler, so it must be a pure synchronous Map lookup with zero I/O — all
 * the real work (DB reads, per-wallet address derivation, which can touch the
 * chain backend) happens out of band in {@link refreshAuthTable}, driven by the
 * lifecycle (engine start, a 60s timer, and the prefs-change hook).
 *
 * Build rule: one entry per enabled mining_prefs row that has a valid, payable
 * payout wallet. A per-user failure (missing wallet, unencodable address, a
 * chain hiccup while peeking the receive address) is logged and that user is
 * skipped — the refresh NEVER throws and never lets one bad row drop everyone.
 */
import { db } from '../db';
import { getWallet, peekReceiveAddress } from '../wallets';
import { getChainConfig } from '../settings';
import { childLogger } from '../logger';
import { addressToOutputScript, networkFor } from './address';
import type { AuthProvider, MinerAuth } from './types';

const log = childLogger('mining:auth');

class AuthTable implements AuthProvider {
	private map = new Map<string, MinerAuth>();

	/** Pure, synchronous, zero-I/O — safe to call on the Stratum hot path. */
	resolve(miningId: string): MinerAuth | null {
		return this.map.get(miningId) ?? null;
	}

	/** Atomically swap in a freshly built snapshot (never mutate the live map in
	 *  place — resolve() must always see a consistent set). */
	replace(next: Map<string, MinerAuth>): void {
		this.map = next;
	}

	get size(): number {
		return this.map.size;
	}

	/** Snapshot of the currently authorized (userId, miningId, walletId, address)
	 *  tuples, for read models / admin views. */
	entries(): MinerAuth[] {
		return [...this.map.values()];
	}
}

const authTable = new AuthTable();

/** The process-wide AuthProvider the MiningPool is constructed with. */
export function getAuthTable(): AuthTable {
	return authTable;
}

interface EnabledPrefsRow {
	user_id: number;
	mining_id: string;
	payout_wallet_id: number | null;
}

/**
 * Rebuild the snapshot from the current DB state. Async because peeking a
 * wallet's receive address can hit the chain backend; this is deliberately off
 * the socket path. Builds into a fresh Map and swaps it in atomically at the
 * end, so a resolve() concurrent with a rebuild always sees either the old or
 * the new complete set, never a half-built one.
 */
export async function refreshAuthTable(): Promise<void> {
	const network = networkFor(getChainConfig().network);
	let rows: EnabledPrefsRow[];
	try {
		rows = db
			.prepare(
				`SELECT user_id, mining_id, payout_wallet_id
				   FROM mining_prefs
				  WHERE enabled = 1 AND mining_id IS NOT NULL AND payout_wallet_id IS NOT NULL`
			)
			.all() as unknown as EnabledPrefsRow[];
	} catch (e) {
		log.error({ err: e }, 'authTable refresh: failed to read mining_prefs; keeping current snapshot');
		return;
	}

	const next = new Map<string, MinerAuth>();
	for (const row of rows) {
		try {
			const wallet = getWallet(row.user_id, row.payout_wallet_id!);
			if (!wallet) {
				log.warn({ userId: row.user_id, walletId: row.payout_wallet_id }, 'payout wallet missing; skipping miner');
				continue;
			}
			const peek = await peekReceiveAddress(wallet);
			const script = addressToOutputScript(peek.address, network);
			next.set(row.mining_id, {
				userId: row.user_id,
				miningId: row.mining_id,
				walletId: wallet.id,
				address: peek.address,
				payoutScript: new Uint8Array(script)
			});
		} catch (e) {
			// One user's failure never aborts the rebuild or drops other miners.
			log.warn({ err: e, userId: row.user_id }, 'authTable refresh: skipping miner (build failed)');
		}
	}
	authTable.replace(next);
	log.info({ miners: next.size }, 'authTable rebuilt');
}
