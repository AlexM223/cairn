import { listCachedPortfolio } from '$lib/server/walletSync';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, depends }) => {
	const userId = locals.user!.id;
	// Cache-first (cairn-2zxt SWR): the list is built SYNCHRONOUSLY from persisted
	// snapshots — no per-wallet gap-limit scan over Electrum, so navigation never
	// blocks (retires the streamed `scans` IIFE of cairn-ybsv/cairn-2zxt.2). The
	// +page.svelte fires each wallet's /refresh endpoint on mount and, once they
	// settle, re-invalidates this tag to pick up the fresh snapshots.
	depends('cairn:wallets');
	const { wallets, errors, multisigs, multisigErrors, lastSyncedAt } =
		listCachedPortfolio(userId);
	return {
		wallets,
		errors,
		multisigs,
		multisigErrors,
		loadError: null as string | null,
		// Oldest sync across all wallets — the freshness the aggregate indicator
		// should honour; null when nothing has synced yet.
		lastSyncedAt
	};
};
