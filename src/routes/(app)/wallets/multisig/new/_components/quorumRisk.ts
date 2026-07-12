// Dynamic, color-coded quorum risk panel (cairn-a1y8) — replaces the old
// "you can afford to lose N keys" copy with tier-based theft-vs-loss risk
// messaging, per the Unchained security model
// (https://unchained.com/blog/multisig-security-tradeoffs/): a quorum trades
// off two opposite risks — too few required keys makes theft easy, too many
// required keys makes irrecoverable loss easy. This module is the pure logic
// (no Svelte) behind that panel; the wizard template renders it.

/** Exact binomial coefficient C(n, k). Exact (no float error) for n <= 15,
 *  the wizard's hard cap on total keys. */
export function binomial(n: number, k: number): number {
	if (k < 0 || k > n) return 0;
	const kk = Math.min(k, n - k);
	let result = 1;
	for (let i = 0; i < kk; i++) {
		result = (result * (n - i)) / (i + 1);
	}
	return Math.round(result);
}

export type QuorumTier = 'red' | 'salmon' | 'yellow' | 'lightgreen' | 'green';

export interface QuorumRisk {
	tier: QuorumTier;
	label: string;
	icon: 'alert-triangle' | 'lock' | 'shield-alert' | 'shield-check' | 'shield';
	badge?: string;
	body: string;
	combos: string | null;
}

/** How many "keys" to write out as a word — the plural is context-sensitive. */
function keys(x: number): string {
	return x === 1 ? 'key' : 'keys';
}

/** The colloquial name for a group of `m` keys in prose ("pairs", "trios", …). */
function setWord(m: number): string {
	if (m === 2) return 'pairs';
	if (m === 3) return 'trios';
	return `sets of ${m} keys`;
}

/** Classify an m-of-n quorum into one of five risk tiers, with the exact copy
 *  for the risk panel. Ordered rules — first match wins:
 *    m === 1            -> red      (any single key spends)
 *    m === n             -> yellow   (every key required, no slack)
 *    2*m <= n            -> salmon   (minority or exact-half quorum)
 *    m === 2              -> green    (the sole survivor: 2-of-3)
 *    else                 -> lightgreen (majority, m >= 3, has spares)
 *
 *  Precondition: 1 <= m <= n <= 15. Callers must clamp/validate before
 *  calling — this function does not defend against out-of-range input. */
export function classifyQuorum(m: number, n: number): QuorumRisk {
	if (m === 1) {
		if (n === 1) {
			return {
				tier: 'red',
				label: 'Risky — one key, no backup',
				icon: 'alert-triangle',
				body:
					'One key does everything. Lose it and the money is gone for good. Anyone who copies ' +
					"it can take everything. There's no second key to save you either way — only sensible " +
					'for tiny, everyday amounts.',
				combos: null
			};
		}
		return {
			tier: 'red',
			label: 'Risky — one key spends everything',
			icon: 'alert-triangle',
			body:
				`Any single one of your ${n} keys can move all the money on its own. Lose a key and ` +
				"you're fine — the others still work. But someone who steals just one key can empty " +
				`this wallet. That's ${n} separate ways to be robbed. Good for small spending money, not ` +
				'for savings.',
			combos: `${n} keys, and any one of them spends on its own.`
		};
	}

	if (m === n) {
		const suggest = n === 2 ? '2-of-3' : `${n - 1}-of-${n}`;
		const suggestion =
			n === 2
				? `Most people add a third key — ${suggest} — so one accident isn't a catastrophe.`
				: `Most people require one fewer key — like ${suggest} — so one accident isn't a catastrophe.`;
		return {
			tier: 'yellow',
			label: 'Fragile — every key must survive',
			icon: 'lock',
			body:
				`All ${n} keys are required, every time. A thief would have to steal every single one, ` +
				'so it\'s very hard to rob. But lose just one key and the money is frozen forever, with ' +
				`no way back. ${suggestion}`,
			combos: `All ${n} keys together — the only combination that can spend.`
		};
	}

	if (2 * m <= n) {
		const C = binomial(n, m);
		const R = n - m;
		const suggestM = Math.floor(n / 2) + 1;
		return {
			tier: 'salmon',
			label: 'Loose — easy to recover, easy to rob',
			icon: 'shield-alert',
			body:
				`You need only ${m} of ${n} keys to spend, which leaves ${C} different combinations a ` +
				`thief could target. You've got plenty of spares — lose up to ${R} ${keys(R)} and you're ` +
				'fine — but all that slack makes theft easier, not harder. Requiring more than half your ' +
				`keys (${suggestM}-of-${n}) protects savings much better.`,
			combos: `${C} different ${setWord(m)} could move the money — ${C} chances for a thief.`
		};
	}

	if (m === 2) {
		return {
			tier: 'green',
			label: 'Recommended — the sweet spot',
			icon: 'shield-check',
			badge: 'Recommended',
			body:
				'Any 2 of your 3 keys can spend. Lose one key and nothing is lost — the other two still ' +
				'work. Someone steals one key and they get nothing; they\'d need a second. The balance ' +
				'most people want.',
			combos: '3 different pairs of keys can spend — no single key ever spends alone.'
		};
	}

	const C = binomial(n, m);
	const R = n - m;
	return {
		tier: 'lightgreen',
		label: 'Solid setup',
		icon: 'shield',
		body:
			`Spending needs ${m} of your ${n} keys — a clear majority, so no small group can move the ` +
			`money alone. Lose up to ${R} ${keys(R)} and you can still reach your money. A dependable ` +
			'balance of safety and recovery.',
		combos: `${C} different ${setWord(m)} can spend — each still needs a full ${m} keys.`
	};
}
