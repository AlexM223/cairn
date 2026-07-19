// Move-1 QA dev-server wrapper: own DB, own Vite cache, port 5181, all-hosts
// bind so move1.localhost resolves (per-agent subdomain rule — never bare
// localhost, cookie-jar collision hazard).
import { spawn } from 'node:child_process';

process.env.CAIRN_DB = 'C:/dev/cairn-move1/data/move1-qa.db';
process.env.CAIRN_VITE_CACHE = 'C:/dev/cairn-move1/.vite-move1';

const child = spawn(
	process.platform === 'win32' ? 'npx.cmd' : 'npx',
	['vite', 'dev', '--port', '5181', '--host'],
	{ cwd: 'C:/dev/cairn-move1', stdio: 'inherit', shell: true }
);
child.on('exit', (code) => process.exit(code ?? 0));
