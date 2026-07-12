<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { startRegistration, browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser';
	import { guessPasskeyName } from '$lib/passkey';
	import type { SessionUser } from '$lib/types';

	let { data } = $props();

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
	// SAFE mitigation for desktop passkey failures: registering a passkey here
	// on an origin that doesn't match the server's expected WebAuthn origin
	// (data.passkeyOriginOk, see $lib/server/passkeyOrigin.ts) would create a
	// passkey that fails to verify on EVERY origin. Distinguish that reason
	// from the ordinary insecure-context case so the fallback hint can name
	// the address where it does work.
	let showPasskeyOriginHint = $state(false);

	// Once verify succeeds we hold the grant (via httpOnly cookie) and prompt the
	// user to finish with a new passkey OR a new password.
	let verified = $state(false);
	let displayName = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');

	onMount(() => {
		// WebAuthn also needs a secure context — a plain-HTTP Umbrel deployment
		// (http://umbrel.local) reports browserSupportsWebAuthn() true but any
		// ceremony there fails outright, so gate on both (cairn-nhfe). The "Set a
		// new password instead" form below is the completion path that always
		// works, regardless of this check.
		const supported = browserSupportsWebAuthn() && window.isSecureContext;
		passkeySupported = supported && data.passkeyOriginOk;
		showPasskeyOriginHint = supported && !data.passkeyOriginOk;
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

	// Second completion path (cairn-nhfe): finish recovery by setting a new
	// password instead of a passkey. Always available — this is what makes
	// recovery work on a plain-HTTP deployment where WebAuthn can't run.
	async function setNewPassword(e: SubmitEvent) {
		e.preventDefault();
		error = null;

		if (newPassword.length < 8) {
			error = 'Password must be at least 8 characters.';
			return;
		}
		if (newPassword !== confirmPassword) {
			error = 'Passwords do not match.';
			return;
		}

		// Shares the `submitting` flag with registerNewPasskey so the two
		// completion paths can't both be in flight at once — whichever the user
		// starts first disables the other button until it resolves.
		submitting = true;
		try {
			const res = await fetch('/api/auth/recover/password', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password: newPassword })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not finish recovery.');

			await goto('/', { invalidateAll: true });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Something went wrong. Start again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Recover access — Heartwood</title>
</svelte:head>

{#if !verified}
	<form class="stack" onsubmit={verify}>
		<div class="intro">
			<h1>Recover access to Heartwood</h1>
			<p class="sub">
				Lost the device with your passkey? Prove it's you with your Heartwood recovery phrase or a
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
				<p class="hint">The 12-word phrase Heartwood gave you when you set up recovery.</p>
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
			<strong>This restores your Heartwood login only.</strong>
			It can never move, spend, or reveal your bitcoin — those keys live on your hardware wallet and
			are untouched by account recovery.
		</div>

		<p class="alt"><a href="/login">Back to sign in</a></p>
	</form>
{:else}
	<div class="stack">
		<div class="intro">
			<h1>Finish recovering your account</h1>
			<p class="sub">
				{#if displayName}Welcome back, {displayName}. {/if}Your identity is verified. Finish with a
				new passkey{passkeySupported ? '' : ' (unavailable on this connection)'} or set a new
				password.
			</p>
		</div>

		{#if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		{#if passkeySupported}
			<button class="btn btn-primary" onclick={registerNewPasskey} disabled={submitting}>
				{#if submitting}<span class="spinner"></span>{/if}
				Create a new passkey
			</button>

			<div class="or-divider" role="separator">or</div>
		{/if}

		<form class="stack" onsubmit={setNewPassword}>
			{#if !passkeySupported}
				<p class="hint" style="text-align: center; margin-bottom: -4px">
					{#if showPasskeyOriginHint}
						Passkeys are available at {data.passkeyExpectedOrigin} — on this address, set a new
						password to finish instead.
					{:else}
						This browser or connection can't create passkeys — set a new password to finish instead.
					{/if}
				</p>
			{/if}

			<div class="field">
				<label class="label" for="newPassword">New password</label>
				<input
					class="input"
					id="newPassword"
					name="newPassword"
					type="password"
					autocomplete="new-password"
					minlength="8"
					disabled={submitting}
					bind:value={newPassword}
				/>
			</div>

			<div class="field">
				<label class="label" for="confirmPassword">Confirm new password</label>
				<input
					class="input"
					id="confirmPassword"
					name="confirmPassword"
					type="password"
					autocomplete="new-password"
					minlength="8"
					disabled={submitting}
					bind:value={confirmPassword}
				/>
				<p class="hint">At least 8 characters.</p>
			</div>

			<button class="btn {passkeySupported ? 'btn-secondary' : 'btn-primary'}" disabled={submitting}>
				{#if submitting}<span class="spinner"></span>{/if}
				Set new password
			</button>
		</form>

		<div class="reassure" role="note">
			<strong>Reminder:</strong> this only restores your Heartwood sign-in. It has no access to your
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

	/* Heartwood text-toggle grammar: no boxed track — active tab is copper
	   text on a copper tint pill, inactive is quiet text. */
	.method-toggle {
		display: flex;
		justify-content: center;
		gap: 8px;
	}

	.method-btn {
		padding: 6px 13px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--eyebrow-path);
		background: transparent;
		border: 0;
		border-radius: var(--radius-toggle);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.method-btn:hover {
		color: var(--text-secondary);
	}

	.method-btn.active {
		color: var(--accent-bright);
		background: var(--accent-muted);
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

	.or-divider {
		text-align: center;
		font-size: 11.5px;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	/* Hairlines, not boxes: the reassurance note reads as a quiet aside
	   between two hairline rules rather than a panel. */
	.reassure {
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--text-muted);
		padding: 12px 4px;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
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
