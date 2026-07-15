<script lang="ts">
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { copyToClipboard } from '$lib/clipboard';
	import { scrollToTop } from '$lib/scrollToTop';
	import Banner from '$lib/components/Banner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Stepper from '$lib/components/Stepper.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import { buildVerifyQuestions, type VerifyQuestion } from './_components/recognitionVerify';
	import {
		WIZARD_PROGRESS_KEY,
		parseSavedProgress,
		hasMeaningfulProgress
	} from './_components/wizardProgress';

	let { data } = $props();

	// --- wizard state ---------------------------------------------------------
	// Two guided steps: (1) the recovery PHRASE behind an explain-first stakes
	// screen, a reveal, and a recognition-based verify, then (2) the one-time
	// recovery CODES with a download. A secret is fetched (and thereby
	// generated) at most once and held only in memory for the life of this
	// page — reloading throws it away, which is why the copy hammers "you will
	// not see this again" (and why the resume snapshot below only ever stores
	// which SCREEN the user reached, never the secret itself — see
	// _components/wizardProgress.ts).
	type Step = 'phrase' | 'codes' | 'done';
	let step = $state<Step>('phrase');

	// Sub-stages within the 'phrase' step (R4, docs/UX-PSYCHOLOGY-RESEARCH-
	// 2026-07-15.md — F7, CHI 2021): explain the stakes in plain language
	// BEFORE any word renders, then reveal, then a recognition-based check
	// ("which word was #4?") instead of the old plain checkbox gate alone.
	// Never auto-fires on mount — generating the phrase is now the visible
	// result of the "Show my recovery phrase" button on the stakes screen, not
	// a side effect of landing on the page.
	type PhraseStage = 'stakes' | 'reveal' | 'verify';
	let phraseStage = $state<PhraseStage>('stakes');

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
	let wroteItDown = $state(false); // "I've written this down" — required before verify

	// Recognition-based verify (R4): 2 positions, pick the right word among
	// three decoys. Recall quizzes ("type word #4") punish and stall; this
	// checks the same thing — did the word actually get written down — with
	// far less friction (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md F7).
	const VERIFY_QUESTION_COUNT = 2;
	let verifyQuestions = $state<VerifyQuestion[]>([]);
	// position -> the option currently picked (null = unanswered).
	let verifyAnswers = $state<Record<number, string | null>>({});
	// position -> true once answered correctly. All-true unlocks Continue.
	let verifyCorrect = $state<Record<number, boolean>>({});
	const verifyPassed = $derived(
		verifyQuestions.length > 0 && verifyQuestions.every((q) => verifyCorrect[q.position])
	);

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
		phraseStage = 'stakes';
		error = null;
		scrollToTop();
	}

	/** Stakes screen's CTA: only now does the phrase actually get generated —
	 *  explain-before-reveal (R4), not a mount side effect. */
	function revealPhrase() {
		phraseStage = 'reveal';
		error = null;
		scrollToTop();
		generatePhrase();
	}

	/** Reveal's Continue: move to the recognition-verify sub-stage instead of
	 *  straight to the codes step. Builds fresh questions each time (e.g. a
	 *  "Back to phrase" round-trip) so a stale answer set never lingers. */
	function toVerifyStage() {
		if (!wroteItDown || !phrase) return;
		verifyQuestions = buildVerifyQuestions(phraseWords, VERIFY_QUESTION_COUNT);
		verifyAnswers = {};
		verifyCorrect = {};
		phraseStage = 'verify';
		error = null;
		scrollToTop();
	}

	/** Verify's "Back to phrase" — the phrase is still in memory, so letting
	 *  someone double-check is calm and non-punitive, not a restart. */
	function backToReveal() {
		phraseStage = 'reveal';
		error = null;
		scrollToTop();
	}

	function pickVerifyAnswer(q: VerifyQuestion, option: string) {
		verifyAnswers = { ...verifyAnswers, [q.position]: option };
		verifyCorrect = { ...verifyCorrect, [q.position]: option === q.correctWord };
	}

	function toCodesStep() {
		if (!verifyPassed) return;
		step = 'codes';
		error = null;
		scrollToTop();
		generateCodes();
	}

	function copyAllCodes() {
		if (!codes) return;
		void copyToClipboard(codes.join('\n'));
	}

	function downloadCodes() {
		if (!codes) return;
		const stamp = new Date().toISOString().slice(0, 10);
		const lines = [
			'Heartwood account recovery codes',
			'================================',
			'',
			'These codes get you back INTO your Heartwood account (your LOGIN) if you',
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
		a.download = `heartwood-recovery-codes-${stamp}.txt`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		downloaded = true;
	}

	function finish() {
		step = 'done';
		error = null;
		scrollToTop();
		try {
			sessionStorage.removeItem(WIZARD_PROGRESS_KEY);
		} catch {
			// Already done in memory; a stale snapshot just ages out.
		}
	}

	// ------------------------------------------- progress survives page reloads
	//
	// A full-page reload used to silently drop the user back to the very first
	// screen with no explanation (Umbrel's app_proxy auth layer can force
	// exactly such a reload mid-flow — the same failure mode documented on the
	// add-wallet and multisig wizards). This mirrors THEIR sessionStorage
	// resume pattern, with one deliberate difference: the payload here is a
	// SECRET (the phrase, the codes), not a public key, so the snapshot stores
	// only which SCREEN the user reached — never the words themselves. A
	// resume into the phrase step always lands on the calm stakes explainer
	// (phraseStage defaults to 'stakes'), not mid-reveal or mid-verify, because
	// the actual phrase can't survive a reload by design.
	const savedProgress = browser ? parseSavedProgress(safeReadProgress(), Date.now()) : null;
	// True after a resume: shows the "picked up where you left off" note.
	let resumed = $state(false);

	function safeReadProgress(): string | null {
		try {
			return sessionStorage.getItem(WIZARD_PROGRESS_KEY);
		} catch {
			return null; // storage blocked (private mode etc.) — just start fresh
		}
	}

	// Gate the persistence effect until onMount has applied any saved snapshot
	// (cairn-pwo1 pattern): Svelte runs user effects in source order, and the
	// persistence $effect below is declared before onMount finishes, so on
	// mount it would otherwise fire first — while step is still the pristine
	// initial 'phrase' — and clobber a valid 'codes' snapshot in sessionStorage
	// before onMount ever gets to read it.
	let hydrated = $state(false);

	onMount(() => {
		if (savedProgress && hasMeaningfulProgress(savedProgress)) {
			step = savedProgress.step;
			// A resume into 'codes' needs its own generateCodes() call — the
			// codes, like the phrase, live only in memory and don't survive a
			// reload; landing on the step without them would just spin forever.
			if (savedProgress.step === 'codes') generateCodes();
			resumed = true;
		}
		hydrated = true;
	});

	$effect(() => {
		if (!hydrated) return;
		// Only 'phrase' and 'codes' are ever persisted — 'done' clears the
		// snapshot outright via finish() above.
		if (step !== 'phrase' && step !== 'codes') return;
		const snapshot = JSON.stringify({ step, savedAt: Date.now() });
		try {
			sessionStorage.setItem(WIZARD_PROGRESS_KEY, snapshot);
		} catch {
			// Best-effort: without storage the wizard still works, it just
			// can't survive a reload.
		}
	});
</script>

<svelte:head>
	<title>Set up account recovery — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer. -->
	<header class="flow-header">
		{#if !data.isAdmin}
			<BackCircle href="/settings" label="Back to settings" />
		{:else}
			<span class="flow-spacer"></span>
		{/if}
		<span class="flow-eyebrow">ACCOUNT RECOVERY</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow. Entry can be from Settings or first sign-in, so a
	     plain (non-breadcrumb) eyebrow like the Settings root page. -->
	<div class="page-eyebrow">ACCOUNT RECOVERY</div>

	<h1 class="page-title">Set up account recovery</h1>
	<p class="lede">A way back into Heartwood if you ever lose your passkeys.</p>

	<div class="stepper-wrap">
		<Stepper {steps} current={step} />
	</div>

	<!-- The account-vs-bitcoin distinction, stated once up top and reinforced in
	     every step. This is the single most important thing for the user to
	     understand, so it leads. -->
	<div class="explainer" role="note">
		<Icon name="info" size={16} />
		<div>
			<strong>This recovers your Heartwood account, not your bitcoin.</strong>
			A recovery phrase or code gets you back into Heartwood (your login) if you lose all your
			passkeys. It does <strong>not</strong> access your bitcoin — your bitcoin keys stay on your
			hardware wallet no matter what happens here.
		</div>
	</div>

	{#if resumed}
		<!-- A reload landed mid-flow and we restored just the screen position —
		     never the phrase or codes themselves, which can't survive a reload
		     by design (see _components/wizardProgress.ts). -->
		<div class="resume-note" role="status">
			<Icon name="info" size={14} />
			<span>Picked up where you left off.</span>
		</div>
	{/if}

	{#if error}
		<Banner variant="error">{error}</Banner>
	{/if}

	{#if step === 'phrase' && phraseStage === 'stakes'}
		<!-- Explain-before-reveal (R4): the stakes, in plain language, before a
		     single word renders. Calm register — never "WARNING", never a
		     skull-and-crossbones. The anxiety here is responsibility without
		     confidence (CHI 2021), so the copy's job is to supply confidence,
		     not pile on more caution. -->
		<section class="panel stakes-panel fade-in">
			<div class="panel-head">
				<h2 class="section-title">Before we show your phrase</h2>
			</div>
			<div class="stakes-icon"><Icon name="shield" size={22} strokeWidth={1.6} /></div>
			<ul class="stakes-list">
				<li>These 12 words are the key to your Heartwood account.</li>
				<li>Anyone who has them can sign in as you — treat them like a password.</li>
				<li>
					Lose them, and lose every passkey too, and nobody — not even Cairn — can get you back in.
				</li>
				<li>Write them on paper and keep it somewhere offline, away from your device.</li>
			</ul>

			<div class="step-actions">
				<button class="btn btn-primary" onclick={revealPhrase}>
					Show my recovery phrase
					<Icon name="arrow-right" size={15} />
				</button>
			</div>
		</section>
	{/if}

	{#if step === 'phrase' && phraseStage === 'reveal'}
		<section class="panel fade-in">
			<div class="panel-head">
				<h2 class="section-title">Your recovery phrase</h2>
				<span class="shown-once">shown once</span>
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
					<button class="btn btn-primary" disabled={!wroteItDown} onclick={toVerifyStage}>
						Continue
						<Icon name="arrow-right" size={15} />
					</button>
				</div>
			{/if}
		</section>
	{/if}

	{#if step === 'phrase' && phraseStage === 'verify'}
		<!-- Recognition-based verify (R4): pick the word you just wrote down,
		     among decoys — not "type word #4 from memory". Recall quizzes
		     punish and stall; recognition checks the same thing (did the word
		     actually get captured, in order) with far less friction. -->
		<section class="panel fade-in">
			<div class="panel-head">
				<h2 class="section-title">Quick check</h2>
			</div>
			<p class="panel-lead">
				Which word did you write down at each position? This just confirms the words made it to
				paper — pick from the options below.
			</p>

			<div class="verify-list">
				{#each verifyQuestions as q (q.position)}
					{@const answered = verifyAnswers[q.position]}
					{@const correct = verifyCorrect[q.position]}
					<div class="verify-question">
						<span class="verify-label">Word #{q.position}</span>
						<div class="verify-options" role="radiogroup" aria-label="Word #{q.position}">
							{#each q.options as option (option)}
								{@const picked = answered === option}
								<button
									type="button"
									class="verify-chip"
									class:picked
									class:wrong={picked && !correct}
									class:right={picked && correct}
									role="radio"
									aria-checked={picked}
									onclick={() => pickVerifyAnswer(q, option)}
								>
									{option}
									{#if picked && correct}
										<Icon name="check" size={13} strokeWidth={2.25} />
									{/if}
								</button>
							{/each}
						</div>
						{#if answered && !correct}
							<span class="verify-hint">Not quite — check word #{q.position} again.</span>
						{/if}
					</div>
				{/each}
			</div>

			<div class="step-actions">
				<button class="btn btn-ghost btn-sm" onclick={backToReveal}>
					<Icon name="chevron-left" size={13} />
					Back to phrase
				</button>
				<button class="btn btn-primary" disabled={!verifyPassed} onclick={toCodesStep}>
					Continue
					<Icon name="arrow-right" size={15} />
				</button>
			</div>
		</section>
	{/if}

	{#if step === 'codes'}
		<section class="panel">
			<div class="panel-head">
				<h2 class="section-title">Your recovery codes</h2>
				<span class="shown-once">shown once</span>
			</div>
			<p class="panel-lead">
				A backup to your phrase: <strong>8 single-use codes</strong>. Each one works once to get back
				into Heartwood. Download or copy them and store them somewhere safe — this is the only time
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
		<section class="panel done-panel">
			<div class="done-badge"><Icon name="check" size={26} strokeWidth={2.25} /></div>
			<h2 class="done-title">Account recovery is set up</h2>
			<p class="done-lead">
				If you ever lose every passkey, you can use your recovery phrase or a recovery code to get
				back into Heartwood. You can regenerate either at any time from Settings.
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
	/* Grove field bleeds to the viewport behind the content column. */
	.grove-bleed {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.hw-page {
		position: relative;
		z-index: 1;
		max-width: 560px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	/* This page composes its own mobile flow header, so the shell's
	   bare-back-circle fallback is suppressed while it's mounted. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.page-eyebrow,
	.flow-eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--eyebrow);
	}

	.page-eyebrow {
		margin-bottom: -8px;
	}

	@media (max-width: 900px) {
		.page-eyebrow {
			display: none;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
		}

		.flow-eyebrow {
			font-size: 10px;
			letter-spacing: 0.2em;
			text-align: center;
		}

		.flow-spacer {
			width: 32px;
			height: 32px;
			flex-shrink: 0;
		}
	}

	.lede {
		font-size: 13px;
		color: var(--text-secondary);
		margin-top: -12px;
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
		border-radius: var(--radius-strip);
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

	/* --- resume note (a reload restored the screen position only) --- */
	.resume-note {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.resume-note :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
	}

	/* Steps are hairline-bounded sections, not cards. */
	.panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding-top: 18px;
		border-top: 1px solid var(--hairline);
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.shown-once {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--attention);
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

	/* --- stakes screen (explain-before-reveal, R4) --- */

	.stakes-panel {
		align-items: center;
		text-align: center;
		gap: 16px;
		padding-bottom: 6px;
	}

	.stakes-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
	}

	.stakes-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-width: 420px;
		font-size: 14px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.stakes-list li:first-child {
		color: var(--text);
		font-weight: 500;
	}

	/* --- recognition verify (R4) --- */

	.verify-list {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.verify-question {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.verify-label {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.verify-options {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.verify-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		font-size: 13.5px;
		font-family: var(--font-mono, monospace);
		color: var(--text);
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-strip);
		cursor: pointer;
		transition:
			border-color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.verify-chip:hover {
		border-color: var(--accent-border);
	}

	.verify-chip.picked.wrong {
		border-color: var(--warning-border-strong);
		background: var(--attention-muted);
		color: var(--attention);
	}

	.verify-chip.picked.right {
		border-color: var(--sage);
		background: var(--sage-muted);
		color: var(--sage);
	}

	.verify-hint {
		font-size: 12px;
		color: var(--attention);
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

	/* Phrase grid — numbered, monospace, unmistakably an ordered set.
	   Input-like fills are the one filled surface the grammar allows. */
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
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-strip);
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
		color: var(--attention);
		background: var(--attention-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-strip);
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
		padding: 11px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
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
		background: var(--bg-input);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-strip);
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
		background: var(--sage-muted);
		color: var(--sage);
	}

	.done-title {
		font-family: var(--font-serif);
		font-size: 20px;
		font-weight: 600;
		color: var(--text-hero);
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
