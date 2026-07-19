// s2b QA: read-only settings dump for the s2 stack DB (worker B diagnostics).
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] || 'C:/dev/cairn/data/qa-s2.db', { readOnly: true });
const rows = db
	.prepare(
		"SELECT key, value FROM settings WHERE key LIKE 'chain%' OR key LIKE 'electrum%' OR key LIKE 'core%' OR key LIKE 'instance%' ORDER BY key"
	)
	.all();
for (const r of rows) console.log(`${r.key} = ${r.value}`);
