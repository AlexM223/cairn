// Aggregates driver.mjs's raw samples into per (scenario, tier) stats, writes
// one results/run-<ISO8601>-<scenario>.json per scenario, and prints a human
// table modeled on docs/LOAD-TEST-RESULTS-2026-07-05.md's columns.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { RESULTS_DIR, ROOT_DIR } from './config.mjs';

function percentile(sortedMs, p) {
	if (sortedMs.length === 0) return null;
	const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
	return sortedMs[idx];
}

/** Stats for one (scenario, tier)'s measured-window samples. */
export function summarizeTier({ scenarioId, scenarioName, tier, durationS, samples, eventLoopLag }) {
	const count = samples.length;
	const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
	const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
	const non2xx = samples.filter((s) => !(s.status >= 200 && s.status < 300)).length;

	return {
		scenario: scenarioId,
		scenarioName,
		tier,
		durationS,
		count,
		rps: durationS > 0 ? count / durationS : 0,
		p50: percentile(ms, 50),
		p95: percentile(ms, 95),
		p99: percentile(ms, 99),
		max: ms.length ? ms[ms.length - 1] : null,
		errorRate: count ? errors / count : 0,
		non2xxRate: count ? non2xx / count : 0,
		eventLoopLag
	};
}

function gitSha() {
	try {
		return execSync('git rev-parse HEAD', { cwd: ROOT_DIR }).toString().trim();
	} catch {
		return 'unknown';
	}
}

function fmtMs(v) {
	return v == null ? '-' : v.toFixed(1);
}
function fmtPct(v) {
	return `${(v * 100).toFixed(1)}%`;
}

export function printTable(rows) {
	const header = [
		'scenario',
		'tier',
		'reqs',
		'rps',
		'p50ms',
		'p95ms',
		'p99ms',
		'maxms',
		'errRate',
		'non2xx',
		'lagP99ms'
	];
	const lines = rows.map((r) => [
		r.scenarioName,
		String(r.tier),
		String(r.count),
		r.rps.toFixed(1),
		fmtMs(r.p50),
		fmtMs(r.p95),
		fmtMs(r.p99),
		fmtMs(r.max),
		fmtPct(r.errorRate),
		fmtPct(r.non2xxRate),
		r.eventLoopLag ? r.eventLoopLag.p99.toFixed(2) : '-'
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
	const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
	console.log('');
	console.log(fmtRow(header));
	console.log(widths.map((w) => '-'.repeat(w)).join('  '));
	for (const l of lines) console.log(fmtRow(l));
	console.log('');
}

/** Write one JSON file per scenario (grouping its tiers), with a shared meta
 *  block. Returns the list of written file paths. */
export function writeResultFiles(rowsByScenario, { buildMode }) {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const startedAt = new Date().toISOString();
	const meta = {
		startedAt,
		gitSha: gitSha(),
		node: process.version,
		cpus: os.cpus().length,
		buildMode
	};
	const iso = startedAt.replace(/[:.]/g, '-');
	const written = [];
	for (const [scenarioId, rows] of Object.entries(rowsByScenario)) {
		const outPath = path.join(RESULTS_DIR, `run-${iso}-${scenarioId}.json`);
		fs.writeFileSync(outPath, JSON.stringify({ meta, scenario: scenarioId, tiers: rows }, null, 2));
		written.push(outPath);
	}
	return written;
}
