#!/usr/bin/env node
// =============================================================
// gates.mjs: runs the project's gates (config().gates.quick or .full from queue.config.json) in order.
//
// WHY: tracks and the orchestrator must check the work the same way whatever the project. Which commands are
// gates (type check, lint, tests, custom checks) is the project's business and lives in queue.config.json, not here.
//   --quick  what tracks run before delivery (quick checks).
//   --full  what the orchestrator runs after merge and before a batch push (everything).
//
// Runs in process.cwd() when it is the project root or a worktree of the project (a track checks its own
// worktree), otherwise in the project root. Each gate is a shell command; it is green when the exit code is 0.
//
// Output: one line per gate (GREEN/RED + duration, and the first error line for red ones) and a final line.
// Exit 0 when all are green (or no gates are set up), 1 otherwise.
//   --log <file>  writes the whole output of each gate to the file (for debugging without filling the context).
//
// Use: node scripts/orchestrator/gates.mjs --quick|--full [--log <file>]
// See docs/orchestration.md.
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const { firstErrorLine, gateType, resultLine } = require('./lib/orchestratorHelp.js');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const full = args.includes('--full');
if (quick === full) {
  console.error('use: gates.mjs --quick|--full [--log <file>]');
  process.exit(2);
}
const li = args.indexOf('--log');
const logFile = li >= 0 && args[li + 1] ? path.resolve(args[li + 1]) : null;

const K = config();
const mode = quick ? 'quick' : 'full';
const gates = (Array.isArray(K.gates?.[mode]) ? K.gates[mode] : []).filter(
  (g) => typeof g === 'string' && g.trim(),
);
if (gates.length === 0) {
  console.log('no gates set up in queue.config.json');
  process.exit(0);
}

/** Is `path` the project root or a worktree of the project (<root>/.claude/worktrees/<name>/...)? */
function inProject(filePath) {
  const rel = path.relative(K.root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const cwd = inProject(process.cwd()) ? process.cwd() : K.root;

if (logFile) fs.writeFileSync(logFile, `gates --${mode} in ${cwd}\n`);
const width = Math.min(60, Math.max(...gates.map((g) => g.length)) + 2);
const start = Date.now();
let failedCount = 0;

for (const command of gates) {
  const t0 = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const sec = (Date.now() - t0) / 1000;
  const out = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  const green = r.status === 0;
  if (!green) failedCount++;
  console.log(
    resultLine(
      {
        name: command,
        status: green ? 'GREEN' : 'RED',
        sec,
        first: green ? '' : firstErrorLine(gateType(command), out, cwd),
      },
      width,
    ),
  );
  if (logFile)
    fs.appendFileSync(logFile, `\n===== ${command} (exit ${r.status ?? 'unknown'}, ${Math.round(sec)} s) =====\n${out}`);
}

const total = Math.round((Date.now() - start) / 1000);
console.log(
  failedCount === 0
    ? `ALL GREEN: ${gates.length} gate(s) --${mode} in ${total} s`
    : `RED: ${failedCount} of ${gates.length} gate(s) --${mode} failed (${total} s)${logFile ? `, full log: ${logFile}` : ''}`,
);
process.exit(failedCount === 0 ? 0 : 1);
