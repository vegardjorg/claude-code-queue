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
//   cq help                       the key commands in groups (lib/cliHelp.js)
//   cq help all                   every command
//   cq help <command>             one queue command in full, or a script's header
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
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELP = createRequire(import.meta.url)('./lib/cliHelp.js');

// Short names for scripts whose file name is long or starts with "queue-".
const ALIASES = HELP.ALIASES;

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
  // The texts and the parsing are in lib/cliHelp.js; the full usage list lives as the comment at the top of queue.mjs.
  const what = rest[0];
  const source = () => fs.readFileSync(path.join(HERE, 'queue.mjs'), 'utf8');
  let lines;
  if (!what) lines = HELP.shortHelp();
  else if (what === 'all') lines = HELP.fullHelp(source(), scripts());
  else if (HELP.ALIASES[what] || scripts().includes(what)) {
    lines = HELP.scriptHeader(fs.readFileSync(path.join(HERE, `${HELP.ALIASES[what] ?? what}.mjs`), 'utf8'));
  } else lines = HELP.commandHelp(source(), what);
  if (!lines) {
    console.error(HELP.unknownCommandMessage(what, HELP.knownCommands(scripts())));
    process.exit(1);
  }
  console.log(lines.join('\n'));
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
