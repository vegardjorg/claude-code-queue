#!/usr/bin/env node
// =============================================================
// hook-push-guard.mjs: PreToolUse hook (Bash/PowerShell) that stops the expensive and irreversible commands before
// they run: forced push, push of branches other than baseBranch, and migration push to an environment that is not
// allowed (see lib/pushGuard.js for the rules and the reasoning, and docs/orchestration.md).
//
// What it does: reads the hook payload from stdin, finds the current branch and (when migrations.environmentFile is set)
// the contents of the environment file, and asks lib/pushGuard.js. The answer is "ask" (Claude Code shows a confirmation
// dialog), "deny" (blocked, with reason) or nothing (normal flow).
//
// Fails OPEN: an internal error (invalid payload, git missing) gives exit 0 without a decision and a line on stderr.
// The guard must never stop normal work because of a bug in itself. If node is missing on PATH, the hook gets exit 127,
// which Claude Code treats as non-blocking.
//
// Test: lib/__tests__/pushGuard.test.ts (the logic). Smoke test of the hook itself:
//   echo '{"tool_input":{"command":"git push --force origin main"},"cwd":"."}' | node scripts/orchestrator/hook-push-guard.mjs
// =============================================================

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Not a queue project (no queue.config.json): do nothing. A plugin's hooks run in every project the user opens.
if (!require('./lib/projectRoot.js').queueActive()) process.exit(0);
const { assess, readEnvironment } = require('./lib/pushGuard.js');
const { config } = require('./lib/queueConfig.js');

function read(stdin) {
  try {
    return JSON.parse(stdin || '{}');
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Main tree for an agent worktree (<root>/.claude/worktrees/<name>), otherwise the path itself. */
function mainTree(top) {
  return String(top).split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
}

/** Only commands that can match: git or the first word of the migration command. Saves git calls otherwise. */
function canHit(command, k) {
  if (/\bgit\b/.test(command)) return true;
  const word = String(k.migrations?.pushCommand || '')
    .split(/\s+/)
    .filter((x) => x && !x.startsWith('-') && !['npx', 'npm', 'pnpm', 'yarn', 'exec'].includes(x));
  return word.length > 0 && command.includes(word[0]);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const p = read(input);
    const command = p?.tool_input?.command;
    if (!p || typeof command !== 'string') process.exit(0);
    const k = config();
    if (!canHit(command, k)) process.exit(0);

    const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    const environment = readEnvironment([top, top && mainTree(top), k.root], k.migrations?.environmentFile);
    const answer = assess(command, {
      branch: branch === 'HEAD' ? null : branch,
      environment,
      baseBranch: k.baseBranch,
      migrations: k.migrations,
    });
    if (!answer) process.exit(0);

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: answer.decision,
          permissionDecisionReason: `push-guard: ${answer.reason}`,
        },
      }),
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      `push-guard: internal error, letting the command through (${e?.message ?? e})\n`,
    );
    process.exit(0);
  }
});
