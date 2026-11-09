// Renders the agent install scripts the server serves (install.sh, install.ps1)
// into a directory, so CI can syntax-check exactly what hosts download.
//
//   node scripts/ci/render-install-scripts.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? 'rendered');

process.env.MASTER_ENCRYPTION_KEY ??= Buffer.alloc(32).toString('base64');
process.env.JWT_SECRET ??= 'ci';
process.env.PUBLIC_BASE_URL ??= 'https://backup.example.com';

// The server sources are TypeScript; ts-node (a server dev dependency)
// transpiles them on the fly.
const require = createRequire(path.join(root, 'server', 'package.json'));
require('ts-node').register({
  transpileOnly: true,
  project: path.join(root, 'server', 'tsconfig.json'),
  compilerOptions: { module: 'commonjs' },
});
const { AgentsService } = require(path.join(root, 'server/src/agents/agents.service.ts'));

const service = new AgentsService({}, {}, {}, {}, {}, {}, {}, {});
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'install.sh'), service.installScript());
writeFileSync(path.join(out, 'install.ps1'), service.installPowerShellScript());
console.log(`rendered install.sh and install.ps1 into ${out}`);
