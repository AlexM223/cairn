import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { scanWallet } from '$lib/server/bitcoin/walletScan';
import type { RequestHandler } from './$types';

/**
 * Portfolio summary across the user's wallets. Lives on its own endpoint so
 * new-block refreshes of the dashboard's chain data don't force a rescan of
 * every wallet — the client fetches this independently.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);

	const wallets = db
		.prepare('SELECT id, name, xpub FROM wallets WHERE user_id = ? ORDER BY created_at ASC')
		.all(user.id) as { id: number; name: string; xpub: string }[];

	if (wallets.length === 0) return json({ portfolio: null });

	// Scans are independent and cached per-xpub — run them concurrently so
	// dashboard latency doesn't grow linearly with wallet count.
	const scans = await Promise.all(
		wallets.map((w) =>
			scanWallet(w.xpub).then(
				(scan) => ({ ok: true as const, scan }),
				() => ({ ok: false as const })
			)
		)
	);

	let confirmed = 0;
	let unconfirmed = 0;
	let reachable = 0;
	for (const result of scans) {
		if (!result.ok) continue;
		confirmed += result.scan.confirmed;
		unconfirmed += result.scan.unconfirmed;
		reachable++;
	}

	return json({
		portfolio: {
			walletCount: wallets.length,
			scannedCount: reachable,
			confirmed,
			unconfirmed
		}
	});
};
