// scripts/qa/s2-set-settings.mjs — upsert settings rows for Session-2 QA instance.
// Usage: node scripts/qa/s2-set-settings.mjs --db <path> key=value [key=value ...]
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
let dbPath = null;
const pairs = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--db') dbPath = argv[++i];
	else if (argv[i].includes('=')) {
		const idx = argv[i].indexOf('=');
		pairs.push([argv[i].slice(0, idx), argv[i].slice(idx + 1)]);
	}
}
if (!dbPath || pairs.length === 0) {
	console.error('usage: node s2-set-settings.mjs --db <path> key=value ...');
	process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const up = db.prepare(
	'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
for (const [k, v] of pairs) up.run(k, v);
const rows = db
	.prepare(
		"SELECT key, value FROM settings WHERE key LIKE 'mining%' OR key IN ('instance_mode','electrum_host','electrum_port','core_rpc_url','core_rpc_user')"
	)
	.all();
console.log(JSON.stringify(rows, null, 1));
db.close();
