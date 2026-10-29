#!/usr/bin/env node
// =============================================================
// cq.mjs: one entry point for all the queue's scripts, so skills, agents and missions can say `cq <...>` and work the
// same whether the scripts live in the project (vendored install) or in Claude Code's plugin folder (plugin install).
//
// Usage:
//   cq <queue command> [args]     same as queue.mjs <queue command>, e.g. `cq show`, `cq fill --scratchpad <dir>`
//   cq queue <command> [args]     the same, written out
//   cq board [args]               queue-board.mjs
//   cq takeover [args]            queue-takeover.mjs
//   cq <script> [args]            <script>.mjs, e.g. `cq prepare-track EX-1 --branch queue/EX-1 --scratchpad <dir>`
//   cq help                       this list
//
// In a plugin, bin/cq (and bin/cq.cmd on Windows) calls this file; the plugin's bin/ folder is on the Bash tool's PATH.
// In a vendored install there is no `cq` on PATH; there the command is `node scripts/orchestrator/cq.mjs <...>`
// (install.mjs rewrites the skills and docs to that form). The project is found by lib/projectRoot.js, not by where
// this file lives.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Short names for scripts whose file name is long or starts with "queue-".
const ALIASES = { queue: 'queue', board: 'queue-board', takeover: 'queue-takeover' };

/** The scripts a user or agent may start (hooks are started by Claude Code, not by hand). */
function scripts() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('hook-') && f !== 'cq.mjs')
    .map((f) => f.slice(0, -'.mjs'.length))
    .sort();
}

const [first, ...rest] = process.argv.slice(2);

if (!first || first === 'help' || first === '--help' || first === '-h') {
  console.log(
    'cq: the work queue (claude-cowie-queue).\n\n' +
      '  cq <queue command> [args]   e.g. cq show, cq next, cq fill --scratchpad <dir>, cq plan show\n' +
      '  cq board                    the board (queue-board.mjs)\n' +
      '  cq takeover                 status picture for a new orchestrator (queue-takeover.mjs)\n' +
      `  cq <script> [args]          one of: ${scripts().join(', ')}\n\n` +
      'The queue commands are listed in docs/queue/queue.md.',
  );
  process.exit(0);
}

// A script name (or alias) runs that script; everything else is a queue.mjs command.
const name = ALIASES[first] ?? (scripts().includes(first) ? first : null);
const file = path.join(HERE, `${name ?? 'queue'}.mjs`);
const args = name ? rest : [first, ...rest];

const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
if (r.error) {
  console.error(`cq: could not start ${path.basename(file)}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
