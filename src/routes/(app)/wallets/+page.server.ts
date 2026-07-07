import { listWallets } from '$lib/server/wallets';
import { listMultisigSummaries } from '$lib/server/multisigScan';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const userId = locals.user!.id;
	return {
		// Streamed, not awaited (cairn-ybsv): a cold/stale scan cache means a full
		// gap-limit pass over Electrum for every wallet — navigation must not hang
		// on that. The page paints skeleton cards immediately and fills in when
		// the scans resolve. Both scanners tolerate per-item failures (errors
		// maps); the defensive catch below keeps a streamed rejection from ever
		// surfacing as an unhandled error.
		scans: (async () => {
			try {
				const [{ wallets, errors }, { multisigs, errors: multisigErrors }] = await Promise.all([
					listWallets(userId),
					listMultisigSummaries(userId)
				]);
				return { wallets, errors, multisigs, multisigErrors, loadError: null as string | null };
			} catch (e) {
				return {
					wallets: [] as Awaited<ReturnType<typeof listWallets>>['wallets'],
					errors: {} as Record<number, string>,
					multisigs: [] as Awaited<ReturnType<typeof listMultisigSummaries>>['multisigs'],
					multisigErrors: {} as Record<number, string>,
					loadError: e instanceof Error ? e.message : 'Could not load your wallets.'
				};
			}
		})()
	};
};
