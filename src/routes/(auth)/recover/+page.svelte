<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startRegistration, browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser';
	import { guessPasskeyName } from '$lib/passkey';
	import type { SessionUser } from '$lib/types';

	// Two secret kinds the user can present. A PHRASE is 12 words; a CODE is one
	// short XXXXX-XXXXX code. We offer both, clearly labeled.
	type Method = 'phrase' | 'code';

	let email = $state('');
	let method = $state<Method>('phrase');
	let phrase = $state('');
	let code = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let passkeySupported = $state(true);

	// Once verify succeeds we hold the grant (via httpOnly cookie) and prompt the
	// user to create a new passkey to finish.
	let verified = $state(false);
	let displayName = $state('');

	onMount(() => {
		passkeySupported = browserSupportsWebAuthn();
	});

	// The one generic failure message the client shows. It intentionally mirrors
	// the server's non-enumerating body and NEVER reveals whether the email exists
	// or which of phrase/code was wrong. We do NOT do any client-side existence
	// check.
	const GENERIC_FAILURE = 'That recovery information did not match. Check it and try again.';

	async function verify(e: SubmitEvent) {
		e.preventDefault();
		error = null;

		if (!email.trim()) {
			error = 'Enter your email to continue.';
			return;
		}
		const secret = method === 'phrase' ? phrase.trim() : code.trim();
		if (!secret) {
			error =
				method === 'phrase'
					? 'Enter your 12-word recovery phrase.'
					: 'Enter one of your recovery codes.';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/auth/recover/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					method === 'phrase'
						? { email: email.trim(), phrase: secret }
						: { email: email.trim(), code: secret }
				)
			});
			const body = await res.json().catch(() => null);

			if (res.status === 429) {
				error = body?.error || 'Too many attempts. Try again later.';
				return;
			}
			if (!res.ok || !body?.ok) {
				// Surface the server's generic, non-enumerating message verbatim
				// (falling back to our own identical copy).
				error = body?.error || GENERIC_FAILURE;
				return;
			}

			// Grant cookie is now set. Move to the "create a new passkey" step.
			displayName = body.user?.displayName || '';
			verified = true;
		} catch {
			error = GENERIC_FAILURE;
		} finally {
			submitting = false;
		}
	}

	function friendlyPasskeyError(e: unknown): string {
		if (e instanceof WebAuthnError) {
			if (e.name === 'NotAllowedError' || e.code === 'ERROR_CEREMONY_ABORTED')
				return 'Passkey prompt was dismissed. Try again when ready.';
			if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
				return 'That device already has a passkey for this account. Use a different device or passkey.';
			return e.message || 'Your device could not complete the passkey step.';
		}
		if (e instanceof Error) return e.message;
		return 'Something went wrong creating your new passkey.';
	}

	// Drive the passkey REGISTRATION ceremony authorized by the grant cookie:
	//   options → browser prompt → verify → real session.
	async function registerNewPasskey() {
		error = null;
		submitting = true;
		try {
			const optRes = await fetch('/api/auth/recover/register/options', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
			const options = await optRes.json().catch(() => null);
			if (!optRes.ok) throw new Error(options?.error || 'Could not start passkey setup.');

			let attResp;
			try {
				attResp = await startRegistration({ optionsJSON: options });
			} catch (e) {
				throw new Error(friendlyPasskeyError(e));
			}

			const verifyRes = await fetch('/api/auth/recover/register/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response: attResp, name: guessPasskeyName() })
			});
			const done = (await verifyRes.json().catch(() => null)) as
				| { user?: SessionUser; error?: string }
				| null;
			if (!verifyRes.ok) throw new Error(done?.error || 'Could not finish recovery.');

			// Signed in for real now.
			await goto('/', { invalidateAll: true });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Something went wrong. Start again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Recover access — Cairn</title>
</svelte:head>

{#if !verified}
	<form class="stack" onsubmit={verify}>
		<div class="intro">
			<h1>Recover access to Cairn</h1>
			<p class="sub">
				Lost the device with your passkey? Prove it's you with your Cairn recovery phrase or a
				recovery code, then set up a new passkey.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		<div class="field">
			<label class="label" for="email">Email</label>
			<input
				class="input"
				id="email"
				name="email"
				type="email"
				autocomplete="email"
				required
				bind:value={email}
			/>
		</div>

		<div class="method-toggle" role="tablist" aria-label="Recovery method">
			<button
				type="button"
				role="tab"
				aria-selected={method === 'phrase'}
				class="method-btn"
				class:active={method === 'phrase'}
				onclick={() => (method = 'phrase')}
			>
				Recovery phrase
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={method === 'code'}
				class="method-btn"
				class:active={method === 'code'}
				onclick={() => (method = 'code')}
			>
				Recovery code
			</button>
		</div>

		{#if method === 'phrase'}
			<div class="field">
				<label class="label" for="phrase">Recovery phrase</label>
				<textarea
					class="input phrase-input"
					id="phrase"
					name="phrase"
					rows="3"
					autocapitalize="none"
					autocomplete="off"
					spellcheck="false"
					placeholder="Your 12 words, separated by spaces"
					bind:value={phrase}
				></textarea>
				<p class="hint">The 12-word phrase Cairn gave you when you set up recovery.</p>
			</div>
		{:else}
			<div class="field">
				<label class="label" for="code">Recovery code</label>
				<input
					class="input code-input"
					id="code"
					name="code"
					type="text"
					autocapitalize="characters"
					autocomplete="off"
					autocorrect="off"
					spellcheck="false"
					placeholder="XXXXX-XXXXX"
					bind:value={code}
				/>
				<p class="hint">One of your single-use recovery codes. Each works only once.</p>
			</div>
		{/if}

		<button class="btn btn-primary" disabled={submitting}>
			{#if submitting}<span class="spinner"></span>{/if}
			Continue
		</button>

		<div class="reassure" role="note">
			<strong>This restores your Cairn login only.</strong>
			It can never move, spend, or reveal your bitcoin — those keys live on your hardware wallet and
			are untouched by account recovery.
		</div>

		<p class="alt"><a href="/login">Back to sign in</a></p>
	</form>
{:else}
	<div class="stack">
		<div class="intro">
			<h1>Set up a new passkey</h1>
			<p class="sub">
				{#if displayName}Welcome back, {displayName}. {/if}Your identity is verified. Create a new
				passkey on this device to finish and sign in.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		{#if !passkeySupported}
			<div class="form-error" role="alert">
				This browser can't create passkeys. Open Cairn in a browser that supports them (or on a
				device with a screen lock) to finish recovery.
			</div>
		{:else}
			<button class="btn btn-primary" onclick={registerNewPasskey} disabled={submitting}>
				{#if submitting}<span class="spinner"></span>{/if}
				Create a new passkey
			</button>
		{/if}

		<div class="reassure" role="note">
			<strong>Reminder:</strong> this new passkey only signs you in to Cairn. It has no access to your
			bitcoin, which stays secured on your hardware wallet.
		</div>

		<p class="alt"><a href="/login">Cancel and go back</a></p>
	</div>
{/if}

<style>
	form,
	.stack {
		gap: 16px;
	}

	.intro {
		text-align: center;
	}

	h1 {
		font-family: var(--font-serif);
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.sub {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.btn {
		width: 100%;
		margin-top: 4px;
	}

	.method-toggle {
		display: flex;
		gap: 6px;
		padding: 4px;
		background: var(--surface-2, rgba(127, 127, 127, 0.06));
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
	}

	.method-btn {
		flex: 1;
		padding: 8px 10px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
		background: transparent;
		border: 0;
		border-radius: calc(var(--radius-card) - 4px);
		cursor: pointer;
	}

	.method-btn.active {
		color: var(--text);
		background: var(--surface);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.phrase-input {
		resize: vertical;
		min-height: 72px;
		font-family: var(--font-mono, ui-monospace, monospace);
		line-height: 1.5;
	}

	.code-input {
		font-family: var(--font-mono, ui-monospace, monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.hint {
		margin-top: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.reassure {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-muted);
		padding: 12px 14px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		background: var(--surface-2, rgba(127, 127, 127, 0.04));
	}

	.reassure strong {
		color: var(--text);
	}

	.alt {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
