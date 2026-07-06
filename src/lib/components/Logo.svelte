<script lang="ts">
	let { size = 24, wordmark = false }: { size?: number; wordmark?: boolean } = $props();
</script>

<span class="logo" style:gap="{Math.round(size * 0.42)}px">
	<svg
		width={size}
		height={size}
		viewBox="0 0 32 32"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
	>
		<rect x="11.5" y="3.5" width="10" height="6.5" rx="3.25" fill="var(--accent)" />
		<rect x="8.5" y="12.5" width="15" height="7" rx="3.5" fill="var(--accent)" />
		<rect x="5" y="22" width="22" height="7.5" rx="3.75" fill="var(--accent)" />
	</svg>
	{#if wordmark}
		<span class="wordmark" style:font-size="{Math.round(size * 0.78)}px">Cairn</span>
	{/if}
</span>

<style>
	.logo {
		display: inline-flex;
		align-items: center;
		line-height: 1;
	}

	.wordmark {
		font-family: var(--font-serif);
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}
</style>
