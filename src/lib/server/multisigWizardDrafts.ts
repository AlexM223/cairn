// Server-side per-key persistence for the create-multisig wizard (cairn-jy3g,
// Phase 2 of cairn-1u41). Phase 1 (wizardProgress.ts) snapshots wizard
// progress into sessionStorage — tab-scoped, gone the moment the tab closes,
// so it only covers a same-tab reload within the hour. A real cosigner-key
// ceremony can span hours or days ("add the Coldcard when I'm home") and
// often continues on a different device, so this module gives the wizard a
// SERVER-SIDE draft: one row per in-progress wizard, committed after every
// key add/remove (not just on exit), resumable from any tab/device via
// `?draft=N` — mirroring the send flow's `?tx=N` resume (see
// src/routes/(app)/wallets/[id]/send/+page.server.ts and getTransaction in
// transactions.ts, whose owner-scoped-lookup-returns-null-on-mismatch shape
// this module copies exactly).
//
// SECURITY: only PUBLIC key material is ever stored — xpub / master
// fingerprint / derivation path / label / device type / category — the exact
// fields the sessionStorage snapshot already holds and the page already
// renders in the DOM. There is no private-key material in this flow at all
// (every key arrives as an xpub); this module still never accepts or stores
// anything resembling one (see normalizeMultisigKeyInput /
// PASTED_PRIVATE_KEY_REFUSAL upstream in +page.server.ts's `key` action,
// which runs BEFORE a key ever reaches this module). Every read/write is
// owner-scoped (getWizardDraft filters on user_id in the SQL, not after the
// fact) so one user can never read or overwrite another's in-progress vault.

import { db } from './db';
import { childLogger } from './logger';
import type {
	MultisigDeviceType,
	MultisigKeyCategory,
	MultisigScriptType
} from './wallets/multisig';

const log = childLogger('multisigWizardDrafts');

export type WizardDraftVaultMode = 'collaborative' | 'personal';

export interface WizardDraftKeyInput {
	name: string;
	category: MultisigKeyCategory;
	deviceType: MultisigDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
}

export interface WizardDraftKeyRow extends WizardDraftKeyInput {
	position: number;
}

export interface WizardDraftFields {
	name: string;
	threshold: number;
	totalKeys: number;
	scriptType: MultisigScriptType;
	vaultMode: WizardDraftVaultMode | null;
	/** The wizard's step at the moment of this commit ('quorum'|'keys'|'review'|…,
	 *  same vocabulary as wizardProgress.ts's WizardStepKey) — stored as plain
	 *  text so a future step added to the client doesn't need a migration here. */
	step: string;
	configImported: boolean;
	importedStartIndex: number;
}

export interface WizardDraftRow extends WizardDraftFields {
	id: number;
	userId: number;
	keys: WizardDraftKeyRow[];
	createdAt: string;
	updatedAt: string;
}

function mapDraft(row: Record<string, unknown>, keys: WizardDraftKeyRow[]): WizardDraftRow {
	return {
		id: row.id as number,
		userId: row.user_id as number,
		name: row.name as string,
		threshold: row.threshold as number,
		totalKeys: row.total_keys as number,
		scriptType: row.script_type as MultisigScriptType,
		vaultMode: (row.vault_mode as WizardDraftVaultMode | null) ?? null,
		step: row.step as string,
		configImported: Boolean(row.config_imported),
		importedStartIndex: row.imported_start_index as number,
		keys,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string
	};
}

function loadKeys(draftId: number): WizardDraftKeyRow[] {
	const rows = db
		.prepare('SELECT * FROM multisig_wizard_draft_keys WHERE draft_id = ? ORDER BY position ASC')
		.all(draftId) as Record<string, unknown>[];
	return rows.map((r) => ({
		position: r.position as number,
		name: r.name as string,
		category: r.category as MultisigKeyCategory,
		deviceType: (r.device_type as MultisigDeviceType) ?? null,
		xpub: r.xpub as string,
		fingerprint: r.fingerprint as string,
		path: r.path as string
	}));
}

/**
 * Owner-scoped lookup — the ONLY way a draft is ever read, and the seam
 * `?draft=N` resume (+page.server.ts's load()) and the `draftSync` action
 * both go through. Returns null both when the draft doesn't exist and when
 * it belongs to a DIFFERENT user, so a caller can never distinguish "gone"
 * from "not yours" — the same shape as getTransaction/getWallet. The load()
 * caller turns a null into `error(404, …)`; the action caller turns it into
 * `fail(404, …)`.
 */
export function getWizardDraft(userId: number, draftId: number): WizardDraftRow | null {
	const row = db
		.prepare('SELECT * FROM multisig_wizard_drafts WHERE id = ? AND user_id = ?')
		.get(draftId, userId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return mapDraft(row, loadKeys(draftId));
}

/** Starts a new draft. Called once, the first time the wizard has anything
 *  worth persisting (the first key add) — see the `draftSync` action, which
 *  creates on demand rather than the client managing two separate calls. */
export function createWizardDraft(userId: number, fields: WizardDraftFields): WizardDraftRow {
	const info = db
		.prepare(
			`INSERT INTO multisig_wizard_drafts
			 (user_id, name, threshold, total_keys, script_type, vault_mode, step, config_imported, imported_start_index)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			userId,
			fields.name,
			fields.threshold,
			fields.totalKeys,
			fields.scriptType,
			fields.vaultMode,
			fields.step,
			fields.configImported ? 1 : 0,
			fields.importedStartIndex
		);
	const draft = getWizardDraft(userId, Number(info.lastInsertRowid));
	/* istanbul ignore next -- the row we just inserted, under the id we just inserted it at, always reads back */
	if (!draft) throw new Error('Wizard draft could not be saved.');
	log.info({ userId, draftId: draft.id }, 'multisig wizard draft created');
	return draft;
}

/**
 * Replace a draft's fields AND its full key list in one transaction — the
 * commit point the wizard calls after EVERY key add/remove (and on other
 * position changes worth surviving a reload, e.g. reaching Review). A
 * full-list replace rather than incremental per-key insert/delete calls
 * keeps this the single write path for the whole draft (no separate
 * "reorder" or "delete key N" endpoint to keep in sync with it) and is safe
 * because the wizard caps at 15 keys — the cost of rewriting all of them on
 * every call is trivial. Called synchronously right after the client's
 * in-memory `keys` array changes, so each key really does get its own
 * durable commit rather than being batched into a save-on-exit.
 *
 * Returns null when the draft doesn't exist or isn't owned by `userId` — the
 * `draftSync` action turns that into a 404, exactly like a cross-user
 * getTransaction miss.
 */
export function syncWizardDraft(
	userId: number,
	draftId: number,
	fields: WizardDraftFields,
	keys: WizardDraftKeyInput[]
): WizardDraftRow | null {
	const existing = getWizardDraft(userId, draftId);
	if (!existing) return null;

	// node:sqlite exposes no transaction() helper — drive BEGIN/COMMIT/ROLLBACK
	// directly, the same pattern createMultisig (wallets/multisig.ts) and
	// backup.ts use. Synchronous statements with no `await` between them, so no
	// other request's JS can interleave on Node's single-threaded event loop.
	db.exec('BEGIN');
	try {
		db.prepare(
			`UPDATE multisig_wizard_drafts
			 SET name = ?, threshold = ?, total_keys = ?, script_type = ?, vault_mode = ?,
			     step = ?, config_imported = ?, imported_start_index = ?,
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND user_id = ?`
		).run(
			fields.name,
			fields.threshold,
			fields.totalKeys,
			fields.scriptType,
			fields.vaultMode,
			fields.step,
			fields.configImported ? 1 : 0,
			fields.importedStartIndex,
			draftId,
			userId
		);
		db.prepare('DELETE FROM multisig_wizard_draft_keys WHERE draft_id = ?').run(draftId);
		const insertKey = db.prepare(
			`INSERT INTO multisig_wizard_draft_keys
			 (draft_id, position, name, category, device_type, xpub, fingerprint, path)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		keys.forEach((k, i) => {
			insertKey.run(draftId, i, k.name, k.category, k.deviceType, k.xpub, k.fingerprint, k.path);
		});
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return getWizardDraft(userId, draftId);
}

/**
 * Deletes a draft — called once its multisig has actually been created
 * (createMultisig succeeded, so the draft's job is done) or when the user
 * explicitly starts over. Owner-scoped; a no-op (not an error) when the
 * draft is already gone or isn't owned by `userId`, so it's safe to call
 * defensively from both the `create` action and `startOver`.
 */
export function deleteWizardDraft(userId: number, draftId: number): void {
	db.prepare('DELETE FROM multisig_wizard_drafts WHERE id = ? AND user_id = ?').run(draftId, userId);
}
