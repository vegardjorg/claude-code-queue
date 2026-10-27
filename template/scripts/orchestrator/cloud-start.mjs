#!/usr/bin/env node
// Starts queue tasks in a cloud session with `claude --cloud`, so the session draws from "Cloud session credits" (routines do
// not). `--cloud` requires a real terminal, so the owner runs this in a terminal themselves:
//
//   node scripts/orchestrator/cloud-start.mjs <id> [<id> …] [--force]
//
// The script makes the cloud package with `queue.mjs cloud-package`, marks the tasks as started in the cloud (`queue.mjs cloud start`)
// and then opens `claude --cloud <package>` in this terminal. When the cloud session reports CLOUD-DONE, the orchestrator fetches and
// merges as before (`queue.mjs cloud done <id>`). Requires baseBranch (config().baseBranch) to be pushed to the remote (config().remote),
// because the cloud session starts from it. See docs/queue.md.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const K = config();
const ROOT = K.root;
const QUEUE = path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs');
const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  console.error('Use: node scripts/orchestrator/cloud-start.mjs <id> [<id> …] [--force]');
  process.exit(1);
}
if (!process.stdout.isTTY) {
  console.error('claude --cloud requires a real terminal. Run the command yourself in a terminal window.');
  process.exit(1);
}

// The cloud session starts from <remote>/<baseBranch>: if baseBranch has unpushed commits, the cloud does not see them.
{
  const r = spawnSync('git', ['rev-list', '--count', `${K.remote}/${K.baseBranch}..${K.baseBranch}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const unpushed = Number((r.stdout || '').trim());
  if (r.status !== 0) {
    console.error(`Could not find ${K.remote}/${K.baseBranch}. The base branch must be pushed before a cloud session can start.`);
    process.exit(1);
  }
  if (unpushed > 0 && !force) {
    console.error(
      `${K.baseBranch} has ${unpushed} commit(s) not pushed to ${K.remote}. The cloud session would start without them. ` +
        'Push baseBranch first (when the owner says "push"), or use --force.',
    );
    process.exit(1);
  }
}

const file = path.join(os.tmpdir(), `cloud-package-${Date.now()}.md`);
const queue = (...a) =>
  execFileSync(process.execPath, [QUEUE, ...a], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
try {
  process.stdout.write(queue('cloud-package', ...ids, '--out', file, ...(force ? ['--force'] : [])));
} catch {
  console.error(
    'Could not make the cloud package (see above). Add --force if you want to send it anyway.',
  );
  process.exit(1);
}
const pkg = fs.readFileSync(file, 'utf8');
process.stdout.write(queue('cloud', 'start', ...ids, '--force'));
console.log(`\nStarting cloud session for ${ids.join(', ')} … (draws from Cloud session credits)\n`);
const r = spawnSync('claude', ['--cloud', pkg], { cwd: ROOT, stdio: 'inherit' });
fs.rmSync(file, { force: true });
process.exit(r.status ?? 0);
