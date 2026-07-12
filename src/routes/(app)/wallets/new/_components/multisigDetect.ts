export interface MultisigDetection {
	isMultisig: boolean;
	m?: number;
	n?: number;
}

/** Heuristic (UX-only) check: does this uploaded/pasted text look like a
 *  MULTISIG wallet config? Authoritative parsing happens server-side after
 *  the hand-off. Never throws. */
export function detectMultisigConfig(text: string): MultisigDetection {
	const t = text.trim();
	if (!t) return { isMultisig: false };
	if (t.startsWith('{')) {
		try {
			const o = JSON.parse(t) as Record<string, unknown>;
			const hasKeys = Array.isArray((o as any).extendedPublicKeys);
			const q = (o as any).quorum as
				| { requiredSigners?: unknown; totalSigners?: unknown }
				| undefined;
			const isMs =
				hasKeys ||
				!!q ||
				o.type === 'multisig' ||
				(typeof o.format === 'string' && o.format !== 'cairn-wallet-config' && o.format !== 'string');
			if (!isMs) return { isMultisig: false };
			const m = Number(q?.requiredSigners);
			const n = hasKeys ? ((o as any).extendedPublicKeys as unknown[]).length : Number(q?.totalSigners);
			return { isMultisig: true, m: Number.isInteger(m) ? m : undefined, n: Number.isInteger(n) ? n : undefined };
		} catch {
			return { isMultisig: false };
		}
	}
	if (/\b(sortedmulti|multi)\s*\(/i.test(t)) {
		const q = t.match(/(?:sorted)?multi\s*\(\s*(\d+)\s*,/i);
		return { isMultisig: true, m: q ? Number(q[1]) : undefined };
	}
	const pol = t.match(/Policy:\s*(\d+)\s+of\s+(\d+)/i);
	if (pol) return { isMultisig: true, m: Number(pol[1]), n: Number(pol[2]) };
	return { isMultisig: false };
}
