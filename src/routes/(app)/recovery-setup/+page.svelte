<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import CopyText from '$lib/components/CopyText.svelte';

	let { data } = $props();

	// --- wizard state ---------------------------------------------------------
	// Two guided steps: (1) the recovery PHRASE behind a "written it down" gate,
	// then (2) the one-time recovery CODES with a download. A secret is fetched
	// (and thereby generated) at most once and held only in memory for the life
	// of this page — reloading throws it away, which is why the copy hammers
	// "you will not see this again".
	type Step = 'phrase' | 'codes' | 'done';
	let step = $state<Step>('phrase');

	const steps = [
		{ key: 'phrase', label: 'Recovery phrase' },
		{ key: 'codes', label: 'Recovery codes' },
		{ key: 'done', label: 'Done' }
	];

	let error = $state<string | null>(null);

	// Phrase step
	let phrase = $state<string | null>(null);
	let phraseWords = $derived(phrase ? phrase.split(' ') : []);
	let loadingPhrase = $state(false);
	let wroteItDown = $state(false); // the gate: step 1 can't advance until checked

	// Codes step
	let codes = $state<string[] | null>(null);
	let loadingCodes = $state(false);
	let downloaded = $state(false);

	async function generatePhrase() {
		if (phrase || loadingPhrase) return; // generate ONCE
		error = null;
		loadingPhrase = true;
		try {
			const res = await fetch('/api/auth/recovery/phrase', { method: 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok || !body?.phrase) throw new Error(body?.error || 'Could not generate a phrase.');
			phrase = body.phrase as string;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not generate a phrase.';
		} finally {
			loadingPhrase = false;
		}
	}

	async function generateCodes() {
		if (codes || loadingCodes) return; // generate ONCE
		error = null;
		loadingCodes = true;
		try {
			const res = await fetch('/api/auth/recovery/codes', { method: 'POST' });
			const body = await res.json().catch(() => null);
			if (!res.ok || !Array.isArray(body?.codes)) throw new Error(body?.error || 'Could not generate codes.');
			codes = body.codes as string[];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not generate codes.';
		} finally {
			loadingCodes = false;
		}
	}

	function toPhraseStep() {
		step = 'phrase';
		error = null;
		generatePhrase();
	}

	function toCodesStep() {
		if (!wroteItDown) return;
		step = 'codes';
		error = null;
		generateCodes();
	}

	function copyAllCodes() {
		if (!codes) return;
		navigator.clipboard.writeText(codes.join('\n'));
	}

	function downloadCodes() {
		if (!codes) return;
		const stamp = new Date().toISOString().slice(0, 10);
		const lines = [
			'Cairn account recovery codes',
			'============================',
			'',
			'These codes get you back INTO your Cairn account (your LOGIN) if you',
			'lose every passkey. Each code works ONCE.',
			'',
			'They are NOT bitcoin keys. They can never move, spend, or reveal any',
			'bitcoin — your bitcoin keys live on your hardware wallet, untouched by',
			'anything here. Store these separately from your hardware-wallet backup;',
			'they protect different things.',
			'',
			`Generated: ${stamp}`,
			'',
			...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}.  ${c}`),
			''
		];
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `cairn-recovery-codes-${stamp}.txt`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		downloaded = true;
	}

	function finish() {
		step = 'done';
		error = null;
	}

	// Kick off phrase generation as soon as the page mounts.
	$effect(() => {
		if (step === 'phrase' && !phrase && !loadingPhrase && !error) generatePhrase();
	});
</script>

<svelte:head>
	<title>Set up account recovery — Cairn</title>
</svelte:head>

<div class="wrap fade-in">
	<header class="head">
		<div class="head-icon"><Icon name="shield" size={20} /></div>
		<div>
			<h1 class="page-title">Set up account recovery</h1>
			<p class="sub">A way back into Cairn if you ever lose your passkeys.</p>
		</div>
	</header>

	<div class="stepper-wrap">
		<Stepper {steps} current={step} />
	</div>

	<!-- The account-vs-bitcoin distinction, stated once up top and reinforced in
	     every step. This is the single most important thing for the user to
	     understand, so it leads. -->
	<div class="explainer" role="note">
		<Icon name="info" size={16} />
		<div>
			<strong>This recovers your Cairn account, not your bitcoin.</strong>
			A recovery phrase or code gets you back into Cairn (your login) if you lose all your
			passkeys. It does <strong>not</strong> access your bitcoin — your bitcoin keys stay on your
			hardware wallet no matter what happens here.
		</div>
	</div>

	{#if error}
		<div class="form-error" role="alert">{error}</div>
	{/if}

	{#if step === 'phrase'}
		<section class="card card-pad panel">
			<div class="panel-head">
				<span class="card-title">Your recovery phrase</span>
				<span class="badge badge-warning">Shown once</span>
			</div>
			<p class="panel-lead">
				Write these 12 words down <strong>in order</strong> and keep them somewhere safe and offline.
				This is the only time they'll ever be shown. Anyone with them can register a new passkey and
				sign in as you — so treat them like a key to your account.
			</p>

			{#if !phrase && error}
				<div class="retry">
					<button class="btn btn-secondary btn-sm" onclick={generatePhrase}>
						<Icon name="refresh" size={14} />
						Try again
					</button>
				</div>
			{:else if !phrase}
				<div class="loading"><span class="spinner"></span> Generating your phrase…</div>
			{:else}
				<ol class="words" aria-label="Recovery phrase">
					{#each phraseWords as word, i (i)}
						<li class="word">
							<span class="word-num">{i + 1}</span>
							<span class="word-text mono">{word}</span>
						</li>
					{/each}
				</ol>

				<div class="phrase-actions">
					<CopyText value={phrase} display="Copy all 12 words" mono={false} />
				</div>

				<div class="bitcoin-note">
					<Icon name="flame" size={15} />
					<span>
						Store your recovery phrase <strong>separately from your hardware-wallet backup</strong> —
						they protect different things. This phrase can never touch your bitcoin.
					</span>
				</div>

				<label class="gate">
					<input type="checkbox" bind:checked={wroteItDown} />
					<span>I've written this down in a safe place.</span>
				</label>

				<div class="step-actions">
					<button class="btn btn-primary" disabled={!wroteItDown} onclick={toCodesStep}>
						Continue
						<Icon name="arrow-right" size={15} />
					</button>
				</div>
			{/if}
		</section>
	{/if}

	{#if step === 'codes'}
		<section class="card card-pad panel">
			<div class="panel-head">
				<span class="card-title">Your recovery codes</span>
				<span class="badge badge-warning">Shown once</span>
			</div>
			<p class="panel-lead">
				A backup to your phrase: <strong>8 single-use codes</strong>. Each one works once to get back
				into Cairn. Download or copy them and store them somewhere safe — this is the only time
				they'll be shown.
			</p>

			{#if !codes && error}
				<div class="retry">
					<button class="btn btn-secondary btn-sm" onclick={generateCodes}>
						<Icon name="refresh" size={14} />
						Try again
					</button>
				</div>
			{:else if !codes}
				<div class="loading"><span class="spinner"></span> Generating your codes…</div>
			{:else}
				<ul class="codes" aria-label="Recovery codes">
					{#each codes as code, i (i)}
						<li class="code mono">{code}</li>
					{/each}
				</ul>

				<div class="code-actions">
					<button class="btn btn-primary btn-sm" onclick={downloadCodes}>
						<Icon name={downloaded ? 'check' : 'arrow-down-left'} size={15} />
						{downloaded ? 'Downloaded' : 'Download codes'}
					</button>
					<button class="btn btn-secondary btn-sm" onclick={copyAllCodes}>
						<Icon name="copy" size={15} />
						Copy all
					</button>
				</div>

				<div class="bitcoin-note">
					<Icon name="flame" size={15} />
					<span>
						Like the phrase, these codes recover your <strong>login only</strong> — never your
						bitcoin. Keep them apart from your hardware-wallet seed backup.
					</span>
				</div>

				<div class="step-actions">
					<button class="btn btn-ghost btn-sm" onclick={toPhraseStep}>
						<Icon name="chevron-left" size={15} />
						Back
					</button>
					<button class="btn btn-primary" onclick={finish}>
						Finish
						<Icon name="check" size={15} />
					</button>
				</div>
			{/if}
		</section>
	{/if}

	{#if step === 'done'}
		<section class="card card-pad panel done-panel">
			<div class="done-badge"><Icon name="check" size={26} strokeWidth={2.25} /></div>
			<h2 class="done-title">Account recovery is set up</h2>
			<p class="done-lead">
				If you ever lose every passkey, you can use your recovery phrase or a recovery code to get
				back into Cairn. You can regenerate either at any time from Settings.
			</p>
			<div class="bitcoin-note center">
				<Icon name="flame" size={15} />
				<span>
					Remember: none of this touches your bitcoin. Your coins are controlled by the keys on your
					hardware wallet — keep that seed backup safe and separate.
				</span>
			</div>
			<div class="step-actions center">
				<button class="btn btn-primary" onclick={() => goto('/', { invalidateAll: true })}>
					Go to dashboard
				</button>
				<a class="btn btn-ghost" href="/settings">Recovery settings</a>
			</div>
		</section>
	{/if}

	{#if step !== 'done'}
		<div class="skip-row">
			{#if data.isAdmin}
				<p class="skip-note admin">
					<Icon name="shield" size={14} />
					As the administrator, you can't skip this — it's what keeps this instance recoverable.
				</p>
			{:else}
				<a class="skip-link" href="/">Skip for now</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	.wrap {
		max-width: 560px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 13px;
	}

	.head-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
	}

	.sub {
		font-size: 13px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.stepper-wrap {
		padding: 4px 8px 2px;
	}

	.explainer {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-card);
		padding: 12px 14px;
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.explainer :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.explainer strong {
		color: var(--text);
		font-weight: 600;
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.panel-lead {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
	}

	.panel-lead strong {
		color: var(--text);
		font-weight: 600;
	}

	.loading {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 13px;
		color: var(--text-muted);
		padding: 12px 0;
	}

	.retry {
		display: flex;
		padding: 4px 0;
	}

	/* Phrase grid — numbered, monospace, unmistakably an ordered set. */
	.words {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	@media (max-width: 480px) {
		.words {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	.word {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.word-num {
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		width: 16px;
		text-align: right;
		flex-shrink: 0;
	}

	.word-text {
		font-size: 13.5px;
		color: var(--text);
	}

	.phrase-actions {
		display: flex;
		font-size: 13px;
		color: var(--accent);
	}

	.bitcoin-note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--warning);
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-control);
		padding: 10px 12px;
	}

	.bitcoin-note :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}

	.bitcoin-note strong {
		color: var(--text);
		font-weight: 600;
	}

	.bitcoin-note.center {
		text-align: left;
	}

	.gate {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 11px 12px;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		font-size: 13.5px;
		font-weight: 500;
		cursor: pointer;
	}

	.gate input {
		width: 17px;
		height: 17px;
		accent-color: var(--accent);
		cursor: pointer;
		flex-shrink: 0;
	}

	.codes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 8px;
	}

	@media (max-width: 480px) {
		.codes {
			grid-template-columns: 1fr;
		}
	}

	.code {
		padding: 9px 12px;
		text-align: center;
		font-size: 14px;
		letter-spacing: 0.04em;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.code-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.step-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		align-items: center;
	}

	.step-actions.center {
		justify-content: center;
	}

	/* Done panel */
	.done-panel {
		align-items: center;
		text-align: center;
		gap: 12px;
		padding-top: 28px;
		padding-bottom: 28px;
	}

	.done-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: var(--success-muted);
		color: var(--success);
	}

	.done-title {
		font-family: var(--font-serif);
		font-size: 20px;
		font-weight: 600;
	}

	.done-lead {
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		max-width: 420px;
	}

	.skip-row {
		display: flex;
		justify-content: center;
		padding: 2px 0 8px;
	}

	.skip-link {
		font-size: 13px;
		color: var(--text-muted);
	}

	.skip-link:hover {
		color: var(--text-secondary);
	}

	.skip-note {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12.5px;
		color: var(--text-muted);
		text-align: center;
		line-height: 1.5;
	}

	.skip-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}
</style>
