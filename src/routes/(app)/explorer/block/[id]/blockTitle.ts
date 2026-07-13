import { formatNumber } from '$lib/format';

export interface BlockTitleState {
	block: { height: number } | null;
	loading: boolean;
	notFound: boolean;
	chainError: string | null;
	coreRpcConfigured: boolean;
}

/** Page <title> for the block detail page. Mirrors the body's own state
 *  machine (see +page.svelte): loading skeleton / genuine not-found / the
 *  honest "needs Bitcoin Core" notice / a live chain error / the found block.
 *  Kept consistent with the tx detail page's txPageTitle so neither page's
 *  tab title can drift from what the body actually renders. */
export function blockPageTitle({
	block,
	loading,
	notFound,
	chainError,
	coreRpcConfigured
}: BlockTitleState): string {
	if (block) return `Block ${formatNumber(block.height)}`;
	if (loading) return 'Loading block';
	if (notFound) return 'Block not found';
	if (chainError && !coreRpcConfigured) return 'Block — needs Bitcoin Core';
	return 'Block';
}
